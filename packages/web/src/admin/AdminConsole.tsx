import { useState } from 'react';
import { EvaluationPage } from './evaluation/EvaluationPage';
import { TracePage } from './trace/TracePage';
import './shared/admin.css';

type AdminPage = 'trace' | 'evaluation';

export function AdminConsole() {
  const [page, setPage] = useState<AdminPage>('trace');
  return (
    <div className="admin-shell">
      <nav className="admin-nav">
        <div className="admin-brand">潜词局 Admin</div>
        <div className="admin-tabs">
          <button className={page === 'trace' ? 'is-active' : ''} onClick={() => setPage('trace')}>Trace</button>
          <button className={page === 'evaluation' ? 'is-active' : ''} onClick={() => setPage('evaluation')}>Evaluation</button>
        </div>
        <a href="/">Game</a>
      </nav>
      {page === 'trace' ? <TracePage /> : <EvaluationPage />}
    </div>
  );
}