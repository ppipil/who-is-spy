import { performance } from 'node:perf_hooks';
import { GameEngine } from './game-engine.js';
import type { GameModel } from './model.js';
import { DeepSeekClient } from './model.js';
import { FakeGameModel } from './test-utils.js';
import type { AgentContext, GameReview, GameState, Player, PublicGameState, Role } from './types.js';

export type EvaluationModelKind = 'fake' | 'real';

export interface EvaluationOptions {
  games: number;
  seed: number;
  modelKind: EvaluationModelKind;
  model?: GameModel;
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
  latencyMs: { p50: number; p95: number };
  tokenUsage: { input: number; output: number; total: number; source: 'unavailable' };
  byStrategyId: Record<string, StrategyEvaluationMetrics>;
  descriptionHomogeneity: number;
  safety: {
    secretLeakOccurrences: number;
    publicStateLeakOccurrences: number;
    illegalStateOccurrences: number;
  };
}

export interface EvaluationResult {
  schemaVersion: 1;
  configuration: { games: number; seed: number; model: EvaluationModelKind };
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

  async describe(context: AgentContext): Promise<string> {
    this.instrumentation.descriptionAttempts += 1;
    return this.measure(() => this.delegate.describe(context));
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

export async function runEvaluation(options: EvaluationOptions): Promise<EvaluationResult> {
  if (!Number.isInteger(options.games) || options.games < 1) throw new Error('--games must be a positive integer');
  if (!Number.isInteger(options.seed)) throw new Error('--seed must be an integer');

  const random = mulberry32(options.seed);
  const instrumentation: Instrumentation = {
    descriptionAttempts: 0,
    voteAttempts: 0,
    reviewAttempts: 0,
    invalidOutputs: 0,
    validVotes: 0,
    latencies: [],
    strategyVotes: new Map(),
  };
  const delegate = options.model ?? (options.modelKind === 'fake' ? new FakeGameModel() : new DeepSeekClient());
  if (!delegate.isConfigured()) throw new Error(`model ${delegate.model} is not configured`);
  const model = new InstrumentedModel(delegate, instrumentation);

  let completedGames = 0;
  let secretLeakOccurrences = 0;
  let publicStateLeakOccurrences = 0;
  let illegalStateOccurrences = 0;
  const pairSimilarities: number[] = [];
  const strategyMetrics = new Map<string, MutableStrategyMetrics>();

  for (let gameIndex = 0; gameIndex < options.games; gameIndex += 1) {
    const engine = new GameEngine(model, random);
    let publicGame = engine.createGame();
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
      pairSimilarities.push(...descriptionPairSimilarities(internal));
    } catch {
      illegalStateOccurrences += 1;
    }
  }

  for (const [strategyId, votes] of instrumentation.strategyVotes) {
    const group = strategyMetrics.get(strategyId) ?? { games: 0, wins: 0, votes: 0, accurateVotes: 0 };
    group.votes += votes.votes;
    group.accurateVotes += votes.accurateVotes;
    strategyMetrics.set(strategyId, group);
  }

  const modelAttempts = instrumentation.descriptionAttempts + instrumentation.voteAttempts + instrumentation.reviewAttempts;
  const metrics: EvaluationMetrics = {
    startedGames: options.games,
    completedGames,
    completionRate: ratio(completedGames, options.games),
    descriptionAttempts: instrumentation.descriptionAttempts,
    secretLeakRejectRate: 0,
    duplicateRejectRate: 0,
    invalidOutputRate: ratio(instrumentation.invalidOutputs, modelAttempts),
    validVoteRate: ratio(instrumentation.validVotes, instrumentation.voteAttempts),
    retryRate: 0,
    latencyMs: {
      p50: percentile(instrumentation.latencies, 0.5),
      p95: percentile(instrumentation.latencies, 0.95),
    },
    tokenUsage: { input: 0, output: 0, total: 0, source: 'unavailable' },
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

function countPublicStateLeaks(game: PublicGameState): number {
  if (game.phase === 'finished') return 0;
  return game.players.reduce((count, player) => {
    const record = player as unknown as Record<string, unknown>;
    return count + ['role', 'word', 'revealedRole', 'revealedWord'].filter((field) => field in record).length;
  }, 0);
}

function countSecretLeaks(game: GameState): number {
  const secrets = [...new Set(game.players.map((player) => player.word))];
  return game.descriptions.filter((description) =>
    secrets.some((secret) => description.text.includes(secret)),
  ).length;
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
