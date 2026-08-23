import type { TimelineNode } from './traceTypes';

export function TraceInspector({ node }: { node: TimelineNode | null }) {
  if (!node) return <aside className="trace-inspector"><p className="admin-empty">Select a timeline node.</p></aside>;
  const event = node.events[0];
  return (
    <aside className="trace-inspector">
      <div className="trace-panel-title">
        <div>
          <span>Inspector</span>
          <strong>{node.title}</strong>
        </div>
        <span className={`trace-badge ${node.status}`}>{node.status}</span>
      </div>
      <section>
        <h3>Metadata</h3>
        <dl>{node.meta.map((item) => <Row key={item.label} label={item.label} value={item.value} />)}</dl>
      </section>
      {event && <EventSection event={event} />}
      {node.prompt && <PromptSection node={node} />}
      {!node.prompt && node.kind === 'model' && <p className="admin-empty">No prompt payload captured for this call.</p>}
    </aside>
  );
}

function EventSection({ event }: { event: Record<string, unknown> }) {
  return (
    <section>
      <h3>Event</h3>
      <dl>
        <Row label="gameId" value={String(event.gameId ?? '-')} />
        <Row label="runId" value={String(event.runId ?? event.gameId ?? '-')} />
        <Row label="round" value={String(event.round ?? '-')} />
        <Row label="sequence" value={String(event.sequence ?? '-')} />
      </dl>
      {typeof event.reason === 'string' && <TextBlock title="Vote Reason" value={event.reason} />}
      {typeof event.text === 'string' && <TextBlock title="Output" value={event.text} />}
      {typeof event.errorType === 'string' && <TextBlock title="Error" value={event.errorType} />}
    </section>
  );
}

function PromptSection({ node }: { node: TimelineNode }) {
  const user = node.prompt?.messages.find((message) => message.role === 'user');
  const system = node.prompt?.messages.find((message) => message.role === 'system');
  return (
    <section>
      <h3>Prompt / Context</h3>
      <dl>
        <Row label="version" value={node.prompt?.promptTemplateVersion ?? '-'} />
        <Row label="hash" value={node.prompt?.promptHash.slice(0, 16) ?? '-'} />
        <Row label="public" value={String(node.prompt?.publicDescriptionCount ?? 0)} />
        <Row label="same round" value={String(node.prompt?.sameRoundPublicDescriptionCount ?? 0)} />
      </dl>
      {system && <TextBlock title="System" value={system.content} />}
      {user && <TextBlock title="Sanitized Context" value={prettyJson(user.content)} />}
    </section>
  );
}

function TextBlock({ title, value }: { title: string; value: string }) {
  return (
    <details className="trace-text-block" open={title !== 'System'}>
      <summary>{title}</summary>
      <pre>{value}</pre>
    </details>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value || '-'}</dd>
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
