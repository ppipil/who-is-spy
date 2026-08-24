import { performance } from 'node:perf_hooks';
import { GameEngine } from '../core/game-engine.js';
import type { DescriptionQualityEvent, DescriptionRequest } from '../core/description-quality.js';
import type { GameModel, ModelUsageSink } from '../core/model.js';
import { DeepSeekClient } from '../core/model.js';
import { FakeGameModel } from '../support/test-utils.js';
import type { AgentContext, GameReview, GameState, Player, PublicGameState, Role, Vote } from '../core/types.js';
import type { TraceEntrypoint, TraceSink } from '../trace/trace.js';
import { createUsageAccumulator, type CostMetrics, type TokenUsageMetrics } from './usage-metrics.js';

export type EvaluationModelKind = 'fake' | 'real';

export interface EvaluationOptions {
  games: number;
  seed: number;
  modelKind: EvaluationModelKind;
  model?: GameModel;
  humanDescriptions?: string[];
  caseIds?: string[];
  wordPair?: readonly [string, string];
  traceSink?: TraceSink;
  traceEntrypoint?: TraceEntrypoint;
}

export interface StrategyEvaluationMetrics {
  games: number;
  wins: number;
  winRate: number;
  votes: number;
  accurateVotes: number;
  voteAccuracy: number;
}

export interface EvaluationCaseSummary {
  caseId: string;
  gameId: string;
  completed: boolean;
  humanDescription: string;
  humanVotesReceived: number;
  totalAiVotes: number;
  reasonAwarenessHits: number;
  descriptions: Array<{ playerId: string; playerName: string; strategyId: string; round: number; text: string }>;
  votes: Array<{ voterId: string; voterName: string; strategyId: string; targetId: string; round: number; reason: string }>;
  error?: string;
}

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
  latencyMs: { p50: number; p95: number };
  tokenUsage: TokenUsageMetrics;
  cost: CostMetrics;
  byStrategyId: Record<string, StrategyEvaluationMetrics>;
  descriptionHomogeneity: number;
  humanInputResponsiveness?: {
    available: boolean;
    normalHumanVotes: number;
    nonsenseHumanVotes: number;
    reasonAwarenessHits: number;
    note: string;
  };
  safety: {
    secretLeakOccurrences: number;
    publicStateLeakOccurrences: number;
    illegalStateOccurrences: number;
  };
}

export interface EvaluationResult {
  schemaVersion: 1;
  configuration: { games: number; seed: number; model: EvaluationModelKind };
  cases: EvaluationCaseSummary[];
  metrics: EvaluationMetrics;
  gate: { passed: boolean; failures: string[] };
}

interface MutableStrategyMetrics {
  games: number;
  wins: number;
  votes: number;
  accurateVotes: number;
}

interface Instrumentation {
  descriptionAttempts: number;
  voteAttempts: number;
  reviewAttempts: number;
  invalidOutputs: number;
  validVotes: number;
  latencies: number[];
  strategyVotes: Map<string, { votes: number; accurateVotes: number }>;
  qualityViolations: DescriptionQualityEvent[];
}

/**
 * 不改变业务返回值的评测装饰器。
 * 它围绕任意 GameModel 统计逻辑调用次数、有效投票、策略命中和耗时，并把真实 trace/usage sink 继续转发给底层模型。
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

  setTraceSink(sink: TraceSink): void {
    this.delegate.setTraceSink?.(sink);
  }

  setUsageSink(sink: ModelUsageSink): void {
    this.delegate.setUsageSink?.(sink);
  }

  async describe(context: AgentContext, request?: DescriptionRequest): Promise<string> {
    this.instrumentation.descriptionAttempts += 1;
    return this.measure(() => this.delegate.describe(context, request));
  }

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

  async review(game: GameState): Promise<GameReview> {
    this.instrumentation.reviewAttempts += 1;
    return this.measure(() => this.delegate.review(game));
  }

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
 * 运行 N 个可复现对局并产出 schema-versioned 指标与 Engineering Gate。
 * seed 通过 Mulberry32 注入 GameEngine；每局复用生产编排、质量门禁和公开 DTO，评测层只做观测，不复制游戏规则。
 * 硬门禁只覆盖确定性正确性：100% 完局、100% 合法投票、零提交密词、零公共 DTO 泄漏、零非法半状态。
 */
