/**
 * 批量评测（Evaluation）
 *
 * 用可控随机源连续跑 N 局“谁是卧底”，并做全面度量：
 * - 完成率、泄密率、重复拒稿率、重试率、非法输出率、有效投票率；
 * - 延迟 p50/p95、token 用量与成本估算（真实 provider 返回 usage 时）；
 * - 按策略（persona）分组的胜率与投票准确率；
 * - 描述同质度（Dice 系数）与安全指标（secret/public/illegal leak）。
 *
 * 关键约束：评测结论以 gate 为准——任何一局未正常完成、
 * 出现泄密或非法状态，gate 都会 FAIL，CLI/管理后台据此判定回归。
 */
import { performance } from 'node:perf_hooks';
import { GameEngine } from './game-engine.js';
import type { DescriptionQualityEvent } from './description-quality.js';
import type { GameModel, ModelUsageEvent } from './model.js';
import { DeepSeekClient } from './model.js';
import { FakeGameModel } from './test-utils.js';
import type { RuntimeTraceDraft, TraceEntrypoint, TraceModelKind, TraceSink } from './trace.js';
import type { AgentContext, GameReview, GameState, Player, PublicGameState, Role } from './types.js';

export type EvaluationModelKind = 'fake' | 'real';
export type EvaluationTask = 'describe' | 'vote' | 'review';

/** 评测进度回调：已跑局数/总局数，供管理后台实时展示。 */
export interface EvaluationProgress {
  completedGames: number;
  totalGames: number;
}

/** token 用量汇总：总量、每局均值、按任务拆分（含重试额外消耗）、数据来源。 */
export interface EvaluationTokenUsage {
  input: number;
  output: number;
  total: number;
  averagePerGame: { input: number; output: number; total: number };
  byTask: Record<EvaluationTask, { input: number; output: number; total: number; retryAddedTokens: number }>;
  source: 'provider' | 'unavailable';
}

/** 成本估算所需的单价配置（默认使用 DeepSeek 公开价格快照）。 */
export interface EvaluationCostConfig {
  model: string;
  currency: string;
  inputTokenPricePer1M: number;
  outputTokenPricePer1M: number;
  source: string;
  sourceDate: string;
}

/** 成本估算结果：未提供单价或拿不到 token 时标记 unavailable。 */
export interface EvaluationCostEstimate {
  source: 'configured' | 'unavailable';
  model: string;
  currency: string;
  inputTokenPricePer1M: number | null;
  outputTokenPricePer1M: number | null;
  priceSource: string | null;
  priceSourceDate: string | null;
  inputCost: number;
  outputCost: number;
  totalCost: number;
  averageCostPerGame: number;
  formula: string;
}

/** 评测运行配置：局数、随机种子、模型类型；评测会注入这些到引擎中。 */
export interface EvaluationOptions {
  games: number;
  seed: number;
  modelKind: EvaluationModelKind;
  model?: GameModel;
  cost?: EvaluationCostConfig;
  onProgress?: (progress: EvaluationProgress) => void;
  runId?: string;
  traceSink?: TraceSink;
  entrypoint?: TraceEntrypoint;
}

/** 单策略（persona）维度的胜负与投票统计。 */
export interface StrategyEvaluationMetrics {
  games: number;
  wins: number;
  winRate: number;
  votes: number;
  accurateVotes: number;
  voteAccuracy: number;
}

/** 一次评测的全部指标（schemaVersion 1 的固定结构）。 */
export interface EvaluationMetrics {
  startedGames: number;
  completedGames: number;
  completionRate: number;
  descriptionAttempts: number;
  secretLeakRejectRate: number;
  duplicateRejectRate: number;
  invalidOutputRate: number;
  validVoteRate: number;
  retryRate: number;
  qualityRepairCount: number;
  providerRetryCount: number;
  latencyMs: { p50: number; p95: number };
  tokenUsage: EvaluationTokenUsage;
  cost: EvaluationCostEstimate;
  byStrategyId: Record<string, StrategyEvaluationMetrics>;
  descriptionHomogeneity: number;
  safety: {
    secretLeakOccurrences: number;
    publicStateLeakOccurrences: number;
    illegalStateOccurrences: number;
  };
}

