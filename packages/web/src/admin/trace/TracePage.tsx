import { useCallback, useEffect, useMemo, useState } from 'react';
import { traceApi } from './traceApi';
import { buildTimeline, buildTraceRuns } from './traceTree';
import { RunExplorer } from './RunExplorer';
import { TraceInspector } from './TraceInspector';
import { TraceTimeline } from './TraceTimeline';
import type { AdminStatus, PromptTraceRecord, RuntimeEvent, TimelineNode, TraceFilters } from './traceTypes';
import './trace.css';

const EMPTY_FILTERS: TraceFilters = { id: '', sourceType: '' };

export function TracePage() {
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [prompts, setPrompts] = useState<PromptTraceRecord[]>([]);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<TimelineNode | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [nextStatus, traceResult, promptResult] = await Promise.all([
        traceApi.status(),
        traceApi.traces(filters),
        traceApi.promptTraces(filters),
      ]);
      setStatus(nextStatus);
      setEvents(traceResult.events);
      setPrompts(promptResult.records);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载追踪失败');
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => { void load(); }, [load]);

  const runs = useMemo(() => buildTraceRuns(events), [events]);
  const selectedRun = runs.find((run) => run.runId === selectedRunId) ?? runs[0] ?? null;
  const timeline = useMemo(() => selectedRun ? buildTimeline(selectedRun, prompts) : [], [selectedRun, prompts]);

  useEffect(() => {
    if (!selectedRun) return;
    setSelectedRunId(selectedRun.runId);
    setSelectedNode(null);
  }, [selectedRun?.runId]);

  const toggle = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <div className="trace-page">
      <header className="trace-header">
        <div>
          <span>轻量管理台 Admin Lite</span>
          <h1>追踪 Trace</h1>
        </div>
        <div className="trace-status">
          <span>追踪: {status?.runtimeTrace ?? 'OFF'}</span>
          <span>模型: {status?.model ?? '未知'}</span>
          <span>{status?.configured ? '已配置 configured' : '未配置 not configured'}</span>
        </div>
      </header>
      {error && <div className="admin-error">{error}</div>}
      <main className="trace-layout">
        <RunExplorer runs={runs} selectedRunId={selectedRun?.runId ?? null} filters={filters} loading={loading} onFilters={setFilters} onRefresh={load} onSelect={setSelectedRunId} />
        <TraceTimeline nodes={timeline} selectedId={selectedNode?.id ?? null} expanded={expanded} onToggle={toggle} onSelect={setSelectedNode} />
        <TraceInspector node={selectedNode} />
      </main>
    </div>
  );
}

function defaultExpandedIds(nodes: TimelineNode[]): Set<string> {
  const ids = new Set<string>();
  for (const node of nodes) {
    ids.add(node.id);
    for (const child of node.children) ids.add(child.id);
  }
  return ids;
}
