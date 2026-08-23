import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import { z } from 'zod';
import { runEvaluation, type EvaluationModelKind, type EvaluationResult } from '../evaluation/evaluation.js';
import { FakeGameModel } from '../support/test-utils.js';
import type { GameModel } from '../core/model.js';

const CANONICAL_CASES = [
  { id: 'normal-human-input', name: 'Normal Human Input', humanDescription: '可以防止身体被淋湿。' },
  { id: 'nonsense-human-input', name: 'Nonsense Human Input', humanDescription: '一一二二，哈哈嘿嘿。' },
] as const;

const JUDGE_WEIGHTS = {
  personaAdherence: 0.25,
  semanticDiversity: 0.2,
  contextUtilization: 0.2,
  humanInputResponsiveness: 0.2,
  exposureControl: 0.15,
} as const;

type CanonicalCaseId = (typeof CANONICAL_CASES)[number]['id'];
type JudgeStatus = 'available' | 'unavailable' | 'disabled';

const judgeDimensionSchema = z.object({
  score: z.number().min(0).max(10),
  reason: z.string().max(800).optional(),
  evidence: z.string().max(1200).optional(),
});

const judgeOutputSchema = z.object({
  personaAdherence: z.object({
    score: z.number().min(0).max(10),
    agents: z.object({
      cautious: z.number().min(0).max(10),
      intuitive: z.number().min(0).max(10),
      analytical: z.number().min(0).max(10),
      contrarian: z.number().min(0).max(10),
    }),
    reason: z.string().max(800).optional(),
    evidence: z.string().max(1200).optional(),
  }),
  semanticDiversity: judgeDimensionSchema,
  contextUtilization: judgeDimensionSchema,
  humanInputResponsiveness: judgeDimensionSchema,
  exposureControl: judgeDimensionSchema,
  issues: z.array(z.string().max(300)).max(12).default([]),
  summary: z.string().max(1200).default(''),
});

type JudgeOutput = z.infer<typeof judgeOutputSchema>;

interface AdminEvaluationReport {
  id: string;
  source: 'local' | 'archive';
  title: string;
  createdAt: string;
  status: 'PASS' | 'WARN' | 'FAIL';
  model: EvaluationModelKind;
  cases: Array<{ id: CanonicalCaseId; name: string; humanDescription: string }>;
  durationMs: number;
  deterministic: EvaluationResult;
  judge: {
    status: JudgeStatus;
    retryCount: number;
    behaviorScore: number | null;
    reason: string;
    output?: JudgeOutput;
  };
  problems: Array<{ title: string; evidence?: string }>;
}

const startInput = z.object({
  model: z.enum(['fake', 'real']).default('fake'),
  cases: z.array(z.enum(['normal-human-input', 'nonsense-human-input'])).min(1).default(['normal-human-input', 'nonsense-human-input']),
  judgeEnabled: z.boolean().default(true),
});

const DEFAULT_REPORTS_PATH = path.resolve(fileURLToPath(new URL('../../traces/admin-evaluation-reports.json', import.meta.url)));
const reports: AdminEvaluationReport[] = loadReports();

