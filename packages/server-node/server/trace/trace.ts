import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

export type ModelTask = 'describe' | 'vote' | 'review' | 'judge';

export type ModelErrorType =
  | 'timeout'
  | 'rate_limit'
  | 'provider_5xx'
  | 'http_non_retryable'
  | 'invalid_json'
  | 'schema_validation'
  | 'network'
  | 'secret'
  | 'unknown';

export interface ModelDiagnostic {
  errorType: ModelErrorType;
  httpStatus?: number;
  retryable: boolean;
  attempt: number;
}

export type TraceOutcome = 'success' | 'failure' | 'fallback';
export type TraceSourceType = 'USER_GAME' | 'ADMIN_PROBE' | 'EVAL_RUN' | 'FAULT_RUN' | 'CLI_DEMO' | 'TEST';
export type TraceEntrypoint = 'web' | 'admin' | 'cli' | 'test';
export type TraceModelKind = 'real' | 'fake' | 'none';
export type TraceRunStatus = 'running' | 'completed' | 'failed';

export interface TraceOrigin {
  sourceType: TraceSourceType;
  entrypoint: TraceEntrypoint;
  modelKind: TraceModelKind;
  runId?: string;
}

export interface TraceRunMetadata {
  runId: string;
  sourceType: TraceSourceType;
  status: TraceRunStatus;
  createdAt: string;
  modelKind?: TraceModelKind;
  scenario?: string;
  gameId?: string;
  targetAgent?: string;
  faultType?: string;
  scenarioOutcome?: string;
  entrypoint?: TraceEntrypoint;
}

export interface ModelCallTraceEvent {
  eventType: 'model_call';
  timestamp: string;
  sequence: number;
  gameId: string;
  round: number;
  phase: string;
  ballot?: number;
  task: ModelTask;
  agentId: string;
  agentName?: string;
  strategyId?: string;
  attempt: number;
  errorType?: ModelErrorType;
  httpStatus?: number;
  latencyMs: number;
  willRetry: boolean;
  outcome: TraceOutcome;
  model?: string;
  temperature?: number;
  inputSummary?: string;
  output?: string;
  promptTemplateVersion?: string;
  injectedFault?: { agentId: string; faultType: ModelErrorType; round: number; attempt: number };
  sourceType?: TraceSourceType;
  entrypoint?: TraceEntrypoint;
  modelKind?: TraceModelKind;
  runId?: string;
}

export interface PublicRuntimeTraceEvent {
  eventType: 'public_event';
  timestamp: string;
  sequence: number;
  gameId: string;
  round: number;
  phase: string;
  ballot?: number;
  publicEventType: string;
  agentId?: string;
  agentName?: string;
  outcome: TraceOutcome;
  model?: string;
  temperature?: number;
  inputSummary?: string;
  output?: string;
  promptTemplateVersion?: string;
  sourceType?: TraceSourceType;
  entrypoint?: TraceEntrypoint;
  modelKind?: TraceModelKind;
  runId?: string;
}

export interface RecoveryActionTraceEvent {
  eventType: 'recovery_action';
  timestamp: string;
  sequence: number;
  gameId: string;
  round: number;
  phase: 'describing';
  ballot?: number;
  recoveryAction: 'description_resume';
  agentId: string;
  agentName?: string;
  manualResumeIndex: number;
  manualRetriesRemaining: number;
  recoveryOutcome?: 'recovered' | 'exhausted';
  sourceType?: TraceSourceType;
  entrypoint?: TraceEntrypoint;
  modelKind?: TraceModelKind;
  runId?: string;
}

export interface PromptProvenanceTraceEvent {
  eventType: 'prompt_provenance';
  timestamp: string;
  sequence: number;
  gameId: string;
  round: number;
  task: ModelTask;
  agentId: string;
  role?: string;
  strategyId?: string;
  promptTemplateVersion: string;
  promptHash: string;
  model: string;
  temperature: number;
  publicDescriptionCount: number;
  sameRoundPublicDescriptionCount: number;
  strategyGuidance?: string;
  repairViolationType?: string;
  sourceType?: TraceSourceType;
  entrypoint?: TraceEntrypoint;
  modelKind?: TraceModelKind;
  runId?: string;
}

export interface QualityViolationTraceEvent {
  eventType: 'quality_violation';
  timestamp: string;
  sequence: number;
  gameId: string;
  round: number;
  phase: 'describing';
  agentId: string;
  strategyId: string;
  attempt: number;
  violationType: string;
  similarity?: number;
  willRetry: boolean;
  sourceType?: TraceSourceType;
  entrypoint?: TraceEntrypoint;
  modelKind?: TraceModelKind;
  runId?: string;
}

