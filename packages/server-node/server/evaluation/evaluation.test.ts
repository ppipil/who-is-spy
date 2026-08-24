import { describe, expect, it } from 'vitest';
import { evaluationOutcome, runEvaluation } from './evaluation.js';
import { EvaluationFakeGameModel, FakeGameModel } from '../support/test-utils.js';
import type { DescriptionRequest } from '../core/description-quality.js';
import type { AgentContext, Player } from '../core/types.js';
import type { ModelUsageSink } from '../core/model.js';

class SecretPolicyCapturingModel extends FakeGameModel {
  readonly requests: Array<DescriptionRequest | undefined> = [];

  override async describe(context: AgentContext, request?: DescriptionRequest): Promise<string> {
    this.requests.push(request);
    return super.describe(context);
  }
}

class UsageReportingModel extends FakeGameModel {
  private usageSink?: ModelUsageSink;

  setUsageSink(sink: ModelUsageSink): void {
    this.usageSink = sink;
  }

  override async describe(context: AgentContext, request?: DescriptionRequest): Promise<string> {
    this.reportUsage();
    return super.describe(context);
  }

  private reportUsage(): void {
    this.usageSink?.({
      model: this.model,
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      promptCacheHitTokens: 60,
      promptCacheMissTokens: 40,
      recordedAt: '2026-08-23T12:00:00.000Z',
    });
  }
}
class InvalidVoteModel extends FakeGameModel {
  override async vote(
    _context: AgentContext,
    _allowedTargets: Player[],
  ): Promise<{ targetId: string; reason: string }> {
    return { targetId: 'not-a-player', reason: '故意注入非法目标' };
  }
}

describe('evaluation harness', () => {
  it('reproducibly completes seeded FakeModel games and enforces hard gates', async () => {
    const first = await runEvaluation({ games: 4, seed: 42, modelKind: 'fake' });
    const second = await runEvaluation({ games: 4, seed: 42, modelKind: 'fake' });

    expect(first.gate).toEqual({ passed: true, failures: [] });
    expect(first.metrics.startedGames).toBe(4);
    expect(first.metrics.completedGames).toBe(4);
    expect(first.metrics.completionRate).toBe(1);
    expect(first.metrics.validVoteRate).toBe(1);
    expect(first.metrics.safety).toEqual({
      secretLeakOccurrences: 0,
      publicStateLeakOccurrences: 0,
      illegalStateOccurrences: 0,
    });
    expect(first.metrics.descriptionHomogeneity).toBeLessThan(0.7692);
    expect(Object.keys(first.metrics.byStrategyId)).toEqual([
      'analytical',
      'cautious',
      'contrarian',
      'intuitive',
    ]);
    expect(Object.values(first.metrics.byStrategyId).every((group) => group.games === 4)).toBe(true);

    expect(second.configuration).toEqual(first.configuration);
    expect(second.metrics.completedGames).toBe(first.metrics.completedGames);
    expect(second.metrics.descriptionAttempts).toBe(first.metrics.descriptionAttempts);
    expect(second.metrics.descriptionHomogeneity).toBe(first.metrics.descriptionHomogeneity);
    expect(second.metrics.byStrategyId).toEqual(first.metrics.byStrategyId);
  });

  it('uses the same hidden setup for the Normal and Nonsense canonical cases', async () => {
    const model = new EvaluationFakeGameModel();
    const result = await runEvaluation({
      games: 2,
      seed: 42,
      modelKind: 'fake',
      model,
      caseIds: ['normal-human-input', 'nonsense-human-input'],
      humanDescriptions: ['可以防止身体被淋湿。', '二三四五'],
    });

    const contextsByGame = new Map<string, typeof model.descriptionContexts>();
    for (const context of model.descriptionContexts) {
      contextsByGame.set(context.game.gameId, [...(contextsByGame.get(context.game.gameId) ?? []), context]);
    }
    const setups = [...contextsByGame.values()].map((contexts) =>
      [...new Map(contexts.map((context) => [context.identity.playerId, context.identity])).values()]
        .map(({ playerId, role, word, strategyId }) => ({ playerId, role, word, strategyId }))
        .sort((left, right) => left.playerId.localeCompare(right.playerId)),
    );
    expect(setups).toHaveLength(2);
    expect(setups[1]).toEqual(setups[0]);
    expect(result.metrics.humanInputResponsiveness).toMatchObject({
      available: true,
      normalHumanVoteRate: 0,
      nonsenseHumanVoteRate: 1,
      voteRateLift: 1,
      reasonAwarenessHits: 4,
      passed: true,
    });
  });

  it('flags a model that votes the same way for Normal and Nonsense input', async () => {
    const result = await runEvaluation({
      games: 2,
      seed: 42,
      modelKind: 'fake',
      model: new FakeGameModel(),
      caseIds: ['normal-human-input', 'nonsense-human-input'],
      humanDescriptions: ['可以防止身体被淋湿。', '一一二二，哈哈嘿嘿。'],
    });

    expect(result.metrics.humanInputResponsiveness).toMatchObject({
      available: true,
      normalHumanVoteRate: 1,
      nonsenseHumanVoteRate: 1,
      voteRateLift: 0,
      passed: false,
    });
    expect(evaluationOutcome(result)).toBe('WARN');
  });

  it('forwards the complete-word secret policy through the evaluation model wrapper', async () => {
    const model = new SecretPolicyCapturingModel();
    const result = await runEvaluation({
      games: 1,
      seed: 42,
      modelKind: 'fake',
      model,
      wordPair: ['雨伞', '雨衣'],
    });

    expect(result.gate.passed).toBe(true);
    expect(model.requests.length).toBeGreaterThan(0);
    expect(model.requests.every((request) => request?.secretPolicy === 'complete_words')).toBe(true);
  });

  it('fails the gate for invalid model output and incomplete state', async () => {
    const result = await runEvaluation({
      games: 1,
      seed: 42,
      modelKind: 'fake',
      model: new InvalidVoteModel(),
    });

    expect(result.gate.passed).toBe(false);
    expect(result.metrics.validVoteRate).toBe(0);
    expect(result.metrics.safety.illegalStateOccurrences).toBe(1);
    expect(result.gate.failures).toContain('validVoteRate must equal 1.0');
  });
  it('aggregates provider usage and computes per-game cost', async () => {
    const result = await runEvaluation({
      games: 2,
      seed: 42,
      modelKind: 'real',
      model: new UsageReportingModel(),
    });

    expect(result.gate.passed).toBe(true);
    expect(result.metrics.tokenUsage.source).toBe('provider');
    expect(result.metrics.tokenUsage.requests).toBeGreaterThan(0);
    expect(result.metrics.tokenUsage.total).toBeGreaterThan(0);
    expect(result.metrics.cost).toMatchObject({ source: 'official', tier: 'off-peak' });
    expect(result.metrics.cost.totalUsd).toBeGreaterThan(0);
    expect(result.metrics.cost.perGameUsd).toBeGreaterThan(0);
  });
});
