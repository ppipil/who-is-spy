import { describe, expect, it } from 'vitest';
import { GameEngine } from './game-engine.js';
import { FaultInjectingModel, scenarioFaults } from './fault-injection.js';
import { InMemoryTraceSink, replayTrace, type ModelCallTraceEvent } from './trace.js';

describe('M5 fault injection and replay', () => {
  it('classifies timeout, retries, and keeps the game playable', async () => {
    const trace = new InMemoryTraceSink();
    const engine = new GameEngine(new FaultInjectingModel(scenarioFaults('describe-timeout')), () => 0, undefined, trace);
    const game = engine.createGame();

    const voting = await engine.submitHumanDescription(game.id, '这是一句安全的公开描述');

    expect(voting.phase).toBe('voting');
    expect(voting.descriptions).toHaveLength(5);
    expect(modelCalls(trace, 'ai-2', 'describe').map((event) => [event.attempt, event.errorType, event.willRetry, event.outcome])).toEqual([
      [1, 'timeout', true, 'failure'],
      [2, undefined, false, 'success'],
    ]);
  });

  it('classifies invalid JSON and schema validation failures without leaking payloads', async () => {
    const invalidJsonTrace = new InMemoryTraceSink();
    const invalidJsonEngine = new GameEngine(
      new FaultInjectingModel(scenarioFaults('describe-bad-json')),
      () => 0,
      undefined,
      invalidJsonTrace,
    );
    const invalidJsonGame = invalidJsonEngine.createGame();
    await invalidJsonEngine.submitHumanDescription(invalidJsonGame.id, '这是一句安全的公开描述');
    expect(modelCalls(invalidJsonTrace, 'ai-2', 'describe')[0].errorType).toBe('invalid_json');

    const schemaTrace = new InMemoryTraceSink();
    const schemaEngine = new GameEngine(
      new FaultInjectingModel(scenarioFaults('schema-failure')),
      () => 0,
      undefined,
      schemaTrace,
    );
    const schemaGame = schemaEngine.createGame();
    await schemaEngine.submitHumanDescription(schemaGame.id, '这是一句安全的公开描述');
    expect(modelCalls(schemaTrace, 'ai-2', 'describe')[0].errorType).toBe('schema_validation');

    const serialized = JSON.stringify([...invalidJsonTrace.events, ...schemaTrace.events]);
    expect(serialized).not.toContain('DEEPSEEK_API_KEY');
    expect(serialized).not.toContain('Authorization');
    expect(serialized).not.toContain('messages');
    expect(serialized).not.toContain('prompt');
  });

  it('classifies HTTP 429 as rate_limit and retries the AI vote', async () => {
    const trace = new InMemoryTraceSink();
    const engine = new GameEngine(new FaultInjectingModel(scenarioFaults('vote-rate-limit')), () => 0, undefined, trace);
    const game = engine.createGame();

    const voting = await engine.submitHumanDescription(game.id, '这是一句安全的公开描述');
    await waitFor(() => modelCalls(trace, 'ai-3', 'vote').length >= 2);

    const finished = await engine.submitHumanVote(voting.id, 'ai-1');

    expect(finished.phase).toBe('finished');
    expect(modelCalls(trace, 'ai-3', 'vote').map((event) => [event.attempt, event.errorType, event.httpStatus, event.willRetry, event.outcome])).toEqual([
      [1, 'rate_limit', 429, true, 'failure'],
      [2, undefined, undefined, false, 'success'],
    ]);
  });

  it('keeps accepted descriptions public and stops safely after final describe failure', async () => {
    const trace = new InMemoryTraceSink();
    const engine = new GameEngine(new FaultInjectingModel(scenarioFaults('describe-final-failure')), () => 0, undefined, trace);
    const game = engine.createGame();

    await expect(engine.submitHumanDescription(game.id, '这是一句安全的公开描述')).rejects.toThrow('故障注入');

    const after = engine.getInternalGame(game.id);
    expect(after.phase).toBe('describing');
    expect(after.descriptions.map((description) => description.playerId)).toEqual(['human', 'ai-1', 'ai-2', 'ai-3']);
    expect(after.votes).toHaveLength(0);
    expect(modelCalls(trace, 'ai-4', 'describe').map((event) => [event.attempt, event.errorType, event.willRetry, event.outcome])).toEqual([
      [1, 'provider_5xx', true, 'failure'],
      [2, 'provider_5xx', false, 'failure'],
    ]);
  });

  it('does not half-commit votes after failure and can retry the same ballot', async () => {
    const trace = new InMemoryTraceSink();
    const engine = new GameEngine(new FaultInjectingModel(scenarioFaults('vote-final-failure')), () => 0, undefined, trace);
    const game = engine.createGame();

    const voting = await engine.submitHumanDescription(game.id, '这是一句安全的公开描述');
    await expect(engine.submitHumanVote(voting.id, 'ai-1')).rejects.toThrow('故障注入');
    expect(engine.getInternalGame(game.id).phase).toBe('voting');
    expect(engine.getInternalGame(game.id).votes).toHaveLength(0);

    const finished = await engine.submitHumanVote(voting.id, 'ai-1');

    expect(finished.phase).toBe('finished');
    expect(engine.getInternalGame(game.id).votes.length).toBeGreaterThan(0);
  });

  it('replays one game from redacted trace events', async () => {
    const trace = new InMemoryTraceSink();
    const engine = new GameEngine(new FaultInjectingModel(scenarioFaults('describe-timeout')), () => 0, undefined, trace);
    const game = engine.createGame();

    await engine.submitHumanDescription(game.id, '这是一句安全的公开描述');
    const replay = replayTrace(trace.events, game.id);

    expect(replay).toContain('弥生（ai-2） describe #1');
    expect(replay).toContain('错误：请求超时');
    expect(replay).toContain('自动重试');
    expect(replay).toContain('弥生（ai-2） describe #2 成功');
  });
});

function modelCalls(trace: InMemoryTraceSink, agentId: string, task: 'describe' | 'vote' | 'review'): ModelCallTraceEvent[] {
  return trace.events.filter(
    (event): event is ModelCallTraceEvent =>
      event.eventType === 'model_call' && event.agentId === agentId && event.task === task,
  );
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('condition was not reached');
}
