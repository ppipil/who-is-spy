import type { PromptTraceRecord, RuntimeEvent, TimelineNode, TraceRunRow, TimelineStatus } from './traceTypes';

const AGENT_NAMES: Record<string, string> = { human: '你', 'ai-1': '阿序', 'ai-2': '弥生', 'ai-3': '老墨', 'ai-4': '小满', review: '复盘' };
const SOURCE_FALLBACK = 'UNKNOWN';

export function labelAgent(id: unknown): string {
  const key = String(id ?? '');
  return AGENT_NAMES[key] ?? (key || 'unknown');
}

export function formatDuration(ms: number | undefined): string {
  if (!ms) return '-';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

export function buildTraceRuns(events: RuntimeEvent[]): TraceRunRow[] {
  const grouped = new Map<string, RuntimeEvent[]>();
  for (const event of events) {
    const key = event.runId || event.gameId;
    grouped.set(key, [...(grouped.get(key) ?? []), event]);
  }
  return [...grouped.entries()].map(([runId, list]) => buildRun(runId, list)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function buildRun(runId: string, events: RuntimeEvent[]): TraceRunRow {
  const sorted = sortEvents(events);
  const lifecycle = [...sorted].reverse().find((event) => event.eventType === 'trace_run');
  const times = sorted.map((event) => Date.parse(event.timestamp)).filter(Number.isFinite).sort((a, b) => a - b);
  return {
    runId,
    gameId: String(lifecycle?.gameId ?? sorted.find((event) => event.gameId)?.gameId ?? runId),
    sourceType: String(lifecycle?.sourceType ?? topValue(sorted.map((event) => event.sourceType)) ?? SOURCE_FALLBACK),
    status: normalizeStatus(lifecycle?.status, sorted, times),
    createdAt: String(lifecycle?.createdAt ?? (times[0] ? new Date(times[0]).toISOString() : new Date().toISOString())),
    modelKind: topValue(sorted.map((event) => event.modelKind)),
    durationMs: duration(sorted, times),
    fixtureWords: Array.isArray(lifecycle?.fixtureWords) ? lifecycle.fixtureWords.map(String) : undefined,
    events: sorted,
  };
}

function normalizeStatus(value: unknown, events: RuntimeEvent[], times: number[]): TraceRunRow['status'] {
  if (value === 'failed' || value === 'completed') return value;
  if (events.some((event) => event.eventType === 'public_event' && event.phase === 'finished')) return 'completed';
  if (value === 'running') {
    const last = times.at(-1) ?? 0;
    return Date.now() - last > 10 * 60 * 1000 ? 'stale' : 'running';
  }
  return 'stale';
}

function duration(events: RuntimeEvent[], times: number[]): number {
  const latency = events.reduce((sum, event) => sum + (Number(event.latencyMs) || 0), 0);
  if (latency > 0) return latency;
  return times.length > 1 ? times[times.length - 1] - times[0] : 0;
}

function topValue(values: unknown[]): string | undefined {
  const counts = new Map<string, number>();
  for (const value of values) if (typeof value === 'string' && value) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

export function buildTimeline(run: TraceRunRow, prompts: PromptTraceRecord[]): TimelineNode[] {
  return roundsFor(run.events).map((round) => roundNode(run, round, prompts));
}

function roundNode(run: TraceRunRow, round: number, prompts: PromptTraceRecord[]): TimelineNode {
  const events = run.events.filter((event) => Number(event.round) === round);
  const children = [...descriptionActions(events, prompts), voteAction(events, prompts), judgeAction(events, prompts), ...standaloneEvents(events)].filter(Boolean) as TimelineNode[];
  return node(`round-${run.runId}-${round}`, 'round', `第 ${round} 轮`, childStatus(children), [], children, events);
}

function descriptionActions(events: RuntimeEvent[], prompts: PromptTraceRecord[]): TimelineNode[] {
  return agents(events, 'describe').map((agentId) => {
    const related = events.filter((event) => event.agentId === agentId && relevantDescription(event));
    const children = related.flatMap((event) => eventToNodes(event, prompts));
    return node(`describe-${agentId}-${events[0]?.round}`, 'action', `${labelAgent(agentId)} · 描述`, childStatus(children), [], children, related);
  });
}

function voteAction(events: RuntimeEvent[], prompts: PromptTraceRecord[]): TimelineNode | null {
  const related = events.filter((event) => event.eventType === 'vote' || event.task === 'vote' || event.publicEventType === 'vote_result' || event.publicEventType === 'elimination');
  if (related.length === 0) return null;
  const children = related.flatMap((event) => eventToNodes(event, prompts));
  return node(`vote-${events[0]?.gameId}-${events[0]?.round}`, 'action', `第 ${events[0]?.round} 轮 · 投票`, childStatus(children), [], children, related);
}

function judgeAction(events: RuntimeEvent[], prompts: PromptTraceRecord[]): TimelineNode | null {
  const related = events.filter((event) => event.task === 'judge');
  if (related.length === 0) return null;
  const visible = related.filter((event) => event.eventType !== 'prompt_provenance');
  const children = visible.flatMap((event) => eventToNodes(event, prompts));
  return node(`judge-${events[0]?.gameId}-${events[0]?.round}`, 'action', 'AI Judge', childStatus(children), [], children, related);
}
function standaloneEvents(events: RuntimeEvent[]): TimelineNode[] {
  return events.filter((event) => event.eventType === 'recovery_action').map(recoveryNode);
}

function eventToNodes(event: RuntimeEvent, prompts: PromptTraceRecord[]): TimelineNode[] {
  if (event.eventType === 'model_call') return withRetry(modelNode(event, prompts), event);
  if (event.eventType === 'prompt_provenance') return [promptNode(event, prompts)];
  if (event.eventType === 'public_event') return [publicNode(event)];
  if (event.eventType === 'quality_violation') return [qualityNode(event)];
  if (event.eventType === 'vote') return [voteNode(event)];
  return [];
}

function withRetry(base: TimelineNode, event: RuntimeEvent): TimelineNode[] {
  if (event.outcome !== 'failure' || !event.willRetry) return [base];
  return [base, node(`retry-${event.sequence}`, 'retry', '已安排重试', 'warn', [{ label: '退避', value: '600ms' }], [], [event])];
}

function modelNode(event: RuntimeEvent, prompts: PromptTraceRecord[]): TimelineNode {
  const prompt = findPrompt(event, prompts);
  return node(`model-${event.sequence}`, 'model', `${labelAgent(event.agentId)} · ${taskLabel(event.task)}`, statusOf(event.outcome), modelMeta(event), prompt ? [promptNode(event, [prompt])] : [], [event], prompt);
}

function taskLabel(value: unknown): string {
  if (value === 'describe') return '描述';
  if (value === 'vote') return '投票';
  if (value === 'review') return '复盘';
  if (value === 'judge') return 'AI Judge';
  return String(value ?? '-').toUpperCase();
}

function outcomeLabel(value: unknown): string {
  if (value === 'success') return '成功';
  if (value === 'failure') return '失败';
  if (value === 'fallback') return '兜底';
  return String(value ?? '-');
}

function modelMeta(event: RuntimeEvent) {
  return [
    { label: '尝试', value: String(event.attempt ?? 1) },
    { label: '延迟', value: formatDuration(Number(event.latencyMs)) },
    { label: '结果', value: outcomeLabel(event.outcome) },
    ...(event.errorType ? [{ label: '错误', value: String(event.errorType) }] : []),
  ];
}

function promptNode(event: RuntimeEvent, prompts: PromptTraceRecord[]): TimelineNode {
  const prompt = findPrompt(event, prompts);
  return node(`prompt-${event.sequence}`, 'prompt', `提示词 ${String(event.promptTemplateVersion ?? prompt?.promptTemplateVersion ?? '')}`, 'neutral', [{ label: '哈希', value: String(event.promptHash ?? prompt?.promptHash ?? '').slice(0, 12) }], [], [event], prompt);
}

function publicNode(event: RuntimeEvent): TimelineNode {
  const title = publicEventTitle(event);
  const meta = publicEventMeta(event);
  return node(`public-${event.sequence}`, 'public', title, 'ok', meta, [], [event]);
}

function publicEventTitle(event: RuntimeEvent): string {
  if (event.publicEventType === 'description') return `${labelAgent(event.agentId)} 已提交描述`;
  if (event.publicEventType === 'elimination') return `${labelAgent(event.agentId)} 被淘汰`;
  if (event.publicEventType === 'vote_result') return '投票结果 / 平票加投';
  if (event.publicEventType === 'system' && event.phase === 'voting') return '描述完成 · 进入投票';
  if (event.publicEventType === 'system' && event.phase === 'describing') return `第 ${event.round} 轮开始`;
  return String(event.publicEventType ?? '公开事件');
}

function publicEventMeta(event: RuntimeEvent): TimelineNode['meta'] {
  return [
    ...(event.agentId ? [{ label: '玩家', value: labelAgent(event.agentId) }] : []),
    ...(event.text ? [{ label: '文本', value: String(event.text) }] : []),
  ];
}

function qualityNode(event: RuntimeEvent): TimelineNode {
  return node(`quality-${event.sequence}`, 'quality', '质量门', 'fail', [{ label: '类型', value: String(event.violationType ?? '-') }, { label: '重试', value: event.willRetry ? '是' : '否' }], [], [event]);
}

function voteNode(event: RuntimeEvent): TimelineNode {
  return node(`vote-${event.sequence}`, 'vote', `${labelAgent(event.agentId)} -> ${labelAgent(event.targetId)}`, 'ok', [{ label: '理由', value: String(event.reason ?? '') }], [], [event]);
}

function recoveryNode(event: RuntimeEvent): TimelineNode {
  const status = event.recoveryOutcome === 'exhausted' ? 'fail' : event.recoveryOutcome === 'recovered' ? 'ok' : 'warn';
  return node(`recovery-${event.sequence}`, 'recovery', `恢复 · ${labelAgent(event.agentId)}`, status, [{ label: '剩余', value: String(event.manualRetriesRemaining ?? 0) }], [], [event]);
}

function findPrompt(event: RuntimeEvent, prompts: PromptTraceRecord[]): PromptTraceRecord | undefined {
  return prompts.find((prompt) => prompt.gameId === event.gameId && prompt.round === event.round && prompt.agentId === event.agentId && prompt.task === event.task);
}

function agents(events: RuntimeEvent[], task: string): string[] {
  return [...new Set(events.filter((event) => event.task === task || relevantDescription(event)).map((event) => String(event.agentId ?? '')).filter(Boolean))];
}

function relevantDescription(event: RuntimeEvent): boolean {
  return event.task === 'describe' || event.eventType === 'quality_violation' || (event.eventType === 'public_event' && event.publicEventType === 'description');
}

function roundsFor(events: RuntimeEvent[]): number[] {
  return [...new Set(events.map((event) => Number(event.round)).filter((round) => round > 0))].sort((a, b) => a - b);
}

function sortEvents(events: RuntimeEvent[]): RuntimeEvent[] {
  return [...events].sort((a, b) => Number(a.sequence) - Number(b.sequence) || a.timestamp.localeCompare(b.timestamp));
}

function childStatus(children: TimelineNode[]): TimelineStatus {
  if (children.some((child) => child.status === 'fail')) return 'fail';
  if (children.some((child) => child.status === 'warn')) return 'warn';
  return 'ok';
}

function statusOf(value: unknown): TimelineStatus {
  if (value === 'success') return 'ok';
  if (value === 'failure') return 'fail';
  if (value === 'fallback') return 'warn';
  return 'neutral';
}

function node(id: string, kind: TimelineNode['kind'], title: string, status: TimelineStatus, meta: TimelineNode['meta'], children: TimelineNode[], events: RuntimeEvent[], prompt?: PromptTraceRecord): TimelineNode {
  const occurredAt = earliestTimestamp(events, prompt);
  return {
    id,
    kind,
    title,
    status,
    meta,
    ...(occurredAt ? { occurredAt } : {}),
    children,
    events,
    ...(prompt ? { prompt } : {}),
  };
}

function earliestTimestamp(events: RuntimeEvent[], prompt?: PromptTraceRecord): string | undefined {
  const timestamps = [...events.map((event) => event.timestamp), prompt?.timestamp]
    .filter((timestamp): timestamp is string => typeof timestamp === 'string' && Number.isFinite(Date.parse(timestamp)))
    .sort();
  return timestamps[0];
}
