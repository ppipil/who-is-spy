import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  adminApi,
  FAULT_SCENARIOS,
  PERSONA_NAMES,
  PERSONA_SUMMARY,
  type AdminStatus,
  type EvaluationData,
  type EvaluationLiveMetrics,
  type EvaluationModelKind,
  type EvaluationRunDetail,
  type EvaluationRunSummary,
  type FaultStatus,
  type PromptTraceRecord,
  type RuntimeEvent,
  type ContextBuildResult,
  type PersonaProbeCase,
  type PersonaRunCase,
  type PersonaRunResult,
  type QualityGateEvidence,
  type QualityGateCheckResult,
  type SequentialAgentStep,
  type SequentialRunResult,
  type SameRoundDescription,
  type SameRoundEvidence,
  type Task1Evidence,
} from './adminApi';
import { EVENT_DEFS, METRIC_DEFS, PROMPT_FIELD_LABELS, type MetricDef } from './definitions';
import { TraceView } from './TraceView';
import {
  buildTraceSessions,
  MODEL_LABELS,
  sessionOrigin,
  SOURCE_LABELS,
  type TraceSession,
} from './traceTree';
import './admin.css';

type Tab = 'overview' | 'trace' | 'faults' | 'evaluation' | 'task1' | 'prompt';
type PromptFilters = { gameId: string; round: string; agentId: string; task: string };
type TraceFilters = { gameId: string; round: string; agent: string; task: string; errorType: string; runId: string };
const AUTO_REFRESH_MS = 300_000;

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'trace', label: 'Trace' },
  { id: 'faults', label: 'Fault Injection' },
  { id: 'evaluation', label: 'Evaluation' },
  { id: 'task1', label: 'Task ① 验收' },
  { id: 'prompt', label: 'Prompt Trace' },
];

