import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import { z } from 'zod';
import { evaluationOutcome, runEvaluation, type EvaluationModelKind, type EvaluationResult } from '../evaluation/evaluation.js';
import { EvaluationFakeGameModel } from '../support/test-utils.js';
import { DeepSeekClient, type GameModel } from '../core/model.js';
import type { TraceEventStore } from '../trace/trace.js';
import { resolveCodeVersion } from '../support/code-version.js';
import { runAiJudge, type EvaluationJudgeResult, type JudgeTraceContext } from './evaluation-judge.js';

const CANONICAL_CASES = [
  { id: 'normal-human-input', name: '正常真人输入 Normal Human Input', humanDescription: '可以防止身体被淋湿。' },
  { id: 'nonsense-human-input', name: '乱填真人输入 Nonsense Human Input', humanDescription: '一一二二，哈哈嘿嘿。' },
] as const;

const EVALUATION_WORD_PAIR = ['雨伞', '雨衣'] as const;
const CURRENT_CODE_VERSION = resolveCodeVersion();
const editableText = z.string().trim().min(2).max(120);
const wordPairInput = z.tuple([z.string().trim().min(1).max(20), z.string().trim().min(1).max(20)]).refine(
  ([civilianWord, undercoverWord]) => civilianWord !== undercoverWord,
  { message: '平民词与卧底词必须不同 The two words must be different' },
);

type CanonicalCaseId = (typeof CANONICAL_CASES)[number]['id'];
type AdminEvaluationCase = { id: CanonicalCaseId; name: string; humanDescription: string };

interface AdminEvaluationReport {
  id: string;
  source: 'local' | 'archive';
  title: string;
  createdAt: string;
  status: 'PASS' | 'WARN' | 'FAIL';
  model: EvaluationModelKind;
  cases: AdminEvaluationCase[];
  durationMs: number;
  codeVersion?: string;
  evidenceUrl?: string;
  archivedEvidence?: ArchivedEvaluationEvidence;
  deterministic?: EvaluationResult;
  judge?: EvaluationJudgeResult;
  problems: Array<{ title: string; evidence?: string }>;
}

interface ArchivedEvaluationEvidence {
  versionStage: string;
  evaluatedCommit: string;
  model: string;
  gamesSeeds: string;
  completion: string;
  validVote: string;
  homogeneity: string;
  latency: string;
  tokenCost: string;
  gateResult: string;
  conclusion: string;
  sourceBranch: string;
  sourcePath: string;
  notMeasured: string[];
}

const startInput = z.object({
  model: z.enum(['fake', 'real']).default('fake'),
  cases: z.array(z.enum(['normal-human-input', 'nonsense-human-input'])).min(1).default(['normal-human-input', 'nonsense-human-input']),
  judgeEnabled: z.boolean().default(true),
  wordPair: wordPairInput.default(['雨伞', '雨衣']),
  caseInputs: z.object({
    'normal-human-input': editableText.optional(),
    'nonsense-human-input': editableText.optional(),
  }).default({}),
  rounds: z.number().int().min(1).max(5).default(1),
});

const DEFAULT_REPORTS_PATH = path.resolve(fileURLToPath(new URL('../../traces/admin-evaluation-reports.json', import.meta.url)));
const reports: AdminEvaluationReport[] = loadReports();

function evaluationDebug(stage: string, details: Record<string, unknown> = {}): void {
  if (process.env.EVALUATION_DEBUG !== '1') return;
  console.info(`[evaluation-debug] ${JSON.stringify({ stage, ...details })}`);
}

