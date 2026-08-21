/**
 * 游戏引擎（GameEngine）
 *
 * 服务端权威的“谁是卧底”状态机：
 * - 负责建局、阶段流转（描述 → 投票 → 淘汰/加票 → 终局）；
 * - AI 描述必须先过质量门禁才能提交，保证损坏状态不推进；
 * - AI 投票采用“私有预生成 + 匹配后消费”的缓存策略，提升交互响应；
 * - 所有公开事件与质量违例都会写入 trace，供评测与回放。
 *
 * 阶段流转主线：
 *   describing →（全员描述完毕）→ voting
 *   voting →（平票且未到加票上限）→ 同一轮 voting（ballot+1，限定平票者）
 *   voting →（淘汰）→ checkWinner：终局 finished / 否则 round+1 回到 describing
 */
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

// 固定 AI 阵容：四个预设 persona，分别对应四种策略。
const AI_PROFILES = [
  { name: '阿序', avatar: '序', strategyId: 'cautious' },
  { name: '弥生', avatar: '弥', strategyId: 'intuitive' },
  { name: '老墨', avatar: '墨', strategyId: 'analytical' },
  { name: '小满', avatar: '满', strategyId: 'contrarian' },
] as const;

// 预生成的 AI 投票批次：round/ballot/候选集合必须与当前局一致才可消费。
interface PendingAiVotes {
  gameId: string;
  round: number;
  ballot: number;
  eligibleTargetIds: string[] | null;
  promise: Promise<{ ok: true; votes: Vote[] } | { ok: false; error: unknown }>;
}

// 描述阶段生成失败后的手动恢复状态（记录缺口 agent 与剩余重试次数）。
interface DescriptionResumeState {
  round: number;
  missingAgentId: string;
  manualResumeIndex: number;
  manualRetriesRemaining: number;
}

// 描述生成失败后允许玩家手动恢复的最大次数。
const MANUAL_DESCRIPTION_RESUME_MAX = 2;

/** 规则类错误：携带 HTTP 状态码，由 app 层转换为对应响应。 */
export class GameRuleError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = 'GameRuleError';
  }
}

/**
 * 游戏引擎：持有全部进行中的对局，负责阶段流转与 AI 行为编排。
 * @param model                模型客户端（describe/vote/review）
 * @param random               随机源（评测时注入可复现的伪随机）
 * @param onQualityViolation   质量门禁违例回调（评测/admin 用它收集指标或写 trace）
 * @param traceSink            运行时 trace 出口（模型调用、公开事件、恢复动作等）
 */
export class GameEngine {
  private readonly games = new Map<string, GameState>();
  private readonly progressListeners = new Set<(event: PublicProgressEvent) => void>();
  // 每个进行中投票阶段预生成一批 AI 投票，避免玩家等待逐个调用。
  private readonly pendingAiVotes = new Map<string, PendingAiVotes>();
  // 描述质量门禁：检查空内容/长度/泄密/与同轮已公开描述重复。
  private readonly qualityGate = new DescriptionQualityGate();
  // 描述生成失败后的手动恢复状态，key 为 gameId。
  private readonly descriptionResume = new Map<string, DescriptionResumeState>();
  // 正在生成描述的局集合，防止同一局并发触发多次生成（409）。
  private readonly descriptionGenerationActive = new Set<string>();

  constructor(
    private readonly model: GameModel,
    private readonly random: () => number = Math.random,
    private readonly onQualityViolation: (event: DescriptionQualityEvent) => void = () => undefined,
    private readonly traceSink?: TraceSink,
  ) {
    if (traceSink) this.model.setTraceSink?.(traceSink);
  }

