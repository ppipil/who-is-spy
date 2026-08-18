import type { AgentStrategyId, Role } from './types.js';

export interface StrategyInput {
  role: Role;
  round: number;
  publicDescriptionCount: number;
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
    buildDescriptionGuidance: ({ round }) =>
      `第${round}轮优先选择低暴露、宽类别的共同属性；保留一个可解释的细节，不追求抢眼。`,
    buildVoteGuidance: ({ publicDescriptionCount }) =>
      `先列证据再下结论；若${publicDescriptionCount}条公开描述仍不足，降低对单一措辞的确信度。`,
    qualityPolicy: { maxDescriptionAttempts: 2, duplicateSimilarityThreshold: 0.76 },
  },
  intuitive: {
    id: 'intuitive',
    displayName: '直觉联想',
    buildDescriptionGuidance: ({ round }) =>
      `第${round}轮用感官、氛围或生活瞬间形成自然联想；避免抽象定义和机械分类。`,
    buildVoteGuidance: () =>
      '关注表达是否自然连贯、是否像临时绕开陌生概念；以语言直觉为主，但必须引用公开措辞。',
    qualityPolicy: { maxDescriptionAttempts: 2, duplicateSimilarityThreshold: 0.72 },
  },
  analytical: {
    id: 'analytical',
    displayName: '结构分析',
    buildDescriptionGuidance: ({ role }) =>
      `从用途、类别或边界条件挑一个维度做对比；作为${role === 'undercover' ? '卧底' : '平民'}仍不得明示身份或答案。`,
    buildVoteGuidance: () =>
      '逐项比较类别、用途和限制条件的矛盾，优先选择与多数公开特征不兼容的目标。',
    qualityPolicy: { maxDescriptionAttempts: 2, duplicateSimilarityThreshold: 0.78 },
  },
  contrarian: {
    id: 'contrarian',
    displayName: '逆向审视',
    buildDescriptionGuidance: ({ publicDescriptionCount }) =>
      `避免复述已有${publicDescriptionCount}条描述的主流角度；寻找成立但不显眼的反例、场景或限制。`,
    buildVoteGuidance: () =>
      '主动检查跟票偏差，寻找刻意迎合共识或异常安全的表达；没有公开证据时不要为了反对而反对。',
    qualityPolicy: { maxDescriptionAttempts: 3, duplicateSimilarityThreshold: 0.68 },
  },
};

export function getAgentStrategy(id: AgentStrategyId): AgentStrategy {
  return STRATEGIES[id];
}

export function listAgentStrategies(): AgentStrategy[] {
  return Object.values(STRATEGIES);
}

