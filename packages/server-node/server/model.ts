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
import type { ModelDiagnostic, ModelErrorType, ModelTask, TraceSink } from './trace.js';

const descriptionSchema = z.object({
  description: z.string().trim().min(2).max(60),
  private_reasoning_summary: z.string().trim().min(1).max(120).optional(),
});

const voteSchema = z.object({
  targetId: z.string().min(1),
  reason: z.string().trim().min(2).max(80),
});

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

export interface GameModel {
  readonly model: string;
  isConfigured(): boolean;
  describe(context: AgentContext, request?: DescriptionRequest): Promise<string>;
  vote(context: AgentContext, allowedTargets: Player[]): Promise<{ targetId: string; reason: string }>;
  review(game: GameState): Promise<GameReview>;
  setTraceSink?(sink: TraceSink): void;
}

export class DeepSeekClient implements GameModel {
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly transport: ModelTransport;
  private traceSink?: TraceSink;

  constructor(options?: { apiKey?: string; baseUrl?: string; model?: string; traceSink?: TraceSink; transport?: ModelTransport }) {
    this.apiKey = options?.apiKey ?? process.env.DEEPSEEK_API_KEY ?? '';
    this.baseUrl = (options?.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/$/, '');
    this.model = options?.model ?? process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash';
    this.traceSink = options?.traceSink;
    this.transport = options?.transport ?? fetch;
  }

  setTraceSink(sink: TraceSink): void {
    this.traceSink = sink;
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  async describe(context: AgentContext, request?: DescriptionRequest): Promise<string> {
    const prompt = buildDescribePrompt(context, request);
    this.traceProvenance(prompt);
    recordPromptDebug(prompt);
    return this.withRetry('describe', context, async (attempt) => {
      const result = descriptionSchema.parse(await this.chatJson('describe', prompt.messages, prompt.temperature, attempt));
      return result.description;
    });
  }

  async vote(context: AgentContext, allowedTargets: Player[]): Promise<{ targetId: string; reason: string }> {
    const prompt = buildVotePrompt(
      context,
      allowedTargets.map(({ id, name }) => ({ id, name })),
    );
    this.traceProvenance(prompt);
    recordPromptDebug(prompt);
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

  async review(game: GameState): Promise<GameReview> {
    const prompt = buildReviewPrompt(game);
    this.traceProvenance(prompt);
    recordPromptDebug(prompt);
    return this.withRetry('review', game, async (attempt) =>
      reviewSchema.parse(await this.chatJson('review', prompt.messages, prompt.temperature, attempt)),
    );
  }

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
    });
  }

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
      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
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

export function normalizeModelDiagnostic(error: unknown, attempt: number): ModelDiagnostic {
  if (error instanceof ModelError && error.diagnostic) return { ...error.diagnostic, attempt };
  if (error instanceof z.ZodError) return { errorType: 'schema_validation', retryable: true, attempt };
  return classifyTransportError(error, attempt);
}

function classifyTransportError(error: unknown, attempt: number): ModelDiagnostic {
  if (isAbortError(error)) return { errorType: 'timeout', retryable: true, attempt };
  if (error instanceof TypeError) return { errorType: 'network', retryable: true, attempt };
  return { errorType: 'unknown', retryable: true, attempt };
}

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

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function stripCodeFence(content: string): string {
  return content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
