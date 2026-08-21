/**
 * 运行时 Trace（可观测性）
 *
 * 统一收集模型调用、公开事件、恢复动作、prompt 溯源与质量违例，
 * 支持内存/控制台/JSONL/复合四种 sink，并可将单局事件重放为可读文本。
 * 评测通过 runId 关联：admin 后台可按 run 过滤查看整次评测的事件链。
 */
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

export type ModelTask = 'describe' | 'vote' | 'review';

/** 模型错误分类：用于 trace 展示与重试判定。 */
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

/** 模型调用诊断信息：错误类型、HTTP 状态、是否可重试、第几次尝试。 */
export interface ModelDiagnostic {
  errorType: ModelErrorType;
  httpStatus?: number;
  retryable: boolean;
  attempt: number;
}

export type TraceOutcome = 'success' | 'failure' | 'fallback';

/** 运行来源：真实游玩 / Admin 实验台 / 评测 / 控制台脚本 / 测试。 */
export type TraceSourceType = 'USER_GAME' | 'ADMIN_PROBE' | 'EVAL_RUN' | 'CLI_DEMO' | 'TEST';
/** 触发入口：Web / Admin / CLI / 测试。 */
export type TraceEntrypoint = 'web' | 'admin' | 'cli' | 'test';
/** 模型类型：真实 / 假模型 / 无模型调用。 */
export type TraceModelKind = 'real' | 'fake' | 'none';

/** 统一来源标记：所有 runtime trace 事件与 prompt 记录都携带。 */
export interface TraceOrigin {
  sourceType: TraceSourceType;
  entrypoint: TraceEntrypoint;
  modelKind: TraceModelKind;
}

/** 模型调用事件：一次 describe/vote/review 尝试的完整记录。 */
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
  sourceType?: TraceSourceType;
  entrypoint?: TraceEntrypoint;
  modelKind?: TraceModelKind;
}

/** 公开事件：描述发布、阶段切换、淘汰、平票等对局内公开内容。 */
export interface PublicRuntimeTraceEvent {
  eventType: 'public_event';
  timestamp: string;
  sequence: number;
  gameId: string;
  round: number;
  phase: string;
  ballot?: number;
  publicEventType: string;
  text?: string;
  agentId?: string;
  agentName?: string;
  outcome: TraceOutcome;
  sourceType?: TraceSourceType;
  entrypoint?: TraceEntrypoint;
  modelKind?: TraceModelKind;
}

/** 恢复动作：描述生成失败后的手动恢复（开始/成功/耗尽）。 */
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
}

/** prompt 溯源：记录实际发送的 prompt 版本、hash 与公开上下文规模。 */
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
}

/** 质量违例：AI 描述被服务端质量门禁拒绝的事件（含是否重试）。 */
export interface QualityViolationTraceEvent {
  eventType: 'quality_violation';
  timestamp: string;
  sequence: number;
  gameId: string;
  round: number;
  agentId: string;
  strategyId?: string;
  attempt: number;
  violationType: string;
  willRetry: boolean;
  sourceType?: TraceSourceType;
  entrypoint?: TraceEntrypoint;
  modelKind?: TraceModelKind;
}

/** 全部 trace 事件类型；draft 为未打时间戳/序号前的输入形态。 */
export type RuntimeTraceEvent =
  | ModelCallTraceEvent
  | PublicRuntimeTraceEvent
  | RecoveryActionTraceEvent
  | PromptProvenanceTraceEvent
  | QualityViolationTraceEvent;
export type RuntimeTraceDraft =
  | Omit<ModelCallTraceEvent, 'timestamp' | 'sequence'>
  | Omit<PublicRuntimeTraceEvent, 'timestamp' | 'sequence'>
  | Omit<RecoveryActionTraceEvent, 'timestamp' | 'sequence'>
  | Omit<PromptProvenanceTraceEvent, 'timestamp' | 'sequence'>
  | Omit<QualityViolationTraceEvent, 'timestamp' | 'sequence'>;

export interface TraceSink {
  record(event: RuntimeTraceDraft): void;
}