export async function runEvaluation(options: EvaluationOptions): Promise<EvaluationResult> {
  if (!Number.isInteger(options.games) || options.games < 1) throw new Error('--games must be a positive integer');
  if (!Number.isInteger(options.seed)) throw new Error('--seed must be an integer');

  const sharedRandom = mulberry32(options.seed);
  const pairedCanonicalCases = hasPairedCanonicalCases(options.caseIds);
  const instrumentation: Instrumentation = {
    descriptionAttempts: 0,
    voteAttempts: 0,
    reviewAttempts: 0,
    invalidOutputs: 0,
    validVotes: 0,
    latencies: [],
    strategyVotes: new Map(),
    qualityViolations: [],
  };
  const delegate: GameModel = options.model ?? (options.modelKind === 'fake' ? new FakeGameModel() : new DeepSeekClient());
  if (!delegate.isConfigured()) throw new Error(`model ${delegate.model} is not configured`);
  const usage = createUsageAccumulator(options.games);
  delegate.setUsageSink?.(usage.record);
  const model = new InstrumentedModel(delegate, instrumentation);

  let completedGames = 0;
  let secretLeakOccurrences = 0;
  let publicStateLeakOccurrences = 0;
  let illegalStateOccurrences = 0;
  const pairSimilarities: number[] = [];
  const strategyMetrics = new Map<string, MutableStrategyMetrics>();
  const caseSummaries: EvaluationCaseSummary[] = [];

  for (let gameIndex = 0; gameIndex < options.games; gameIndex += 1) {
    const caseRandom = pairedCanonicalCases ? mulberry32(options.seed) : sharedRandom;
    const engine = new GameEngine(
      model,
      caseRandom,
      (event) => instrumentation.qualityViolations.push(event),
      options.traceSink,
      {
        sourceType: 'EVAL_RUN',
        entrypoint: options.traceEntrypoint ?? 'test',
        modelKind: options.modelKind === 'real' ? 'real' : 'fake',
      },
    );
    let publicGame = engine.createGame({
      ...(options.wordPair ? { wordPair: options.wordPair } : {}),
      descriptionSecretPolicy: 'complete_words',
    });
    publicStateLeakOccurrences += countPublicStateLeaks(publicGame);
    try {
      publicGame = await driveGame(engine, publicGame, options.humanDescriptions?.[gameIndex]);
      publicStateLeakOccurrences += countPublicStateLeaks(publicGame);
      const internal = engine.getInternalGame(publicGame.id);
      if (publicGame.phase === 'finished' && publicGame.winner) {
        completedGames += 1;
        collectStrategyOutcomes(internal, publicGame.winner, strategyMetrics);
      } else {
        illegalStateOccurrences += 1;
      }
      secretLeakOccurrences += countSecretLeaks(internal);
      pairSimilarities.push(...descriptionPairSimilarities(internal));
      caseSummaries.push(caseSummary(options, gameIndex, publicGame, internal));
    } catch (error) {
      illegalStateOccurrences += 1;
      caseSummaries.push(failedCaseSummary(options, gameIndex, publicGame, error));
    }
  }

  for (const [strategyId, votes] of instrumentation.strategyVotes) {
    const group = strategyMetrics.get(strategyId) ?? { games: 0, wins: 0, votes: 0, accurateVotes: 0 };
    group.votes += votes.votes;
    group.accurateVotes += votes.accurateVotes;
    strategyMetrics.set(strategyId, group);
  }

  const modelAttempts = instrumentation.descriptionAttempts + instrumentation.voteAttempts + instrumentation.reviewAttempts;
  // 所有比率统一保留四位小数；分母为 0 时返回 0，避免批量评测输出 NaN。
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
    retryRate: ratio(
      instrumentation.qualityViolations.filter((event) => event.willRetry).length,
      instrumentation.descriptionAttempts,
    ),
    latencyMs: {
      p50: percentile(instrumentation.latencies, 0.5),
      p95: percentile(instrumentation.latencies, 0.95),
    },
    tokenUsage: usage.tokenUsage,
    cost: usage.cost,
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
    humanInputResponsiveness: humanInputResponsiveness(caseSummaries),
    safety: { secretLeakOccurrences, publicStateLeakOccurrences, illegalStateOccurrences },
  };

  const failures: string[] = [];
  if (metrics.completionRate !== 1) failures.push('completionRate must equal 1.0');
  if (secretLeakOccurrences > 0) failures.push('secret descriptions must not reach committed state');
  if (publicStateLeakOccurrences > 0) failures.push('pre-finale public DTO must not expose secret fields');
  if (illegalStateOccurrences > 0) failures.push('evaluation games must not enter illegal or incomplete state');
  if (metrics.validVoteRate !== 1) failures.push('validVoteRate must equal 1.0');

  return {
    schemaVersion: 1,
    configuration: { games: options.games, seed: options.seed, model: options.modelKind },
    cases: caseSummaries,
    metrics,
    gate: { passed: failures.length === 0, failures },
  };
}

