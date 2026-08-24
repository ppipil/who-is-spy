import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import type { EvaluationResult } from '../evaluation/evaluation.js';
import { DeepSeekClient, ModelError, type ChatMessage, type GameModel } from '../core/model.js';
import { recordPromptDebug, renderPromptHash, type RenderedPrompt } from '../core/prompt.js';
import type { ModelDiagnostic, TraceModelKind, TraceSink } from '../trace/trace.js';

const TEMPERATURE = 0.2;
const SCORE_BANDS = [
  { min: 9, max: 10, english: 'Excellent', chinese: '优秀' },
  { min: 7, max: 8, english: 'Good', chinese: '良好' },
  { min: 5, max: 6, english: 'Average', chinese: '一般' },
  { min: 3, max: 4, english: 'Weak', chinese: '较弱' },
  { min: 0, max: 2, english: 'Poor', chinese: '很差' },
] as const;
const SCORE_RUBRIC = [
  '统一评分档位（score 必须为 0–10 的整数）：',
  '9–10 = Excellent / 优秀；',
  '7–8 = Good / 良好；',
  '5–6 = Average / 一般；',
  '3–4 = Weak / 较弱；',
  '0–2 = Poor / 很差。',
  'reason 和 summary 必须与 score 语义一致，并分别使用“评级：优秀/良好/一般/较弱/很差”明确写出 score 对应的唯一中文评级；不得出现其他档位评价。',
].join('\n');
const JUDGE_WEIGHTS = {
  personaAdherence: 0.25,
  semanticDiversity: 0.2,
  contextUtilization: 0.2,
  humanInputResponsiveness: 0.2,
  exposureControl: 0.15,
} as const;

export type JudgeDimensionId = keyof typeof JUDGE_WEIGHTS;
export type JudgeStatus = 'available' | 'unavailable' | 'disabled' | 'skipped';
export type JudgeDimensionStatus = 'available' | 'unavailable';

const chineseText = (field: string, max: number) => z.string().trim().min(1).max(max).refine(
  (value) => /[\u3400-\u9fff]/u.test(value),
  `${field} 必须使用简体中文`,
);

function createDimensionSchema() {
  return z.object({
    score: z.number().int().min(0).max(10),
    reason: chineseText('reason', 800),
    evidence: chineseText('evidence', 1200),
    summary: chineseText('summary', 1200),
  }).strict().superRefine((output, context) => {
    const expectedBand = scoreBand(output.score);
    for (const field of ['reason', 'summary'] as const) {
      const expectedRating = `评级：${expectedBand.chinese}`;
      if (!output[field].includes(expectedRating)) {
        context.addIssue({ code: 'custom', path: [field], message: `${field} 必须包含与 score 一致的“${expectedRating}”` });
      }
      const conflictingBand = SCORE_BANDS.find((band) => band !== expectedBand && output[field].includes(band.chinese));
      if (conflictingBand) {
        context.addIssue({ code: 'custom', path: [field], message: `${field} 不得包含与 score 冲突的评级“${conflictingBand.chinese}”` });
      }
    }
  });
}

function scoreBand(score: number): (typeof SCORE_BANDS)[number] {
  return SCORE_BANDS.find((band) => score >= band.min && score <= band.max) ?? SCORE_BANDS.at(-1)!;
}

// Each dimension has its own schema instance so one response cannot satisfy or
// invalidate another dimension. The common builder keeps validation consistent.
const personaAdherenceSchema = createDimensionSchema();
const semanticDiversitySchema = createDimensionSchema();
const contextUtilizationSchema = createDimensionSchema();
const humanInputResponsivenessSchema = createDimensionSchema();
const exposureControlSchema = createDimensionSchema();

type DimensionModelOutput = z.infer<typeof personaAdherenceSchema>;
type RawDimensionModelOutput = z.input<typeof personaAdherenceSchema>;

export interface JudgeDimensionResult {
  status: JudgeDimensionStatus;
  score: number | null;
  retryCount: number;
  reason: string;
  evidence: string;
  summary: string;
}

export interface JudgeOutput {
  personaAdherence: JudgeDimensionResult;
  semanticDiversity: JudgeDimensionResult;
  contextUtilization: JudgeDimensionResult;
  humanInputResponsiveness: JudgeDimensionResult;
  exposureControl: JudgeDimensionResult;
  summary: string;
}

export interface EvaluationJudgeResult {
  status: JudgeStatus;
  retryCount: number;
  behaviorScore: number | null;
  availableMetrics: number;
  totalMetrics: 5;
  scoreCoverage?: 'full' | 'partial';
  reason: string;
  output?: JudgeOutput;
}

