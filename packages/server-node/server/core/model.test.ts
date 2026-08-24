import { describe, expect, it } from 'vitest';
import { DeepSeekClient, ModelError, type ModelTransport } from './model.js';
import type { AgentContext } from './types.js';

describe('DeepSeekClient error taxonomy', () => {
  it('classifies timeout as retryable and retries once', async () => {
    const transport = sequenceTransport([
      () => Promise.reject(new DOMException('aborted', 'AbortError')),
      () => Promise.resolve(jsonResponse({ description: '含蓄安全描述' })),
    ]);
    const client = clientWith(transport);

    await expect(client.describe(context())).resolves.toBe('含蓄安全描述');
    expect(transport.calls).toBe(2);
  });

  it('classifies an aborted TypeError as timeout when the client deadline fires', async () => {
    const transport = abortingTransport();
    const client = new DeepSeekClient({ apiKey: 'test-key', transport, model: 'test-model', timeoutMs: 5, retryDelayMs: 0 });

    await expect(client.describe(context())).rejects.toMatchObject({
      diagnostic: { errorType: 'timeout', retryable: true, attempt: 4 },
    });
    expect(transport.calls).toBe(4);
  });

  it('classifies HTTP 429 as retryable rate_limit', async () => {
    const transport = sequenceTransport([
      () => Promise.resolve(textResponse(429)),
      () => Promise.resolve(jsonResponse({ description: '含蓄安全描述' })),
    ]);
    const client = clientWith(transport);

    await expect(client.describe(context())).resolves.toBe('含蓄安全描述');
    expect(transport.calls).toBe(2);
  });

  it('classifies provider 5xx as retryable provider_5xx', async () => {
    const transport = sequenceTransport([() => Promise.resolve(textResponse(502)), () => Promise.resolve(textResponse(502))]);
    const client = clientWith(transport);

    await expect(client.describe(context())).rejects.toMatchObject({
      diagnostic: { errorType: 'provider_5xx', httpStatus: 502, retryable: true, attempt: 2 },
    });
    expect(transport.calls).toBe(2);
  });

  it('classifies 401/403 as non-retryable HTTP errors', async () => {
    for (const status of [401, 403]) {
      const transport = sequenceTransport([() => Promise.resolve(textResponse(status))]);
      const client = clientWith(transport);

      await expect(client.describe(context())).rejects.toMatchObject({
        diagnostic: { errorType: 'http_non_retryable', httpStatus: status, retryable: false, attempt: 1 },
      });
      expect(transport.calls).toBe(1);
    }
  });

  it('classifies invalid JSON and retries once', async () => {
    const transport = sequenceTransport([
      () => Promise.resolve(rawContentResponse('{not-json')),
      () => Promise.resolve(jsonResponse({ description: '含蓄安全描述' })),
    ]);
    const client = clientWith(transport);

    await expect(client.describe(context())).resolves.toBe('含蓄安全描述');
    expect(transport.calls).toBe(2);
  });

  it('classifies schema validation and network failures', async () => {
    const schemaTransport = sequenceTransport([
      () => Promise.resolve(jsonResponse({ description: '' })),
      () => Promise.resolve(jsonResponse({ description: '' })),
    ]);
    await expect(clientWith(schemaTransport).describe(context())).rejects.toMatchObject({
      diagnostic: { errorType: 'schema_validation', retryable: true, attempt: 2 },
    });

    const networkTransport = sequenceTransport([
      () => Promise.reject(new TypeError('network down')),
      () => Promise.reject(new TypeError('network down')),
      () => Promise.reject(new TypeError('network down')),
      () => Promise.reject(new TypeError('network down')),
    ]);
    await expect(clientWith(networkTransport).describe(context())).rejects.toMatchObject({
      diagnostic: { errorType: 'network', retryable: true, attempt: 4 },
    });
    expect(networkTransport.calls).toBe(4);
  });
  it('captures provider token usage without changing the domain response', async () => {
    const transport = sequenceTransport([() => Promise.resolve(rawContentResponse(
      JSON.stringify({ description: '含蓄安全描述' }),
      { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 40 },
      'deepseek-v4-flash',
    ))]);
    const client = clientWith(transport);
    const usages: import('./model.js').ModelUsage[] = [];
    client.setUsageSink((usage) => usages.push(usage));

    await expect(client.describe(context())).resolves.toBe('含蓄安全描述');
    expect(usages).toHaveLength(1);
    expect(usages[0]).toMatchObject({
      model: 'deepseek-v4-flash',
      promptTokens: 120,
      completionTokens: 30,
      totalTokens: 150,
      promptCacheHitTokens: 80,
      promptCacheMissTokens: 40,
    });
  });
});

function clientWith(transport: ModelTransport & { calls: number }): DeepSeekClient {
  return new DeepSeekClient({ apiKey: 'test-key', transport, model: 'test-model', retryDelayMs: 0 });
}

function sequenceTransport(steps: Array<() => Promise<Response>>): ModelTransport & { calls: number } {
  const transport = ((..._args: Parameters<ModelTransport>) => {
    const step = steps[Math.min(transport.calls, steps.length - 1)];
    transport.calls += 1;
    return step();
  }) as ModelTransport & { calls: number };
  transport.calls = 0;
  return transport;
}

function abortingTransport(): ModelTransport & { calls: number } {
  const transport = ((_url: string | URL | Request, init?: RequestInit) => {
    transport.calls += 1;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new TypeError('fetch failed')), { once: true });
    });
  }) as ModelTransport & { calls: number };
  transport.calls = 0;
  return transport;
}

function jsonResponse(value: unknown): Response {
  return rawContentResponse(JSON.stringify(value));
}

function rawContentResponse(
  content: string,
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number; prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number },
  model?: string,
): Response {
  return new Response(JSON.stringify({ model, choices: [{ message: { content } }], usage }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function textResponse(status: number): Response {
  return new Response('redacted provider body', { status });
}

function context(): AgentContext {
  return {
    identity: {
      playerId: 'ai-1',
      name: '阿序',
      strategyId: 'cautious',
      role: 'civilian',
      word: '测试词A',
    },
    game: {
      gameId: 'test-game',
      round: 1,
      phase: 'describing',
      ballot: 1,
      alivePlayers: [{ id: 'ai-1', name: '阿序' }],
      publicDescriptions: [],
      publicEliminations: [],
    },
  };
}
