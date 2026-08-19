import { describe, expect, it } from 'vitest';
import {
  DESCRIBE_PROMPT_VERSION,
  VOTE_PROMPT_VERSION,
  buildDescribePrompt,
  buildVotePrompt,
  renderPromptHash,
} from './prompt.js';
import type { AgentContext, AgentStrategyId } from './types.js';

const STRATEGY_IDS: AgentStrategyId[] = ['cautious', 'intuitive', 'analytical', 'contrarian'];
const DISPLAY_NAMES = ['谨慎观察', '直觉敏锐', '逻辑派', '出其不意'];
const ALLOWED_TARGETS = [
  { id: 'human', name: '你' },
  { id: 'ai-1', name: '阿序' },
  { id: 'ai-2', name: '弥生' },
  { id: 'ai-4', name: '小满' },
];

describe('persona distinguishability', () => {
  it('renders four clearly different persona prompts for the same game state', () => {
    const prompts = STRATEGY_IDS.map((strategyId) => buildDescribePrompt(fixedCase(strategyId)));
    const hashes = prompts.map((prompt) => renderPromptHash(prompt.version, prompt.messages));
    expect(new Set(hashes)).toHaveLength(4);

    const users = prompts.map((prompt) => JSON.parse(prompt.messages[1].content));
    expect(users.map((user) => user.persona.id)).toEqual(STRATEGY_IDS);
    expect(users.map((user) => user.persona.displayName)).toEqual(DISPLAY_NAMES);
    expect(new Set(users.map((user) => user.persona.describe))).toHaveLength(4);
    expect(new Set(users.map((user) => user.persona.core))).toHaveLength(4);
    expect(new Set(users.map((user) => user.persona.speechStyle))).toHaveLength(4);
    expect(new Set(users.map((user) => user.persona.keyPrinciple))).toHaveLength(4);
    expect(users.map((user) => user.persona.riskTolerance)).toEqual(['LOW', 'MEDIUM_LOW', 'MEDIUM_HIGH', 'HIGH']);
    expect(new Set(users.map((user) => user.persona.personalityAnchor))).toHaveLength(4);
    expect(new Set(users.map((user) => user.persona.observationLens))).toHaveLength(4);
    expect(new Set(users.map((user) => user.priority))).toHaveLength(1);
    expect(users[0].priority).toContain('全局安全');

    expect(new Set(users.map((user) => user.roleObjective))).toHaveLength(1);
    expect(users[0].roleObjective).toContain('shared-safe');
    expect(new Set(users.map((user) => user.safety.exposure))).toHaveLength(1);
  });

  it('routes the same context into the four personas and keeps identical inputs hashed identically', () => {
    const first = buildDescribePrompt(fixedCase('cautious'));
    const second = buildDescribePrompt(fixedCase('cautious'));
    expect(renderPromptHash(first.version, first.messages)).toBe(renderPromptHash(second.version, second.messages));
    expect(first.version).toBe(DESCRIBE_PROMPT_VERSION);

    const retried = buildDescribePrompt(fixedCase('cautious'), { attempt: 2 });
    expect(renderPromptHash(retried.version, retried.messages)).toBe(renderPromptHash(first.version, first.messages));

    const repaired = buildDescribePrompt(fixedCase('cautious'), {
      attempt: 2,
      repair: { violationType: 'duplicate_description', guidance: '换一个角度' },
    });
    expect(renderPromptHash(repaired.version, repaired.messages)).not.toBe(
      renderPromptHash(first.version, first.messages),
    );
  });

  it('produces four distinct vote prompts and uses the v3 versions', () => {
    const votePrompts = STRATEGY_IDS.map((strategyId) => buildVotePrompt(fixedCase(strategyId), ALLOWED_TARGETS));
    const hashes = votePrompts.map((prompt) => renderPromptHash(prompt.version, prompt.messages));
    expect(new Set(hashes)).toHaveLength(4);
    expect(votePrompts[0].version).toBe(VOTE_PROMPT_VERSION);
    const users = votePrompts.map((prompt) => JSON.parse(prompt.messages[1].content));
    expect(new Set(users.map((user) => user.persona.vote))).toHaveLength(4);
    expect(new Set(users.map((user) => user.persona.riskTolerance))).toHaveLength(4);
    expect(new Set(users.map((user) => user.persona.observationLens))).toHaveLength(4);
  });
});

function fixedCase(strategyId: AgentStrategyId): AgentContext {
  return {
    identity: {
      playerId: 'ai-3',
      name: '老墨',
      strategyId,
      role: 'undercover',
      word: '高铁',
    },
    game: {
      gameId: 'persona-fixed-case',
      round: 2,
      phase: 'describing',
      ballot: 1,
      alivePlayers: [
        { id: 'human', name: '你' },
        { id: 'ai-1', name: '阿序' },
        { id: 'ai-2', name: '弥生' },
        { id: 'ai-3', name: '老墨' },
        { id: 'ai-4', name: '小满' },
      ],
      publicDescriptions: [
        { playerId: 'human', playerName: '你', text: '上下班的时候很多人会接触到。', round: 2 },
        { playerId: 'ai-1', playerName: '阿序', text: '经常需要在固定的地方等它。', round: 2 },
        { playerId: 'ai-2', playerName: '弥生', text: '通常会按照自己的路线移动。', round: 2 },
      ],
      publicEliminations: [],
    },
  };
}