export interface JudgeTraceContext {
  traceSink: TraceSink;
  gameId: string;
  runId: string;
  round: number;
  modelKind: TraceModelKind;
}

interface JudgeDimensionDefinition {
  id: JudgeDimensionId;
  label: string;
  promptVersion: string;
  schema: z.ZodType<DimensionModelOutput>;
  rubric: string;
  applicable?: (result: EvaluationResult) => boolean;
  unavailableReason?: string;
  evidence: (result: EvaluationResult, redact: (text: string) => string) => unknown;
}

const DIMENSIONS: readonly JudgeDimensionDefinition[] = [
  {
    id: 'personaAdherence',
    label: '角色策略一致性',
    promptVersion: 'judge-persona-adherence-v2',
    schema: personaAdherenceSchema,
    rubric: '只评估 Persona Adherence：AI 的公开描述是否持续体现 cautious、intuitive、analytical、contrarian 各自的策略风格。不要评价其他指标。',
    evidence: (result, redact) => ({
      strategyDefinitions: {
        cautious: '谨慎、低暴露、强调证据置信度',
        intuitive: '直觉、感官联想、快速形成印象',
        analytical: '分析类别、用途和不一致点',
        contrarian: '挑战共识和过度安全的表达',
      },
      cases: judgeableCases(result).map((item) => ({
        caseId: item.caseId,
        descriptions: item.descriptions.map((entry) => ({ strategyId: entry.strategyId, round: entry.round, text: redact(entry.text) })),
      })),
    }),
  },
  {
    id: 'semanticDiversity',
    label: '语义多样性',
    promptVersion: 'judge-semantic-diversity-v4',
    schema: semanticDiversitySchema,
    rubric: '只评估 Semantic Diversity：AI 描述是否从不同语义角度提供信息，而不是换词重复同一线索。0 分表示高度重复，10 分表示角度丰富且互补。不要评价其他指标。',
    evidence: (result, redact) => ({
      lexicalHomogeneity: result.metrics.descriptionHomogeneity,
      cases: judgeableCases(result).map((item) => ({
        caseId: item.caseId,
        descriptions: item.descriptions.map((entry) => ({ round: entry.round, text: redact(entry.text) })),
      })),
    }),
  },
  {
    id: 'contextUtilization',
    label: '上下文利用',
    promptVersion: 'judge-context-utilization-v2',
    schema: contextUtilizationSchema,
    rubric: '只评估 Context Utilization：后续 AI 描述是否利用同一局已公开的人类输入与先前 AI 描述，形成补充、约束或合理对照。不要评价其他指标。',
    evidence: (result, redact) => ({
      cases: judgeableCases(result).map((item) => ({
        caseId: item.caseId,
        humanDescription: redact(item.humanDescription),
        orderedAiDescriptions: item.descriptions.map((entry, index) => ({ order: index + 1, round: entry.round, text: redact(entry.text) })),
      })),
    }),
  },
  {
    id: 'humanInputResponsiveness',
    label: '真人输入响应',
    promptVersion: 'judge-human-input-responsiveness-v3',
    schema: humanInputResponsivenessSchema,
    rubric: '只评估 Human Input Responsiveness：对比 Normal 与 Nonsense 两个完成用例，判断 AI 是否把纯数字、随机字符、重复语气词或无关内容识别为强异常证据。结合 codeEvidence 的首轮收票率、相对 Normal 的 lift 和明确异常理由判断；若代码验收 passed=false，评分不得高于 4。简短但相关的弱线索不能被误判为胡言乱语。0 分表示基本无差异，10 分表示响应清晰且合理。不要评价其他指标。',
    applicable: hasCompletedHumanComparison,
    unavailableReason: '该指标需要 Normal 与 Nonsense 两个完成用例，当前证据不足。',
    evidence: (result, redact) => ({
      codeEvidence: result.metrics.humanInputResponsiveness ?? null,
      cases: judgeableCases(result).filter((item) => item.caseId === 'normal-human-input' || item.caseId === 'nonsense-human-input').map((item) => ({
        caseId: item.caseId,
        humanDescription: redact(item.humanDescription),
        humanVotesReceived: item.humanVotesReceived,
        totalAiVotes: item.totalAiVotes,
        reasonAwarenessHits: item.reasonAwarenessHits,
        aiDescriptions: item.descriptions.map((entry) => ({ round: entry.round, text: redact(entry.text) })),
      })),
    }),
  },
  {
    id: 'exposureControl',
    label: '暴露控制',
    promptVersion: 'judge-exposure-control-v2',
    schema: exposureControlSchema,
    rubric: '只评估 Exposure Control：公开描述是否在保持可玩性的同时避免直接揭示题目、明显别名或过度确定的答案。0 分表示暴露严重，10 分表示克制且安全。不要推测或输出密词。不要评价其他指标。',
    evidence: (result, redact) => ({
      deterministicSafety: result.metrics.safety,
      qualityGate: {
        secretLeakRejectRate: result.metrics.secretLeakRejectRate,
        duplicateRejectRate: result.metrics.duplicateRejectRate,
        retryRate: result.metrics.retryRate,
      },
      cases: judgeableCases(result).map((item) => ({
        caseId: item.caseId,
        descriptions: item.descriptions.map((entry) => ({ round: entry.round, text: redact(entry.text) })),
      })),
    }),
  },
] as const;

