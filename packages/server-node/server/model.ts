/**
 * 模型客户端（DeepSeek / OpenAI 兼容）
 *
 * - describe/vote/review 三个任务统一走 chat/completions JSON 模式；
 * - 每次调用自动重试一次（仅对可重试错误），并记录 model_call trace；
 * - 从 provider 响应 usage 中记录 token 用量（评测成本指标的数据源）；
 * - prompt 溯源与脱敏调试记录由 prompt.ts 提供。
 */
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import type { DescriptionRequest } from './description-quality.js';
import {
  buildDescribePrompt,
  buildReviewPrompt,
  buildVotePrompt,
  recordPromptDebug,
  renderPromptHash,
  type RenderedPrompt,
} from './prompt.js';
import type { AgentContext, GameReview, GameState, Player } from './types.js';
import type {
  ModelDiagnostic,
  ModelErrorType,
  ModelTask,
  TraceModelKind,
  TraceOrigin,
  TraceSink,
} from './trace.js';

// 描述响应 schema：description 必填，私有推理摘要可选。
const descriptionSchema = z.object({
  description: z.string().trim().min(2).max(60),
  private_reasoning_summary: z.string().trim().min(1).max(120).optional(),
});

// 投票响应 schema：targetId 必须来自服务端下发的候选。
const voteSchema = z.object({
  targetId: z.string().min(1),
  reason: z.string().trim().min(2).max(80),
});

// 复盘响应 schema：标题/摘要/转折点/每人洞察，字段都有长度约束。
const reviewSchema = z.object({
  headline: z.string().trim().min(2).max(40),
  summary: z.string().trim().min(10).max(300),
  turningPoints: z.array(z.string().trim().min(2).max(120)).min(1).max(4),
  playerInsights: z.array(
    z.object({
      playerId: z.string(),
      insight: z.string().trim().min(2).max(120),
    }),
  ),
});

/** 模型层错误：附带诊断信息（错误类型、HTTP 状态、可重试性）。 */
export class ModelError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
    public readonly diagnostic?: ModelDiagnostic,
  ) {
    super(message);
    this.name = 'ModelError';
  }
}

interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

export type ModelTransport = typeof fetch;

/** provider 返回的 token 用量事件（一次真实调用一条）。 */
export interface ModelUsageEvent {
  task: 'describe' | 'vote' | 'review';
  providerAttempt: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  source: 'provider';
}

/** 用量回调类型：评测 harness 用它收集 token 数据。 */
export type ModelUsageRecorder = (event: ModelUsageEvent) => void;

/** 模型接口：引擎只依赖这三个任务 + 可选 trace/usage 回调。 */
export interface GameModel {
  readonly model: string;
  readonly modelKind?: TraceModelKind;
  isConfigured(): boolean;
  describe(context: AgentContext, request?: DescriptionRequest): Promise<string>;
  vote(context: AgentContext, allowedTargets: Player[]): Promise<{ targetId: string; reason: string }>;
  review(game: GameState): Promise<GameReview>;
  setTraceSink?(sink: TraceSink): void;
  setOrigin?(origin: TraceOrigin): void;
  setUsageRecorder?(recorder: ModelUsageRecorder): void;
}

/** DeepSeek 兼容客户端实现（也兼容任意 OpenAI 风格端点）。 */
export class DeepSeekClient implements GameModel {
  readonly model: string;
  readonly modelKind: TraceModelKind = 'real';
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly transport: ModelTransport;
  private traceSink?: TraceSink;
  private usageRecorder?: ModelUsageRecorder;
  private origin?: TraceOrigin;