export interface VoteTraceEvent {
  eventType: 'vote';
  timestamp: string;
  sequence: number;
  gameId: string;
  round: number;
  ballot?: number;
  agentId: string;
  targetId: string;
  reason: string;
  sourceType?: TraceSourceType;
  entrypoint?: TraceEntrypoint;
  modelKind?: TraceModelKind;
  runId?: string;
}

export interface TraceRunLifecycleEvent {
  eventType: 'trace_run';
  timestamp: string;
  sequence: number;
  gameId: string;
  round: number;
  runId: string;
  sourceType: TraceSourceType;
  status: TraceRunStatus;
  createdAt: string;
  modelKind?: TraceModelKind;
  scenario?: string;
  targetAgent?: string;
  faultType?: string;
  scenarioOutcome?: string;
  entrypoint?: TraceEntrypoint;
}

export type RuntimeTraceEvent =
  | ModelCallTraceEvent
  | PublicRuntimeTraceEvent
  | RecoveryActionTraceEvent
  | PromptProvenanceTraceEvent
  | QualityViolationTraceEvent
  | VoteTraceEvent
  | TraceRunLifecycleEvent;
export type RuntimeTraceDraft =
  | Omit<ModelCallTraceEvent, 'timestamp' | 'sequence'>
  | Omit<PublicRuntimeTraceEvent, 'timestamp' | 'sequence'>
  | Omit<RecoveryActionTraceEvent, 'timestamp' | 'sequence'>
  | Omit<PromptProvenanceTraceEvent, 'timestamp' | 'sequence'>
  | Omit<QualityViolationTraceEvent, 'timestamp' | 'sequence'>
  | Omit<VoteTraceEvent, 'timestamp' | 'sequence'>
  | Omit<TraceRunLifecycleEvent, 'timestamp' | 'sequence'>;

export interface TraceSink {
  record(event: RuntimeTraceDraft): void;
}

export interface TraceEventStore extends TraceSink {
  readonly events: RuntimeTraceEvent[];
}

export const DEFAULT_ADMIN_TRACE_PATH = path.resolve(
  fileURLToPath(new URL('../../traces/admin-runtime.jsonl', import.meta.url)),
);

export class InMemoryTraceSink implements TraceEventStore {
  readonly events: RuntimeTraceEvent[] = [];
  private sequence = 0;

  record(event: RuntimeTraceDraft): void {
    this.events.push({ ...event, timestamp: new Date().toISOString(), sequence: ++this.sequence } as RuntimeTraceEvent);
  }
}

export class ConsoleTraceSink implements TraceSink {
  private sequence = 0;

  record(event: RuntimeTraceDraft): void {
    const full = { ...event, timestamp: new Date().toISOString(), sequence: ++this.sequence } as RuntimeTraceEvent;
    console.error(formatTraceLine(full));
  }
}

export class JsonlTraceSink implements TraceSink {
  private sequence = 0;

  constructor(readonly filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  record(event: RuntimeTraceDraft): void {
    const full = { ...event, timestamp: new Date().toISOString(), sequence: ++this.sequence } as RuntimeTraceEvent;
    fs.appendFileSync(this.filePath, `${JSON.stringify(full)}\n`, 'utf8');
  }
}

export class PersistentJsonlTraceSink implements TraceEventStore {
  readonly events: RuntimeTraceEvent[];
  private sequence: number;

  constructor(readonly filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.events = readJsonlTrace(filePath);
    this.sequence = this.events.reduce((max, event) => Math.max(max, event.sequence), 0);
  }

  record(event: RuntimeTraceDraft): void {
    const full = { ...event, timestamp: new Date().toISOString(), sequence: ++this.sequence } as RuntimeTraceEvent;
    this.events.push(full);
    fs.appendFileSync(this.filePath, `${JSON.stringify(full)}\n`, 'utf8');
  }
}

export class CompositeTraceSink implements TraceSink {
  constructor(private readonly sinks: readonly TraceSink[]) {}