/** 评测结果：配置 + 指标 + 门禁结论（failures 为具体失败原因）。 */
export interface EvaluationResult {
  schemaVersion: 1;
  configuration: { games: number; seed: number; model: EvaluationModelKind };
  metrics: EvaluationMetrics;
  gate: { passed: boolean; failures: string[] };
}

/** 内部可变的策略统计（最终导出前补全胜率/准确率）。 */
interface MutableStrategyMetrics {
  games: number;
  wins: number;
  votes: number;
  accurateVotes: number;
}

/** 埋点聚合：所有尝试数、延迟、usage 事件、质量违例与策略票型。 */
interface Instrumentation {
  descriptionAttempts: number;
  voteAttempts: number;
  reviewAttempts: number;
  invalidOutputs: number;
  validVotes: number;
  latencies: number[];
  usageEvents: ModelUsageEvent[];
  strategyVotes: Map<string, { votes: number; accurateVotes: number }>;
  qualityViolations: DescriptionQualityEvent[];
}

/**
 * 埋点模型：包装真实/假模型，统计每次调用的尝试次数、延迟、
 * 非法输出与投票准确度；评测的所有行为指标都来自这层包装。
 */
class InstrumentedModel implements GameModel {
  readonly model: string;

  constructor(
    private readonly delegate: GameModel,
    private readonly instrumentation: Instrumentation,
  ) {
    this.model = delegate.model;
  }

  isConfigured(): boolean {
    return this.delegate.isConfigured();
  }

  /** 描述调用：计尝试数并测量延迟。 */
  async describe(context: AgentContext): Promise<string> {
    this.instrumentation.descriptionAttempts += 1;
    return this.measure(() => this.delegate.describe(context));
  }

  /**
   * 投票调用：除延迟外还校验目标合法性（allowedTargets 内），
   * 并按策略记录“投中卧底”的准确票数。
   */
  async vote(
    context: AgentContext,
    allowedTargets: Player[],
  ): Promise<{ targetId: string; reason: string }> {
    this.instrumentation.voteAttempts += 1;
    try {
      const result = await this.measure(() => this.delegate.vote(context, allowedTargets));
      const target = allowedTargets.find((candidate) => candidate.id === result.targetId);
      const strategyId = strategyIdOfContext(context);
      const group = this.instrumentation.strategyVotes.get(strategyId) ?? { votes: 0, accurateVotes: 0 };
      group.votes += 1;
      if (target) {
        this.instrumentation.validVotes += 1;
        if (target.role === 'undercover') group.accurateVotes += 1;
      } else {
        this.instrumentation.invalidOutputs += 1;
      }
      this.instrumentation.strategyVotes.set(strategyId, group);
      return result;
    } catch (error) {
      throw error;
    }
  }

  /** 复盘调用：计尝试数并测量延迟。 */
  async review(game: GameState): Promise<GameReview> {
    this.instrumentation.reviewAttempts += 1;
    return this.measure(() => this.delegate.review(game));
  }

  /** 统一测量：记录耗时，抛错时计入非法输出。 */
  private async measure<T>(operation: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    try {
      return await operation();
    } catch (error) {
      this.instrumentation.invalidOutputs += 1;
      throw error;
    } finally {
      this.instrumentation.latencies.push(performance.now() - startedAt);
    }
  }
}

/**
 * 评测入口：按种子跑 N 局并汇总指标。
 * 每一局都创建独立 GameEngine（共享同一随机源），驱动到终局；
 * 全程收集埋点数据、质量违例、token 用量与安全事件。
 */
