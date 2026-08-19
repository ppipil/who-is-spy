import 'dotenv/config';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import {
  mulberry32,
  runEvaluation,
  type EngineFactory,
  type EngineLike,
  type EvaluationCostConfig,
  type EvaluationResult,
} from './evaluation.js';
import { GameEngine as FinalGameEngine } from './game-engine.js';
import { DeepSeekClient as FinalDeepSeekClient } from './model.js';
import type { GameModel } from './model.js';
import { FakeGameModel } from './test-utils.js';
import type { AgentContext, GameReview, GameState, Player } from './types.js';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, 'docs', 'evidence', 'm6-final-comparison');

interface Options {
  seeds: number[];
  games: number;
  mode: 'fake' | 'real';
  baselineSrc: string;
  outDir: string;
  baselineCommit: string;
  finalCommit: string;
  cost?: EvaluationCostConfig;
}

class CompatFakeModel extends FakeGameModel implements GameModel {
  override async describe(context: AgentContext): Promise<string> {
    this.descriptionContexts.push(structuredClone(context));
    const descriptions: Record<string, string> = {
      cautious: '平常不太显眼，却经常出现在熟悉的地方',
      intuitive: '第一感觉带着鲜明氛围，让人很快产生联想',
      analytical: '从用途和类别看，它有一组清楚的边界',
      contrarian: '大家常说的特点之外，反而有个冷门场景',
    };
    return descriptions[context.identity.strategyId] ?? descriptions.cautious;
  }

  override async vote(
    context: AgentContext,
    allowedTargets: Player[],
  ): Promise<{ targetId: string; reason: string }> {
    this.voteContexts.push(structuredClone(context));
    const human = allowedTargets.find((player) => player.isHuman);
    const target = human ?? allowedTargets[0];
    return { targetId: target.id, reason: '从公开描述的一致性判断，这位玩家最可疑' };
  }

  override async review(game: GameState): Promise<GameReview> {
    return {
      headline: '细微的语义偏差决定了终局',
      summary: '玩家们围绕相近概念谨慎描述，最终通过公开措辞和集中票型找到了不同阵营。',
      turningPoints: ['首轮描述形成了清晰的判断分歧。', '多数票在终局集中到真正的卧底。'],
      playerInsights: game.players.map((player) => ({
        playerId: player.id,
        insight: `${player.name}围绕自己的词给出了独立判断。`,
      })),
    };
  }
}

interface WordSetup {
  words: string[];
  roles: string[];
  undercoverIndex: number;
  hash: string;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const baseline = await loadBaselineModule(options.baselineSrc);

  const baselineEngineFactory: EngineFactory = (model, random) =>
    new (baseline.engineMod.GameEngine as new (engineModel: GameModel, engineRandom: () => number) => EngineLike)(
      model,
      random,
    );
  const finalEngineFactory: EngineFactory = (model, random, onQualityEvent) =>
    new FinalGameEngine(model, random, onQualityEvent);

  const wordSetup = await checkWordSetup(options.seeds, baselineEngineFactory, finalEngineFactory);
  if (wordSetup.some((entry) => !entry.matched)) {
    throw new Error(`word setup mismatch for seeds: ${wordSetup.filter((entry) => !entry.matched).map((entry) => entry.seed).join(', ')}`);
  }

  const out = options.outDir;
  await mkdir(path.join(out, 'raw', 'baseline'), { recursive: true });
  await mkdir(path.join(out, 'raw', 'final'), { recursive: true });
  await mkdir(path.join(out, 'raw', 'fake-sanity'), { recursive: true });
  await mkdir(path.join(out, 'aggregate'), { recursive: true });

  const baselineReports: EvaluationResult[] = [];
  const finalReports: EvaluationResult[] = [];