export function createAdminEvaluationRouter(defaultModel: GameModel): Router {
  const router = Router();

  router.get('/evaluation/cases', (_request, response) => {
    response.json({ cases: CANONICAL_CASES });
  });

  router.get('/evaluations', (_request, response) => {
    response.json({ reports: localReports(), archivedReports: historyReports() });
  });

  router.get('/evaluations/:id', (request, response) => {
    const report = [...localReports(), ...historyReports()].find((item) => item.id === request.params.id);
    if (!report) {
      response.status(404).json({ error: 'evaluation report not found' });
      return;
    }
    response.json({ report });
  });

  router.post('/evaluations', async (request, response, next) => {
    try {
      const input = startInput.parse(request.body ?? {});
      const startedAt = Date.now();
      const selectedCases = CANONICAL_CASES.filter((item) => input.cases.includes(item.id));
      const result = await runEvaluation({
        games: selectedCases.length,
        seed: 42,
        modelKind: input.model,
        model: input.model === 'fake' ? new FakeGameModel() : defaultModel,
        humanDescriptions: selectedCases.map((item) => item.humanDescription),
        caseIds: selectedCases.map((item) => item.id),
      });
      const judge = await runAiJudge(input.judgeEnabled, result);
      const report = buildReport(input.model, selectedCases, result, Date.now() - startedAt, judge);
      saveReport(report);
      response.status(201).json({ report });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function localReports(): AdminEvaluationReport[] {
  return [...reports].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function saveReport(report: AdminEvaluationReport): void {
  reports.unshift(report);
  const filePath = reportsPath();
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({ reports }, null, 2)}\n`, 'utf8');
}

function loadReports(): AdminEvaluationReport[] {
  const filePath = reportsPath();
  if (!filePath || !fs.existsSync(filePath)) return [];
  try {
    const payload = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { reports?: Partial<AdminEvaluationReport>[] };
    return Array.isArray(payload.reports)
      ? payload.reports
          .filter((report): report is AdminEvaluationReport => Boolean(report?.id && report.createdAt && report.deterministic && report.model && report.cases && report.judge))
          .map((report) => ({
            ...report,
            source: 'local',
            title: report.title === 'Latest Run' ? localReportTitle(report.model, report.cases.length) : report.title,
          }))
      : [];
  } catch {
    return [];
  }
}

function reportsPath(): string | null {
  const configured = process.env.ADMIN_EVALUATION_REPORTS_JSON;
  if (configured === 'memory' || configured === 'off' || configured === '0') return null;
  return configured && configured.trim() ? configured : DEFAULT_REPORTS_PATH;
}

function buildReport(
  model: EvaluationModelKind,
  cases: Array<(typeof CANONICAL_CASES)[number]>,
  deterministic: EvaluationResult,
  durationMs: number,
  judge: AdminEvaluationReport['judge'],
): AdminEvaluationReport {
  return {
    id: `eval-${randomUUID()}`,
    source: 'local',
    title: localReportTitle(model, cases.length),
    createdAt: new Date().toISOString(),
    status: deterministic.gate.passed ? 'PASS' : 'FAIL',
    model,
    cases,
    durationMs,
    deterministic,
    judge,
    problems: topProblems(deterministic),
  };
}

async function runAiJudge(enabled: boolean, deterministic: EvaluationResult): Promise<AdminEvaluationReport['judge']> {
  if (!enabled) return { status: 'disabled', retryCount: 0, behaviorScore: null, reason: 'AI Judge disabled for this run.' };
  const apiKey = process.env.DEEPSEEK_API_KEY ?? '';
  if (!apiKey) {
    return {
      status: 'unavailable',
      retryCount: 0,
      behaviorScore: null,
      reason: 'AI Judge unavailable: DEEPSEEK_API_KEY is not configured. Deterministic engineering metrics remain valid.',
    };
  }

  let lastReason = 'AI Judge unavailable.';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const output = await requestJudge(apiKey, deterministic);
      return {
        status: 'available',
        retryCount: attempt - 1,
        behaviorScore: aiBehaviorScore(output),
        reason: output.summary || 'AI Judge completed.',
        output,
      };
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    status: 'unavailable',
    retryCount: 1,
    behaviorScore: null,
    reason: `AI Judge unavailable after retry: ${lastReason}. Deterministic engineering metrics remain valid.`,
  };
}

async function requestJudge(apiKey: string, deterministic: EvaluationResult): Promise<JudgeOutput> {
  const baseUrl = (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/$/, '');
  const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: judgeSystemPrompt() },
          { role: 'user', content: JSON.stringify(judgeEvidence(deterministic)) },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`AI Judge HTTP ${response.status}`);
    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error('AI Judge returned empty content');
    return judgeOutputSchema.parse(JSON.parse(stripCodeFence(content)));
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new Error('AI Judge timeout');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function judgeSystemPrompt(): string {
  return [
    'You are the AI Judge for a Who-is-Spy game evaluation. Use only the provided public descriptions, public vote reasons, and deterministic metrics.',
    'Never infer or reveal secret words, hidden roles, private prompts, or hidden reasoning. Score only behavior quality.',
    'Return strict JSON with: personaAdherence { score, agents { cautious, intuitive, analytical, contrarian }, reason, evidence }, semanticDiversity, contextUtilization, humanInputResponsiveness, exposureControl, issues, summary.',
    'Each score is 0-10. Judge Good/Bad Examples are few-shot guidance, not a dataset. Code will calculate the weighted total: Persona 25%, Semantic Diversity 20%, Context Utilization 20%, Human Input Responsiveness 20%, Exposure Control 15%.',
  ].join('\n');
}

function judgeEvidence(deterministic: EvaluationResult): unknown {
  return {
    schemaVersion: deterministic.schemaVersion,
    metrics: deterministic.metrics,
    cases: deterministic.cases.map((item) => ({
      caseId: item.caseId,
      completed: item.completed,
      humanDescription: item.humanDescription,
      humanVotesReceived: item.humanVotesReceived,
      totalAiVotes: item.totalAiVotes,
      reasonAwarenessHits: item.reasonAwarenessHits,
      descriptions: item.descriptions,
      votes: item.votes,
      error: item.error,
    })),
  };
}

function aiBehaviorScore(output: JudgeOutput): number {
  const score =
    output.personaAdherence.score * JUDGE_WEIGHTS.personaAdherence +
    output.semanticDiversity.score * JUDGE_WEIGHTS.semanticDiversity +
    output.contextUtilization.score * JUDGE_WEIGHTS.contextUtilization +
    output.humanInputResponsiveness.score * JUDGE_WEIGHTS.humanInputResponsiveness +
    output.exposureControl.score * JUDGE_WEIGHTS.exposureControl;
  return Math.round(score * 100) / 100;
}

function localReportTitle(model: EvaluationModelKind, caseCount: number): string {
  const label = model === 'real' ? 'DeepSeek' : 'Fake';
  const time = new Date().toLocaleString('zh-CN', { hour12: false });
  return `${label} · ${caseCount} case${caseCount === 1 ? '' : 's'} · ${time}`;
}

function topProblems(result: EvaluationResult): AdminEvaluationReport['problems'] {
  const problems: AdminEvaluationReport['problems'] = [];
  if (!result.gate.passed) problems.push(...result.gate.failures.slice(0, 3).map((failure) => ({ title: failure })));
  if (result.metrics.latencyMs.p95 > 10_000) problems.push({ title: 'P95 latency is high', evidence: `${result.metrics.latencyMs.p95}ms` });
  if (result.metrics.descriptionHomogeneity > 0.4) problems.push({ title: 'Description lexical homogeneity is high', evidence: String(result.metrics.descriptionHomogeneity) });
  return problems.slice(0, 5);
}

function historyReports(): AdminEvaluationReport[] {
  return [
    historical('baseline', 'Baseline'),
    historical('m1', 'M1'),
    historical('m2', 'M2'),
    historical('m3', 'M3'),
    historical('m4', 'M4'),
    historical('m5', 'M5'),
    historical('m6', 'M6 Final'),
  ];
}

function historical(id: string, title: string): AdminEvaluationReport {
  return {
    id,
    source: 'archive',
    title,
    createdAt: '2026-08-01T00:00:00.000Z',
    status: 'WARN',
    model: 'fake',
    cases: [],
    durationMs: 0,
    deterministic: placeholderResult(),
    judge: { status: 'unavailable', retryCount: 0, behaviorScore: null, reason: 'Historical evidence only. Not measured in Admin Lite.' },
    problems: [{ title: 'Historical report placeholder', evidence: 'Link GitHub evidence when milestone files are available.' }],
  };
}

function placeholderResult(): EvaluationResult {
  return {
    schemaVersion: 1,
    configuration: { games: 0, seed: 42, model: 'fake' },
    cases: [],
    metrics: {
      startedGames: 0,
      completedGames: 0,
      completionRate: 0,
      descriptionAttempts: 0,
      secretLeakRejectRate: 0,
      duplicateRejectRate: 0,
      invalidOutputRate: 0,
      validVoteRate: 0,
      retryRate: 0,
      latencyMs: { p50: 0, p95: 0 },
      tokenUsage: { input: 0, output: 0, total: 0, source: 'unavailable' },
      byStrategyId: {},
      descriptionHomogeneity: 0,
      safety: { secretLeakOccurrences: 0, publicStateLeakOccurrences: 0, illegalStateOccurrences: 0 },
    },
    gate: { passed: false, failures: ['Not measured in Admin Lite'] },
  };
}

function stripCodeFence(content: string): string {
  return content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
}