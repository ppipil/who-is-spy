import { z } from 'zod';
import type { AgentContext, GameReview, GameState, Player } from './types.js';

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
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ModelError';
  }
}

interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

export interface GameModel {
  readonly model: string;
  isConfigured(): boolean;
  describe(context: AgentContext): Promise<string>;
  vote(context: AgentContext, allowedTargets: Player[]): Promise<{ targetId: string; reason: string }>;
  review(game: GameState): Promise<GameReview>;
}

export class DeepSeekClient implements GameModel {
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options?: { apiKey?: string; baseUrl?: string; model?: string }) {
    this.apiKey = options?.apiKey ?? process.env.DEEPSEEK_API_KEY ?? '';
    this.baseUrl = (options?.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/$/, '');
    this.model = options?.model ?? process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash';
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  async describe(context: AgentContext): Promise<string> {
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
          context,
          output: { description: 'string', private_reasoning_summary: 'string' },
        }),
      },
    ];

    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = descriptionSchema.parse(await this.chatJson(messages));
        if (result.description.includes(context.identity.word)) {
          throw new Error('描述包含秘密词');
        }
        return result.description;
      } catch (error) {
        lastError = error;
      }
    }
    throw new ModelError('AI 未能生成合规描述，已自动重试；请再试一次', lastError);
  }

  async vote(context: AgentContext, allowedTargets: Player[]): Promise<{ targetId: string; reason: string }> {
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
          context,
          allowedTargets: allowedTargets.map(({ id, name }) => ({ id, name })),
          output: { targetId: '必须来自 allowedTargets.id', reason: '不超过 36 个汉字' },
        }),
      },
    ];

    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = voteSchema.parse(await this.chatJson(messages));
        if (!targetIds.includes(result.targetId)) {
          throw new Error(`无效投票目标: ${result.targetId}`);
        }
        return result;
      } catch (error) {
        lastError = error;
      }
    }
    throw new ModelError('AI 未能生成有效选票，已自动重试；请再试一次', lastError);
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
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return reviewSchema.parse(await this.chatJson(messages, 0.45));
      } catch (error) {
        lastError = error;
      }
    }
    throw new ModelError('AI 未能生成结构化复盘', lastError);
  }

  private async chatJson(messages: ChatMessage[], temperature = 0.8): Promise<unknown> {
    if (!this.isConfigured()) {
      throw new ModelError('未配置 DEEPSEEK_API_KEY，请复制 .env.example 为 .env 后填写密钥');
    }

    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
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
        if (!response.ok) {
          const detail = await response.text();
          throw new Error(`DeepSeek ${response.status}: ${detail.slice(0, 240)}`);
        }
        const payload = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const content = payload.choices?.[0]?.message?.content;
        if (!content) throw new Error('DeepSeek 返回了空内容');
        return JSON.parse(stripCodeFence(content));
      } catch (error) {
        lastError = error;
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 600));
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new ModelError('AI 服务暂时不可用，已自动重试；请稍后再试', lastError);
  }
}

function stripCodeFence(content: string): string {
  return content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
}
