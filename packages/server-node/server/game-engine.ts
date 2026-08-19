import { randomUUID } from 'node:crypto';
import { getAgentStrategy } from './agent-strategy.js';
import { buildAgentContext } from './agent-context.js';
import {
  DescriptionQualityError,
  DescriptionQualityGate,
  normalizeDescription,
  repairGuidance,
  type DescriptionQualityEvent,
  type DescriptionQualityViolation,
} from './description-quality.js';
import type { GameModel } from './model.js';
import type {
  Description,
  GameReview,
  GameState,
  Player,
  PublicProgressEvent,
  PublicGameState,
  Role,
  Vote,
} from './types.js';
import type { TraceSink } from './trace.js';
import { chooseWordPair } from './words.js';

const AI_PROFILES = [
  { name: '阿序', avatar: '序', strategyId: 'cautious' },
  { name: '弥生', avatar: '弥', strategyId: 'intuitive' },
  { name: '老墨', avatar: '墨', strategyId: 'analytical' },
  { name: '小满', avatar: '满', strategyId: 'contrarian' },
] as const;

interface PendingAiVotes {
  gameId: string;
  round: number;
  ballot: number;
  eligibleTargetIds: string[] | null;
  promise: Promise<{ ok: true; votes: Vote[] } | { ok: false; error: unknown }>;
}

export class GameRuleError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = 'GameRuleError';
  }
}

export class GameEngine {
  private readonly games = new Map<string, GameState>();
  private readonly progressListeners = new Set<(event: PublicProgressEvent) => void>();
  private readonly pendingAiVotes = new Map<string, PendingAiVotes>();
  private readonly qualityGate = new DescriptionQualityGate();

  constructor(
    private readonly model: GameModel,
    private readonly random: () => number = Math.random,
    private readonly onQualityViolation: (event: DescriptionQualityEvent) => void = () => undefined,
    private readonly traceSink?: TraceSink,
  ) {
    if (traceSink) this.model.setTraceSink?.(traceSink);
  }

  createGame(): PublicGameState {
    const pair = chooseWordPair(this.random);
    const undercoverIndex = Math.floor(this.random() * 5);
    const swapWords = this.random() > 0.5;
    const civilianWord = pair[swapWords ? 1 : 0];
    const undercoverWord = pair[swapWords ? 0 : 1];
    const rawPlayers = [
      { name: '你', avatar: '你', isHuman: true },
      ...AI_PROFILES.map(({ name, avatar, strategyId }) => ({ name, avatar, strategyId, isHuman: false })),
    ];
    const players: Player[] = rawPlayers.map((profile, index) => {
      const role: Role = index === undercoverIndex ? 'undercover' : 'civilian';
      return {
        id: index === 0 ? 'human' : `ai-${index}`,
        ...profile,
        role,
        word: role === 'undercover' ? undercoverWord : civilianWord,
        alive: true,
      };
    });
    const id = randomUUID();
    const game: GameState = {
      id,
      phase: 'describing',
      round: 1,
      ballot: 1,
      players,
      descriptions: [],
      votes: [],
      events: [
        {
          id: randomUUID(),
          type: 'system',
          text: '密词已发放。请用一句话描述它，但不要直接说出答案。',
          round: 1,
        },
      ],
      eligibleTargetIds: null,
      winner: null,
      review: null,
      createdAt: Date.now(),
    };
    this.games.set(id, game);
    return this.toPublic(game);
  }

  getGame(id: string): PublicGameState {
    return this.toPublic(this.requireGame(id));
  }

  getInternalGame(id: string): GameState {
    return this.requireGame(id);
  }

