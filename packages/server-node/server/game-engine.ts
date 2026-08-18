import { randomUUID } from 'node:crypto';
import { buildAgentContext } from './agent-context.js';
import type { GameModel } from './model.js';
import type {
  Description,
  GameReview,
  GameState,
  Player,
  PublicGameState,
  Role,
  Vote,
} from './types.js';
import { chooseWordPair } from './words.js';

const AI_PROFILES = [
  { name: '阿序', avatar: '序', style: '谨慎观察' },
  { name: '弥生', avatar: '弥', style: '直觉敏锐' },
  { name: '老墨', avatar: '墨', style: '逻辑派' },
  { name: '小满', avatar: '满', style: '出其不意' },
] as const;

export class GameRuleError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = 'GameRuleError';
  }
}

export class GameEngine {
  private readonly games = new Map<string, GameState>();

  constructor(
    private readonly model: GameModel,
    private readonly random: () => number = Math.random,
  ) {}

  createGame(): PublicGameState {
    const pair = chooseWordPair(this.random);
    const undercoverIndex = Math.floor(this.random() * 5);
    const swapWords = this.random() > 0.5;
    const civilianWord = pair[swapWords ? 1 : 0];
    const undercoverWord = pair[swapWords ? 0 : 1];
    const rawPlayers = [
      { name: '你', avatar: '你', isHuman: true },
      ...AI_PROFILES.map(({ name, avatar }) => ({ name, avatar, isHuman: false })),
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
    const contextGame = { ...game, descriptions: [...game.descriptions, humanDescription] };
    const aiDescriptions = await this.generateDescriptions(contextGame);
    const roundDescriptions: Description[] = [humanDescription, ...aiDescriptions];
    game.descriptions.push(...roundDescriptions);
    game.events.push(
      ...roundDescriptions.map((item) => ({
        id: randomUUID(),
        type: 'description' as const,
        text: item.text,
        round: game.round,
        playerId: item.playerId,
      })),
    );
    game.phase = 'voting';
    game.ballot = 1;
    game.eligibleTargetIds = null;
    game.events.push({
      id: randomUUID(),
      type: 'system',
      text: '所有人描述完毕。观察措辞，投出你最怀疑的一票。',
      round: game.round,
    });
    return this.toPublic(game);
  }

  async submitHumanVote(id: string, targetId: string): Promise<PublicGameState> {
    const game = this.requireGame(id);
    this.assertPhase(game, 'voting');
    const human = this.human(game);
    if (!human.alive) throw new GameRuleError('你已出局，请继续观战');
    this.validateVoteTarget(game, human, targetId);

    const aiVotes = await this.generateVotes(game);
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
        const descriptions = await this.generateDescriptions(game);
        game.descriptions.push(...descriptions);
        game.events.push(
          ...descriptions.map((item) => ({
            id: randomUUID(),
            type: 'description' as const,
            text: item.text,
            round: game.round,
            playerId: item.playerId,
          })),
        );
        game.phase = 'voting';
        game.ballot = 1;
        game.eligibleTargetIds = null;
      } else {
        const votes = await this.generateVotes(game);
        game.votes.push(...votes);
        await this.resolveBallot(game, votes);
      }
    }
    if (safety >= 12 && !this.isFinished(game)) {
      throw new GameRuleError('自动对局轮次异常，请重新开局', 500);
    }
    return this.toPublic(game);
  }

  private async generateDescriptions(game: GameState): Promise<Description[]> {
    const agents = game.players.filter((player) => !player.isHuman && player.alive);
    const outputs = await Promise.all(
      agents.map(async (agent) => ({
        playerId: agent.id,
        text: await this.model.describe(buildAgentContext(game, agent)),
        round: game.round,
      })),
    );
    return outputs;
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

  private isFinished(game: GameState): boolean {
    return game.phase === 'finished';
  }
}

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}