/**
 * 用确定性的人类动作把单局推进到 finished，最多执行 24 个动作防止异常死循环。
 * 人类出局后复用正式 spectator 路径，确保批量评测覆盖的仍是生产状态机。
 */
async function driveGame(engine: GameEngine, initial: PublicGameState, firstHumanDescription?: string): Promise<PublicGameState> {
  let game = initial;
  let actions = 0;
  while (game.phase !== 'finished' && actions < 24) {
    actions += 1;
    const human = game.players.find((player) => player.isHuman)!;
    if (!human.alive) return engine.continueAsSpectator(game.id);
    if (game.phase === 'describing') {
      game = await engine.submitHumanDescription(game.id, game.round === 1 && firstHumanDescription ? firstHumanDescription : `第${game.round}轮我想到一种常见体验`);
    } else {
      const allowed = game.eligibleTargetIds
        ? game.eligibleTargetIds
        : game.players.filter((player) => player.alive && !player.isHuman).map((player) => player.id);
      game = await engine.submitHumanVote(game.id, allowed[0]);
    }
  }
  return game;
}

function caseSummary(options: EvaluationOptions, gameIndex: number, publicGame: PublicGameState, game: GameState): EvaluationCaseSummary {
  const playerById = new Map(game.players.map((player) => [player.id, player]));
  const aiVotes = game.votes.filter((vote) => vote.voterId !== 'human');
  return {
    caseId: options.caseIds?.[gameIndex] ?? `game-${gameIndex + 1}`,
    gameId: game.id,
    completed: publicGame.phase === 'finished' && Boolean(publicGame.winner),
    humanDescription: options.humanDescriptions?.[gameIndex] ?? `第${gameIndex + 1}局我想到一种常见体验`,
    humanVotesReceived: aiVotes.filter((vote) => vote.targetId === 'human').length,
    totalAiVotes: aiVotes.length,
    reasonAwarenessHits: aiVotes.filter((vote) => reasonMentionsHumanInput(vote)).length,
    descriptions: game.descriptions
      .filter((description) => description.playerId !== 'human')
      .map((description) => {
        const player = playerById.get(description.playerId);
        return {
          playerId: description.playerId,
          playerName: player?.name ?? description.playerId,
          strategyId: player?.strategyId ?? 'unknown',
          round: description.round,
          text: description.text,
        };
      }),
    votes: aiVotes.map((vote) => {
      const player = playerById.get(vote.voterId);
      return {
        voterId: vote.voterId,
        voterName: player?.name ?? vote.voterId,
        strategyId: player?.strategyId ?? 'unknown',
        targetId: vote.targetId,
        round: vote.round,
        reason: vote.reason,
      };
    }),
  };
}

function failedCaseSummary(options: EvaluationOptions, gameIndex: number, publicGame: PublicGameState, error: unknown): EvaluationCaseSummary {
  return {
    caseId: options.caseIds?.[gameIndex] ?? `game-${gameIndex + 1}`,
    gameId: publicGame.id,
    completed: false,
    humanDescription: options.humanDescriptions?.[gameIndex] ?? `第${gameIndex + 1}局我想到一种常见体验`,
    humanVotesReceived: 0,
    totalAiVotes: 0,
    reasonAwarenessHits: 0,
    descriptions: [],
    votes: [],
    error: error instanceof Error ? error.message : String(error),
  };
}

