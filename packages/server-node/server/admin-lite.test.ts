import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { FakeGameModel } from './support/test-utils.js';

function withAdminTraceEnv<T>(operation: () => Promise<T>): Promise<T> {
  const previousEnabled = process.env.ENABLE_ADMIN_CONSOLE;
  const previousTracePath = process.env.ADMIN_TRACE_JSONL;
  const previousEvaluationPath = process.env.ADMIN_EVALUATION_REPORTS_JSON;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-trace-'));
  process.env.ENABLE_ADMIN_CONSOLE = '1';
  process.env.ADMIN_TRACE_JSONL = path.join(tempDir, 'runtime.jsonl');
  process.env.ADMIN_EVALUATION_REPORTS_JSON = path.join(tempDir, 'evaluation-reports.json');

  return operation().finally(() => {
    if (previousEnabled === undefined) delete process.env.ENABLE_ADMIN_CONSOLE;
    else process.env.ENABLE_ADMIN_CONSOLE = previousEnabled;
    if (previousTracePath === undefined) delete process.env.ADMIN_TRACE_JSONL;
    else process.env.ADMIN_TRACE_JSONL = previousTracePath;
    if (previousEvaluationPath === undefined) delete process.env.ADMIN_EVALUATION_REPORTS_JSON;
    else process.env.ADMIN_EVALUATION_REPORTS_JSON = previousEvaluationPath;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
}

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

  it('returns trace events without exposing secret words before finale', async () => withAdminTraceEnv(async () => {
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
  }));

  it('loads persisted runtime trace events after app restart', async () => withAdminTraceEnv(async () => {
    const first = createApp(new FakeGameModel());
    const created = await request(first.app).post('/api/games').expect(201);
    await request(first.app).post(`/api/games/${created.body.id}/describe`).send({ text: '常见生活场景里会遇到' }).expect(200);

    const restarted = createApp(new FakeGameModel());
    const traces = await request(restarted.app).get(`/api/admin/traces?gameId=${created.body.id}`).expect(200);

    expect(traces.body.count).toBeGreaterThan(0);
    expect(traces.body.events.some((event: { eventType: string }) => event.eventType === 'trace_run')).toBe(true);
    expect(JSON.stringify(traces.body)).not.toContain(created.body.human.word);
  }));
  it('runs the Evaluation MVP through the Admin adapter', async () => withAdminTraceEnv(async () => {
    const { app } = createApp(new FakeGameModel());
    const response = await request(app)
      .post('/api/admin/evaluations')
      .send({ model: 'fake', cases: ['normal-human-input', 'nonsense-human-input'], judgeEnabled: true })
      .expect(201);

    expect(response.body.report.status).toBe('PASS');
    expect(response.body.report.source).toBe('local');
    expect(response.body.report.title).toContain('Fake');
    expect(response.body.report.cases).toHaveLength(2);
    expect(response.body.report.deterministic.metrics.startedGames).toBe(2);
    expect(response.body.report.deterministic.metrics.humanInputResponsiveness.available).toBe(true);
    expect(response.body.report.judge.status).toBe('unavailable');

    const history = await request(app).get('/api/admin/evaluations').expect(200);
    expect(history.body.reports.some((report: { id: string }) => report.id === response.body.report.id)).toBe(true);
    expect(history.body.archivedReports.some((report: { id: string }) => report.id === 'm6')).toBe(true);

    const restarted = createApp(new FakeGameModel());
    const persisted = await request(restarted.app).get('/api/admin/evaluations').expect(200);
    expect(persisted.body.reports.some((report: { id: string }) => report.id === response.body.report.id)).toBe(true);
  }));
});