import type { EvaluationCaseOption, EvaluationHistoryResponse, EvaluationReport, StartEvaluationInput } from './evaluationTypes';

async function adminRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? 'Evaluation request failed');
  return payload;
}

export const evaluationApi = {
  cases: () => adminRequest<{ cases: EvaluationCaseOption[] }>('/api/admin/evaluation/cases'),
  history: () => adminRequest<EvaluationHistoryResponse>('/api/admin/evaluations'),
  start: (input: StartEvaluationInput) => adminRequest<{ report: EvaluationReport }>('/api/admin/evaluations', {
    method: 'POST',
    body: JSON.stringify(input),
  }),
};