  subscribeToPublicProgress(listener: (event: PublicProgressEvent) => void): () => void {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  async submitHumanDescription(id: string, text: string): Promise<PublicGameState> {
    const game = this.requireGame(id);
    this.assertPhase(game, 'describing');
    const human = this.human(game);
    if (!human.alive) throw new GameRuleError('你已出局，请继续观战');
    const description = normalizeText(text);
    if (description.length < 2 || description.length > 60) {
      throw new GameRuleError('描述需为 2–60 个字符');
    }
    if (description.includes(human.word)) {
      throw new GameRuleError('不能直接说出你的秘密词');
    }
    if (game.descriptions.some((item) => item.round === game.round && item.playerId === human.id)) {
      throw new GameRuleError('本轮已经描述过了');
    }

    const humanDescription = { playerId: human.id, text: description, round: game.round };
    this.commitDescription(game, humanDescription);
    await this.generateDescriptions(game);
    this.enterVoting(game);
    return this.toPublic(game);
  }

  async submitHumanVote(id: string, targetId: string): Promise<PublicGameState> {
    const game = this.requireGame(id);
    this.assertPhase(game, 'voting');
    const human = this.human(game);
    if (!human.alive) throw new GameRuleError('你已出局，请继续观战');
    this.validateVoteTarget(game, human, targetId);

    const aiVotes = await this.consumePendingAiVotes(game);
    const target = game.players.find((player) => player.id === targetId)!;
    const roundVotes: Vote[] = [
      {
        voterId: human.id,
        targetId,
        reason: `我认为 ${target.name} 的描述最可疑`,
        round: game.round,
        ballot: game.ballot,
      },
      ...aiVotes,
    ];
    game.votes.push(...roundVotes);
    await this.resolveBallot(game, roundVotes);
    this.prefetchAiVotes(game);
    return this.toPublic(game);
  }

  async continueAsSpectator(id: string): Promise<PublicGameState> {
    const game = this.requireGame(id);
    if (this.human(game).alive) throw new GameRuleError('你仍在场上，请亲自完成行动');
    if (game.phase === 'finished') return this.toPublic(game);

    let safety = 0;
    while (!this.isFinished(game) && safety < 12) {
      safety += 1;
      if (game.phase === 'describing') {
        await this.generateDescriptions(game);
        this.enterVoting(game);
      } else {
        const votes = await this.consumePendingAiVotes(game);
        game.votes.push(...votes);
        await this.resolveBallot(game, votes);
        this.prefetchAiVotes(game);
      }
    }
    if (safety >= 12 && !this.isFinished(game)) {
      throw new GameRuleError('自动对局轮次异常，请重新开局', 500);
    }
    return this.toPublic(game);
  }

  private async generateDescriptions(game: GameState): Promise<Description[]> {
    const describedPlayerIds = new Set(
      game.descriptions.filter((description) => description.round === game.round).map((description) => description.playerId),
    );
    const agents = game.players.filter((player) => !player.isHuman && player.alive && !describedPlayerIds.has(player.id));
    const outputs: Description[] = [];
    const allSecrets = [...new Set(game.players.map((player) => player.word))];
    for (const agent of agents) {
      const context = buildAgentContext(game, agent);
      const strategy = getAgentStrategy(context.identity.strategyId);
      const acceptedSameRound = game.descriptions
        .filter((description) => description.round === game.round)
        .map((description) => description.text);
      let violation: DescriptionQualityViolation | undefined;
      let acceptedText: string | undefined;
      for (let attempt = 1; attempt <= strategy.qualityPolicy.maxDescriptionAttempts; attempt += 1) {
        const text = normalizeDescription(
          await this.model.describe(context, {
            attempt,
            ...(violation
              ? { repair: { violationType: violation.type, guidance: repairGuidance(violation) } }
              : {}),
          }),
        );
        violation =
          this.qualityGate.check({
            text,
            allSecrets,
            acceptedSameRound,
            duplicateSimilarityThreshold: strategy.qualityPolicy.duplicateSimilarityThreshold,
          }) ?? undefined;
        if (!violation) {
          acceptedText = text;
          break;
        }
        const willRetry = attempt < strategy.qualityPolicy.maxDescriptionAttempts;
        this.onQualityViolation({
          gameId: game.id,
          round: game.round,
          agentId: agent.id,
          strategyId: strategy.id,
          attempt,
          violationType: violation.type,
          ...(violation.similarity === undefined ? {} : { similarity: violation.similarity }),
          willRetry,
        });
      }
      if (acceptedText === undefined) {
        throw new DescriptionQualityError(
          'AI 描述未通过质量检查，状态未推进；请重试本次行动',
          violation?.type ?? 'empty',
        );
      }
      const description = { playerId: agent.id, text: acceptedText, round: game.round };
      this.commitDescription(game, description);
      outputs.push(description);
    }
    return outputs;
  }

  private commitDescription(game: GameState, description: Description): void {
    game.descriptions.push(description);
    const event: GameState['events'][number] = {
      id: randomUUID(),
      type: 'description',
      text: description.text,
      round: description.round,
      playerId: description.playerId,
    };
    game.events.push(event);
    this.tracePublicEvent(game, event.type, description.playerId);
    const nextSpeaker = game.players.find(
      (player) => !player.isHuman && player.alive && !game.descriptions.some(
        (item) => item.round === game.round && item.playerId === player.id,
      ),
    );
    this.emitPublicProgress({
      type: 'description_published',
      gameId: game.id,
      description: {
        ...description,
        playerName: game.players.find((player) => player.id === description.playerId)?.name ?? '未知玩家',
      },
      event,
      phase: 'describing',
      progress: {
        completed: game.descriptions.filter((item) => item.round === game.round).length,
        total: game.players.filter((player) => player.alive).length,
        nextSpeaker: nextSpeaker ? { playerId: nextSpeaker.id, playerName: nextSpeaker.name } : null,
      },
    });
  }

  private enterVoting(game: GameState): void {
    game.phase = 'voting';
    game.ballot = 1;
    game.eligibleTargetIds = null;
    const event: GameState['events'][number] = {
      id: randomUUID(),
      type: 'system',
      text: '所有人描述完毕。观察措辞，投出你最怀疑的一票。',
      round: game.round,
    };
    game.events.push(event);
    this.tracePublicEvent(game, event.type);
    this.emitPublicProgress({
      type: 'phase_changed',
      gameId: game.id,
      phase: game.phase,
      round: game.round,
      ballot: game.ballot,
      eligibleTargetIds: game.eligibleTargetIds,
      event,
    });
    this.prefetchAiVotes(game);
  }

  private prefetchAiVotes(game: GameState): void {
    if (game.phase !== 'voting') return;
    const existing = this.pendingAiVotes.get(game.id);
    if (existing && this.matchesPendingVotes(existing, game)) return;
    const pending: PendingAiVotes = {
      gameId: game.id,
      round: game.round,
      ballot: game.ballot,
      eligibleTargetIds: game.eligibleTargetIds ? [...game.eligibleTargetIds] : null,
      promise: this.generateVotes(game)
        .then((votes) => ({ ok: true as const, votes }))
        .catch((error: unknown) => {
          if (this.pendingAiVotes.get(game.id) === pending) this.pendingAiVotes.delete(game.id);
          return { ok: false as const, error };
        }),
    };
    this.pendingAiVotes.set(game.id, pending);
  }

  private async consumePendingAiVotes(game: GameState): Promise<Vote[]> {
    const pending = this.pendingAiVotes.get(game.id);
    if (!pending || !this.matchesPendingVotes(pending, game)) return this.generateVotes(game);
    this.pendingAiVotes.delete(game.id);
    const result = await pending.promise;
    if (!result.ok) throw result.error;
    return result.votes;
  }

  private matchesPendingVotes(pending: PendingAiVotes, game: GameState): boolean {
    const eligible = game.eligibleTargetIds ? [...game.eligibleTargetIds] : null;
    return pending.gameId === game.id
      && pending.round === game.round
      && pending.ballot === game.ballot
      && JSON.stringify(pending.eligibleTargetIds) === JSON.stringify(eligible);
  }

  private emitPublicProgress(event: PublicProgressEvent): void {
    for (const listener of this.progressListeners) listener(event);
  }

  private async generateVotes(game: GameState): Promise<Vote[]> {
    const voters = game.players.filter((player) => !player.isHuman && player.alive);
    return Promise.all(
      voters.map(async (voter) => {
        const allowedTargets = this.allowedTargets(game, voter);
        const result = await this.model.vote(buildAgentContext(game, voter), allowedTargets);
        return {
          voterId: voter.id,
          targetId: result.targetId,
          reason: result.reason,
          round: game.round,
          ballot: game.ballot,
        };
      }),
    );
  }

  private async resolveBallot(game: GameState, votes: Vote[]): Promise<void> {
    const counts = new Map<string, number>();
    for (const vote of votes) counts.set(vote.targetId, (counts.get(vote.targetId) ?? 0) + 1);
    const maxVotes = Math.max(...counts.values());
    const leaders = [...counts.entries()].filter(([, count]) => count === maxVotes).map(([id]) => id);

    if (leaders.length > 1 && game.ballot < 2) {
      game.ballot += 1;
      game.eligibleTargetIds = leaders;
      const names = leaders.map((id) => game.players.find((player) => player.id === id)?.name).join('、');
      game.events.push({
        id: randomUUID(),
        type: 'vote_result',
        text: `${names} 同票，进入最终加票。`,
        round: game.round,
      });
      this.tracePublicEvent(game, 'vote_result');
      return;
    }

    const eliminatedId = leaders.length === 1 ? leaders[0] : leaders[Math.floor(this.random() * leaders.length)];
    const eliminated = game.players.find((player) => player.id === eliminatedId);
    if (!eliminated) throw new GameRuleError('投票结果无效', 500);
    eliminated.alive = false;
    game.eligibleTargetIds = null;
    game.events.push({
      id: randomUUID(),
      type: 'elimination',
      text: `${eliminated.name} 被投出局。身份将在终局揭晓。`,
      round: game.round,
      playerId: eliminated.id,
    });
    this.tracePublicEvent(game, 'elimination', eliminated.id);

    const winner = this.checkWinner(game);
    if (winner) {
      game.winner = winner;
      game.phase = 'finished';
      game.review = await this.createReview(game);
      return;
    }

    game.round += 1;
    game.ballot = 1;
    game.phase = 'describing';
    game.events.push({
      id: randomUUID(),
      type: 'system',
      text: `第 ${game.round} 轮开始。换个角度描述，别让身份暴露。`,
      round: game.round,
    });
    this.tracePublicEvent(game, 'system');
  }

  private checkWinner(game: GameState): Role | null {
    const alive = game.players.filter((player) => player.alive);
    const undercoverAlive = alive.filter((player) => player.role === 'undercover').length;
    if (undercoverAlive === 0) return 'civilian';
    if (undercoverAlive >= alive.length - undercoverAlive) return 'undercover';
    return null;
  }

  private async createReview(game: GameState): Promise<GameReview> {
    try {
      return await this.model.review(game);
    } catch {
      this.traceSink?.record({
        eventType: 'model_call',
        gameId: game.id,
        round: game.round,
        phase: game.phase,
        ballot: game.ballot,
        task: 'review',
        agentId: 'review',
        agentName: '复盘',
        attempt: 1,
        latencyMs: 0,
        willRetry: false,
        outcome: 'fallback',
      });
      const undercover = game.players.find((player) => player.role === 'undercover')!;
      return {
        headline: game.winner === 'civilian' ? '平民锁定了那处微妙偏差' : '卧底把相似性利用到了最后',
        summary: `${undercover.name} 拿到的是“${undercover.word}”，其余玩家拿到“${game.players.find((p) => p.role === 'civilian')!.word}”。本局共进行了 ${game.round} 轮，胜负来自描述细节与投票联盟的共同变化。`,
        turningPoints: ['终局票型决定了阵营胜负；可展开每轮记录回看判断依据。'],
        playerInsights: game.players.map((player) => ({
          playerId: player.id,
          insight: `${player.name} 以“${player.word}”为出发点完成了本局表达与判断。`,
        })),
      };
    }
  }

  private allowedTargets(game: GameState, voter: Player): Player[] {
    const eligible = game.eligibleTargetIds ? new Set(game.eligibleTargetIds) : null;
    const targets = game.players.filter(
      (player) => player.alive && player.id !== voter.id && (!eligible || eligible.has(player.id)),
    );
    if (targets.length === 0) throw new GameRuleError(`${voter.name} 没有可投票目标`, 500);
    return targets;
  }

  private validateVoteTarget(game: GameState, voter: Player, targetId: string): void {
    if (!this.allowedTargets(game, voter).some((player) => player.id === targetId)) {
      throw new GameRuleError('请选择一名有效的存活玩家');
    }
  }

  private toPublic(game: GameState): PublicGameState {
    const finished = game.phase === 'finished';
    const human = this.human(game);
    return {
      id: game.id,
      phase: game.phase,
      round: game.round,
      ballot: game.ballot,
      players: game.players.map(({ id, name, avatar, isHuman, alive, role, word }) => ({
        id,
        name,
        avatar,
        isHuman,
        alive,
        ...(finished ? { revealedRole: role, revealedWord: word } : {}),
      })),
      descriptions: game.descriptions,
      votes: game.votes,
      events: game.events,
      eligibleTargetIds: game.eligibleTargetIds,
      winner: game.winner,
      review: game.review,
      human: { playerId: human.id, role: human.role, word: human.word },
      model: this.model.model,
    };
  }

  private requireGame(id: string): GameState {
    const game = this.games.get(id);
    if (!game) throw new GameRuleError('对局不存在或已过期', 404);
    return game;
  }

  private human(game: GameState): Player {
    return game.players.find((player) => player.isHuman)!;
  }

  private assertPhase(game: GameState, phase: GameState['phase']): void {
    if (game.phase !== phase) throw new GameRuleError(`当前不在${phase === 'describing' ? '描述' : '投票'}阶段`);
  }

  private tracePublicEvent(game: GameState, publicEventType: string, agentId?: string): void {
    const player = agentId ? game.players.find((candidate) => candidate.id === agentId) : undefined;
    this.traceSink?.record({
      eventType: 'public_event',
      gameId: game.id,
      round: game.round,
      phase: game.phase,
      ballot: game.ballot,
      publicEventType,
      agentId,
      agentName: player?.name,
      outcome: 'success',
    });
  }

  private isFinished(game: GameState): boolean {
    return game.phase === 'finished';
  }
}

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}
