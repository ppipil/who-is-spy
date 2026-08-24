import { useCallback, useEffect, useMemo, useState } from 'react';
import { traceApi } from './traceApi';
import { buildTimeline, buildTraceRuns } from './traceTree';
import { RunExplorer } from './RunExplorer';
import { TraceInspector } from './TraceInspector';
import { TraceTimeline } from './TraceTimeline';
import type { AdminStatus, PromptTraceRecord, RuntimeEvent, TimelineNode, TraceFilters, TraceRunRow } from './traceTypes';
import './trace.css';

const EMPTY_FILTERS: TraceFilters = { id: '', sourceType: '' };

export function TracePage({ initialRunId = '' }: { initialRunId?: string }) {
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [runs, setRuns] = useState<TraceRunRow[]>([]);
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [prompts, setPrompts] = useState<PromptTraceRecord[]>([]);
  const [filters, setFilters] = useState<TraceFilters>(() => ({ ...EMPTY_FILTERS, id: initialRunId }));
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<TimelineNode | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [nextStatus, runResult] = await Promise.all([traceApi.status(), traceApi.runs(filters)]);
      const nextRuns: TraceRunRow[] = runResult.runs.map((run) => ({
        ...run, status: staleStatus(run.status, run.createdAt), durationMs: 0, events: [],
      }));
      setStatus(nextStatus); setRuns(nextRuns);
      setSelectedRunId((current) => nextRuns.some((run) => run.runId === current) ? current : nextRuns[0]?.runId ?? null);
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : '加载追踪失败'); }
    finally { setLoading(false); }
  }, [filters]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!initialRunId) return;
    setFilters((current) => current.id === initialRunId ? current : { ...current, id: initialRunId });
  }, [initialRunId]);
  useEffect(() => {
    if (!selectedRunId) { setEvents([]); setPrompts([]); return; }
    setLoading(true);
    void Promise.all([
      traceApi.traces({ id: selectedRunId, sourceType: '' }),
      traceApi.promptTraces({ id: selectedRunId, sourceType: '' }),
    ]).then(([traceResult, promptResult]) => {
      setEvents(traceResult.events); setPrompts(promptResult.records);
    }).catch((loadError: unknown) => setError(loadError instanceof Error ? loadError.message : '加载追踪失败'))
      .finally(() => setLoading(false));
  }, [selectedRunId]);

  const selectedSummary = runs.find((run) => run.runId === selectedRunId) ?? null;
  const eventRun = useMemo(() => buildTraceRuns(events)[0] ?? null, [events]);
  const selectedRun = useMemo(() => selectedSummary ? { ...selectedSummary, durationMs: eventRun?.durationMs ?? 0, events } : null, [selectedSummary, eventRun, events]);
  const timeline = useMemo(() => selectedRun ? buildTimeline(selectedRun, prompts) : [], [selectedRun, prompts]);

  useEffect(() => {
    if (!selectedRun) return;
    setSelectedNode(null);
    setExpanded(selectedRun.sourceType === 'FAULT_RUN' ? defaultExpandedIds(timeline) : new Set());
  }, [selectedRun?.runId, timeline]);

  const toggle = (id: string) => setExpanded((current) => {
    const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next;
  });

  return <div className="trace-page">
    <header className="trace-header"><div><span>轻量管理台 Admin Lite</span><h1>追踪 Trace</h1></div>
      <div className="trace-status"><span>追踪: {status?.runtimeTrace ?? 'OFF'}</span><span>模型: {status?.model ?? '未知'}</span><span>{status?.configured ? '已配置 configured' : '未配置 not configured'}</span></div>
    </header>
    {error && <div className="admin-error">{error}</div>}
    <main className="trace-layout">
      <RunExplorer runs={runs} selectedRunId={selectedRun?.runId ?? null} filters={filters} loading={loading} onFilters={setFilters} onRefresh={load} onSelect={setSelectedRunId} />
      <TraceTimeline nodes={timeline} selectedId={selectedNode?.id ?? null} expanded={expanded} onToggle={toggle} onSelect={setSelectedNode} />
      <TraceInspector node={selectedNode} />
    </main>
  </div>;
}

function defaultExpandedIds(nodes: TimelineNode[]): Set<string> {
  const ids = new Set<string>();
  const visit = (node: TimelineNode) => { if (node.children.length) ids.add(node.id); for (const child of node.children) visit(child); };
  for (const node of nodes) visit(node);
  return ids;
}

function staleStatus(status: TraceRunRow['status'], createdAt: string): TraceRunRow['status'] {
  return status === 'running' && Date.now() - Date.parse(createdAt) > 10 * 60 * 1000 ? 'stale' : status;
}