function hasPairedCanonicalCases(caseIds: string[] | undefined): boolean {
  return Boolean(
    caseIds?.includes('normal-human-input') && caseIds.includes('nonsense-human-input'),
  );
}

/**
 * 比较固定 Normal/Nonsense 配对用例中人类收到的 AI 票和理由关键词命中，作为“AI 是否读了人类输入”的代理指标。
 * 缺任一配对 case 时明确返回 unavailable，不用不完整样本推断响应性。
 */
function humanInputResponsiveness(cases: EvaluationCaseSummary[]): EvaluationMetrics['humanInputResponsiveness'] {
  const normal = cases.find((item) => item.caseId === 'normal-human-input');
  const nonsense = cases.find((item) => item.caseId === 'nonsense-human-input');
  if (!normal || !nonsense) {
    return {
      available: false,
      normalHumanVotes: normal?.humanVotesReceived ?? 0,
      nonsenseHumanVotes: nonsense?.humanVotesReceived ?? 0,
      reasonAwarenessHits: nonsense?.reasonAwarenessHits ?? 0,
      note: 'Not Available. Requires both canonical cases.',
    };
  }
  return {
    available: true,
    normalHumanVotes: normal.humanVotesReceived,
    nonsenseHumanVotes: nonsense.humanVotesReceived,
    reasonAwarenessHits: nonsense.reasonAwarenessHits,
    note: 'Compare whether nonsense human input changes suspicion and vote reasons.',
  };
}

function reasonMentionsHumanInput(vote: Vote): boolean {
  return /人类|玩家|描述|表达|敷衍|无关|信息|异常|奇怪|落差|矛盾|自然感/.test(vote.reason);
}
/** 统计终局前公共玩家 DTO 中意外出现的 role/word/revealedRole/revealedWord 字段，用于零容忍门禁。 */
function countPublicStateLeaks(game: PublicGameState): number {
  if (game.phase === 'finished') return 0;
  return game.players.reduce((count, player) => {
    const record = player as unknown as Record<string, unknown>;
    return count + ['role', 'word', 'revealedRole', 'revealedWord'].filter((field) => field in record).length;
  }, 0);
}

/** 统计已经提交的描述中包含任一完整题目词的条数；它衡量门禁是否失守，而不是被成功拦截的尝试。 */
function countSecretLeaks(game: GameState): number {
  const secrets = [...new Set(game.players.map((player) => player.word))];
  return game.descriptions.filter((description) =>
    secrets.some((secret) => description.text.includes(secret)),
  ).length;
}

/** 按 AI seat 聚合每种 strategyId 的参局数与阵营胜场，避免把一局胜负误计成单个 Agent 独立结果。 */
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

/**
 * 生成同质化样本：逐轮取 AI 描述的所有无序两两组合，计算字符 bigram Dice。
 * 人类描述被排除，最终 descriptionHomogeneity 是所有这些 pair 的平均值；该值是字面代理，不是语义质量真值。
 */
function descriptionPairSimilarities(game: GameState): number[] {
  // 同质化只比较“同一轮、AI 与 AI”的所有无序两两组合，不把人类描述混入 Persona 指标。
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

function diceCoefficient(left: string, right: string): number {
  const leftPairs = bigrams(normalizeForSimilarity(left));
  const rightPairs = bigrams(normalizeForSimilarity(right));
  if (leftPairs.size === 0 && rightPairs.size === 0) return 1;
  let overlap = 0;
  for (const pair of leftPairs) if (rightPairs.has(pair)) overlap += 1;
  return ratio(2 * overlap, leftPairs.size + rightPairs.size);
}

function normalizeForSimilarity(value: string): string {
  return value.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

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

/** 将整数 seed 转换为确定性伪随机源，使词对、身份、换词和破平票在回归中可复现。 */
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

/** 用 nearest-rank 计算离散延迟样本分位数；无样本返回 0，结果统一保留四位小数。 */
function percentile(values: number[], quantile: number): number {
  // 使用 nearest-rank（向上取整）分位数，适合当前离散的单次模型调用延迟样本。
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)]);
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : round(numerator / denominator);
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
