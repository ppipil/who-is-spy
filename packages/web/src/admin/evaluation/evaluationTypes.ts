export type EvaluationModel = 'fake' | 'real';
export type EvaluationStatus = 'PASS' | 'WARN' | 'FAIL';
export type EvaluationReportSource = 'local' | 'archive';
export type JudgeStatus = 'available' | 'unavailable' | 'disabled' | 'skipped';

export interface EvaluationCaseOption {
  id: 'normal-human-input' | 'nonsense-human-input';
  name: string;
  humanDescription: string;
}

export interface EvaluationCasesResponse {
  cases: EvaluationCaseOption[];
  fixtureWords: [string, string];
  defaultRounds: number;
  maxRounds: number;
  provider: { model: string; configured: boolean; envProxyEnabled: boolean };
}

export interface EvaluationCaseEvidence {
  playerId: string;
  playerName: string;
  strategyId: string;
  round: number;
  text: string;
}

export interface EvaluationVoteEvidence {
  voterId: string;
  voterName: string;
  strategyId: string;
  targetId: string;
  round: number;
  reason: string;
}

export interface EvaluationMetrics {
  startedGames: number;
  completedGames: number;
  completionRate: number;
  validVoteRate: number;
  invalidOutputRate: number;
  retryRate: number;
  descriptionHomogeneity: number;
  humanInputResponsiveness?: {
    available: boolean;
    normalHumanVotes: number;
    nonsenseHumanVotes: number;
    reasonAwarenessHits: number;
    note: string;
  };
  latencyMs: { p50: number; p95: number };
  tokenUsage: { input: number | null; output: number | null; total: number | null; cacheHitInput?: number | null; cacheMissInput?: number | null; requests?: number; source: string };
  cost?: { totalUsd: number | null; perGameUsd: number | null; currency: 'USD'; source: string; model?: string; tier?: string };
  safety: {
    secretLeakOccurrences: number;
    publicStateLeakOccurrences: number;
    illegalStateOccurrences: number;
  };
}

export interface ArchivedEvaluationEvidence {
  versionStage: string;
  evaluatedCommit: string;
  model: string;
  gamesSeeds: string;
  completion: string;
  validVote: string;
  homogeneity: string;
  latency: string;
  tokenCost: string;
  gateResult: string;
  conclusion: string;
  sourceBranch: string;
  sourcePath: string;
  notMeasured: string[];
}

export interface JudgeDimensionResult {
  status: 'available' | 'unavailable';
  score: number | null;
  retryCount: number;
  reason: string;
  evidence: string;
  summary: string;
}

export interface EvaluationReport {
  id: string;
  source: EvaluationReportSource;
  title: string;
  createdAt: string;
  status: EvaluationStatus;
  model: EvaluationModel;
  cases: EvaluationCaseOption[];
  durationMs: number;
  evidenceUrl?: string;
  archivedEvidence?: ArchivedEvaluationEvidence;
  deterministic?: {
    configuration: { games: number; seed: number; model: EvaluationModel };
    cases?: Array<{
      caseId: string;
      gameId: string;
      completed: boolean;
      humanDescription: string;
      humanVotesReceived: number;
      totalAiVotes: number;
      reasonAwarenessHits: number;
      descriptions: EvaluationCaseEvidence[];
      votes: EvaluationVoteEvidence[];
      error?: string;
    }>;
    metrics: EvaluationMetrics;
    gate: { passed: boolean; failures: string[] };
  };
  judge?: {
    status: JudgeStatus;
    retryCount: number;
    behaviorScore: number | null;
    availableMetrics: number;
    totalMetrics: 5;
    scoreCoverage?: 'full' | 'partial';
    reason: string;
    output?: {
      personaAdherence: JudgeDimensionResult;
      semanticDiversity: JudgeDimensionResult;
      contextUtilization: JudgeDimensionResult;
      humanInputResponsiveness: JudgeDimensionResult;
      exposureControl: JudgeDimensionResult;
      summary: string;
    };
  };
  problems: Array<{ title: string; evidence?: string }>;
}

export interface StartEvaluationInput {
  model: EvaluationModel;
  cases: string[];
  judgeEnabled: boolean;
  wordPair: [string, string];
  caseInputs: Partial<Record<EvaluationCaseOption['id'], string>>;
  rounds: number;
}
export interface EvaluationHistoryResponse {
  reports: EvaluationReport[];
  archivedReports: EvaluationReport[];
}