export function AdminConsole() {
  const [tab, setTab] = useState<Tab>('overview');
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const [promptFilters, setPromptFilters] = useState<PromptFilters>({ gameId: '', round: '', agentId: '', task: '' });
  const [traceFilters, setTraceFilters] = useState<TraceFilters>({
    gameId: '',
    round: '',
    agent: '',
    task: '',
    errorType: '',
    runId: '',
  });
  const [traceSelection, setTraceSelection] = useState<{ gameId?: string; round?: string; agentId?: string } | null>(
    null,
  );

  const openPrompt = (filters: PromptFilters) => {
    setPromptFilters(filters);
    setTab('prompt');
  };

  const refreshStatus = useCallback(() => {
    adminApi
      .status()
      .then(setStatus)
      .catch((error: unknown) => setStatusError(error instanceof Error ? error.message : '无法读取状态'));
  }, []);

  useEffect(() => {
    refreshStatus();
    const timer = setInterval(refreshStatus, AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refreshStatus]);

  return (
    <main className="admin-shell">
      <div className="paper-noise" />
      <header className="admin-header">
        <div className="brand">
          <span className="brand-seal">潜</span>
          <span>Developer Console</span>
        </div>
        <div className="model-chip">
          <span className={`status-dot ${status?.configured ? 'online' : ''}`} />
          {status ? `${status.model} · ${status.configured ? '已就席' : '未配置'}` : '连接中…'}
        </div>
      </header>

      <nav className="admin-tabs" role="tablist">
        {TABS.map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={tab === item.id}
            className={`admin-tab ${tab === item.id ? 'is-active' : ''}`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <section className="admin-body">
        {/* 所有 Tab 面板保持挂载，切 Tab 只隐藏不销毁状态 */}
        <div style={{ display: tab === 'overview' ? undefined : 'none' }} aria-hidden={tab !== 'overview'}>
          <Overview status={status} statusError={statusError} onRetry={refreshStatus} />
        </div>
        <div style={{ display: tab === 'trace' ? undefined : 'none' }} aria-hidden={tab !== 'trace'}>
          <TraceView initialFilters={traceFilters} initialSelection={traceSelection} onOpenPrompt={openPrompt} />
        </div>
        <div style={{ display: tab === 'faults' ? undefined : 'none' }} aria-hidden={tab !== 'faults'}>
          <FaultPanel />
        </div>
        <div style={{ display: tab === 'evaluation' ? undefined : 'none' }} aria-hidden={tab !== 'evaluation'}>
          <EvaluationPanel
            status={status}
            onOpenTrace={(runId) => {
              setTraceFilters((previous) => ({ ...previous, runId }));
              setTab('trace');
            }}
            onOpenGameTrace={(gameId) => {
              setTraceSelection({ gameId });
              setTab('trace');
            }}
          />
        </div>
        <div style={{ display: tab === 'task1' ? undefined : 'none' }} aria-hidden={tab !== 'task1'}>
          <Task1AcceptancePanel
            onOpenPrompt={openPrompt}
            onOpenTraceStep={(gameId, round, agentId) => {
              setTraceSelection({ gameId, round: String(round), agentId });
              setTab('trace');
            }}
            status={status}
          />
        </div>
        <div style={{ display: tab === 'prompt' ? undefined : 'none' }} aria-hidden={tab !== 'prompt'}>
          <PromptTracePanel initialFilters={promptFilters} />
        </div>
      </section>
      <footer className="admin-footer">
        Demo-only developer surface · not production authentication / authorization
      </footer>
    </main>
  );
}

function Overview({
  status,
  statusError,
  onRetry,
}: {
  status: AdminStatus | null;
  statusError: string;
  onRetry: () => void;
}) {
  if (statusError && !status) {
    return (
      <div className="admin-empty">
        <p>无法连接 Admin API：{statusError}</p>
        <button className="admin-button" onClick={onRetry}>
          重试
        </button>
      </div>
    );
  }
  if (!status) {
    return (
      <div className="admin-skeleton-grid">
        {[0, 1, 2, 3].map((item) => (
          <div className="admin-card admin-skeleton" key={item} />
        ))}
      </div>
    );
  }
  return (
    <div className="admin-overview">
      <div className="admin-card-grid">
        <StatusCard def={METRIC_DEFS.model} value={status.model} sub={status.configured ? 'configured' : 'not configured'} />
        <StatusCard def={METRIC_DEFS.runtimeTrace} value={status.runtimeTrace} sub="M5 trace sink" />
        <StatusCard
          def={METRIC_DEFS.faultState}
          value={status.fault.state.toUpperCase()}
          tone={status.fault.state === 'armed' ? 'warn' : status.fault.state === 'triggered' ? 'ok' : 'neutral'}
          sub={status.fault.scenario ?? 'one-shot · auto-clear'}
        />
        <StatusCard def={METRIC_DEFS.activeGames} value={String(status.activeGames)} sub="in-memory GameEngine" />
      </div>
      <p className="admin-note">
        Overview 只展示当前进程的真实状态；对局数据保存在内存中，服务重启后清零。
      </p>
    </div>
  );
}

function StatusCard({
  def,
  value,
  sub,
  tone = 'neutral',
}: {
  def?: MetricDef;
  value: string;
  sub?: string;
  tone?: 'neutral' | 'warn' | 'ok';
}) {
  return (
    <article className="admin-card">
      <span className="admin-card-label">{def ? <MetricLabel def={def} /> : null}</span>
      <strong className={`admin-card-value ${tone === 'warn' ? 'tone-warn' : tone === 'ok' ? 'tone-ok' : ''}`}>
        {value}
      </strong>
      {sub && <span className="admin-card-sub">{sub}</span>}
    </article>
  );
}

function MetricLabel({ def }: { def: MetricDef }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="metric-label">
      <span className="metric-bilingual">
        <b>{def.zh}</b>
        <em>{def.en}</em>
        <button
          className="metric-help"
          type="button"
          aria-expanded={open}
          aria-label={`查看 ${def.zh} 含义`}
          title="点击查看含义"
          onClick={() => setOpen((value) => !value)}
        >
          ?
        </button>
      </span>
      {open && <span className="metric-meaning">{def.meaning}</span>}
    </span>
  );
}

function LegacyTraceView({
  initialFilters,
  onOpenPrompt,
}: {
  initialFilters: TraceFilters;
  onOpenPrompt: (filters: PromptFilters) => void;
}) {
  const [filters, setFilters] = useState<TraceFilters>(initialFilters);
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expandedGames, setExpandedGames] = useState<Set<string>>(new Set());

  const groups = useMemo(() => {
    const map = new Map<string, { start: string; events: RuntimeEvent[] }>();
    for (const event of events) {
      const group = map.get(event.gameId) ?? { start: event.timestamp, events: [] };
      group.events.push(event);
      map.set(event.gameId, group);
    }
    return [...map.entries()]
      .map(([gameId, group]) => ({ gameId, ...group }))
      .sort((left, right) => (left.start < right.start ? 1 : -1));
  }, [events]);

  const toggleGame = (gameId: string) => {
    setExpandedGames((current) => {
      const next = new Set(current);
      if (next.has(gameId)) next.delete(gameId);
      else next.add(gameId);
      return next;
    });
  };

  const load = useCallback((next?: TraceFilters) => {
    const params = next ?? filters;
    setLoading(true);
    setError('');
    adminApi
      .traces(params)
      .then((result) => {
        setEvents(result.events);
        setCount(result.count);
      })
      .catch((loadError: unknown) => setError(loadError instanceof Error ? loadError.message : '加载失败'))
      .finally(() => setLoading(false));
  }, [filters]);

  useEffect(() => {
    setFilters(initialFilters);
    load(initialFilters);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFilters]);

  useEffect(() => {
    const timer = setInterval(() => load(), AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <div className="admin-panel">
      <p className="admin-tab-intro">
        按发生顺序回放当前进程里打过的对局：每一行都是一次真实事件——模型调用、自动重试、失败恢复、质量门禁或公开事件。
        数据只保存在当前后端进程内存，后端重启后会清空（无持久化）；默认显示全部对局，最多最近 500 条。
      </p>
      <div className="admin-legend">
        <span><i className="legend-dot ok" />成功</span>
        <span><i className="legend-dot bad" />失败 / 异常</span>
        <span><i className="legend-dot warn" />重试 / 恢复 / 门禁</span>
        <span><i className="legend-dot neutral" />溯源 / 公开事件</span>
      </div>
      <div className="admin-filters">
        <FilterInput label="对局 ID" placeholder="如 c4037fe7…" value={filters.gameId} onChange={(value) => setFilters({ ...filters, gameId: value })} />
        <FilterInput label="轮次" placeholder="如 2" value={filters.round} onChange={(value) => setFilters({ ...filters, round: value })} />
        <FilterInput label="玩家" placeholder="ai-2 / 阿序" value={filters.agent} onChange={(value) => setFilters({ ...filters, agent: value })} />
        <FilterInput label="任务" placeholder="describe / vote / review" value={filters.task} onChange={(value) => setFilters({ ...filters, task: value })} />
        <FilterInput label="错误类型" placeholder="timeout / rate_limit" value={filters.errorType} onChange={(value) => setFilters({ ...filters, errorType: value })} />
        <FilterInput label="评测 runId" placeholder="如 8821306c…" value={filters.runId} onChange={(value) => setFilters({ ...filters, runId: value })} />
        <button className="admin-button" onClick={() => load()}>
          应用筛选
        </button>
        <button
          className="admin-button quiet"
          onClick={() => {
            const empty = { gameId: '', round: '', agent: '', task: '', errorType: '', runId: '' };
            setFilters(empty);
            load(empty);
          }}
        >
          重置
        </button>
      </div>

      {error && <div className="admin-error">{error}</div>}
      {loading ? (
        <div className="admin-skeleton-list">
          {[0, 1, 2, 3].map((item) => (
            <div className="admin-skeleton" key={item} />
          ))}
        </div>
      ) : events.length === 0 ? (
        <div className="admin-empty">
          <p>没有匹配的 trace 事件。先开一局游戏，事件会自动进入这条时间线（每 5 分钟自动刷新，或点击“应用筛选”立即刷新）。</p>
        </div>
      ) : (
        <>
          <p className="admin-count">
            共 {count} 条事件 · {groups.length} 个对局 · 点击对局标题展开（最新在前）· 最多显示最近 500 条
          </p>
          <div className="admin-timeline">
            {groups.map((group) => {
              const expanded = expandedGames.has(group.gameId);
              return (
                <section className="admin-game-group" key={group.gameId}>
                  <button
                    type="button"
                    className={`admin-game-header ${expanded ? 'is-open' : ''}`}
                    aria-expanded={expanded}
                    onClick={() => toggleGame(group.gameId)}
                  >
                    <span className="admin-game-id">对局 {group.gameId.slice(0, 8)}…</span>
                    <span className="admin-game-time">开始 {new Date(group.start).toLocaleTimeString()}</span>
                    <span className="admin-game-count">{group.events.length} 事件</span>
                    <ChevronDown className="admin-chevron" size={14} />
                  </button>
                  {expanded && (
                    <div className="admin-game-body">
                      {group.events.map((event, index) => {
                        const previous = group.events[index - 1];
                        const newRound = !previous || previous.round !== event.round;
                        return (
                          <Fragment key={event.sequence}>
                            {newRound && <div className="admin-round-heading">第 {event.round} 轮</div>}
                            <TraceRow event={event} onOpenPrompt={onOpenPrompt} />
                          </Fragment>
                        );
                      })}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

const TASK_LABELS: Record<string, string> = { describe: '描述', vote: '投票', review: '复盘' };
const ERROR_LABELS: Record<string, string> = {
  timeout: '超时',
  rate_limit: '限流',
  provider_5xx: '服务端异常',
  http_non_retryable: '请求被拒',
  invalid_json: 'JSON 无法解析',
  schema_validation: '结构不符',
  network: '网络错误',
  secret: '泄题',
  unknown: '未知',
};

function TraceRow({ event, onOpenPrompt }: { event: RuntimeEvent; onOpenPrompt: (filters: PromptFilters) => void }) {
  const linkable =
    event.eventType === 'model_call' ||
    event.eventType === 'recovery_action' ||
    event.eventType === 'quality_violation' ||
    event.eventType === 'prompt_provenance';
  const openPromptTrace = () => {
    onOpenPrompt({
      gameId: event.gameId,
      round: String(event.round),
      agentId: String(event.agentId ?? ''),
      task:
        event.eventType === 'model_call' || event.eventType === 'prompt_provenance'
          ? String(event.task ?? '')
          : 'describe',
    });
  };
  return (
    <article className="admin-trace-row">
      <EventBadge event={event} />
      <div className="admin-trace-main">
        <div className="admin-trace-head">
          <EventSummary event={event} />
          {linkable && (
            <button className="admin-trace-link" onClick={openPromptTrace}>
              追溯 Prompt
            </button>
          )}
          <span className="admin-trace-time">{new Date(event.timestamp).toLocaleTimeString()}</span>
        </div>
        <details className="admin-raw">
          <summary>原始元数据</summary>
          <pre>{JSON.stringify(event, null, 2)}</pre>
        </details>
      </div>
    </article>
  );
}

function EventBadge({ event }: { event: RuntimeEvent }) {
  const tone =
    event.eventType === 'model_call'
      ? event.outcome === 'success'
        ? 'ok'
        : 'bad'
      : event.eventType === 'recovery_action' || event.eventType === 'quality_violation'
        ? 'warn'
        : 'neutral';
  const def = EVENT_DEFS[event.eventType];
  return <span className={`admin-badge trace-${tone}`}>{def?.zh ?? event.eventType}</span>;
}

function EventSummary({ event }: { event: RuntimeEvent }) {
  const type = event.eventType;
  const agent = String(event.agentName ?? event.agentId ?? '');
  const task = TASK_LABELS[String(event.task ?? '')] ?? String(event.task ?? '');
  const attempt = Number(event.attempt ?? 1);
  if (type === 'model_call') {
    const ok = event.outcome === 'success';
    const error = event.errorType ? ERROR_LABELS[String(event.errorType)] ?? String(event.errorType) : null;
    const latency = Number(event.latencyMs) > 0 ? `（${Math.round(Number(event.latencyMs))}ms）` : '';
    const suffix = ok ? '成功' : error ? `失败：${error}` : '失败';
    const retry = !ok && Boolean(event.willRetry) ? ' → 自动重试' : !ok && !event.willRetry ? ' · 重试耗尽' : '';
    return (
      <span className={`admin-event ${ok ? 'ok' : 'bad'}`}>
        {ok ? '✓' : '✕'} {agent} {task} 第 {attempt} 次尝试 {suffix}
        {latency}
        {retry}
      </span>
    );
  }
  if (type === 'public_event') {
    const labels: Record<string, string> = {
      description: '描述发布',
      system: '系统提示',
      vote_result: '投票结果',
      elimination: '淘汰',
      evaluation_game_start: '评测对局开始',
      evaluation_game_completed: '评测对局完成',
      evaluation_game_failed: '评测对局失败',
    };
    const label = labels[String(event.publicEventType)] ?? String(event.publicEventType);
    const text = event.text
      ? `：${String(event.text).slice(0, 48)}${String(event.text).length > 48 ? '…' : ''}`
      : '';
    return (
      <span className="admin-event neutral">
        {label}
        {agent ? ` · ${agent}` : ''}
        {text}
      </span>
    );
  }
  if (type === 'recovery_action') {
    const outcome =
      event.recoveryOutcome === 'recovered' ? '恢复成功' : event.recoveryOutcome === 'exhausted' ? '恢复耗尽' : '';
    return (
      <span className="admin-event warn">
        描述失败后手动重试 {agent} 第 {Number(event.manualResumeIndex ?? 1)} 次（剩余{' '}
        {Number(event.manualRetriesRemaining ?? 0)} 次）{outcome}
      </span>
    );
  }
  if (type === 'quality_violation') {
    return (
      <span className="admin-event warn">
        门禁拦截 {agent} 第 {attempt} 次尝试：{String(event.violationType ?? '')}
        {Boolean(event.willRetry) ? ' → 修复重试' : ' · 中止'}
      </span>
    );
  }
  if (type === 'prompt_provenance') {
    return (
      <span className="admin-event neutral">
        记录 {task} 的 Prompt：版本 {String(event.promptTemplateVersion ?? '')} · 哈希{' '}
        {String(event.promptHash ?? '').slice(0, 12)}…
      </span>
    );
  }
  return <span className="admin-event neutral">{String(event.eventType)}</span>;
}

function FaultPanel() {
  const [status, setStatus] = useState<FaultStatus | null>(null);
  const [scenario, setScenario] = useState(FAULT_SCENARIOS[0]);
  const [targetAgent, setTargetAgent] = useState('');
  const [delayMs, setDelayMs] = useState('');
  const [error, setError] = useState('');

  const refresh = useCallback(() => {
    adminApi
      .faults()
      .then(setStatus)
      .catch((loadError: unknown) => setError(loadError instanceof Error ? loadError.message : '读取失败'));
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const arm = async () => {
    setError('');
    try {
      setStatus(
        await adminApi.armFault(
          scenario,
          targetAgent || undefined,
          delayMs === '' ? undefined : Number(delayMs),
        ),
      );
    } catch (armError) {
      setError(armError instanceof Error ? armError.message : 'Arm 失败');
    }
  };

  const clear = async () => {
    setError('');
    try {
      setStatus(await adminApi.clearFault());
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : 'Clear 失败');
    }
  };

  const state = status?.state ?? 'normal';
  return (
    <div className="admin-panel">
      <div className="admin-fault-card">
        <div className="admin-fault-head">
          <span className="admin-card-label">Fault State</span>
          <span className={`admin-badge state-${state} ${state === 'armed' ? 'pulse' : ''}`}>
            {state.toUpperCase()}
          </span>
        </div>
        <p className="admin-fault-note">
          {state === 'armed' && status?.scenario
            ? `已武装 ${status.scenario}（剩余 ${status.remaining ?? 0} 次注入）。下一次匹配的调用会真正触发 M5 fault mechanism，触发后自动清除。`
            : state === 'triggered' && status?.scenario
              ? `已触发并自动清除（one-shot）。场景 ${status.scenario} · 对局 ${status.gameId ?? '—'} · ${status.triggeredAt ? new Date(status.triggeredAt).toLocaleTimeString() : ''}。可再次 Arm。`
              : '当前正常。选择场景后 Arm，然后按场景条件在游戏里触发。'}
        </p>
        <div className="admin-fault-controls">
          <label className="admin-field">
            <span>Scenario</span>
            <select value={scenario} onChange={(event) => setScenario(event.target.value)}>
              {FAULT_SCENARIOS.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <label className="admin-field">
            <span>Target Agent</span>
            <select value={targetAgent} onChange={(event) => setTargetAgent(event.target.value)}>
              <option value="">Any</option>
              <option value="ai-1">ai-1</option>
              <option value="ai-2">ai-2</option>
              <option value="ai-3">ai-3</option>
              <option value="ai-4">ai-4</option>
            </select>
          </label>
          <label className="admin-field">
            <span>模拟耗时 (ms)</span>
            <input
              type="number"
              min={0}
              max={60000}
              placeholder="0 = 立即注入"
              value={delayMs}
              onChange={(event) => setDelayMs(event.target.value)}
            />
          </label>
          <button className="admin-button" onClick={arm} disabled={state === 'armed'}>
            Arm Fault
          </button>
          <button className="admin-button quiet" onClick={clear}>
            Clear Fault
          </button>
          <button className="admin-button quiet" onClick={refresh}>
            刷新
          </button>
        </div>
        {error && <div className="admin-error">{error}</div>}
        <p className="admin-fault-hint">
          场景沿用 M5 定义，触发条件固定：describe-timeout / describe-bad-json / schema-failure 在“新一局第 1 轮 ai-2 第一次描述”触发；
          describe-final-failure 在 ai-4 描述（两次尝试均失败）、vote-final-failure 在 ai-2 投票、review-failure 在终局复盘。
          timeout / rate_limit 属瞬时故障，注入后自动重试恢复，游戏看起来正常——注入证据在 Trace 页（失败 + 自动重试行）。想让操作真的失败，用 final-failure 或 review-failure 场景。
          “模拟耗时”会让注入先等待该毫秒数再失败（如 30000 更像真实超时）；留空或 0 则立即注入，测试/确定性场景请保持 0。
        </p>
      </div>
    </div>
  );
}

type LiveEvalRow = {
  defKey: string;
  final: (metrics: EvaluationLiveMetrics) => string;
  baseline?: (data: EvaluationData) => string;
  delta?: (metrics: EvaluationLiveMetrics, data: EvaluationData) => number | null;
  better?: 'up' | 'down' | 'neutral';
};

function formatRate(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function formatDelta(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 100) return value.toFixed(0);
  if (absolute >= 1) return value.toFixed(2);
  return value.toFixed(4);
}

const LIVE_EVAL_ROWS: LiveEvalRow[] = [
  {
    defKey: 'completionRate',
    final: (m) => formatRate(m.completionRate),
    baseline: (d) => formatRate(d.baseline.completionRate),
    delta: (m, d) => m.completionRate - d.baseline.completionRate,
    better: 'up',
  },
  {
    defKey: 'validVoteRate',
    final: (m) => formatRate(m.validVoteRate),
    baseline: (d) => formatRate(d.baseline.validVoteRate),
    delta: (m, d) => m.validVoteRate - d.baseline.validVoteRate,
    better: 'neutral',
  },
  {
    defKey: 'invalidOutputRate',
    final: (m) => formatRate(m.invalidOutputRate),
    baseline: (d) => formatRate(d.baseline.invalidOutputRate),
    delta: (m, d) => m.invalidOutputRate - d.baseline.invalidOutputRate,
    better: 'down',
  },
  {
    defKey: 'secretLeak',
    final: (m) => String(m.safety.secretLeakOccurrences),
    baseline: (d) => String(d.baseline.descriptionExactSecretLeaks),
    delta: (m, d) => m.safety.secretLeakOccurrences - d.baseline.descriptionExactSecretLeaks,
    better: 'neutral',
  },
  {
    defKey: 'homogeneity',
    final: (m) => m.descriptionHomogeneity.toFixed(4),
    baseline: (d) => d.baseline.descriptionHomogeneity.toFixed(4),
    delta: (m, d) => m.descriptionHomogeneity - d.baseline.descriptionHomogeneity,
    better: 'down',
  },
  {
    defKey: 'latencyP50',
    final: (m) => `${Math.round(m.latencyMs.p50)} ms`,
    baseline: (d) => `${Math.round(d.baseline.latencyMs.p50)} ms`,
    delta: (m, d) => m.latencyMs.p50 - d.baseline.latencyMs.p50,
    better: 'down',
  },
  {
    defKey: 'latencyP95',
    final: (m) => `${Math.round(m.latencyMs.p95)} ms`,
    baseline: (d) => `${Math.round(d.baseline.latencyMs.p95)} ms`,
    delta: (m, d) => m.latencyMs.p95 - d.baseline.latencyMs.p95,
    better: 'down',
  },
  {
    defKey: 'tokensPerGame',
    final: (m) => m.tokenUsage.averagePerGame.total.toFixed(1),
    baseline: (d) => d.baseline.tokensPerGame.toFixed(1),
    delta: (m, d) => m.tokenUsage.averagePerGame.total - d.baseline.tokensPerGame,
    better: 'down',
  },
  {
    defKey: 'costPerGame',
    final: (m) => (m.cost.source === 'unavailable' ? '—' : `${m.cost.averageCostPerGame.toFixed(4)} ${m.cost.currency}`),
    baseline: (d) => d.baseline.costPerGame.toFixed(4),
    delta: (m, d) => (m.cost.source === 'unavailable' ? null : m.cost.averageCostPerGame - d.baseline.costPerGame),
    better: 'down',
  },
  {
    defKey: 'providerRetries',
    final: (m) => String(m.providerRetryCount),
    baseline: (d) => String(d.baseline.providerRetryCount),
    delta: (m, d) => m.providerRetryCount - d.baseline.providerRetryCount,
    better: 'down',
  },
  {
    defKey: 'qualityRepairs',
    final: (m) => String(m.qualityRepairCount),
    baseline: (d) => String(d.baseline.qualityRepairCount),
    delta: (m, d) => m.qualityRepairCount - d.baseline.qualityRepairCount,
    better: 'neutral',
  },
  { defKey: 'descriptionAttempts', final: (m) => String(m.descriptionAttempts) },
  { defKey: 'retryRate', final: (m) => formatRate(m.retryRate) },
];

function EvaluationPanel({
  status,
  onOpenTrace,
  onOpenGameTrace,
}: {
  status: AdminStatus | null;
  onOpenTrace: (runId: string) => void;
  onOpenGameTrace: (gameId: string) => void;
}) {
  const [baseline, setBaseline] = useState<EvaluationData | null>(null);
  const [runs, setRuns] = useState<EvaluationRunSummary[]>([]);
  const [selected, setSelected] = useState<EvaluationRunDetail | null>(null);
  const [games, setGames] = useState('20');
  const [seed, setSeed] = useState('42');
  const [model, setModel] = useState<EvaluationModelKind>('fake');
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [sampleSessions, setSampleSessions] = useState<TraceSession[]>([]);

  const loadRuns = useCallback(async () => {
    try {
      const result = await adminApi.evaluationRuns();
      setRuns(result.runs);
    } catch {
      // 历史列表加载失败时保留现有列表
    }
  }, []);

  useEffect(() => {
    loadRuns();
    adminApi
      .evaluation()
      .then(setBaseline)
      .catch(() => setBaseline(null));
    adminApi
      .traces({})
      .then((result) => setSampleSessions(buildTraceSessions(result.events, [])))
      .catch(() => setSampleSessions([]));
  }, [loadRuns]);

  const selectRun = useCallback(async (runId: string) => {
    setError('');
    try {
      setSelected(await adminApi.evaluationRun(runId));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载评测详情失败');
    }
  }, []);

  const pollRun = useCallback(
    async (runId: string) => {
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const detail = await adminApi.evaluationRun(runId);
        setSelected(detail);
        if (detail.status !== 'running') {
          await loadRuns();
          return;
        }
      }
    },
    [loadRuns],
  );

  const startRun = async () => {
    setError('');
    const gamesValue = Number(games);
    const seedValue = Number(seed);
    if (!Number.isInteger(gamesValue) || gamesValue < 1 || gamesValue > 100) {
      setError('局数必须是 1–100 的整数');
      return;
    }
    if (!Number.isInteger(seedValue)) {
      setError('seed 必须是整数');
      return;
    }
    setStarting(true);
    try {
      const { runId } = await adminApi.startEvaluation({ games: gamesValue, seed: seedValue, model });
      setSelected(await adminApi.evaluationRun(runId));
      await pollRun(runId);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : '启动评测失败');
    } finally {
      setStarting(false);
    }
  };

  const runningDetail = selected?.status === 'running' ? selected : null;
  return (
    <div className="admin-panel">
      <header className="admin-task2-header">
        <h1>Task ② · Evaluation</h1>
        <p>可重复评测 + Baseline / Final 真实对照</p>
      </header>

      {baseline ? (
        <BaselineFinalModule data={baseline} />
      ) : (
        <div className="admin-empty">
          <p>Baseline / Final canonical 数据未加载。</p>
        </div>
      )}

      <section className="admin-task2-module">
        <h2 className="admin-task2-module-title">可重复评测工具</h2>
        <EvaluationPipeline />
        <MetricsChecklist />
        <Runbook />

        <h3 className="admin-block-title">在线运行同一 Harness（与 CLI 同源，供现场演示）</h3>
        <p className="admin-note">
          批量跑 N 局评测：同 seed + fake 模型结果确定可复现；每次运行都会做门禁判定，并与官方基线和同配置历史运行对比。
        </p>

        <div className="admin-run-form">
        <label className="admin-field">
          <span>局数 Games</span>
          <input
            value={games}
            onChange={(event) => setGames(event.target.value)}
            inputMode="numeric"
            disabled={starting || runningDetail !== null}
          />
        </label>
        <label className="admin-field">
          <span>Seed</span>
          <input
            value={seed}
            onChange={(event) => setSeed(event.target.value)}
            inputMode="numeric"
            disabled={starting || runningDetail !== null}
          />
        </label>
        <label className="admin-field">
          <span>模型 Model</span>
          <select
            value={model}
            onChange={(event) => setModel(event.target.value as EvaluationModelKind)}
            disabled={starting || runningDetail !== null}
          >
            <option value="fake">fake（确定性 · 零成本）</option>
            <option value="real" disabled={!status?.configured}>
              real{status?.configured ? '' : '（未配置密钥）'}
            </option>
          </select>
        </label>
        <button
          className="admin-button"
          onClick={startRun}
          disabled={starting || runningDetail !== null}
        >
          {runningDetail ? '评测运行中…' : starting ? '启动中…' : '开始批量评测'}
        </button>
      </div>

      {runningDetail && (
        <div className="admin-progress">
          <div className="admin-progress-meta">
            <span>
              正在评测：{runningDetail.progress.completedGames}/{runningDetail.progress.totalGames} 局（seed{' '}
              {runningDetail.config.seed} · {runningDetail.config.model}）
            </span>
            <span>{Math.round((runningDetail.progress.completedGames / runningDetail.progress.totalGames) * 100)}%</span>
          </div>
          <div className="admin-progress-track">
            <div
              className="admin-progress-bar"
              style={{ width: `${(runningDetail.progress.completedGames / runningDetail.progress.totalGames) * 100}%` }}
            />
          </div>
        </div>
      )}

      {error && <div className="admin-error">{error}</div>}

      {selected?.status === 'failed' && (
        <div className="admin-gate fail">
          <strong>评测失败</strong>
          <span>{selected.error ?? '未知错误'}</span>
        </div>
      )}

      {selected?.status === 'completed' && selected.result && (
        <>
          {selected.gate && <GateBanner gate={selected.gate} />}
          <div className="admin-block-actions">
            <button className="admin-button" onClick={() => onOpenTrace(selected.runId)}>
              在 Trace 中查看本评测（{selected.runId.slice(0, 8)}…）
            </button>
          </div>
          {selected.config.model === 'fake' && <ReproducibilityPanel run={selected} runs={runs} />}

          <div className="admin-card-grid evaluation-cards">
            <StatusCard
              def={METRIC_DEFS.completionRate}
              value={formatRate(selected.result.metrics.completionRate)}
              sub={`${selected.result.metrics.completedGames}/${selected.result.metrics.startedGames} 局`}
            />
            <StatusCard
              def={METRIC_DEFS.validVoteRate}
              value={formatRate(selected.result.metrics.validVoteRate)}
              sub={selected.result.metrics.invalidOutputRate === 0 ? '无非法输出' : '含非法输出'}
            />
            <StatusCard
              def={METRIC_DEFS.homogeneity}
              value={selected.result.metrics.descriptionHomogeneity.toFixed(4)}
              sub="越低词面重复越少"
            />
            <StatusCard
              def={METRIC_DEFS.costPerGame}
              value={
                selected.result.metrics.cost.source === 'unavailable'
                  ? '—'
                  : `$${selected.result.metrics.cost.averageCostPerGame.toFixed(4)}`
              }
              sub={selected.result.metrics.cost.source === 'unavailable' ? 'fake 无计量' : '估算值'}
            />
          </div>

          <div className="admin-block">
            <h3 className="admin-block-title">指标表 Metrics（对比官方基线）</h3>
            {baseline ? (
              <LiveResultTable metrics={selected.result.metrics} baseline={baseline} />
            ) : (
              <p className="admin-note">基线数据未加载，只展示本次运行指标。</p>
            )}
          </div>

          <StrategyTable byStrategyId={selected.result.metrics.byStrategyId} />
          <TokenCostDetail metrics={selected.result.metrics} />
          <SafetyDetail metrics={selected.result.metrics} />

          <details className="admin-raw">
            <summary>原始评测 JSON</summary>
            <pre>{JSON.stringify(selected.result, null, 2)}</pre>
          </details>
        </>
      )}

        <RunHistoryTable
          runs={runs}
          selectedRunId={selected?.runId ?? null}
          onSelect={selectRun}
          onOpenTrace={onOpenTrace}
        />
        <SampleSessionsPanel sessions={sampleSessions} onOpenGameTrace={onOpenGameTrace} />
      </section>
    </div>
  );
}

function SampleSessionsPanel({
  sessions,
  onOpenGameTrace,
}: {
  sessions: TraceSession[];
  onOpenGameTrace: (gameId: string) => void;
}) {
  const samples = sessions.filter((session) => sessionOrigin(session).sourceType !== 'EVAL_RUN');
  if (samples.length === 0) return null;
  return (
    <div className="admin-block">
      <h3 className="admin-block-title">其他运行样本（不计入正式 Evaluation aggregate）</h3>
      <p className="admin-note">
        以下样本来自真人对局 / 管理员实验 / 控制台演示 / 测试等，仅用于排查与对照，不参与任何评测指标统计。
        点击行可跳转到对应 Trace Session。
      </p>
      <table className="admin-table admin-clickable-table">
        <thead>
          <tr>
            <th>来源</th>
            <th>模型</th>
            <th>Session</th>
            <th>开始时间</th>
            <th>Trace 数</th>
          </tr>
        </thead>
        <tbody>
          {samples.slice(0, 20).map((session) => {
            const origin = sessionOrigin(session);
            return (
              <tr key={session.id} onClick={() => onOpenGameTrace(session.id)}>
                <td>
                  {origin.sourceType ? (
                    <span className="admin-badge neutral">{SOURCE_LABELS[origin.sourceType] ?? origin.sourceType}</span>
                  ) : (
                    '未标记'
                  )}
                </td>
                <td>{origin.modelKind ? MODEL_LABELS[origin.modelKind] ?? origin.modelKind : '—'}</td>
                <td>{session.id.slice(0, 8)}…</td>
                <td>{new Date(session.startedAt).toLocaleString()}</td>
                <td>{session.traces.length}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function GateBanner({ gate }: { gate: { passed: boolean; failures: string[] } }) {
  return (
    <div className={`admin-gate ${gate.passed ? 'pass' : 'fail'}`}>
      <strong>{gate.passed ? '门禁 PASS' : '门禁 FAIL'}</strong>
      <span>
        {gate.passed
          ? '全部质量阈值达标，本次运行可作为回归基线。'
          : '以下质量指标越过阈值，本次运行不可作为回归基线：'}
      </span>
      {gate.failures.length > 0 && (
        <ul className="admin-gate-failures">
          {gate.failures.map((failure) => (
            <li key={failure}>{failure}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ReproducibilityPanel({ run, runs }: { run: EvaluationRunDetail; runs: EvaluationRunSummary[] }) {
  const earlier = runs
    .filter(
      (candidate) =>
        candidate.runId !== run.runId &&
        candidate.status === 'completed' &&
        candidate.config.model === 'fake' &&
        candidate.config.seed === run.config.seed &&
        candidate.config.games === run.config.games &&
        candidate.metrics,
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
  if (!earlier?.metrics || !run.metrics) {
    return (
      <p className="admin-note">
        这是该 seed + 局数组合的首次运行；再用相同配置跑一次即可校验可复现性。
      </p>
    );
  }
  const candidates: Array<[string, number, number]> = [
    ['completionRate', run.metrics.completionRate, earlier.metrics.completionRate],
    ['validVoteRate', run.metrics.validVoteRate, earlier.metrics.validVoteRate],
    ['descriptionHomogeneity', run.metrics.descriptionHomogeneity, earlier.metrics.descriptionHomogeneity],
    ['tokensPerGame', run.metrics.tokensPerGame, earlier.metrics.tokensPerGame],
  ];
  const differences = candidates.filter(([, current, previous]) => current !== previous);
  if (differences.length === 0) {
    return (
      <p className="admin-note repro-ok">
        可复现性校验 ✓：与 {new Date(earlier.createdAt).toLocaleString()} 的同配置运行关键指标完全一致（seed{' '}
        {run.config.seed} · {run.config.games} 局 · fake）。
      </p>
    );
  }
  return (
    <div className="admin-note repro-warn">
      <strong>可复现性校验 ✗：</strong>
      与同配置历史运行存在差异：
      <ul>
        {differences.map(([key, current, previous]) => (
          <li key={key}>
            {key}: {current} vs {previous}
          </li>
        ))}
      </ul>
    </div>
  );
}

function LiveResultTable({ metrics, baseline }: { metrics: EvaluationLiveMetrics; baseline: EvaluationData }) {
  return (
    <table className="admin-table">
      <thead>
        <tr>
          <th>指标 Metric</th>
          <th>本次运行 Final</th>
          <th>官方基线 Baseline</th>
          <th>差值 Delta</th>
        </tr>
      </thead>
      <tbody>
        {LIVE_EVAL_ROWS.map((row) => {
          const def = METRIC_DEFS[row.defKey];
          const delta = row.delta ? row.delta(metrics, baseline) : null;
          const worse = row.better === 'up' ? delta !== null && delta < 0 : delta !== null && delta > 0;
          const improved = row.better === 'up' ? delta !== null && delta > 0 : delta !== null && delta < 0;
          const tone =
            delta === null || !row.better || row.better === 'neutral' ? '' : worse ? 'delta-bad' : improved ? 'delta-good' : '';
          return (
            <tr key={row.defKey}>
              <td>{def ? <MetricLabel def={def} /> : row.defKey}</td>
              <td>{row.final(metrics)}</td>
              <td>{row.baseline ? row.baseline(baseline) : '—'}</td>
              <td className={tone}>{delta === null ? '—' : `${delta > 0 ? '+' : ''}${formatDelta(delta)}`}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function StrategyTable({ byStrategyId }: { byStrategyId: EvaluationLiveMetrics['byStrategyId'] }) {
  const rows = Object.entries(byStrategyId).sort(([left], [right]) => left.localeCompare(right));
  if (rows.length === 0) return null;
  return (
    <div className="admin-block">
      <h3 className="admin-block-title">策略分组 Strategy Breakdown</h3>
      <table className="admin-table">
        <thead>
          <tr>
            <th>策略</th>
            <th>局数</th>
            <th>胜场</th>
            <th>胜率</th>
            <th>投票</th>
            <th>准确票</th>
            <th>投票准确率</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([strategyId, group]) => (
            <tr key={strategyId}>
              <td>{PERSONA_NAMES[strategyId] ?? strategyId}</td>
              <td>{group.games}</td>
              <td>{group.wins}</td>
              <td>{formatRate(group.winRate)}</td>
              <td>{group.votes}</td>
              <td>{group.accurateVotes}</td>
              <td>{formatRate(group.voteAccuracy)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TokenCostDetail({ metrics }: { metrics: EvaluationLiveMetrics }) {
  const { tokenUsage, cost } = metrics;
  return (
    <div className="admin-block">
      <h3 className="admin-block-title">Token 与成本 Token &amp; Cost</h3>
      {tokenUsage.source === 'unavailable' ? (
        <p className="admin-note">fake 模型不产生真实 token 计量；真实模型运行会在 provider 返回 usage 时自动统计。</p>
      ) : (
        <>
          <p>
            输入 {tokenUsage.input} / 输出 {tokenUsage.output} / 总计 {tokenUsage.total}（每局平均{' '}
            {tokenUsage.averagePerGame.total}）
          </p>
          <table className="admin-table">
            <thead>
              <tr>
                <th>任务</th>
                <th>输入</th>
                <th>输出</th>
                <th>总计</th>
                <th>重试附加</th>
              </tr>
            </thead>
            <tbody>
              {(['describe', 'vote', 'review'] as const).map((task) => (
                <tr key={task}>
                  <td>{TASK_LABELS[task] ?? task}</td>
                  <td>{tokenUsage.byTask[task].input}</td>
                  <td>{tokenUsage.byTask[task].output}</td>
                  <td>{tokenUsage.byTask[task].total}</td>
                  <td>{tokenUsage.byTask[task].retryAddedTokens}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="admin-note">
            {cost.source === 'configured'
              ? `估算成本：总 ${cost.totalCost} ${cost.currency}（每局 ${cost.averageCostPerGame.toFixed(4)} ${cost.currency}）。${cost.formula}`
              : `成本不可用：${cost.formula}`}
          </p>
        </>
      )}
    </div>
  );
}

function SafetyDetail({ metrics }: { metrics: EvaluationLiveMetrics }) {
  const { safety } = metrics;
  return (
    <div className="admin-block">
      <h3 className="admin-block-title">安全明细 Safety</h3>
      <p className="admin-note">
        提交状态密词泄漏 {safety.secretLeakOccurrences} · 公开 DTO 泄漏 {safety.publicStateLeakOccurrences} ·
        非法/未完成状态 {safety.illegalStateOccurrences}
      </p>
    </div>
  );
}

function reproducibilityOf(run: EvaluationRunSummary, runs: EvaluationRunSummary[]): string | null {
  if (run.status !== 'completed' || run.config.model !== 'fake' || !run.metrics) return null;
  const earlier = runs
    .filter(
      (candidate) =>
        candidate.runId !== run.runId &&
        candidate.status === 'completed' &&
        candidate.config.model === 'fake' &&
        candidate.config.seed === run.config.seed &&
        candidate.config.games === run.config.games &&
        candidate.metrics,
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
  if (!earlier?.metrics) return null;
  const identical =
    earlier.metrics.completionRate === run.metrics.completionRate &&
    earlier.metrics.validVoteRate === run.metrics.validVoteRate &&
    earlier.metrics.descriptionHomogeneity === run.metrics.descriptionHomogeneity &&
    earlier.metrics.tokensPerGame === run.metrics.tokensPerGame &&
    earlier.metrics.costPerGame === run.metrics.costPerGame;
  return identical ? '可复现 ✓' : '与历史不一致 ✗';
}

function RunHistoryTable({
  runs,
  selectedRunId,
  onSelect,
  onOpenTrace,
}: {
  runs: EvaluationRunSummary[];
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
  onOpenTrace: (runId: string) => void;
}) {
  if (runs.length === 0) return null;
  return (
    <div className="admin-block">
      <h3 className="admin-block-title">运行历史 Run History（内存，服务重启清空）</h3>
      <p className="admin-note">以下均为正式批量评测（EVAL_RUN · 自动评测），参与评测指标统计。</p>
      <table className="admin-table admin-clickable-table">
        <thead>
          <tr>
            <th>来源</th>
            <th>时间</th>
            <th>模型</th>
            <th>seed</th>
            <th>局数</th>
            <th>门禁</th>
            <th>完局率</th>
            <th>同质化</th>
            <th>P50(ms)</th>
            <th>成本/局</th>
            <th>可复现</th>
            <th>Trace</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => {
            const reproducible = reproducibilityOf(run, runs);
            return (
              <tr
                key={run.runId}
                className={run.runId === selectedRunId ? 'is-selected' : ''}
                onClick={() => onSelect(run.runId)}
              >
                <td>
                  <span className="admin-badge neutral">EVAL_RUN · 自动评测</span>
                </td>
                <td>{new Date(run.createdAt).toLocaleString()}</td>
                <td>{run.config.model}</td>
                <td>{run.config.seed}</td>
                <td>{run.config.games}</td>
                <td>{run.status === 'running' ? '运行中' : run.status === 'failed' ? '失败' : run.gate?.passed ? 'PASS' : 'FAIL'}</td>
                <td>{run.metrics ? formatRate(run.metrics.completionRate) : '—'}</td>
                <td>{run.metrics ? run.metrics.descriptionHomogeneity.toFixed(4) : '—'}</td>
                <td>{run.metrics ? Math.round(run.metrics.latencyP50) : '—'}</td>
                <td>{run.metrics ? run.metrics.costPerGame.toFixed(4) : '—'}</td>
                <td>{reproducible ? <span className="admin-badge repro-ok">{reproducible}</span> : '—'}</td>
                <td>
                  <button
                    className="admin-trace-link"
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpenTrace(run.runId);
                    }}
                  >
                    查看
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const PLAYER_NAMES: Record<string, string> = {
  human: '你',
  'ai-1': '阿序',
  'ai-2': '弥生',
  'ai-3': '老墨',
  'ai-4': '小满',
};

const AGENT_IDS = ['ai-1', 'ai-2', 'ai-3', 'ai-4'];

function parseDescriptionLines(text: string): SameRoundDescription[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const separator = line.indexOf(':');
      const playerId = separator > 0 ? line.slice(0, separator).trim() : 'human';
      const content = separator > 0 ? line.slice(separator + 1).trim() : line;
      return { playerId, playerName: PLAYER_NAMES[playerId] ?? playerId, text: content };
    });
}

function formatDescriptionLines(descriptions: SameRoundDescription[]): string {
  return descriptions.map((description) => `${description.playerId}: ${description.text}`).join('\n');
}

function Task1AcceptancePanel({
  onOpenPrompt,
  onOpenTraceStep,
  status,
}: {
  onOpenPrompt: (filters: PromptFilters) => void;
  onOpenTraceStep: (gameId: string, round: number, agentId: string) => void;
  status: AdminStatus | null;
}) {
  const [evidence, setEvidence] = useState<Task1Evidence | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'context' | 'persona' | 'quality'>('context');

  // Tab1：顺序上下文（真实引擎跑一轮）
  const [seqCivilian, setSeqCivilian] = useState('地铁');
  const [seqUndercover, setSeqUndercover] = useState('高铁');
  const [seqHuman, setSeqHuman] = useState('上下班的时候很多人会接触到');
  const [seqRound, setSeqRound] = useState('1');
  const [seqResult, setSeqResult] = useState<SequentialRunResult | null>(null);
  const [seqSelected, setSeqSelected] = useState<string | null>(null);
  const [seqLoading, setSeqLoading] = useState(false);
  const [seqError, setSeqError] = useState('');

  // A：同轮上下文（可编辑）
  const [contextAgent, setContextAgent] = useState('ai-3');
  const [contextRound, setContextRound] = useState('2');
  const [contextText, setContextText] = useState('');
  const [contextResult, setContextResult] = useState<ContextBuildResult | null>(null);
  const [contextRecord, setContextRecord] = useState<SameRoundEvidence | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState('');

  // B：Persona 可区分（可编辑局面，可重跑真实模型）
  const [personaRole, setPersonaRole] = useState<'civilian' | 'undercover'>('undercover');
  const [personaWord, setPersonaWord] = useState('高铁');
  const [personaRound, setPersonaRound] = useState('2');
  const [personaText, setPersonaText] = useState(
    'human: 上下班的时候很多人会接触到。\nai-1: 经常需要在固定的地方等它。\nai-2: 通常会按照自己的路线移动。',
  );
  const [personaResult, setPersonaResult] = useState<PersonaRunResult | null>(null);
  const [personaPromptCase, setPersonaPromptCase] = useState<PersonaRunCase | null>(null);
  const [personaLoading, setPersonaLoading] = useState(false);
  const [personaError, setPersonaError] = useState('');

  // C：Quality Gate（可编辑候选文本，实时检查）
  const [attempt1, setAttempt1] = useState('一种不太张扬但很常见的体验');
  const [attempt2, setAttempt2] = useState('它常在特定场合形成明显氛围');
  const [acceptedText, setAcceptedText] = useState('这是生活里熟悉的一种东西\n一种不太张扬但很常见的体验');
  const [threshold, setThreshold] = useState('0.72');
  const [secretsText, setSecretsText] = useState('高铁,地铁');
  const [qualityResult, setQualityResult] = useState<QualityGateCheckResult | null>(null);
  const [qualityLoading, setQualityLoading] = useState(false);
  const [qualityError, setQualityError] = useState('');

  const runContext = useCallback(
    async (agentId: string, round: number, descriptions: SameRoundDescription[]) => {
      setContextLoading(true);
      setContextError('');
      try {
        setContextResult(await adminApi.task1Context({ agentId, round, publicDescriptions: descriptions }));
      } catch (loadError) {
        setContextError(loadError instanceof Error ? loadError.message : '上下文重算失败');
      } finally {
        setContextLoading(false);
      }
    },
    [],
  );

  const runQuality = useCallback(async () => {
    setQualityLoading(true);
    setQualityError('');
    try {
      const thresholdValue = Number(threshold);
      if (!Number.isFinite(thresholdValue) || thresholdValue < 0 || thresholdValue > 1) {
        throw new Error('threshold 必须是 0–1 的数字');
      }
      setQualityResult(
        await adminApi.task1Quality({
          attempt1Candidate: attempt1,
          attempt2Candidate: attempt2,
          acceptedSameRound: acceptedText
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean),
          threshold: thresholdValue,
          allSecrets: secretsText
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean),
        }),
      );
    } catch (runError) {
      setQualityError(runError instanceof Error ? runError.message : 'Gate 检查失败');
    } finally {
      setQualityLoading(false);
    }
  }, [attempt1, attempt2, acceptedText, threshold, secretsText]);

  const runSequential = async () => {
    setSeqLoading(true);
    setSeqError('');
    try {
      const round = Number(seqRound);
      if (!Number.isInteger(round) || round < 1) {
        throw new Error('round 必须是正整数');
      }
      const result = await adminApi.task1SequentialRun({
        civilianWord: seqCivilian,
        undercoverWord: seqUndercover,
        humanDescription: seqHuman,
        round,
      });
      setSeqResult(result);
      const first = result.steps[0];
      setSeqSelected(first ? `${first.round}-${first.agentId}` : null);
    } catch (runError) {
      setSeqError(runError instanceof Error ? runError.message : '顺序描述运行失败');
    } finally {
      setSeqLoading(false);
    }
  };

  useEffect(() => {
    adminApi
      .task1()
      .then(async (data) => {
        setEvidence(data);
        const record =
          data.contextRecords.find(
            (item) => item.agentId === 'ai-3' && item.sameRoundPublicDescriptionCount >= 2,
          ) ?? data.contextRecords[0];
        if (record) {
          setContextAgent(record.agentId);
          setContextRound(String(record.round));
          setContextText(formatDescriptionLines(record.sameRoundDescriptions));
          try {
            const result = await adminApi.task1Context({
              agentId: record.agentId,
              round: record.round,
              publicDescriptions: record.sameRoundDescriptions,
            });
            setContextResult(result);
            setContextRecord({
              agentId: record.agentId,
              agentName: record.agentName,
              round: record.round,
              gameId: record.gameId,
              promptVersion: result.promptVersion,
              promptHash: result.promptHash,
              publicDescriptionCount: result.publicDescriptionCount,
              sameRoundPublicDescriptionCount: result.sameRoundPublicDescriptionCount,
              timestamp: record.timestamp,
              sameRoundDescriptions: record.sameRoundDescriptions,
            });
          } catch {
            // 记录载入失败时保留空结果，等待手动重算
          }
        }
      })
      .catch((loadError: unknown) =>
        setError(loadError instanceof Error ? loadError.message : '加载 Task ① 证据失败'),
      );
  }, []);

  useEffect(() => {
    runQuality();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) {
    return (
      <div className="admin-empty">
        <p>无法读取 Task ① 验收证据：{error}</p>
      </div>
    );
  }
  if (!evidence) {
    return (
      <div className="admin-skeleton-grid">
        {[0, 1, 2].map((item) => (
          <div className="admin-card admin-skeleton" key={item} />
        ))}
      </div>
    );
  }

  const personas = personaResult ?? evidence.persona;
  const realAvailable = Boolean(status?.configured);
  const acceptedCount = acceptedText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean).length;

  return (
    <div className="admin-panel">
      <header className="admin-task1-header">
        <h1>Task ① · Agent 验证实验台</h1>
        <p>看到了什么 → 怎么决策 → 什么允许公开</p>
      </header>
      <nav className="admin-tabs" role="tablist">
        {[
          { id: 'context', label: '顺序上下文验证' },
          { id: 'persona', label: 'Persona 对照实验' },
          { id: 'quality', label: 'Quality Gate 验证' },
        ].map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={tab === item.id}
            className={`admin-tab ${tab === item.id ? 'is-active' : ''}`}
            onClick={() => setTab(item.id as 'context' | 'persona' | 'quality')}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {tab === 'context' && (
        <section className="admin-task1-card">
          <div className="admin-task1-inputs">
            <label className="admin-field">
              <span>平民词</span>
              <input value={seqCivilian} onChange={(event) => setSeqCivilian(event.target.value)} />
            </label>
            <label className="admin-field">
              <span>卧底词</span>
              <input value={seqUndercover} onChange={(event) => setSeqUndercover(event.target.value)} />
            </label>
            <label className="admin-field task1-wide">
              <span>Human 首句</span>
              <input value={seqHuman} onChange={(event) => setSeqHuman(event.target.value)} />
            </label>
            <label className="admin-field">
              <span>Round</span>
              <input value={seqRound} inputMode="numeric" onChange={(event) => setSeqRound(event.target.value)} />
            </label>
            <button className="admin-button" disabled={seqLoading || !realAvailable} onClick={runSequential}>
              {seqLoading ? '运行中（真实顺序描述）…' : '运行真实顺序描述'}
            </button>
          </div>
          {!realAvailable && <div className="admin-error">Real model unavailable：配置 DEEPSEEK_API_KEY 后重启后端</div>}
          {seqError && <div className="admin-error">{seqError}</div>}
          {seqResult && (
            <>
              <div className="admin-task1-meta">
                <span>测试词：平民 = {seqResult.civilianWord} · 卧底 = {seqResult.undercoverWord}</span>
                <span>
                  目标 Round = {seqResult.round} · 已完成 = {seqResult.completedRounds}
                </span>
                <span title={seqResult.gameId}>gameId = {seqResult.gameId.slice(0, 8)}…</span>
              </div>
              {seqResult.endedNote && <div className="admin-error">{seqResult.endedNote}</div>}
              <p className="admin-task1-sub">点击时间线上的 Agent，查看它调用模型时实际收到的同轮先发描述：</p>
              <div className="admin-task1-timeline">
                {[...new Set(seqResult.steps.map((step) => step.round))]
                  .sort((left, right) => left - right)
                  .map((round) => {
                    const roundSteps = seqResult.steps.filter((step) => step.round === round);
                    return (
                      <Fragment key={round}>
                        <div className="admin-task1-sub">Round {round}</div>
                        {roundSteps.map((step, index) => (
                          <Fragment key={`${round}-${step.agentId}`}>
                            <button
                              type="button"
                              className={`admin-task1-timeline-step ${
                                seqSelected === `${round}-${step.agentId}` ? 'is-selected' : ''
                              }`}
                              onClick={() => setSeqSelected(`${round}-${step.agentId}`)}
                            >
                              <strong>{step.agentName}</strong>
                              <span>“{step.description}”</span>
                              <span className="admin-note">
                                same-round: {step.sameRoundPublicDescriptionCount}
                              </span>
                            </button>
                            {index < roundSteps.length - 1 && <span className="admin-task1-arrow">↓</span>}
                          </Fragment>
                        ))}
                      </Fragment>
                    );
                  })}
              </div>
              {seqResult.steps.find((step) => seqSelected === `${step.round}-${step.agentId}`) && (
                <SequentialStepDetail
                  step={seqResult.steps.find((item) => seqSelected === `${item.round}-${item.agentId}`)!}
                  gameId={seqResult.gameId}
                  onOpenPrompt={onOpenPrompt}
                  onOpenTraceStep={onOpenTraceStep}
                />
              )}
            </>
          )}
        </section>
      )}

      {tab === 'context' && (
        <div className="admin-block admin-task1-card">
          <h3 className="admin-block-title">手动构造上下文（可选 · 真实 Prompt Builder）</h3>
        <div className="admin-task1-inputs">
          <label className="admin-field">
            <span>Agent</span>
            <select value={contextAgent} onChange={(event) => setContextAgent(event.target.value)}>
              {AGENT_IDS.map((agentId) => (
                <option key={agentId} value={agentId}>
                  {agentId}（{PLAYER_NAMES[agentId]}）
                </option>
              ))}
            </select>
          </label>
          <label className="admin-field">
            <span>Round</span>
            <input
              value={contextRound}
              inputMode="numeric"
              onChange={(event) => setContextRound(event.target.value)}
            />
          </label>
          <button
            className="admin-button quiet"
            disabled={evidence.contextRecords.length === 0}
            onClick={() => {
              const record =
                evidence.contextRecords.find(
                  (item) => item.agentId === contextAgent && item.sameRoundPublicDescriptionCount >= 2,
                ) ?? evidence.contextRecords.find((item) => item.agentId === contextAgent) ?? evidence.contextRecords[0];
              if (!record) return;
              setContextAgent(record.agentId);
              setContextRound(String(record.round));
              setContextText(formatDescriptionLines(record.sameRoundDescriptions));
              setContextResult(null);
              runContext(record.agentId, record.round, record.sameRoundDescriptions);
            }}
          >
            载入最近真实记录{evidence.contextRecords.length > 0 ? `（${evidence.contextRecords.length} 条可选）` : ''}
          </button>
        </div>
        <p className="admin-task1-sub">同轮公开描述（每行一行，格式：playerId: 文本）</p>
        <textarea
          className="admin-task1-textarea"
          rows={4}
          value={contextText}
          onChange={(event) => setContextText(event.target.value)}
          placeholder={'human: …\nai-1: …\nai-2: …'}
        />
        <div className="admin-block-actions">
          <button
            className="admin-button"
            disabled={contextLoading}
            onClick={() => {
              const round = Number(contextRound);
              if (!Number.isInteger(round) || round < 1) {
                setContextError('round 必须是正整数');
                return;
              }
              runContext(contextAgent, round, parseDescriptionLines(contextText));
            }}
          >
            {contextLoading ? '计算中…' : '重新计算上下文'}
          </button>
          <span className="admin-note">改动任一文本 → promptHash / same-round 计数会跟着变化</span>
        </div>
        {contextError && <div className="admin-error">{contextError}</div>}
        {contextResult && (
          <div className="admin-task1-result">
            <div className="admin-task1-meta">
              <span>sameRoundPublicDescriptions = {contextResult.sameRoundPublicDescriptionCount}</span>
              <span>publicDescriptionCount = {contextResult.publicDescriptionCount}</span>
              <span>promptVersion = {contextResult.promptVersion}</span>
              <span title={contextResult.promptHash}>promptHash = {contextResult.promptHash.slice(0, 16)}…</span>
              <span>strategyId = {contextResult.strategyId}</span>
            </div>
            <details className="admin-raw">
              <summary>Sanitized Prompt（模型实际收到的消息体）</summary>
              {contextResult.messages.map((message, index) => (
                <div key={index}>
                  <span className="admin-badge neutral">{message.role}</span>
                  <pre>{prettyJson(message.content)}</pre>
                </div>
              ))}
            </details>
            {contextRecord && (
              <div className="admin-block-actions">
                <button
                  className="admin-button"
                  onClick={() =>
                    onOpenPrompt({
                      gameId: contextRecord.gameId,
                      round: String(contextRecord.round),
                      agentId: contextRecord.agentId,
                      task: 'describe',
                    })
                  }
                >
                  查看 Prompt Trace（对应真实记录）
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      )}

      {tab === 'context' && contextRecord && (
        <div className="admin-block">
          <h3 className="admin-block-title">参考：最近一条真实同轮上下文记录</h3>
          <SameRoundEvidenceCard evidence={contextRecord} onOpenPrompt={onOpenPrompt} />
        </div>
      )}

      {tab === 'persona' && (
      <>
      <h2 className="admin-task1-section-title">B · Persona 可区分（相同局面，只换 Persona）</h2>
      <div className="admin-block admin-task1-card">
        <div className="admin-persona-fixed">
          {['Same State', 'Same Role', 'Same Word', 'Same Context', 'Same Seat', 'Only Persona Changes'].map((item) => (
            <span className="admin-badge neutral" key={item}>
              {item}
            </span>
          ))}
        </div>
        <div className="admin-task1-inputs">
          <label className="admin-field">
            <span>Role</span>
            <select
              value={personaRole}
              onChange={(event) => setPersonaRole(event.target.value as 'civilian' | 'undercover')}
            >
              <option value="civilian">civilian</option>
              <option value="undercover">undercover</option>
            </select>
          </label>
          <label className="admin-field">
            <span>Word</span>
            <input value={personaWord} onChange={(event) => setPersonaWord(event.target.value)} />
          </label>
          <label className="admin-field">
            <span>Round</span>
            <input
              value={personaRound}
              inputMode="numeric"
              onChange={(event) => setPersonaRound(event.target.value)}
            />
          </label>
        </div>
        <p className="admin-task1-sub">同轮公开描述（每行一行，格式：playerId: 文本）</p>
        <textarea
          className="admin-task1-textarea"
          rows={4}
          value={personaText}
          onChange={(event) => setPersonaText(event.target.value)}
        />
        <div className="admin-block-actions">
          <button
            className="admin-button"
            disabled={personaLoading}
            onClick={async () => {
              const round = Number(personaRound);
              if (!Number.isInteger(round) || round < 1) {
                setPersonaError('round 必须是正整数');
                return;
              }
              setPersonaLoading(true);
              setPersonaError('');
              try {
                setPersonaResult(
                  await adminApi.task1PersonaRun({
                    role: personaRole,
                    word: personaWord,
                    round,
                    publicDescriptions: parseDescriptionLines(personaText),
                  }),
                );
              } catch (runError) {
                setPersonaError(runError instanceof Error ? runError.message : 'Persona 对比运行失败');
              } finally {
                setPersonaLoading(false);
              }
            }}
          >
            {personaLoading ? '运行中（真实模型 · 8 次调用）…' : '运行真实 Persona 对比'}
          </button>
          <span className="admin-note">
            默认展示最近一次真实 persona-probe 证据快照；点按钮用当前输入重跑
          </span>
        </div>
        {personaError && <div className="admin-error">{personaError}</div>}
        <p className="admin-note">{personas.scenario}</p>
        <div className="admin-persona-grid">
          {personas.cases.map((item) => (
            <PersonaCard
              key={item.personaId}
              item={item}
              onViewPrompt={personaResult ? () => setPersonaPromptCase(item as PersonaRunCase) : undefined}
            />
          ))}
        </div>
        {personaPromptCase && <PersonaPromptPanel persona={personaPromptCase} />}
        <p className="admin-note">
          {personaResult
            ? `本次运行：${personaResult.generatedAt} · ${personaResult.model}`
            : `证据快照：${evidence.persona.generatedAt} · ${evidence.persona.model} · ${evidence.persona.command}`}
          ；同一局面下四个 Persona 的描述、投票目标与理由均不同。
        </p>
      </div>
      </>
      )}

      {tab === 'quality' && (
      <>
      <h2 className="admin-task1-section-title">C · Quality Gate（不合格描述不会推进游戏）</h2>
      <div className="admin-block admin-task1-card">
        <div className="admin-block-actions">
          <button
            className="admin-button quiet"
            onClick={() => {
              setAttempt1('地铁');
              setAttempt2('大家每天都可能接触到它。');
              setAcceptedText('它通常在地下运行');
              setSecretsText('地铁');
            }}
          >
            预设：测试泄题
          </button>
          <button
            className="admin-button quiet"
            onClick={() => {
              setAttempt1('它一般是在地下运行的。');
              setAttempt2('换个角度：大家每天都可能接触到它。');
              setAcceptedText('它通常在地下运行。');
              setSecretsText('地铁');
            }}
          >
            预设：测试雷同
          </button>
          <span className="admin-note">预设只填入输入框；判定始终走真实 Quality Gate</span>
        </div>
        <div className="admin-task1-inputs">
          <label className="admin-field task1-wide">
            <span>Attempt #1 Candidate</span>
            <input value={attempt1} onChange={(event) => setAttempt1(event.target.value)} />
          </label>
          <label className="admin-field task1-wide">
            <span>Attempt #2 Candidate（修复后）</span>
            <input value={attempt2} onChange={(event) => setAttempt2(event.target.value)} />
          </label>
        </div>
        <div className="admin-task1-inputs">
          <label className="admin-field task1-wide">
            <span>本轮已公开描述（每行一条）</span>
            <textarea
              className="admin-task1-textarea"
              rows={3}
              value={acceptedText}
              onChange={(event) => setAcceptedText(event.target.value)}
            />
          </label>
        </div>
        <div className="admin-task1-inputs">
          <label className="admin-field">
            <span>相似度阈值</span>
            <input value={threshold} onChange={(event) => setThreshold(event.target.value)} />
          </label>
          <label className="admin-field">
            <span>禁止公开的密词（逗号分隔）</span>
            <input value={secretsText} onChange={(event) => setSecretsText(event.target.value)} />
          </label>
          <button className="admin-button" disabled={qualityLoading} onClick={runQuality}>
            {qualityLoading ? '检查中…' : '执行 Gate 检查'}
          </button>
        </div>
        {qualityError && <div className="admin-error">{qualityError}</div>}
        {qualityResult && <LiveQualityResult result={qualityResult} initialCount={acceptedCount} />}
      </div>
      </>
      )}
      {tab === 'quality' && (
      <div className="admin-block">
        <h3 className="admin-block-title">默认示例（回归用例，可随时点「执行 Gate 检查」恢复）</h3>
        <QualityGateEvidenceCard evidence={evidence.qualityGate} />
      </div>
      )}
    </div>
  );
}

function SequentialStepDetail({
  step,
  gameId,
  onOpenPrompt,
  onOpenTraceStep,
}: {
  step: SequentialAgentStep;
  gameId: string;
  onOpenPrompt: (filters: PromptFilters) => void;
  onOpenTraceStep: (gameId: string, round: number, agentId: string) => void;
}) {
  return (
    <div className="admin-task1-result">
      <div className="admin-task1-meta">
        <span>
          Agent：{step.agentName} / {step.agentId}
        </span>
        <span>Persona：{step.personaName}</span>
        <span>Round：{step.round}</span>
        <span>sameRoundPublicDescriptionCount：{step.sameRoundPublicDescriptionCount}</span>
        {step.promptVersion && <span>promptVersion：{step.promptVersion}</span>}
        {step.promptHash && (
          <span title={step.promptHash}>promptHash：{step.promptHash.slice(0, 16)}…</span>
        )}
      </div>
      {step.agentId !== 'human' && (
        <>
          <p className="admin-task1-sub">本次调用时已公开的同轮描述（模型实际收到）：</p>
          <div className="admin-task1-descriptions">
            {step.receivedSameRound.map((description) => (
              <div
                className="admin-task1-description"
                key={`${step.agentId}-${description.playerId}-${description.text}`}
              >
                <span className="admin-badge repro-ok">✓</span>
                <strong>
                  {description.playerName}（{description.playerId}）：
                </strong>
                <span>{description.text}</span>
              </div>
            ))}
          </div>
          <div className="admin-block-actions">
            {step.agentId !== 'human' && (
              <button
                className="admin-button"
                onClick={() => onOpenTraceStep(gameId, step.round, step.agentId)}
              >
                查看本次完整 Trace
              </button>
            )}
            <button
              className="admin-button"
              onClick={() =>
                onOpenPrompt({
                  gameId,
                  round: String(step.round),
                  agentId: step.agentId,
                  task: 'describe',
                })
              }
            >
              查看本次 Prompt Trace
            </button>
          </div>
          {step.messages.length > 0 && (
            <details className="admin-raw">
              <summary>Prompt（真实 rendered messages · 已脱敏）</summary>
              {step.messages.map((message, index) => (
                <div key={index}>
                  <span className="admin-badge neutral">{message.role}</span>
                  <pre>{prettyJson(message.content)}</pre>
                </div>
              ))}
            </details>
          )}
        </>
      )}
      <p className="admin-task1-field">
        模型输出 description：<em>“{step.description}”</em>
      </p>
    </div>
  );
}

function extractGuidance(messages: Array<{ role: string; content: string }>): string {
  const user = messages.find((message) => message.role === 'user');
  if (!user) return '(无 user message)';
  try {
    const parsed = JSON.parse(user.content) as { strategy?: { guidance?: string } };
    return parsed.strategy?.guidance ?? '(无 strategy.guidance)';
  } catch {
    return '(无法解析 prompt)';
  }
}

function PersonaPromptPanel({ persona }: { persona: PersonaRunCase }) {
  const guidance = extractGuidance(persona.prompts.describe.messages);
  return (
    <div className="admin-task1-result">
      <div className="admin-task1-meta">
        <span>
          {persona.agentName}｜{persona.personaName}
        </span>
        <span>Risk: {persona.risk}</span>
        <span>strategyId: {persona.personaId}</span>
      </div>
      <p className="admin-task1-sub">Persona 差异（strategy.guidance）：</p>
      <pre className="admin-task1-guidance">{guidance}</pre>
      <details className="admin-raw">
        <summary>Describe Prompt（rendered messages · 已脱敏）</summary>
        {persona.prompts.describe.messages.map((message, index) => (
          <div key={index}>
            <span className="admin-badge neutral">{message.role}</span>
            <pre>{prettyJson(message.content)}</pre>
          </div>
        ))}
        <p className="admin-note">
          promptVersion: {persona.prompts.describe.promptVersion} · promptHash:{' '}
          {persona.prompts.describe.promptHash.slice(0, 16)}…
        </p>
      </details>
      <details className="admin-raw">
        <summary>Vote Prompt（rendered messages · 已脱敏）</summary>
        {persona.prompts.vote.messages.map((message, index) => (
          <div key={index}>
            <span className="admin-badge neutral">{message.role}</span>
            <pre>{prettyJson(message.content)}</pre>
          </div>
        ))}
        <p className="admin-note">
          promptVersion: {persona.prompts.vote.promptVersion} · promptHash:{' '}
          {persona.prompts.vote.promptHash.slice(0, 16)}…
        </p>
      </details>
      <p className="admin-note">
        共同部分：roleObjective / safety / context / output schema 位于 system 与 user 公共字段；差异集中在
        strategy.guidance（观察视角 / 表达风格 / 投票偏向）。
      </p>
    </div>
  );
}

function LiveQualityResult({ result, initialCount }: { result: QualityGateCheckResult; initialCount: number }) {
  const committedCount = result.committed ? initialCount + 1 : initialCount;
  return (
    <div className="admin-task1-result">
      <div className="admin-task1-flow">
        <span className="admin-task1-flow-step">Model Candidate</span>
        <span className="admin-task1-arrow">→</span>
        <span className="admin-task1-flow-step">Quality Gate</span>
        <span className="admin-task1-arrow">→</span>
        <span className="admin-task1-flow-step">Public GameState</span>
      </div>
      {result.attempts.map((attempt, index) => (
        <div key={attempt.attempt}>
          <div className={`admin-gate-step ${attempt.gate === 'REJECTED' ? 'rejected' : 'passed'}`}>
            <div className="admin-gate-step-head">
              <span className="admin-badge neutral">Attempt #{attempt.attempt}</span>
              <span className={`admin-badge ${attempt.gate === 'REJECTED' ? 'trace-bad' : 'repro-ok'}`}>
                Gate: {attempt.gate}
                {attempt.gate === 'PASSED' && ' → COMMITTED'}
              </span>
            </div>
            <p className="admin-task1-field">
              Candidate：<em>“{attempt.candidate}”</em>
            </p>
            {attempt.reason && (
              <p className="admin-task1-field">
                Reason：<code>{attempt.reason}</code>
                {attempt.similarity !== undefined && attempt.threshold !== undefined && (
                  <span>
                    {' '}
                    · similarity {attempt.similarity.toFixed(2)} ≥ threshold {attempt.threshold.toFixed(2)}
                  </span>
                )}
              </p>
            )}
            <p className="admin-task1-field">
              {attempt.gate === 'REJECTED' && attempt.willRetry ? 'willRetry: true → Repair / Retry' : '不进入 GameState'}
            </p>
          </div>
          {index < result.attempts.length - 1 && (
            <div className="admin-task1-repair">
              <span className="admin-task1-arrow">↓</span>
              <span className="admin-note">Repair / Retry</span>
              <span className="admin-task1-arrow">↓</span>
            </div>
          )}
        </div>
      ))}
      <div className="admin-task1-gamestate">
        <strong>Public GameState</strong>
        <div className="admin-task1-gamestate-row">
          {result.notCommitted.map((candidate) => (
            <span className="admin-badge trace-bad" key={candidate}>
              ✕ NOT COMMITTED：“{candidate}”
            </span>
          ))}
          {result.committed && (
            <span className="admin-badge repro-ok">✓ COMMITTED：“{result.committed}”</span>
          )}
        </div>
        {result.notCommitted.length === 0 && (
          <p className="admin-note">两个候选都通过了门禁（都被提交）；把 Attempt #1 改成雷同或含密词即可看到 REJECTED。</p>
        )}
        <p className="admin-task1-sub">状态证明（descriptionCount）：</p>
        <div className="admin-task1-descriptions">
          <div className="admin-task1-description">
            <span className="admin-badge neutral">Before</span>
            <strong>descriptionCount = {initialCount}</strong>
          </div>
          {result.notCommitted.length > 0 && (
            <div className="admin-task1-description">
              <span className="admin-badge trace-bad">Rejected attempt</span>
              <strong>descriptionCount = {initialCount}（未提交）</strong>
            </div>
          )}
          <div className="admin-task1-description">
            <span className="admin-badge repro-ok">Accepted attempt</span>
            <strong>descriptionCount = {committedCount}</strong>
          </div>
        </div>
      </div>
    </div>
  );
}

function SameRoundEvidenceCard({
  evidence,
  onOpenPrompt,
}: {
  evidence: SameRoundEvidence;
  onOpenPrompt: (filters: PromptFilters) => void;
}) {
  return (
    <div className="admin-task1-card">
      <div className="admin-task1-card-head">
        <span className="admin-badge neutral">
          当前 Agent：{evidence.agentName} / {evidence.agentId} / Round {evidence.round}
        </span>
        <span className="admin-trace-time">{new Date(evidence.timestamp).toLocaleTimeString()}</span>
      </div>
      <div className="admin-task1-order">
        {['Human', 'ai-1', 'ai-2', `${evidence.agentId} ← 当前 Agent`].map((item, index, list) => (
          <span className="admin-task1-order-step" key={item}>
            {item}
            {index < list.length - 1 && <span className="admin-task1-arrow">↓</span>}
          </span>
        ))}
      </div>
      <p className="admin-task1-sub">ai-3 实际收到的同轮 publicDescriptions：</p>
      <div className="admin-task1-descriptions">
        {evidence.sameRoundDescriptions.map((description) => (
          <div className="admin-task1-description" key={`${description.playerId}-${description.text}`}>
            <span className="admin-badge repro-ok">✓</span>
            <strong>{description.playerName}（{description.playerId}）：</strong>
            <span>{description.text}</span>
          </div>
        ))}
      </div>
      <div className="admin-task1-meta">
        <span>sameRoundPublicDescriptions = {evidence.sameRoundPublicDescriptionCount}</span>
        <span>publicDescriptionCount = {evidence.publicDescriptionCount}</span>
        <span>promptVersion = {evidence.promptVersion}</span>
        <span title={evidence.promptHash}>promptHash = {evidence.promptHash.slice(0, 16)}…</span>
        <span title={evidence.gameId}>gameId = {evidence.gameId.slice(0, 8)}…</span>
      </div>
      <div className="admin-block-actions">
        <button
          className="admin-button"
          onClick={() =>
            onOpenPrompt({
              gameId: evidence.gameId,
              round: String(evidence.round),
              agentId: evidence.agentId,
              task: 'describe',
            })
          }
        >
          查看 Prompt Trace
        </button>
      </div>
      <p className="admin-note">来源：真实 prompt provenance（sanitized 模型输入，密词已脱敏）——这是模型实际收到的上下文，不是概念图。</p>
    </div>
  );
}

function PersonaCard({ item, onViewPrompt }: { item: PersonaProbeCase; onViewPrompt?: () => void }) {
  return (
    <article className="admin-persona-card">
      <div className="admin-persona-card-head">
        <strong>
          {item.agentName}｜{item.personaName}
        </strong>
        <span className={`admin-badge risk-${item.risk.toLowerCase()}`}>{item.risk}</span>
      </div>
      <p className="admin-persona-focus">{item.strategyFocus}</p>
      <p className="admin-persona-field">
        <span className="admin-persona-label">description</span>
        <em>“{item.description}”</em>
      </p>
      <p className="admin-persona-field">
        <span className="admin-persona-label">vote</span>
        <strong>{item.voteTarget}</strong>
      </p>
      <p className="admin-persona-field">
        <span className="admin-persona-label">reason</span>
        <span>{item.reason}</span>
      </p>
      {onViewPrompt && (
        <div className="admin-block-actions">
          <button className="admin-button quiet" onClick={onViewPrompt}>
            查看 Prompt
          </button>
        </div>
      )}
    </article>
  );
}

function QualityGateEvidenceCard({ evidence }: { evidence: QualityGateEvidence }) {
  const first = evidence.attempts[0];
  const second = evidence.attempts[1];
  return (
    <div className="admin-task1-card">
      <div className="admin-task1-flow">
        <span className="admin-task1-flow-step">Model Candidate</span>
        <span className="admin-task1-arrow">→</span>
        <span className="admin-task1-flow-step">Quality Gate</span>
        <span className="admin-task1-arrow">→</span>
        <span className="admin-task1-flow-step">Public GameState</span>
      </div>

      {first && (
        <div className="admin-gate-step rejected">
          <div className="admin-gate-step-head">
            <span className="admin-badge trace-bad">Attempt #{first.attempt}</span>
            <span className="admin-badge trace-warn">Gate: REJECTED</span>
          </div>
          <p className="admin-task1-field">
            Candidate：<em>“{first.candidate}”</em>
          </p>
          <p className="admin-task1-field">
            Reason：<code>{first.reason}</code>
            {first.similarity !== undefined && first.threshold !== undefined && (
              <span>
                {' '}
                · similarity {first.similarity.toFixed(2)} ≥ threshold {first.threshold.toFixed(2)}
              </span>
            )}
          </p>
          <p className="admin-task1-field">willRetry: {first.willRetry ? 'true → Repair / Retry' : 'false'}</p>
        </div>
      )}

      <div className="admin-task1-repair">
        <span className="admin-task1-arrow">↓</span>
        <span className="admin-note">Repair / Retry（携带 repair 指导重新生成）</span>
        <span className="admin-task1-arrow">↓</span>
      </div>

      {second && (
        <div className="admin-gate-step passed">
          <div className="admin-gate-step-head">
            <span className="admin-badge neutral">Attempt #{second.attempt}</span>
            <span className="admin-badge repro-ok">Gate: PASSED → COMMITTED</span>
          </div>
          <p className="admin-task1-field">
            Candidate：<em>“{second.candidate}”</em>
          </p>
        </div>
      )}

      <div className="admin-task1-gamestate">
        <strong>Public GameState（{evidence.agent} · Round {evidence.round}）</strong>
        <div className="admin-task1-gamestate-row">
          <span className="admin-badge trace-bad">Attempt #1 ✕ NOT COMMITTED</span>
          <span className="admin-badge repro-ok">Attempt #2 ✓ COMMITTED</span>
        </div>
        <p className="admin-note">{evidence.gameStateProof}</p>
        <p className="admin-note">
          来源：<code>{evidence.source}</code>。{evidence.sourceNote}
        </p>
      </div>
    </div>
  );
}

const M6_CANONICAL = {
  baselineCommit: '7d98e19',
  finalCommit: '49eb39d',
  seeds: '101–105',
  games: '5 vs 5',
  model: 'deepseek-v4-flash',
  baselineReport: {
    branch: 'eval/m1-real-smoke',
    commit: '2d3ee69',
    path: 'docs/evidence/m1-baseline/summary.md',
    label: 'Baseline Report',
  },
  finalReport: {
    branch: 'eval/m6-final-comparison',
    commit: '9d1a285',
    path: 'docs/evidence/m6-final-comparison/summary.md',
    label: 'Final Comparison Report',
  },
};

const GITHUB_BASE = 'https://github.com/ppipil/who-is-spy/blob';

function reportUrl(report: { commit: string; path: string }): string {
  return `${GITHUB_BASE}/${report.commit}/${report.path}`;
}

type CanonicalRow = {
  label: string;
  baseline: (data: EvaluationData) => string;
  final: (data: EvaluationData) => string;
  delta: (data: EvaluationData) => number | null;
  better: 'up' | 'down' | 'neutral';
};

const CANONICAL_ROWS: CanonicalRow[] = [
  {
    label: '对局完成率',
    baseline: (d) => `${(d.baseline.completionRate * 100).toFixed(0)}%`,
    final: (d) => `${(d.final.completionRate * 100).toFixed(0)}%`,
    delta: (d) => d.final.completionRate - d.baseline.completionRate,
    better: 'up',
  },
  {
    label: '有效投票率',
    baseline: (d) => `${(d.baseline.validVoteRate * 100).toFixed(0)}%`,
    final: (d) => `${(d.final.validVoteRate * 100).toFixed(0)}%`,
    delta: (d) => d.final.validVoteRate - d.baseline.validVoteRate,
    better: 'neutral',
  },
  {
    label: '非法输出率',
    baseline: (d) => `${(d.baseline.invalidOutputRate * 100).toFixed(2)}%`,
    final: (d) => `${(d.final.invalidOutputRate * 100).toFixed(2)}%`,
    delta: (d) => d.final.invalidOutputRate - d.baseline.invalidOutputRate,
    better: 'down',
  },
  {
    label: '直接泄露密词',
    baseline: (d) => String(d.baseline.descriptionExactSecretLeaks),
    final: (d) => String(d.final.descriptionExactSecretLeaks),
    delta: (d) => (d.final.descriptionExactSecretLeaks as number) - (d.baseline.descriptionExactSecretLeaks as number),
    better: 'neutral',
  },
  {
    label: '描述字面雷同度',
    baseline: (d) => d.baseline.descriptionHomogeneity.toFixed(4),
    final: (d) => d.final.descriptionHomogeneity.toFixed(4),
    delta: (d) => d.final.descriptionHomogeneity - d.baseline.descriptionHomogeneity,
    better: 'down',
  },
  {
    label: 'P50 延迟',
    baseline: (d) => `${Math.round(d.baseline.latencyMs.p50)} ms`,
    final: (d) => `${Math.round(d.final.latencyMs.p50)} ms`,
    delta: (d) => d.final.latencyMs.p50 - d.baseline.latencyMs.p50,
    better: 'down',
  },
  {
    label: 'P95 延迟',
    baseline: (d) => `${Math.round(d.baseline.latencyMs.p95)} ms`,
    final: (d) => `${Math.round(d.final.latencyMs.p95)} ms`,
    delta: (d) => d.final.latencyMs.p95 - d.baseline.latencyMs.p95,
    better: 'down',
  },
  {
    label: 'Token / 局',
    baseline: (d) => d.baseline.tokensPerGame.toFixed(1),
    final: (d) => d.final.tokensPerGame.toFixed(1),
    delta: (d) => d.final.tokensPerGame - d.baseline.tokensPerGame,
    better: 'down',
  },
  {
    label: '估算成本 / 局',
    baseline: (d) => `$${d.baseline.costPerGame.toFixed(4)}`,
    final: (d) => `$${d.final.costPerGame.toFixed(4)}`,
    delta: (d) => d.final.costPerGame - d.baseline.costPerGame,
    better: 'down',
  },
  {
    label: 'Provider Retry',
    baseline: (d) => String(d.baseline.providerRetryCount),
    final: (d) => String(d.final.providerRetryCount),
    delta: (d) => d.final.providerRetryCount - d.baseline.providerRetryCount,
    better: 'down',
  },
  {
    label: 'Quality Repair',
    baseline: (d) => String(d.baseline.qualityRepairCount),
    final: (d) => String(d.final.qualityRepairCount),
    delta: (d) => d.final.qualityRepairCount - d.baseline.qualityRepairCount,
    better: 'neutral',
  },
];

function BaselineFinalModule({ data }: { data: EvaluationData }) {
  return (
    <section className="admin-task2-module">
      <h2 className="admin-task2-module-title">Baseline vs Final</h2>
      <p className="admin-note">
        使用相同评测设置，对官方 Baseline 和 Core Final 做真实模型对照测试（M6 canonical evidence，不重新计算、不伪造）。
      </p>
      <div className="admin-task2-meta">
        <span className="admin-badge neutral">Baseline commit: {M6_CANONICAL.baselineCommit}</span>
        <span className="admin-badge neutral">Core Final commit: {M6_CANONICAL.finalCommit}</span>
        <span className="admin-badge neutral">Seeds: {M6_CANONICAL.seeds}</span>
        <span className="admin-badge neutral">Games: {M6_CANONICAL.games}</span>
        <span className="admin-badge neutral">模型: {M6_CANONICAL.model}（同一套设置）</span>
      </div>
      <table className="admin-table">
        <thead>
          <tr>
            <th>指标</th>
            <th>Baseline</th>
            <th>Final</th>
            <th>Δ</th>
          </tr>
        </thead>
        <tbody>
          {CANONICAL_ROWS.map((row) => {
            const delta = row.delta(data);
            const worse = row.better === 'up' ? (delta ?? 0) < 0 : (delta ?? 0) > 0;
            const improved = row.better === 'up' ? (delta ?? 0) > 0 : (delta ?? 0) < 0;
            const tone = row.better === 'neutral' || delta === null || delta === 0 ? '' : worse ? 'delta-bad' : improved ? 'delta-good' : '';
            return (
              <tr key={row.label}>
                <td>{row.label}</td>
                <td>{row.baseline(data)}</td>
                <td>{row.final(data)}</td>
                <td className={tone}>{delta === null ? '—' : `${delta > 0 ? '+' : ''}${formatDelta(delta)}`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="admin-note">
        “描述字面雷同度” = lexical homogeneity（字符 bigram + Dice 词面代理），不是 semantic diversity / 语义多样性。
        Final 完成率 80% 为真实结果，未美化。
      </p>

      <div className="admin-task2-conclusion">
        <div className="admin-task2-tradeoff gain">
          <h3>收益</h3>
          <ul>
            <li>描述字面重复明显降低（0.0640 → 0.0107）</li>
            <li>有效投票率保持 100%</li>
            <li>密词直接泄露保持 0</li>
          </ul>
        </div>
        <div className="admin-task2-tradeoff cost">
          <h3>代价 / Bad Case</h3>
          <ul>
            <li>延迟上升（p50 6079 → 10236 ms；p95 36630 → 58343 ms）</li>
            <li>Token / 成本上升（21765.6 → 27251.2 / 局；$0.0162 → $0.0215 / 局）</li>
            <li>完成率 80%：Final 5 局中有 1 局因真实 description timeout 未完成</li>
            <li>该 Bad Case 后续推动了 Resume / Recovery polish</li>
          </ul>
        </div>
      </div>

      <div className="admin-task2-reports">
        <ReportCard title="Baseline" report={M6_CANONICAL.baselineReport} />
        <ReportCard title="Final" report={M6_CANONICAL.finalReport} />
      </div>
      <p className="admin-note">数据来源：{data.source}</p>
    </section>
  );
}

function ReportCard({
  title,
  report,
}: {
  title: string;
  report: { branch: string; commit: string; path: string; label: string };
}) {
  return (
    <article className="admin-task2-report">
      <strong>{title}</strong>
      <span className="admin-note">branch: {report.branch}</span>
      <span className="admin-note">commit: {report.commit}</span>
      <span className="admin-note">report: {report.path}</span>
      <a className="admin-button" href={reportUrl(report)} target="_blank" rel="noreferrer">
        查看{report.label} ↗
      </a>
    </article>
  );
}

function EvaluationPipeline() {
  const steps = ['固定配置', '批量运行游戏', '采集 Trace / 模型输出', '计算指标', '生成 Report'];
  return (
    <div className="admin-block">
      <h3 className="admin-block-title">Evaluation Pipeline</h3>
      <div className="admin-task2-pipeline">
        {steps.map((step, index) => (
          <span className="admin-task1-flow-step" key={step}>
            {index + 1}. {step}
          </span>
        ))}
      </div>
    </div>
  );
}

const METRICS_CHECKLIST = [
  '对局完成率 completionRate',
  '有效投票率 validVoteRate',
  '非法模型输出率 invalidOutputRate',
  '密词泄露 descriptionExactSecretLeaks',
  '描述字面雷同度 descriptionHomogeneity',
  'P50 / P95 延迟 latencyMs',
  'Token 消耗 tokenUsage',
  '估算成本 cost',
  'Provider Retry providerRetryCount',
  'Quality Repair qualityRepairCount',
];

function MetricsChecklist() {
  return (
    <div className="admin-block">
      <h3 className="admin-block-title">评测覆盖指标</h3>
      <div className="admin-task2-checklist">
        {METRICS_CHECKLIST.map((item) => (
          <span className="admin-badge repro-ok" key={item}>
            ✓ {item}
          </span>
        ))}
      </div>
    </div>
  );
}

function Runbook() {
  const commands = [
    {
      step: '1. 确定性回归（fake · 零成本 · 固定 seed）',
      code: 'npm run eval:node -- --games 20 --seed 42 --model fake',
    },
    {
      step: '2. 真实模型评测（需要 DEEPSEEK_API_KEY；M6 设置 = seeds 101–105 各 1 局）',
      code: 'npm run eval:node -- --games 1 --seed 101 --model real',
    },
    {
      step: '3. 门禁：质量指标越过阈值时评测非 0 退出',
      code: 'npm run eval:node -- --games 1 --seed 101 --model real; echo $LASTEXITCODE',
    },
    {
      step: '4. 结果落盘（stdout 为 schema-versioned JSON，可机器读取）',
      code: 'npm run eval:node -- --games 20 --seed 42 --model fake > eval-report.json',
    },
    {
      step: '5. 回归门禁：测试 / 契约 / 构建',
      code: 'npm run test:node && npm run contract:node && npm run build',
    },
  ];
  return (
    <div className="admin-block">
      <h3 className="admin-block-title">如何重复运行（Runbook · 真实命令）</h3>
      {commands.map((item) => (
        <div className="admin-task2-command" key={item.step}>
          <p>{item.step}</p>
          <pre>{item.code}</pre>
        </div>
      ))}
      <p className="admin-note">
        M6 的 Baseline vs Final 对照实验使用 <code>eval/m6-final-comparison</code> 分支的{' '}
        <code>m6:compare</code>（同一 Harness 驱动 baseline worktree 与 final，seeds 101–105、两侧交替执行、word setup
        逐 seed 校验）；完整命令见该分支的 <code>docs/evidence/m6-final-comparison/summary.md</code>。
      </p>
    </div>
  );
}

function PromptTracePanel({ initialFilters }: { initialFilters: PromptFilters }) {
  const [filters, setFilters] = useState<PromptFilters>(initialFilters);
  const [records, setRecords] = useState<PromptTraceRecord[]>([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback((next?: typeof filters) => {
    const params = next ?? filters;
    setLoading(true);
    setError('');
    adminApi
      .promptTraces(params)
      .then((result) => {
        setRecords(result.records);
        setCount(result.count);
      })
      .catch((loadError: unknown) => setError(loadError instanceof Error ? loadError.message : '加载失败'))
      .finally(() => setLoading(false));
  }, [filters]);

  useEffect(() => {
    setFilters(initialFilters);
    load(initialFilters);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFilters]);

  useEffect(() => {
    const timer = setInterval(() => load(), AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <div className="admin-panel">
      <div className="admin-filters">
        <FilterInput label="gameId" value={filters.gameId} onChange={(value) => setFilters({ ...filters, gameId: value })} />
        <FilterInput label="round" value={filters.round} onChange={(value) => setFilters({ ...filters, round: value })} />
        <FilterInput label="agentId" value={filters.agentId} onChange={(value) => setFilters({ ...filters, agentId: value })} />
        <FilterInput label="task" value={filters.task} onChange={(value) => setFilters({ ...filters, task: value })} />
        <button className="admin-button" onClick={() => load()}>应用筛选</button>
        <button
          className="admin-button quiet"
          onClick={() => {
            const empty = { gameId: '', round: '', agentId: '', task: '' };
            setFilters(empty);
            load(empty);
          }}
        >
          重置
        </button>
      </div>

      {error && <div className="admin-error">{error}</div>}
      {loading ? (
        <div className="admin-skeleton-list">
          {[0, 1].map((item) => (
            <div className="admin-skeleton" key={item} />
          ))}
        </div>
      ) : records.length === 0 ? (
        <div className="admin-empty">
          <p>没有匹配的 prompt provenance。开一局游戏后，每次模型调用都会记录一条（含脱敏输入；每 5 分钟自动刷新，或点击“应用筛选”立即刷新）。</p>
        </div>
      ) : (
        <>
          <p className="admin-count">{count} 条 provenance（最近 200 条）</p>
          <div className="admin-prompt-list">
            {records.map((record, index) => (
              <PromptTraceCard key={`${record.gameId}-${record.round}-${record.agentId}-${record.promptHash}-${index}`} record={record} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function PromptTraceCard({ record }: { record: PromptTraceRecord }) {
  const [copied, setCopied] = useState(false);
  const personaName = record.strategyId ? PERSONA_NAMES[record.strategyId] ?? record.strategyId : '—';
  const personaSummary = record.strategyId ? PERSONA_SUMMARY[record.strategyId] : '';

  const copyHash = async () => {
    try {
      await navigator.clipboard.writeText(record.promptHash);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };

  return (
    <article className="admin-prompt-card">
      <div className="admin-prompt-head">
        <span className="admin-badge neutral">{record.task}</span>
        <span className="admin-prompt-title">
          {record.strategyId ? `${PERSONA_NAMES[record.strategyId] ?? record.strategyId} · ` : ''}
          {record.gameId} · R{record.round} · {record.agentId}
        </span>
        <span className="admin-prompt-time">{new Date(record.timestamp).toLocaleTimeString()}</span>
      </div>
      <div className="admin-prompt-meta">
        <MetaItem label="Persona" value={personaName} badge />
        <MetaItem label="Role" value={record.role ?? '—'} />
        <MetaItem label="Prompt Version" value={record.promptTemplateVersion} />
        <MetaItem label="Model" value="deepseek-v4-flash" />
        <MetaItem label="Temperature" value="0.8" />
        <MetaItem label="Same-round descriptions" value={String(record.sameRoundPublicDescriptionCount)} />
        <MetaItem label="Prompt Hash" value={`${record.promptHash.slice(0, 12)}…`} copy onClick={copyHash} copied={copied} />
      </div>
      {personaSummary && <p className="admin-prompt-persona">Persona：{personaName} · {personaSummary}</p>}
      <details className="admin-raw">
        <summary>Sanitized Model Input</summary>
        {record.messages.map((message, index) => (
          <div className="admin-prompt-message" key={index}>
            <span className="admin-badge neutral">{message.role}</span>
            <pre>{prettyJson(message.content)}</pre>
          </div>
        ))}
      </details>
    </article>
  );
}

function MetaItem({
  label,
  value,
  badge = false,
  copy = false,
  onClick,
  copied = false,
}: {
  label: string;
  value: string;
  badge?: boolean;
  copy?: boolean;
  onClick?: () => void;
  copied?: boolean;
}) {
  return (
    <div className="admin-meta-item">
      <span className="admin-meta-label">{PROMPT_FIELD_LABELS[label] ?? label}</span>
      {badge ? <span className="admin-badge neutral">{value}</span> : <span className="admin-meta-value">{value}</span>}
      {copy && (
        <button className="admin-copy" onClick={onClick}>
          {copied ? 'copied' : 'copy'}
        </button>
      )}
    </div>
  );
}

function FilterInput({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="admin-field">
      <span>{label}</span>
      <input
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function prettyJson(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}
