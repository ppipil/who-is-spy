import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { getAgentStrategy } from './agent-strategy.js';
import type { DescriptionRequest } from './description-quality.js';
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

export interface ModelUsageEvent {
  task: 'describe' | 'vote' | 'review';
  providerAttempt: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  source: 'provider';
}

export type ModelUsageRecorder = (event: ModelUsageEvent) => void;

export interface GameModel {
  readonly model: string;
  isConfigured(): boolean;
  describe(context: AgentContext, request?: DescriptionRequest): Promise<string>;
  vote(context: AgentContext, allowedTargets: Player[]): Promise<{ targetId: string; reason: string }>;
  review(game: GameState): Promise<GameReview>;
  setTraceSink?(sink: TraceSink): void;
  setUsageRecorder?(recorder: ModelUsageRecorder): void;
}

export class DeepSeekClient implements GameModel {
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly transport: ModelTransport;
  private traceSink?: TraceSink;
  private usageRecorder?: ModelUsageRecorder;

  constructor(options?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    traceSink?: TraceSink;
    transport?: ModelTransport;
    usageRecorder?: ModelUsageRecorder;
  }) {
    this.apiKey = options?.apiKey ?? process.env.DEEPSEEK_API_KEY ?? '';
    this.baseUrl = (options?.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/$/, '');
    this.model = options?.model ?? process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash';
    this.traceSink = options?.traceSink;
    this.transport = options?.transport ?? fetch;
    this.usageRecorder = options?.usageRecorder;
  }

  setTraceSink(sink: TraceSink): void {
    this.traceSink = sink;
  }

  setUsageRecorder(recorder: ModelUsageRecorder): void {
    this.usageRecorder = recorder;
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  async describe(context: AgentContext, request?: DescriptionRequest): Promise<string> {
    const strategy = getAgentStrategy(context.identity.strategyId);
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          '你正在玩“谁是卧底”。只依据收到的私有身份、自己的词和公开信息行动。绝不说出词语本身，不虚构其他玩家信息。用自然、含蓄、像真人的中文描述，避免每轮重复角度。只输出 JSON。',
      },
      {
        role: 'user',
        content: JSON.stringify({
          task: '为本轮给出一句公开描述。description 需为 2–60 个字符（约 28 个汉字以内），不能包含自己的词。',
          strategy: {
            id: strategy.id,
            guidance: strategy.buildDescriptionGuidance({
              role: context.identity.role,
              round: context.game.round,
              publicDescriptionCount: context.game.publicDescriptions.length,
            }),
          },
          repair: request?.repair,
          context,
          output: { description: 'string', private_reasoning_summary: 'string' },
        }),
      },
    ];

    return this.withRetry('describe', context, async (attempt) => {
      const result = descriptionSchema.parse(await this.chatJson('describe', messages, 0.8, attempt));
      return result.description;
    });
  }

  async vote(context: AgentContext, allowedTargets: Player[]): Promise<{ targetId: string; reason: string }> {
    const strategy = getAgentStrategy(context.identity.strategyId);
    const targetIds = allowedTargets.map((player) => player.id);
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          '你正在玩“谁是卧底”。只依据自己的私有身份、词语与公开描述投票。不得读取或猜测系统未提供的隐藏字段。必须投给存活的其他玩家，并给出简短公开理由。只输出 JSON。',
      },
      {
        role: 'user',
        content: JSON.stringify({
          task: '选择最可疑的一名玩家。',
          strategy: {
            id: strategy.id,
            guidance: strategy.buildVoteGuidance({
              role: context.identity.role,
              round: context.game.round,
              publicDescriptionCount: context.game.publicDescriptions.length,
            }),
          },
          context,
          allowedTargets: allowedTargets.map(({ id, name }) => ({ id, name })),
          output: { targetId: '必须来自 allowedTargets.id', reason: '不超过 36 个汉字' },
        }),
      },
    ];

    return this.withRetry('vote', context, async (attempt) => {
      const result = voteSchema.parse(await this.chatJson('vote', messages, 0.8, attempt));
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
    const publicRecord = {
      players: game.players.map(({ id, name, role, word, alive }) => ({ id, name, role, word, alive })),
      descriptions: game.descriptions,
      votes: game.votes,
      events: game.events,
      winner: game.winner,
    };
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: '你是“谁是卧底”的专业赛后分析师。根据完整赛局生成精炼、具体、有洞察的中文复盘。只输出 JSON。',
      },
      {
        role: 'user',
        content: JSON.stringify({
          task: '指出关键转折、描述策略和投票逻辑。playerInsights 覆盖每名玩家。',
          record: publicRecord,
          output: {
            headline: 'string',
            summary: 'string',
            turningPoints: ['string'],
            playerInsights: [{ playerId: 'string', insight: 'string' }],
          },
        }),
      },
    ];
    return this.withRetry('review', game, async (attempt) => reviewSchema.parse(await this.chatJson('review', messages, 0.45, attempt)));
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
