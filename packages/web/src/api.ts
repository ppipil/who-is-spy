import type { PublicGameState } from './types';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(payload.error ?? '请求失败，请稍后重试');
  }
  return payload;
}

export const api = {
  health: () =>
    request<{ ok: boolean; model: string; configured: boolean }>('/api/health'),
  createGame: () =>
    request<PublicGameState>('/api/games', { method: 'POST' }),
  describe: (id: string, text: string) =>
    request<PublicGameState>(`/api/games/${id}/describe`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
  vote: (id: string, targetId: string) =>
    request<PublicGameState>(`/api/games/${id}/vote`, {
      method: 'POST',
      body: JSON.stringify({ targetId }),
    }),
  continue: (id: string) =>
    request<PublicGameState>(`/api/games/${id}/continue`, { method: 'POST' }),
};
