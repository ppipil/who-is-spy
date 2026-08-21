import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AdminConsole } from './admin/AdminConsole';
import './styles.css';

const isAdminRoute = window.location.pathname === '/admin';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isAdminRoute ? <AdminConsole /> : <App />}
  </StrictMode>,
);
