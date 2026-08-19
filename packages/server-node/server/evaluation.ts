import { performance } from 'node:perf_hooks';
import { GameEngine } from './game-engine.js';
import type { DescriptionQualityEvent, DescriptionRequest } from './description-quality.js';
import type { GameModel, ModelUsageEvent } from './model.js';
import { DeepSeekClient, ModelError } from './model.js';
import { FakeGameModel } from './test-utils.js';
import type { ModelErrorType } from './trace.js';
import type { AgentContext, GameReview, GameState, Player, PublicGameState, Role } from './types.js';

export type EvaluationModelKind = 'fake' | 'real';
export type EvaluationErrorType = 'timeout' | 'http' | 'schema' | 'validation' | 'secret' | 'unknown' | null;
export type EvaluationTask = 'describe' | 'vote' | 'review';

export const EVALUATION_SCHEMA_VERSION = 5;

export interface EngineLike {
  createGame(): PublicGameState;
  submitHumanDescription(id: string, text: string): Promise<PublicGameState>;
  submitHumanVote(id: string, targetId: string): Promise<PublicGameState>;
  continueAsSpectator(id: string): Promise<PublicGameState>;
  getInternalGame(id: string): GameState;
}

export type EngineFactory = (
  model: GameModel,
  random: () => number,
  onQualityEvent: (event: DescriptionQualityEvent) => void,
) => EngineLike;

export interface EvaluationOptions {
  games: number;
  seed: number;
  modelKind: EvaluationModelKind;
  model?: GameModel;
  engineFactory?: EngineFactory;
  side?: 'baseline' | 'final';
  commit?: string;
  runId?: string;
  cost?: EvaluationCostConfig;
}

export interface EvaluationCostConfig {
  model: string;
  currency: string;
  inputTokenPricePer1M: number;
  outputTokenPricePer1M: number;
  source: string;
  sourceDate: string;
}

export interface StrategyEvaluationMetrics {
  games: number;
  wins: number;
  winRate: number;
  votes: number;
  accurateVotes: number;
  voteAccuracy: number;
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
  qualityRepairCount: number;
  latencyMs: { p50: number; p95: number };
  tokenUsage: EvaluationTokenUsage;
  internalRetryCount: number;
  retryAddedTokens: number;
  cost: EvaluationCostEstimate;
  byStrategyId: Record<string, StrategyEvaluationMetrics>;
  descriptionHomogeneity: number;
  safety: {
    secretLeakOccurrences: number;
    publicStateLeakOccurrences: number;
    illegalStateOccurrences: number;
    descriptionExactSecretLeaks: number;
    voteReasonSecretMentions: number;
    reviewSecretMentions: number;
    aliasOrSemanticExposure: number;
  };
}

export interface EvaluationTokenUsage {
  input: number;
  output: number;
  total: number;
  averagePerGame: { input: number; output: number; total: number };
  byTask: Record<EvaluationTask, { input: number; output: number; total: number; retryAddedTokens: number }>;
  source: 'provider' | 'unavailable';
}

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

export interface EvaluationResult {
  schemaVersion: typeof EVALUATION_SCHEMA_VERSION;
  run: {
    runId: string;
    side: string;
    commit: string;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    gateSource: 'runEvaluation';
    scenario: { seed: number; games: number };
    unavailable: {
      tokenUsage: boolean;
      cost: boolean;
      internalProviderRetries: boolean;
    };
  };
  configuration: { games: number; seed: number; model: EvaluationModelKind };
  metrics: EvaluationMetrics;
  trace: {
    games: EvaluationGameTrace[];
    modelCalls: EvaluationModelCallTrace[];
  };
  gate: { passed: boolean; failures: string[] };
}

export interface EvaluationModelCallTrace {
  runId: string;
  gameId: string | null;
  round: number;
  agentId: string;
  task: EvaluationTask;
  attempt: number;
  latencyMs: number;
  status: 'success' | 'failure';
  errorType: EvaluationErrorType;
  httpStatus: number | null;
  schemaFields: string[];
  sameRoundPublicAiDescriptionCount: number | null;
  sameRoundHumanDescriptionPresent: boolean | null;
}

export interface EvaluationGameTrace {
  gameId: string;
  completed: boolean;
  winner: Role | null;
  timeline: Array<{
    order: number;
    round: number;
    type: 'description' | 'vote' | 'vote_result' | 'elimination' | 'review';
    actorId?: string;
    targetId?: string;
    text?: string;
    reason?: string;
  }>;
  leakSummary: {
    descriptionExactSecretLeaks: number;
    voteReasonSecretMentions: number;
    reviewSecretMentions: number;
    aliasOrSemanticExposure: number;
  };
}