export async function runEvaluation(options: EvaluationOptions): Promise<EvaluationResult> {
  if (!Number.isInteger(options.games) || options.games < 1) throw new Error('--games must be a positive integer');
  if (!Number.isInteger(options.seed)) throw new Error('--seed must be an integer');

  // 注入 mulberry32 伪随机源，保证同一种子结果可复现。
  const random = mulberry32(options.seed);
  const instrumentation: Instrumentation = {
    descriptionAttempts: 0,
    voteAttempts: 0,
    reviewAttempts: 0,
    invalidOutputs: 0,
    validVotes: 0,
    latencies: [],
    usageEvents: [],
    strategyVotes: new Map(),
    qualityViolations: [],
  };
  // fake/real 二选一；不支持埋点接口的模型自动跳过 usage 记录。
  const delegate = options.model ?? (options.modelKind === 'fake' ? new FakeGameModel() : new DeepSeekClient());
  if (!delegate.isConfigured()) throw new Error(`model ${delegate.model} is not configured`);
  // 绑定 provider 用量回调：DeepSeek 响应中的 usage 字段会进入评测指标。
  if ('setUsageRecorder' in delegate) {
    delegate.setUsageRecorder?.((event) => instrumentation.usageEvents.push(event));
  }
  const origin = {
    sourceType: 'EVAL_RUN' as const,
    entrypoint: options.entrypoint ?? ('admin' as TraceEntrypoint),
    modelKind: options.modelKind as TraceModelKind,
  };
  if ('setOrigin' in delegate) {
    delegate.setOrigin?.(origin);
  }
  // 评测 trace 统一打上 runId/source/sourceType 标记，便于管理后台按 run 过滤。
  const traceSink = options.traceSink
    ? stampEvaluationTrace(options.traceSink, options.runId, origin)
    : undefined;
  if ('setTraceSink' in delegate && traceSink) {
    delegate.setTraceSink?.(traceSink);
  }
  const model = new InstrumentedModel(delegate, instrumentation);

  let completedGames = 0;
  let secretLeakOccurrences = 0;
  let publicStateLeakOccurrences = 0;
  let illegalStateOccurrences = 0;
  const pairSimilarities: number[] = [];
  const strategyMetrics = new Map<string, MutableStrategyMetrics>();

  for (let gameIndex = 0; gameIndex < options.games; gameIndex += 1) {
    // 每局新引擎：注入同一随机源 + 质量违例收集回调。
    const engine = new GameEngine(model, random, (event) => {
      instrumentation.qualityViolations.push(event);
      traceSink?.record({
        eventType: 'quality_violation',
        gameId: event.gameId,
        round: event.round,
        agentId: event.agentId,
        strategyId: event.strategyId,
        attempt: event.attempt,
        violationType: event.violationType,
        willRetry: event.willRetry,
      });
    });
    let publicGame = engine.createGame();
    // 评测生命周期事件：便于在 trace 中定位某一局。
    traceSink?.record({
      eventType: 'public_event',
      gameId: publicGame.id,
      round: 0,
      phase: 'evaluation',
      publicEventType: 'evaluation_game_start',
      text: `评测局 ${gameIndex + 1}/${options.games} 开始`,
      outcome: 'success',
    });
    // 建局即检查一次公开 DTO（终局前不得泄露身份字段）。
    publicStateLeakOccurrences += countPublicStateLeaks(publicGame);
    try {
      publicGame = await driveGame(engine, publicGame);
      publicStateLeakOccurrences += countPublicStateLeaks(publicGame);
      // 终局后把局内公开内容（描述/投票）补发到 trace，密词脱敏。
      const internal = engine.getInternalGame(publicGame.id);
      publishPublicGameTrace(traceSink, internal, gameIndex + 1, options.games);
      if (publicGame.phase === 'finished' && publicGame.winner) {
        completedGames += 1;
        // 按策略统计胜场（每名 AI 各计一次）。
        collectStrategyOutcomes(internal, publicGame.winner, strategyMetrics);
        traceSink?.record({
          eventType: 'public_event',
          gameId: publicGame.id,
          round: publicGame.round,
          phase: 'evaluation',
          publicEventType: 'evaluation_game_completed',
          text: `评测局 ${gameIndex + 1}/${options.games} 完成（winner: ${publicGame.winner}）`,
          outcome: 'success',
        });
      } else {
        // 跑到终局但状态非法（如 24 次动作上限未结束）也记为失败。
        illegalStateOccurrences += 1;
        traceSink?.record({
          eventType: 'public_event',
          gameId: publicGame.id,
          round: publicGame.round,
          phase: 'evaluation',
          publicEventType: 'evaluation_game_failed',
          text: `评测局 ${gameIndex + 1}/${options.games} 未进入完成状态`,
          outcome: 'failure',
        });
      }
      secretLeakOccurrences += countSecretLeaks(internal);
      pairSimilarities.push(...descriptionPairSimilarities(internal));
    } catch (error) {
      // 中途抛错：视为非法状态，尽量仍发布公开内容 trace 便于定位。
      illegalStateOccurrences += 1;
      try {
        publishPublicGameTrace(traceSink, engine.getInternalGame(publicGame.id), gameIndex + 1, options.games);
      } catch {
        // 半途失败且无法取得内部状态时跳过公开事件发布
      }
      traceSink?.record({
        eventType: 'public_event',
        gameId: publicGame.id,
        round: publicGame.round,
        phase: 'evaluation',
        publicEventType: 'evaluation_game_failed',
        text: `评测局 ${gameIndex + 1}/${options.games} 失败：${error instanceof Error ? error.message : String(error)}`,
        outcome: 'failure',
      });
    }
      options.onProgress?.({ completedGames: gameIndex + 1, totalGames: options.games });
  }

  // 合并埋点里的策略票型到按局统计中。
  for (const [strategyId, votes] of instrumentation.strategyVotes) {
    const group = strategyMetrics.get(strategyId) ?? { games: 0, wins: 0, votes: 0, accurateVotes: 0 };
    group.votes += votes.votes;
    group.accurateVotes += votes.accurateVotes;
    strategyMetrics.set(strategyId, group);
  }

  const modelAttempts = instrumentation.descriptionAttempts + instrumentation.voteAttempts + instrumentation.reviewAttempts;
  const tokenUsage = buildTokenUsage(instrumentation.usageEvents, options.games);
  const cost = buildCostEstimate(tokenUsage, options.cost ?? DEFAULT_COST_CONFIG, delegate.model, options.games);
  // 汇总全部指标：比率统一四舍五入到 4 位小数。
  const metrics: EvaluationMetrics = {
    startedGames: options.games,
    completedGames,
    completionRate: ratio(completedGames, options.games),
    descriptionAttempts: instrumentation.descriptionAttempts,
    secretLeakRejectRate: ratio(
      instrumentation.qualityViolations.filter((event) => event.violationType === 'secret_leak').length,
      instrumentation.descriptionAttempts,
    ),
    duplicateRejectRate: ratio(
      instrumentation.qualityViolations.filter((event) => event.violationType === 'duplicate_description').length,
      instrumentation.descriptionAttempts,
    ),
    invalidOutputRate: ratio(instrumentation.invalidOutputs, modelAttempts),
    validVoteRate: ratio(instrumentation.validVotes, instrumentation.voteAttempts),
    qualityRepairCount: instrumentation.qualityViolations.length,
    providerRetryCount: instrumentation.usageEvents.filter((event) => event.providerAttempt > 1).length,
    retryRate: ratio(
      instrumentation.qualityViolations.filter((event) => event.willRetry).length,
      instrumentation.descriptionAttempts,
    ),
    latencyMs: {
      p50: percentile(instrumentation.latencies, 0.5),
      p95: percentile(instrumentation.latencies, 0.95),
    },
    tokenUsage,
    cost,
    byStrategyId: Object.fromEntries(
      [...strategyMetrics.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([id, group]) => [
        id,
        {
          ...group,
          winRate: ratio(group.wins, group.games),
          voteAccuracy: ratio(group.accurateVotes, group.votes),
        },
      ]),
    ),
    descriptionHomogeneity: average(pairSimilarities),
    safety: { secretLeakOccurrences, publicStateLeakOccurrences, illegalStateOccurrences },
  };

  // 门禁：任何一条不满足都让本次评测 FAIL（CLI 会以非零码退出）。
  const failures: string[] = [];
  if (metrics.completionRate !== 1) failures.push('completionRate must equal 1.0');
  if (secretLeakOccurrences > 0) failures.push('secret descriptions must not reach committed state');
  if (publicStateLeakOccurrences > 0) failures.push('pre-finale public DTO must not expose secret fields');
  if (illegalStateOccurrences > 0) failures.push('evaluation games must not enter illegal or incomplete state');
  if (metrics.validVoteRate !== 1) failures.push('validVoteRate must equal 1.0');

  return {
    schemaVersion: 1,
    configuration: { games: options.games, seed: options.seed, model: options.modelKind },
    metrics,
    gate: { passed: failures.length === 0, failures },
  };
}

