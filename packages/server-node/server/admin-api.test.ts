import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from './app.js';
import { EvaluationRunStore, type EvaluationRunner } from './admin/evaluation-runs.js';
import { runEvaluation } from './evaluation.js';
import { DeepSeekClient } from './model.js';
import { FakeGameModel } from './test-utils.js';
import type { AgentContext, Player } from './types.js';

class InvalidVoteModel extends FakeGameModel {
  override async vote(
    _context: AgentContext,
    _allowedTargets: Player[],
  ): Promise<{ targetId: string; reason: string }> {
    return { targetId: 'not-a-player', reason: '故意注入非法目标' };
  }
}

async function waitForEvaluationRun(app: Express, runId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await request(app).get(`/api/admin/evaluation/runs/${runId}`).expect(200);
    if (response.body.status !== 'running') return response.body;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('evaluation run did not finish in time');
}

function mockTransport(options?: { avoidHumanVote?: boolean }): typeof fetch {
  return async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    const user = JSON.parse(body.messages[1].content) as Record<string, unknown>;
    let content: string;
    if (user.allowedTargets) {
      const targets = user.allowedTargets as Array<{ id: string }>;
      const target = options?.avoidHumanVote
        ? (targets.find((item) => item.id !== 'human') ?? targets[0])
        : targets[0];
      const identity = (user.context as { identity?: { word?: string } } | undefined)?.identity;
      content = JSON.stringify({ targetId: target.id, reason: `公开证据表明最可疑：${identity?.word ?? ''}` });
    } else if (user.record) {
      const players = (user.record as { players: Array<{ id: string }> }).players;
      content = JSON.stringify({
        headline: '复盘结论',
        summary: '基于公开记录与票型给出完整复盘。',
        turningPoints: ['终局票型决定了胜负。'],
        playerInsights: players.map((player) => ({ playerId: player.id, insight: '围绕公开信息做出判断。' })),
      });
    } else {
      const agentId = (user.context as { identity?: { playerId?: string } } | undefined)?.identity?.playerId ?? '';
      const textByAgent: Record<string, string> = {
        'ai-1': '通常出现在特定的场合',
        'ai-2': '人们需要提前安排才能使用',
        'ai-3': '它帮助缩短了两地之间的距离',
        'ai-4': '有时候反而会带来一些不便',
      };
      content = JSON.stringify({
        description: textByAgent[agentId] ?? '含蓄的安全描述',
        private_reasoning_summary: '依据公开信息',
      });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

describe('admin console', () => {
  it('returns 404 for /admin and /api/admin/* when disabled', async () => {
    const { app } = createApp();
    await request(app).get('/admin').expect(404);
    await request(app).get('/api/admin/status').expect(404);
    await request(app).get('/api/admin/traces').expect(404);
  });

  it('serves status, traces, and prompt traces when enabled', async () => {
    const { app } = createApp(new DeepSeekClient({ transport: mockTransport(), apiKey: 'test-key' }), {
      adminEnabled: true,
    });

    await request(app).get('/admin').expect(200);
    const status = await request(app).get('/api/admin/status').expect(200);
    expect(status.body).toMatchObject({
      runtimeTrace: 'ON',
      adminEnabled: true,
      fault: { state: 'normal' },
      activeGames: 0,
    });

    const created = await request(app).post('/api/games').expect(201);
    const gameId = created.body.id;
    await request(app).post(`/api/games/${gameId}/describe`).send({ text: '经常出现在普通生活里' }).expect(200);

    const traces = await request(app).get('/api/admin/traces').query({ gameId }).expect(200);
    expect(traces.body.count).toBeGreaterThan(0);
    expect(traces.body.events.every((event: { gameId: string }) => event.gameId === gameId)).toBe(true);
    expect(traces.body.events.some((event: { eventType: string }) => event.eventType === 'model_call')).toBe(true);
    const ai1DescribeSuccesses = traces.body.events.filter(
      (event: { eventType: string; task: string; agentId: string; outcome: string }) =>
        event.eventType === 'model_call' &&
        event.task === 'describe' &&
        event.agentId === 'ai-1' &&
        event.outcome === 'success',
    );
    expect(ai1DescribeSuccesses).toHaveLength(1);

    const prompts = await request(app).get('/api/admin/prompt-traces').query({ gameId }).expect(200);
    expect(prompts.body.count).toBeGreaterThan(0);
    const serialized = JSON.stringify(prompts.body);
    expect(serialized).toContain('<REDACTED>');
    expect(serialized).not.toContain('地铁');
    expect(serialized).not.toContain('高铁');
    expect(serialized).not.toContain('DEEPSEEK_API_KEY');
    expect(serialized).toContain('describe-v3');
  });

  it('arms, triggers, and clears a real fault through the running engine', async () => {
    const { app } = createApp(new DeepSeekClient({ transport: mockTransport(), apiKey: 'test-key' }), {
      adminEnabled: true,
    });

    await request(app).post('/api/admin/faults/arm').send({ scenario: 'describe-timeout' }).expect(200);
    const armed = await request(app).get('/api/admin/faults').expect(200);
    expect(armed.body.state).toBe('armed');

    const created = await request(app).post('/api/games').expect(201);
    const gameId = created.body.id;
    await request(app).post(`/api/games/${gameId}/describe`).send({ text: '经常出现在普通生活里' }).expect(200);

    const after = await request(app).get('/api/admin/faults').expect(200);
    expect(after.body.state).toBe('triggered');
    expect(after.body.triggeredCount).toBeGreaterThanOrEqual(1);
    expect(after.body.gameId).toBe(gameId);
    expect(after.body.scenario).toBe('describe-timeout');
    const traces = await request(app).get('/api/admin/traces').query({ gameId, errorType: 'timeout' }).expect(200);
    expect(
      traces.body.events.some(
        (event: { outcome: string; willRetry: boolean }) => event.outcome === 'failure' && event.willRetry === true,
      ),
    ).toBe(true);

    await request(app).post('/api/admin/faults/clear').expect(200);
    const cleared = await request(app).get('/api/admin/faults').expect(200);
    expect(cleared.body.state).toBe('normal');
  });

  it('honors an injected delay so the simulated timeout feels real', async () => {
    const { app } = createApp(new DeepSeekClient({ transport: mockTransport(), apiKey: 'test-key' }), {
      adminEnabled: true,
    });
    await request(app)
      .post('/api/admin/faults/arm')
      .send({ scenario: 'describe-timeout', delayMs: 80 })
      .expect(200);
    const created = await request(app).post('/api/games').expect(201);
    const gameId = created.body.id;
    const startedAt = Date.now();
    await request(app).post(`/api/games/${gameId}/describe`).send({ text: '经常出现在普通生活里' }).expect(200);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(80);
    const traces = await request(app).get('/api/admin/traces').query({ gameId, errorType: 'timeout' }).expect(200);
    const failure = traces.body.events.find((event: { outcome: string }) => event.outcome === 'failure');
    expect(failure).toBeDefined();
    expect(failure.latencyMs).toBeGreaterThanOrEqual(80);
  });

  it('serves canonical evaluation evidence without hiding seed 101 failure', async () => {
    const { app } = createApp(new DeepSeekClient({ transport: mockTransport(), apiKey: 'test-key' }), {
      adminEnabled: true,
    });
    const evaluation = await request(app).get('/api/admin/evaluation').expect(200);
    expect(evaluation.body.baseline.completionRate).toBe(1);
    expect(evaluation.body.final.completionRate).toBe(0.8);
    expect(evaluation.body.final.gateFailures ?? evaluation.body.seed101.gateFailures).toBeDefined();
    expect(evaluation.body.seed101.note).toContain('timeout');
  });

  it('runs a seeded fake evaluation and exposes progress, gate, and history', async () => {
    const { app } = createApp(undefined, { adminEnabled: true });
    const started = await request(app)
      .post('/api/admin/evaluation/run')
      .send({ games: 2, seed: 7, model: 'fake' })
      .expect(202);
    const runId = started.body.runId as string;

    const detail = await waitForEvaluationRun(app, runId);
    expect(detail.status).toBe('completed');
    expect(detail.config).toEqual({ games: 2, seed: 7, model: 'fake' });
    expect(detail.gate).toEqual({ passed: true, failures: [] });
    const result = detail.result as {
      metrics: { startedGames: number; completedGames: number; validVoteRate: number; descriptionHomogeneity: number };
    };
    expect(result.metrics.startedGames).toBe(2);
    expect(result.metrics.completedGames).toBe(2);
    expect(result.metrics.validVoteRate).toBe(1);
    expect(detail.progress).toEqual({ completedGames: 2, totalGames: 2 });

    const list = await request(app).get('/api/admin/evaluation/runs').expect(200);
    expect(list.body.runs).toHaveLength(1);
    expect(list.body.runs[0].runId).toBe(runId);

    const traces = await request(app).get('/api/admin/traces').query({ runId }).expect(200);
    expect(traces.body.count).toBeGreaterThan(0);
    expect(
      traces.body.events.every(
        (event: { runId: string; source: string }) => event.runId === runId && event.source === 'evaluation',
      ),
    ).toBe(true);
  });

  it('rejects invalid evaluation configuration', async () => {
    const { app } = createApp(undefined, { adminEnabled: true });
    await request(app).post('/api/admin/evaluation/run').send({ games: 0, seed: 42 }).expect(400);
    await request(app).post('/api/admin/evaluation/run').send({ games: 101, seed: 42 }).expect(400);
    await request(app).post('/api/admin/evaluation/run').send({ games: 1, seed: 1.5 }).expect(400);
    await request(app).post('/api/admin/evaluation/run').send({ games: 1, seed: 1, model: 'unknown' }).expect(400);
  });

  it('returns 409 while another evaluation is running', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pendingRunner: EvaluationRunner = async () => {
      await pending;
      return runEvaluation({ games: 1, seed: 1, modelKind: 'fake' });
    };
    const store = new EvaluationRunStore(pendingRunner);
    const { app } = createApp(undefined, { adminEnabled: true, evaluationRuns: store, evaluationRunner: pendingRunner });

    await request(app).post('/api/admin/evaluation/run').send({ games: 1, seed: 1, model: 'fake' }).expect(202);
    const busy = await request(app).post('/api/admin/evaluation/run').send({ games: 1, seed: 2, model: 'fake' }).expect(409);
    expect(busy.body.error).toContain('评测已在运行');
    release();
  });

  it('records a failed gate and incomplete state in the run detail', async () => {
    const failingRunner: EvaluationRunner = async ({ games, seed, onProgress }) =>
      runEvaluation({
        games,
        seed,
        modelKind: 'fake',
        model: new InvalidVoteModel(),
        onProgress,
      });
    const { app } = createApp(undefined, { adminEnabled: true, evaluationRunner: failingRunner });

    const started = await request(app)
      .post('/api/admin/evaluation/run')
      .send({ games: 1, seed: 42, model: 'fake' })
      .expect(202);
    const detail = await waitForEvaluationRun(app, started.body.runId as string);
    expect(detail.status).toBe('completed');
    expect(detail.gate).toMatchObject({ passed: false });
    expect((detail.gate as { failures: string[] }).failures).toContain('validVoteRate must equal 1.0');
    const result = detail.result as { metrics: { validVoteRate: number; safety: { illegalStateOccurrences: number } } };
    expect(result.metrics.validVoteRate).toBe(0);
    expect(result.metrics.safety.illegalStateOccurrences).toBe(1);
  });

  it('rejects real model runs when the provider is not configured', async () => {
    const previousKey = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = '';
    try {
      const { app } = createApp(undefined, { adminEnabled: true });
      await request(app).post('/api/admin/evaluation/run').send({ games: 1, seed: 42, model: 'real' }).expect(400);
    } finally {
      if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = previousKey;
    }
  });

  it('serves task 1 acceptance evidence aggregator', async () => {
    const { app } = createApp(undefined, { adminEnabled: true });
    const task1 = await request(app).get('/api/admin/task1').expect(200);
    expect(task1.body.relation.label).toContain('Sequential Context');
    expect(task1.body.relation.meaning).toBe('看到了什么 → 怎么决策 → 什么允许公开');
    expect(task1.body.persona.cases).toHaveLength(4);
    expect(
      task1.body.persona.cases.every(
        (item: { description: string; reason: string }) => item.description.length > 0 && item.reason.length > 0,
      ),
    ).toBe(true);
    expect(task1.body.qualityGate.attempts.map((attempt: { gate: string }) => attempt.gate)).toEqual([
      'REJECTED',
      'PASSED',
    ]);
    expect(task1.body.sameRound).toBeNull();
  });

  it('rebuilds a custom sequential context with real prompt hashing', async () => {
    const { app } = createApp(undefined, { adminEnabled: true });
    const built = await request(app)
      .post('/api/admin/task1/context')
      .send({
        agentId: 'ai-3',
        round: 2,
        publicDescriptions: [
          { playerId: 'human', playerName: '你', text: '上下班的时候很多人会接触到。' },
          { playerId: 'ai-1', playerName: '阿序', text: '经常需要在固定的地方等它。' },
          { playerId: 'ai-2', playerName: '弥生', text: '通常会按照自己的路线移动。' },
        ],
      })
      .expect(200);
    expect(built.body.agentId).toBe('ai-3');
    expect(built.body.sameRoundPublicDescriptionCount).toBe(3);
    expect(built.body.publicDescriptionCount).toBe(3);
    expect(built.body.promptVersion).toBeTruthy();
    expect(built.body.promptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(built.body.messages.length).toBeGreaterThan(0);

    const changed = await request(app)
      .post('/api/admin/task1/context')
      .send({
        agentId: 'ai-1',
        round: 2,
        publicDescriptions: [
          { playerId: 'human', playerName: '你', text: '上下班的时候很多人会接触到。' },
        ],
      })
      .expect(200);
    expect(changed.body.sameRoundPublicDescriptionCount).toBe(1);
    expect(changed.body.promptHash).not.toBe(built.body.promptHash);
  });

  it('runs the real quality gate on custom candidates', async () => {
    const { app } = createApp(undefined, { adminEnabled: true });
    const result = await request(app)
      .post('/api/admin/task1/quality')
      .send({
        attempt1Candidate: '一种不太张扬但很常见的体验',
        attempt2Candidate: '它常在特定场合形成明显氛围',
        acceptedSameRound: ['这是生活里熟悉的一种东西', '一种不太张扬但很常见的体验'],
        threshold: 0.72,
        allSecrets: ['高铁', '地铁'],
      })
      .expect(200);
    expect(result.body.attempts.map((attempt: { gate: string }) => attempt.gate)).toEqual(['REJECTED', 'PASSED']);
    expect(result.body.attempts[0]).toMatchObject({ reason: 'duplicate_description', similarity: 1, willRetry: true });
    expect(result.body.committed).toBe('它常在特定场合形成明显氛围');
    expect(result.body.notCommitted).toEqual(['一种不太张扬但很常见的体验']);
  });

  it('runs a custom persona comparison through the probe model', async () => {
    const probeModel = new DeepSeekClient({ transport: mockTransport(), apiKey: 'test-key' });
    const { app } = createApp(undefined, { adminEnabled: true, task1ProbeModel: probeModel });
    const result = await request(app)
      .post('/api/admin/task1/persona/run')
      .send({
        role: 'undercover',
        word: '高铁',
        round: 2,
        publicDescriptions: [
          { playerId: 'human', playerName: '你', text: '上下班的时候很多人会接触到。' },
        ],
      })
      .expect(200);
    expect(result.body.cases).toHaveLength(4);
    expect(result.body.cases.every((item: { description: string; voteTarget: string }) => item.description.length > 0 && item.voteTarget.length > 0)).toBe(
      true,
    );
    expect(result.body.cases.every((item: { prompts: { describe: { messages: unknown[] } } }) => item.prompts.describe.messages.length > 0)).toBe(
      true,
    );
    expect(result.body.generatedAt).toBeTruthy();
  });

  it('runs a real sequential round with the requested word pair and growing same-round context', async () => {
    const probeModel = new DeepSeekClient({ transport: mockTransport(), apiKey: 'test-key' });
    const { app } = createApp(undefined, { adminEnabled: true, task1ProbeModel: probeModel });
    const result = await request(app)
      .post('/api/admin/task1/sequential/run')
      .send({
        civilianWord: '地铁',
        undercoverWord: '高铁',
        humanDescription: '上下班的时候很多人会接触到',
        round: 1,
      })
      .expect(200);
    expect(result.body.gameId).toBeTruthy();
    expect(result.body.civilianWord).toBe('地铁');
    expect(result.body.steps).toHaveLength(5);
    expect(result.body.steps.map((step: { agentId: string }) => step.agentId)).toEqual([
      'human',
      'ai-1',
      'ai-2',
      'ai-3',
      'ai-4',
    ]);
    const counts = result.body.steps.map(
      (step: { sameRoundPublicDescriptionCount: number }) => step.sameRoundPublicDescriptionCount,
    );
    expect(counts).toEqual([0, 1, 2, 3, 4]);
    const ai4 = result.body.steps[4];
    expect(ai4.receivedSameRound).toHaveLength(4);
    expect(ai4.description.length).toBeGreaterThan(0);
    expect(ai4.promptVersion).toBeTruthy();
    expect(ai4.promptHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('advances through voting into round 2 with continuing same-round context', async () => {
    const probeModel = new DeepSeekClient({
      transport: mockTransport({ avoidHumanVote: true }),
      apiKey: 'test-key',
    });
    const { app } = createApp(undefined, { adminEnabled: true, task1ProbeModel: probeModel });
    const result = await request(app)
      .post('/api/admin/task1/sequential/run')
      .send({
        civilianWord: '地铁',
        undercoverWord: '高铁',
        humanDescription: '上下班的时候很多人会接触到',
        round: 2,
      })
      .expect(200);
    expect(result.body.round).toBe(2);
    expect(result.body.completedRounds).toBe(2);
    expect(result.body.endedNote).toBeUndefined();
    const rounds = [...new Set(result.body.steps.map((step: { round: number }) => step.round))];
    expect(rounds).toEqual([1, 2]);
    const round2 = result.body.steps.filter((step: { round: number }) => step.round === 2);
    expect(round2.some((step: { agentId: string }) => step.agentId === 'human')).toBe(true);
    const round2Ai = round2.filter((step: { agentId: string }) => step.agentId !== 'human');
    expect(round2Ai.length).toBeGreaterThan(0);
    expect(round2Ai[0].sameRoundPublicDescriptionCount).toBeGreaterThanOrEqual(1);
    expect(round2Ai[0].receivedSameRound.length).toBeGreaterThanOrEqual(1);
    expect(round2Ai[0].promptVersion).toBeTruthy();
  });

  it('returns vote details with secret words redacted', async () => {
    const model = new DeepSeekClient({
      transport: mockTransport({ avoidHumanVote: true }),
      apiKey: 'test-key',
    });
    const { app } = createApp(model, { adminEnabled: true });
    const created = await request(app).post('/api/games').expect(201);
    const gameId = created.body.id;
    await request(app)
      .post(`/api/games/${gameId}/describe`)
      .send({ text: '上下班的时候很多人会接触到' })
      .expect(200);
    const beforeVote = await request(app).get(`/api/games/${gameId}`).expect(200);
    const target = beforeVote.body.players.find(
      (player: { alive: boolean; isHuman: boolean }) => player.alive && !player.isHuman,
    );
    await request(app)
      .post(`/api/games/${gameId}/vote`)
      .send({ targetId: target.id })
      .expect(200);

    const votes = await request(app).get(`/api/admin/games/${gameId}/votes`).expect(200);
    expect(votes.body.players).toHaveLength(5);
    expect(votes.body.votes.length).toBeGreaterThan(0);
    const humanWord = (await request(app).get(`/api/games/${gameId}`).expect(200)).body.human.word as string;
    for (const vote of votes.body.votes as Array<{ reason: string }>) {
      expect(vote.reason).not.toContain(humanWord);
    }
    expect(votes.body.votes.some((vote: { reason: string }) => vote.reason.includes('[SECRET]'))).toBe(true);

    await request(app).get('/api/admin/games/not-a-game/votes').expect(404);
  });

  it('searches internal content server-side with redacted matches', async () => {
    const model = new DeepSeekClient({
      transport: mockTransport({ avoidHumanVote: true }),
      apiKey: 'test-key',
    });
    const { app } = createApp(model, { adminEnabled: true });
    const created = await request(app).post('/api/games').expect(201);
    const gameId = created.body.id;
    await request(app)
      .post(`/api/games/${gameId}/describe`)
      .send({ text: '上下班的时候很多人会接触到' })
      .expect(200);
    const game = await request(app).get(`/api/games/${gameId}`).expect(200);
    const target = game.body.players.find(
      (player: { alive: boolean; isHuman: boolean }) => player.alive && !player.isHuman,
    );
    await request(app)
      .post(`/api/games/${gameId}/vote`)
      .send({ targetId: target.id })
      .expect(200);
    const humanWord = (await request(app).get(`/api/games/${gameId}`).expect(200)).body.human.word as string;

    const common = await request(app).post('/api/admin/traces/search').send({ keyword: '上下班' }).expect(200);
    expect(common.body.count).toBeGreaterThan(0);
    expect(common.body.matches.some((match: { field: string }) => match.field === 'description')).toBe(true);

    // 搜索所有投票理由共有的前缀：必然命中 vote_reason，且密词应被替换为 [SECRET]。
    // （不能直接搜 humanWord：引擎随机分配角色，人类可能是卧底，其词未必出现在任何理由中）
    const secret = await request(app).post('/api/admin/traces/search').send({ keyword: '公开证据表明最可疑' }).expect(200);
    expect(secret.body.count).toBeGreaterThan(0);
    expect(secret.body.matches.every((match: { field: string }) => match.field === 'vote_reason')).toBe(true);
    for (const match of secret.body.matches as Array<{ text: string }>) {
      expect(match.text).not.toContain(humanWord);
    }
    expect(secret.body.matches.some((match: { text: string }) => match.text.includes('[SECRET]'))).toBe(true);

    await request(app).post('/api/admin/traces/search').send({ keyword: '' }).expect(400);
  });

  it('rejects sequential run when the probe model is not configured', async () => {
    const previousKey = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = '';
    try {
      const { app } = createApp(undefined, { adminEnabled: true });
      await request(app)
        .post('/api/admin/task1/sequential/run')
        .send({ civilianWord: '地铁', undercoverWord: '高铁', humanDescription: '上下班的时候很多人会接触到', round: 1 })
        .expect(400);
    } finally {
      if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = previousKey;
    }
  });

  it('rejects persona comparison when the probe model is not configured', async () => {
    const previousKey = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = '';
    try {
      const { app } = createApp(undefined, { adminEnabled: true });
      await request(app)
        .post('/api/admin/task1/persona/run')
        .send({ role: 'civilian', word: '地铁', round: 1, publicDescriptions: [] })
        .expect(400);
    } finally {
      if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = previousKey;
    }
  });
});
