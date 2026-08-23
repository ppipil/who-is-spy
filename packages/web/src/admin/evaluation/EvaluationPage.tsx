import { useEffect, useMemo, useState } from 'react';
import { evaluationApi } from './evaluationApi';
import type { EvaluationCaseOption, EvaluationModel, EvaluationReport } from './evaluationTypes';
import './evaluation.css';

const RUNNING_STAGES = ['Preparing cases', 'Running evaluation harness', 'Waiting for AI Judge / save', 'Refreshing reports'];

export function EvaluationPage() {
  const [cases, setCases] = useState<EvaluationCaseOption[]>([]);
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
      setReports(history.reports);
      setArchivedReports(history.archivedReports);
      setActiveReport((current) => current ?? history.reports[0] ?? history.archivedReports[0] ?? null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load evaluation');
    }
  }

  async function startEvaluation() {
    setRunning(true);
    setStartedAt(Date.now());
    setElapsedMs(0);
    setError('');
    try {
      const result = await evaluationApi.start({ model, cases: selectedCases, judgeEnabled });
      setActiveReport(result.report);
      await load();
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : 'Evaluation failed');
    } finally {
      setRunning(false);
      setStartedAt(null);
    }
  }

  function toggleCase(id: string) {
    setSelectedCases((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  return (
    <div className="evaluation-page">
      <header className="evaluation-header">
        <div>
          <span>Admin Lite</span>
          <h1>Evaluation</h1>
        </div>
        <p>Run canonical admin evaluations locally, then compare them with archived milestone reports.</p>
      </header>
      {error && <div className="admin-error">{error}</div>}
      <main className="evaluation-layout">
        <section className="evaluation-card runner-card">
          <h2>Run Evaluation</h2>
          <fieldset>
            <legend>Model</legend>
            <label><input type="radio" checked={model === 'fake'} onChange={() => setModel('fake')} /> Fake</label>
            <label><input type="radio" checked={model === 'real'} onChange={() => setModel('real')} /> DeepSeek</label>
          </fieldset>
          <fieldset>
            <legend>Cases</legend>
            {cases.map((item) => (
              <label key={item.id}>
                <input type="checkbox" checked={selectedCases.includes(item.id)} onChange={() => toggleCase(item.id)} />
                <span>{item.name}</span>
                <small>{item.humanDescription}</small>
              </label>
            ))}
          </fieldset>
          <label className="judge-toggle">
            <input type="checkbox" checked={judgeEnabled} onChange={(event) => setJudgeEnabled(event.target.checked)} />
            AI Judge Enabled
          </label>
          <button disabled={running || selectedCases.length === 0} onClick={startEvaluation}>{running ? 'RUNNING…' : 'Start Evaluation'}</button>
          {running && <RunningProgress model={model} caseCount={selectedCases.length} elapsedMs={elapsedMs} stage={runningStage} />}
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

function RunningProgress({ model, caseCount, elapsedMs, stage }: { model: EvaluationModel; caseCount: number; elapsedMs: number; stage: string }) {
  return (
    <div className="evaluation-running">
      <strong>RUNNING</strong>
      <span>Model: {model === 'real' ? 'DeepSeek' : 'Fake'} · Cases: {caseCount} · Elapsed: {formatDuration(elapsedMs)}</span>
      <span>Current stage: {stage}</span>
      <small>Progress is local UI feedback while the backend request is in flight; report is saved after the request returns.</small>
    </div>
  );
}

function ReportDetail({ report }: { report: EvaluationReport | null }) {
  if (!report) return <section className="evaluation-card"><p className="admin-empty">No report selected.</p></section>;
  const metrics = report.deterministic.metrics;
  return (
    <section className="evaluation-card report-card">
      <div className="report-title">
        <span className={`report-status ${report.status.toLowerCase()}`}>{report.status}</span>
        <div><h2>Report Detail</h2><small>{report.title} · {new Date(report.createdAt).toLocaleString()}</small></div>
      </div>
      <div className="summary-grid">
        <Metric label="Source" value={report.source === 'archive' ? 'Archive' : 'Local'} />
        <Metric label="Model" value={report.model === 'real' ? 'DeepSeek' : 'Fake'} />
        <Metric label="Cases" value={`${report.cases.length || report.deterministic.configuration.games}`} />
        <Metric label="Duration" value={formatDuration(report.durationMs)} />
        <Metric label="Judge" value={report.judge.status} />
      </div>
      <h3>Reliability & Safety</h3>
      <div className="metric-grid">
        <Metric label="Completion" value={formatRate(metrics.completionRate)} status={report.deterministic.gate.passed ? 'PASS' : 'FAIL'} />
        <Metric label="Valid Vote" value={formatRate(metrics.validVoteRate)} />
        <Metric label="Invalid Output" value={formatRate(metrics.invalidOutputRate)} />
        <Metric label="Secret Leak" value={String(metrics.safety.secretLeakOccurrences)} />
        <Metric label="Public Leak" value={String(metrics.safety.publicStateLeakOccurrences)} />
        <Metric label="Retry" value={formatRate(metrics.retryRate)} />
      </div>
      <h3>Agent Behavior</h3>
      <div className="metric-grid">
        <Metric label="AI Behavior Score" value={report.judge.behaviorScore === null ? 'Unavailable' : report.judge.behaviorScore.toFixed(1)} />
        <Metric label="Lexical Homogeneity" value={String(metrics.descriptionHomogeneity)} />
        <Metric label="Judge Reason" value={report.judge.reason} />
      </div>
      {report.judge.output && <JudgeBreakdown output={report.judge.output} />}
      <h3>Human Input Responsiveness</h3>
      <p>{humanInputText(metrics)}</p>
      <h3>Efficiency</h3>
      <div className="metric-grid">
        <Metric label="P50" value={formatMs(metrics.latencyMs.p50)} />
        <Metric label="P95" value={formatMs(metrics.latencyMs.p95)} />
        <Metric label="Tokens/Game" value="Unavailable" />
        <Metric label="Cost/Game" value="Unavailable" />
      </div>
      <h3>Top Problems</h3>
      {report.problems.length === 0 ? <p className="admin-empty">No top problems.</p> : <ol>{report.problems.map((item) => <li key={`${item.title}-${item.evidence ?? ''}`}>{item.title}{item.evidence ? <small>{item.evidence}</small> : null}</li>)}</ol>}
    </section>
  );
}

function JudgeBreakdown({ output }: { output: NonNullable<EvaluationReport['judge']['output']> }) {
  const rows = [
    ['Persona', output.personaAdherence.score],
    ['Semantic Diversity', output.semanticDiversity.score],
    ['Context Utilization', output.contextUtilization.score],
    ['Human Input', output.humanInputResponsiveness.score],
    ['Exposure Control', output.exposureControl.score],
  ] as const;
  return (
    <div className="judge-breakdown">
      {rows.map(([label, score]) => <Metric key={label} label={label} value={score.toFixed(1)} />)}
      {output.issues.length > 0 && <p><strong>Judge Issues:</strong> {output.issues.join('; ')}</p>}
    </div>
  );
}
function ReportHistory({ localReports, archivedReports, activeId, onSelect }: { localReports: EvaluationReport[]; archivedReports: EvaluationReport[]; activeId: string | null; onSelect: (report: EvaluationReport) => void }) {
  return (
    <section className="evaluation-card history-card">
      <h2>Reports</h2>
      <div className="history-columns">
        <HistoryColumn title="Local Admin Runs" empty="No local runs yet." reports={localReports} activeId={activeId} onSelect={onSelect} />
        <HistoryColumn title="Archived Milestones" empty="Waiting for GitHub report links." reports={archivedReports} activeId={activeId} onSelect={onSelect} />
      </div>
    </section>
  );
}

function HistoryColumn({ title, empty, reports, activeId, onSelect }: { title: string; empty: string; reports: EvaluationReport[]; activeId: string | null; onSelect: (report: EvaluationReport) => void }) {
  return (
    <div className="history-column">
      <h3>{title}</h3>
      {reports.length === 0 ? <p className="admin-empty">{empty}</p> : reports.map((report) => (
        <button key={report.id} className={report.id === activeId ? 'is-active' : ''} onClick={() => onSelect(report)}>
          <strong>{report.title}</strong>
          <span>{report.status} · {report.source === 'archive' ? 'archive' : report.model}</span>
          <small>Completion {formatRate(report.deterministic.metrics.completionRate)} · P95 {formatMs(report.deterministic.metrics.latencyMs.p95)}</small>
        </button>
      ))}
    </div>
  );
}

function Metric({ label, value, status }: { label: string; value: string; status?: string }) {
  return <div className="metric-card"><span>{label}</span><strong>{value}</strong>{status && <small>{status}</small>}</div>;
}

function humanInputText(metrics: EvaluationReport['deterministic']['metrics']): string {
  const value = metrics.humanInputResponsiveness;
  if (!value || !value.available) return 'Not Available. Requires both canonical cases.';
  return `Normal human votes: ${value.normalHumanVotes}; Nonsense human votes: ${value.nonsenseHumanVotes}; reason awareness hits: ${value.reasonAwarenessHits}.`;
}

function formatRate(value: number): string { return `${Math.round(value * 100)}%`; }
function formatMs(value: number): string { return value > 0 ? `${Math.round(value)}ms` : 'Unavailable'; }
function formatDuration(value: number): string { return value > 0 ? `${(value / 1000).toFixed(1)}s` : '—'; }