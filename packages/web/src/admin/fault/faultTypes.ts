export type FaultScenarioId = 'describe-timeout' | 'describe-bad-json' | 'review-failure';
export interface FaultScenario { id: FaultScenarioId; name: string; description: string }
export type FaultOutcome = 'PAUSED SAFELY' | 'RECOVERED BY RETRY' | 'RECOVERED BY MANUAL RESUME' | 'RECOVERED BY FALLBACK' | 'SAFE ABORT' | 'NOT EXECUTED';
export interface FaultDemoStep {
  sequence: number; kind: 'attempt' | 'retry' | 'manual_resume' | 'fallback';
  status: 'FAILED' | 'SUCCESS' | 'SCHEDULED' | 'STARTED' | 'RECOVERED' | 'EXHAUSTED';
  title: string; attempt?: number; errorType?: string; willRetry?: boolean;
}
export interface FaultDemoResult {
  scenario: FaultScenarioId; scenarioName: string;
  faultStatus: 'FAULT TRIGGERED' | 'TARGET FAULT NOT REACHED'; outcome: FaultOutcome;
  injectedFault: string; gameId: string; runId: string; round: number; phase: string;
  agentId: string; task: string; targetAttempt: number; canRecover: boolean;
  recoveryAction: string; stateEvidence: string[]; timeline: FaultDemoStep[]; stopReason?: string;
}
