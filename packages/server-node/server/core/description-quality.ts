export type DescriptionViolationType =
  | 'empty'
  | 'invalid_length'
  | 'secret_leak'
  | 'duplicate_description';

export interface DescriptionQualityInput {
  text: string;
  allSecrets: readonly string[];
  acceptedSameRound: readonly string[];
  duplicateSimilarityThreshold: number;
}

export interface DescriptionQualityViolation {
  type: DescriptionViolationType;
  message: string;
  similarity?: number;
}

export interface DescriptionQualityRule {
  check(input: DescriptionQualityInput): DescriptionQualityViolation | null;
}

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

export interface DescriptionRequest {
  attempt: number;
  repair?: { violationType: DescriptionViolationType; guidance: string };
}

export class DescriptionQualityError extends Error {
  constructor(
    message: string,
    public readonly violationType: DescriptionViolationType,
  ) {
    super(message);
    this.name = 'DescriptionQualityError';
  }
}

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

const emptyRule: DescriptionQualityRule = {
  check: ({ text }) =>
    normalizeDescription(text).length === 0
      ? { type: 'empty', message: '描述不能为空' }
      : null,
};

const lengthRule: DescriptionQualityRule = {
  check: ({ text }) => {
    const length = normalizeDescription(text).length;
    return length < 2 || length > 60
      ? { type: 'invalid_length', message: '描述长度必须为 2–60 个字符' }
      : null;
  },
};

const secretRule: DescriptionQualityRule = {
  check: ({ text, allSecrets }) => {
    const normalized = normalizeDescription(text);
    return allSecrets.some((secret) => secret.length > 0 && normalized.includes(secret))
      ? { type: 'secret_leak', message: '描述包含禁止公开的完整词语' }
      : null;
  },
};

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

export const DEFAULT_DESCRIPTION_RULES: readonly DescriptionQualityRule[] = [
  emptyRule,
  lengthRule,
  secretRule,
  duplicateRule,
];

export function repairGuidance(violation: DescriptionQualityViolation): string {
  const guidance: Record<DescriptionViolationType, string> = {
    empty: '上次没有给出有效内容，请重新生成一句完整但含蓄的描述。',
    invalid_length: '上次长度不合规，请生成 2–60 个字符的一句话。',
    secret_leak: '上次包含禁止公开的答案，请换用更间接的属性，且不要复述任何词语。',
    duplicate_description: '上次与本轮公开描述过于相似，请换一个未使用的角度和措辞。',
  };
  return guidance[violation.type];
}

export function normalizeDescription(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

export function descriptionSimilarity(left: string, right: string): number {
  const leftPairs = bigrams(normalizeForSimilarity(left));
  const rightPairs = bigrams(normalizeForSimilarity(right));
  if (leftPairs.size === 0 && rightPairs.size === 0) return 1;
  let overlap = 0;
  for (const pair of leftPairs) if (rightPairs.has(pair)) overlap += 1;
  return (2 * overlap) / (leftPairs.size + rightPairs.size || 1);
}

function normalizeForSimilarity(value: string): string {
  return value.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function bigrams(value: string): Set<string> {
  const result = new Set<string>();
  for (let index = 0; index < value.length - 1; index += 1) result.add(value.slice(index, index + 2));
  return result;
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

