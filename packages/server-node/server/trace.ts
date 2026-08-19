import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

export type ModelTask = 'describe' | 'vote' | 'review';

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
}

export type RuntimeTraceEvent = ModelCallTraceEvent | PublicRuntimeTraceEvent;
export type RuntimeTraceDraft =
  | Omit<ModelCallTraceEvent, 'timestamp' | 'sequence'>
  | Omit<PublicRuntimeTraceEvent, 'timestamp' | 'sequence'>;

export interface TraceSink {
  record(event: RuntimeTraceDraft): void;
}

export class InMemoryTraceSink implements TraceSink {
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

export class CompositeTraceSink implements TraceSink {
  constructor(private readonly sinks: readonly TraceSink[]) {}

  record(event: RuntimeTraceDraft): void {
    for (const sink of this.sinks) sink.record(event);
  }
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
  if (event.eventType === 'public_event') {
    return `#${event.sequence} 第${event.round}轮 ${phaseLabel(event.phase)} · 公开事件 ${publicEventLabel(event.publicEventType)}`;
  }
  const icon = event.outcome === 'success' ? '✓' : event.outcome === 'fallback' ? '↳' : '✗';
  const actor = displayAgent(event.agentId, event.agentName);
  const error = event.errorType ? ` ${errorLabel(event.errorType)} errorType=${event.errorType}${event.httpStatus ? ` HTTP=${event.httpStatus}` : ''}` : '';
  const retry = event.willRetry ? ' → 自动重试' : '';
  return `#${event.sequence} 第${event.round}轮 ${phaseLabel(event.phase)} · ${icon} ${actor} ${event.task} #${event.attempt}${error} ${event.latencyMs}ms${retry}`;
}

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

export function readJsonlTrace(filePath: string): RuntimeTraceEvent[] {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RuntimeTraceEvent);
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
