import { TracePage } from './trace/TracePage';
import './shared/admin.css';

export function AdminConsole() {
  return (
    <div className="admin-shell">
      <nav className="admin-nav">
        <div className="admin-brand">潜词局 Admin</div>
        <a href="/">Game</a>
      </nav>
      <TracePage />
    </div>
  );
}