/** 包装 sink：给途经的所有事件统一打来源标记（在采集边界 stamp，不改业务逻辑）。 */
export function stampTraceOrigin(sink: TraceSink, origin: TraceOrigin): TraceSink {
  return {
    record: (event) => {
      sink.record({
        ...event,
        sourceType: origin.sourceType,
        entrypoint: origin.entrypoint,
        modelKind: origin.modelKind,
      } as unknown as RuntimeTraceDraft);
    },
  };
}

/** Admin 默认历史文件（启用 admin 且未显式配置 M5_TRACE_JSONL 时使用）。 */
export const DEFAULT_ADMIN_TRACE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../traces/runtime-trace.jsonl',
);

/** 内存 sink：admin 后台查询用，按序追加并自动编号；可预填历史并外发完整事件。 */
export class InMemoryTraceSink implements TraceSink {
  readonly events: RuntimeTraceEvent[] = [];
  private sequence = 0;

  constructor(
    initialEvents: RuntimeTraceEvent[] = [],
    private readonly onRecorded?: (event: RuntimeTraceEvent) => void,
  ) {
    if (initialEvents.length > 0) {
      this.events.push(...initialEvents);
      this.sequence = Math.max(
        ...initialEvents.map((event) => (Number.isFinite(event.sequence) ? Number(event.sequence) : 0)),
        0,
      );
    }
  }

  record(event: RuntimeTraceDraft): void {
    const full = { ...event, timestamp: new Date().toISOString(), sequence: ++this.sequence } as RuntimeTraceEvent;
    this.events.push(full);
    this.onRecorded?.(full);
  }
}

/** 控制台 sink：把事件格式化为一行人类可读文本输出到 stderr。 */
export class ConsoleTraceSink implements TraceSink {
  private sequence = 0;

  record(event: RuntimeTraceDraft): void {
    const full = { ...event, timestamp: new Date().toISOString(), sequence: ++this.sequence } as RuntimeTraceEvent;
    this.recordFull(full);
  }

  recordFull(event: RuntimeTraceEvent): void {
    console.error(formatTraceLine(event));
  }
}

/** JSONL sink：追加写入指定文件，每行一个完整事件。 */
export class JsonlTraceSink implements TraceSink {
  private sequence = 0;

  constructor(readonly filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  record(event: RuntimeTraceDraft): void {
    const full = { ...event, timestamp: new Date().toISOString(), sequence: ++this.sequence } as RuntimeTraceEvent;
    this.recordFull(full);
  }

  /** 写入已编号的完整事件（用于与内存 sink 共用同一 sequence 的持久化链路）。 */
  recordFull(event: RuntimeTraceEvent): void {
    fs.appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, 'utf8');
  }
}

/** 复合 sink：同一事件同时写入多个下游。 */
export class CompositeTraceSink implements TraceSink {
  constructor(private readonly sinks: readonly TraceSink[]) {}

  record(event: RuntimeTraceDraft): void {
    for (const sink of this.sinks) sink.record(event);
  }
}

/** 按环境变量装配 sink：M5_TRACE_CONSOLE=1 启用控制台，M5_TRACE_JSONL 指定文件。 */
export function createTraceSinkFromEnv(): TraceSink | undefined {
  const sinks: TraceSink[] = [];
  if (process.env.M5_TRACE_CONSOLE === '1') sinks.push(new ConsoleTraceSink());
  const jsonlPath = process.env.M5_TRACE_JSONL;
  if (jsonlPath) sinks.push(new JsonlTraceSink(jsonlPath));
  return sinks.length === 0 ? undefined : new CompositeTraceSink(sinks);
}

/** 测量一次异步操作耗时（毫秒，4 位小数）。 */
export async function measureLatency<T>(operation: () => Promise<T>): Promise<{ result: T; latencyMs: number }> {
  const startedAt = performance.now();
  const result = await operation();
  return { result, latencyMs: round(performance.now() - startedAt) };
}