export function createAdminEvaluationRouter(defaultModel: GameModel, runtimeTrace?: TraceEventStore): Router {
  const router = Router();
  const deepSeekProvider = defaultModel instanceof DeepSeekClient ? defaultModel : new DeepSeekClient();

  router.get('/evaluation/cases', (_request, response) => {
    response.json({
      cases: CANONICAL_CASES,
      fixtureWords: EVALUATION_WORD_PAIR,
      codeVersion: CURRENT_CODE_VERSION,
      defaultRounds: 1,
      maxRounds: 5,
      provider: {
        model: deepSeekProvider.model,
        configured: deepSeekProvider.isConfigured(),
        envProxyEnabled: process.execArgv.includes('--use-env-proxy') || process.env.NODE_USE_ENV_PROXY === '1',
      },
    });
  });

  router.get('/evaluations', (_request, response) => {
    response.json({ reports: localReports(), archivedReports: historyReports() });
  });

  router.get('/evaluations/:id', (request, response) => {
    const report = [...localReports(), ...historyReports()].find((item) => item.id === request.params.id);
    if (!report) {
      response.status(404).json({ error: '未找到评测报告 evaluation report not found' });
      return;
    }
    response.json({ report });
  });

  router.post('/evaluations', async (request, response, next) => {
    try {
      const input = startInput.parse(request.body ?? {});
      const startedAt = Date.now();
      const selectedCaseTemplates = CANONICAL_CASES.filter((item) => input.cases.includes(item.id));
      const selectedCases = Array.from({ length: input.rounds }, (_, roundIndex) => selectedCaseTemplates.map((item) => ({
        ...item,
        name: `${item.name} · Run ${roundIndex + 1}`,
        humanDescription: input.caseInputs[item.id] ?? item.humanDescription,
      }))).flat();
      evaluationDebug('request_started', {
        model: input.model,
        caseIds: selectedCases.map((item) => item.id),
        rounds: input.rounds,
        totalGames: selectedCases.length,
        judgeEnabled: input.judgeEnabled,
      });
      const evaluationModel = input.model === 'fake'
        ? new EvaluationFakeGameModel()
        : new DeepSeekClient();
      const result = await runEvaluation({
        games: selectedCases.length,
        seed: 42,
        modelKind: input.model,
        model: evaluationModel,
        humanDescriptions: selectedCases.map((item) => item.humanDescription),
        caseIds: selectedCases.map((item) => item.id),
        wordPair: input.wordPair,
        traceSink: runtimeTrace,
        traceEntrypoint: 'admin',
      });
      evaluationDebug('cases_completed', {
        startedGames: result.metrics.startedGames,
        completedGames: result.metrics.completedGames,
        gatePassed: result.gate.passed,
        cases: result.cases.map((item) => ({
          caseId: item.caseId,
          completed: item.completed,
          hasError: Boolean(item.error),
        })),
      });
      const judgeModel = input.model === 'fake' ? defaultModel : evaluationModel;
      evaluationDebug('judge_started', { enabled: input.judgeEnabled });
      const judge = await runAiJudge(input.judgeEnabled, result, judgeModel, judgeTraceContext(result, runtimeTrace, input.model), input.wordPair);
      evaluationDebug('judge_completed', {
        status: judge.status,
        retryCount: judge.retryCount,
        availableMetrics: judge.availableMetrics,
        scoreCoverage: judge.scoreCoverage ?? null,
        behaviorScoreAvailable: judge.behaviorScore !== null,
      });
      const report = buildReport(input.model, selectedCases, result, Date.now() - startedAt, judge);
      saveReport(report);
      evaluationDebug('report_saved', {
        reportId: report.id,
        status: report.status,
        durationMs: report.durationMs,
      });
      response.status(201).json({ report });
    } catch (error) {
      evaluationDebug('request_failed', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      next(error);
    }
  });

  return router;
}

function judgeTraceContext(result: EvaluationResult, runtimeTrace: TraceEventStore | undefined, model: EvaluationModelKind): JudgeTraceContext | undefined {
  if (!runtimeTrace) return undefined;
  const targetCase = [...result.cases].reverse().find((item) => item.completed && item.descriptions.length > 0);
  if (!targetCase) return undefined;
  const lifecycle = [...runtimeTrace.events].reverse().find((event) => event.eventType === 'trace_run' && event.gameId === targetCase.gameId);
  const rounds = [...targetCase.descriptions.map((item) => item.round), ...targetCase.votes.map((item) => item.round)];
  return {
    traceSink: runtimeTrace,
    gameId: targetCase.gameId,
    runId: lifecycle?.runId ?? targetCase.gameId,
    round: Math.max(0, ...rounds) + 1,
    modelKind: model === 'real' ? 'real' : 'fake',
  };
}
function localReports(): AdminEvaluationReport[] {
  return [...reports].sort((a, b) => reportTimestamp(b.createdAt) - reportTimestamp(a.createdAt));
}

function reportTimestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
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
          .map((report) => {
            const normalized = {
              ...report,
              source: 'local' as const,
              codeVersion: report.codeVersion ?? 'legacy-unrecorded',
              title: report.title === 'Latest Run' ? localReportTitle(report.model, report.cases.length) : report.title,
            };
            return { ...normalized, problems: topProblems(normalized.deterministic!, normalized.judge!) };
          })
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
  cases: AdminEvaluationCase[],
  deterministic: EvaluationResult,
  durationMs: number,
  judge: EvaluationJudgeResult,
): AdminEvaluationReport {
  return {
    id: `eval-${randomUUID()}`,
    source: 'local',
    title: localReportTitle(model, cases.length),
    createdAt: new Date().toISOString(),
    status: evaluationOutcome(deterministic),
    model,
    cases,
    durationMs,
    codeVersion: CURRENT_CODE_VERSION,
    deterministic,
    judge,
    problems: topProblems(deterministic, judge),
  };
}

