import { useState } from 'react';
import { EvaluationPage } from './evaluation/EvaluationPage';
import { TracePage } from './trace/TracePage';
import { FaultPage } from './fault/FaultPage';
import './shared/admin.css';

type AdminPage = 'trace' | 'evaluation' | 'fault';

export function AdminConsole() {
  const [page, setPage] = useState<AdminPage>('trace');
  const [traceRunId, setTraceRunId] = useState('');
  return (
    <div className="admin-shell">
      <nav className="admin-nav">
        <div className="admin-brand">潜词局管理台 Admin</div>
        <div className="admin-tabs">
          <button className={page === 'trace' ? 'is-active' : ''} onClick={() => setPage('trace')}>追踪 Trace</button>
          <button className={page === 'evaluation' ? 'is-active' : ''} onClick={() => setPage('evaluation')}>评测 Evaluation</button>
          <button className={page === 'fault' ? 'is-active' : ''} onClick={() => setPage('fault')}>故障 Fault</button>
        </div>
        <a href="/">返回游戏 Game</a>
      </nav>
      <section className="admin-page" hidden={page !== 'trace'}>
        <TracePage initialRunId={traceRunId} />
      </section>
      <section className="admin-page" hidden={page !== 'evaluation'}>
        <EvaluationPage />
      </section>
      <section className="admin-page" hidden={page !== 'fault'}>
        <FaultPage onViewTrace={(runId) => { setTraceRunId(runId); setPage('trace'); }} />
      </section>
    </div>
  );
}