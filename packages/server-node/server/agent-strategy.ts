import type { AgentStrategyId, Role } from './types.js';

export interface StrategyInput {
  role: Role;
  round: number;
  publicDescriptionCount: number;
  sameRoundPublicDescriptions?: Array<{ playerId: string; text: string }>;
}

export interface QualityPolicy {
  maxDescriptionAttempts: number;
  duplicateSimilarityThreshold: number;
}

export interface AgentStrategy {
  id: AgentStrategyId;
  displayName: string;
  buildDescriptionGuidance(input: StrategyInput): string;
  buildVoteGuidance(input: StrategyInput): string;
  qualityPolicy: QualityPolicy;
}

const STRATEGIES: Record<AgentStrategyId, AgentStrategy> = {
  cautious: {
    id: 'cautious',
    displayName: '谨慎观察',
    buildDescriptionGuidance: ({ role, round, sameRoundPublicDescriptions }) => {
      const sameCount = sameRoundPublicDescriptions?.length ?? 0;
      return role === 'undercover'
        ? `你是卧底：先读本轮${sameCount}条公开描述推断多数词的宽泛语义范围，只给一个既适用于自己词、也大概率适用于多数词的 shared-safe 线索；自然融入，不要暴露自己词的独特特征，不编造无依据信息。`
        : `第${round}轮作为平民只给一个低暴露、宽类别的共同属性（weak clue）；不做定义式描述，不组合多个高辨识特征；本轮已有${sameCount}条公开描述，出现过的核心语义不要再补充，换角度也不能给出更具体的新证据；你的话卧底也看得到，要帮队友缩小范围，但不能让卧底反推多数词。`;
    },
    buildVoteGuidance: ({ publicDescriptionCount }) =>
      `先列证据再下结论；若${publicDescriptionCount}条公开描述仍不足，降低对单一措辞的确信度。`,
    qualityPolicy: { maxDescriptionAttempts: 2, duplicateSimilarityThreshold: 0.72 },
  },
  intuitive: {
    id: 'intuitive',
    displayName: '直觉联想',
    buildDescriptionGuidance: ({ role, round, sameRoundPublicDescriptions }) => {
      const sameCount = sameRoundPublicDescriptions?.length ?? 0;
      return role === 'undercover'
        ? `你是卧底：先感受本轮${sameCount}条公开描述共同指向的语义氛围，挑一个自己词与多数词都可能成立的感官类 shared-safe 线索；自然融入，不暴露自己词的独特特征，不编造。`
        : `第${round}轮作为平民用一个感官/氛围/生活瞬间的弱线索，不做定义、不组合高辨识特征；本轮已有${sameCount}条公开描述，已出现的核心语义不再补充；具体程度以帮队友判断、不给卧底反推多数词为限。`;
    },
    buildVoteGuidance: () =>
      '关注表达是否自然连贯、是否像临时绕开陌生概念；以语言直觉为主，但必须引用公开措辞。',
    qualityPolicy: { maxDescriptionAttempts: 2, duplicateSimilarityThreshold: 0.72 },
  },
  analytical: {
    id: 'analytical',
    displayName: '结构分析',
    buildDescriptionGuidance: ({ role, round, sameRoundPublicDescriptions }) => {
      const sameCount = sameRoundPublicDescriptions?.length ?? 0;
      return role === 'undercover'
        ? `你是卧底：先按本轮${sameCount}条公开描述归纳多数词的可能类别，选一个自己词与多数词都成立的类别级 shared-safe 线索；不要给出只属于自己词的精确维度，不编造。`
        : `第${round}轮作为平民只从一个用途/类别/边界维度给弱线索，不做定义式对比、不叠加维度；本轮已有${sameCount}条公开描述，出现过的维度不再补充；避免让卧底据此反推多数词。`;
    },
    buildVoteGuidance: () =>
      '逐项比较类别、用途和限制条件的矛盾，优先选择与多数公开特征不兼容的目标。',
    qualityPolicy: { maxDescriptionAttempts: 2, duplicateSimilarityThreshold: 0.72 },
  },
  contrarian: {
    id: 'contrarian',
    displayName: '逆向审视',
    buildDescriptionGuidance: ({ role, round, sameRoundPublicDescriptions }) => {
      const sameCount = sameRoundPublicDescriptions?.length ?? 0;
      return role === 'undercover'
        ? `你是卧底：观察多数人避开或强调的角度，找一个既符合自己词、也不与多数语义冲突的冷门但安全的角度；自然融入，不暴露独特特征，不编造。`
        : `第${round}轮作为平民避开已有${sameCount}条描述的主流角度，但只换一个同样模糊的角度，不能因此提供更具体的新证据；帮助队友判断，不给卧底反推多数词的依据。`;
    },
    buildVoteGuidance: () =>
      '主动检查跟票偏差，寻找刻意迎合共识或异常安全的表达；没有公开证据时不要为了反对而反对。',
    qualityPolicy: { maxDescriptionAttempts: 3, duplicateSimilarityThreshold: 0.72 },
  },
};

export function getAgentStrategy(id: AgentStrategyId): AgentStrategy {
  return STRATEGIES[id];
}

export function listAgentStrategies(): AgentStrategy[] {
  return Object.values(STRATEGIES);
}
