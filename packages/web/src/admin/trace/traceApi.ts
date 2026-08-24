import type { AdminStatus, PromptTraceRecord, RuntimeEvent, TraceFilters, TraceRunSummary } from './traceTypes';

async function adminRequest<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json' } });
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? '管理台请求失败');
  return payload;
}

function queryString(params: object): string {
  const entries = Object.entries(params as Record<string, string | undefined>).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim() !== '',
  );
  return entries.length === 0 ? '' : `?${new URLSearchParams(entries).toString()}`;
}

export const traceApi = {
  status: () => adminRequest<AdminStatus>('/api/admin/status'),
  runs: (filters: TraceFilters) =>
    adminRequest<{ count: number; runs: TraceRunSummary[] }>(`/api/admin/trace-runs${queryString(filters)}`),
  traces: (filters: TraceFilters) =>
    adminRequest<{ count: number; events: RuntimeEvent[] }>(`/api/admin/traces${queryString(filters)}`),
  promptTraces: (filters: TraceFilters) =>
    adminRequest<{ count: number; records: PromptTraceRecord[] }>(`/api/admin/prompt-traces${queryString(filters)}`),
};
