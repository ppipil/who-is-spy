import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { DeepSeekClient } from './model.js';

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

const ENV_KEYS = ['M5_TRACE_JSONL', 'PROMPT_TRACE_JSONL', 'ADMIN_EVAL_RUNS_JSON'];

let tempDir = '';
const previousEnv = new Map<string, string | undefined>();

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-persist-'));
  for (const key of ENV_KEYS) previousEnv.set(key, process.env[key]);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const previous = previousEnv.get(key);
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('admin history persistence across simulated restart', () => {
  it('recovers runtime trace, prompt trace and eval run history from local files', async () => {
    process.env.M5_TRACE_JSONL = path.join(tempDir, 'trace.jsonl');
    process.env.PROMPT_TRACE_JSONL = path.join(tempDir, 'prompt.jsonl');
    process.env.ADMIN_EVAL_RUNS_JSON = path.join(tempDir, 'runs.json');

    const makeModel = () => new DeepSeekClient({ transport: mockTransport(), apiKey: 'test-key' });

    // 第一次启动：玩一局真实对局 + 跑一次 fake 评测
    const app1 = createApp(makeModel(), { adminEnabled: true });
    const game = await request(app1.app).post('/api/games').expect(201);
    const gameId = game.body.id;
    await request(app1.app)
      .post(`/api/games/${gameId}/describe`)
      .send({ text: '上下班的时候很多人会接触到' })
      .expect(200);
    const before = await request(app1.app).get(`/api/games/${gameId}`).expect(200);
    const target = before.body.players.find(
      (player: { alive: boolean; isHuman: boolean }) => player.alive && !player.isHuman,
    );
    await request(app1.app)
      .post(`/api/games/${gameId}/vote`)
      .send({ targetId: target.id })
      .expect(200);

    const started = await request(app1.app)
      .post('/api/admin/evaluation/run')
      .send({ games: 1, seed: 42, model: 'fake' })
      .expect(202);
    const runId = started.body.runId as string;
    let detail: { body: { status?: string } } | undefined;
    for (let i = 0; i < 150; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      detail = (await request(app1.app)
        .get(`/api/admin/evaluation/runs/${runId}`)
        .expect(200)) as unknown as { body: { status?: string } };
      if (detail.body.status !== 'running') break;
    }
    expect(detail?.body.status).toBe('completed');

    const traces1 = await request(app1.app).get('/api/admin/traces').expect(200);
    const traceCount1 = traces1.body.count as number;
    const maxSeq1 = (traces1.body.events as Array<{ sequence: number }>).reduce(
      (max, event) => Math.max(max, event.sequence),
      0,
    );
    const promptCount1 = (await request(app1.app).get('/api/admin/prompt-traces').expect(200)).body.count as number;
    expect(traceCount1).toBeGreaterThan(0);
    expect(promptCount1).toBeGreaterThan(0);

    // 模拟重启：相同环境变量重建 app，历史应从本地文件恢复
    const app2 = createApp(makeModel(), { adminEnabled: true });
    const traces2 = await request(app2.app).get('/api/admin/traces').expect(200);
    expect(traces2.body.count).toBeGreaterThanOrEqual(traceCount1);
    expect(traces2.body.count).toBeGreaterThan(0);
    const maxSeq2 = (traces2.body.events as Array<{ sequence: number }>).reduce(
      (max, event) => Math.max(max, event.sequence),
      0,
    );
    expect(maxSeq2).toBe(maxSeq1);

    const prompts2 = await request(app2.app).get('/api/admin/prompt-traces').expect(200);
    expect(prompts2.body.count).toBeGreaterThanOrEqual(promptCount1);

    const runs2 = await request(app2.app).get('/api/admin/evaluation/runs').expect(200);
    expect(runs2.body.runs).toHaveLength(1);
    expect(runs2.body.runs[0].runId).toBe(runId);
    expect(runs2.body.runs[0].gate.passed).toBe(true);
    const detail2 = await request(app2.app).get(`/api/admin/evaluation/runs/${runId}`).expect(200);
    expect(detail2.body.result).toBeUndefined();
    expect(detail2.body.metrics.completionRate).toBe(1);

    // 新事件 sequence 从历史最大值继续
    const game2 = await request(app2.app).post('/api/games').expect(201);
    await request(app2.app)
      .post(`/api/games/${game2.body.id}/describe`)
      .send({ text: '换个角度描述' })
      .expect(200);
    const traces3 = await request(app2.app).get('/api/admin/traces').expect(200);
    const maxSeq3 = (traces3.body.events as Array<{ sequence: number }>).reduce(
      (max, event) => Math.max(max, event.sequence),
      0,
    );
    expect(maxSeq3).toBeGreaterThan(maxSeq2);
  });
});
