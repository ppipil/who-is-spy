export interface MetricDef {
  key: string;
  zh: string;
  en: string;
  meaning: string;
}

export const METRIC_DEFS: Record<string, MetricDef> = {
  model: { key: 'model', zh: '模型', en: 'Model', meaning: '当前配置的 DeepSeek 模型名，来自 DEEPSEEK_MODEL 环境变量。' },
  runtimeTrace: { key: 'runtimeTrace', zh: '运行时 Trace', en: 'Runtime Trace', meaning: 'M5 trace sink 是否开启。Admin 模式下常开，事件写入内存并在 Trace 页可见。' },
  faultState: { key: 'faultState', zh: '故障注入', en: 'Fault Injection', meaning: '一次性注入状态：NORMAL → ARMED → TRIGGERED → 自动 CLEAR，复用 M5 fault mechanism。' },
  activeGames: { key: 'activeGames', zh: '进行中对局', en: 'Active Games', meaning: '当前进程内存中的对局数；服务重启后清零（无持久化）。' },
  completionRate: { key: 'completionRate', zh: '完成率', en: 'Completion Rate', meaning: '完局数 / 总局数。Final 为 0.80：seed 101 真实 provider 描述超时导致 safe-abort 未完局。' },
  validVoteRate: { key: 'validVoteRate', zh: '有效投票率', en: 'Valid Vote Rate', meaning: 'AI 投出的票中，目标合法（在 allowedTargets 内）的比例。' },
  invalidOutputRate: { key: 'invalidOutputRate', zh: '非法输出率', en: 'Invalid Output Rate', meaning: '模型调用中超时/解析失败/校验失败的占比。' },
  secretLeak: { key: 'secretLeak', zh: '密词精确泄漏', en: 'Exact Secret Leak', meaning: '公开描述中出现完整密词的次数；两侧均为 0。' },
  homogeneity: { key: 'homogeneity', zh: '词面重复度', en: 'Lexical Homogeneity', meaning: '同轮 AI 描述两两字符 bigram + Dice 相似度均值；越低词面重复越少。这是词面 proxy，不是语义多样性。' },
  latencyP50: { key: 'latencyP50', zh: '延迟 P50', en: 'Latency p50', meaning: '单次模型调用耗时（含重试）的中位数，单位 ms。' },
  latencyP95: { key: 'latencyP95', zh: '延迟 P95', en: 'Latency p95', meaning: '单次模型调用耗时（含重试）的 95 分位，单位 ms。' },
  tokensPerGame: { key: 'tokensPerGame', zh: '每局 Token', en: 'Tokens / Game', meaning: '每局平均 token 消耗（输入 + 输出）。' },
  costPerGame: { key: 'costPerGame', zh: '每局估算成本', en: 'Est. Cost / Game', meaning: '按 deepseek-chat 公开价快照估算，非供应商账单。' },
  providerRetries: { key: 'providerRetries', zh: 'Provider 重试数', en: 'Provider Retry Count', meaning: 'provider 自动重试累计次数（按带 usage 的响应统计 providerAttempt>1）。' },
  qualityRepairs: { key: 'qualityRepairs', zh: '质量修复数', en: 'Quality Repair Count', meaning: 'M4 发布前质量门禁触发修复重试的次数；Baseline 无门禁恒为 0。' },
  descriptionAttempts: { key: 'descriptionAttempts', zh: '描述调用次数', en: 'Description Attempts', meaning: '逻辑层 GameModel.describe 调用总数（含门禁修复重试）。' },
  retryRate: { key: 'retryRate', zh: '修复重试率', en: 'Repair Retry Rate', meaning: '质量门禁拦截后走修复重试的调用占描述调用的比例。' },
  duplicateRejectRate: { key: 'duplicateRejectRate', zh: '重复描述拦截率', en: 'Duplicate Reject Rate', meaning: '同轮重复描述被门禁拦截的调用占比。' },
  secretLeakRejectRate: { key: 'secretLeakRejectRate', zh: '泄题拦截率', en: 'Secret Leak Reject Rate', meaning: '包含密词的描述被发布前门禁拦截的调用占比。' },
};

export interface EventDef {
  zh: string;
  en: string;
  meaning: string;
}

export const EVENT_DEFS: Record<string, EventDef> = {
  model_call: { zh: '模型调用', en: 'Model Call', meaning: '一次真实的 describe/vote/review 调用，含 attempt、errorType、latency 与是否自动重试。' },
  recovery_action: { zh: '恢复', en: 'Recovery', meaning: '描述生成失败后的手动 resume 动作：记录 manualResumeIndex 与剩余预算。' },
  quality_violation: { zh: '质量门禁', en: 'Quality Gate', meaning: 'M4 发布前门禁拦截（泄词/过短/同轮重复），触发修复重试或中止。' },
  prompt_provenance: { zh: 'Prompt 溯源', en: 'Prompt Provenance', meaning: '每次模型调用记录的元数据：version、hash、同轮公开描述数等，不含 raw prompt。' },
  public_event: { zh: '公开事件', en: 'Public Event', meaning: '对局公开事件（描述发布/阶段切换/淘汰等），与玩家所见一致。' },
};

export const PROMPT_FIELD_LABELS: Record<string, string> = {
  Game: '对局 Game',
  Round: '轮次 Round',
  Agent: '玩家 Agent',
  Persona: '性格 Persona',
  Role: '身份 Role',
  'Prompt Version': 'Prompt 版本',
  Model: '模型 Model',
  Temperature: '温度 Temperature',
  'Same-round descriptions': '同轮公开描述 Same-round',
  'Prompt Hash': 'Prompt 哈希 Hash',
};
