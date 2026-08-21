import { describe, expect, it } from 'vitest';
import { runEvaluation, type EvaluationProgress } from './evaluation.js';
import type { ModelUsageRecorder } from './model.js';
import { InMemoryTraceSink } from './trace.js';
import { FakeGameModel } from './test-utils.js';
import type { AgentContext, GameReview, GameState, Player } from './types.js';

class InvalidVoteModel extends FakeGameModel {
  override async vote(
    _context: AgentContext,
    _allowedTargets: Player[],
  ): Promise<{ targetId: string; reason: string }> {
    return { targetId: 'not-a-player', reason: '故意注入非法目标' };
  }
}

class UsageRecordingModel extends FakeGameModel {
  private recorder?: ModelUsageRecorder;

  setUsageRecorder(recorder: ModelUsageRecorder): void {
    this.recorder = recorder;
  }

  private record(task: 'describe' | 'vote' | 'review'): void {
    this.recorder?.({ task, providerAttempt: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15, source: 'provider' });
  }

  override async describe(context: AgentContext): Promise<string> {
    this.record('describe');
    return super.describe(context);
  }

  override async vote(
    context: AgentContext,
    allowedTargets: Player[],
  ): Promise<{ targetId: string; reason: string }> {
    this.record('vote');
    return super.vote(context, allowedTargets);
  }

  override async review(game: GameState): Promise<GameReview> {
    this.record('review');
    return super.review(game);
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

  it('reports per-game progress and live token/cost usage when the provider exposes usage', async () => {
    const progress: EvaluationProgress[] = [];
    const model = new UsageRecordingModel();
    const result = await runEvaluation({
      games: 2,
      seed: 3,
      modelKind: 'fake',
      model,
      onProgress: (update) => progress.push(update),
    });

    expect(progress).toEqual([
      { completedGames: 1, totalGames: 2 },
      { completedGames: 2, totalGames: 2 },
    ]);
    expect(result.metrics.tokenUsage.source).toBe('provider');
    expect(result.metrics.tokenUsage.total).toBeGreaterThan(0);
    expect(result.metrics.tokenUsage.averagePerGame.total).toBeGreaterThan(0);
    expect(result.metrics.tokenUsage.byTask.describe.total).toBeGreaterThan(0);
    expect(result.metrics.cost.source).toBe('configured');
    expect(result.metrics.cost.totalCost).toBeGreaterThan(0);
    expect(result.metrics.cost.averageCostPerGame).toBeGreaterThan(0);
  });

  it('associates evaluation run events with the run id in the trace sink', async () => {
    const sink = new InMemoryTraceSink();
    const result = await runEvaluation({
      games: 1,
      seed: 5,
      modelKind: 'fake',
      runId: 'run-trace-test',
      traceSink: sink,
    });

    expect(result.gate.passed).toBe(true);
    expect(sink.events.length).toBeGreaterThanOrEqual(2);
    expect(sink.events.every((event) => 'runId' in event && event.runId === 'run-trace-test')).toBe(true);
    expect(sink.events.every((event) => 'source' in event && event.source === 'evaluation')).toBe(true);
    const eventTypes = sink.events
      .filter((event) => event.eventType === 'public_event')
      .map((event) => (event as { publicEventType: string }).publicEventType);
    expect(eventTypes).toContain('evaluation_game_start');
    expect(eventTypes).toContain('evaluation_game_completed');
    expect(eventTypes).toContain('description');
    expect(eventTypes).toContain('vote_result');
    const descriptions = sink.events.filter(
      (event) => (event as { publicEventType?: string }).publicEventType === 'description',
    );
    expect(descriptions.length).toBeGreaterThan(0);
    expect(
      descriptions.every((event) => ((event as { text?: string }).text ?? '').length > 0),
    ).toBe(true);
  });
});
