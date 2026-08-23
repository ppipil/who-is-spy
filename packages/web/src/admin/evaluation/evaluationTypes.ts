export type EvaluationModel = 'fake' | 'real';
export type EvaluationStatus = 'PASS' | 'WARN' | 'FAIL';
export type EvaluationReportSource = 'local' | 'archive';
export type JudgeStatus = 'available' | 'unavailable' | 'disabled';

export interface EvaluationCaseOption {
  id: 'normal-human-input' | 'nonsense-human-input';
  name: string;
  humanDescription: string;
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
  tokenUsage: { input: number | null; output: number | null; total: number | null; source: string };
  safety: {
    secretLeakOccurrences: number;
    publicStateLeakOccurrences: number;
    illegalStateOccurrences: number;
  };
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
  deterministic: {
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
  judge: {
    status: JudgeStatus;
    retryCount: number;
    behaviorScore: number | null;
    reason: string;
    output?: {
      personaAdherence: { score: number; agents: Record<string, number>; reason?: string; evidence?: string };
      semanticDiversity: { score: number; reason?: string; evidence?: string };
      contextUtilization: { score: number; reason?: string; evidence?: string };
      humanInputResponsiveness: { score: number; reason?: string; evidence?: string };
      exposureControl: { score: number; reason?: string; evidence?: string };
      issues: string[];
      summary: string;
    };
  };
  problems: Array<{ title: string; evidence?: string }>;
}

export interface StartEvaluationInput {
  model: EvaluationModel;
  cases: string[];
  judgeEnabled: boolean;
}
export interface EvaluationHistoryResponse {
  reports: EvaluationReport[];
  archivedReports: EvaluationReport[];
}
