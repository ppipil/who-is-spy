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
});
