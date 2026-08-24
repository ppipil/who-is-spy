import type { ModelUsage } from '../core/model.js';

export type UsageSource = 'provider' | 'unavailable';
export type PricingSource = 'official' | 'environment' | 'unavailable';

export interface TokenUsageMetrics {
  input: number | null;
  output: number | null;
  total: number | null;
  cacheHitInput: number | null;
  cacheMissInput: number | null;
  requests: number;
  source: UsageSource;
}

export interface CostMetrics {
  totalUsd: number | null;
  perGameUsd: number | null;
  currency: 'USD';
  source: PricingSource;
  model?: string;
  tier?: 'peak' | 'off-peak' | 'configured';
}

export interface UsageAccumulator {
  tokenUsage: TokenUsageMetrics;
  cost: CostMetrics;
  record(usage: ModelUsage): void;
}

interface Pricing {
  cacheHitInputUsdPerMillion: number;
  cacheMissInputUsdPerMillion: number;
  outputUsdPerMillion: number;
  source: Exclude<PricingSource, 'unavailable'>;
  tier: 'peak' | 'off-peak' | 'configured';
}

/**
 * 创建一次评测运行的 token/成本累加器。
 * 每个成功 HTTP 响应的 provider usage 都会累加；只有所有请求都能匹配价目表时才给出成本，否则保留 token 并把 cost 标为 unavailable。
 */
export function createUsageAccumulator(games: number, environment: NodeJS.ProcessEnv = process.env): UsageAccumulator {
  const tokenUsage: TokenUsageMetrics = {
    input: null,
    output: null,
    total: null,
    cacheHitInput: null,
    cacheMissInput: null,
    requests: 0,
    source: 'unavailable',
  };
  const cost: CostMetrics = { totalUsd: null, perGameUsd: null, currency: 'USD', source: 'unavailable' };
  let accumulatedCost = 0;
  let allRequestsPriced = true;

  return {
    tokenUsage,
    cost,
    record(usage) {
      tokenUsage.input = (tokenUsage.input ?? 0) + usage.promptTokens;
      tokenUsage.output = (tokenUsage.output ?? 0) + usage.completionTokens;
      tokenUsage.total = (tokenUsage.total ?? 0) + usage.totalTokens;
      tokenUsage.cacheHitInput = (tokenUsage.cacheHitInput ?? 0) + usage.promptCacheHitTokens;
      tokenUsage.cacheMissInput = (tokenUsage.cacheMissInput ?? 0) + usage.promptCacheMissTokens;
      tokenUsage.requests += 1;
      tokenUsage.source = 'provider';

      const pricing = resolvePricing(usage.model, new Date(usage.recordedAt), environment);
      if (!pricing) allRequestsPriced = false;
      else accumulatedCost += requestCost(usage, pricing);
      updateCost(cost, usage.model, pricing, accumulatedCost, allRequestsPriced, games);
    },
  };
}

function updateCost(cost: CostMetrics, model: string, pricing: Pricing | null, total: number, allPriced: boolean, games: number): void {
  cost.model = cost.model && cost.model !== model ? 'mixed' : model;
  if (!pricing || !allPriced) {
    cost.totalUsd = null;
    cost.perGameUsd = null;
    cost.source = 'unavailable';
    delete cost.tier;
    return;
  }
  cost.totalUsd = roundUsd(total);
  cost.perGameUsd = roundUsd(total / games);
  cost.source = pricing.source;
  cost.tier = pricing.tier;
}

function requestCost(usage: ModelUsage, pricing: Pricing): number {
  // 成本按 provider 返回的缓存命中输入、缓存未命中输入、输出 token 分别计价后求和。
  return (
    usage.promptCacheHitTokens * pricing.cacheHitInputUsdPerMillion
    + usage.promptCacheMissTokens * pricing.cacheMissInputUsdPerMillion
    + usage.completionTokens * pricing.outputUsdPerMillion
  ) / 1_000_000;
}

/**
 * 解析单次请求的价格来源：环境变量完整配置优先，否则按官方模型族和 UTC 峰/谷时段匹配。
 * 未知私有别名返回 null，避免用错误价目伪造成本精度。
 */
function resolvePricing(model: string, at: Date, environment: NodeJS.ProcessEnv): Pricing | null {
  const configured = configuredPricing(environment);
  if (configured) return configured;
  const tier = isPeak(at) ? 'peak' : 'off-peak';
  const normalized = model.toLowerCase();
  if (normalized.startsWith('deepseek-v4-pro')) {
    return tier === 'peak'
      ? officialPricing(0.044, 1.32, 3.96, tier)
      : officialPricing(0.022, 0.66, 1.98, tier);
  }
  if (normalized.startsWith('deepseek-v4-flash')) {
    return tier === 'peak'
      ? officialPricing(0.014, 0.44, 1.32, tier)
      : officialPricing(0.007, 0.22, 0.66, tier);
  }
  return null;
}

function configuredPricing(environment: NodeJS.ProcessEnv): Pricing | null {
  const hit = nonNegativeNumber(environment.DEEPSEEK_INPUT_CACHE_HIT_USD_PER_MILLION);
  const miss = nonNegativeNumber(environment.DEEPSEEK_INPUT_CACHE_MISS_USD_PER_MILLION);
  const output = nonNegativeNumber(environment.DEEPSEEK_OUTPUT_USD_PER_MILLION);
  if (hit === null || miss === null || output === null) return null;
  return {
    cacheHitInputUsdPerMillion: hit,
    cacheMissInputUsdPerMillion: miss,
    outputUsdPerMillion: output,
    source: 'environment',
    tier: 'configured',
  };
}

function officialPricing(hit: number, miss: number, output: number, tier: 'peak' | 'off-peak'): Pricing {
  return {
    cacheHitInputUsdPerMillion: hit,
    cacheMissInputUsdPerMillion: miss,
    outputUsdPerMillion: output,
    source: 'official',
    tier,
  };
}

/** 按 provider 的 UTC 工作日时间窗判断峰值计价；使用 UTC 避免部署机器时区改变成本结果。 */
function isPeak(at: Date): boolean {
  const day = at.getUTCDay();
  const hour = at.getUTCHours();
  return day >= 1 && day <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
}

function nonNegativeNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function roundUsd(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000;
}
