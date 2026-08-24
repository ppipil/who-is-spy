export type DescriptionSecretPolicy = 'complete_words' | 'own_word_characters';

export type DescriptionViolationType =
  | 'empty'
  | 'invalid_length'
  | 'secret_leak'
  | 'duplicate_description';

export interface DescriptionQualityInput {
  text: string;
  ownSecret: string;
  allSecrets: readonly string[];
  secretPolicy?: DescriptionSecretPolicy;
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
  secretPolicy?: DescriptionSecretPolicy;
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

/**
 * 描述提交前的服务端权威门禁。
 * 它按固定顺序短路执行规则并返回首个 violation；不依赖模型自觉，也不直接修改 GameState。
 * GameEngine 根据 violation 决定定向重试，只有返回 null 的描述才允许公开。
 */
export class DescriptionQualityGate {
  constructor(
    private readonly rules: readonly DescriptionQualityRule[] = DEFAULT_DESCRIPTION_RULES,
  ) {}

  check(input: DescriptionQualityInput): DescriptionQualityViolation | null {
    // 规则按“基础合法性 → 泄密 → 雷同”短路；一次只返回首个问题，便于给模型明确的定向修复提示。
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
  check: ({ text, ownSecret, allSecrets, secretPolicy }) => {
    return containsSecretLeak(text, ownSecret, allSecrets, secretPolicy)
      ? { type: 'secret_leak', message: '描述包含禁止公开的题目词或组成字' }
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

/**
 * 把结构化 violation 翻译成下一次模型调用可执行的修复指令。
 * 指令只针对本次失败原因，避免重试 Prompt 无限膨胀；密词政策不同，泄密提示也随之变化。
 */
export function repairGuidance(
  violation: DescriptionQualityViolation,
  secretPolicy: DescriptionSecretPolicy = 'own_word_characters',
): string {
  const guidance: Record<DescriptionViolationType, string> = {
    empty: '上次没有给出有效内容，请重新生成一句完整但含蓄的描述。',
    invalid_length: '上次长度不合规，请生成 2–60 个字符的一句话。',
    secret_leak: secretPolicy === 'complete_words'
      ? '上次包含完整题目词。请换用更间接的属性，不要复述任何完整题目词。'
      : '上次包含完整题目词，或使用了自己题目词中的汉字。请换用更间接的属性，不要复述题目词或其中的字。',
    duplicate_description: '上次与本轮公开描述过于相似，请换一个未使用的角度和措辞。',
  };
  return guidance[violation.type];
}

/** 统一裁剪首尾空白并折叠连续空白，使长度、泄密和相似度规则使用同一文本口径。 */
export function normalizeDescription(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/**
 * 生成需要禁止公开的词项集合：完整密词加其中的汉字，并按长度降序排列。
 * 默认生产策略只用当前 Agent 的汉字集合，避免把另一个阵营的词反向泄露给 Prompt。
 */
export function secretLeakTerms(secrets: readonly string[]): string[] {
  const terms = new Set<string>();
  for (const secret of secrets) {
    const normalized = normalizeDescription(secret);
    if (!normalized) continue;
    terms.add(normalized);
    for (const char of normalized) {
      if (/\p{Script=Han}/u.test(char)) terms.add(char);
    }
  }
  return [...terms].sort((left, right) => right.length - left.length || left.localeCompare(right));
}

/**
 * 判断候选描述是否泄密。
 * 两种策略都拦截所有完整题目词；own_word_characters 还拦截当前玩家词中的任一汉字，
 * 而 complete_words 用于可复现评测，避免固定题词的共享汉字让测试描述无法生成。
 */
export function containsSecretLeak(
  text: string,
  ownSecret: string,
  allSecrets: readonly string[],
  secretPolicy: DescriptionSecretPolicy = 'own_word_characters',
): boolean {
  const normalized = normalizeDescription(text);
  const completeSecretLeak = normalizedSecretTerms(allSecrets).some((term) => normalized.includes(term));
  if (secretPolicy === 'complete_words') return completeSecretLeak;
  const ownCharacterLeak = secretLeakTerms([ownSecret]).some((term) => normalized.includes(term));
  return completeSecretLeak || ownCharacterLeak;
}

function normalizedSecretTerms(secrets: readonly string[]): string[] {
  return [...new Set(secrets.map(normalizeDescription).filter(Boolean))];
}

/**
 * 计算两条描述的字符 bigram Dice 相似度，返回 0–1。
 * 它确定、快速、无需额外模型，适合在线门禁近似复述；局限是无法识别字面不同的语义改写。
 */
export function descriptionSimilarity(left: string, right: string): number {
  // 去掉大小写、空白和标点后计算字符 bigram Dice；它擅长抓近似措辞，不等价于语义相似度。
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

