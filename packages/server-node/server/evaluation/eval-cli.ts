import { runEvaluation, type EvaluationModelKind, type EvaluationResult } from './evaluation.js';

interface CliOptions {
  games: number;
  seed: number;
  model: EvaluationModelKind;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const result = await runEvaluation({ games: options.games, seed: options.seed, modelKind: options.model });
  printHumanTable(result);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.gate.passed) process.exitCode = 1;
}

function parseArguments(arguments_: string[]): CliOptions {
  const options: CliOptions = { games: 20, seed: 42, model: 'fake' };
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
    } else {
      throw new Error(`unknown or incomplete argument: ${argument}`);
    }
  }
  return options;
}

function printHumanTable(result: EvaluationResult): void {
  const { metrics } = result;
  const rows = [
    ['started/completed', `${metrics.startedGames}/${metrics.completedGames}`],
    ['completionRate', formatRate(metrics.completionRate)],
    ['descriptionAttempts', String(metrics.descriptionAttempts)],
    ['validVoteRate', formatRate(metrics.validVoteRate)],
    ['invalidOutputRate', formatRate(metrics.invalidOutputRate)],
    ['secretLeakRejectRate', formatRate(metrics.secretLeakRejectRate)],
    ['duplicateRejectRate', formatRate(metrics.duplicateRejectRate)],
    ['retryRate', formatRate(metrics.retryRate)],
    ['latency p50/p95 ms', `${metrics.latencyMs.p50}/${metrics.latencyMs.p95}`],
    ['tokens input/output/total', `${metrics.tokenUsage.input}/${metrics.tokenUsage.output}/${metrics.tokenUsage.total}`],
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

