/**
 * 描述质量门禁（服务端权威校验）
 *
 * AI（与人类）的描述在提交前必须通过以下规则：
 * 空内容、长度 2–60、不得包含任一密词、不得与本轮已公开描述高度重复。
 * 违例会生成 DescriptionQualityEvent 供 trace/评测收集；
 * 重试耗尽时抛 DescriptionQualityError，且本轮状态不推进。
 */
export type DescriptionViolationType =
  | 'empty'
  | 'invalid_length'
  | 'secret_leak'
  | 'duplicate_description';

/** 门禁输入：待检文本、全部密词、本轮已接受描述与重复阈值。 */
export interface DescriptionQualityInput {
  text: string;
  allSecrets: readonly string[];
  acceptedSameRound: readonly string[];
  duplicateSimilarityThreshold: number;
}

/** 一次违例的明细（含重复相似度）。 */
export interface DescriptionQualityViolation {
  type: DescriptionViolationType;
  message: string;
  similarity?: number;
}

/** 单条规则接口。 */
export interface DescriptionQualityRule {
  check(input: DescriptionQualityInput): DescriptionQualityViolation | null;
}

/** 违例事件：供引擎回调解读（写 trace / 评测统计）。 */
export interface DescriptionQualityEvent {
  gameId: string;
  round: number;
  agentId: string;
  strategyId: string;
  attempt: number;
  violationType: DescriptionViolationType;
  similarity?: number;
  willRetry: boolean;
}

/** 描述生成请求：attempt 序号，可选修复指引。 */
export interface DescriptionRequest {
  attempt: number;
  repair?: { violationType: DescriptionViolationType; guidance: string };
}

/** 质量错误：携带违例类型，引擎据此中止本轮且不推进状态。 */
export class DescriptionQualityError extends Error {
  constructor(
    message: string,
    public readonly violationType: DescriptionViolationType,
  ) {
    super(message);
    this.name = 'DescriptionQualityError';
  }
}

/** 质量门禁：按序执行规则，返回第一个违例；全部通过返回 null。 */
export class DescriptionQualityGate {
  constructor(
    private readonly rules: readonly DescriptionQualityRule[] = DEFAULT_DESCRIPTION_RULES,
  ) {}

  check(input: DescriptionQualityInput): DescriptionQualityViolation | null {
    for (const rule of this.rules) {
      const violation = rule.check(input);
      if (violation) return violation;
    }
    return null;
  }
}

// 规则 1：非空。
const emptyRule: DescriptionQualityRule = {
  check: ({ text }) =>
    normalizeDescription(text).length === 0
      ? { type: 'empty', message: '描述不能为空' }
      : null,
};

// 规则 2：长度 2–60 字符。
const lengthRule: DescriptionQualityRule = {
  check: ({ text }) => {
    const length = normalizeDescription(text).length;
    return length < 2 || length > 60
      ? { type: 'invalid_length', message: '描述长度必须为 2–60 个字符' }
      : null;
  },
};

// 规则 3：不得包含任何密词（平民词与卧底词都禁止说出）。
const secretRule: DescriptionQualityRule = {
  check: ({ text, allSecrets }) => {
    const normalized = normalizeDescription(text);
    return allSecrets.some((secret) => secret.length > 0 && normalized.includes(secret))
      ? { type: 'secret_leak', message: '描述包含禁止公开的完整词语' }
      : null;
  },
};

// 规则 4：与本轮已接受描述的最大相似度不得达到阈值。
const duplicateRule: DescriptionQualityRule = {
  check: ({ text, acceptedSameRound, duplicateSimilarityThreshold }) => {
    const similarity = Math.max(
      0,
      ...acceptedSameRound.map((accepted) => descriptionSimilarity(text, accepted)),
    );
    return similarity >= duplicateSimilarityThreshold
      ? {
          type: 'duplicate_description',
          message: '描述与本轮已公开内容过于相似',
          similarity: round(similarity),
        }
      : null;
  },
};

/** 默认规则集：按“空 → 长度 → 泄密 → 重复”顺序执行。 */
export const DEFAULT_DESCRIPTION_RULES: readonly DescriptionQualityRule[] = [
  emptyRule,
  lengthRule,
  secretRule,
  duplicateRule,
];

/** 按违例类型生成修复指引（随下一次模型请求一起发送）。 */
export function repairGuidance(violation: DescriptionQualityViolation): string {
  const guidance: Record<DescriptionViolationType, string> = {
    empty: '上次没有给出有效内容，请重新生成一句完整但含蓄的描述。',
    invalid_length: '上次长度不合规，请生成 2–60 个字符的一句话。',
    secret_leak: '上次包含禁止公开的答案，请换用更间接的属性，且不要复述任何词语。',
    duplicate_description: '上次与本轮公开描述过于相似，请换一个未使用的角度和措辞。',
  };
  return guidance[violation.type];
}

/** 描述归一化：去首尾空白、折叠连续空白。 */
export function normalizeDescription(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/** 描述相似度：Dice 系数（bigram），0~1。 */
export function descriptionSimilarity(left: string, right: string): number {
  const leftPairs = bigrams(normalizeForSimilarity(left));
  const rightPairs = bigrams(normalizeForSimilarity(right));
  if (leftPairs.size === 0 && rightPairs.size === 0) return 1;
  let overlap = 0;
  for (const pair of leftPairs) if (rightPairs.has(pair)) overlap += 1;
  return (2 * overlap) / (leftPairs.size + rightPairs.size || 1);
}

/** 相似度归一化：小写并去除空白/标点/符号。 */
function normalizeForSimilarity(value: string): string {
  return value.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** 提取连续两字符的 bigram 集合。 */
function bigrams(value: string): Set<string> {
  const result = new Set<string>();
  for (let index = 0; index < value.length - 1; index += 1) result.add(value.slice(index, index + 2));
  return result;
}

/** 四舍五入到 4 位小数。 */
function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

