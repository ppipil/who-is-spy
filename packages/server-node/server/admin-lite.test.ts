import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import type { ChatMessage } from './core/model.js';
import { FakeGameModel } from './support/test-utils.js';
import type { ModelTask } from './trace/trace.js';

const JUDGE_SCORES = {
  personaAdherence: 8,
  semanticDiversity: 3,
  contextUtilization: 7,
  humanInputResponsiveness: 4,
  exposureControl: 9,
} as const;

type FixtureJudgeDimension = keyof typeof JUDGE_SCORES;

function judgeRating(score: number): string {
  if (score >= 9) return '优秀';
  if (score >= 7) return '良好';
  if (score >= 5) return '一般';
  if (score >= 3) return '较弱';
  return '很差';
}

class FiveDimensionJudgeFakeModel extends FakeGameModel {
  readonly calls: FixtureJudgeDimension[] = [];
  readonly evidenceKeys = new Map<FixtureJudgeDimension, string[]>();
  readonly observedMessages: ChatMessage[][] = [];

  async completeJson(_task: ModelTask, messages: ChatMessage[]): Promise<unknown> {
    const dimension = this.dimensionFrom(messages);
    this.calls.push(dimension);
    this.observedMessages.push(messages);
    this.evidenceKeys.set(dimension, Object.keys(JSON.parse(messages[1]?.content ?? '{}') as Record<string, unknown>));
    return this.responseFor(dimension);
  }

  protected responseFor(dimension: FixtureJudgeDimension): unknown {
    const rating = judgeRating(JUDGE_SCORES[dimension]);
    return {
      score: JUDGE_SCORES[dimension],
      reason: `评级：${rating}。${dimension} 的简体中文评分理由。`,
      evidence: `${dimension} 的简体中文公开证据。`,
      summary: `评级：${rating}。${dimension} 的简体中文结论。`,
    };
  }

  private dimensionFrom(messages: ChatMessage[]): FixtureJudgeDimension {
    const matched = messages[0]?.content.match(/指标标识：(personaAdherence|semanticDiversity|contextUtilization|humanInputResponsiveness|exposureControl)/u)?.[1];
    if (!matched || !(matched in JUDGE_SCORES)) throw new Error('测试模型未收到独立 Judge 指标标识');
    return matched as FixtureJudgeDimension;
  }
}

class SensitiveOutputJudgeModel extends FiveDimensionJudgeFakeModel {
  protected responseFor(dimension: FixtureJudgeDimension): unknown {
    const response = super.responseFor(dimension) as Record<string, unknown>;
    return { ...response, evidence: dimension + ' 的公开证据误提雨伞，应在 Trace 中脱敏。' };
  }
}

class EnglishSemanticJudgeModel extends FiveDimensionJudgeFakeModel {
  protected responseFor(dimension: FixtureJudgeDimension): unknown {
    if (dimension === 'semanticDiversity') {
      return { score: 6, reason: 'English only', evidence: 'English only', summary: 'English only' };
    }
    return super.responseFor(dimension);
  }
}

