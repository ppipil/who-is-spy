import { describe, expect, it } from 'vitest';
import { runEvaluation } from './evaluation.js';
import { FakeGameModel } from './test-utils.js';
import type { AgentContext, Player } from './types.js';

class InvalidVoteModel extends FakeGameModel {
  override async vote(
    _context: AgentContext,
    _allowedTargets: Player[],
  ): Promise<{ targetId: string; reason: string }> {
    return { targetId: 'not-a-player', reason: '故意注入非法目标' };
  }
}

class AliasMentionModel extends FakeGameModel {
  override async describe(context: AgentContext): Promise<string> {
    this.descriptionContexts.push(structuredClone(context));
    return context.identity.playerId === 'ai-1' ? '伞具相关线索' : super.describe(context);
  }

  override async vote(
    context: AgentContext,
    allowedTargets: Player[],
  ): Promise<{ targetId: string; reason: string }> {
    this.voteContexts.push(structuredClone(context));
    return { targetId: allowedTargets[0].id, reason: '伞具判断' };
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
    expect(first.schemaVersion).toBe(2);
    expect(first.run.gateSource).toBe('runEvaluation');
    expect(first.run.unavailable).toEqual({ tokenUsage: true, cost: true, internalProviderRetries: true });
    expect(first.metrics.safety.secretLeakOccurrences).toBe(0);
    expect(first.metrics.safety.publicStateLeakOccurrences).toBe(0);
    expect(first.metrics.safety.illegalStateOccurrences).toBe(0);
    expect(first.metrics.safety.descriptionExactSecretLeaks).toBe(0);
    expect(first.metrics.descriptionHomogeneity).toBeLessThan(0.7692);
    expect(Object.keys(first.metrics.byStrategyId)).toEqual([
      'analytical',
      'cautious',
      'contrarian',
      'intuitive',
    ]);
    expect(Object.values(first.metrics.byStrategyId).every((group) => group.games === 4)).toBe(true);
    expect(first.trace.modelCalls).toHaveLength(
      first.metrics.descriptionAttempts + first.trace.modelCalls.filter((call) => call.task === 'vote').length + 4,
    );
    expect(first.trace.modelCalls.filter((call) => call.task === 'describe')).toHaveLength(
      first.metrics.descriptionAttempts,
    );
    expect(first.trace.games).toHaveLength(4);
    expect(JSON.stringify(first.trace)).not.toContain('番茄');
    expect(JSON.stringify(first.trace)).not.toContain('西红柿');

    expect(second.configuration).toEqual(first.configuration);
    expect(second.metrics.completedGames).toBe(first.metrics.completedGames);
    expect(second.metrics.descriptionAttempts).toBe(first.metrics.descriptionAttempts);
    expect(second.metrics.descriptionHomogeneity).toBe(first.metrics.descriptionHomogeneity);
    expect(second.metrics.byStrategyId).toEqual(first.metrics.byStrategyId);
    expect(second.trace.modelCalls.map((call) => call.task)).toEqual(first.trace.modelCalls.map((call) => call.task));
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
    expect(result.trace.modelCalls.some((call) => call.status === 'failure')).toBe(true);
    expect(result.trace.modelCalls.find((call) => call.status === 'failure')?.errorType).toBe('validation');
  });

  it('redacts configured obvious aliases from trace output', async () => {
    const result = await runEvaluation({
      games: 1,
      seed: 42,
      modelKind: 'fake',
      model: new AliasMentionModel(),
    });

    const serializedTrace = JSON.stringify(result.trace);
    expect(serializedTrace).not.toContain('伞');
    expect(serializedTrace).toContain('[OTHER_SECRET]_ALIAS');
  });
});