/**
 * 驱动单局：用固定策略模拟人类玩家（每轮固定描述文案、投第一个合法目标），
 * 直到终局或超过 24 次动作上限（上限本身会被 gate 判定为非法状态）。
 */
async function driveGame(engine: GameEngine, initial: PublicGameState): Promise<PublicGameState> {
  let game = initial;
  let actions = 0;
  while (game.phase !== 'finished' && actions < 24) {
    actions += 1;
    const human = game.players.find((player) => player.isHuman)!;
    if (!human.alive) return engine.continueAsSpectator(game.id);
    if (game.phase === 'describing') {
      game = await engine.submitHumanDescription(game.id, `第${game.round}轮我想到一种常见体验`);
    } else {
      const allowed = game.eligibleTargetIds
        ? game.eligibleTargetIds
        : game.players.filter((player) => player.alive && !player.isHuman).map((player) => player.id);
      game = await engine.submitHumanVote(game.id, allowed[0]);
    }
  }
  return game;
}

/** 统计公开 DTO 中意外暴露的身份字段数（终局前不应有任何 role/word）。 */
function countPublicStateLeaks(game: PublicGameState): number {
  if (game.phase === 'finished') return 0;
  return game.players.reduce((count, player) => {
    const record = player as unknown as Record<string, unknown>;
    return count + ['role', 'word', 'revealedRole', 'revealedWord'].filter((field) => field in record).length;
  }, 0);
}