class InconsistentPersonaJudgeModel extends FiveDimensionJudgeFakeModel {
  protected responseFor(dimension: FixtureJudgeDimension): unknown {
    if (dimension === 'personaAdherence') {
      return {
        score: 5,
        reason: '评级：优秀。角色策略表现优秀。',
        evidence: '公开描述证据完整。',
        summary: '评级：优秀。总体表现优秀。',
      };
    }
    return super.responseFor(dimension);
  }
}
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
  it('is enabled by default and can be explicitly disabled', async () => {
    const previous = process.env.ENABLE_ADMIN_CONSOLE;
    delete process.env.ENABLE_ADMIN_CONSOLE;
    try {
      const enabled = createApp(new FakeGameModel());
      await request(enabled.app).get('/api/admin/status').expect(200);
      process.env.ENABLE_ADMIN_CONSOLE = '0';
      const disabled = createApp(new FakeGameModel());
      await request(disabled.app).get('/api/admin/status').expect(404);
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

  it('filters trace events by unified id and source type', async () => withAdminTraceEnv(async () => {
    const { app } = createApp(new FakeGameModel());
    const created = await request(app).post('/api/games').expect(201);
    await request(app).post(`/api/games/${created.body.id}/describe`).send({ text: '常见生活场景里会遇到' }).expect(200);

    const byId = await request(app).get(`/api/admin/traces?id=${created.body.id}`).expect(200);
    expect(byId.body.count).toBeGreaterThan(0);
    expect(byId.body.events.every((event: { gameId: string; runId?: string }) => event.gameId === created.body.id || event.runId === created.body.id)).toBe(true);

    const userGame = await request(app).get('/api/admin/traces?sourceType=USER_GAME').expect(200);
    expect(userGame.body.count).toBeGreaterThan(0);
    expect(userGame.body.events.every((event: { sourceType?: string }) => event.sourceType === 'USER_GAME')).toBe(true);

    const terminalSource = await request(app).get('/api/admin/traces?sourceType=TERMINAL_SCRIPT').expect(200);
    expect(terminalSource.body.count).toBe(0);
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
    const caseOptions = await request(app).get('/api/admin/evaluation/cases').expect(200);
    expect(caseOptions.body.fixtureWords).toEqual(['雨伞', '雨衣']);
    expect(caseOptions.body).toMatchObject({ codeVersion: expect.any(String), defaultRounds: 1, maxRounds: 5, provider: { model: expect.any(String), configured: expect.any(Boolean), envProxyEnabled: expect.any(Boolean) } });
    expect(caseOptions.body.cases.map((item: { humanDescription: string }) => item.humanDescription)).toEqual(expect.arrayContaining(['可以防止身体被淋湿。', '一一二二，哈哈嘿嘿。']));

    const response = await request(app)
      .post('/api/admin/evaluations')
      .send({
        model: 'fake',
        cases: ['normal-human-input', 'nonsense-human-input'],
        judgeEnabled: true,
        wordPair: ['风筝', '气球'],
        caseInputs: {
          'normal-human-input': '下雨天常见的随身用品。',
          'nonsense-human-input': '一一二二，哈哈嘿嘿。',
        },
        rounds: 2,
      })
      .expect(201);

    expect(response.body.report.status).toBe('PASS');
    expect(response.body.report.codeVersion).toBe(caseOptions.body.codeVersion);
    expect(response.body.report.source).toBe('local');
    expect(response.body.report.title).toContain('Fake');
    expect(response.body.report.cases).toHaveLength(4);
    expect(response.body.report.deterministic.metrics.startedGames).toBe(4);
    expect(response.body.report.deterministic.metrics.humanInputResponsiveness).toMatchObject({
      available: true,
      normalHumanVoteRate: 0,
      nonsenseHumanVoteRate: 1,
      voteRateLift: 1,
      reasonAwarenessHits: 8,
      passed: true,
    });
    expect(response.body.report.deterministic.cases.filter((item: { humanDescription: string }) => item.humanDescription === '下雨天常见的随身用品。')).toHaveLength(2);
    expect(response.body.report.judge.status).toBe('unavailable');

    const evalTraces = await request(app).get('/api/admin/traces?sourceType=EVAL_RUN').expect(200);
    expect(evalTraces.body.count).toBeGreaterThan(0);
    expect(evalTraces.body.events.every((event: { sourceType?: string }) => event.sourceType === 'EVAL_RUN')).toBe(true);

    const webTraces = await request(app).get('/api/admin/traces?sourceType=USER_GAME').expect(200);
    expect(webTraces.body.count).toBe(0);
    const history = await request(app).get('/api/admin/evaluations').expect(200);
    expect(history.body.reports.some((report: { id: string }) => report.id === response.body.report.id)).toBe(true);
    expect(history.body.archivedReports.map((report: { id: string }) => report.id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
    expect(history.body.archivedReports.every((report: { evidenceUrl: string }) => report.evidenceUrl.includes('/blob/') && report.evidenceUrl.endsWith('/summary.md'))).toBe(true);
    const m1 = history.body.archivedReports.find((report: { id: string }) => report.id === 'm1');
    expect(m1.evidenceUrl).toBe('https://github.com/ppipil/who-is-spy/blob/eval/m1-real-smoke/docs/evidence/m1-baseline/summary.md');
    expect(m1.archivedEvidence).toMatchObject({
      evaluatedCommit: 'fc9821c (official original baseline: 7d98e19)',
      completion: '3/3 (100%); usage smoke 1/1 (100%)',
      validVote: '100%',
      homogeneity: '0.0546 (3-game real smoke)',
    });
    expect(m1.deterministic).toBeUndefined();
    const m5 = history.body.archivedReports.find((report: { id: string }) => report.id === 'm5');
    expect(m5.archivedEvidence).toMatchObject({ homogeneity: 'Not measured', latency: 'Not measured', tokenCost: 'Not measured' });
    expect(m5.archivedEvidence.notMeasured).toEqual(expect.arrayContaining(['Aggregate latency', 'Provider token usage and cost']));
    const m6 = history.body.archivedReports.find((report: { id: string }) => report.id === 'm6');
    expect(m6.archivedEvidence).toMatchObject({
      completion: 'Baseline 5/5 (100%) · Final 4/5 (80%)',
      validVote: 'Baseline 100% · Final 100%',
      homogeneity: 'Baseline 0.0640 · Final 0.0107',
    });

    const restarted = createApp(new FakeGameModel());
    const persisted = await request(restarted.app).get('/api/admin/evaluations').expect(200);
    expect(persisted.body.reports.some((report: { id: string }) => report.id === response.body.report.id)).toBe(true);
  }));
  it('scores four independent dimensions when Human Input Responsiveness lacks a paired case', async () => withAdminTraceEnv(async () => {
    const model = new FiveDimensionJudgeFakeModel();
    const { app } = createApp(model);
    const response = await request(app)
      .post('/api/admin/evaluations')
      .send({ model: 'fake', cases: ['normal-human-input'], judgeEnabled: true })
      .expect(201);

    expect(response.body.report.cases).toHaveLength(1);
    expect(response.body.report.judge.status).toBe('available');
    expect(response.body.report.judge.scoreCoverage).toBe('partial');
    expect(response.body.report.judge).toMatchObject({ availableMetrics: 4, totalMetrics: 5, behaviorScore: 6.69, retryCount: 0 });
    expect(response.body.report.judge.output.semanticDiversity).toMatchObject({ status: 'available', score: 3 });
    expect(response.body.report.judge.output.humanInputResponsiveness).toMatchObject({ status: 'unavailable', score: null, retryCount: 0 });
    expect(response.body.report.problems).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Semantic Diversity 偏低' })]));
    expect(model.calls).toEqual(['personaAdherence', 'semanticDiversity', 'contextUtilization', 'exposureControl']);
    expect(model.evidenceKeys.get('personaAdherence')).toEqual(['strategyDefinitions', 'cases']);
    expect(model.evidenceKeys.get('semanticDiversity')).toEqual(['lexicalHomogeneity', 'cases']);
    expect(model.evidenceKeys.get('contextUtilization')).toEqual(['cases']);
    expect(model.evidenceKeys.get('exposureControl')).toEqual(['deterministicSafety', 'qualityGate', 'cases']);
    expect(JSON.stringify(model.observedMessages)).not.toContain('雨伞');
    expect(JSON.stringify(model.observedMessages)).not.toContain('雨衣');

    const gameId = response.body.report.deterministic.cases[0].gameId;
    const traces = await request(app).get(`/api/admin/traces?id=${gameId}`).expect(200);
    const judgePrompts = traces.body.events.filter((event: { eventType: string; task?: string }) => event.eventType === 'prompt_provenance' && event.task === 'judge');
    const judgeCalls = traces.body.events.filter((event: { eventType: string; task?: string }) => event.eventType === 'model_call' && event.task === 'judge');
    expect(judgePrompts).toHaveLength(4);
    expect(new Set(judgePrompts.map((event: { promptTemplateVersion: string }) => event.promptTemplateVersion)).size).toBe(4);
    expect(judgeCalls).toHaveLength(4);
    expect(judgeCalls.every((event: { outcome: string }) => event.outcome === 'success')).toBe(true);
    const prompts = await request(app).get(`/api/admin/prompt-traces?gameId=${gameId}`).expect(200);
    expect(prompts.body.records.filter((record: { task: string }) => record.task === 'judge')).toHaveLength(4);
  }));
  it('redacts evaluation fixture words from judge trace output', async () => withAdminTraceEnv(async () => {
    const { app } = createApp(new SensitiveOutputJudgeModel());
    const response = await request(app)
      .post('/api/admin/evaluations')
      .send({ model: 'fake', cases: ['normal-human-input'], judgeEnabled: true })
      .expect(201);

    const gameId = response.body.report.deterministic.cases[0].gameId;
    const traces = await request(app).get('/api/admin/traces?id=' + gameId).expect(200);
    const serialized = JSON.stringify(traces.body.events.filter((event: { task?: string }) => event.task === 'judge'));
    expect(serialized).toContain('[已脱敏]');
    expect(serialized).not.toContain('雨伞');
    expect(serialized).not.toContain('雨衣');
  }));

  it('returns a Full AI Behavior Score only when all five dimensions succeed', async () => withAdminTraceEnv(async () => {
    const model = new FiveDimensionJudgeFakeModel();
    const { app } = createApp(model);
    const response = await request(app)
      .post('/api/admin/evaluations')
      .send({ model: 'fake', cases: ['normal-human-input', 'nonsense-human-input'], judgeEnabled: true })
      .expect(201);

    expect(response.body.report.judge).toMatchObject({ status: 'available', scoreCoverage: 'full', availableMetrics: 5, totalMetrics: 5, behaviorScore: 6.15, retryCount: 0 });
    expect(response.body.report.judge.output.humanInputResponsiveness).toMatchObject({ status: 'available', score: 4 });
    expect(model.calls).toEqual(['personaAdherence', 'semanticDiversity', 'contextUtilization', 'humanInputResponsiveness', 'exposureControl']);
    expect(model.evidenceKeys.get('humanInputResponsiveness')).toEqual(['codeEvidence', 'cases']);
    for (const messages of model.observedMessages) {
      expect(messages[0]?.content).toContain('9–10 = Excellent / 优秀');
      expect(messages[0]?.content).toContain('7–8 = Good / 良好');
      expect(messages[0]?.content).toContain('5–6 = Average / 一般');
      expect(messages[0]?.content).toContain('3–4 = Weak / 较弱');
      expect(messages[0]?.content).toContain('0–2 = Poor / 很差');
    }
    for (const dimension of Object.values(response.body.report.judge.output).filter((value): value is { reason: string; evidence: string; summary: string } => Boolean(value && typeof value === 'object' && 'reason' in value))) {
      expect(dimension.reason).toMatch(/[\u3400-\u9fff]/u);
      expect(dimension.evidence).toMatch(/[\u3400-\u9fff]/u);
      expect(dimension.summary).toMatch(/[\u3400-\u9fff]/u);
    }
    expect(response.body.report.problems).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Semantic Diversity 偏低' }),
      expect.objectContaining({ title: 'Human Input Responsiveness 偏低' }),
    ]));
  }));

  it('keeps four dimensions available when one dimension fails Chinese/schema validation', async () => withAdminTraceEnv(async () => {
    const model = new EnglishSemanticJudgeModel();
    const { app } = createApp(model);
    const response = await request(app)
      .post('/api/admin/evaluations')
      .send({ model: 'fake', cases: ['normal-human-input', 'nonsense-human-input'], judgeEnabled: true })
      .expect(201);

    expect(response.body.report.judge).toMatchObject({ status: 'available', scoreCoverage: 'partial', availableMetrics: 4, totalMetrics: 5, behaviorScore: 6.94, retryCount: 1 });
    expect(response.body.report.judge.output.semanticDiversity).toMatchObject({ status: 'unavailable', score: null, retryCount: 1 });
    expect(response.body.report.judge.output.semanticDiversity.reason).toContain('简体中文校验');
    expect(response.body.report.judge.output.personaAdherence).toMatchObject({ status: 'available', score: 8 });
    expect(response.body.report.judge.output.contextUtilization).toMatchObject({ status: 'available', score: 7 });
    expect(response.body.report.judge.output.humanInputResponsiveness).toMatchObject({ status: 'available', score: 4 });
    expect(response.body.report.judge.output.exposureControl).toMatchObject({ status: 'available', score: 9 });
    expect(model.calls.filter((dimension) => dimension === 'semanticDiversity')).toHaveLength(2);
    expect(model.calls).toHaveLength(6);
    const gameId = response.body.report.deterministic.cases.at(-1).gameId;
    const traces = await request(app).get(`/api/admin/traces?id=${gameId}`).expect(200);
    const failedCalls = traces.body.events.filter((event: { eventType: string; task?: string; outcome?: string; agentId?: string }) => event.eventType === 'model_call' && event.task === 'judge' && event.outcome === 'failure' && event.agentId === 'ai-judge-semantic-diversity');
    const successfulCalls = traces.body.events.filter((event: { eventType: string; task?: string; outcome?: string }) => event.eventType === 'model_call' && event.task === 'judge' && event.outcome === 'success');
    expect(failedCalls).toHaveLength(2);
    expect(failedCalls.map((event: { willRetry: boolean }) => event.willRetry)).toEqual([true, false]);
    expect(successfulCalls).toHaveLength(4);
  }));

  it('rejects only the Judge dimension whose score conflicts with its written rating', async () => withAdminTraceEnv(async () => {
    const model = new InconsistentPersonaJudgeModel();
    const { app } = createApp(model);
    const response = await request(app)
      .post('/api/admin/evaluations')
      .send({ model: 'fake', cases: ['normal-human-input', 'nonsense-human-input'], judgeEnabled: true })
      .expect(201);

    expect(response.body.report.judge).toMatchObject({ status: 'available', scoreCoverage: 'partial', availableMetrics: 4, totalMetrics: 5 });
    expect(response.body.report.judge.output.personaAdherence).toMatchObject({ status: 'unavailable', score: null, retryCount: 1 });
    expect(response.body.report.judge.output.semanticDiversity).toMatchObject({ status: 'available', score: 3 });
    expect(response.body.report.judge.output.contextUtilization).toMatchObject({ status: 'available', score: 7 });
    expect(response.body.report.judge.output.humanInputResponsiveness).toMatchObject({ status: 'available', score: 4 });
    expect(response.body.report.judge.output.exposureControl).toMatchObject({ status: 'available', score: 9 });
    expect(model.calls.filter((dimension) => dimension === 'personaAdherence')).toHaveLength(2);
  }));
});
