import type { FaultDemoResult, FaultScenario, FaultScenarioId } from './faultTypes';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json' } });
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? 'Fault Demo 请求失败');
  return payload;
}
export const faultApi = {
  scenarios: () => request<{ scenarios: FaultScenario[] }>('/api/admin/fault-demos'),
  run: (scenario: FaultScenarioId) => request<FaultDemoResult>('/api/admin/fault-demos/run', {
    method: 'POST', body: JSON.stringify({ scenario }),
  }),
  recover: (runId: string) => request<FaultDemoResult>(`/api/admin/fault-demos/${encodeURIComponent(runId)}/recover`, { method: 'POST' }),
  replay: (runId: string) => request<{ replay: string }>(`/api/admin/traces/${encodeURIComponent(runId)}/replay`),
};