  record(event: RuntimeTraceDraft): void {
    for (const sink of this.sinks) sink.record(event);
  }
}

/**
 * 用装饰器给任意 TraceSink 统一盖上 sourceType、entrypoint、modelKind 和可选 runId。
 * 业务生产者无需重复传来源字段，也避免同一运行中的事件被错误归类到不同来源。
 */
export function stampTraceOrigin(sink: TraceSink, origin: TraceOrigin): TraceSink {
  return {
    record(event) {
      sink.record({
        ...event,
        sourceType: origin.sourceType,
        entrypoint: origin.entrypoint,
        modelKind: origin.modelKind,
        ...(origin.runId ? { runId: origin.runId } : {}),
      } as RuntimeTraceDraft);
    },
  };
}

/**
 * 写入或更新一条运行生命周期事件，用 running/completed/failed 串起同一 runId。
 * metadata 只包含运行定位与场景信息，不接受密词、API Key 或完整 Prompt。
 */
export function recordTraceRun(sink: TraceSink | undefined, metadata: TraceRunMetadata): void {
  sink?.record({
    eventType: 'trace_run',
    gameId: metadata.gameId ?? metadata.runId,
    round: 0,
    runId: metadata.runId,
    sourceType: metadata.sourceType,
    status: metadata.status,
    createdAt: metadata.createdAt,
    ...(metadata.modelKind ? { modelKind: metadata.modelKind } : {}),
    ...(metadata.scenario ? { scenario: metadata.scenario } : {}),
    ...(metadata.targetAgent ? { targetAgent: metadata.targetAgent } : {}),
    ...(metadata.faultType ? { faultType: metadata.faultType } : {}),
    ...(metadata.scenarioOutcome ? { scenarioOutcome: metadata.scenarioOutcome } : {}),
    ...(metadata.entrypoint ? { entrypoint: metadata.entrypoint } : {}),
  });
}

export function listTraceRuns(events: readonly RuntimeTraceEvent[]): TraceRunMetadata[] {
  const byRunId = new Map<string, TraceRunMetadata>();
  for (const event of events) {
    if (event.eventType !== 'trace_run') continue;
    byRunId.set(event.runId, {
      runId: event.runId,
      sourceType: event.sourceType,
      status: event.status,
      createdAt: event.createdAt,
      gameId: event.gameId,
      ...(event.modelKind ? { modelKind: event.modelKind } : {}),
      ...(event.scenario ? { scenario: event.scenario } : {}),
      ...(event.targetAgent ? { targetAgent: event.targetAgent } : {}),
      ...(event.faultType ? { faultType: event.faultType } : {}),
      ...(event.scenarioOutcome ? { scenarioOutcome: event.scenarioOutcome } : {}),
      ...(event.entrypoint ? { entrypoint: event.entrypoint } : {}),
    });
  }
  return [...byRunId.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function filterTraceEventsByRun(events: readonly RuntimeTraceEvent[], runId: string): RuntimeTraceEvent[] {
  return events.filter((event) => event.runId === runId);
}

export function filterTraceEventsByCase(events: readonly RuntimeTraceEvent[], runId: string, gameId: string): RuntimeTraceEvent[] {
  return events.filter((event) => event.gameId === gameId && event.runId === runId);
}
/**
 * 创建 Admin Console 使用的可查询 trace store。
 * ADMIN_TRACE_JSONL=0/off/memory 时只存内存，否则持久化到配置路径或默认 JSONL；两种实现共享同一事件 schema。
 */
export function createAdminRuntimeTraceSink(): TraceEventStore {
  const configuredPath = process.env.ADMIN_TRACE_JSONL;
  if (configuredPath === '0' || configuredPath === 'off' || configuredPath === 'memory') return new InMemoryTraceSink();
  return new PersistentJsonlTraceSink(configuredPath && configuredPath.trim() ? configuredPath : DEFAULT_ADMIN_TRACE_PATH);
}

export function createTraceSinkFromEnv(): TraceSink | undefined {
  const sinks: TraceSink[] = [];
  if (process.env.M5_TRACE_CONSOLE === '1') sinks.push(new ConsoleTraceSink());
  const jsonlPath = process.env.M5_TRACE_JSONL;
  if (jsonlPath) sinks.push(new JsonlTraceSink(jsonlPath));
  return sinks.length === 0 ? undefined : new CompositeTraceSink(sinks);
}

export async function measureLatency<T>(operation: () => Promise<T>): Promise<{ result: T; latencyMs: number }> {
  const startedAt = performance.now();
  const result = await operation();
  return { result, latencyMs: round(performance.now() - startedAt) };
}

export function formatTraceLine(event: RuntimeTraceEvent): string {
  if (event.eventType === 'trace_run') {
    const label = event.status === 'completed' ? '完成' : event.status === 'failed' ? '失败' : '运行中';
    return `#${event.sequence} Run ${event.runId} · ${event.sourceType} ${label}`;
  }
  if (event.eventType === 'vote') {
    return `#${event.sequence} 第${event.round}轮 投票阶段 · 投票 ${displayAgent(event.agentId)} → ${displayAgent(event.targetId)}：${event.reason}`;
  }
  if (event.eventType === 'quality_violation') {
    return `#${event.sequence} 第${event.round}轮 描述阶段 · 质量门禁 ${displayAgent(event.agentId)} ${event.violationType}${event.willRetry ? ' → 修复重试' : ' → 中止'}`;
  }  if (event.eventType === 'public_event') {
    return `#${event.sequence} 第${event.round}轮 ${phaseLabel(event.phase)} · 公开事件 ${publicEventLabel(event.publicEventType)}`;
  }
  if (event.eventType === 'recovery_action') {
    const outcome = event.recoveryOutcome === 'recovered' ? '恢复成功' : event.recoveryOutcome === 'exhausted' ? '恢复耗尽' : '';
    return `#${event.sequence} 第${event.round}轮 描述阶段 · ↳ 手动恢复 ${displayAgent(event.agentId, event.agentName)} #${event.manualResumeIndex}（剩余 ${event.manualRetriesRemaining} 次）${outcome}`;
  }
  if (event.eventType === 'prompt_provenance') {
    return `#${event.sequence} 第${event.round}轮 · 溯源 ${displayAgent(event.agentId)} ${event.task} ${event.promptTemplateVersion} hash=${event.promptHash.slice(0, 12)}（公开 ${event.publicDescriptionCount}，同轮 ${event.sameRoundPublicDescriptionCount}）`;
  }
  const icon = event.outcome === 'success' ? '✓' : event.outcome === 'fallback' ? '↳' : '✗';
  const actor = displayAgent(event.agentId, event.agentName);
  const error = event.errorType ? ` ${errorLabel(event.errorType)} errorType=${event.errorType}${event.httpStatus ? ` HTTP=${event.httpStatus}` : ''}` : '';
  const injected = event.injectedFault ? ' [INJECTED FAULT]' : '';
  const retry = event.willRetry ? ' → 自动重试' : '';
  return `#${event.sequence} 第${event.round}轮 ${phaseLabel(event.phase)} · ${icon} ${actor} ${event.task} #${event.attempt}${error}${injected} ${event.latencyMs}ms${retry}`;
}

/**
 * 按 sequence 回放单局关键决策链。
 * 回放聚焦公开状态推进、模型成功/失败、自动重试和手动恢复；Prompt provenance 被刻意省略，避免回放变成 Prompt 泄漏渠道。
 */
export function replayTrace(
  events: readonly RuntimeTraceEvent[],
  gameId: string,
  options: { groupVoteBatches?: boolean } = {},
): string {
  const selected = events
    .filter((event) => event.gameId === gameId)
    .sort((left, right) => left.sequence - right.sequence);
  const lines = options.groupVoteBatches ? formatGroupedVoteReplay(selected) : selected.flatMap(formatReplayEvent);
  return lines.length === 0 ? `未找到对局 ${gameId} 的 trace。` : lines.join('\n');
}

export function errorLabel(errorType: ModelErrorType): string {
  const labels: Record<ModelErrorType, string> = {
    timeout: '请求超时',
    rate_limit: 'API 请求被限流',
    provider_5xx: '模型服务端异常',
    http_non_retryable: '不可重试的 HTTP 错误',
    invalid_json: '模型返回了无法解析的 JSON',
    schema_validation: '返回结构不符合 Schema',
    network: '网络请求异常',
    secret: '内容包含禁止公开信息',
    unknown: '未分类模型错误',
  };
  return labels[errorType];
}

export function displayAgent(agentId: string, agentName?: string): string {
  return agentName ? `${agentName}（${agentId}）` : agentId;
}

function formatReplayEvent(event: RuntimeTraceEvent): string[] {
  if (event.eventType === 'public_event') {
    if (event.publicEventType === 'description') {
      return [`→ 公开 description${event.agentId ? `：${displayAgent(event.agentId, event.agentName)}` : ''}`];
    }
    if (event.publicEventType === 'system' && event.phase === 'voting') return ['→ 描述完成，进入投票'];
    if (event.publicEventType === 'vote_result') return ['→ 投票平票，进入加票'];
    if (event.publicEventType === 'elimination') return [`→ 淘汰：${displayAgent(event.agentId ?? 'unknown', event.agentName)}`];
    if (event.publicEventType === 'system' && event.phase === 'describing') return [`→ 进入第${event.round}轮描述`];
    return [];
  }
  if (event.eventType === 'recovery_action') {
    const outcome = event.recoveryOutcome === 'recovered' ? '，恢复成功' : event.recoveryOutcome === 'exhausted' ? '，恢复耗尽' : '';
    return [
      `↳ 手动恢复 ${displayAgent(event.agentId, event.agentName)} #${event.manualResumeIndex}（剩余 ${event.manualRetriesRemaining} 次）${outcome}`,
    ];
  }
  if (event.eventType === 'prompt_provenance') return [];
  if (event.eventType === 'quality_violation' || event.eventType === 'trace_run' || event.eventType === 'vote') return [];
  if (event.outcome === 'success') {
    if (event.task === 'vote' && !hasNearbyFailure(event)) return [];
    const suffix = event.task === 'vote' ? '成功（私有候选，等待整批结算）' : '成功';
    return [`✓ ${displayAgent(event.agentId, event.agentName)} ${event.task} #${event.attempt} ${suffix}`];
  }
  if (event.outcome === 'fallback') {
    return ['↳ review 失败，使用 local fallback'];
  }
  const details = [
    `✗ ${displayAgent(event.agentId, event.agentName)} ${event.task} #${event.attempt}`,
    `  错误：${event.errorType ? errorLabel(event.errorType) : '未知错误'}`,
    `  errorType: ${event.errorType ?? 'unknown'}${event.httpStatus ? `, HTTP: ${event.httpStatus}` : ''}`,
  ];
  details.push(event.willRetry ? '  → 自动重试' : '  → 重试耗尽 / 明确中止');
  return details;
}

function hasNearbyFailure(_event: ModelCallTraceEvent): boolean {
  return true;
}

function formatGroupedVoteReplay(events: RuntimeTraceEvent[]): string[] {
  const lines: string[] = [];
  let voteBatch = 0;
  let pendingDiscard = false;
  let seenVoteAgents = new Set<string>();
  for (const event of events) {
    if (event.eventType === 'public_event') {
      if (event.publicEventType === 'elimination' && voteBatch > 0) {
        if (pendingDiscard) {
          lines.push('→ 本批存在最终失败，整批 private candidates discard，未提交 GameState');
          pendingDiscard = false;
        }
        lines.push('→ 本批 AI votes 全部成功，连同 Human vote 正式提交并结算');
      }
      lines.push(...formatReplayEvent(event));
      continue;
    }
    if (event.eventType === 'recovery_action') {
      lines.push(...formatReplayEvent(event));
      continue;
    }
    if (event.eventType === 'prompt_provenance') continue;
    if (event.eventType !== 'model_call') continue;
    if (event.task === 'vote' && voteBatch === 0) {
      voteBatch += 1;
      lines.push('【第一次 ballot batch：私有预生成】');
    } else if (event.task === 'vote' && pendingDiscard && event.attempt === 1 && seenVoteAgents.has(event.agentId)) {
      lines.push('→ 本批存在最终失败，整批 private candidates discard，未提交 GameState');
      voteBatch += 1;
      pendingDiscard = false;
      seenVoteAgents = new Set<string>();
      lines.push('【重新尝试后的第二次 batch：私有预生成】');
    }
    lines.push(...formatReplayEvent(event));
    if (event.task === 'vote' && event.outcome === 'failure' && !event.willRetry) {
      pendingDiscard = true;
    }
    if (event.task === 'vote') seenVoteAgents.add(event.agentId);
  }
  if (pendingDiscard) lines.push('→ 本批存在最终失败，整批 private candidates discard，未提交 GameState');
  return lines;
}

function phaseLabel(phase: string): string {
  const labels: Record<string, string> = {
    describing: '描述阶段',
    voting: '投票阶段',
    finished: '终局',
    model: '模型调用',
  };
  return labels[phase] ?? phase;
}

function publicEventLabel(type: string): string {
  const labels: Record<string, string> = {
    description: '公开描述',
    system: '阶段提示',
    vote_result: '投票结果',
    elimination: '淘汰',
  };
  return labels[type] ?? type;
}

/**
 * 容错读取 JSONL trace：逐行解析并只保留满足基础事件形状的记录。
 * 文件不存在或单行损坏不会阻断服务启动；返回结果供持久化 sink 续接 sequence。
 */
export function readJsonlTrace(filePath: string): RuntimeTraceEvent[] {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as RuntimeTraceEvent];
      } catch {
        return [];
      }
    });
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
