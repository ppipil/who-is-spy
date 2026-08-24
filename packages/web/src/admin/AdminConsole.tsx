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
        <div className="admin-brand">潜词局管理台 Admin</div>
        <div className="admin-tabs">
          <button className={page === 'trace' ? 'is-active' : ''} onClick={() => setPage('trace')}>追踪 Trace</button>
          <button className={page === 'evaluation' ? 'is-active' : ''} onClick={() => setPage('evaluation')}>评测 Evaluation</button>
        </div>
        <a href="/">返回游戏 Game</a>
      </nav>
      {page === 'trace' ? <TracePage /> : <EvaluationPage />}
    </div>
  );
}