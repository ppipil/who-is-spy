import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { FakeGameModel } from './test-utils.js';

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