/** 把单条事件格式化为人类可读的一行（控制台 sink 与 CLI 使用）。 */
export function formatTraceLine(event: RuntimeTraceEvent): string {
  if (event.eventType === 'public_event') {
    return `#${event.sequence} 第${event.round}轮 ${phaseLabel(event.phase)} · 公开事件 ${publicEventLabel(event.publicEventType)}`;
  }
  if (event.eventType === 'recovery_action') {
    const outcome = event.recoveryOutcome === 'recovered' ? '恢复成功' : event.recoveryOutcome === 'exhausted' ? '恢复耗尽' : '';
    return `#${event.sequence} 第${event.round}轮 描述阶段 · ↳ 手动恢复 ${displayAgent(event.agentId, event.agentName)} #${event.manualResumeIndex}（剩余 ${event.manualRetriesRemaining} 次）${outcome}`;
  }
  if (event.eventType === 'prompt_provenance') {
    return `#${event.sequence} 第${event.round}轮 · 溯源 ${displayAgent(event.agentId)} ${event.task} ${event.promptTemplateVersion} hash=${event.promptHash.slice(0, 12)}（公开 ${event.publicDescriptionCount}，同轮 ${event.sameRoundPublicDescriptionCount}）`;
  }
  if (event.eventType === 'quality_violation') {
    return `#${event.sequence} 第${event.round}轮 描述阶段 · 质量门禁 ${displayAgent(event.agentId)} ${event.violationType} #${event.attempt}${event.willRetry ? ' → 修复重试' : ' → 中止'}`;
  }
  const icon = event.outcome === 'success' ? '✓' : event.outcome === 'fallback' ? '↳' : '✗';
  const actor = displayAgent(event.agentId, event.agentName);
  const error = event.errorType ? ` ${errorLabel(event.errorType)} errorType=${event.errorType}${event.httpStatus ? ` HTTP=${event.httpStatus}` : ''}` : '';
  const retry = event.willRetry ? ' → 自动重试' : '';
  return `#${event.sequence} 第${event.round}轮 ${phaseLabel(event.phase)} · ${icon} ${actor} ${event.task} #${event.attempt}${error} ${event.latencyMs}ms${retry}`;
}

/**
 * 回放指定对局的 trace：按事件序号排序后转为可读文本行。
 * groupVoteBatches=true 时按投票批次分组展示（区分私有预生成与整批结算）。
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

/** 错误类型 → 中文标签。 */
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

/** agent 展示名：有中文名时带 id 显示，否则只显示 id。 */
export function displayAgent(agentId: string, agentName?: string): string {
  return agentName ? `${agentName}（${agentId}）` : agentId;
}

/** 单条事件 → 回放文本行（公开事件映射为简短流程描述，失败事件带错误详情）。 */
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
  if (event.eventType === 'quality_violation') {
    return [
      `→ 质量门禁：${event.violationType}（${event.agentId} #${event.attempt}）${event.willRetry ? '，修复重试' : '，中止'}`,
    ];
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

/** 保留位：判断成功投票附近是否有失败（当前固定为 true，避免冗长输出）。 */
function hasNearbyFailure(_event: ModelCallTraceEvent): boolean {
  return true;
}

/** 按投票批次分组回放：标出每一批私有预生成、整批丢弃与整批结算。 */
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
    if (event.eventType === 'quality_violation') {
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

/** 阶段 → 中文标签。 */
function phaseLabel(phase: string): string {
  const labels: Record<string, string> = {
    describing: '描述阶段',
    voting: '投票阶段',
    finished: '终局',
    model: '模型调用',
  };
  return labels[phase] ?? phase;
}

/** 公开事件类型 → 中文标签。 */
function publicEventLabel(type: string): string {
  const labels: Record<string, string> = {
    description: '公开描述',
    system: '阶段提示',
    vote_result: '投票结果',
    elimination: '淘汰',
  };
  return labels[type] ?? type;
}

/** 读取 JSONL trace 文件为事件数组。 */
export function readJsonlTrace(filePath: string): RuntimeTraceEvent[] {
  if (!fs.existsSync(filePath)) return [];
  const events: RuntimeTraceEvent[] = [];
  let skipped = 0;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as RuntimeTraceEvent);
    } catch {
      skipped += 1;
    }
  }
  if (skipped > 0) {
    console.warn(`[trace] 跳过 ${skipped} 条损坏的 JSONL 行（${filePath}）`);
  }
  return events;
}

/** 四舍五入到 4 位小数。 */
function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
