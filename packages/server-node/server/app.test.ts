import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { FakeGameModel } from './test-utils.js';
import type { AgentContext } from './types.js';

class PausedDescriptionModel extends FakeGameModel {
  private readonly resolvers: Array<() => void> = [];

  override async describe(context: AgentContext): Promise<string> {
    this.descriptionContexts.push(structuredClone(context));
    await new Promise<void>((resolve) => this.resolvers.push(resolve));
    return `公开描述-${context.identity.strategyId}`;
  }

  releaseNext(): void {
    const resolve = this.resolvers.shift();
    if (!resolve) throw new Error('no pending description');
    resolve();
  }
}

describe('HTTP API', () => {
  it('reports model readiness and keeps AI secrets server-side before the finale', async () => {
    const { app } = createApp(new FakeGameModel());

    const health = await request(app).get('/api/health').expect(200);
    expect(health.body).toMatchObject({
      ok: true,
      configured: true,
      model: 'deepseek-v4-flash-test-double',
    });

    const created = await request(app).post('/api/games').expect(201);
    expect(created.body.players).toHaveLength(5);
    expect(created.body.human.word).toBeTypeOf('string');
    for (const player of created.body.players) {
      expect(player).not.toHaveProperty('role');
      expect(player).not.toHaveProperty('word');
      expect(player).not.toHaveProperty('revealedRole');
      expect(player).not.toHaveProperty('revealedWord');
    }
  });

  it('validates malformed actions with a useful client error', async () => {
    const { app } = createApp(new FakeGameModel());
    const created = await request(app).post('/api/games').expect(201);

    const response = await request(app)
      .post(`/api/games/${created.body.id}/vote`)
      .send({ targetId: '' })
      .expect(400);

    expect(response.body.error).toBe('请求格式不正确');
  });

  it('exposes each committed public description through GET while describe is still pending', async () => {
    const model = new PausedDescriptionModel();
    const { app } = createApp(model);
    const created = await request(app).post('/api/games').expect(201);
    const pending = request(app)
      .post(`/api/games/${created.body.id}/describe`)
      .send({ text: '经常出现在普通生活里' })
      .then((response) => response);

    await waitFor(() => model.descriptionContexts.length === 1);
    const afterHuman = await request(app).get(`/api/games/${created.body.id}`).expect(200);
    expect(afterHuman.body.phase).toBe('describing');
    expect(afterHuman.body.descriptions.map((description: { playerId: string }) => description.playerId)).toEqual(['human']);

    model.releaseNext();
    await waitFor(() => model.descriptionContexts.length === 2);
    const afterAiOne = await request(app).get(`/api/games/${created.body.id}`).expect(200);
    expect(afterAiOne.body.descriptions.map((description: { playerId: string }) => description.playerId)).toEqual([
      'human',
      'ai-1',
    ]);
    expect(afterAiOne.body.players.every((player: Record<string, unknown>) => !('role' in player) && !('word' in player))).toBe(true);

    model.releaseNext();
    await waitFor(() => model.descriptionContexts.length === 3);
    model.releaseNext();
    await waitFor(() => model.descriptionContexts.length === 4);
    model.releaseNext();
    await expect(pending).resolves.toMatchObject({ status: 200 });
  });

  it('streams only public progress events over SSE as descriptions are committed', async () => {
    const model = new PausedDescriptionModel();
    const { app } = createApp(model);
    const server = app.listen(0);
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const controller = new AbortController();

    try {
      const created = (await postJson(`${baseUrl}/api/games`, {})) as { id: string };
      const stream = await fetch(`${baseUrl}/api/games/${created.id}/events`, { signal: controller.signal });
      expect(stream.status).toBe(200);
      expect(stream.headers.get('content-type')).toContain('text/event-stream');
      if (!stream.body) throw new Error('SSE stream has no body');
      const reader = stream.body.getReader();

      await readUntil(reader, 'event: ready');
      const pending = postJson(`${baseUrl}/api/games/${created.id}/describe`, {
        text: '经常出现在普通生活里',
      });

      await waitFor(() => model.descriptionContexts.length === 1);
      model.releaseNext();
      const firstAiEvent = await readUntil(reader, '公开描述-');
      expect(firstAiEvent).toContain('event: description_published');
      expect(firstAiEvent).toContain('"playerName":"阿序"');
      expect(firstAiEvent).toContain('"completed":2');
      expect(firstAiEvent).toContain('"nextSpeaker":{"playerId":"ai-2"');
      expect(firstAiEvent).not.toMatch(/"role"|"word"|"revealedRole"|"revealedWord"|"private_reasoning"|"prompt"|"response"/);

      model.releaseNext();
      await waitFor(() => model.descriptionContexts.length === 3);
      model.releaseNext();
      await waitFor(() => model.descriptionContexts.length === 4);
      model.releaseNext();
      const votingEvent = await readUntil(reader, 'event: phase_changed');
      expect(votingEvent).toContain('"phase":"voting"');
      expect(votingEvent).not.toMatch(/"role"|"word"|"revealedRole"|"revealedWord"/);

      await expect(pending).resolves.toMatchObject({ phase: 'voting' });
    } finally {
      controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it('can initialize the production static fallback on Express 5', async () => {
    const previousEnvironment = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const { app } = createApp(new FakeGameModel());
      await request(app).get('/api/health').expect(200);
    } finally {
      process.env.NODE_ENV = previousEnvironment;
    }
  });
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('condition was not reached');
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.json();
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, expected: string): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    if (buffer.includes(expected)) return buffer;
  }
  throw new Error(`SSE event not received: ${expected}`);
}
