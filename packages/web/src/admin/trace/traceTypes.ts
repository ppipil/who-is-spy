export interface AdminStatus {
  model: string;
  configured: boolean;
  runtimeTrace: 'ON' | 'OFF';
  activeGames: number;
  adminEnabled: boolean;
}

export interface RuntimeEvent {
  eventType: string;
  timestamp: string;
  sequence: number;
  gameId: string;
  round: number;
  runId?: string;
  sourceType?: string;
  entrypoint?: string;
  modelKind?: string;
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
  runId?: string;
}

export interface TraceFilters {
  gameId: string;
  runId: string;
  round: string;
  agent: string;
  task: string;
  errorType: string;
}

export interface TraceRunRow {
  runId: string;
  gameId?: string;
  sourceType: string;
  status: 'running' | 'completed' | 'failed';
  createdAt: string;
  modelKind?: string;
  durationMs: number;
  events: RuntimeEvent[];
}

export type TimelineStatus = 'ok' | 'fail' | 'warn' | 'neutral';
export type TimelineKind = 'run' | 'round' | 'action' | 'model' | 'prompt' | 'public' | 'vote' | 'quality' | 'recovery' | 'retry' | 'continue';

export interface TimelineNode {
  id: string;
  kind: TimelineKind;
  title: string;
  status: TimelineStatus;
  meta: Array<{ label: string; value: string }>;
  occurredAt?: string;
  children: TimelineNode[];
  events: RuntimeEvent[];
  prompt?: PromptTraceRecord;
}
