import type { TimelineNode } from './traceTypes';

export function TraceInspector({ node }: { node: TimelineNode | null }) {
  if (!node) return <aside className="trace-inspector"><p className="admin-empty">请选择一个时间线节点。</p></aside>;
  const event = node.events[0];
  return (
    <aside className="trace-inspector">
      <div className="trace-panel-title">
        <div>
          <span>检查器</span>
          <strong>{node.title}</strong>
        </div>
        <span className={`trace-badge ${node.status}`}>{statusLabel(node.status)}</span>
      </div>
      <section>
        <h3>元数据</h3>
        <dl>{node.meta.map((item) => <Row key={item.label} label={item.label} value={item.value} />)}</dl>
      </section>
      {event && <EventSection event={event} />}
      {node.prompt && <PromptSection node={node} />}
      {!node.prompt && node.kind === 'model' && <p className="admin-empty">本次调用没有捕获到提示词内容。</p>}
    </aside>
  );
}

function statusLabel(status: TimelineNode['status']): string {
  if (status === 'ok') return '正常';
  if (status === 'fail') return '失败';
  if (status === 'warn') return '警告';
  return '中性';
}

function EventSection({ event }: { event: Record<string, unknown> }) {
  return (
    <section>
      <h3>事件</h3>
      <dl>
        <Row label="gameId" value={field(event.gameId)} />
        <Row label="runId" value={field(event.runId ?? event.gameId)} />
        <Row label="轮次" value={field(event.round)} />
        <Row label="序号" value={field(event.sequence)} />
        <Row label="时间" value={timeLabel(event.timestamp)} />
        <Row label="玩家/代理" value={field(event.agentName ?? event.agentId)} />
        <Row label="任务" value={field(event.task)} />
        <Row label="模型" value={field(event.model)} />
        <Row label="温度" value={field(event.temperature)} />
        <Row label="Prompt 版本" value={field(event.promptTemplateVersion)} />
        <Row label="尝试" value={field(event.attempt)} />
        <Row label="结果" value={field(event.outcome)} />
        <Row label="错误类型 errorType" value={field(event.errorType)} />
        <Row label="故障来源" value={event.injectedFault ? 'Fault Injection（人工模拟）' : '—'} />
        <Row label="重试" value={retryLabel(event)} />
        <Row label="延迟" value={latencyLabel(event.latencyMs)} />
        <Row label="恢复" value={recoveryLabel(event)} />
      </dl>
      {typeof event.inputSummary === 'string' && <TextBlock title="Judge 输入摘要" value={prettyJson(event.inputSummary)} />}
      {typeof event.output === 'string' && <TextBlock title="Judge 输出" value={prettyJson(event.output)} />}
      {typeof event.reason === 'string' && <TextBlock title="投票理由" value={event.reason} />}
      {typeof event.text === 'string' && <TextBlock title="输出" value={event.text} />}
      {typeof event.errorType === 'string' && <TextBlock title="失败原因" value={failureSummary(event)} />}
    </section>
  );
}
function PromptSection({ node }: { node: TimelineNode }) {
  const user = node.prompt?.messages.find((message) => message.role === 'user');
  const system = node.prompt?.messages.find((message) => message.role === 'system');
  return (
    <section>
      <h3>提示词 / 上下文</h3>
      <dl>
        <Row label="版本" value={node.prompt?.promptTemplateVersion ?? '-'} />
        <Row label="哈希" value={node.prompt?.promptHash.slice(0, 16) ?? '-'} />
        <Row label="公开数" value={String(node.prompt?.publicDescriptionCount ?? 0)} />
        <Row label="同轮" value={String(node.prompt?.sameRoundPublicDescriptionCount ?? 0)} />
      </dl>
      {system && <TextBlock title="系统" value={system.content} />}
      {user && <TextBlock title="已脱敏上下文" value={prettyJson(user.content)} />}
    </section>
  );
}

function field(value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  return String(value);
}

function retryLabel(event: Record<string, unknown>): string {
  if (event.willRetry === true) return '已安排';
  if (event.willRetry === false) return '否';
  return '—';
}

function timeLabel(value: unknown): string {
  if (typeof value !== 'string') return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], { hour12: false });
}

function latencyLabel(value: unknown): string {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function recoveryOutcomeLabel(value: string): string {
  if (value === 'recovered') return '已恢复';
  if (value === 'exhausted') return '已耗尽';
  return value;
}

function recoveryLabel(event: Record<string, unknown>): string {
  if (typeof event.recoveryOutcome === 'string') return recoveryOutcomeLabel(event.recoveryOutcome);
  if (event.eventType === 'recovery_action') return '等待中';
  return '—';
}

function failureSummary(event: Record<string, unknown>): string {
  const task = field(event.task);
  const agent = field(event.agentName ?? event.agentId);
  const attempt = field(event.attempt);
  const error = field(event.errorType);
  const retry = retryLabel(event);
  return `${agent} 的 ${task} 第 ${attempt} 次尝试失败，错误类型 ${error}。重试: ${retry}。`;
}
function TextBlock({ title, value }: { title: string; value: string }) {
  return (
    <details className="trace-text-block" open={title !== '系统'}>
      <summary>{title}</summary>
      <pre>{value}</pre>
    </details>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value || '—'}</dd>
    </>
  );
}

function prettyJson(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}
