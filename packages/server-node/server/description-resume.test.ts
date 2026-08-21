import { describe, expect, it } from 'vitest';
import { GameEngine } from './game-engine.js';
import { ModelError } from './model.js';
import { InMemoryTraceSink } from './trace.js';
import { FakeGameModel } from './test-utils.js';
import type { AgentContext } from './types.js';

class ResumeTestModel extends FakeGameModel {
  failAgent: string | null = null;
  private readonly describeCallsByAgent = new Map<string, number>();
  private gatePromise: Promise<void> | null = null;
  private releaseGate: (() => void) | null = null;

  override async describe(context: AgentContext): Promise<string> {
    this.describeCallsByAgent.set(
      context.identity.playerId,
      (this.describeCallsByAgent.get(context.identity.playerId) ?? 0) + 1,
    );
    if (this.failAgent === context.identity.playerId) {
      throw new ModelError('AI 描述失败：请求超时', undefined, {
        errorType: 'timeout',
        retryable: true,
        attempt: 2,
      });
    }
    if (this.gatePromise) await this.gatePromise;
    return super.describe(context);
  }

  describeCalls(agentId: string): number {
    return this.describeCallsByAgent.get(agentId) ?? 0;
  }

  installGate(): () => void {
    this.gatePromise = new Promise<void>((resolve) => {
      this.releaseGate = resolve;
    });
    return () => this.releaseGate?.();
  }
}

describe('description resume', () => {
  it('continues from the failed agent without re-running successful agents and enters voting', async () => {
    const trace = new InMemoryTraceSink();
    const model = new ResumeTestModel();
    model.failAgent = 'ai-3';
    const engine = new GameEngine(model, fixedRandom, undefined, trace);
    const created = engine.createGame();

    await expect(engine.submitHumanDescription(created.id, '经常出现在普通生活里')).rejects.toThrow();
    expect(roundDescriptionIds(engine, created.id)).toEqual(['human', 'ai-1', 'ai-2']);
    expect(model.describeCalls('ai-3')).toBe(1);
    expect(model.describeCalls('ai-4')).toBe(0);
    expect(engine.getGame(created.id).descriptionResume).toEqual({
      missingAgentId: 'ai-3',
      manualResumeIndex: 0,
      manualRetriesRemaining: 2,
    });

    model.failAgent = null;
    const resumed = await engine.resumeDescription(created.id);

    expect(resumed.phase).toBe('voting');
    expect(roundDescriptionIds(engine, created.id)).toEqual(['human', 'ai-1', 'ai-2', 'ai-3', 'ai-4']);
    expect(model.describeCalls('ai-1')).toBe(1);
    expect(model.describeCalls('ai-2')).toBe(1);
    expect(model.describeCalls('ai-3')).toBe(2);
    expect(model.describeCalls('ai-4')).toBe(1);
    const describedPlayerIds = resumed.descriptions
      .filter((description) => description.round === 1)
      .map((description) => description.playerId);
    expect(new Set(describedPlayerIds).size).toBe(describedPlayerIds.length);
    expect(engine.getGame(created.id).descriptionResume).toBeUndefined();

    const recoveryEvents = trace.events.filter((event) => event.eventType === 'recovery_action');
    expect(recoveryEvents).toHaveLength(2);
    expect(recoveryEvents[0]).toMatchObject({
      recoveryAction: 'description_resume',
      agentId: 'ai-3',
      manualResumeIndex: 1,
      manualRetriesRemaining: 2,
    });
    expect(recoveryEvents[0].recoveryOutcome).toBeUndefined();
    expect(recoveryEvents[1]).toMatchObject({
      recoveryAction: 'description_resume',
      agentId: 'ai-3',
      recoveryOutcome: 'recovered',
    });
  });

  it('exhausts the manual resume budget without half state and blocks further resume', async () => {
    const trace = new InMemoryTraceSink();
    const model = new ResumeTestModel();
    model.failAgent = 'ai-3';
    const engine = new GameEngine(model, fixedRandom, undefined, trace);
    const created = engine.createGame();

    await expect(engine.submitHumanDescription(created.id, '经常出现在普通生活里')).rejects.toThrow();
    await expect(engine.resumeDescription(created.id)).rejects.toThrow();
    expect(engine.getGame(created.id).descriptionResume).toMatchObject({
      missingAgentId: 'ai-3',
      manualResumeIndex: 1,
      manualRetriesRemaining: 1,
    });
    await expect(engine.resumeDescription(created.id)).rejects.toThrow();
    expect(engine.getGame(created.id).descriptionResume).toMatchObject({
      missingAgentId: 'ai-3',
      manualResumeIndex: 2,
      manualRetriesRemaining: 0,
    });
    await expect(engine.resumeDescription(created.id)).rejects.toMatchObject({ status: 400 });

    const state = engine.getGame(created.id);
    expect(state.phase).toBe('describing');
    expect(roundDescriptionIds(engine, created.id)).toEqual(['human', 'ai-1', 'ai-2']);
    expect(model.describeCalls('ai-3')).toBe(3);
    expect(model.describeCalls('ai-4')).toBe(0);

    const exhausted = trace.events.filter(
      (event) => event.eventType === 'recovery_action' && event.recoveryOutcome === 'exhausted',
    );
    expect(exhausted).toHaveLength(2);
    expect(exhausted[1]).toMatchObject({ manualResumeIndex: 2, manualRetriesRemaining: 0 });
  });

  it('allows only one active resume request per game generation', async () => {
    const model = new ResumeTestModel();
    model.failAgent = 'ai-3';
    const engine = new GameEngine(model, fixedRandom);
    const created = engine.createGame();
    await expect(engine.submitHumanDescription(created.id, '经常出现在普通生活里')).rejects.toThrow();

    model.failAgent = null;
    const release = model.installGate();
    const firstResume = engine.resumeDescription(created.id);
    await waitFor(() => model.describeCalls('ai-3') === 2);
    await expect(engine.resumeDescription(created.id)).rejects.toMatchObject({ status: 409 });
    release();
    const resumed = await firstResume;
    expect(resumed.phase).toBe('voting');
    expect(model.describeCalls('ai-4')).toBe(1);
  });

  it('rejects resume before the human describes or when the round is complete', async () => {
    const model = new ResumeTestModel();
    const engine = new GameEngine(model, fixedRandom);
    const created = engine.createGame();
    await expect(engine.resumeDescription(created.id)).rejects.toMatchObject({ status: 400 });

    const completed = await engine.submitHumanDescription(created.id, '经常出现在普通生活里');
    expect(completed.phase).toBe('voting');
    await expect(engine.resumeDescription(created.id)).rejects.toMatchObject({ status: 400 });
  });
});

function roundDescriptionIds(engine: GameEngine, gameId: string): string[] {
  return engine
    .getInternalGame(gameId)
    .descriptions.filter((description) => description.round === 1)
    .map((description) => description.playerId);
}

function fixedRandom(): number {
  return 0.42;
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('condition was not reached');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