/** 统计已提交描述中包含任一密词的条数（质量门禁应该已拦截）。 */
function countSecretLeaks(game: GameState): number {
  const secrets = [...new Set(game.players.map((player) => player.word))];
  return game.descriptions.filter((description) =>
    secrets.some((secret) => description.text.includes(secret)),
  ).length;
}

/** 按策略聚合每局结果：每个 AI 玩家计一场，阵营胜则计一次胜场。 */
function collectStrategyOutcomes(
  game: GameState,
  winner: Role,
  groups: Map<string, MutableStrategyMetrics>,
): void {
  for (const player of game.players.filter((candidate) => !candidate.isHuman)) {
    const strategyId = strategyIdOfPlayer(player);
    const group = groups.get(strategyId) ?? { games: 0, wins: 0, votes: 0, accurateVotes: 0 };
    group.games += 1;
    if (player.role === winner) group.wins += 1;
    groups.set(strategyId, group);
  }
}

/** 每轮非人类描述两两计算 Dice 相似度，供同质度指标使用。 */
function descriptionPairSimilarities(game: GameState): number[] {
  const values: number[] = [];
  const rounds = new Set(game.descriptions.map((description) => description.round));
  for (const round of rounds) {
    const texts = game.descriptions
      .filter((description) => description.round === round && description.playerId !== 'human')
      .map((description) => description.text);
    for (let left = 0; left < texts.length; left += 1) {
      for (let right = left + 1; right < texts.length; right += 1) {
        values.push(diceCoefficient(texts[left], texts[right]));
      }
    }
  }
  return values;
}

