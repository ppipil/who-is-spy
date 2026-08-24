import { describe, expect, it } from 'vitest';
import { createUsageAccumulator } from './usage-metrics.js';

describe('evaluation usage metrics', () => {
  it('aggregates provider tokens and official off-peak flash pricing', () => {
    const accumulator = createUsageAccumulator(2, {});
    accumulator.record({
      model: 'deepseek-v4-flash',
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      totalTokens: 2_000_000,
      promptCacheHitTokens: 400_000,
      promptCacheMissTokens: 600_000,
      recordedAt: '2026-08-23T12:00:00.000Z',
    });

    expect(accumulator.tokenUsage).toMatchObject({
      input: 1_000_000,
      output: 1_000_000,
      total: 2_000_000,
      requests: 1,
      source: 'provider',
    });
    expect(accumulator.cost).toMatchObject({
      totalUsd: 0.7948,
      perGameUsd: 0.3974,
      source: 'official',
      tier: 'off-peak',
    });
  });

  it('uses configured pricing and leaves unknown models unpriced by default', () => {
    const configured = createUsageAccumulator(1, {
      DEEPSEEK_INPUT_CACHE_HIT_USD_PER_MILLION: '1',
      DEEPSEEK_INPUT_CACHE_MISS_USD_PER_MILLION: '2',
      DEEPSEEK_OUTPUT_USD_PER_MILLION: '3',
    });
    configured.record(usage('private-model'));
    expect(configured.cost).toMatchObject({ totalUsd: 0.006, perGameUsd: 0.006, source: 'environment', tier: 'configured' });

    const unknown = createUsageAccumulator(1, {});
    unknown.record(usage('private-model'));
    expect(unknown.tokenUsage.source).toBe('provider');
    expect(unknown.cost).toMatchObject({ totalUsd: null, perGameUsd: null, source: 'unavailable' });
  });
});

function usage(model: string) {
  return {
    model,
    promptTokens: 2_000,
    completionTokens: 1_000,
    totalTokens: 3_000,
    promptCacheHitTokens: 1_000,
    promptCacheMissTokens: 1_000,
    recordedAt: '2026-08-23T12:00:00.000Z',
  };
}