  /** 配置来源优先级：显式参数 > 环境变量 > 默认值。 */
  constructor(options?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    traceSink?: TraceSink;
    transport?: ModelTransport;
    usageRecorder?: ModelUsageRecorder;
    origin?: TraceOrigin;
  }) {
    this.apiKey = options?.apiKey ?? process.env.DEEPSEEK_API_KEY ?? '';
    this.baseUrl = (options?.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/$/, '');
    this.model = options?.model ?? process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash';
    this.traceSink = options?.traceSink;
    this.transport = options?.transport ?? fetch;
    this.usageRecorder = options?.usageRecorder;
    this.origin = options?.origin;
  }

  /** 注入 trace sink（模型调用与 prompt 溯源事件会写入这里）。 */
  setTraceSink(sink: TraceSink): void {
    this.traceSink = sink;
  }

  /** 注入 token 用量回调（评测用）。 */
  setUsageRecorder(recorder: ModelUsageRecorder): void {
    this.usageRecorder = recorder;
  }

  setOrigin(origin: TraceOrigin): void {
    this.origin = origin;
  }

  /** 是否配置了 API Key。 */
  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  /** 生成一句描述：构建 prompt → 溯源/调试记录 → 带重试的 JSON 调用 → 返回 description。 */
  async describe(context: AgentContext, request?: DescriptionRequest): Promise<string> {
    const prompt = buildDescribePrompt(context, request);
    this.traceProvenance(prompt);
    recordPromptDebug(prompt, this.origin);
    return this.withRetry('describe', context, async (attempt) => {
      const result = descriptionSchema.parse(await this.chatJson('describe', prompt.messages, prompt.temperature, attempt));
      return result.description;
    });
  }

  /** 生成投票：校验返回的 targetId 必须在候选列表内，否则按 schema 违例重试。 */
  async vote(context: AgentContext, allowedTargets: Player[]): Promise<{ targetId: string; reason: string }> {
    const prompt = buildVotePrompt(
      context,
      allowedTargets.map(({ id, name }) => ({ id, name })),
    );
    this.traceProvenance(prompt);
    recordPromptDebug(prompt, this.origin);
    const targetIds = allowedTargets.map((player) => player.id);
    return this.withRetry('vote', context, async (attempt) => {
      const result = voteSchema.parse(await this.chatJson('vote', prompt.messages, prompt.temperature, attempt));
      if (!targetIds.includes(result.targetId)) {
        throw new ModelError('AI 返回了无效投票目标', undefined, {
          errorType: 'schema_validation',
          retryable: true,
          attempt,
        });
      }
      return result;
    });
  }

  /** 生成终局复盘。 */
  async review(game: GameState): Promise<GameReview> {
    const prompt = buildReviewPrompt(game);
    this.traceProvenance(prompt);
    recordPromptDebug(prompt, this.origin);
    return this.withRetry('review', game, async (attempt) =>
      reviewSchema.parse(await this.chatJson('review', prompt.messages, prompt.temperature, attempt)),
    );
  }

  /** 记录 prompt 溯源事件（模板版本 + hash + 上下文规模）。 */
  private traceProvenance(prompt: RenderedPrompt): void {
    if (!this.traceSink) return;
    this.traceSink.record({
      eventType: 'prompt_provenance',
      gameId: prompt.metadata.gameId,
      round: prompt.metadata.round,
      task: prompt.metadata.task,
      agentId: prompt.metadata.agentId,
      role: prompt.metadata.role,
      strategyId: prompt.metadata.strategyId,
      promptTemplateVersion: prompt.version,
      promptHash: renderPromptHash(prompt.version, prompt.messages),
      model: this.model,
      temperature: prompt.temperature,
      publicDescriptionCount: prompt.metadata.publicDescriptionCount,
      sameRoundPublicDescriptionCount: prompt.metadata.sameRoundPublicDescriptionCount,
      strategyGuidance: prompt.metadata.strategyGuidance,
      repairViolationType: prompt.metadata.repairViolationType,
      sourceType: this.origin?.sourceType,
      entrypoint: this.origin?.entrypoint,
      modelKind: this.origin?.modelKind ?? this.modelKind,
    });
  }

  /**
   * 带重试的统一调用骨架：最多尝试 2 次，
   * 仅对诊断标记为可重试的错误重试（间隔 600ms），
   * 每次尝试都会写 model_call trace（成功/失败）。
   */
  private async withRetry<T>(
    task: ModelTask,
    context: AgentContext | GameState,
    operation: (attempt: number) => Promise<T>,
  ): Promise<T> {
    let lastError: ModelError | undefined;
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const startedAt = performance.now();
      try {
        const result = await operation(attempt);
        this.traceModelCall(context, task, attempt, round(performance.now() - startedAt), 'success', false);
        return result;
      } catch (error) {
        const diagnostic = normalizeModelDiagnostic(error, attempt);
        const willRetry = diagnostic.retryable && attempt < maxAttempts;
        lastError =
          error instanceof ModelError
            ? new ModelError(error.message, error.cause, diagnostic)
            : new ModelError(messageForDiagnostic(task, diagnostic), error, diagnostic);
        this.traceModelCall(context, task, attempt, round(performance.now() - startedAt), 'failure', willRetry, diagnostic);
        if (!willRetry) throw lastError;
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
    }
    throw lastError ?? new ModelError('AI 服务暂时不可用，已自动重试；请稍后再试');
  }

  /** 发起 chat/completions 请求：30s 超时、JSON 模式、记录 usage、解析并校验 JSON。 */
  private async chatJson(task: ModelTask, messages: ChatMessage[], temperature: number, attempt: number): Promise<unknown> {
    if (!this.isConfigured()) {
      throw new ModelError('未配置模型密钥，请检查本地环境变量', undefined, {
        errorType: 'http_non_retryable',
        retryable: false,
        attempt,
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await this.transport(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature,
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw httpModelError(response.status, attempt);
      // 读取 provider 返回的 token 用量（评测成本指标依赖）。
      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      this.recordUsage(task, attempt, payload.usage);
      const content = payload.choices?.[0]?.message?.content;
      if (!content) {
        throw new ModelError('AI 返回了空内容', undefined, {
          errorType: 'schema_validation',
          retryable: true,
          attempt,
        });
      }
      try {
        return JSON.parse(stripCodeFence(content));
      } catch (error) {
        throw new ModelError('AI 返回了无法解析的 JSON', error, {
          errorType: 'invalid_json',
          retryable: true,
          attempt,
        });
      }
    } catch (error) {
      if (error instanceof ModelError) throw error;
      const diagnostic = classifyTransportError(error, attempt);
      throw new ModelError(messageForDiagnostic(task, diagnostic), error, diagnostic);
    } finally {
      clearTimeout(timeout);
    }
  }

  /** 把 provider usage 字段归一化后交给评测回调；字段缺失时按 0 处理。 */
  private recordUsage(
    task: ModelUsageEvent['task'],
    providerAttempt: number,
    usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined,
  ): void {
    if (!usage || !this.usageRecorder) return;
    const inputTokens = Number.isFinite(usage.prompt_tokens) ? (usage.prompt_tokens ?? 0) : 0;
    const outputTokens = Number.isFinite(usage.completion_tokens) ? (usage.completion_tokens ?? 0) : 0;
    const totalTokens = Number.isFinite(usage.total_tokens)
      ? (usage.total_tokens ?? inputTokens + outputTokens)
      : inputTokens + outputTokens;
    this.usageRecorder({
      task,
      providerAttempt,
      inputTokens,
      outputTokens,
      totalTokens,
      source: 'provider',
    });
  }

  /** 记录 model_call trace：context 可能是 AgentContext（describe/vote）或 GameState（review）。 */
  private traceModelCall(
    context: AgentContext | GameState,
    task: ModelTask,
    attempt: number,
    latencyMs: number,
    outcome: 'success' | 'failure',
    willRetry: boolean,
    diagnostic?: ModelDiagnostic,
  ): void {
    if (!this.traceSink) return;
    // 通过是否含 players 字段区分 review（传 GameState）与其余任务。
    const isGame = 'players' in context;
    this.traceSink.record({
      eventType: 'model_call',
      gameId: isGame ? context.id : context.game.gameId ?? 'unknown',
      round: isGame ? context.round : context.game.round,
      phase: isGame ? context.phase : context.game.phase,
      ballot: isGame ? context.ballot : context.game.ballot,
      task,
      agentId: isGame ? 'review' : context.identity.playerId,
      agentName: isGame ? '复盘' : context.identity.name,
      strategyId: isGame ? undefined : context.identity.strategyId,
      attempt,
      errorType: diagnostic?.errorType,
      httpStatus: diagnostic?.httpStatus,
      latencyMs,
      willRetry,
      outcome,
    });
  }
}

/** 把任意错误归一化为诊断信息（ModelError / ZodError / 传输错误）。 */
export function normalizeModelDiagnostic(error: unknown, attempt: number): ModelDiagnostic {
  if (error instanceof ModelError && error.diagnostic) return { ...error.diagnostic, attempt };
  if (error instanceof z.ZodError) return { errorType: 'schema_validation', retryable: true, attempt };
  return classifyTransportError(error, attempt);
}

/** 传输层错误分类：超时/网络/未知。 */
function classifyTransportError(error: unknown, attempt: number): ModelDiagnostic {
  if (isAbortError(error)) return { errorType: 'timeout', retryable: true, attempt };
  if (error instanceof TypeError) return { errorType: 'network', retryable: true, attempt };
  return { errorType: 'unknown', retryable: true, attempt };
}

/** HTTP 状态 → 错误类型与可重试性（429/5xx 可重试）。 */
function httpModelError(status: number, attempt: number): ModelError {
  const errorType: ModelErrorType =
    status === 429 ? 'rate_limit' : status >= 500 ? 'provider_5xx' : 'http_non_retryable';
  return new ModelError(`AI 服务返回 HTTP ${status}`, undefined, {
    errorType,
    httpStatus: status,
    retryable: status === 429 || status >= 500,
    attempt,
  });
}

/** 生成面向用户的失败文案（任务 + 错误类型）。 */
function messageForDiagnostic(task: ModelTask, diagnostic: ModelDiagnostic): string {
  const taskLabel = { describe: '描述', vote: '投票', review: '复盘' }[task];
  const labels: Record<ModelErrorType, string> = {
    timeout: '请求超时',
    rate_limit: '供应商限流',
    provider_5xx: '供应商服务异常',
    http_non_retryable: '供应商请求被拒绝',
    invalid_json: '返回 JSON 无法解析',
    schema_validation: '返回结构不符合约定',
    network: '网络不可用',
    secret: '内容包含禁止公开信息',
    unknown: '未知错误',
  };
  return `AI ${taskLabel}失败：${labels[diagnostic.errorType]}`;
}

/** 判断是否为 AbortController 超时中止。 */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/** 去掉模型可能包裹的 ```json ... ``` 代码围栏，再交给 JSON.parse。 */
function stripCodeFence(content: string): string {
  return content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
}

/** 四舍五入到 4 位小数。 */
function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
