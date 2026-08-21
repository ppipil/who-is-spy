export type FaultState = 'normal' | 'armed' | 'triggered';

export interface FaultStatus {
  state: FaultState;
  scenario?: string;
  triggeredCount: number;
  remaining?: number;
  gameId?: string;
  triggeredAt?: string;
}

export interface AdminStatus {
  model: string;
  configured: boolean;
  runtimeTrace: 'ON' | 'OFF';
  fault: FaultStatus;
  activeGames: number;
  adminEnabled: boolean;
}

export interface RuntimeEvent {
  eventType: string;
  timestamp: string;
  sequence: number;
  gameId: string;
  round: number;
  [key: string]: unknown;
}

export interface PromptTraceMessage {
  role: string;
  content: string;
}

export interface PromptTraceRecord {
  timestamp: string;
  gameId: string;
  round: number;
  task: string;
  agentId: string;
  role: string | null;
  strategyId: string | null;
  promptTemplateVersion: string;
  promptHash: string;
  publicDescriptionCount: number;
  sameRoundPublicDescriptionCount: number;
  messages: PromptTraceMessage[];
}

export interface EvaluationAggregate {
  games: number;
  completionRate: number;
  validVoteRate: number;
  invalidOutputRate: number;
  descriptionExactSecretLeaks: number;
  descriptionHomogeneity: number;
  latencyMs: { p50: number; p95: number };
  tokensPerGame: number;
  costPerGame: number;
  providerRetryCount: number;
  qualityRepairCount: number;
}

export interface EvaluationData {
  source: string;
  baseline: EvaluationAggregate;
  final: EvaluationAggregate;
  seed101: { note: string; gateFailures: string[] };
}

export type EvaluationModelKind = 'fake' | 'real';
export type EvaluationRunStatus = 'running' | 'completed' | 'failed';

export interface EvaluationRunConfig {
  games: number;
  seed: number;
  model: EvaluationModelKind;
}

export interface EvaluationRunProgress {
  completedGames: number;
  totalGames: number;
}

export interface EvaluationRunSummaryMetrics {
  completionRate: number;
  validVoteRate: number;
  descriptionHomogeneity: number;
  latencyP50: number;
  latencyP95: number;
  tokensPerGame: number;
  costPerGame: number;
  providerRetryCount: number;
  qualityRepairCount: number;
}

export interface EvaluationRunSummary {
  runId: string;
  status: EvaluationRunStatus;
  createdAt: string;
  finishedAt?: string;
  durationMs?: number;
  config: EvaluationRunConfig;
  progress: EvaluationRunProgress;
  gate?: { passed: boolean; failures: string[] };
  metrics?: EvaluationRunSummaryMetrics;
  error?: string;
}

export interface EvaluationLiveMetrics {
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
  tokenUsage: {
    input: number;
    output: number;
    total: number;
    averagePerGame: { input: number; output: number; total: number };
    byTask: Record<'describe' | 'vote' | 'review', { input: number; output: number; total: number; retryAddedTokens: number }>;
    source: 'provider' | 'unavailable';
  };
  cost: {
    source: 'configured' | 'unavailable';
    model: string;
    currency: string;
    inputCost: number;
    outputCost: number;
    totalCost: number;
    averageCostPerGame: number;
    formula: string;
  };
  byStrategyId: Record<
    string,
    { games: number; wins: number; winRate: number; votes: number; accurateVotes: number; voteAccuracy: number }
  >;
  descriptionHomogeneity: number;
  safety: { secretLeakOccurrences: number; publicStateLeakOccurrences: number; illegalStateOccurrences: number };
}

export interface EvaluationResult {
  schemaVersion: number;
  configuration: { games: number; seed: number; model: EvaluationModelKind };
  metrics: EvaluationLiveMetrics;
  gate: { passed: boolean; failures: string[] };
}

export interface EvaluationRunDetail extends EvaluationRunSummary {
  result?: EvaluationResult;
}

