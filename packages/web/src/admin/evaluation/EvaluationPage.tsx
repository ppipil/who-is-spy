import { useEffect, useMemo, useState } from 'react';
import { evaluationApi } from './evaluationApi';
import { EvaluationEvidence } from './EvaluationEvidence';
import type { EvaluationCaseOption, EvaluationModel, EvaluationReport } from './evaluationTypes';
import './evaluation.css';

const RUNNING_STAGES = ['准备评测用例 Preparing cases', '运行评测框架 Evaluation harness', '等待 AI Judge / 保存报告', '刷新报告列表 Refreshing reports'];

export function EvaluationPage() {
  const [cases, setCases] = useState<EvaluationCaseOption[]>([]);
  const [wordPair, setWordPair] = useState<[string, string] | null>(null);
  const [caseInputs, setCaseInputs] = useState<Record<string, string>>({});
  const [rounds, setRounds] = useState(1);
  const [maxRounds, setMaxRounds] = useState(5);
  const [provider, setProvider] = useState<{ model: string; configured: boolean; envProxyEnabled: boolean } | null>(null);
  const [selectedCases, setSelectedCases] = useState<string[]>(['normal-human-input', 'nonsense-human-input']);
  const [model, setModel] = useState<EvaluationModel>('fake');
  const [judgeEnabled, setJudgeEnabled] = useState(true);
  const [reports, setReports] = useState<EvaluationReport[]>([]);
  const [archivedReports, setArchivedReports] = useState<EvaluationReport[]>([]);
  const [activeReport, setActiveReport] = useState<EvaluationReport | null>(null);
  const [running, setRunning] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => { void load(); }, []);

  useEffect(() => {
    if (!running || startedAt === null) return undefined;
    const timer = window.setInterval(() => setElapsedMs(Date.now() - startedAt), 500);
    return () => window.clearInterval(timer);
  }, [running, startedAt]);

  const runningStage = useMemo(() => {
    if (!running) return '';
    const index = Math.min(Math.floor(elapsedMs / 6000), RUNNING_STAGES.length - 1);
    return RUNNING_STAGES[index];
  }, [elapsedMs, running]);

  async function load() {
    setError('');
    try {
      const [caseResult, history] = await Promise.all([evaluationApi.cases(), evaluationApi.history()]);
      setCases(caseResult.cases);
      setWordPair((current) => current ?? caseResult.fixtureWords);
      setCaseInputs((current) => Object.keys(current).length > 0 ? current : Object.fromEntries(caseResult.cases.map((item) => [item.id, item.humanDescription])));
      setRounds((current) => current || caseResult.defaultRounds);
      setMaxRounds(caseResult.maxRounds);
      setProvider(caseResult.provider);
      setReports(history.reports);
      setArchivedReports(history.archivedReports);
      setActiveReport((current) => current ?? history.reports[0] ?? history.archivedReports[0] ?? null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载评测 Evaluation 失败');
    }
  }

  async function startEvaluation() {
    setRunning(true);
    setStartedAt(Date.now());
    setElapsedMs(0);
    setError('');
    try {
      const result = await evaluationApi.start({
        model,
        cases: selectedCases,
        judgeEnabled,
        wordPair: wordPair ?? ['雨伞', '雨衣'],
        caseInputs,
        rounds,
      });
      setActiveReport(result.report);
      await load();
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : '评测 Evaluation 失败');
    } finally {
      setRunning(false);
      setStartedAt(null);
    }
  }

  function toggleCase(id: string) {
    setSelectedCases((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  function setWord(index: 0 | 1, value: string) {
    setWordPair((current) => {
      const next: [string, string] = current ? [...current] : ['雨伞', '雨衣'];
      next[index] = value;
      return next;
    });
  }

  const configurationValid = Boolean(
    wordPair
    && wordPair[0].trim()
    && wordPair[1].trim()
    && wordPair[0].trim() !== wordPair[1].trim()
    && selectedCases.length > 0
    && selectedCases.every((id) => (caseInputs[id] ?? '').trim().length >= 2)
    && (model === 'fake' || provider?.configured),
  );

  return (
    <div className="evaluation-page">
      <header className="evaluation-header">
        <div>
          <span>轻量管理台 Admin Lite</span>
          <h1>评测 Evaluation</h1>
        </div>
        <p>在本地运行标准评测用例，并与已归档的里程碑报告对比。</p>
      </header>
      {error && <div className="admin-error">{error}</div>}
      <main className="evaluation-layout">
        <section className="evaluation-card runner-card">
          <h2>运行评测 Run Evaluation</h2>
          <fieldset>
            <legend>模型 Model</legend>
            <label><input type="radio" checked={model === 'fake'} onChange={() => setModel('fake')} /> Fake 模型</label>
            <label><input type="radio" checked={model === 'real'} onChange={() => setModel('real')} /> DeepSeek</label>
            <small className={provider?.configured ? 'provider-status is-ready' : 'provider-status'}>
              DeepSeek: {provider?.model ?? '检测中…'} · {provider?.configured ? '已配置 Configured' : '未配置 Not configured'} · {provider?.envProxyEnabled ? '代理已启用 Proxy on' : '系统代理未启用 Proxy off'}
            </small>
          </fieldset>
          <fieldset className="word-editor">
            <legend>题目 Words</legend>
            <label>
              <span>平民词 Civilian</span>
              <input value={wordPair?.[0] ?? ''} maxLength={20} onChange={(event) => setWord(0, event.target.value)} />
            </label>
            <label>
              <span>卧底词 Undercover</span>
              <input value={wordPair?.[1] ?? ''} maxLength={20} onChange={(event) => setWord(1, event.target.value)} />
            </label>
          </fieldset>
          <fieldset>
            <legend>用例 Cases</legend>
            {cases.map((item) => (
              <div className="case-editor" key={item.id}>
                <label className="case-toggle">
                  <input type="checkbox" checked={selectedCases.includes(item.id)} onChange={() => toggleCase(item.id)} />
                  <span>{item.name}</span>
                </label>
                <textarea
                  aria-label={`${item.name} Human input`}
                  disabled={!selectedCases.includes(item.id)}
                  maxLength={120}
                  rows={3}
                  value={caseInputs[item.id] ?? item.humanDescription}
                  onChange={(event) => setCaseInputs((current) => ({ ...current, [item.id]: event.target.value }))}
                />
              </div>
            ))}
          </fieldset>
          <label className="rounds-editor">
            <span>评测轮次 Evaluation rounds</span>
            <select value={rounds} onChange={(event) => setRounds(Number(event.target.value))}>
              {Array.from({ length: maxRounds }, (_, index) => index + 1).map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
            <small>每个选中 Case 重复运行的次数；DeepSeek 会按实际 games 产生调用。</small>
          </label>
          <label className="judge-toggle">
            <input type="checkbox" checked={judgeEnabled} onChange={(event) => setJudgeEnabled(event.target.checked)} />
            启用 AI Judge 智能裁判
          </label>
          <button disabled={running || !configurationValid} onClick={startEvaluation}>{running ? '运行中 RUNNING…' : '开始评测 Start Evaluation'}</button>
          {running && <RunningProgress model={model} caseCount={selectedCases.length} rounds={rounds} elapsedMs={elapsedMs} stage={runningStage} />}
        </section>

        <ReportDetail report={activeReport} />
        <ReportHistory
          localReports={reports}
          archivedReports={archivedReports}
          activeId={activeReport?.id ?? null}
          onSelect={setActiveReport}
        />
      </main>
    </div>
  );
}

function RunningProgress({ model, caseCount, rounds, elapsedMs, stage }: { model: EvaluationModel; caseCount: number; rounds: number; elapsedMs: number; stage: string }) {
  return (
    <div className="evaluation-running">
      <strong>运行中 RUNNING</strong>
      <span>模型 Model: {model === 'real' ? 'DeepSeek' : 'Fake 模型'} · Games: {caseCount * rounds} · 已用时 Elapsed: {formatDuration(elapsedMs)}</span>
      <span>当前阶段 Current stage: {stage}</span>
      <small>进度为本地界面反馈；后端请求返回后会保存报告。</small>
    </div>
  );
}

function ReportDetail({ report }: { report: EvaluationReport | null }) {
  if (!report) return <section className="evaluation-card"><p className="admin-empty">尚未选择报告。</p></section>;
  if (report.archivedEvidence) return <ArchivedReportDetail report={report} />;
  if (!report.deterministic || !report.judge) return <section className="evaluation-card"><p className="admin-empty">报告数据不完整。</p></section>;
  const deterministic = report.deterministic;
  const judge = report.judge;
  const metrics = deterministic.metrics;
  return (
    <section className="evaluation-card report-card">
      <div className="report-title">
        <span className={`report-status ${report.status.toLowerCase()}`}>{reportStatusLabel(report.status)}</span>
        <div><h2>报告详情 Report Detail</h2><small>{report.title} · {new Date(report.createdAt).toLocaleString()}</small></div>
      </div>
      <div className="summary-grid">
        <Metric label="来源 Source" value={report.source === 'archive' ? '归档 Archive' : '本地 Local'} />
        <Metric label="模型 Model" value={report.model === 'real' ? 'DeepSeek' : 'Fake 模型'} />
        <Metric label="用例 Cases" value={`${report.cases.length || deterministic.configuration.games}`} />
        <Metric label="耗时 Duration" value={formatDuration(report.durationMs)} />
        <Metric label="裁判 Judge" value={judgeStatusLabel(judge.status)} />
      </div>
      {report.evidenceUrl && <a className="report-evidence-link" href={report.evidenceUrl} target="_blank" rel="noreferrer">打开 GitHub 归档证据 Open archived evidence ↗</a>}
      <h3>可靠性与安全 Reliability & Safety</h3>
      <div className="metric-grid">
        <Metric label="完局率 Completion" value={formatRate(metrics.completionRate)} status={deterministic.gate.passed ? '通过 PASS' : '失败 FAIL'} />
        <Metric label="有效投票 Valid Vote" value={formatRate(metrics.validVoteRate)} />
        <Metric label="非法输出 Invalid Output" value={formatRate(metrics.invalidOutputRate)} />
        <Metric label="密词泄露 Secret Leak" value={String(metrics.safety.secretLeakOccurrences)} />
        <Metric label="公开状态泄露 Public Leak" value={String(metrics.safety.publicStateLeakOccurrences)} />
        <Metric label="重试 Retry" value={formatRate(metrics.retryRate)} />
      </div>
      <h3>AI 行为 Agent Behavior</h3>
      <div className="metric-grid">
        <Metric
          label="AI 行为评分 AI Behavior Score"
          value={judge.behaviorScore === null ? '不可用 Unavailable' : judge.behaviorScore.toFixed(2)}
          status={judgeCoverageLabel(judge)}
        />
        <Metric label="代码层措辞同质化 Lexical Homogeneity" value={String(metrics.descriptionHomogeneity)} />
        <Metric label="裁判说明 Judge Reason" value={judge.reason} />
      </div>
      {currentJudgeOutput(report) && <JudgeBreakdown output={currentJudgeOutput(report)!} />}
      <EvaluationEvidence report={report} />
      <h3>真人输入响应 Human Input Responsiveness</h3>
      <div className="metric-grid">
        <Metric label="Judge Score" value={judgeResponsivenessScore(report)} />
        <Metric label="Normal votes" value={String(metrics.humanInputResponsiveness?.normalHumanVotes ?? 0)} />
        <Metric label="Nonsense votes" value={String(metrics.humanInputResponsiveness?.nonsenseHumanVotes ?? 0)} />
        <Metric label="reason awareness hits" value={String(metrics.humanInputResponsiveness?.reasonAwarenessHits ?? 0)} />
      </div>      <h3>效率 Efficiency</h3>
      <div className="metric-grid">
        <Metric label="P50" value={formatMs(metrics.latencyMs.p50)} />
        <Metric label="P95" value={formatMs(metrics.latencyMs.p95)} />
        <Metric label="Token/局 Tokens/Game" value={formatTokensPerGame(metrics)} />
        <Metric label="成本/局 Cost/Game" value={formatCostPerGame(metrics)} />
      </div>
      <h3>主要问题 Top Problems</h3>
      {report.problems.length === 0 ? <p className="admin-empty">暂无主要问题。</p> : <ol>{report.problems.map((item) => <li key={`${item.title}-${item.evidence ?? ''}`}>{item.title}{item.evidence ? <small>{item.evidence}</small> : null}</li>)}</ol>}
    </section>
  );
}

function ArchivedReportDetail({ report }: { report: EvaluationReport }) {
  const evidence = report.archivedEvidence!;
  return (
    <section className="evaluation-card report-card archived-report-card">
      <div className="report-title">
        <span className={`report-status ${report.status.toLowerCase()}`}>{reportStatusLabel(report.status)}</span>
        <div><h2>历史评测证据 Historical Evaluation Evidence</h2><small>{report.title}</small></div>
      </div>
      <div className="summary-grid archive-summary-grid">
        <Metric label="版本 / 阶段 Version / Stage" value={evidence.versionStage} />
        <Metric label="被评测 Commit" value={evidence.evaluatedCommit} />
        <Metric label="模型 Model" value={evidence.model} />
        <Metric label="Games / Seeds" value={evidence.gamesSeeds} />
      </div>
      <a className="report-evidence-link" href={report.evidenceUrl} target="_blank" rel="noreferrer">View Evidence / GitHub ↗</a>
      <h3>真实历史指标 Historical Metrics</h3>
      <div className="metric-grid archive-metric-grid">
        <Metric label="完局率 Completion" value={evidence.completion} />
        <Metric label="有效投票 Valid Vote" value={evidence.validVote} />
        <Metric label="词面同质化 Homogeneity" value={evidence.homogeneity} />
        <Metric label="延迟 Latency" value={evidence.latency} />
        <Metric label="Token / Cost" value={evidence.tokenCost} />
        <Metric label="Gate / Result" value={evidence.gateResult} />
      </div>
      <h3>阶段重点结论 Stage Conclusion</h3>
      <p className="archive-conclusion">{evidence.conclusion}</p>
      {evidence.notMeasured.length > 0 && (
        <>
          <h3>未测指标 Not measured</h3>
          <ul className="not-measured-list">{evidence.notMeasured.map((item) => <li key={item}>{item}</li>)}</ul>
        </>
      )}
      <h3>数据来源 Evidence Source</h3>
      <p className="archive-source"><code>{evidence.sourceBranch}:{evidence.sourcePath}</code></p>
    </section>
  );
}

function JudgeBreakdown({ output }: { output: NonNullable<NonNullable<EvaluationReport['judge']>['output']> }) {
  const rows = [
    ['Persona Adherence', output.personaAdherence],
    ['Semantic Diversity', output.semanticDiversity],
    ['Context Utilization', output.contextUtilization],
    ['Human Input Responsiveness', output.humanInputResponsiveness],
    ['Exposure Control', output.exposureControl],
  ] as const;
  return (
    <div className="judge-breakdown">
      {rows.map(([label, dimension]) => (
        <div className="judge-dimension" key={label}>
          <Metric label={label} value={dimension.status === 'available' && dimension.score !== null ? dimension.score.toFixed(1) : '不可用 Unavailable'} status={`Retry ${dimension.retryCount}`} />
          <p><strong>理由：</strong>{dimension.reason}</p>
          <p><strong>证据：</strong>{dimension.evidence}</p>
          <p><strong>结论：</strong>{dimension.summary}</p>
        </div>
      ))}
      <p className="judge-overall-summary"><strong>总体结论：</strong> {output.summary}</p>
    </div>
  );
}
function ReportHistory({ localReports, archivedReports, activeId, onSelect }: { localReports: EvaluationReport[]; archivedReports: EvaluationReport[]; activeId: string | null; onSelect: (report: EvaluationReport) => void }) {
  return (
    <section className="evaluation-card history-card">
      <h2>报告 Reports</h2>
      <div className="history-columns">
        <HistoryColumn title="本地管理台运行 Local Admin Runs" empty="暂无本地运行。" reports={localReports} activeId={activeId} onSelect={onSelect} initialLimit={5} />
        <HistoryColumn title="归档里程碑 Archived Milestones" empty="等待 GitHub 报告链接。" reports={archivedReports} activeId={activeId} onSelect={onSelect} />
      </div>
    </section>
  );
}

function HistoryColumn({ title, empty, reports, activeId, onSelect, initialLimit }: { title: string; empty: string; reports: EvaluationReport[]; activeId: string | null; onSelect: (report: EvaluationReport) => void; initialLimit?: number }) {
  const [expanded, setExpanded] = useState(false);
  const visibleReports = initialLimit && !expanded ? reports.slice(0, initialLimit) : reports;
  const hiddenCount = reports.length - visibleReports.length;
  return (
    <div className="history-column">
      <h3>{title}</h3>
      {reports.length === 0 ? <p className="admin-empty">{empty}</p> : visibleReports.map((report) => (
        <div className="history-entry" key={report.id}>
          <button className={report.id === activeId ? 'is-active' : ''} onClick={() => onSelect(report)}>
            <strong>{report.title}</strong>
            <span>{reportStatusLabel(report.status)} · {report.source === 'archive' ? '归档 archive' : modelLabel(report.model)}</span>
            <small>{historySnapshot(report)}</small>
          </button>
          {report.evidenceUrl && <a href={report.evidenceUrl} target="_blank" rel="noreferrer">View Evidence / GitHub ↗</a>}
        </div>
      ))}
      {hiddenCount > 0 && (
        <button type="button" className="history-show-more" onClick={() => setExpanded(true)}>
          Show more · 还有 {hiddenCount} 条
        </button>
      )}
    </div>
  );
}

function reportStatusLabel(status: EvaluationReport['status']): string {
  if (status === 'PASS') return '通过 PASS';
  if (status === 'WARN') return '警告 WARN';
  if (status === 'FAIL') return '失败 FAIL';
  return status;
}

function judgeStatusLabel(status: NonNullable<EvaluationReport['judge']>['status']): string {
  if (status === 'available') return '可用 available';
  if (status === 'unavailable') return '不可用 unavailable';
  if (status === 'disabled') return '已关闭 disabled';
  if (status === 'skipped') return '已跳过 skipped';
  return status;
}

function judgeCoverageLabel(judge: NonNullable<EvaluationReport['judge']>): string {
  if (typeof judge.availableMetrics !== 'number') return '旧版报告 Legacy Judge';
  const coverage = judge.scoreCoverage === 'full' ? '完整 Full' : judge.scoreCoverage === 'partial' ? '部分 Partial' : '不可用 Unavailable';
  return `${judge.availableMetrics}/${judge.totalMetrics ?? 5} · ${coverage}`;
}

function modelLabel(model: EvaluationModel): string {
  return model === 'real' ? 'DeepSeek' : 'Fake 模型';
}

function Metric({ label, value, status }: { label: string; value: string; status?: string }) {
  return <div className="metric-card"><span>{label}</span><strong>{value}</strong>{status && <small>{status}</small>}</div>;
}

function currentJudgeOutput(report: EvaluationReport): NonNullable<NonNullable<EvaluationReport['judge']>['output']> | null {
  const output = report.judge?.output;
  return output?.personaAdherence && output?.semanticDiversity && output?.contextUtilization && output?.humanInputResponsiveness && output?.exposureControl ? output : null;
}

function judgeResponsivenessScore(report: EvaluationReport): string {
  const value = currentJudgeOutput(report)?.humanInputResponsiveness;
  if (value?.status === 'available' && value.score !== null) return value.score.toFixed(1);
  const completedCaseIds = new Set((report.deterministic?.cases ?? []).filter((item) => item.completed).map((item) => item.caseId));
  if (report.judge?.status === 'available' && completedCaseIds.has('normal-human-input') && completedCaseIds.has('nonsense-human-input')) return '数据缺失 Missing';
  return '不适用 N/A';
}

function historySnapshot(report: EvaluationReport): string {
  if (report.archivedEvidence) return `Completion ${report.archivedEvidence.completion} · ${report.archivedEvidence.gateResult}`;
  if (!report.deterministic) return '报告数据不完整';
  return `完局 Completion ${formatRate(report.deterministic.metrics.completionRate)} · P95 ${formatMs(report.deterministic.metrics.latencyMs.p95)}`;
}
function formatTokensPerGame(metrics: NonNullable<EvaluationReport['deterministic']>['metrics']): string {
  if (metrics.tokenUsage.source !== 'provider' || metrics.tokenUsage.total === null) return '不可用 Unavailable';
  const games = Math.max(1, metrics.completedGames);
  return `${Math.round(metrics.tokenUsage.total / games)} (${metrics.tokenUsage.total} total)`;
}

function formatCostPerGame(metrics: NonNullable<EvaluationReport['deterministic']>['metrics']): string {
  const cost = metrics.cost;
  if (!cost || cost.perGameUsd === null) return '不可用 Unavailable';
  const provenance = [cost.source, cost.tier].filter(Boolean).join(' / ');
  return `$${cost.perGameUsd.toFixed(6)}${provenance ? ` · ${provenance}` : ''}`;
}
function formatRate(value: number): string { return `${Math.round(value * 100)}%`; }
function formatMs(value: number): string { return value > 0 ? `${Math.round(value)}ms` : '不可用 Unavailable'; }
function formatDuration(value: number): string { return value > 0 ? `${(value / 1000).toFixed(1)}s` : '—'; }
