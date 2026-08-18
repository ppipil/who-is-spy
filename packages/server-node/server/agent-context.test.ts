import { describe, expect, it } from 'vitest';
import { buildAgentContext } from './agent-context.js';
import type { GameState } from './types.js';

describe('buildAgentContext', () => {
  it('only exposes the current agent secret and public game facts', () => {
    const game: GameState = {
      id: 'game-1',
      phase: 'describing',
      round: 2,
      ballot: 1,
      players: [
        {
          id: 'human',
          name: '你',
          avatar: '你',
          isHuman: true,
          role: 'undercover',
          word: '绝密卧底词',
          alive: true,
        },
        {
          id: 'ai-1',
          name: '阿序',
          avatar: '序',
          isHuman: false,
          role: 'civilian',
          word: '当前玩家词',
          alive: true,
        },
        {
          id: 'ai-2',
          name: '弥生',
          avatar: '弥',
          isHuman: false,
          role: 'civilian',
          word: '其他玩家词',
          alive: false,
        },
      ],
      descriptions: [{ playerId: 'human', text: '这是已经公开的描述', round: 1 }],
      votes: [],
      events: [
        {
          id: 'event-1',
          type: 'elimination',
          text: '弥生被投出局。身份将在终局揭晓。',
          round: 1,
          playerId: 'ai-2',
        },
      ],
      eligibleTargetIds: null,
      winner: null,
      review: null,
      createdAt: 1,
    };

    const context = buildAgentContext(game, game.players[1]);
    const serialized = JSON.stringify(context);

    expect(context.identity).toEqual({
      playerId: 'ai-1',
      name: '阿序',
      role: 'civilian',
      word: '当前玩家词',
    });
    expect(context.game.publicDescriptions[0].text).toBe('这是已经公开的描述');
    expect(context.game.publicEliminations[0].text).toContain('弥生被投出局');
    expect(serialized).not.toContain('绝密卧底词');
    expect(serialized).not.toContain('其他玩家词');
    expect(serialized).not.toContain('"role":"undercover"');
  });
});