  /**
   * 创建新对局：随机词对、随机卧底席位，初始处于描述阶段第 1 轮。
   * 人类玩家固定为第一个（id='human'），其余 4 名 AI 按阵容生成。
   */
  createGame(): PublicGameState {
    // 词对与卧底席位都来自注入的随机源，保证评测可复现。
    const pair = chooseWordPair(this.random);
    const undercoverIndex = Math.floor(this.random() * 5);
    // 随机决定平民/卧底词是否交换（避免固定席位与固定词强绑定）。
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
      phase: 'describing', // 新局从描述阶段开始
      round: 1,
      ballot: 1,
      players,
      descriptions: [],
      votes: [],
      // 首轮系统提示：说明密词已发放。
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

  /** 获取对局的公开视图（隐藏所有玩家身份直到终局）。 */
  getGame(id: string): PublicGameState {
    return this.toPublic(this.requireGame(id));
  }

  /** 获取内部完整状态，仅供评测/管理后台使用，不做对外响应。 */
  getInternalGame(id: string): GameState {
    return this.requireGame(id);
  }

  /** 当前进行中的对局数量（管理后台状态展示用）。 */
  activeGameCount(): number {
    return this.games.size;
  }

  /** 订阅公开进度事件（SSE 推送用），返回退订函数。 */
  subscribeToPublicProgress(listener: (event: PublicProgressEvent) => void): () => void {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  /**
   * 人类提交本轮描述：
   * 校验通过后先落库人类描述，再顺序生成剩余 AI 描述，最后进入投票阶段。
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
    // 人类也不能直接说出自己的密词（与 AI 质量门禁同一约束）。
    if (description.includes(human.word)) {
      throw new GameRuleError('不能直接说出你的秘密词');
    }
    if (game.descriptions.some((item) => item.round === game.round && item.playerId === human.id)) {
      throw new GameRuleError('本轮已经描述过了');
    }

    // 先提交人类描述（同步落库 + 推送），再进行 AI 生成。
    const humanDescription = { playerId: human.id, text: description, round: game.round };
    this.commitDescription(game, humanDescription);
    await this.runDescriptionGeneration(game);
    this.enterVoting(game);
    return this.toPublic(game);
  }

  /** 人类提交投票：消费/生成 AI 票后统一结算本轮 ballot。 */
  async submitHumanVote(id: string, targetId: string): Promise<PublicGameState> {
    const game = this.requireGame(id);
    this.assertPhase(game, 'voting');
    const human = this.human(game);
    if (!human.alive) throw new GameRuleError('你已出局，请继续观战');
    this.validateVoteTarget(game, human, targetId);

    // 若缓存批与当前 round/ballot/候选一致则直接消费，否则现场生成。
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
    // 结算后立即为下一 ballot / 下一轮预生成 AI 票。
    this.prefetchAiVotes(game);
    return this.toPublic(game);
  }

  /**
   * 观战模式：人类出局后由服务器自动替人类行动，直到终局。
   * safety 上限防止异常状态下无限循环。
   */
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
   * 描述阶段手动恢复：AI 生成失败后，玩家点击“继续”重试生成缺口描述。
   * 恢复过程写 trace（started/recovered/exhausted），并限制手动重试次数。
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
    // 找到第一个尚未完成描述的存活 AI 作为恢复缺口。
    const missingAgentId = pending[0].id;
    const state = this.descriptionResume.get(game.id);
    // 同一缺口手动重试次数耗尽后不允许继续。
    if (
      state &&
      state.round === game.round &&
      state.missingAgentId === missingAgentId &&
      state.manualRetriesRemaining <= 0
    ) {
      throw new GameRuleError('本轮手动重试次数已用完，当前进度未损坏但暂时无法继续', 400);
    }
    // 累计手动恢复序号；换缺口时重置，同一缺口继续累加。
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
      // 恢复仍失败：记录新的缺口，并扣减剩余重试次数。
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

  /** 生成本轮剩余 AI 描述；失败时若人类仍在场则登记可恢复状态。 */
  private async runDescriptionGeneration(game: GameState): Promise<void> {
    if (this.descriptionGenerationActive.has(game.id)) {
      throw new GameRuleError('已有生成请求进行中，请稍候', 409);
    }
    this.descriptionGenerationActive.add(game.id);
    try {
      await this.generateDescriptions(game);
    } catch (error) {
      // 失败不推进状态：登记缺口供玩家手动恢复（仅人类在场时需要）。
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
   * 顺序生成所有未描述 AI 的描述：
   * 每个 agent 单独构建上下文（能看到前面已提交的描述），
   * 逐条过质量门禁，接受后才 commit；全部耗尽则抛错，本轮不推进。
   */
  private async generateDescriptions(game: GameState): Promise<Description[]> {
    const agents = this.pendingDescriptionAgents(game);
    const outputs: Description[] = [];
    // 全部密词（平民词+卧底词），用于泄密检查。
    const allSecrets = [...new Set(game.players.map((player) => player.word))];
    for (const agent of agents) {
      // 为当前 agent 构造可见上下文（含前面玩家已公开的描述）。
      const context = buildAgentContext(game, agent);
      const strategy = getAgentStrategy(context.identity.strategyId);
      // 本轮已接受的描述文本，用于重复度检查。
      const acceptedSameRound = game.descriptions
        .filter((description) => description.round === game.round)
        .map((description) => description.text);
      let violation: DescriptionQualityViolation | undefined;
      let acceptedText: string | undefined;
      // 质量门禁重试循环：违例时带上修复指引重新请求模型。
      for (let attempt = 1; attempt <= strategy.qualityPolicy.maxDescriptionAttempts; attempt += 1) {
        const text = normalizeDescription(
          await this.model.describe(context, {
            attempt,
            ...(violation
              ? { repair: { violationType: violation.type, guidance: repairGuidance(violation) } }
              : {}),
          }),
        );
        // 服务端权威检查：泄密/重复/长度/空内容。
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
        // 记录违例（admin trace / 评测指标），判断是否还有重试机会。
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
        // 重试耗尽：抛出质量错误，任何候选都未提交，状态停留在原阶段。
        throw new DescriptionQualityError(
          'AI 描述未通过质量检查，状态未推进；请重试本次行动',
          violation?.type ?? 'empty',
        );
      }
      // 只有通过门禁的文本才写入 GameState 并对外公开。
      const description = { playerId: agent.id, text: acceptedText, round: game.round };
      this.commitDescription(game, description);
      outputs.push(description);
    }
    return outputs;
  }

  /** 本轮尚未完成描述、且仍存活的 AI 列表（按原玩家顺序）。 */
  private pendingDescriptionAgents(game: GameState): Player[] {
    const describedPlayerIds = new Set(
      game.descriptions.filter((description) => description.round === game.round).map((description) => description.playerId),
    );
    return game.players.filter((player) => !player.isHuman && player.alive && !describedPlayerIds.has(player.id));
  }

  /** 记录描述恢复动作（开始/成功/耗尽三种状态）到 trace。 */
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
      agentId,
      agentName: game.players.find((player) => player.id === agentId)?.name,
      manualResumeIndex: state.manualResumeIndex,
      manualRetriesRemaining: state.manualRetriesRemaining,
      ...(recoveryOutcome ? { recoveryOutcome } : {}),
    });
  }

  /** 提交一条描述：写入 GameState、追加公开事件、写 trace、推送 SSE 进度。 */
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
    this.tracePublicEvent(game, event.type, event.text, description.playerId);
    // 计算下一位发言的存活 AI（用于前端展示进度）。
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

  /** 全员描述完毕 → 进入投票阶段（ballot=1，无候选限制），并预生成 AI 票。 */
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
    this.tracePublicEvent(game, event.type, event.text);
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
   * 预生成 AI 投票：若已有缓存且与当前 round/ballot/候选一致则跳过；
   * 否则发起新一批后台生成，失败时自动清理缓存。
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

  /** 消费已缓存的 AI 票；缓存不存在或不匹配则现场生成。 */
  private async consumePendingAiVotes(game: GameState): Promise<Vote[]> {
    const pending = this.pendingAiVotes.get(game.id);
    if (!pending || !this.matchesPendingVotes(pending, game)) return this.generateVotes(game);
    this.pendingAiVotes.delete(game.id);
    const result = await pending.promise;
    if (!result.ok) throw result.error;
    return result.votes;
  }

  /** 缓存批次是否与当前状态匹配（平票加票会改变 eligible，导致缓存失效）。 */
  private matchesPendingVotes(pending: PendingAiVotes, game: GameState): boolean {
    const eligible = game.eligibleTargetIds ? [...game.eligibleTargetIds] : null;
    return pending.gameId === game.id
      && pending.round === game.round
      && pending.ballot === game.ballot
      && JSON.stringify(pending.eligibleTargetIds) === JSON.stringify(eligible);
  }

  /** 向所有订阅者广播公开进度事件（SSE）。 */
  private emitPublicProgress(event: PublicProgressEvent): void {
    for (const listener of this.progressListeners) listener(event);
  }

  /** 并行生成所有存活 AI 的投票（各自构建上下文 + 服务端限定候选）。 */
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
   * 结算一次投票：
   * - 平票且 ballot<2 → 加票轮（ballot+1，候选锁定平票者），留在投票阶段；
   * - 否则淘汰得票最多者（加票后仍平则随机），再判断胜负/进入下一轮。
   */
  private async resolveBallot(game: GameState, votes: Vote[]): Promise<void> {
    const counts = new Map<string, number>();
    for (const vote of votes) counts.set(vote.targetId, (counts.get(vote.targetId) ?? 0) + 1);
    const maxVotes = Math.max(...counts.values());
    const leaders = [...counts.entries()].filter(([, count]) => count === maxVotes).map(([id]) => id);

    if (leaders.length > 1 && game.ballot < 2) {
      // 首次平票：进入最终加票，只允许投给平票者。
      game.ballot += 1;
      game.eligibleTargetIds = leaders;
      const names = leaders.map((id) => game.players.find((player) => player.id === id)?.name).join('、');
      const event = {
        id: randomUUID(),
        type: 'vote_result' as const,
        text: `${names} 同票，进入最终加票。`,
        round: game.round,
      };
      game.events.push(event);
      this.tracePublicEvent(game, 'vote_result', event.text);
      return;
    }

    const eliminatedId = leaders.length === 1 ? leaders[0] : leaders[Math.floor(this.random() * leaders.length)];
    const eliminated = game.players.find((player) => player.id === eliminatedId);
    if (!eliminated) throw new GameRuleError('投票结果无效', 500);
    eliminated.alive = false;
    game.eligibleTargetIds = null;
    const eliminationEvent = {
      id: randomUUID(),
      type: 'elimination' as const,
      text: `${eliminated.name} 被投出局。身份将在终局揭晓。`,
      round: game.round,
      playerId: eliminated.id,
    };
    game.events.push(eliminationEvent);
    this.tracePublicEvent(game, 'elimination', eliminationEvent.text, eliminated.id);

    // 淘汰后检查胜负条件。
    const winner = this.checkWinner(game);
    if (winner) {
      // 终局：记录胜者、置为 finished，并生成复盘（失败走本地 fallback）。
      game.winner = winner;
      game.phase = 'finished';
      game.review = await this.createReview(game);
      return;
    }

    // 未分胜负：进入下一轮，重置 ballot 回到描述阶段。
    game.round += 1;
    game.ballot = 1;
    game.phase = 'describing';
    const roundStartEvent = {
      id: randomUUID(),
      type: 'system' as const,
      text: `第 ${game.round} 轮开始。换个角度描述，别让身份暴露。`,
      round: game.round,
    };
    game.events.push(roundStartEvent);
    this.tracePublicEvent(game, 'system', roundStartEvent.text);
  }

  /** 胜负判定：卧底全灭则平民胜；卧底人数 ≥ 存活一半则卧底胜。 */
  private checkWinner(game: GameState): Role | null {
    const alive = game.players.filter((player) => player.alive);
    const undercoverAlive = alive.filter((player) => player.role === 'undercover').length;
    if (undercoverAlive === 0) return 'civilian';
    if (undercoverAlive >= alive.length - undercoverAlive) return 'undercover';
    return null;
  }

  /** 终局复盘：调用模型生成；失败时写 fallback trace 并返回本地模板复盘。 */
  private async createReview(game: GameState): Promise<GameReview> {
    try {
      return await this.model.review(game);
    } catch {
      // 复盘失败不影响胜负结果，降级为确定性本地复盘。
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

  /** 计算某投票者可投的存活目标；加票轮受 eligibleTargetIds 限制。 */
  private allowedTargets(game: GameState, voter: Player): Player[] {
    const eligible = game.eligibleTargetIds ? new Set(game.eligibleTargetIds) : null;
    const targets = game.players.filter(
      (player) => player.alive && player.id !== voter.id && (!eligible || eligible.has(player.id)),
    );
    if (targets.length === 0) throw new GameRuleError(`${voter.name} 没有可投票目标`, 500);
    return targets;
  }

  /** 校验人类投票目标是否合法（存活、非自己、符合加票限制）。 */
  private validateVoteTarget(game: GameState, voter: Player, targetId: string): void {
    if (!this.allowedTargets(game, voter).some((player) => player.id === targetId)) {
      throw new GameRuleError('请选择一名有效的存活玩家');
    }
  }

  /** 转换为公开视图：终局前隐藏所有 role/word，终局后才揭晓身份与密词。 */
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
      // 人类玩家始终能看到自己的身份与密词。
      human: { playerId: human.id, role: human.role, word: human.word },
      model: this.model.model,
      // 存在描述缺口时附带恢复信息，供前端显示“继续”入口。
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

  /** 取对局内部状态；不存在则返回 404 规则错误。 */
  private requireGame(id: string): GameState {
    const game = this.games.get(id);
    if (!game) throw new GameRuleError('对局不存在或已过期', 404);
    return game;
  }

  /** 取人类玩家（建局时固定为第一个玩家）。 */
  private human(game: GameState): Player {
    return game.players.find((player) => player.isHuman)!;
  }

  /** 阶段断言：请求动作只能在对应阶段执行。 */
  private assertPhase(game: GameState, phase: GameState['phase']): void {
    if (game.phase !== phase) throw new GameRuleError(`当前不在${phase === 'describing' ? '描述' : '投票'}阶段`);
  }

  /** 记录一条公开事件到 trace（含事件文本，供回放与评测查看实际内容）。 */
  private tracePublicEvent(game: GameState, publicEventType: string, text: string, agentId?: string): void {
    const player = agentId ? game.players.find((candidate) => candidate.id === agentId) : undefined;
    this.traceSink?.record({
      eventType: 'public_event',
      gameId: game.id,
      round: game.round,
      phase: game.phase,
      ballot: game.ballot,
      publicEventType,
      text,
      agentId,
      agentName: player?.name,
      outcome: 'success',
    });
  }

  /** 终局判断：phase === 'finished'。 */
  private isFinished(game: GameState): boolean {
    return game.phase === 'finished';
  }
}

/** 归一化文本：去除首尾空白、折叠连续空白。 */
function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}
