import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { FakeGameModel } from './test-utils.js';

describe('Admin Lite trace API', () => {
  it('is disabled unless ENABLE_ADMIN_CONSOLE is set', async () => {
    const previous = process.env.ENABLE_ADMIN_CONSOLE;
    delete process.env.ENABLE_ADMIN_CONSOLE;
    try {
      const { app } = createApp(new FakeGameModel());
      await request(app).get('/api/admin/status').expect(404);
    } finally {
      if (previous === undefined) delete process.env.ENABLE_ADMIN_CONSOLE;
      else process.env.ENABLE_ADMIN_CONSOLE = previous;
    }
  });

  it('returns trace events without exposing secret words before finale', async () => {
    const previous = process.env.ENABLE_ADMIN_CONSOLE;
    process.env.ENABLE_ADMIN_CONSOLE = '1';
    try {
      const { app } = createApp(new FakeGameModel());
      const created = await request(app).post('/api/games').expect(201);
      await request(app).post(`/api/games/${created.body.id}/describe`).send({ text: '常见生活场景里会遇到' }).expect(200);

      const traces = await request(app).get(`/api/admin/traces?gameId=${created.body.id}`).expect(200);
      const body = JSON.stringify(traces.body);
      expect(traces.body.events.some((event: { eventType: string }) => event.eventType === 'vote')).toBe(false);
      expect(body).not.toContain(created.body.human.word);
      for (const player of created.body.players) {
        expect(body).not.toContain(player.word);
        expect(body).not.toContain(player.revealedWord);
      }
    } finally {
      if (previous === undefined) delete process.env.ENABLE_ADMIN_CONSOLE;
      else process.env.ENABLE_ADMIN_CONSOLE = previous;
    }
  });
});