function localReportTitle(model: EvaluationModelKind, caseCount: number): string {
  const label = model === 'real' ? 'DeepSeek' : 'Fake 模型';
  const time = new Date().toLocaleString('zh-CN', { hour12: false });
  return `${label} · ${caseCount} 个用例 cases · ${time}`;
}

function topProblems(result: EvaluationResult, judge: EvaluationJudgeResult): AdminEvaluationReport['problems'] {
  const problems: AdminEvaluationReport['problems'] = [];
  if (!result.gate.passed) problems.push(...result.gate.failures.slice(0, 3).map((failure) => ({ title: failure })));
  const responsiveness = result.metrics.humanInputResponsiveness;
  if (responsiveness?.available && !responsiveness.passed) {
    problems.push({
      title: '胡言乱语识别未达标 Nonsense input response is below acceptance',
      evidence: 'Nonsense ' + Math.round(responsiveness.nonsenseHumanVoteRate * 100) + '% · Normal ' + Math.round(responsiveness.normalHumanVoteRate * 100) + '% · Lift ' + Math.round(responsiveness.voteRateLift * 100) + 'pp · Reasons ' + responsiveness.reasonAwarenessHits,
    });
  }
  if (result.metrics.latencyMs.p95 > 10_000) problems.push({ title: 'P95 延迟偏高 P95 latency is high', evidence: `${result.metrics.latencyMs.p95}ms` });
  if (result.metrics.descriptionHomogeneity > 0.4) problems.push({ title: '描述措辞同质化偏高 Description lexical homogeneity is high', evidence: String(result.metrics.descriptionHomogeneity) });
  const judgeDimensions = [
    ['Persona Adherence', judge.output?.personaAdherence],
    ['Semantic Diversity', judge.output?.semanticDiversity],
    ['Context Utilization', judge.output?.contextUtilization],
    ['Human Input Responsiveness', judge.output?.humanInputResponsiveness],
    ['Exposure Control', judge.output?.exposureControl],
  ] as const;
  for (const [label, dimension] of judgeDimensions) {
    if (dimension?.status === 'available' && dimension.score !== null && dimension.score < 6) {
      problems.push({ title: `${label} 偏低`, evidence: `${dimension.score.toFixed(1)}/10 · ${dimension.reason}` });
    }
  }
  return problems.slice(0, 5);
}

