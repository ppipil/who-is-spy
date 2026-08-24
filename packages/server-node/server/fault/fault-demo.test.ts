import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { FakeGameModel } from '../support/test-utils.js';

describe('Admin Fault Demo thin adapter', () => {
  it('keeps a provider timeout visible and paused until manual resume', async () => {
    const { app } = createApp(new FakeGameModel());
    const started = await request(app).post('/api/admin/fault-demos/run').send({ scenario: 'describe-timeout' }).expect(201);
    expect(started.body).toMatchObject({
      scenario: 'describe-timeout', faultStatus: 'FAULT TRIGGERED', outcome: 'PAUSED SAFELY',
      injectedFault: 'timeout', agentId: 'ai-4', task: 'describe', phase: 'describing', canRecover: true,
    });
    expect(started.body.timeline.filter((step: { kind: string }) => step.kind === 'attempt')).toMatchObject([
      { status: 'FAILED', attempt: 1, errorType: 'timeout', willRetry: true },
      { status: 'FAILED', attempt: 2, errorType: 'timeout', willRetry: false },
    ]);
    expect(started.body.stateEvidence).toContain('Committed votes: 0');

    const recovered = await request(app).post(`/api/admin/fault-demos/${started.body.runId}/recover`).expect(200);
    expect(recovered.body).toMatchObject({
      faultStatus: 'FAULT TRIGGERED', outcome: 'RECOVERED BY MANUAL RESUME', phase: 'voting', canRecover: false,
    });
    expect(recovered.body.timeline).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'manual_resume', status: 'STARTED' }),
      expect.objectContaining({ kind: 'manual_resume', status: 'RECOVERED' }),
      expect.objectContaining({ kind: 'attempt', status: 'SUCCESS' }),
    ]));

    const trace = await request(app).get(`/api/admin/traces?id=${started.body.runId}`).expect(200);
    expect(trace.body.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: 'model_call', errorType: 'timeout', outcome: 'failure', injectedFault: expect.objectContaining({ faultType: 'timeout' }) }),
      expect.objectContaining({ eventType: 'recovery_action', recoveryOutcome: 'recovered' }),
    ]));
    const replay = await request(app).get(`/api/admin/traces/${started.body.runId}/replay`).expect(200);
    expect(replay.body.replay).toContain('请求超时');
    expect(replay.body.replay).toContain('手动恢复');
  });

  it('rejects bad JSON and visibly recovers through bounded retry', async () => {
    const { app } = createApp(new FakeGameModel());
    const response = await request(app).post('/api/admin/fault-demos/run').send({ scenario: 'describe-bad-json' }).expect(201);
    expect(response.body).toMatchObject({
      faultStatus: 'FAULT TRIGGERED', outcome: 'RECOVERED BY RETRY', injectedFault: 'invalid_json',
      agentId: 'ai-2', phase: 'voting', canRecover: false,
    });
    expect(response.body.timeline).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'attempt', status: 'FAILED', attempt: 1, errorType: 'invalid_json' }),
      expect.objectContaining({ kind: 'retry', status: 'SCHEDULED' }),
      expect.objectContaining({ kind: 'attempt', status: 'SUCCESS', attempt: 2 }),
    ]));
  });

  it('shows review retry exhaustion followed by local fallback', async () => {
    const { app } = createApp(new FakeGameModel());
    const response = await request(app).post('/api/admin/fault-demos/run').send({ scenario: 'review-failure' }).expect(201);
    expect(response.body).toMatchObject({
      faultStatus: 'FAULT TRIGGERED', outcome: 'RECOVERED BY FALLBACK', injectedFault: 'provider_5xx',
      agentId: 'review', task: 'review', phase: 'finished', canRecover: false,
    });
    expect(response.body.timeline).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'attempt', status: 'FAILED', attempt: 2, willRetry: false }),
      expect.objectContaining({ kind: 'retry', status: 'EXHAUSTED' }),
      expect.objectContaining({ kind: 'fallback', status: 'RECOVERED' }),
    ]));
  });

  it('exposes only fixed scenarios and a complete Fault run summary', async () => {
    const { app } = createApp(new FakeGameModel());
    const list = await request(app).get('/api/admin/fault-demos').expect(200);
    expect(list.body.scenarios.map((scenario: { id: string }) => scenario.id)).toEqual([
      'describe-timeout', 'describe-bad-json', 'review-failure',
    ]);
    await request(app).post('/api/admin/fault-demos/run').send({ scenario: 'custom-fault' }).expect(400);
    const run = await request(app).post('/api/admin/fault-demos/run').send({ scenario: 'describe-bad-json' }).expect(201);
    const summaries = await request(app).get('/api/admin/trace-runs?sourceType=FAULT_RUN').expect(200);
    expect(summaries.body.runs).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: run.body.runId, sourceType: 'FAULT_RUN', scenario: 'describe-bad-json', faultType: 'invalid_json', scenarioOutcome: 'RECOVERED BY RETRY' }),
    ]));
  });
});