/** Dice 系数：基于 bigram 集合的相似度，0~1。 */
function diceCoefficient(left: string, right: string): number {
  const leftPairs = bigrams(normalizeForSimilarity(left));
  const rightPairs = bigrams(normalizeForSimilarity(right));
  if (leftPairs.size === 0 && rightPairs.size === 0) return 1;
  let overlap = 0;
  for (const pair of leftPairs) if (rightPairs.has(pair)) overlap += 1;
  return ratio(2 * overlap, leftPairs.size + rightPairs.size);
}

/** 相似度归一化：小写并去除空白/标点/符号。 */
function normalizeForSimilarity(value: string): string {
  return value.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** 提取连续两字符的 bigram 集合。 */
function bigrams(value: string): Set<string> {
  const result = new Set<string>();
  for (let index = 0; index < value.length - 1; index += 1) result.add(value.slice(index, index + 2));
  return result;
}

function strategyIdOfContext(context: AgentContext): string {
  return (context.identity as AgentContext['identity'] & { strategyId?: string }).strategyId ?? 'baseline-unassigned';
}

function strategyIdOfPlayer(player: Player): string {
  return (player as Player & { strategyId?: string }).strategyId ?? 'baseline-unassigned';
}

/** mulberry32 伪随机数生成器：同种子产生相同序列，保证评测可复现。 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** 计算百分位（p50/p95），空数组返回 0。 */
function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)]);
}

/** 平均值，空数组返回 0。 */
function average(values: number[]): number {
  if (values.length === 0) return 0;
  return round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

/** 比例计算（分母为 0 返回 0），统一四舍五入到 4 位小数。 */
function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : round(numerator / denominator);
}

/** 四舍五入到 4 位小数。 */
function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** 包装 trace sink：给评测期间的所有事件附加 runId/source/sourceType 关联字段。 */
function stampEvaluationTrace(
  sink: TraceSink,
  runId: string | undefined,
  origin: { sourceType: 'EVAL_RUN'; entrypoint: TraceEntrypoint; modelKind: TraceModelKind },
): TraceSink {
  return {
    record: (event) => {
      // runId/source/sourceType 是评测关联用的附加字段；sink 实现按结构展开，多余字段会原样保留。
      sink.record({
        ...event,
        runId: runId ?? 'unknown-run',
        source: 'evaluation',
        sourceType: origin.sourceType,
        entrypoint: origin.entrypoint,
        modelKind: origin.modelKind,
      } as unknown as RuntimeTraceDraft);
    },
  };
}

/**
 * 终局后发布“只含公开内容”的局内 trace：
 * 每条已提交描述与投票（voterId → targetId + reason）都会补发，
 * 精确密词统一脱敏为 [SECRET]，绝不外泄非公开信息。
 */
function publishPublicGameTrace(sink: TraceSink | undefined, game: GameState, gameIndex: number, totalGames: number): void {
  if (!sink) return;
  // 先收集全部密词，发布前逐个替换为 [SECRET]。
  const secrets = [...new Set(game.players.map((player) => player.word))];
  const redact = (text: string): string =>
    secrets.reduce((value, secret) => value.split(secret).join('[SECRET]'), text);
  for (const description of game.descriptions) {
    sink.record({
      eventType: 'public_event',
      gameId: game.id,
      round: description.round,
      phase: 'describing',
      publicEventType: 'description',
      text: redact(description.text),
      agentId: description.playerId,
      outcome: 'success',
    });
  }
  for (const vote of game.votes) {
    sink.record({
      eventType: 'public_event',
      gameId: game.id,
      round: vote.round,
      phase: 'voting',
      publicEventType: 'vote_result',
      text: `${vote.voterId} → ${vote.targetId}：${redact(vote.reason)}`,
      agentId: vote.voterId,
      outcome: 'success',
    });
  }
}

