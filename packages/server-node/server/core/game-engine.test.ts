import { describe, expect, it } from 'vitest';
import { GameEngine } from './game-engine.js';
import { FakeGameModel } from '../support/test-utils.js';
import type { AgentContext } from './types.js';

class FailOnFourthDescriptionModel extends FakeGameModel {
  private calls = 0;

  override async describe(context: AgentContext): Promise<string> {
    this.calls += 1;
    const output = await super.describe(context);
    if (this.calls === 4) throw new Error('injected fourth-agent failure');
    return output;
  }
}

class PausedDescriptionModel extends FakeGameModel {
  private readonly resolvers: Array<() => void> = [];

  override async describe(context: AgentContext): Promise<string> {
    this.descriptionContexts.push(structuredClone(context));
    await new Promise<void>((resolve) => this.resolvers.push(resolve));
    return `公开描述-${context.identity.strategyId}`;
  }

  releaseNext(): void {
    const resolve = this.resolvers.shift();
    if (!resolve) throw new Error('no pending description');
    resolve();
  }
}

class PausedVoteModel extends FakeGameModel {
  readonly pendingVoteContexts: AgentContext[] = [];
  readonly plannedVoteTargets: string[] = [];
  readonly allowedTargetSnapshots: string[][] = [];
  private readonly voteResolvers: Array<() => void> = [];

  override async vote(context: AgentContext, allowedTargets: Parameters<FakeGameModel['vote']>[1]): ReturnType<FakeGameModel['vote']> {
    this.pendingVoteContexts.push(structuredClone(context));
    this.allowedTargetSnapshots.push(allowedTargets.map((target) => target.id));
    await new Promise<void>((resolve) => this.voteResolvers.push(resolve));
    const isOpenBallot = allowedTargets.length === context.game.alivePlayers.length - 1;
    const preferredTargetId = isOpenBallot
      ? ({ 'ai-1': 'human', 'ai-2': 'human', 'ai-3': 'ai-1', 'ai-4': 'ai-2' } as Record<string, string>)[context.identity.playerId]
      : ({ 'ai-1': 'human', 'ai-2': 'ai-1', 'ai-3': 'ai-1', 'ai-4': 'ai-1' } as Record<string, string>)[context.identity.playerId];
    const target = allowedTargets.find((candidate) => candidate.id === preferredTargetId) ?? allowedTargets[0];
    this.plannedVoteTargets.push(target.id);
    return {
      targetId: target.id,
      reason: '用于验证预生成投票绑定',
    };
  }

  releaseVotes(count: number): void {
    for (let index = 0; index < count; index += 1) {
      const resolve = this.voteResolvers.shift();
      if (!resolve) throw new Error('no pending vote');
      resolve();
    }
  }
}

