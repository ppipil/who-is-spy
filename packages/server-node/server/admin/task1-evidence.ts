// Task ① 验收证据数据（Evidence Aggregator 的数据源，不新增第二套系统）
//
// B: persona-probe 真实结果（2026-08-20 10:21 +08 · deepseek-chat 真实调用）
// C: description-quality.test.ts 确定性 Quality Gate 用例（真实引擎 + 门禁代码路径）

export interface PersonaProbeCase {
  personaId: 'cautious' | 'intuitive' | 'analytical' | 'contrarian';
  personaName: string;
  agentName: string;
  risk: string;
  description: string;
  voteTarget: string;
  reason: string;
  strategyFocus: string;
}

export interface PersonaProbeEvidence {
  generatedAt: string;
  command: string;
  model: string;
  scenario: string;
  cases: PersonaProbeCase[];
}

// Persona 展示元数据（agentName/risk/focus 为验收演示口径，risk 为展示档位非引擎字段）
export const PERSONA_META: Record<
  PersonaProbeCase['personaId'],
  { agentName: string; risk: string; strategyFocus: string }
> = {
  cautious: { agentName: '阿序', risk: 'LOW', strategyFocus: '观察 / 低风险' },
  intuitive: { agentName: '弥生', risk: 'MEDIUM_LOW', strategyFocus: '场景 / 语言感觉' },
  analytical: { agentName: '老墨', risk: 'MEDIUM_HIGH', strategyFocus: '关系 / 逻辑一致性' },
  contrarian: { agentName: '小满', risk: 'HIGH', strategyFocus: '反例 / 反共识' },
};

export const PERSONA_PROBE_EVIDENCE: PersonaProbeEvidence = {
  generatedAt: '2026-08-20T10:21:41+08:00',
  command: 'npm run persona-probe',
  model: 'deepseek-chat（真实 DeepSeek 调用）',
  scenario: '同一固定局面：Round 2 · undercover · word=高铁 · 相同 3 条同轮公开描述 · 仅切换 persona',
  cases: [
    {
      personaId: 'cautious',
      personaName: '谨慎观察',
      agentName: PERSONA_META.cautious.agentName,
      risk: PERSONA_META.cautious.risk,
      description: '它往往在固定的站点停靠。',
      voteTarget: 'ai-2',
      reason: '弥生发言较模糊，未明确指向特定交通方式，显可疑。',
      strategyFocus: PERSONA_META.cautious.strategyFocus,
    },
    {
      personaId: 'intuitive',
      personaName: '直觉敏锐',
      agentName: PERSONA_META.intuitive.agentName,
      risk: PERSONA_META.intuitive.risk,
      description: '有时候能让人很快到达另一个城市。',
      voteTarget: 'ai-1',
      reason: '描述模糊且回避具体特征，感觉像在掩饰。',
      strategyFocus: PERSONA_META.intuitive.strategyFocus,
    },
    {
      personaId: 'analytical',
      personaName: '逻辑派',
      agentName: PERSONA_META.analytical.agentName,
      risk: PERSONA_META.analytical.risk,
      description: '从这个角度看，它连接了不同的地方。',
      voteTarget: 'ai-1',
      reason: '阿序的描述更贴近地铁等固定站点，而高铁站台不固定，逻辑不符。',
      strategyFocus: PERSONA_META.analytical.strategyFocus,
    },
    {
      personaId: 'contrarian',
      personaName: '出其不意',
      agentName: PERSONA_META.contrarian.agentName,
      risk: PERSONA_META.contrarian.risk,
      description: '但有时候也会因为各种原因晚点。',
      voteTarget: 'ai-1',
      reason: '描述偏向固定站点等待，与高铁特征有偏差，更像公交或地铁。',
      strategyFocus: PERSONA_META.contrarian.strategyFocus,
    },
  ],
};

export interface QualityGateAttempt {
  attempt: number;
  candidate: string;
  gate: 'REJECTED' | 'PASSED';
  reason?: string;
  similarity?: number;
  threshold?: number;
  willRetry: boolean;
}

export interface QualityGateEvidence {
  source: string;
  sourceNote: string;
  agent: string;
  round: number;
  attempts: QualityGateAttempt[];
  committed: string;
  gameStateProof: string;
}

export const QUALITY_GATE_EVIDENCE: QualityGateEvidence = {
  source: 'packages/server-node/server/description-quality.test.ts',
  sourceNote:
    '确定性 Quality Gate 回归用例（真实 GameEngine + 门禁代码路径；注入脚本化候选输出用于证明门禁行为，非产品环境伪造数据）',
  agent: 'ai-2',
  round: 1,
  attempts: [
    {
      attempt: 1,
      candidate: '一种不太张扬但很常见的体验',
      gate: 'REJECTED',
      reason: 'LEXICAL_DUPLICATE',
      similarity: 1,
      threshold: 0.72,
      willRetry: true,
    },
    {
      attempt: 2,
      candidate: '它常在特定场合形成明显氛围',
      gate: 'PASSED',
      willRetry: false,
    },
  ],
  committed: '它常在特定场合形成明显氛围',
  gameStateProof:
    'GameState 中 ai-2 的描述为修复后的文本（attempt #2）；被拒候选（attempt #1）未进入 descriptions/events；同轮后续 ai-3 收到的 publicDescriptions 中 ai-2 为修复后文本。',
};
