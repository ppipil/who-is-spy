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
