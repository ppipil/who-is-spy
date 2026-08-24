import { RefreshCw } from 'lucide-react';
import type { TraceFilters, TraceRunRow } from './traceTypes';
import { formatDuration } from './traceTree';

interface Props {
  runs: TraceRunRow[];
  selectedRunId: string | null;
  filters: TraceFilters;
  loading: boolean;
  onFilters: (filters: TraceFilters) => void;
  onRefresh: () => void;
  onSelect: (runId: string) => void;
}

export function RunExplorer({ runs, selectedRunId, filters, loading, onFilters, onRefresh, onSelect }: Props) {
  return (
    <aside className="trace-run-explorer">
      <div className="trace-panel-title">
        <div>
          <span>运行列表</span>
          <strong>{runs.length} 次运行</strong>
        </div>
        <button className="admin-icon-button" onClick={onRefresh} disabled={loading} title="刷新追踪">
          <RefreshCw size={15} className={loading ? 'spin' : ''} />
        </button>
      </div>
      <div className="trace-filters">
        <Filter label="ID（运行/对局）" value={filters.id} onChange={(id) => onFilters({ ...filters, id })} />
        <SourceFilter value={filters.sourceType} onChange={(sourceType) => onFilters({ ...filters, sourceType })} />
      </div>
      <div className="trace-run-list">
        {runs.map((run) => (
          <button key={run.runId} className={run.runId === selectedRunId ? 'is-selected' : ''} onClick={() => onSelect(run.runId)}>
            <span className={`trace-badge ${run.status}`}>{statusLabel(run.status)}</span>
            <strong>{run.runId.slice(0, 12)}</strong>
            <small>{sourceLabel(run.sourceType)} · {formatDuration(run.durationMs)}</small>
            {run.scenario && <small>{run.scenario} · {run.faultType ?? 'fault'} · {run.scenarioOutcome ?? 'running'}</small>}
          </button>
        ))}
        {runs.length === 0 && <p className="admin-empty">暂无追踪运行。先开一局游戏，然后刷新。</p>}
      </div>
    </aside>
  );
}

function statusLabel(status: TraceRunRow['status']): string {
  if (status === 'running') return '未结束';
  if (status === 'completed') return '已完成';
  if (status === 'failed') return '失败';
  if (status === 'stale') return '旧记录未关闭';
  return status;
}

function sourceLabel(sourceType: string): string {
  if (sourceType === 'USER_GAME') return '网页对局';
  if (sourceType === 'EVAL_RUN') return '评测来源';
  if (sourceType === 'FAULT_RUN') return '故障演示';
  return '终端脚本';
}

function SourceFilter({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <label>
      <span>来源</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">全部来源</option>
        <option value="USER_GAME">网页对局</option>
        <option value="EVAL_RUN">评测来源</option>
        <option value="FAULT_RUN">故障演示</option>
        <option value="TERMINAL_SCRIPT">终端脚本</option>
      </select>
    </label>
  );
}

function Filter({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label>
      <span>{label}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}