describe('GameEngine', () => {
  it('runs a complete game with one human and four isolated AI players', async () => {
    const model = new FakeGameModel();
    const engine = new GameEngine(model, () => 0);
    const created = engine.createGame();

    expect(created.players).toHaveLength(5);
    expect(created.players.filter((player) => player.isHuman)).toHaveLength(1);
    expect(created.players.filter((player) => !player.isHuman)).toHaveLength(4);
    expect(created.players.every((player) => player.revealedRole === undefined)).toBe(true);
    expect(created.players.every((player) => player.revealedWord === undefined)).toBe(true);
    expect(created.human.role).toBe('undercover');

    const voting = await engine.submitHumanDescription(created.id, '经常伴随着细腻的泡沫');
    expect(voting.phase).toBe('voting');
    expect(voting.descriptions).toHaveLength(5);
    expect(model.descriptionContexts).toHaveLength(4);
    expect(
      model.descriptionContexts.map(
        (context) =>
          context.game.publicDescriptions.filter(
            (description) => description.round === 1 && description.playerId !== 'human',
          ).length,
      ),
    ).toEqual([0, 1, 2, 3]);

    const internal = engine.getInternalGame(created.id);
    const undercoverWord = internal.players.find((player) => player.role === 'undercover')!.word;
    for (const context of model.descriptionContexts) {
      expect(context.game.publicDescriptions.some((item) => item.playerId === 'human')).toBe(true);
      expect(JSON.stringify(context)).not.toContain(undercoverWord);
    }

    const finished = await engine.submitHumanVote(created.id, 'ai-1');
    expect(finished.phase).toBe('finished');
    expect(finished.winner).toBe('civilian');
    expect(finished.review?.turningPoints.length).toBeGreaterThan(0);
    expect(finished.players.every((player) => player.revealedRole)).toBe(true);
    expect(finished.players.every((player) => player.revealedWord)).toBe(true);
    expect(finished.players.find((player) => player.id === 'human')?.alive).toBe(false);
    expect(model.voteContexts).toHaveLength(4);
  });

  it('rejects descriptions that reveal a topic word or one of its characters', async () => {
    const engine = new GameEngine(new FakeGameModel(), () => 0);
    const game = engine.createGame();
    const internal = engine.getInternalGame(game.id);
    const otherWord = internal.players.find((player) => player.word !== game.human.word)!.word;

    await expect(
      engine.submitHumanDescription(game.id, `答案就是${game.human.word}`),
    ).rejects.toThrow('不能提到题目词或题目里的字');
    await expect(
      engine.submitHumanDescription(game.id, `线索里带${otherWord[0]}这个字`),
    ).rejects.toThrow('不能提到题目词或题目里的字');
  });

  it('commits each successful AI description before the next AI starts', async () => {
    const model = new PausedDescriptionModel();
    const engine = new GameEngine(model, () => 0);
    const game = engine.createGame();
    const pending = engine.submitHumanDescription(game.id, '经常出现在普通生活里');

    await waitFor(() => model.descriptionContexts.length === 1);
    expect(roundDescriptionIds(engine, game.id)).toEqual(['human']);
    expect(engine.getInternalGame(game.id).phase).toBe('describing');

    model.releaseNext();
    await waitFor(() => model.descriptionContexts.length === 2);
    expect(roundDescriptionIds(engine, game.id)).toEqual(['human', 'ai-1']);

    model.releaseNext();
    await waitFor(() => model.descriptionContexts.length === 3);
    expect(roundDescriptionIds(engine, game.id)).toEqual(['human', 'ai-1', 'ai-2']);

    model.releaseNext();
    await waitFor(() => model.descriptionContexts.length === 4);
    expect(roundDescriptionIds(engine, game.id)).toEqual(['human', 'ai-1', 'ai-2', 'ai-3']);

    model.releaseNext();
    await expect(pending).resolves.toMatchObject({ phase: 'voting' });
    expect(roundDescriptionIds(engine, game.id)).toEqual(['human', 'ai-1', 'ai-2', 'ai-3', 'ai-4']);
    expect(
      model.descriptionContexts.map(
        (context) =>
          context.game.publicDescriptions.filter(
            (description) => description.round === 1 && description.playerId !== 'human',
          ).length,
      ),
    ).toEqual([0, 1, 2, 3]);
  });

  it('keeps successful descriptions public and stays describing when the fourth agent fails', async () => {
    const model = new FailOnFourthDescriptionModel();
    const engine = new GameEngine(model, () => 0);
    const game = engine.createGame();

    await expect(engine.submitHumanDescription(game.id, '经常出现在普通生活里')).rejects.toThrow(
      'injected fourth-agent failure',
    );

    const after = engine.getInternalGame(game.id);
    expect(after.phase).toBe('describing');
    expect(roundDescriptionIds(engine, game.id)).toEqual(['human', 'ai-1', 'ai-2', 'ai-3']);
    expect(after.events.filter((event) => event.type === 'description').map((event) => event.playerId)).toEqual([
      'human',
      'ai-1',
      'ai-2',
      'ai-3',
    ]);
    expect(after.events.some((event) => event.text === '所有人描述完毕。观察措辞，投出你最怀疑的一票。')).toBe(false);
    expect(model.descriptionContexts).toHaveLength(4);
    expect(
      model.descriptionContexts.map(
        (context) =>
          context.game.publicDescriptions.filter(
            (description) => description.round === 1 && description.playerId !== 'human',
          ).length,
      ),
    ).toEqual([0, 1, 2, 3]);
  });

  it('prefetches AI votes privately and regenerates them for a second ballot', async () => {
    const model = new PausedVoteModel();
    const engine = new GameEngine(model, () => 0);
    const game = engine.createGame();

    const voting = await engine.submitHumanDescription(game.id, '经常出现在普通生活里');
    expect(voting.phase).toBe('voting');

    await waitFor(() => model.pendingVoteContexts.length === 4);
    expect(engine.getInternalGame(game.id).votes).toHaveLength(0);

    const pendingHumanVote = engine.submitHumanVote(game.id, 'ai-1');
    await Promise.resolve();
    expect(engine.getInternalGame(game.id).votes).toHaveLength(0);

    model.releaseVotes(4);
    const secondBallot = await pendingHumanVote;
    expect(model.plannedVoteTargets.slice(0, 4)).toEqual(['human', 'human', 'ai-1', 'ai-2']);
    expect(secondBallot.phase).toBe('voting');
    expect(secondBallot.ballot).toBe(2);
    expect([...(secondBallot.eligibleTargetIds ?? [])].sort()).toEqual(['ai-1', 'human']);

    await waitFor(() => model.pendingVoteContexts.length === 8);
    expect(model.allowedTargetSnapshots.slice(4)).toEqual([
      ['human'],
      ['human', 'ai-1'],
      ['human', 'ai-1'],
      ['human', 'ai-1'],
    ]);
  });
});

function roundDescriptionIds(engine: GameEngine, gameId: string): string[] {
  const game = engine.getInternalGame(gameId);
  return game.descriptions.filter((description) => description.round === game.round).map((description) => description.playerId);
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (condition()) return;
    await Promise.resolve();
  }
  throw new Error('condition was not reached');
}