export async function runAiJudge(
  enabled: boolean,
  deterministic: EvaluationResult,
  defaultModel: GameModel,
  trace?: JudgeTraceContext,
  sensitiveTerms: readonly string[] = [],
): Promise<EvaluationJudgeResult> {
  if (!enabled) return baseJudgeResult('disabled', '本次已关闭人工智能裁判。');
  if (judgeableCases(deterministic).length === 0) return baseJudgeResult('skipped', '人工智能裁判已跳过：至少需要一个已完成且包含公开描述证据的用例。');

  const judgeModel = defaultModel.completeJson ? defaultModel : new DeepSeekClient();
  if (!judgeModel.isConfigured()) return unavailableJudgeResult('人工智能裁判不可用：未配置模型密钥。');

  const redact = createRedactor(sensitiveTerms);
  const dimensions = {} as Record<JudgeDimensionId, JudgeDimensionResult>;
  for (const definition of DIMENSIONS) {
    if (definition.applicable && !definition.applicable(deterministic)) {
      dimensions[definition.id] = unavailableDimension(definition.unavailableReason ?? '该指标的证据不足。');
      continue;
    }
    dimensions[definition.id] = await runDimension(definition, deterministic, judgeModel, trace, redact);
  }

  const available = DIMENSIONS.filter((definition) => dimensions[definition.id].status === 'available');
  const availableMetrics = available.length;
  const behaviorScore = availableMetrics > 0 ? weightedScore(available, dimensions) : null;
  const scoreCoverage = availableMetrics === 5 ? 'full' : availableMetrics > 0 ? 'partial' : undefined;
  const summary = availableMetrics === 5
    ? `五项人工智能行为指标均可用，完整评分为 ${behaviorScore!.toFixed(2)} 分。`
    : `当前有 ${availableMetrics}/5 项人工智能行为指标可用，部分评分为 ${behaviorScore === null ? '不可用' : `${behaviorScore.toFixed(2)} 分`}。`;
  const output: JudgeOutput = {
    personaAdherence: dimensions.personaAdherence,
    semanticDiversity: dimensions.semanticDiversity,
    contextUtilization: dimensions.contextUtilization,
    humanInputResponsiveness: dimensions.humanInputResponsiveness,
    exposureControl: dimensions.exposureControl,
    summary,
  };

  return {
    status: availableMetrics > 0 ? 'available' : 'unavailable',
    retryCount: DIMENSIONS.reduce((sum, definition) => sum + dimensions[definition.id].retryCount, 0),
    behaviorScore,
    availableMetrics,
    totalMetrics: 5,
    ...(scoreCoverage ? { scoreCoverage } : {}),
    reason: summary,
    output,
  };
}

async function runDimension(
  definition: JudgeDimensionDefinition,
  deterministic: EvaluationResult,
  judgeModel: GameModel,
  trace: JudgeTraceContext | undefined,
  redact: (text: string) => string,
): Promise<JudgeDimensionResult> {
  const evidence = definition.evidence(deterministic, redact);
  const messages = dimensionMessages(definition, evidence);
  const debugPrompt = buildSafeDebugPrompt(definition, deterministic, evidence, trace);
  traceJudgePrompt(trace, definition, debugPrompt, messages, judgeModel.model);

  let lastError: unknown;
  let dimensionRetries = 0;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const startedAt = performance.now();
    try {
      const raw = await judgeModel.completeJson!('judge', messages, TEMPERATURE);
      const output = definition.schema.parse(normalizeDimensionOutput(raw));
      traceJudgeCall(trace, definition, debugPrompt, redact, judgeModel.model, performance.now() - startedAt, 'success', output, undefined, attempt, false);
      return { status: 'available', score: output.score, retryCount: attempt - 1, reason: output.reason, evidence: output.evidence, summary: output.summary };
    } catch (error) {
      lastError = error;
      const willRetry = error instanceof z.ZodError && attempt < 2;
      if (error instanceof z.ZodError) {
        judgeDebug('schema_mismatch', { dimension: definition.id, issues: error.issues.map((issue) => ({ path: issue.path.join('.') || '<root>', code: issue.code })) });
      }
      traceJudgeCall(trace, definition, debugPrompt, redact, judgeModel.model, performance.now() - startedAt, 'failure', undefined, error, attempt, willRetry);
      if (willRetry) dimensionRetries += 1;
      if (!willRetry) break;
    }
  }

  return unavailableDimension(failureReason(lastError), Math.max(dimensionRetries, retryCountFor(lastError)));
}

