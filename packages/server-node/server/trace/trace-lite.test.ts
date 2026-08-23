import { describe, expect, it } from 'vitest';
import { GameEngine, redactSecretWords } from '../core/game-engine.js';
import { FakeGameModel } from '../support/test-utils.js';
import { filterTraceEventsByCase, filterTraceEventsByRun, InMemoryTraceSink, listTraceRuns } from './trace.js';

describe('Trace Lite observability', () => {
  it('records run lifecycle, prompt, quality-safe public flow, and vote events for a user game', async () => {
    const sink = new InMemoryTraceSink();
    const engine = new GameEngine(new FakeGameModel(), () => 0.2, undefined, sink);
    const created = engine.createGame();

    await engine.submitHumanDescription(created.id, '常见生活场景里会遇到');
    const voting = engine.getGame(created.id);
    const target = voting.players.find((player) => !player.isHuman && player.alive)!;
    await engine.submitHumanVote(created.id, target.id);

    expect(listTraceRuns(sink.events).some((run) => run.runId === created.id && run.sourceType === 'USER_GAME')).toBe(true);
    expect(filterTraceEventsByRun(sink.events, created.id).length).toBeGreaterThan(0);
    expect(filterTraceEventsByCase(sink.events, created.id, created.id).length).toBeGreaterThan(0);

    const votes = sink.events.filter((event) => event.eventType === 'vote');
    expect(votes.length).toBeGreaterThan(0);
    expect(votes.every((event) => event.gameId === created.id && event.runId === created.id)).toBe(true);
    expect(votes.every((event) => 'reason' in event && typeof event.reason === 'string')).toBe(true);
  });

  it('redacts secret words before vote reasons are written to trace', () => {
    expect(redactSecretWords('我会选择地铁，因为地铁很明显', ['地铁'])).toBe('我会选择[SECRET]，因为[SECRET]很明显');
  });
});
