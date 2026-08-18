import { describe, expect, it } from 'vitest';
import { GameEngine } from './game-engine.js';
import { FakeGameModel } from './test-utils.js';

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

  it('rejects descriptions that reveal the human secret word', async () => {
    const engine = new GameEngine(new FakeGameModel(), () => 0);
    const game = engine.createGame();

    await expect(
      engine.submitHumanDescription(game.id, `答案就是${game.human.word}`),
    ).rejects.toThrow('不能直接说出你的秘密词');
  });
});