function normalizeDimensionOutput(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const record = raw as Partial<RawDimensionModelOutput>;
  const score = record.score;
  if (typeof score !== 'number' || !Number.isInteger(score) || score < 0 || score > 10) return raw;
  const expectedBand = scoreBand(score);
  return {
    ...record,
    reason: normalizeRatingField(record.reason, expectedBand.chinese),
    summary: normalizeRatingField(record.summary, expectedBand.chinese),
  };
}

function normalizeRatingField(value: unknown, expectedRating: string): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!/[\u3400-\u9fff]/u.test(trimmed)) return value;
  if (SCORE_BANDS.some((band) => trimmed.includes(band.chinese))) return value;
  return `评级：${expectedRating}。${trimmed}`;
}
function dimensionMessages(definition: JudgeDimensionDefinition, evidence: unknown): ChatMessage[] {
  return [
    { role: 'system', content: [
      `你是“谁是卧底”的独立指标评审。指标标识：${definition.id}。`,
      definition.rubric,
      SCORE_RUBRIC,
      'reason、evidence、summary 必须全部使用简体中文，且必须提供非空内容；JSON 字段名保持英文。',
      '只输出 JSON：{"score":0,"reason":"简体中文理由","evidence":"简体中文证据摘要","summary":"简体中文结论"}。',
      '不得输出玩家角色、密词、接口密钥、完整私有提示词或隐藏推理。',
    ].join('\n') },
    { role: 'user', content: JSON.stringify(evidence) },
  ];
}

function buildSafeDebugPrompt(definition: JudgeDimensionDefinition, deterministic: EvaluationResult, evidence: unknown, trace?: JudgeTraceContext): RenderedPrompt {
  const cases = judgeableCases(deterministic);
  const descriptionCount = cases.reduce((sum, item) => sum + item.descriptions.length, 0);
  return {
    version: definition.promptVersion,
    temperature: TEMPERATURE,
    secretWords: [],
    messages: [
      { role: 'system', content: `独立评估 ${definition.label}，并用简体中文返回指定 JSON。` },
      { role: 'user', content: JSON.stringify({ dimension: definition.id, caseIds: cases.map((item) => item.caseId), descriptionCount, evidenceFields: objectKeys(evidence) }) },
    ],
    metadata: {
      gameId: trace?.gameId ?? cases[0]?.gameId ?? 'evaluation-judge',
      round: trace?.round ?? 1,
      task: 'judge',
      agentId: dimensionAgentId(definition.id),
      publicDescriptionCount: descriptionCount,
      sameRoundPublicDescriptionCount: 0,
      ...(trace?.runId ? { runId: trace.runId } : {}),
    },
  };
}

function traceJudgePrompt(trace: JudgeTraceContext | undefined, definition: JudgeDimensionDefinition, debugPrompt: RenderedPrompt, actualMessages: ChatMessage[], model: string): void {
  recordPromptDebug(debugPrompt);
  if (!trace) return;
  trace.traceSink.record({
    eventType: 'prompt_provenance', gameId: trace.gameId, round: trace.round, task: 'judge', agentId: dimensionAgentId(definition.id),
    promptTemplateVersion: debugPrompt.version, promptHash: renderPromptHash(debugPrompt.version, actualMessages), model, temperature: TEMPERATURE,
    publicDescriptionCount: debugPrompt.metadata.publicDescriptionCount, sameRoundPublicDescriptionCount: 0,
    sourceType: 'EVAL_RUN', entrypoint: 'admin', modelKind: trace.modelKind, runId: trace.runId,
  });
}