// 默认成本配置：DeepSeek 公开价格快照（估算用，评测报告中会记录来源与日期）。
const DEFAULT_COST_CONFIG: EvaluationCostConfig = {
  model: 'deepseek-v4-flash',
  currency: 'USD',
  inputTokenPricePer1M: 0.27,
  outputTokenPricePer1M: 1.1,
  source: 'DeepSeek deepseek-chat public pricing snapshot (estimate)',
  sourceDate: '2026-08-19',
};

/** 汇总 provider 返回的 usage 事件：总量/每局均值/按任务拆分。 */
function buildTokenUsage(events: ModelUsageEvent[], games: number): EvaluationTokenUsage {
  const totals = sumUsage(events);
  return {
    ...totals,
    averagePerGame: {
      input: ratio(totals.input, games),
      output: ratio(totals.output, games),
      total: ratio(totals.total, games),
    },
    byTask: {
      describe: buildTaskUsage(events, 'describe'),
      vote: buildTaskUsage(events, 'vote'),
      review: buildTaskUsage(events, 'review'),
    },
    source: events.length > 0 ? 'provider' : 'unavailable',
  };
}

/** 单任务 token 统计，含重试（providerAttempt>1）多耗的部分。 */
function buildTaskUsage(
  events: ModelUsageEvent[],
  task: EvaluationTask,
): { input: number; output: number; total: number; retryAddedTokens: number } {
  const taskEvents = events.filter((event) => event.task === task);
  const totals = sumUsage(taskEvents);
  return {
    ...totals,
    retryAddedTokens: sumUsage(taskEvents.filter((event) => event.providerAttempt > 1)).total,
  };
}

/** 对 usage 事件做三字段累加。 */
function sumUsage(events: ModelUsageEvent[]): { input: number; output: number; total: number } {
  return events.reduce(
    (sum, event) => ({
      input: sum.input + event.inputTokens,
      output: sum.output + event.outputTokens,
      total: sum.total + event.totalTokens,
    }),
    { input: 0, output: 0, total: 0 },
  );
}

/**
 * 成本估算：只有同时具备单价配置和 provider usage 才算得出；
 * 否则返回 unavailable 占位结果并说明缺失原因。
 */
function buildCostEstimate(
  tokenUsage: EvaluationTokenUsage,
  cost: EvaluationCostConfig | undefined,
  model: string,
  games: number,
): EvaluationCostEstimate {
  const unavailable: EvaluationCostEstimate = {
    source: 'unavailable',
    model: cost?.model ?? model,
    currency: cost?.currency ?? 'unavailable',
    inputTokenPricePer1M: cost?.inputTokenPricePer1M ?? null,
    outputTokenPricePer1M: cost?.outputTokenPricePer1M ?? null,
    priceSource: cost?.source ?? null,
    priceSourceDate: cost?.sourceDate ?? null,
    inputCost: 0,
    outputCost: 0,
    totalCost: 0,
    averageCostPerGame: 0,
    formula: 'unavailable: provider token usage and explicit price configuration are required',
  };
  if (!cost || tokenUsage.source === 'unavailable') return unavailable;

  const inputCost = round((tokenUsage.input / 1_000_000) * cost.inputTokenPricePer1M);
  const outputCost = round((tokenUsage.output / 1_000_000) * cost.outputTokenPricePer1M);
  const totalCost = round(inputCost + outputCost);
  return {
    source: 'configured',
    model: cost.model,
    currency: cost.currency,
    inputTokenPricePer1M: cost.inputTokenPricePer1M,
    outputTokenPricePer1M: cost.outputTokenPricePer1M,
    priceSource: cost.source,
    priceSourceDate: cost.sourceDate,
    inputCost,
    outputCost,
    totalCost,
    averageCostPerGame: ratio(totalCost, games),
    formula: `${cost.currency} = input/1M * ${cost.inputTokenPricePer1M} + output/1M * ${cost.outputTokenPricePer1M} (${cost.source})`,
  };
}
