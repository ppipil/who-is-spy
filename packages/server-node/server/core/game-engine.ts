import { randomUUID } from 'node:crypto';
import { getAgentStrategy } from './agent-strategy.js';
import { buildAgentContext } from './agent-context.js';
import {
  containsSecretLeak,
  DescriptionQualityError,
  DescriptionQualityGate,
  normalizeDescription,
  repairGuidance,
  type DescriptionQualityEvent,
  type DescriptionSecretPolicy,
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
import { recordTraceRun, stampTraceOrigin, type TraceOrigin, type TraceSink } from '../trace/trace.js';
import { chooseWordPair } from './words.js';

export interface CreateGameOptions {
  wordPair?: readonly [string, string];
  descriptionSecretPolicy?: DescriptionSecretPolicy;
}

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

interface DescriptionResumeState {
  round: number;
  missingAgentId: string;
  manualResumeIndex: number;
  manualRetriesRemaining: number;
}

const MANUAL_DESCRIPTION_RESUME_MAX = 2;

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
  private readonly descriptionResume = new Map<string, DescriptionResumeState>();
  private readonly descriptionGenerationActive = new Set<string>();
  private readonly descriptionSecretPolicies = new Map<string, DescriptionSecretPolicy>();
  private readonly traceSink?: TraceSink;

  constructor(
    private readonly model: GameModel,
    private readonly random: () => number = Math.random,
    private readonly onQualityViolation: (event: DescriptionQualityEvent) => void = () => undefined,
    traceSink?: TraceSink,
    private readonly traceOrigin: TraceOrigin = {
      sourceType: 'TEST',
      entrypoint: 'test',
      modelKind: model.model === 'fake' ? 'fake' : model.isConfigured() ? 'real' : 'none',
    },
  ) {
    this.traceSink = traceSink ? stampTraceOrigin(traceSink, this.traceOrigin) : undefined;
    if (this.traceSink) this.model.setTraceSink?.(this.traceSink);
  }

  createGame(options: CreateGameOptions = {}): PublicGameState {
    const pair = options.wordPair ?? chooseWordPair(this.random);
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
    this.descriptionSecretPolicies.set(id, options.descriptionSecretPolicy ?? 'own_word_characters');
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
    recordTraceRun(this.traceSink, {
      runId: id,
      gameId: id,
      sourceType: this.traceOrigin.sourceType,
      entrypoint: this.traceOrigin.entrypoint,
      modelKind: this.traceOrigin.modelKind,
      status: 'running',
      createdAt: new Date(game.createdAt).toISOString(),
    });
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

  /**
   * 接收人类本轮描述并驱动整个描述阶段。
   * 先校验阶段、存活、长度、泄密和重复提交；校验通过后才公开人类描述，随后串行生成剩余 AI 描述。
   * 任一 AI 最终失败时不会进入投票，已成功公开的前缀会保留，供 resumeDescription 从断点继续。
   */
  async submitHumanDescription(id: string, text: string): Promise<PublicGameState> {
    const game = this.requireGame(id);
    this.assertPhase(game, 'describing');
    const human = this.human(game);
    if (!human.alive) throw new GameRuleError('你已出局，请继续观战');
    const description = normalizeText(text);
    if (description.length < 2 || description.length > 60) {
      throw new GameRuleError('描述需为 2–60 个字符');
    }
    const secretPolicy = this.descriptionSecretPolicies.get(game.id) ?? 'own_word_characters';
    if (containsSecretLeak(description, human.word, game.players.map((player) => player.word), secretPolicy)) {
      throw new GameRuleError('不能提到题目词或题目里的字');
    }
    if (game.descriptions.some((item) => item.round === game.round && item.playerId === human.id)) {
      throw new GameRuleError('本轮已经描述过了');
    }

    const humanDescription = { playerId: human.id, text: description, round: game.round };
    this.commitDescription(game, humanDescription);
    await this.runDescriptionGeneration(game);
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
        await this.runDescriptionGeneration(game);
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

  /**
   * 手动恢复一次停在 describing 的生成流程。
   * 它从本轮第一个缺失 Agent 开始，不重跑已提交发言；同时用 active set 防并发恢复，并限制每个失败点的手动预算。
   * 全部缺失描述补齐后才进入 voting；再次失败则保留一致状态并更新恢复计数。
   */
  async resumeDescription(id: string): Promise<PublicGameState> {
    const game = this.requireGame(id);
    this.assertPhase(game, 'describing');
    const human = this.human(game);
    if (!human.alive) throw new GameRuleError('你已出局，请继续观战');
    const humanDescribed = game.descriptions.some(
      (description) => description.round === game.round && description.playerId === human.id,
    );
    if (!humanDescribed) throw new GameRuleError('请先完成本轮你的描述');
    const pending = this.pendingDescriptionAgents(game);
    if (pending.length === 0) throw new GameRuleError('本轮描述已经完成');
    if (this.descriptionGenerationActive.has(game.id)) {
      throw new GameRuleError('已有生成请求进行中，请稍候', 409);
    }
    const missingAgentId = pending[0].id;
    const state = this.descriptionResume.get(game.id);
    if (
      state &&
      state.round === game.round &&
      state.missingAgentId === missingAgentId &&
      state.manualRetriesRemaining <= 0
    ) {
      throw new GameRuleError('本轮手动重试次数已用完，当前进度未损坏但暂时无法继续', 400);
    }
    const next: DescriptionResumeState = {
      round: game.round,
      missingAgentId,
      manualResumeIndex:
        (state && state.round === game.round && state.missingAgentId === missingAgentId ? state.manualResumeIndex : 0) + 1,
      manualRetriesRemaining:
        state && state.round === game.round && state.missingAgentId === missingAgentId
          ? state.manualRetriesRemaining
          : MANUAL_DESCRIPTION_RESUME_MAX,
    };
    this.descriptionResume.set(game.id, next);
    this.traceRecovery(game, missingAgentId, next, undefined);
    this.descriptionGenerationActive.add(game.id);
    try {
      await this.generateDescriptions(game);
      this.descriptionResume.delete(game.id);
      this.traceRecovery(game, missingAgentId, next, 'recovered');
      this.enterVoting(game);
    } catch (error) {
      const pendingAfter = this.pendingDescriptionAgents(game);
      const nextMissing = pendingAfter[0]?.id;
      if (nextMissing && nextMissing !== missingAgentId) {
        this.descriptionResume.set(game.id, {
          round: game.round,
          missingAgentId: nextMissing,
          manualResumeIndex: 1,
          manualRetriesRemaining: MANUAL_DESCRIPTION_RESUME_MAX,
        });
      } else {
        const updated = this.descriptionResume.get(game.id);
        if (updated) {
          updated.missingAgentId = nextMissing ?? missingAgentId;
          updated.manualRetriesRemaining = Math.max(0, updated.manualRetriesRemaining - 1);
        }
      }
      this.traceRecovery(game, missingAgentId, this.descriptionResume.get(game.id) ?? next, 'exhausted');
      throw error;
    } finally {
      this.descriptionGenerationActive.delete(game.id);
    }
    return this.toPublic(game);
  }

  /**
   * 描述生成的并发保护外壳。
   * 同一局同一时刻只允许一条生成链运行；失败时登记首个缺失 Agent 和恢复预算，finally 中必定释放锁。
   */
  private async runDescriptionGeneration(game: GameState): Promise<void> {
    if (this.descriptionGenerationActive.has(game.id)) {
      throw new GameRuleError('已有生成请求进行中，请稍候', 409);
    }
    this.descriptionGenerationActive.add(game.id);
    try {
      await this.generateDescriptions(game);
    } catch (error) {
      const pending = this.pendingDescriptionAgents(game);
      if (pending.length > 0 && this.human(game).alive) {
        this.descriptionResume.set(game.id, {
          round: game.round,
          missingAgentId: pending[0].id,
          manualResumeIndex: 0,
          manualRetriesRemaining: MANUAL_DESCRIPTION_RESUME_MAX,
        });
      }
      throw error;
    } finally {
      this.descriptionGenerationActive.delete(game.id);
    }
  }

  /**
   * 串行编排本轮尚未发言的 AI，是“后发者可见前序公开描述”的核心函数。
   * 每次循环都基于最新 GameState 构造隔离 AgentContext，再按 Persona 重试预算调用模型和质量门禁。
   * 只有通过长度、泄密、雷同检查的文本才会立即提交；预算耗尽则抛错，失败文本不污染公开状态。
   */
  private async generateDescriptions(game: GameState): Promise<Description[]> {
    const agents = this.pendingDescriptionAgents(game);
    const outputs: Description[] = [];
    const allSecrets = [...new Set(game.players.map((player) => player.word))];
    const secretPolicy = this.descriptionSecretPolicies.get(game.id) ?? 'own_word_characters';
    // 描述必须串行生成：每次循环都基于最新 GameState 重建隔离上下文；若改成 Promise.all，
    // 四个 Agent 会拿到同一份旧前缀，后发者就看不到同轮先发者刚公开的描述。
    for (const agent of agents) {
      const context = buildAgentContext(game, agent);
      const strategy = getAgentStrategy(context.identity.strategyId);
      const acceptedSameRound = game.descriptions
        .filter((description) => description.round === game.round)
        .map((description) => description.text);
      let violation: DescriptionQualityViolation | undefined;
      let acceptedText: string | undefined;
      // 质量失败只重试当前 Agent，并把 violation 转成修复提示；在 acceptedText 产生前不推进状态。
      for (let attempt = 1; attempt <= strategy.qualityPolicy.maxDescriptionAttempts; attempt += 1) {
        const text = normalizeDescription(
          await this.model.describe(context, {
            attempt,
            ...(violation
              ? { repair: { violationType: violation.type, guidance: repairGuidance(violation, secretPolicy) } }
              : {}),
            secretPolicy,
          }),
        );
        violation =
          this.qualityGate.check({
            text,
            ownSecret: agent.word,
            allSecrets,
            secretPolicy,
            acceptedSameRound,
            duplicateSimilarityThreshold: strategy.qualityPolicy.duplicateSimilarityThreshold,
          }) ?? undefined;
        if (!violation) {
          acceptedText = text;
          break;
        }
        const willRetry = attempt < strategy.qualityPolicy.maxDescriptionAttempts;
        const qualityEvent = {
          gameId: game.id,
          round: game.round,
          agentId: agent.id,
          strategyId: strategy.id,
          attempt,
          violationType: violation.type,
          ...(violation.similarity === undefined ? {} : { similarity: violation.similarity }),
          willRetry,
        };
        this.onQualityViolation(qualityEvent);
        this.traceSink?.record({
          eventType: 'quality_violation',
          phase: 'describing',
          runId: game.id,
          ...qualityEvent,
        });
      }
      if (acceptedText === undefined) {
        throw new DescriptionQualityError(
          'AI 描述未通过质量检查，状态未推进；请重试本次行动',
          violation?.type ?? 'empty',
        );
      }
      const description = { playerId: agent.id, text: acceptedText, round: game.round };
      // 先提交再进入下一次循环，是“逐步公开”成立的关键顺序。
      this.commitDescription(game, description);
      outputs.push(description);
    }
    return outputs;
  }

  /**
   * 计算本轮仍缺描述的存活 AI。
   * 该集合同时服务首次生成和断点恢复，确保恢复只补缺口，不重复调用已经成功的 Agent。
   */
  private pendingDescriptionAgents(game: GameState): Player[] {
    const describedPlayerIds = new Set(
      game.descriptions.filter((description) => description.round === game.round).map((description) => description.playerId),
    );
    return game.players.filter((player) => !player.isHuman && player.alive && !describedPlayerIds.has(player.id));
  }

  private traceRecovery(
    game: GameState,
    agentId: string,
    state: DescriptionResumeState,
    recoveryOutcome: 'recovered' | 'exhausted' | undefined,
  ): void {
    this.traceSink?.record({
      eventType: 'recovery_action',
      gameId: game.id,
      round: game.round,
      phase: 'describing',
      ballot: game.ballot,
      recoveryAction: 'description_resume',
      runId: game.id,
      agentId,
      agentName: game.players.find((player) => player.id === agentId)?.name,
      manualResumeIndex: state.manualResumeIndex,
      manualRetriesRemaining: state.manualRetriesRemaining,
      ...(recoveryOutcome ? { recoveryOutcome } : {}),
    });
  }

  /**
   * 将一条已验收描述原子地提升为公开事实。
   * 同步更新 descriptions、公共事件、trace 和 SSE 进度；调用完成后，下一位 Agent 重建上下文即可看到它。
   * 此函数不做质量判断，调用方必须先通过 DescriptionQualityGate。
   */
  private commitDescription(game: GameState, description: Description): void {
    // 只有通过长度、泄密和雷同门禁的文本才能进入公开事实源。
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

  /**
   * 在所有存活玩家完成本轮描述后切换到 voting。
   * 写入公开阶段事件、计算投票候选约束，并启动 AI 私有投票预取；描述未齐时不得调用。
   */
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

  /**
   * 提前生成当前 ballot 的 AI 私有候选票以隐藏等待时间。
   * 预取结果带 game/round/ballot/eligibleTargetIds 快照；失败只清缓存，不写入 GameState。
   */
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

  /**
   * 消费与当前投票快照完全匹配的预取结果。
   * 缓存缺失或过期时现场重算；整批失败直接抛出，因此不会提交半批 AI 票。
   */
  private async consumePendingAiVotes(game: GameState): Promise<Vote[]> {
    const pending = this.pendingAiVotes.get(game.id);
    if (!pending || !this.matchesPendingVotes(pending, game)) return this.generateVotes(game);
    this.pendingAiVotes.delete(game.id);
    const result = await pending.promise;
    if (!result.ok) throw result.error;
    return result.votes;
  }

  /** 校验预取票是否仍属于当前局、轮次、ballot 和候选集合，防止消费过期异步结果。 */
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

  /**
   * 并行生成全部存活 AI 的私有候选票。
   * 每个 voter 只拿自己的隔离上下文和合法目标；Promise.all 保证要么得到完整批次，要么整批失败。
   */
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

  /**
   * 以服务端权威规则结算一批完整票。
   * 负责计票、平票加票、淘汰、胜负判定、下一轮推进和终局复盘；模型只提候选，不能决定状态转换。
   */
  private async resolveBallot(game: GameState, votes: Vote[]): Promise<void> {
    this.recordVoteTrace(game, votes);
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
      recordTraceRun(this.traceSink, {
        runId: game.id,
        gameId: game.id,
        sourceType: this.traceOrigin.sourceType,
        entrypoint: this.traceOrigin.entrypoint,
        modelKind: this.traceOrigin.modelKind,
        status: 'completed',
        createdAt: new Date().toISOString(),
      });
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

  private recordVoteTrace(game: GameState, votes: Vote[]): void {
    const secrets = [...new Set(game.players.map((player) => player.word))];
    for (const vote of votes) {
      this.traceSink?.record({
        eventType: 'vote',
        gameId: game.id,
        round: vote.round,
        ballot: vote.ballot,
        agentId: vote.voterId,
        targetId: vote.targetId,
        reason: redactSecretWords(vote.reason, secrets),
        runId: game.id,
      });
    }
  }

  private checkWinner(game: GameState): Role | null {
    const alive = game.players.filter((player) => player.alive);
    const undercoverAlive = alive.filter((player) => player.role === 'undercover').length;
    if (undercoverAlive === 0) return 'civilian';
    if (undercoverAlive >= alive.length - undercoverAlive) return 'undercover';
    return null;
  }

  /**
   * 生成终局复盘。
   * 优先调用模型；若 provider 重试仍失败，则返回本地确定性 fallback 并记录 fallback trace，避免已完成对局因复盘失败而悬空。
   */
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
        runId: game.id,
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

  /**
   * 将服务端完整状态投影成客户端 DTO。
   * 终局前只给人类自己的 role/word，其他玩家不含秘密字段；只有 finished 后才附 revealedRole/revealedWord。
   */
  private toPublic(game: GameState): PublicGameState {
    const finished = game.phase === 'finished';
    const human = this.human(game);
    const resume = this.descriptionResume.get(game.id);
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
      ...(resume
        ? {
            descriptionResume: {
              missingAgentId: resume.missingAgentId,
              manualResumeIndex: resume.manualResumeIndex,
              manualRetriesRemaining: resume.manualRetriesRemaining,
            },
          }
        : {}),
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
      runId: game.id,
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

/** 在写公开理由或 trace 前替换完整密词；按长度降序处理，避免短词先替换破坏长词匹配。 */
export function redactSecretWords(text: string, secrets: readonly string[]): string {
  return [...new Set(secrets)].reduce((value, secret) => secret.length > 0 ? value.split(secret).join('[SECRET]') : value, text);
}