function traceJudgeCall(
  trace: JudgeTraceContext | undefined,
  definition: JudgeDimensionDefinition,
  prompt: RenderedPrompt,
  redact: (text: string) => string,
  model: string,
  latencyMs: number,
  outcome: 'success' | 'failure',
  output?: DimensionModelOutput,
  error?: unknown,
  attempt = 1,
  willRetry = false,
): void {
  if (!trace) return;
  const diagnostic = diagnosticFor(error, attempt);
  trace.traceSink.record({
    eventType: 'model_call', gameId: trace.gameId, round: trace.round, phase: `evaluation_judge_${definition.id}`, task: 'judge',
    agentId: dimensionAgentId(definition.id), agentName: `人工智能裁判·${definition.label}`, attempt,
    errorType: diagnostic?.errorType, httpStatus: diagnostic?.httpStatus,
    latencyMs: Math.round(latencyMs * 10_000) / 10_000, willRetry, outcome, model, temperature: TEMPERATURE,
    inputSummary: prompt.messages[1]?.content ? redact(prompt.messages[1].content) : undefined,
    output: output ? redact(JSON.stringify(output)) : undefined, promptTemplateVersion: prompt.version,
    sourceType: 'EVAL_RUN', entrypoint: 'admin', modelKind: trace.modelKind, runId: trace.runId,
  });
}

function baseJudgeResult(status: JudgeStatus, reason: string): EvaluationJudgeResult {
  return { status, retryCount: 0, behaviorScore: null, availableMetrics: 0, totalMetrics: 5, reason };
}

function unavailableJudgeResult(reason: string): EvaluationJudgeResult {
  const dimensions = Object.fromEntries(DIMENSIONS.map((definition) => [definition.id, unavailableDimension(reason)])) as unknown as Record<JudgeDimensionId, JudgeDimensionResult>;
  const summary = '五项人工智能行为指标均不可用，未生成行为评分。';
  return {
    ...baseJudgeResult('unavailable', reason),
    output: {
      personaAdherence: dimensions.personaAdherence,
      semanticDiversity: dimensions.semanticDiversity,
      contextUtilization: dimensions.contextUtilization,
      humanInputResponsiveness: dimensions.humanInputResponsiveness,
      exposureControl: dimensions.exposureControl,
      summary,
    },
  };
}

function unavailableDimension(reason: string, retryCount = 0): JudgeDimensionResult {
  return {
    status: 'unavailable',
    score: null,
    retryCount,
    reason,
    evidence: '未获得可用的评审证据。',
    summary: '该指标暂时不可用。',
  };
}

function weightedScore(available: readonly JudgeDimensionDefinition[], dimensions: Record<JudgeDimensionId, JudgeDimensionResult>): number {
  const availableWeight = available.reduce((sum, definition) => sum + JUDGE_WEIGHTS[definition.id], 0);
  const weighted = available.reduce((sum, definition) => sum + dimensions[definition.id].score! * JUDGE_WEIGHTS[definition.id], 0);
  return Math.round((weighted / availableWeight) * 100) / 100;
}

function failureReason(error: unknown): string {
  if (error instanceof z.ZodError) return '该指标不可用：模型返回内容未通过格式或简体中文校验。';
  if (error instanceof ModelError) return '该指标不可用：模型调用失败，请查看追踪记录。';
  return '该指标不可用：评审调用出现异常，请查看追踪记录。';
}

function retryCountFor(error: unknown): number {
  if (error instanceof z.ZodError) return 1;
  if (error instanceof ModelError) return Math.max(0, (error.diagnostic?.attempt ?? 1) - 1);
  return 0;
}

function createRedactor(sensitiveTerms: readonly string[]): (text: string) => string {
  const terms = [...new Set(sensitiveTerms.map((term) => term.trim()).filter(Boolean))].sort((left, right) => right.length - left.length);
  return (text) => terms.reduce((safe, term) => safe.replaceAll(term, '[已脱敏]'), text);
}

function judgeableCases(result: EvaluationResult): EvaluationResult['cases'] {
  return result.cases.filter((item) => item.completed && item.descriptions.length > 0);
}

function hasCompletedHumanComparison(result: EvaluationResult): boolean {
  const cases = judgeableCases(result);
  return cases.some((item) => item.caseId === 'normal-human-input') && cases.some((item) => item.caseId === 'nonsense-human-input');
}

function objectKeys(value: unknown): string[] {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
}

function dimensionAgentId(id: JudgeDimensionId): string {
  return `ai-judge-${id.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

function diagnosticFor(error: unknown, attempt: number): ModelDiagnostic | undefined {
  if (error instanceof ModelError) return error.diagnostic;
  if (error instanceof z.ZodError) return { errorType: 'schema_validation', retryable: true, attempt };
  return undefined;
}

function judgeDebug(stage: string, details: Record<string, unknown>): void {
  if (process.env.EVALUATION_DEBUG === '1') console.info(`[judge-debug] ${JSON.stringify({ stage, ...details })}`);
}
