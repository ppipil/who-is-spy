import type { AgentContext, GameState, Player } from './types.js';

export function buildAgentContext(game: GameState, agent: Player): AgentContext {
  if (agent.isHuman) {
    throw new Error('Human players do not receive an AI agent context');
  }

  const playerNames = new Map(game.players.map((player) => [player.id, player.name]));

  return {
    identity: {
      playerId: agent.id,
      name: agent.name,
      role: agent.role,
      word: agent.word,
    },
    game: {
      round: game.round,
      alivePlayers: game.players
        .filter((player) => player.alive)
        .map(({ id, name }) => ({ id, name })),
      publicDescriptions: game.descriptions.map((description) => ({
        playerId: description.playerId,
        playerName: playerNames.get(description.playerId) ?? '未知玩家',
        text: description.text,
        round: description.round,
      })),
      publicEliminations: game.events
        .filter((event) => event.type === 'elimination')
        .map(({ text, round }) => ({ text, round })),
    },
  };
}
