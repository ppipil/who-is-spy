import { useEffect, useState } from 'react';
import { faultApi } from './faultApi';
import type { FaultDemoResult, FaultScenario, FaultScenarioId } from './faultTypes';
import './fault.css';

export function FaultPage({ onViewTrace }: { onViewTrace: (runId: string) => void }) {
  const [scenarios, setScenarios] = useState<FaultScenario[]>([]);
  const [running, setRunning] = useState<FaultScenarioId | 'recover' | null>(null);
  const [result, setResult] = useState<FaultDemoResult | null>(null);
  const [replay, setReplay] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { void faultApi.scenarios().then(({ scenarios: items }) => setScenarios(items)).catch(showError); }, []);

  const run = async (scenario: FaultScenarioId) => {
    setRunning(scenario); setError(''); setResult(null); setReplay('');
    try { setResult(await faultApi.run(scenario)); } catch (cause) { showError(cause); }
    finally { setRunning(null); }
  };
  const recover = async () => {
    if (!result) return;
    setRunning('recover'); setError('');
    try { setResult(await faultApi.recover(result.runId)); } catch (cause) { showError(cause); }
    finally { setRunning(null); }
  };
  const loadReplay = async () => {
    if (!result) return;
    try { setReplay((await faultApi.replay(result.runId)).replay); } catch (cause) { showError(cause); }
  };
  function showError(cause: unknown) { setError(cause instanceof Error ? cause.message : 'Fault Demo 请求失败'); }

  return <main className="fault-page">
    <header><span>轻量管理台 Admin Lite</span><h1>Fault Demo</h1><p>人工、确定性的 Provider 故障注入；不调用 DeepSeek。</p></header>
    {error && <div className="admin-error">{error}</div>}
    <section className="fault-scenarios">{scenarios.map((scenario) => <article key={scenario.id}>
      <h2>{scenario.name}</h2><p>{scenario.description}</p>
      <button disabled={running !== null} onClick={() => void run(scenario.id)}>{running === scenario.id ? 'Injecting…' : 'Inject Fault'}</button>
    </article>)}</section>
    {result && <section className="fault-result">
      <div className="fault-verdicts">
        <strong className={result.faultStatus === 'FAULT TRIGGERED' ? 'fault-triggered' : 'not-reached'}>{result.faultStatus}</strong>
        <strong className={result.outcome.startsWith('RECOVERED') ? 'fault-recovered' : 'fault-paused'}>{result.outcome}</strong>
      </div>
      <div className="fault-facts">
        <div><small>Scenario</small><strong>{result.scenarioName}</strong></div>
        <div><small>Injected Fault</small><strong>{result.injectedFault}</strong></div>
        <div><small>Location</small><strong>Round {result.round} / {result.phase} / {result.agentId} / {result.task}</strong></div>
        <div><small>Game / Run</small><strong>{result.runId}</strong></div>
      </div>
      <div><small>Attempt Timeline</small><ol className="fault-timeline">{result.timeline.map((step) => <li key={`${step.sequence}-${step.kind}`} className={step.status.toLowerCase()}>
        <strong>{step.status}</strong><span>{step.title}</span>{step.errorType && <code>{step.errorType}</code>}
      </li>)}</ol></div>
      <div><small>Recovery Action</small><strong>{result.recoveryAction}</strong></div>
      <div><small>State Protection</small><ul>{result.stateEvidence.map((item) => <li key={item}>{item}</li>)}</ul></div>
      {result.stopReason && <div><small>Stop Reason</small><strong>{result.stopReason}</strong></div>}
      <div className="fault-actions">
        {result.canRecover && <button disabled={running !== null} onClick={() => void recover()}>{running === 'recover' ? 'Resuming…' : 'Restore Provider & Resume'}</button>}
        <button className="secondary" onClick={() => onViewTrace(result.runId)}>View Trace</button>
        <button className="secondary" onClick={() => void loadReplay()}>Replay Incident</button>
      </div>
      {replay && <pre className="fault-replay">{replay}</pre>}
    </section>}
  </main>;
}