  console.error(`M6 comparison start: mode=${options.mode} seeds=${options.seeds.join(',')} gamesPerSeed=${options.games}`);
  for (let index = 0; index < options.seeds.length; index += 1) {
    const seed = options.seeds[index];
    const order: Array<'baseline' | 'final'> = index % 2 === 0 ? ['baseline', 'final'] : ['final', 'baseline'];
    for (const side of order) {
      const engineFactory = side === 'baseline' ? baselineEngineFactory : finalEngineFactory;
      const model = createModel(options.mode, side, baseline);
      const commit = side === 'baseline' ? options.baselineCommit : options.finalCommit;
      const result = await runEvaluation({
        games: options.games,
        seed,
        modelKind: options.mode,
        model,
        engineFactory,
        side,
        commit,
        runId: `m6-${side}-seed-${seed}-${options.mode}`,
        cost: options.cost,
      });
      const fileName = path.join(out, 'raw', side, `seed-${seed}.json`);
      await writeFile(fileName, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
      console.error(
        `${side} seed ${seed}: completed=${result.metrics.completedGames}/${result.metrics.startedGames} gate=${result.gate.passed ? 'PASS' : 'FAIL'}`,
      );
      if (side === 'baseline') baselineReports.push(result);
      else finalReports.push(result);
    }
  }

  if (options.mode === 'fake') {
    for (const [side, reports] of [
      ['baseline', baselineReports],
      ['final', finalReports],
    ] as const) {
      for (const report of reports) {
        const seed = report.configuration.seed;
        await writeFile(
          path.join(out, 'raw', 'fake-sanity', `${side}-seed-${seed}.json`),
          `${JSON.stringify(report, null, 2)}\n`,
          'utf8',
        );
      }
    }
  }

  const baselineAggregate = aggregateReports(baselineReports, options);
  const finalAggregate = aggregateReports(finalReports, options);
  const comparison = buildComparison(options, baselineAggregate, finalAggregate, wordSetup);

  await writeFile(
    path.join(out, 'config.json'),
    `${JSON.stringify(buildConfig(options, wordSetup), null, 2)}\n`,
    'utf8',
  );
  await writeFile(path.join(out, 'aggregate', 'baseline.json'), `${JSON.stringify(baselineAggregate, null, 2)}\n`, 'utf8');
  await writeFile(path.join(out, 'aggregate', 'final.json'), `${JSON.stringify(finalAggregate, null, 2)}\n`, 'utf8');
  await writeFile(path.join(out, 'aggregate', 'comparison.json'), `${JSON.stringify(comparison, null, 2)}\n`, 'utf8');

  printComparisonTable(
    comparison as {
      aggregate: { baseline: Aggregate; final: Aggregate; delta: Record<string, number> };
    },
  );
  console.error(`\nReports written to ${out}`);
}

function createModel(mode: Options['mode'], side: 'baseline' | 'final', baseline: Awaited<ReturnType<typeof loadBaselineModule>>): GameModel {
  if (mode === 'fake') return new CompatFakeModel();
  return side === 'baseline'
    ? new (baseline.modelMod.DeepSeekClient as new () => GameModel)()
    : new FinalDeepSeekClient();
}

async function checkWordSetup(
  seeds: number[],
  baselineFactory: EngineFactory,
  finalFactory: EngineFactory,
): Promise<Array<{ seed: number; baseline: WordSetup; final: WordSetup; matched: boolean }>> {
  const results: Array<{ seed: number; baseline: WordSetup; final: WordSetup; matched: boolean }> = [];
  for (const seed of seeds) {
    const baseline = inspectWordSetup(baselineFactory, seed);
    const final = inspectWordSetup(finalFactory, seed);
    const matched = JSON.stringify(baseline.words) === JSON.stringify(final.words)
      && JSON.stringify(baseline.roles) === JSON.stringify(final.roles)
      && baseline.undercoverIndex === final.undercoverIndex;
    results.push({ seed, baseline, final, matched });
  }
  return results;
}

function inspectWordSetup(factory: EngineFactory, seed: number): WordSetup {
  const engine = factory(new CompatFakeModel(), mulberry32(seed), () => undefined);
  const publicGame = engine.createGame();
  const internal = engine.getInternalGame(publicGame.id);
  const words = internal.players.map((player) => player.word);
  const roles = internal.players.map((player) => player.role);
  const undercoverIndex = internal.players.findIndex((player) => player.role === 'undercover');
  return { words, roles, undercoverIndex, hash: sha256(words.join('|')) };
}

async function loadBaselineModule(src: string): Promise<{
  engineMod: { GameEngine: unknown };
  modelMod: { DeepSeekClient: unknown };
}> {
  const baseDir = path.join(src, 'packages', 'server-node', 'server');
  const engineUrl = pathToFileURL(path.join(baseDir, 'game-engine.ts')).href;
  const modelUrl = pathToFileURL(path.join(baseDir, 'model.ts')).href;
  const engineMod = (await import(engineUrl)) as { GameEngine: unknown };
  const modelMod = (await import(modelUrl)) as { DeepSeekClient: unknown };
  return { engineMod, modelMod };
}

interface Aggregate {
  side: 'baseline' | 'final';
  games: number;
  completionRate: number;
  validVoteRate: number;
  invalidOutputRate: number;
  descriptionExactSecretLeaks: number;
  descriptionHomogeneity: number;
  latencyMs: { p50: number; p95: number };
  totalTokens: number;
  tokensPerGame: number;
  totalCost: number;
  costPerGame: number;
  providerRetryCount: number;
  qualityRepairCount: number;
  gateFailures: Array<{ seed: number; failures: string[] }>;
  bySeed: Array<{
    seed: number;
    completionRate: number;
    validVoteRate: number;
    invalidOutputRate: number;
    descriptionExactSecretLeaks: number;
    descriptionHomogeneity: number;
    latencyMs: { p50: number; p95: number };
    tokensTotal: number;
    cost: number;
    providerRetryCount: number;
    qualityRepairCount: number;
    gate: { passed: boolean; failures: string[] };
  }>;
}

function aggregateReports(reports: EvaluationResult[], options: Options): Aggregate {
  const latencies = reports.flatMap((report) => report.trace.modelCalls.map((call) => call.latencyMs));
  const tokens = reports.reduce(
    (sum, report) => ({
      input: sum.input + report.metrics.tokenUsage.input,
      output: sum.output + report.metrics.tokenUsage.output,
      total: sum.total + report.metrics.tokenUsage.total,
    }),
    { input: 0, output: 0, total: 0 },
  );
  const cost = reports.reduce((sum, report) => sum + report.metrics.cost.totalCost, 0);
  const side = reports[0]?.run.side === 'final' ? 'final' : 'baseline';
  return {
    side,
    games: reports.length,
    completionRate: mean(reports.map((report) => report.metrics.completionRate)),
    validVoteRate: mean(reports.map((report) => report.metrics.validVoteRate)),
    invalidOutputRate: mean(reports.map((report) => report.metrics.invalidOutputRate)),
    descriptionExactSecretLeaks: sum(reports.map((report) => report.metrics.safety.descriptionExactSecretLeaks)),
    descriptionHomogeneity: mean(reports.map((report) => report.metrics.descriptionHomogeneity)),
    latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
    totalTokens: tokens.total,
    tokensPerGame: round4(tokens.total / Math.max(1, reports.length)),
    totalCost: round4(cost),
    costPerGame: round4(cost / Math.max(1, reports.length)),
    providerRetryCount: sum(reports.map((report) => report.metrics.internalRetryCount)),
    qualityRepairCount: sum(reports.map((report) => report.metrics.qualityRepairCount)),
    gateFailures: reports
      .filter((report) => !report.gate.passed)
      .map((report) => ({ seed: report.configuration.seed, failures: report.gate.failures })),
    bySeed: reports.map((report) => ({
      seed: report.configuration.seed,
      completionRate: report.metrics.completionRate,
      validVoteRate: report.metrics.validVoteRate,
      invalidOutputRate: report.metrics.invalidOutputRate,
      descriptionExactSecretLeaks: report.metrics.safety.descriptionExactSecretLeaks,
      descriptionHomogeneity: report.metrics.descriptionHomogeneity,
      latencyMs: report.metrics.latencyMs,
      tokensTotal: report.metrics.tokenUsage.total,
      cost: report.metrics.cost.totalCost,
      providerRetryCount: report.metrics.internalRetryCount,
      qualityRepairCount: report.metrics.qualityRepairCount,
      gate: report.gate,
    })),
  };
}

function buildComparison(
  options: Options,
  baseline: Aggregate,
  final: Aggregate,
  wordSetup: Array<{ seed: number; baseline: WordSetup; final: WordSetup; matched: boolean }>,
): unknown {
  const delta = (metric: (aggregate: Aggregate) => number) => round4(finalMetric(metric) - baselineMetric(metric));
  const finalMetric = (metric: (aggregate: Aggregate) => number) => metric(final);
  const baselineMetric = (metric: (aggregate: Aggregate) => number) => metric(baseline);
  return {
    methodology: {
      seeds: options.seeds,
      gamesPerSeedPerSide: options.games,
      mode: options.mode,
      sideOrder: 'alternating per seed (baseline/final then final/baseline)',
      baselineCommit: options.baselineCommit,
      finalCommit: options.finalCommit,
      sameModelConfig: true,
      sameEvaluator: 'packages/server-node/server/evaluation.ts (schema v5)',
      sameWordSetup: wordSetup.every((entry) => entry.matched),
      wordSetupCheck: wordSetup.map((entry) => ({ seed: entry.seed, matched: entry.matched, hash: entry.baseline.hash })),
    },
    pairedBySeed: baseline.bySeed.map((baselineSeed, index) => {
      const finalSeed = final.bySeed[index];
      return {
        seed: baselineSeed.seed,
        baseline: baselineSeed,
        final: finalSeed,
        delta: {
          completionRate: round4(finalSeed.completionRate - baselineSeed.completionRate),
          validVoteRate: round4(finalSeed.validVoteRate - baselineSeed.validVoteRate),
          invalidOutputRate: round4(finalSeed.invalidOutputRate - baselineSeed.invalidOutputRate),
          descriptionExactSecretLeaks: finalSeed.descriptionExactSecretLeaks - baselineSeed.descriptionExactSecretLeaks,
          descriptionHomogeneity: round4(finalSeed.descriptionHomogeneity - baselineSeed.descriptionHomogeneity),
          latencyP50Ms: finalSeed.latencyMs.p50 - baselineSeed.latencyMs.p50,
          latencyP95Ms: finalSeed.latencyMs.p95 - baselineSeed.latencyMs.p95,
          tokens: finalSeed.tokensTotal - baselineSeed.tokensTotal,
          cost: round4(finalSeed.cost - baselineSeed.cost),
          providerRetryCount: finalSeed.providerRetryCount - baselineSeed.providerRetryCount,
          qualityRepairCount: finalSeed.qualityRepairCount - baselineSeed.qualityRepairCount,
        },
      };
    }),
    aggregate: {
      baseline,
      final,
      delta: {
        completionRate: delta((aggregate) => aggregate.completionRate),
        validVoteRate: delta((aggregate) => aggregate.validVoteRate),
        invalidOutputRate: delta((aggregate) => aggregate.invalidOutputRate),
        descriptionExactSecretLeaks: final.descriptionExactSecretLeaks - baseline.descriptionExactSecretLeaks,
        descriptionHomogeneity: delta((aggregate) => aggregate.descriptionHomogeneity),
        latencyP50Ms: final.latencyMs.p50 - baseline.latencyMs.p50,
        latencyP95Ms: final.latencyMs.p95 - baseline.latencyMs.p95,
        tokensPerGame: round4(final.tokensPerGame - baseline.tokensPerGame),
        costPerGame: round4(final.costPerGame - baseline.costPerGame),
        providerRetryCount: final.providerRetryCount - baseline.providerRetryCount,
        qualityRepairCount: final.qualityRepairCount - baseline.qualityRepairCount,
      },
    },
  };
}

function buildConfig(
  options: Options,
  wordSetup: Array<{ seed: number; baseline: WordSetup; final: WordSetup; matched: boolean }>,
): unknown {
  return {
    milestone: 'M6 final baseline vs improved evaluation',
    date: new Date().toISOString(),
    seeds: options.seeds,
    gamesPerSeedPerSide: options.games,
    mode: options.mode,
    baseline: {
      branch: 'baseline',
      commit: options.baselineCommit,
      engineSrc: 'temporary git worktree at baseline commit (removed after run; re-extract with: git worktree add <dir> baseline)',
    },
    final: {
      branch: 'main',
      commit: options.finalCommit,
      engineSrc: 'packages/server-node (eval/m6-final-comparison worktree)',
    },
    model: {
      provider: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
      model: process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
      temperature: { describe: 0.8, vote: 0.8, review: 0.45 },
    },
    evaluator: {
      schemaVersion: 5,
      file: 'packages/server-node/server/evaluation.ts',
      sameHarnessForBothSides: true,
      sameMetrics: true,
    },
    cost: options.cost
      ? {
          currency: options.cost.currency,
          inputTokenPricePer1M: options.cost.inputTokenPricePer1M,
          outputTokenPricePer1M: options.cost.outputTokenPricePer1M,
          source: options.cost.source,
          sourceDate: options.cost.sourceDate,
        }
      : null,
    wordSetup: {
      samePairsForBothSides: true,
      matchedForEverySeed: wordSetup.every((entry) => entry.matched),
      check: wordSetup.map((entry) => ({ seed: entry.seed, matched: entry.matched, hash: entry.baseline.hash })),
    },
    trajectoryEvidence: {
      m2: 'PASS',
      m3: 'PASS',
      m4: 'PASS',
      m5: 'PASS',
      note: 'referenced from existing milestone evidence; not re-scored in M6',
    },
  };
}

function printComparisonTable(comparison: {
  aggregate: { baseline: Aggregate; final: Aggregate; delta: Record<string, number> };
}): void {
  const { baseline, final, delta } = comparison.aggregate;
  console.error('\nM6 aggregate comparison');
  console.error('Metric'.padEnd(34), 'Baseline'.padEnd(14), 'Final'.padEnd(14), 'Delta');
  console.error('-'.repeat(78));
  const rows: Array<[string, number, number]> = [
    ['completionRate', baseline.completionRate, final.completionRate],
    ['validVoteRate', baseline.validVoteRate, final.validVoteRate],
    ['invalidOutputRate', baseline.invalidOutputRate, final.invalidOutputRate],
    ['descriptionExactSecretLeaks', baseline.descriptionExactSecretLeaks, final.descriptionExactSecretLeaks],
    ['descriptionHomogeneity', baseline.descriptionHomogeneity, final.descriptionHomogeneity],
    ['latency p50 (ms)', baseline.latencyMs.p50, final.latencyMs.p50],
    ['latency p95 (ms)', baseline.latencyMs.p95, final.latencyMs.p95],
    ['tokens / game', baseline.tokensPerGame, final.tokensPerGame],
    ['cost / game', baseline.costPerGame, final.costPerGame],
    ['provider retries', baseline.providerRetryCount, final.providerRetryCount],
    ['quality repairs', baseline.qualityRepairCount, final.qualityRepairCount],
  ];
  for (const [name, baselineValue, finalValue] of rows) {
    console.error(
      name.padEnd(34),
      String(baselineValue).padEnd(14),
      String(finalValue).padEnd(14),
      String(delta[name as keyof typeof delta] ?? round4(finalValue - baselineValue)),
    );
  }
}

function parseArguments(arguments_: string[]): Options {
  const options: Options = {
    seeds: [101, 102, 103, 104, 105],
    games: 1,
    mode: 'real',
    baselineSrc: process.env.M6_BASELINE_SRC ?? '',
    outDir: DEFAULT_OUT_DIR,
    baselineCommit: process.env.M6_BASELINE_COMMIT ?? '7d98e194ee57bb078ed45e9831ad42ff68a57b56',
    finalCommit: process.env.M6_FINAL_COMMIT ?? 'unknown',
    cost: costOptionsFromEnv(),
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (argument === '--seeds' && value) {
      options.seeds = value.split(',').map(Number);
      index += 1;
    } else if (argument === '--games' && value) {
      options.games = Number(value);
      index += 1;
    } else if (argument === '--mode' && (value === 'fake' || value === 'real')) {
      options.mode = value;
      index += 1;
    } else if (argument === '--baseline-src' && value) {
      options.baselineSrc = value;
      index += 1;
    } else if (argument === '--out' && value) {
      options.outDir = path.resolve(value);
      index += 1;
    } else if (argument === '--baseline-commit' && value) {
      options.baselineCommit = value;
      index += 1;
    } else if (argument === '--final-commit' && value) {
      options.finalCommit = value;
      index += 1;
    } else if (argument === '--input-token-price-per-1m' && value) {
      options.cost = { ...defaultCostOptions(), ...options.cost, inputTokenPricePer1M: Number(value) };
      index += 1;
    } else if (argument === '--output-token-price-per-1m' && value) {
      options.cost = { ...defaultCostOptions(), ...options.cost, outputTokenPricePer1M: Number(value) };
      index += 1;
    } else if (argument === '--cost-currency' && value) {
      options.cost = { ...defaultCostOptions(), ...options.cost, currency: value };
      index += 1;
    } else if (argument === '--cost-source' && value) {
      options.cost = { ...defaultCostOptions(), ...options.cost, source: value };
      index += 1;
    } else if (argument === '--cost-source-date' && value) {
      options.cost = { ...defaultCostOptions(), ...options.cost, sourceDate: value };
      index += 1;
    } else {
      throw new Error(`unknown or incomplete argument: ${argument}`);
    }
  }
  if (!options.baselineSrc) throw new Error('--baseline-src <dir> or M6_BASELINE_SRC is required');
  return options;
}

function costOptionsFromEnv(): EvaluationCostConfig | undefined {
  if (
    !process.env.EVALUATION_COST_CURRENCY ||
    !process.env.EVALUATION_INPUT_TOKEN_PRICE_PER_1M ||
    !process.env.EVALUATION_OUTPUT_TOKEN_PRICE_PER_1M ||
    !process.env.EVALUATION_COST_SOURCE ||
    !process.env.EVALUATION_COST_SOURCE_DATE
  ) {
    return undefined;
  }
  return {
    model: process.env.EVALUATION_COST_MODEL ?? process.env.DEEPSEEK_MODEL ?? 'unknown',
    currency: process.env.EVALUATION_COST_CURRENCY,
    inputTokenPricePer1M: Number(process.env.EVALUATION_INPUT_TOKEN_PRICE_PER_1M),
    outputTokenPricePer1M: Number(process.env.EVALUATION_OUTPUT_TOKEN_PRICE_PER_1M),
    source: process.env.EVALUATION_COST_SOURCE,
    sourceDate: process.env.EVALUATION_COST_SOURCE_DATE,
  };
}

function defaultCostOptions(): EvaluationCostConfig {
  return {
    model: process.env.EVALUATION_COST_MODEL ?? process.env.DEEPSEEK_MODEL ?? 'unknown',
    currency: process.env.EVALUATION_COST_CURRENCY ?? 'unavailable',
    inputTokenPricePer1M: Number(process.env.EVALUATION_INPUT_TOKEN_PRICE_PER_1M ?? Number.NaN),
    outputTokenPricePer1M: Number(process.env.EVALUATION_OUTPUT_TOKEN_PRICE_PER_1M ?? Number.NaN),
    source: process.env.EVALUATION_COST_SOURCE ?? 'unavailable',
    sourceDate: process.env.EVALUATION_COST_SOURCE_DATE ?? 'unavailable',
  };
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return round4(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)]);
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return round4(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