interface MutableStrategyMetrics {
  games: number;
  wins: number;
  votes: number;
  accurateVotes: number;
}

interface Instrumentation {
  runId: string;
  descriptionAttempts: number;
  voteAttempts: number;
  reviewAttempts: number;
  invalidOutputs: number;
  validVotes: number;
  latencies: number[];
  strategyVotes: Map<string, { votes: number; accurateVotes: number }>;
  qualityViolations: DescriptionQualityEvent[];
  currentGameId: string | null;
  modelCalls: EvaluationModelCallTrace[];
  usageEvents: ModelUsageEvent[];
  internalRetryCount: number;
}

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

  async describe(context: AgentContext, request?: DescriptionRequest): Promise<string> {
    this.instrumentation.descriptionAttempts += 1;
    return this.measure('describe', context, () => this.delegate.describe(context, request));
  }

  async vote(
    context: AgentContext,
    allowedTargets: Player[],
  ): Promise<{ targetId: string; reason: string }> {
    this.instrumentation.voteAttempts += 1;
    try {
      const result = await this.measure('vote', context, () => this.delegate.vote(context, allowedTargets));
      const target = allowedTargets.find((candidate) => candidate.id === result.targetId);
      const strategyId = strategyIdOfContext(context);
      const group = this.instrumentation.strategyVotes.get(strategyId) ?? { votes: 0, accurateVotes: 0 };
      group.votes += 1;
      if (target) {
        this.instrumentation.validVotes += 1;
        if (target.role === 'undercover') group.accurateVotes += 1;
      } else {
        this.instrumentation.invalidOutputs += 1;
        const call = [...this.instrumentation.modelCalls]
          .reverse()
          .find(
            (candidate) =>
              candidate.task === 'vote' &&
              candidate.agentId === context.identity.playerId &&
              candidate.round === context.game.round,
          );
        if (call) {
          call.status = 'failure';
          call.errorType = 'validation';
        }
      }
      this.instrumentation.strategyVotes.set(strategyId, group);
      return result;
    } catch (error) {
      throw error;
    }
  }

  async review(game: GameState): Promise<GameReview> {
    this.instrumentation.reviewAttempts += 1;
    return this.measure('review', game, () => this.delegate.review(game));
  }

  private async measure<T>(
    task: 'describe' | 'vote' | 'review',
    context: AgentContext | GameState,
    operation: () => Promise<T>,
  ): Promise<T> {
    const startedAt = performance.now();
    const call = this.createCallTrace(task, context);
    try {
      const result = await operation();
      call.status = 'success';
      return result;
    } catch (error) {
      this.instrumentation.invalidOutputs += 1;
      call.status = 'failure';
      Object.assign(call, classifyModelCallError(error));
      throw error;
    } finally {
      call.latencyMs = round(performance.now() - startedAt);
      this.instrumentation.latencies.push(call.latencyMs);
      this.instrumentation.modelCalls.push(call);
    }
  }

  private createCallTrace(task: EvaluationTask, context: AgentContext | GameState): EvaluationModelCallTrace {
    const descriptionContext = task === 'describe' && 'identity' in context ? context : null;
    const sameRoundDescriptions = descriptionContext
      ? descriptionContext.game.publicDescriptions.filter((description) => description.round === descriptionContext.game.round)
      : [];
    return {
      runId: this.instrumentation.runId,
      gameId: this.instrumentation.currentGameId,
      round: 'round' in context ? context.round : context.game.round,
      agentId: 'identity' in context ? context.identity.playerId : 'review',
      task,
      attempt: 1,
      latencyMs: 0,
      status: 'success',
      errorType: null,
      httpStatus: null,
      schemaFields: [],
      sameRoundPublicAiDescriptionCount: descriptionContext
        ? sameRoundDescriptions.filter((description) => description.playerId !== 'human').length
        : null,
      sameRoundHumanDescriptionPresent: descriptionContext
        ? sameRoundDescriptions.some((description) => description.playerId === 'human')
        : null,
    };
  }
}

