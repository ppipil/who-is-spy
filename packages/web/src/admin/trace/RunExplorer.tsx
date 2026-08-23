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
          <span>Run Explorer</span>
          <strong>{runs.length} runs</strong>
        </div>
        <button className="admin-icon-button" onClick={onRefresh} disabled={loading} title="Refresh trace">
          <RefreshCw size={15} className={loading ? 'spin' : ''} />
        </button>
      </div>
      <div className="trace-filters">
        <Filter label="runId" value={filters.runId} onChange={(runId) => onFilters({ ...filters, runId })} />
        <Filter label="gameId" value={filters.gameId} onChange={(gameId) => onFilters({ ...filters, gameId })} />
        <Filter label="round" value={filters.round} onChange={(round) => onFilters({ ...filters, round })} />
        <Filter label="agent" value={filters.agent} onChange={(agent) => onFilters({ ...filters, agent })} />
      </div>
      <div className="trace-run-list">
        {runs.map((run) => (
          <button key={run.runId} className={run.runId === selectedRunId ? 'is-selected' : ''} onClick={() => onSelect(run.runId)}>
            <span className={`trace-badge ${run.status}`}>{run.status}</span>
            <strong>{run.runId.slice(0, 12)}</strong>
            <small>{run.sourceType} · {formatDuration(run.durationMs)}</small>
          </button>
        ))}
        {runs.length === 0 && <p className="admin-empty">No trace runs yet. Start a game, then refresh.</p>}
      </div>
    </aside>
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
