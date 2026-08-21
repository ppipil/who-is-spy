/**
 * 评测证据数据（只读）
 *
 * M6 最终对比的规范基线：baseline vs improved（seeds 101–105, deepseek-v4-flash）。
 * 来源为 eval/m6-final-comparison 分支的 aggregate 报告，勿手工编辑；
 * 若需更新，请从 docs/evidence 重新派生。
 */
export const evaluationData = {
  source: 'eval/m6-final-comparison branch aggregate reports (seeds 101-105, deepseek-v4-flash)',
  baseline: {
    games: 5,
    completionRate: 1,
    validVoteRate: 1,
    invalidOutputRate: 0,
    descriptionExactSecretLeaks: 0,
    descriptionHomogeneity: 0.064,
    latencyMs: { p50: 6079.0278, p95: 36629.7186 },
    tokensPerGame: 21765.6,
    costPerGame: 0.0162,
    providerRetryCount: 6,
    qualityRepairCount: 0,
  },
  final: {
    games: 5,
    completionRate: 0.8,
    validVoteRate: 1,
    invalidOutputRate: 0.0182,
    descriptionExactSecretLeaks: 0,
    descriptionHomogeneity: 0.0107,
    latencyMs: { p50: 10236.2338, p95: 58342.955 },
    tokensPerGame: 27251.2,
    costPerGame: 0.0215,
    providerRetryCount: 11,
    qualityRepairCount: 1,
  },
  seed101: {
    note: 'Final seed 101: real provider describe timeout -> safe abort -> incomplete game (completionRate 0.80 aggregate).',
    gateFailures: [
      'completionRate must equal 1.0',
      'evaluation games must not enter illegal or incomplete state',
    ],
  },
};
