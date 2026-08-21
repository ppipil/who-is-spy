import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  adminApi,
  PERSONA_NAMES,
  type GameVotesPayload,
  type PromptTraceRecord,
  type RuntimeEvent,
} from './adminApi';
import {
  buildTraceSessions,
  filterSessionsByKeyword,
  mergeVoteOutputs,
  MODEL_LABELS,
  sessionOrigin,
  SOURCE_LABELS,
  type TraceObservation,
} from './traceTree';
import './admin.css';

const AUTO_REFRESH_MS = 300_000;

export type TraceFilters = {
  gameId: string;
  round: string;
  agent: string;
  task: string;
  errorType: string;
  runId: string;
};

export interface TraceSelection {
  gameId?: string;
  round?: string;
  agentId?: string;
}

function prettyJson(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}

function fmtDuration(ms: number): string {
  if (!ms) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function findNode(tree: TraceObservation, predicate: (node: TraceObservation) => boolean): TraceObservation | null {
  if (predicate(tree)) return tree;
  for (const child of tree.children) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  return null;
}

function ancestorIds(tree: TraceObservation, targetId: string): string[] {
  if (tree.id === targetId) return [];
  for (const child of tree.children) {
    const path = ancestorIds(child, targetId);
    if (path !== null) return [tree.id, ...path];
  }
  return [];
}

function StatusIcon({ status }: { status: string }) {
  const label = status === 'ok' ? '✓' : status === 'fail' ? '✕' : status === 'warn' ? '↻' : '·';
  return <span className={`admin-badge trace-${status}`}>{label}</span>;
}

function NodeBadge({ kind, status }: { kind: string; status: string }) {
  const labels: Record<string, string> = {
    human: 'HUMAN',
    agent: 'AGENT',
    generation: 'GENERATION',
    quality_gate: 'GATE',
    retry: 'RETRY',
    commit: 'COMMIT',
    atomic_commit: 'COMMIT',
    resume: 'RESUME',
    error: 'ERROR',
    fallback: 'FALLBACK',
    event: 'TRACE',
    review: 'REVIEW',
  };
  const tone = status === 'ok' ? 'ok' : status === 'fail' ? 'bad' : status === 'warn' ? 'warn' : 'neutral';
  return <span className={`admin-badge trace-${tone}`}>{labels[kind] ?? kind}</span>;
}

function parseUserPayload(content: string): Record<string, unknown> | null {
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function TraceView({
  initialFilters,
  initialSelection,
  onOpenPrompt,
}: {
  initialFilters: TraceFilters;
  initialSelection?: TraceSelection | null;
  onOpenPrompt: (filters: { gameId: string; round: string; agentId: string; task: string }) => void;
}) {
  const [filters, setFilters] = useState<TraceFilters>(initialFilters);
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [prompts, setPrompts] = useState<PromptTraceRecord[]>([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [keyword, setKeyword] = useState('');
  const [votesByGame, setVotesByGame] = useState<Map<string, GameVotesPayload>>(new Map());
  const [traceRound, setTraceRound] = useState('');
  const [traceTask, setTraceTask] = useState('');
  const [traceStatus, setTraceStatus] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [modelFilter, setModelFilter] = useState('');
  const appliedSelection = useRef(false);

  const load = useCallback(
    async (next?: TraceFilters) => {
      const params = next ?? filters;
      setLoading(true);
      setError('');
      try {
        const [traceResult, promptResult] = await Promise.all([
          adminApi.traces({ gameId: params.gameId || undefined, runId: params.runId || undefined }),
          adminApi.promptTraces({}),
        ]);
        setEvents(traceResult.events);
        setCount(traceResult.count);
        setPrompts(promptResult.records);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : '加载失败');
      } finally {
        setLoading(false);
      }
    },
    [filters],
  );

  useEffect(() => {
    setFilters(initialFilters);
    load(initialFilters);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFilters]);

  useEffect(() => {
    const timer = setInterval(() => load(), AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const allSessions = useMemo(() => mergeVoteOutputs(buildTraceSessions(events, prompts), votesByGame), [
    events,
    prompts,
    votesByGame,
  ]);
  const sessions = useMemo(() => {
    let list = filterSessionsByKeyword(allSessions, keyword);
    if (sourceFilter) list = list.filter((session) => sessionOrigin(session).sourceType === sourceFilter);
    if (modelFilter) list = list.filter((session) => sessionOrigin(session).modelKind === modelFilter);
    return list;
  }, [allSessions, keyword, sourceFilter, modelFilter]);
  const session = sessions.find((item) => item.id === selectedSessionId) ?? sessions[0] ?? null;

  useEffect(() => {
    if (sessions.length === 0) return;
    const sessionExists = sessions.some((item) => item.id === selectedSessionId);
    if (!sessionExists) {
      setSelectedSessionId(sessions[0].id);
      setSelectedTraceId(sessions[0].traces[0]?.id ?? null);
      setSelectedNodeId(null);
      return;
    }
    const current = sessions.find((item) => item.id === selectedSessionId);
    const traceExists = current?.traces.some((trace) => trace.id === selectedTraceId);
    if (!traceExists) {
      setSelectedTraceId(current?.traces[0]?.id ?? null);
      setSelectedNodeId(null);
    }
  }, [sessions, selectedSessionId, selectedTraceId]);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    adminApi
      .gameVotes(session.id)
      .then((payload) => {
        if (cancelled) return;
        setVotesByGame((current) => {
          const next = new Map(current);
          next.set(session.id, payload);
          return next;
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [session?.id]);

  useEffect(() => {
    if (!initialSelection?.gameId || appliedSelection.current) return;
    const target = sessions.find((item) => item.id === initialSelection.gameId);
    if (!target || target.traces.length === 0) return;
    const round = Number(initialSelection.round);
    const trace =
      target.traces.find((item) => item.task === 'description' && item.round === round) ?? target.traces[0];
    setSelectedSessionId(target.id);
    setSelectedTraceId(trace.id);
    if (initialSelection.agentId) {
      const node = findNode(
        trace.tree,
        (candidate) =>
          candidate.event?.agentId === initialSelection.agentId ||
          candidate.title.includes(String(initialSelection.agentId)),
      );
      if (node) {
        setSelectedNodeId(node.id);
        const ancestors = ancestorIds(trace.tree, node.id);
        setCollapsed((current) => {
          const next = new Set(current);
          for (const id of ancestors) next.delete(id);
          return next;
        });
      }
    }
    appliedSelection.current = true;
  }, [sessions, initialSelection]);

  const visibleTraces = useMemo(() => {
    if (!session) return [];
    return session.traces.filter((trace) => {
      if (traceRound && String(trace.round ?? '') !== traceRound) return false;
      if (traceTask && trace.task !== traceTask) return false;
      if (traceStatus && trace.status !== traceStatus) return false;
      return true;
    });
  }, [session, traceRound, traceTask, traceStatus]);

  const selectedTrace = session?.traces.find((item) => item.id === selectedTraceId) ?? null;
  const selectedNode = selectedTrace
    ? findNode(selectedTrace.tree, (node) => node.id === selectedNodeId)
    : null;

  const toggleCollapse = (id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="admin-panel">
      <div className="admin-trace3">
        <aside className="admin-trace-col">
          <FilterInput label="关键词" value={keyword} onChange={setKeyword} placeholder="如 电影 / 高铁" />
          <div className="admin-trace-filters">
            <select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)}>
              <option value="">全部来源</option>
              {Object.entries(SOURCE_LABELS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
            <select value={modelFilter} onChange={(event) => setModelFilter(event.target.value)}>
              <option value="">全部模型</option>
              <option value="real">Real</option>
              <option value="fake">Fake</option>
              <option value="none">无模型</option>
            </select>
          </div>
          <div className="admin-filters">
            <FilterInput label="gameId" value={filters.gameId} onChange={(value) => setFilters({ ...filters, gameId: value })} />
            <FilterInput label="runId" value={filters.runId} onChange={(value) => setFilters({ ...filters, runId: value })} />
            <button className="admin-button" onClick={() => load()}>
              刷新
            </button>
          </div>
          {error && <div className="admin-error">{error}</div>}
          <div className="admin-trace-session-list">
            {sessions.map((item) => (
              <button
                key={item.id}
                className={`admin-trace-session ${session?.id === item.id ? 'is-active' : ''}`}
                onClick={() => {
                  setSelectedSessionId(item.id);
                  setSelectedTraceId(item.traces[0]?.id ?? null);
                  setSelectedNodeId(null);
                }}
              >
                <span>{item.id.slice(0, 8)}…</span>
                <span className="admin-trace-session-meta">
                  <span className="admin-note">
                    {(() => {
                      const origin = sessionOrigin(item);
                      return origin.sourceType
                        ? `${SOURCE_LABELS[origin.sourceType] ?? origin.sourceType} · ${MODEL_LABELS[origin.modelKind ?? ''] ?? '—'}`
                        : '未标记';
                    })()}
                  </span>
                  <span className="admin-note">{item.traces.length} traces</span>
                </span>
              </button>
            ))}
          </div>
          {session && (
            <>
              <div className="admin-trace-sub">
                Game Session · {session.id.slice(0, 8)}…
                {(() => {
                  const origin = sessionOrigin(session);
                  return origin.sourceType ? (
                    <span className="admin-badge neutral">
                      {SOURCE_LABELS[origin.sourceType] ?? origin.sourceType} · {MODEL_LABELS[origin.modelKind ?? ''] ?? '—'}
                    </span>
                  ) : null;
                })()}
              </div>
              <div className="admin-trace-filters">
                <select value={traceRound} onChange={(event) => setTraceRound(event.target.value)}>
                  <option value="">全部 Round</option>
                  {[...new Set(session.traces.map((trace) => String(trace.round ?? '')).filter(Boolean))].map((round) => (
                    <option key={round} value={round}>
                      R{round}
                    </option>
                  ))}
                </select>
                <select value={traceTask} onChange={(event) => setTraceTask(event.target.value)}>
                  <option value="">全部任务</option>
                  <option value="description">Description</option>
                  <option value="vote">Vote</option>
                  <option value="review">Review</option>
                  <option value="resume">Resume</option>
                </select>
                <select value={traceStatus} onChange={(event) => setTraceStatus(event.target.value)}>
                  <option value="">全部状态</option>
                  <option value="ok">成功</option>
                  <option value="fail">失败</option>
                  <option value="warn">重试/降级</option>
                </select>
              </div>
              <div className="admin-trace-list">
                {visibleTraces.map((trace) => (
                  <button
                    key={trace.id}
                    className={`admin-trace-row ${selectedTrace?.id === trace.id ? 'is-active' : ''}`}
                    onClick={() => {
                      setSelectedTraceId(trace.id);
                      setSelectedNodeId(null);
                    }}
                  >
                    <StatusIcon status={trace.status} />
                    <span>{trace.name}</span>
                    <span className="admin-note">{fmtDuration(trace.durationMs)}</span>
                  </button>
                ))}
                {visibleTraces.length === 0 && (
                  <p className="admin-note">当前筛选下没有 Trace</p>
                )}
              </div>
            </>
          )}
        </aside>

        <section className="admin-trace-col admin-trace-tree-col">
          {loading && !selectedTrace ? (
            <div className="admin-skeleton-list">
              {[0, 1, 2].map((item) => (
                <div className="admin-skeleton" key={item} />
              ))}
            </div>
          ) : selectedTrace ? (
            <TraceTree
              node={selectedTrace.tree}
              depth={0}
              collapsed={collapsed}
              selectedNodeId={selectedNodeId}
              onToggle={toggleCollapse}
              onSelect={setSelectedNodeId}
            />
          ) : (
            <div className="admin-empty">
              <p>没有可用的 Trace。先开一局游戏，事件会自动按 Session / Trace / Observation 组织。</p>
            </div>
          )}
        </section>

        <aside className="admin-trace-col admin-trace-detail-col">
          {selectedNode ? (
            <TraceNodeDetail
              node={selectedNode}
              gameId={session?.id}
              onOpenPrompt={onOpenPrompt}
            />
          ) : (
            <div className="admin-empty">
              <p>点击中间树上的节点，右侧查看该节点自己的 Input / Output / Metadata。</p>
            </div>
          )}
        </aside>
      </div>
      <p className="admin-count">
        共 {count} 条事件 · {keyword.trim() ? `关键词命中 ${sessions.reduce((sum, item) => sum + item.traces.length, 0)} 条 Trace` : ''}{' '}
        · Session / Trace / Observation 视图（服务重启后内存清空）
      </p>
    </div>
  );
}

function TraceTree({
  node,
  depth,
  collapsed,
  selectedNodeId,
  onToggle,
  onSelect,
}: {
  node: TraceObservation;
  depth: number;
  collapsed: Set<string>;
  selectedNodeId: string | null;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
}) {
  const defaultExpanded = depth === 0 || node.kind === 'agent' || node.kind === 'event';
  const isExpanded = collapsed.has(node.id) ? false : defaultExpanded;
  const hasChildren = node.children.length > 0;
  return (
    <div className="admin-tree-node" style={{ paddingLeft: depth * 14 }}>
      <button
        className={`admin-tree-row ${selectedNodeId === node.id ? 'is-selected' : ''}`}
        onClick={() => {
          onSelect(node.id);
          if (hasChildren) onToggle(node.id);
        }}
      >
        <span className="admin-tree-caret">{hasChildren ? (isExpanded ? '▾' : '▸') : '·'}</span>
        <NodeBadge kind={node.kind} status={node.status} />
        <span className="admin-tree-title">{node.title}</span>
        {node.durationMs !== undefined && node.durationMs > 0 && (
          <span className="admin-note">{fmtDuration(node.durationMs)}</span>
        )}
      </button>
      {hasChildren && isExpanded && (
        <div className="admin-tree-children">
          {node.children.map((child) => (
            <TraceTree
              key={child.id}
              node={child}
              depth={depth + 1}
              collapsed={collapsed}
              selectedNodeId={selectedNodeId}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TraceNodeDetail({
  node,
  gameId,
  onOpenPrompt,
}: {
  node: TraceObservation;
  gameId?: string;
  onOpenPrompt: (filters: { gameId: string; round: string; agentId: string; task: string }) => void;
}) {
  if (node.kind === 'generation' || node.kind === 'review') {
    return <GenerationDetail node={node} gameId={gameId} onOpenPrompt={onOpenPrompt} />;
  }
  if (node.kind === 'quality_gate') return <QualityGateDetail node={node} />;
  if (node.kind === 'retry') return <RetryDetail node={node} />;
  if (node.kind === 'commit') return <CommitDetail node={node} />;
  if (node.kind === 'atomic_commit') return <AtomicCommitDetail node={node} />;
  if (node.kind === 'resume') return <ResumeDetail node={node} />;
  if (node.kind === 'agent') return <AgentDetail node={node} />;
  return <TextDetail title={node.title} text={node.detail} />;
}

function DetailCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="admin-trace-detail-block">
      <h4>{title}</h4>
      {children}
    </div>
  );
}

function GenerationDetail({
  node,
  gameId,
  onOpenPrompt,
}: {
  node: TraceObservation;
  gameId?: string;
  onOpenPrompt: (filters: { gameId: string; round: string; agentId: string; task: string }) => void;
}) {
  const event = node.event;
  const prompt = node.prompt;
  const task = String(event?.task ?? '');
  const user = prompt?.messages.find((message) => message.role === 'user');
  const system = prompt?.messages.find((message) => message.role === 'system');
  const payload = user ? parseUserPayload(user.content) : null;
  const context = isRecord(payload?.context) ? payload.context : null;
  const game = isRecord(context?.game) ? context.game : null;
  const publicDescriptions = Array.isArray(game?.publicDescriptions) ? (game.publicDescriptions as Array<Record<string, unknown>>) : [];
  const strategy = isRecord(payload?.strategy) ? payload.strategy : null;
  const output = isRecord(payload?.output) ? payload.output : null;

  return (
    <div className="admin-trace-detail">
      <h3>{node.kind === 'review' ? 'Review Generation' : 'Generation'}</h3>
      <div className="admin-trace-meta">
        <span>Task: {task}</span>
        <span>Attempt: {String(event?.attempt ?? 1)}</span>
        <span>Latency: {event?.latencyMs ? fmtDuration(Number(event.latencyMs)) : '—'}</span>
        <span>Status: {String(event?.outcome ?? '')}</span>
        {prompt?.strategyId && <span>Persona: {PERSONA_NAMES[prompt.strategyId] ?? prompt.strategyId}</span>}
        {prompt?.promptTemplateVersion && <span>Prompt Version: {prompt.promptTemplateVersion}</span>}
        {prompt?.promptHash && (
          <span title={prompt.promptHash}>Prompt Hash: {prompt.promptHash.slice(0, 16)}…</span>
        )}
      </div>

      <DetailCard title="Input">
        {system && (
          <details className="admin-raw">
            <summary>System（含 roleObjective / safety / exposure policy）</summary>
            <pre>{system.content}</pre>
          </details>
        )}
        {user && (
          <>
            {strategy?.guidance && (
              <div className="admin-trace-field">
                <span className="admin-trace-label">Persona Policy</span>
                <pre className="admin-trace-guidance">{String(strategy.guidance)}</pre>
              </div>
            )}
            <div className="admin-trace-field">
              <span className="admin-trace-label">Public Context（sanitized）</span>
              <div className="admin-trace-public">
                {publicDescriptions.map((description, index) => (
                  <div key={index}>
                    <strong>{String(description.playerName ?? description.playerId ?? '')}</strong>
                    <span>“{String(description.text ?? '')}”</span>
                  </div>
                ))}
                {publicDescriptions.length === 0 && <span className="admin-note">（无同轮公开描述）</span>}
              </div>
            </div>
            {output && (
              <div className="admin-trace-field">
                <span className="admin-trace-label">Output Schema</span>
                <pre>{prettyJson(JSON.stringify(output))}</pre>
              </div>
            )}
            <details className="admin-raw">
              <summary>查看原始 Sanitized JSON</summary>
              <pre>{prettyJson(user.content)}</pre>
            </details>
          </>
        )}
      </DetailCard>

      <DetailCard title="Output">
        {node.output ? (
          <p className="admin-trace-field">
            <em>“{node.output}”</em>
            <span className="admin-note">
              {task === 'vote'
                ? '（投票理由 · 密词已脱敏）'
                : '（该次生成的输出未逐次入库，此处为最终提交文本）'}
            </span>
          </p>
        ) : task === 'vote' ? (
          <p className="admin-note">投票输出未逐次入库；最终票型见 Atomic Commit 节点。</p>
        ) : (
          <p className="admin-note">该次输出未入库（trace 不采集模型原始输出）。</p>
        )}
      </DetailCard>

      <DetailCard title="Usage">
        <p className="admin-note">当前 trace 不采集 token / cost，不展示伪造数据。</p>
      </DetailCard>

      {gameId && prompt && (
        <div className="admin-block-actions">
          <button
            className="admin-button quiet"
            onClick={() =>
              onOpenPrompt({
                gameId,
                round: String(Number(event?.round ?? 0)),
                agentId: String(event?.agentId ?? ''),
                task,
              })
            }
          >
            打开 Prompt Trace
          </button>
        </div>
      )}
    </div>
  );
}

function QualityGateDetail({ node }: { node: TraceObservation }) {
  const event = node.event;
  const violation = String(event?.violationType ?? node.detail ?? '');
  const similarity = Number(event?.similarity);
  const willRetry = Boolean(event?.willRetry);
  return (
    <div className="admin-trace-detail">
      <h3>Quality Gate</h3>
      <div className="admin-trace-meta">
        <span>Status: REJECTED</span>
        <span>Violation: {violation}</span>
        <span>Action: {willRetry ? 'REPAIR' : 'ABORT'}</span>
      </div>
      <DetailCard title="判定">
        <p className="admin-trace-field">
          Lexical Similarity:{' '}
          {Number.isFinite(similarity) ? similarity.toFixed(2) : '未记录'}
        </p>
        <p className="admin-trace-field">
          Threshold: {violation === 'duplicate_description' ? DUPLICATE_THRESHOLD_LABEL : '—'}
        </p>
        <p className="admin-note">
          Candidate / Compared With 未入库（trace 不记录被拒输出）；similarity 为字符 bigram + Dice 的 Lexical
          Similarity，不是 Semantic Similarity。
        </p>
      </DetailCard>
    </div>
  );
}

const DUPLICATE_THRESHOLD_LABEL = '0.72（strategy qualityPolicy）';

function RetryDetail({ node }: { node: TraceObservation }) {
  const event = node.event;
  return (
    <div className="admin-trace-detail">
      <h3>Retry</h3>
      <div className="admin-trace-meta">
        <span>Error Type: {String(event?.errorType ?? '')}</span>
        <span>Attempt: {String(event?.attempt ?? 1)}</span>
        <span>Duration: {event?.latencyMs ? fmtDuration(Number(event.latencyMs)) : '—'}</span>
        <span>Retryable: {event?.willRetry ? 'yes' : 'no'}</span>
        <span>Next Action: automatic retry</span>
        <span>Backoff: 600ms</span>
      </div>
      <p className="admin-note">不展示 API Key / raw provider body。</p>
    </div>
  );
}

function CommitDetail({ node }: { node: TraceObservation }) {
  return (
    <div className="admin-trace-detail">
      <h3>Commit</h3>
      <p className="admin-trace-field">
        已进入 GameState：<em>“{node.detail ?? ''}”</em>
      </p>
    </div>
  );
}

function AtomicCommitDetail({ node }: { node: TraceObservation }) {
  return (
    <div className="admin-trace-detail">
      <h3>Atomic Commit</h3>
      <p className="admin-trace-field">{node.detail ?? (node.status === 'ok' ? '✓ COMMITTED' : '✕ NOT COMMITTED')}</p>
      <p className="admin-note">单个 vote 成功 ≠ GameState 已提交；只有整批结算成功才原子提交。</p>
    </div>
  );
}

function ResumeDetail({ node }: { node: TraceObservation }) {
  const event = node.event;
  return (
    <div className="admin-trace-detail">
      <h3>Description Resume</h3>
      <div className="admin-trace-meta">
        <span>resumeOf: R{String(event?.round ?? '')} · Description</span>
        <span>missingAgent: {String(event?.agentId ?? '')}</span>
        <span>manualResumeIndex: {String(event?.manualResumeIndex ?? 1)}</span>
        <span>manualRetriesRemaining: {String(event?.manualRetriesRemaining ?? 0)}</span>
        <span>outcome: {String(event?.recoveryOutcome ?? 'started')}</span>
      </div>
      <p className="admin-note">Resume 与原失败 Trace（R{String(event?.round ?? '')} · Description）同属一个 Session。</p>
    </div>
  );
}

function AgentDetail({ node }: { node: TraceObservation }) {
  return (
    <div className="admin-trace-detail">
      <h3>Agent</h3>
      <p className="admin-trace-field">{node.title}</p>
      <p className="admin-note">
        {node.children.length} 个 Observation：
        {node.children.map((child) => child.kind).join(' / ')}
      </p>
    </div>
  );
}

function TextDetail({ title, text }: { title: string; text?: string }) {
  return (
    <div className="admin-trace-detail">
      <h3>{title}</h3>
      {text ? <p className="admin-trace-field">{text}</p> : <p className="admin-note">（无额外元数据）</p>}
    </div>
  );
}

function FilterInput({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="admin-field">
      <span>{label}</span>
      <input value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}
