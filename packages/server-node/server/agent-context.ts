/**
 * Agent 上下文构造
 *
 * 职责：把服务器内部 GameState 裁剪成“单个 AI 玩家可见”的上下文快照。
 * 这是隐私边界的第一道闸门：AI 只能看到自己的身份（role/word）和公开信息，
 * 看不到其他玩家的身份、未公开的投票、候选目标等隐藏字段。
 */
import type { AgentContext, GameState, Player } from './types.js';

/** 为指定 AI 玩家构建可见上下文；人类玩家不参与 AI 决策，直接抛错。 */
export function buildAgentContext(game: GameState, agent: Player): AgentContext {
  if (agent.isHuman) {
    throw new Error('Human players do not receive an AI agent context');
  }

  // 预建 playerId → 名字映射，供公开描述展示使用，避免逐条查找。
  const playerNames = new Map(game.players.map((player) => [player.id, player.name]));

  return {
    // identity：只包含该 AI 自己的私有信息，绝不混入他人字段。
    identity: {
      playerId: agent.id,
      name: agent.name,
      strategyId: agent.strategyId!,
      role: agent.role,
      word: agent.word,
    },
    // game：只暴露对局中已经公开的信息。
    game: {
      gameId: game.id,
      round: game.round,
      phase: game.phase,
      ballot: game.ballot,
      // 存活玩家只带 id/name，不含 role/word。
      alivePlayers: game.players
        .filter((player) => player.alive)
        .map(({ id, name }) => ({ id, name })),
      // 已提交的描述是公开的，玩家名映射缺失时回退“未知玩家”。
      publicDescriptions: game.descriptions.map((description) => ({
        playerId: description.playerId,
        playerName: playerNames.get(description.playerId) ?? '未知玩家',
        text: description.text,
        round: description.round,
      })),
      // 公开淘汰记录：只保留文案与轮次，不带身份细节。
      publicEliminations: game.events
        .filter((event) => event.type === 'elimination')
        .map(({ text, round }) => ({ text, round })),
    },
  };
}
