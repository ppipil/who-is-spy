import { runEvaluation, type EvaluationCostConfig, type EvaluationModelKind, type EvaluationResult } from './evaluation.js';

interface CliOptions {
  games: number;
  seed: number;
  model: EvaluationModelKind;
  commit?: string;
  runId?: string;
  cost?: EvaluationCostConfig;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const result = await runEvaluation({
    games: options.games,
    seed: options.seed,
    modelKind: options.model,
    commit: options.commit,
    runId: options.runId,
    cost: options.cost,
  });
  printHumanTable(result);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.gate.passed) process.exitCode = 1;
}

function parseArguments(arguments_: string[]): CliOptions {
  const options: CliOptions = { games: 20, seed: 42, model: 'fake', cost: costOptionsFromEnv() };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (argument === '--games' && value) {
      options.games = Number(value);
      index += 1;
    } else if (argument === '--seed' && value) {
      options.seed = Number(value);
      index += 1;
    } else if (argument === '--model' && (value === 'fake' || value === 'real')) {
      options.model = value;
      index += 1;
    } else if (argument === '--commit' && value) {
      options.commit = value;
      index += 1;
    } else if (argument === '--run-id' && value) {
      options.runId = value;
      index += 1;
    } else if (argument === '--cost-model' && value) {
      options.cost = { ...defaultCostOptions(), ...options.cost, model: value };
      index += 1;
    } else if (argument === '--cost-currency' && value) {
      options.cost = { ...defaultCostOptions(), ...options.cost, currency: value };
      index += 1;
    } else if (argument === '--input-token-price-per-1m' && value) {
      options.cost = { ...defaultCostOptions(), ...options.cost, inputTokenPricePer1M: Number(value) };
      index += 1;
    } else if (argument === '--output-token-price-per-1m' && value) {
      options.cost = { ...defaultCostOptions(), ...options.cost, outputTokenPricePer1M: Number(value) };
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

function printHumanTable(result: EvaluationResult): void {
  const { metrics } = result;
  const rows = [
    ['started/completed', `${metrics.startedGames}/${metrics.completedGames}`],
    ['schemaVersion', String(result.schemaVersion)],
    ['runId', result.run.runId],
    ['commit', result.run.commit],
    ['completionRate', formatRate(metrics.completionRate)],
    ['descriptionAttempts', String(metrics.descriptionAttempts)],
    ['validVoteRate', formatRate(metrics.validVoteRate)],
    ['invalidOutputRate', formatRate(metrics.invalidOutputRate)],
    ['secretLeakRejectRate', formatRate(metrics.secretLeakRejectRate)],
    ['duplicateRejectRate', formatRate(metrics.duplicateRejectRate)],
    ['retryRate', formatRate(metrics.retryRate)],
    ['latency p50/p95 ms', `${metrics.latencyMs.p50}/${metrics.latencyMs.p95}`],
    [
      'tokens input/output/total',
      `${metrics.tokenUsage.input}/${metrics.tokenUsage.output}/${metrics.tokenUsage.total} (${metrics.tokenUsage.source})`,
    ],
    ['avg tokens/game', `${metrics.tokenUsage.averagePerGame.input}/${metrics.tokenUsage.averagePerGame.output}/${metrics.tokenUsage.averagePerGame.total}`],
    ['internal retries', String(metrics.internalRetryCount)],
    ['retry-added tokens', String(metrics.retryAddedTokens)],
    ['estimated cost', `${metrics.cost.totalCost} ${metrics.cost.currency} (${metrics.cost.source})`],
    ['descriptionHomogeneity', String(metrics.descriptionHomogeneity)],
    ['gate', result.gate.passed ? 'PASS' : `FAIL: ${result.gate.failures.join('; ')}`],
  ];
  console.error('\nEvaluation metrics');
  console.error('Metric'.padEnd(30), 'Value');
  console.error('-'.repeat(52));
  for (const [name, value] of rows) console.error(name.padEnd(30), value);
  console.error('\nStrategy metrics');
  console.error('strategyId'.padEnd(24), 'games  winRate  voteAccuracy');
  console.error('-'.repeat(58));
  for (const [strategyId, group] of Object.entries(metrics.byStrategyId)) {
    console.error(
      strategyId.padEnd(24),
      String(group.games).padEnd(6),
      formatRate(group.winRate).padEnd(9),
      formatRate(group.voteAccuracy),
    );
  }
}

function formatRate(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

