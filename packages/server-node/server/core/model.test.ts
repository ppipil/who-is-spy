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
    ]);
    await expect(clientWith(networkTransport).describe(context())).rejects.toMatchObject({
      diagnostic: { errorType: 'network', retryable: true, attempt: 2 },
    });
  });
});

function clientWith(transport: ModelTransport & { calls: number }): DeepSeekClient {
  return new DeepSeekClient({ apiKey: 'test-key', transport, model: 'test-model' });
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

function jsonResponse(value: unknown): Response {
  return rawContentResponse(JSON.stringify(value));
}

function rawContentResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
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