function historyReports(): AdminEvaluationReport[] {
  return [
    historical('m1', 'M1 · Baseline Evaluation', 'PASS', {
      versionStage: 'M1 · Instrumented official baseline / real smoke',
      evaluatedCommit: 'fc9821c (official original baseline: 7d98e19)',
      model: 'DeepSeek Real · deepseek-v4-flash usage smoke',
      gamesSeeds: '3-game real smoke, seed 42; separate 1-game usage smoke, seed 42',
      completion: '3/3 (100%); usage smoke 1/1 (100%)',
      validVote: '100%',
      homogeneity: '0.0546 (3-game real smoke)',
      latency: 'p50 6767.5141 ms · p95 47245.0955 ms (3-game real smoke)',
      tokenCost: '3-game smoke: Not measured; 1-game usage smoke: 4413 input / 6822 output / 11235 total · $0.0025 estimated',
      gateResult: 'PASS (3/3 real smoke and 1/1 usage smoke)',
      conclusion: 'The harness drove complete live DeepSeek games. This is smoke evidence, not a formal quality comparison. M0 is referenced through the official baseline commit; no separate M0 Evaluation Report is created.',
      sourceBranch: 'eval/m1-real-smoke',
      sourcePath: 'docs/evidence/m1-baseline/summary.md',
      notMeasured: ['Token/cost for the retained historical 3-game real smoke'],
    }),
    historical('m2', 'M2 · Persona Strategy', 'PASS', {
      versionStage: 'M2 · Persona small-sample acceptance',
      evaluatedCommit: 'a878e5e',
      model: 'DeepSeek · deepseek-v4-flash',
      gamesSeeds: '3 games, fixed seed 42',
      completion: '3/3 (100%)',
      validVote: '100%',
      homogeneity: '0.0239',
      latency: 'p50 8500.9498 ms · p95 43306.5196 ms',
      tokenCost: '20386 input / 35474 output / 55860 total · $0.0128 estimated total',
      gateResult: 'PASS',
      conclusion: 'All four persona strategies were wired through the real-model path and showed directional differences. The sample is qualitative and not statistically significant; vote/review/alias exposure remained a known risk.',
      sourceBranch: 'eval/m2-persona',
      sourcePath: 'docs/evidence/m2-persona/summary.md',
      notMeasured: [],
    }),
    historical('m3', 'M3 · Sequential Observation', 'PASS', {
      versionStage: 'M3 · Sequential description / SSE / vote prefetch smoke',
      evaluatedCommit: '1f3cf9e',
      model: 'DeepSeek · deepseek-v4-flash',
      gamesSeeds: '3 games, seed 42',
      completion: '3/3 (100%)',
      validVote: '100%',
      homogeneity: '0.0051',
      latency: 'p50 7680.3248 ms · p95 27263.8088 ms · whole run 263025.9631 ms',
      tokenCost: '21096 input / 30883 output / 51979 total · 17326.3333/game · $0.0116 total / $0.0039 game',
      gateResult: 'PASS',
      conclusion: 'Every real game recorded the same-round public-description prefixes, proving context availability. Later descriptions were qualitatively less repetitive, without claiming causality or statistical significance.',
      sourceBranch: 'eval/m3-sequential',
      sourcePath: 'docs/evidence/m3-sequential/summary.md',
      notMeasured: [],
    }),
    historical('m4', 'M4 · Quality Gate', 'PASS', {
      versionStage: 'M4 · Pre-publication description Quality Gate',
      evaluatedCommit: '806c05c',
      model: 'DeepSeek · deepseek-v4-flash',
      gamesSeeds: '3 games, seed 42',
      completion: '3/3 (100%)',
      validVote: '100%',
      homogeneity: 'Not measured',
      latency: 'p50 7757.1355 ms · p95 44454.8239 ms',
      tokenCost: '27537 input / 41758 output / 69295 total · 23098.3333/game · $0.0156 estimated total',
      gateResult: 'PASS; 1 exact-secret rejection and repair retry; final public exact leaks 0',
      conclusion: 'The real smoke observed one exact-secret rejection before publication and a successful repair. The gate covered descriptions only; vote reasons, reviews, and semantic aliases remained outside enforcement.',
      sourceBranch: 'eval/m4-quality-gate',
      sourcePath: 'docs/evidence/m4-quality-gate/summary.md',
      notMeasured: ['Description homogeneity in the M4 summary'],
    }),
    historical('m5', 'M5 · Reliability', 'WARN', {
      versionStage: 'M5 · Fault injection, replay, and safe recovery',
      evaluatedCommit: '49eb39d',
      model: 'DeepSeek happy-path smoke; deterministic injected-fault scenarios',
      gamesSeeds: '1 game each for seeds 42, 43, 44',
      completion: 'seed 42: 0%; seeds 43/44: 100% (2/3 completed)',
      validVote: 'seed 42: 83.33%; seeds 43/44: 100%',
      homogeneity: 'Not measured',
      latency: 'Not measured',
      tokenCost: 'Not measured',
      gateResult: 'Real smoke: FAIL / PASS / PASS for seeds 42 / 43 / 44; deterministic recovery scenarios: SAFE',
      conclusion: 'Fault injection, precise localization, redacted trace, replay, safe ballot abort/retry, and local review fallback were verified. Seed 42 honestly retained a real invalid-vote/incomplete-game failure.',
      sourceBranch: 'eval/m5-reliability',
      sourcePath: 'docs/evidence/m5-reliability/summary.md',
      notMeasured: ['Aggregate description homogeneity', 'Aggregate latency', 'Provider token usage and cost'],
    }),
    historical('m6', 'M6 · Baseline vs Final', 'WARN', {
      versionStage: 'M6 · Final paired Baseline vs Improved evaluation',
      evaluatedCommit: 'baseline 7d98e194ee57bb078ed45e9831ad42ff68a57b56 · final 49eb39da8be4f7f959a8afd642272046ca8637e9',
      model: 'deepseek-v4-flash',
      gamesSeeds: 'Baseline 5 + Final 5; frozen seeds 101, 102, 103, 104, 105',
      completion: 'Baseline 5/5 (100%) · Final 4/5 (80%)',
      validVote: 'Baseline 100% · Final 100%',
      homogeneity: 'Baseline 0.0640 · Final 0.0107',
      latency: 'Baseline p50/p95 6079.0 / 36629.7 ms · Final 10236.2 / 58343.0 ms',
      tokenCost: 'Baseline 21765.6 tokens/game · $0.0162/game; Final 27251.2 tokens/game · $0.0215/game',
      gateResult: 'Baseline 5 PASS; Final 4 PASS / 1 FAIL (seed 101 provider timeout)',
      conclusion: 'Final traded higher latency, tokens, and estimated cost for lower lexical repetition, a leak-prevention boundary, and repair capability. Completion was lower by 0.2 in this small sample because of one retained real provider timeout.',
      sourceBranch: 'eval/m6-final-comparison',
      sourcePath: 'docs/evidence/m6-final-comparison/summary.md',
      notMeasured: [],
    }),
  ];
}

function historical(id: string, title: string, status: AdminEvaluationReport['status'], evidence: ArchivedEvaluationEvidence): AdminEvaluationReport {
  return {
    id,
    source: 'archive',
    title,
    createdAt: '2026-08-01T00:00:00.000Z',
    status,
    model: 'real',
    cases: [],
    durationMs: 0,
    codeVersion: evidence.evaluatedCommit,
    evidenceUrl: `https://github.com/ppipil/who-is-spy/blob/${evidence.sourceBranch}/${evidence.sourcePath}`,
    archivedEvidence: evidence,
    problems: [],
  };
}