export interface SameRoundDescription {
  playerId: string;
  playerName: string;
  text: string;
}

export interface SameRoundEvidence {
  agentId: string;
  agentName: string;
  round: number;
  gameId: string;
  promptVersion: string;
  promptHash: string;
  publicDescriptionCount: number;
  sameRoundPublicDescriptionCount: number;
  timestamp: string;
  sameRoundDescriptions: SameRoundDescription[];
}

export interface PersonaProbeCase {
  personaId: 'cautious' | 'intuitive' | 'analytical' | 'contrarian';
  personaName: string;
  agentName: string;
  risk: string;
  description: string;
  voteTarget: string;
  reason: string;
  strategyFocus: string;
}

export interface PersonaPromptView {
  promptVersion: string;
  promptHash: string;
  messages: Array<{ role: string; content: string }>;
}

export interface PersonaRunCase extends PersonaProbeCase {
  prompts: { describe: PersonaPromptView; vote: PersonaPromptView };
}

export interface PersonaProbeEvidence {
  generatedAt: string;
  command: string;
  model: string;
  scenario: string;
  cases: PersonaProbeCase[];
}

export interface QualityGateAttempt {
  attempt: number;
  candidate: string;
  gate: 'REJECTED' | 'PASSED';
  reason?: string;
  similarity?: number;
  threshold?: number;
  willRetry: boolean;
}

export interface QualityGateEvidence {
  source: string;
  sourceNote: string;
  agent: string;
  round: number;
  attempts: QualityGateAttempt[];
  committed: string;
  gameStateProof: string;
}

export interface Task1Evidence {
  relation: { label: string; meaning: string };
  sameRound: SameRoundEvidence | null;
  contextRecords: ContextRecordSummary[];
  persona: PersonaProbeEvidence;
  qualityGate: QualityGateEvidence;
}

export interface ContextRecordSummary {
  gameId: string;
  round: number;
  agentId: string;
  agentName: string;
  sameRoundPublicDescriptionCount: number;
  publicDescriptionCount: number;
  timestamp: string;
  promptVersion: string;
  sameRoundDescriptions: SameRoundDescription[];
}

export interface ContextBuildInput {
  agentId: string;
  round: number;
  publicDescriptions: SameRoundDescription[];
  role?: 'civilian' | 'undercover';
  word?: string;
}

export interface ContextBuildResult {
  agentId: string;
  agentName: string;
  strategyId: string;
  round: number;
  sameRoundPublicDescriptionCount: number;
  publicDescriptionCount: number;
  promptVersion: string;
  promptHash: string;
  messages: Array<{ role: string; content: string }>;
}

export interface PersonaRunInput {
  role: 'civilian' | 'undercover';
  word: string;
  round: number;
  publicDescriptions: SameRoundDescription[];
}

export interface PersonaRunResult {
  generatedAt: string;
  model: string;
  scenario: string;
  cases: PersonaRunCase[];
}

export interface SequentialAgentStep {
  agentId: string;
  agentName: string;
  personaId: string;
  personaName: string;
  round: number;
  sameRoundPublicDescriptionCount: number;
  publicDescriptionCount: number;
  receivedSameRound: SameRoundDescription[];
  promptVersion: string;
  promptHash: string;
  messages: Array<{ role: string; content: string }>;
  description: string;
}

export interface SequentialRunResult {
  gameId: string;
  round: number;
  completedRounds: number;
  civilianWord: string;
  undercoverWord: string;
  humanDescription: string;
  steps: SequentialAgentStep[];
  endedNote?: string;
}

export interface GameVoteRecord {
  voterId: string;
  targetId: string;
  reason: string;
  round: number;
  ballot: number;
}

export interface GameVotesPayload {
  gameId: string;
  players: Array<{ id: string; name: string }>;
  votes: GameVoteRecord[];
}

export interface QualityGateCheckInput {
  attempt1Candidate: string;
  attempt2Candidate: string;
  acceptedSameRound: string[];
  threshold: number;
  allSecrets: string[];
}

