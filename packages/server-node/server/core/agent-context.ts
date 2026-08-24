import type { AgentContext, GameState, Player } from './types.js';

/**
 * 为指定 AI 构造“最小权限”的模型上下文。
 * 输入是服务端完整 GameState 和当前 Agent，但输出只保留该 Agent 自己的 role/word，
 * 以及经过字段白名单投影的公共玩家、公开描述和淘汰记录；其他玩家的身份与词不会进入返回值。
 * GameEngine 会在每名 AI 发言前重新调用它，因此后发者能看到刚提交的公开描述，同时不突破信息隔离。
 */
export function buildAgentContext(game: GameState, agent: Player): AgentContext {
  if (agent.isHuman) {
    throw new Error('Human players do not receive an AI agent context');
  }

  const playerNames = new Map(game.players.map((player) => [player.id, player.name]));

  // 信息隔离边界：identity 只取当前 Agent 的私有身份和词；其他玩家只能通过下方
  // 显式挑选的公开字段进入上下文。不要把 Player 或 GameState 整体透传给模型。
  return {
    identity: {
      playerId: agent.id,
      name: agent.name,
      strategyId: agent.strategyId!,
      role: agent.role,
      word: agent.word,
    },
    game: {
      gameId: game.id,
      round: game.round,
      phase: game.phase,
      ballot: game.ballot,
      alivePlayers: game.players
        .filter((player) => player.alive)
        .map(({ id, name }) => ({ id, name })),
      // game.descriptions 只保存已经提交的公开发言。GameEngine 在每位 AI 成功后立即提交，
      // 因而后发 Agent 重建上下文时能看到本轮前面已经公开的描述。
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
