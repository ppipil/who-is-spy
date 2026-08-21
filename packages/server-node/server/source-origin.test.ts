import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { DeepSeekClient } from './model.js';
import { InMemoryTraceSink, stampTraceOrigin, type TraceOrigin } from './trace.js';

function mockTransport(): typeof fetch {
  return async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    const user = JSON.parse(body.messages[1].content) as Record<string, unknown>;
    let content: string;
    if (user.allowedTargets) {
      const targets = user.allowedTargets as Array<{ id: string }>;
      const target = targets.find((item) => item.id !== 'human') ?? targets[0];
      content = JSON.stringify({ targetId: target.id, reason: '公开证据表明最可疑' });
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
      content = JSON.stringify({ description: textByAgent[agentId] ?? '含蓄的安全描述' });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

describe('source origin stamping', () => {
  it('stamps origin fields on every event passing through the wrapper, including quality violations', () => {
    const memory = new InMemoryTraceSink();
    const origin: TraceOrigin = { sourceType: 'CLI_DEMO', entrypoint: 'cli', modelKind: 'fake' };
    const stamped = stampTraceOrigin(memory, origin);
    stamped.record({
      eventType: 'public_event',
      gameId: 'g1',
      round: 1,
      phase: 'describing',
      publicEventType: 'description',
      text: 'x',
      outcome: 'success',
    });
    stamped.record({
      eventType: 'quality_violation',
      gameId: 'g1',
      round: 1,
      agentId: 'ai-1',
      attempt: 1,
      violationType: 'secret_leak',
      willRetry: true,
    });
    expect(memory.events).toHaveLength(2);
    expect(
      memory.events.every(
        (event) =>
          event.sourceType === 'CLI_DEMO' && event.entrypoint === 'cli' && event.modelKind === 'fake',
      ),
    ).toBe(true);
  });

  it('distinguishes user game, admin probe and eval run in runtime trace and prompt trace', async () => {
    const makeModel = () => new DeepSeekClient({ transport: mockTransport(), apiKey: 'test-key' });
    const app = createApp(makeModel(), { adminEnabled: true, task1ProbeModel: makeModel() });

    // USER_GAME（测试环境自动标记 TEST/test）
    const game = await request(app.app).post('/api/games').expect(201);
    await request(app.app)
      .post(`/api/games/${game.body.id}/describe`)
      .send({ text: '上下班的时候很多人会接触到' })
      .expect(200);

    // ADMIN_PROBE：顺序实验 + persona 探针
    await request(app.app)
      .post('/api/admin/task1/sequential/run')
      .send({
        civilianWord: '地铁',
        undercoverWord: '高铁',
        humanDescription: '上下班的时候很多人会接触到',
        round: 1,
      })
      .expect(200);
    await request(app.app)
      .post('/api/admin/task1/persona/run')
      .send({
        role: 'undercover',
        word: '高铁',
        round: 2,
        publicDescriptions: [{ playerId: 'human', playerName: '你', text: '上下班的时候很多人会接触到。' }],
      })
      .expect(200);

    // EVAL_RUN（fake，经 admin 入口 → entrypoint test）
    const started = await request(app.app)
      .post('/api/admin/evaluation/run')
      .send({ games: 1, seed: 42, model: 'fake' })
      .expect(202);
    let detail: { body: { status?: string } } | undefined;
    for (let i = 0; i < 150; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      detail = (await request(app.app)
        .get(`/api/admin/evaluation/runs/${started.body.runId}`)
        .expect(200)) as unknown as { body: { status?: string } };
      if (detail.body.status !== 'running') break;
    }
    expect(detail?.body.status).toBe('completed');

    const traces = await request(app.app).get('/api/admin/traces').expect(200);
    const events = traces.body.events as Array<Record<string, unknown>>;
    const traceSources = new Set(
      events.map((event) => `${String(event.sourceType)}/${String(event.entrypoint)}/${String(event.modelKind)}`),
    );
    expect(traceSources.has('TEST/test/real')).toBe(true);
    expect(traceSources.has('ADMIN_PROBE/admin/real')).toBe(true);
    expect(traceSources.has('EVAL_RUN/test/fake')).toBe(true);
    // Persona Probe 现在也应进入 runtime trace（固定 gameId task1-probe）
    expect(events.some((event) => event.gameId === 'task1-probe')).toBe(true);

    const prompts = await request(app.app).get('/api/admin/prompt-traces').expect(200);
    const records = prompts.body.records as Array<Record<string, unknown>>;
    const promptSources = new Set(
      records.map((record) => `${String(record.sourceType)}/${String(record.entrypoint)}/${String(record.modelKind)}`),
    );
    expect(promptSources.has('TEST/test/real')).toBe(true);
    expect(promptSources.has('ADMIN_PROBE/admin/real')).toBe(true);
    expect(records.some((record) => record.gameId === 'task1-probe' && record.sourceType === 'ADMIN_PROBE')).toBe(true);
  });
});
