import { describe, expect, it } from 'vitest';
import { listAgentStrategies } from './agent-strategy.js';
import { FakeGameModel } from './test-utils.js';
import type { AgentContext, AgentStrategyId, Player } from './types.js';

const strategyIds: AgentStrategyId[] = ['cautious', 'intuitive', 'analytical', 'contrarian'];

describe('agent strategies', () => {
  it('produce differentiated description and vote behavior in the same situation', async () => {
    const model = new FakeGameModel();
    const allowedTargets: Player[] = [
      player('target-1', '目标甲'),
      player('target-2', '目标乙'),
      player('target-3', '目标丙'),
    ];
    const contexts = strategyIds.map((strategyId) => context(strategyId));

    const descriptions = await Promise.all(contexts.map((item) => model.describe(item)));
    const votes = await Promise.all(contexts.map((item) => model.vote(item, allowedTargets)));

    expect(new Set(descriptions)).toHaveLength(4);
    expect(new Set(votes.map((vote) => vote.reason))).toHaveLength(4);
    expect(new Set(votes.map((vote) => vote.targetId)).size).toBeGreaterThan(1);
    expect(model.descriptionContexts.map((item) => item.identity.strategyId)).toEqual(strategyIds);
  });

  it('keeps policy and guidance behind a registry-backed boundary', () => {
    const strategies = listAgentStrategies();
    expect(strategies.map((strategy) => strategy.id)).toEqual(strategyIds);
    expect(
      new Set(
        strategies.map((strategy) =>
          strategy.buildDescriptionGuidance({ role: 'civilian', round: 1, publicDescriptionCount: 2 }),
        ),
      ),
    ).toHaveLength(4);
    expect(strategies.every((strategy) => strategy.qualityPolicy.maxDescriptionAttempts >= 2)).toBe(true);
  });
});

function context(strategyId: AgentStrategyId): AgentContext {
  return {
    identity: {
      playerId: `agent-${strategyId}`,
      name: '同一测试玩家',
      strategyId,
      role: 'civilian',
      word: '相同测试词',
    },
    game: {
      round: 1,
      alivePlayers: [
        { id: 'target-1', name: '目标甲' },
        { id: 'target-2', name: '目标乙' },
        { id: 'target-3', name: '目标丙' },
      ],
      publicDescriptions: [
        { playerId: 'target-1', playerName: '目标甲', text: '同一条公开描述', round: 1 },
      ],
      publicEliminations: [],
    },
  };
}

function player(id: string, name: string): Player {
  return {
    id,
    name,
    avatar: name.slice(-1),
    isHuman: false,
    strategyId: 'cautious',
    role: 'civilian',
    word: '只用于服务端目标对象',
    alive: true,
  };
}

