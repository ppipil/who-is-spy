import { describe, expect, it } from 'vitest';
import { buildRoleObjective, listAgentStrategies } from './agent-strategy.js';
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

  it('keeps policy behind a registry and separates role objective from persona', () => {
    const strategies = listAgentStrategies();
    expect(strategies.map((strategy) => strategy.id)).toEqual(strategyIds);
    expect(strategies.map((strategy) => strategy.displayName)).toEqual([
      '谨慎观察',
      '直觉敏锐',
      '逻辑派',
      '出其不意',
    ]);
    expect(new Set(strategies.map((strategy) => strategy.persona.core))).toHaveLength(4);
    expect(new Set(strategies.map((strategy) => strategy.persona.describe))).toHaveLength(4);
    expect(new Set(strategies.map((strategy) => strategy.persona.vote))).toHaveLength(4);
    expect(new Set(strategies.map((strategy) => strategy.persona.speechStyle))).toHaveLength(4);
    expect(strategies.map((strategy) => strategy.persona.riskTolerance)).toEqual([
      'LOW',
      'MEDIUM_LOW',
      'MEDIUM_HIGH',
      'HIGH',
    ]);
    expect(new Set(strategies.map((strategy) => strategy.persona.riskTolerance))).toHaveLength(4);
    expect(strategies.map((strategy) => strategy.persona.personalityAnchor.split('（')[0])).toEqual([
      'ISTJ-like',
      'INFP-like',
      'INTP-like',
      'ENTP-like',
    ]);
    expect(new Set(strategies.map((strategy) => strategy.persona.observationLens))).toHaveLength(4);
    expect(strategies.every((strategy) => strategy.persona.personalityAnchor.includes('内部锚点'))).toBe(true);
    expect(strategies.every((strategy) => strategy.qualityPolicy.maxDescriptionAttempts >= 2)).toBe(true);

    const undercoverObjectives = strategies.map(() => buildRoleObjective({ role: 'undercover', phase: 'describing' }));
    expect(new Set(undercoverObjectives)).toHaveLength(1);
    expect(undercoverObjectives[0]).toContain('shared-safe');
    const civilianObjectives = strategies.map(() => buildRoleObjective({ role: 'civilian', phase: 'describing' }));
    expect(new Set(civilianObjectives)).toHaveLength(1);
    expect(civilianObjectives[0]).toContain('weak clue');
    expect(undercoverObjectives[0]).not.toBe(civilianObjectives[0]);
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
      gameId: 'test-game',
      round: 1,
      phase: 'describing',
      ballot: 1,
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

