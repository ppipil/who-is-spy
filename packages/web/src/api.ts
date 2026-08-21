import type { DescriptionPublishedProgressEvent, PhaseChangedProgressEvent, PublicGameState } from './types';

export interface ApiDiagnostic {
  errorType?: string;
  httpStatus?: number | null;
  retryable?: boolean;
  attempt?: number;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly diagnostic?: ApiDiagnostic,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
  const payload = (await response.json()) as T & { error?: string; diagnostic?: ApiDiagnostic };
  if (!response.ok) {
    throw new ApiError(payload.error ?? '请求失败，请稍后重试', response.status, payload.diagnostic);
  }
  return payload;
}

export const api = {
  health: () =>
    request<{ ok: boolean; model: string; configured: boolean }>('/api/health'),
  createGame: () =>
    request<PublicGameState>('/api/games', { method: 'POST' }),
  getGame: (id: string) =>
    request<PublicGameState>(`/api/games/${id}`),
  subscribeToProgress: (
    id: string,
    handlers: {
      onDescription: (event: DescriptionPublishedProgressEvent) => void;
      onPhase: (event: PhaseChangedProgressEvent) => void;
    },
  ) => {
    const source = new EventSource(`/api/games/${id}/events`);
    source.addEventListener('description_published', (message) => handlers.onDescription(JSON.parse(message.data)));
    source.addEventListener('phase_changed', (message) => handlers.onPhase(JSON.parse(message.data)));
    return source;
  },
  describe: (id: string, text: string) =>
    request<PublicGameState>(`/api/games/${id}/describe`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
  resumeDescription: (id: string) =>
    request<PublicGameState>(`/api/games/${id}/description/resume`, {
      method: 'POST',
    }),
  vote: (id: string, targetId: string) =>
    request<PublicGameState>(`/api/games/${id}/vote`, {
      method: 'POST',
      body: JSON.stringify({ targetId }),
    }),
  continue: (id: string) =>
    request<PublicGameState>(`/api/games/${id}/continue`, { method: 'POST' }),
};