export async function runEvaluation(options: EvaluationOptions): Promise<EvaluationResult> {
  if (!Number.isInteger(options.games) || options.games < 1) throw new Error('--games must be a positive integer');
  if (!Number.isInteger(options.seed)) throw new Error('--seed must be an integer');

  const startedAt = new Date();
  const startedMs = performance.now();
  const runId =
    options.runId ?? `eval-${options.modelKind}-seed-${options.seed}-${startedAt.toISOString().replace(/[:.]/g, '-')}`;
  const random = mulberry32(options.seed);
  const instrumentation: Instrumentation = {
    runId,
    descriptionAttempts: 0,
    voteAttempts: 0,
    reviewAttempts: 0,
    invalidOutputs: 0,
    validVotes: 0,
    latencies: [],
    strategyVotes: new Map(),
    qualityViolations: [],
    currentGameId: null,
    modelCalls: [],
    usageEvents: [],
    internalRetryCount: 0,
  };
  const delegate: GameModel = options.model ?? (options.modelKind === 'fake' ? new FakeGameModel() : new DeepSeekClient());
  if (!delegate.isConfigured()) throw new Error(`model ${delegate.model} is not configured`);
  delegate.setUsageRecorder?.((event: ModelUsageEvent) => {
    instrumentation.usageEvents.push(event);
    if (event.providerAttempt > 1) instrumentation.internalRetryCount += event.providerAttempt - 1;
  });
  const model = new InstrumentedModel(delegate, instrumentation);
  const createEngine =
    options.engineFactory ?? ((engineModel: GameModel, engineRandom: () => number, onQualityEvent: (event: DescriptionQualityEvent) => void) =>
      new GameEngine(engineModel, engineRandom, onQualityEvent));

  let completedGames = 0;
  let secretLeakOccurrences = 0;
  let publicStateLeakOccurrences = 0;
  let illegalStateOccurrences = 0;
  let voteReasonSecretMentions = 0;
  let reviewSecretMentions = 0;
  let aliasOrSemanticExposure = 0;
  const pairSimilarities: number[] = [];
  const strategyMetrics = new Map<string, MutableStrategyMetrics>();
  const games: EvaluationGameTrace[] = [];

  for (let gameIndex = 0; gameIndex < options.games; gameIndex += 1) {
    const engine = createEngine(model, random, (event) => instrumentation.qualityViolations.push(event));
    let publicGame = engine.createGame();
    instrumentation.currentGameId = publicGame.id;
    publicStateLeakOccurrences += countPublicStateLeaks(publicGame);
    try {
      publicGame = await driveGame(engine, publicGame);
      publicStateLeakOccurrences += countPublicStateLeaks(publicGame);
      const internal = engine.getInternalGame(publicGame.id);
      if (publicGame.phase === 'finished' && publicGame.winner) {
        completedGames += 1;
        collectStrategyOutcomes(internal, publicGame.winner, strategyMetrics);
      } else {
        illegalStateOccurrences += 1;
      }
      secretLeakOccurrences += countSecretLeaks(internal);
      const leakSummary = collectLeakSummary(internal);
      voteReasonSecretMentions += leakSummary.voteReasonSecretMentions;
      reviewSecretMentions += leakSummary.reviewSecretMentions;
      aliasOrSemanticExposure += leakSummary.aliasOrSemanticExposure;
      pairSimilarities.push(...descriptionPairSimilarities(internal));
      games.push(buildGameTrace(internal, publicGame, leakSummary));
    } catch {
      illegalStateOccurrences += 1;
      const internal = engine.getInternalGame(publicGame.id);
      const leakSummary = collectLeakSummary(internal);
      secretLeakOccurrences += leakSummary.descriptionExactSecretLeaks;
      voteReasonSecretMentions += leakSummary.voteReasonSecretMentions;
      reviewSecretMentions += leakSummary.reviewSecretMentions;
      aliasOrSemanticExposure += leakSummary.aliasOrSemanticExposure;
      games.push(buildGameTrace(internal, publicGame, leakSummary));
    }
  }

  for (const [strategyId, votes] of instrumentation.strategyVotes) {
    const group = strategyMetrics.get(strategyId) ?? { games: 0, wins: 0, votes: 0, accurateVotes: 0 };
    group.votes += votes.votes;
    group.accurateVotes += votes.accurateVotes;
    strategyMetrics.set(strategyId, group);
  }

  const modelAttempts = instrumentation.descriptionAttempts + instrumentation.voteAttempts + instrumentation.reviewAttempts;
  const tokenUsage = buildTokenUsage(instrumentation.usageEvents, options.games);
  const cost = buildCostEstimate(tokenUsage, options.cost, delegate.model, options.games);
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
    retryRate: ratio(
      instrumentation.qualityViolations.filter((event) => event.willRetry).length,
      instrumentation.descriptionAttempts,
    ),
    latencyMs: {
      p50: percentile(instrumentation.latencies, 0.5),
      p95: percentile(instrumentation.latencies, 0.95),
    },
    tokenUsage,
    internalRetryCount: instrumentation.internalRetryCount,
    retryAddedTokens: tokenUsage.input + tokenUsage.output === 0 ? 0 : sumUsage(instrumentation.usageEvents.filter((event) => event.providerAttempt > 1)).total,
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
    safety: {
      secretLeakOccurrences,
      publicStateLeakOccurrences,
      illegalStateOccurrences,
      descriptionExactSecretLeaks: secretLeakOccurrences,
      voteReasonSecretMentions,
      reviewSecretMentions,
      aliasOrSemanticExposure,
    },
  };

  const failures: string[] = [];
  if (metrics.completionRate !== 1) failures.push('completionRate must equal 1.0');
  if (secretLeakOccurrences > 0) failures.push('secret descriptions must not reach committed state');
  if (publicStateLeakOccurrences > 0) failures.push('pre-finale public DTO must not expose secret fields');
  if (illegalStateOccurrences > 0) failures.push('evaluation games must not enter illegal or incomplete state');
  if (metrics.validVoteRate !== 1) failures.push('validVoteRate must equal 1.0');

  const finishedAt = new Date();
  return {
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    run: {
      runId,
      side: options.side ?? 'unknown',
      commit: options.commit ?? process.env.EVALUATION_COMMIT ?? 'unknown',
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: round(performance.now() - startedMs),
      gateSource: 'runEvaluation',
      scenario: { seed: options.seed, games: options.games },
      unavailable: {
        tokenUsage: tokenUsage.source === 'unavailable',
        cost: cost.source === 'unavailable',
        internalProviderRetries: instrumentation.usageEvents.length === 0 && instrumentation.internalRetryCount === 0,
      },
    },
    configuration: { games: options.games, seed: options.seed, model: options.modelKind },
    metrics,
    trace: { games, modelCalls: instrumentation.modelCalls },
    gate: { passed: failures.length === 0, failures },
  };
}