export interface QualityGateCheckResult {
  attempts: Array<{
    attempt: number;
    candidate: string;
    gate: 'REJECTED' | 'PASSED';
    reason?: string;
    similarity?: number;
    threshold?: number;
    willRetry: boolean;
  }>;
  committed: string | null;
  notCommitted: string[];
}

async function adminRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(payload.error ?? '请求失败，请稍后重试');
  }
  return payload;
}

function queryString(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(
    (entry): entry is [string, string | number] => entry[1] !== undefined && entry[1] !== '',
  );
  return entries.length === 0 ? '' : `?${new URLSearchParams(entries.map(([key, value]) => [key, String(value)])).toString()}`;
}

export const adminApi = {
  status: () => adminRequest<AdminStatus>('/api/admin/status'),
  traces: (params: { gameId?: string; round?: string; agent?: string; task?: string; errorType?: string; runId?: string }) =>
    adminRequest<{ count: number; events: RuntimeEvent[] }>(`/api/admin/traces${queryString(params)}`),
  promptTraces: (params: { gameId?: string; round?: string; agentId?: string; task?: string }) =>
    adminRequest<{ count: number; records: PromptTraceRecord[] }>(`/api/admin/prompt-traces${queryString(params)}`),
  faults: () => adminRequest<FaultStatus>('/api/admin/faults'),
  armFault: (scenario: string, targetAgent?: string, delayMs?: number) =>
    adminRequest<FaultStatus>('/api/admin/faults/arm', {
      method: 'POST',
      body: JSON.stringify({ scenario, targetAgent, delayMs }),
    }),
  clearFault: () =>
    adminRequest<FaultStatus>('/api/admin/faults/clear', {
      method: 'POST',
    }),
  evaluation: () => adminRequest<EvaluationData>('/api/admin/evaluation'),
  startEvaluation: (config: EvaluationRunConfig) =>
    adminRequest<{ runId: string; status: EvaluationRunStatus }>('/api/admin/evaluation/run', {
      method: 'POST',
      body: JSON.stringify(config),
    }),
  evaluationRuns: () => adminRequest<{ runs: EvaluationRunSummary[] }>('/api/admin/evaluation/runs'),
  evaluationRun: (runId: string) => adminRequest<EvaluationRunDetail>(`/api/admin/evaluation/runs/${runId}`),
  task1: () => adminRequest<Task1Evidence>('/api/admin/task1'),
  task1Context: (input: ContextBuildInput) =>
    adminRequest<ContextBuildResult>('/api/admin/task1/context', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  task1PersonaRun: (input: PersonaRunInput) =>
    adminRequest<PersonaRunResult>('/api/admin/task1/persona/run', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  task1SequentialRun: (input: {
    civilianWord: string;
    undercoverWord: string;
    humanDescription: string;
    round: number;
  }) =>
    adminRequest<SequentialRunResult>('/api/admin/task1/sequential/run', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  gameVotes: (gameId: string) => adminRequest<GameVotesPayload>(`/api/admin/games/${gameId}/votes`),
  task1Quality: (input: QualityGateCheckInput) =>
    adminRequest<QualityGateCheckResult>('/api/admin/task1/quality', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
};

export const FAULT_SCENARIOS = [
  'describe-timeout',
  'describe-bad-json',
  'schema-failure',
  'vote-rate-limit',
  'describe-final-failure',
  'vote-final-failure',
  'review-failure',
];

export const PERSONA_NAMES: Record<string, string> = {
  cautious: '谨慎观察',
  intuitive: '直觉敏锐',
  analytical: '逻辑派',
  contrarian: '出其不意',
};

export const PERSONA_SUMMARY: Record<string, string> = {
  cautious: '低风险 / 先观察 / 少透露',
  intuitive: '场景 / 感受 / 语言自然度',
  analytical: '类别 / 关系 / 逻辑一致性',
  contrarian: '反例 / 非主流视角 / 反共识检查',
};