async function driveGame(engine: EngineLike, initial: PublicGameState): Promise<PublicGameState> {
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

function countPublicStateLeaks(game: PublicGameState): number {
  if (game.phase === 'finished') return 0;
  return game.players.reduce((count, player) => {
    const record = player as unknown as Record<string, unknown>;
    return count + ['role', 'word', 'revealedRole', 'revealedWord'].filter((field) => field in record).length;
  }, 0);
}

function countSecretLeaks(game: GameState): number {
  return collectLeakSummary(game).descriptionExactSecretLeaks;
}

function collectLeakSummary(game: GameState): EvaluationGameTrace['leakSummary'] {
  const secrets = [...new Set(game.players.map((player) => player.word))];
  const descriptionExactSecretLeaks = game.descriptions.filter((description) =>
    secrets.some((secret) => description.text.includes(secret)),
  ).length;
  const voteReasonSecretMentions = game.votes.filter((vote) =>
    secrets.some((secret) => vote.reason.includes(secret)),
  ).length;
  const reviewText = game.review
    ? `${game.review.headline} ${game.review.summary} ${game.review.turningPoints.join(' ')} ${game.review.playerInsights
        .map((item) => item.insight)
        .join(' ')}`
    : '';
  const reviewSecretMentions = reviewText ? secrets.filter((secret) => reviewText.includes(secret)).length : 0;
  const aliasOrSemanticExposure = [...game.descriptions.map((item) => item.text), ...game.votes.map((item) => item.reason), reviewText]
    .filter((text) => secrets.some((secret) => secretAliases(secret).some((alias) => text.includes(alias)))).length;
  return {
    descriptionExactSecretLeaks,
    voteReasonSecretMentions,
    reviewSecretMentions,
    aliasOrSemanticExposure,
  };
}

function buildGameTrace(
  game: GameState,
  publicGame: PublicGameState,
  leakSummary: EvaluationGameTrace['leakSummary'],
): EvaluationGameTrace {
  const timeline: EvaluationGameTrace['timeline'] = [];
  for (const description of game.descriptions) {
    timeline.push({
      order: timeline.length + 1,
      round: description.round,
      type: 'description',
      actorId: description.playerId,
      text: sanitizeForPlayer(game, description.playerId, description.text),
    });
  }
  for (const vote of game.votes) {
    timeline.push({
      order: timeline.length + 1,
      round: vote.round,
      type: 'vote',
      actorId: vote.voterId,
      targetId: vote.targetId,
      reason: sanitizeForPlayer(game, vote.voterId, vote.reason),
    });
  }
  const publicEvents = game.events.filter(
    (item): item is (typeof game.events)[number] & { type: 'vote_result' | 'elimination' } =>
      item.type === 'vote_result' || item.type === 'elimination',
  );
  for (const event of publicEvents) {
    timeline.push({
      order: timeline.length + 1,
      round: event.round,
      type: event.type,
      actorId: event.playerId,
      text: sanitizeNeutral(game, event.text),
    });
  }
  if (game.review) {
    timeline.push({
      order: timeline.length + 1,
      round: game.round,
      type: 'review',
      actorId: 'review',
      text: sanitizeNeutral(
        game,
        `${game.review.headline} ${game.review.summary} ${game.review.turningPoints.join(' ')}`,
      ),
    });
  }
  return {
    gameId: publicGame.id,
    completed: publicGame.phase === 'finished' && Boolean(publicGame.winner),
    winner: publicGame.winner,
    timeline: timeline
      .sort((left, right) => left.round - right.round || left.order - right.order)
      .map((entry, index) => ({ ...entry, order: index + 1 })),
    leakSummary,
  };
}

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

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

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

function buildCostEstimate(
  tokenUsage: EvaluationTokenUsage,
  cost: EvaluationCostConfig | undefined,
  model: string,
  games: number,
): EvaluationCostEstimate {
  const unavailable = {
    source: 'unavailable' as const,
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
  if (!isConfiguredCost(cost) || tokenUsage.source === 'unavailable') return unavailable;

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
    formula: '(inputTokens / 1,000,000 * inputTokenPricePer1M) + (outputTokens / 1,000,000 * outputTokenPricePer1M)',
  };
}

function isConfiguredCost(cost: EvaluationCostConfig | undefined): cost is EvaluationCostConfig {
  return Boolean(
    cost &&
      Number.isFinite(cost.inputTokenPricePer1M) &&
      Number.isFinite(cost.outputTokenPricePer1M) &&
      cost.currency !== 'unavailable' &&
      cost.source !== 'unavailable' &&
      cost.sourceDate !== 'unavailable',
  );
}

function percentile(values: number[], quantile: number): number {
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

function sanitizeForPlayer(game: GameState, playerId: string, value: string): string {
  const actor = game.players.find((player) => player.id === playerId);
  return [...new Set(game.players.map((player) => player.word))].reduce((text, secret) => {
    const replacement = actor && actor.word === secret ? '[SELF_SECRET]' : '[OTHER_SECRET]';
    const exactRedacted = text.split(secret).join(replacement);
    return secretAliases(secret).reduce(
      (aliasRedacted, alias) => aliasRedacted.split(alias).join(`${replacement}_ALIAS`),
      exactRedacted,
    );
  }, value);
}

function sanitizeNeutral(game: GameState, value: string): string {
  return [...new Set(game.players.map((player) => player.word))].reduce(
    (text, secret) => {
      const exactRedacted = text.split(secret).join('[SECRET]');
      return secretAliases(secret).reduce(
        (aliasRedacted, alias) => aliasRedacted.split(alias).join('[SECRET_ALIAS]'),
        exactRedacted,
      );
    },
    value,
  );
}

function secretAliases(secret: string): string[] {
  const aliases: Record<string, string[]> = {
    雨伞: ['伞具', '伞'],
    雨衣: ['雨披', '防水衣'],
  };
  return aliases[secret] ?? [];
}

function classifyModelCallError(error: unknown): Pick<
  EvaluationModelCallTrace,
  'errorType' | 'httpStatus' | 'schemaFields'
> {
  if (error instanceof ModelError && error.diagnostic) {
    const diagnostic = error.diagnostic;
    return {
      errorType: mapErrorType(diagnostic.errorType),
      httpStatus: diagnostic.httpStatus ?? null,
      schemaFields: [],
    };
  }
  return { errorType: 'unknown', httpStatus: null, schemaFields: [] };
}

function mapErrorType(type: ModelErrorType): EvaluationErrorType {
  switch (type) {
    case 'timeout':
      return 'timeout';
    case 'rate_limit':
    case 'provider_5xx':
    case 'http_non_retryable':
    case 'network':
      return 'http';
    case 'invalid_json':
      return 'schema';
    case 'schema_validation':
      return 'validation';
    case 'secret':
      return 'secret';
    default:
      return 'unknown';
  }
}
