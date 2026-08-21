import 'dotenv/config';
import { listAgentStrategies } from './agent-strategy.js';
import { DeepSeekClient } from './model.js';
import { buildDescribePrompt, buildVotePrompt, renderPromptHash } from './prompt.js';
import type { TraceOrigin } from './trace.js';
import type { AgentContext, AgentStrategyId, Player } from './types.js';

const ALIVE_PLAYERS = [
  { id: 'human', name: '你' },
  { id: 'ai-1', name: '阿序' },
  { id: 'ai-2', name: '弥生' },
  { id: 'ai-3', name: '老墨' },
  { id: 'ai-4', name: '小满' },
];

const ALLOWED_TARGETS: Array<{ id: string; name: string }> = [
  { id: 'human', name: '你' },
  { id: 'ai-1', name: '阿序' },
  { id: 'ai-2', name: '弥生' },
  { id: 'ai-4', name: '小满' },
];

const ALLOWED_TARGET_PLAYERS: Player[] = ALLOWED_TARGETS.map(({ id, name }) => ({
  id,
  name,
  avatar: name.slice(-1),
  isHuman: id === 'human',
  role: 'civilian',
  word: '占位词',
  alive: true,
}));

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
      gameId: 'persona-probe',
      round: 2,
      phase: 'describing',
      ballot: 1,
      alivePlayers: ALIVE_PLAYERS,
      publicDescriptions: [
        { playerId: 'human', playerName: '你', text: '上下班的时候很多人会接触到。', round: 2 },
        { playerId: 'ai-1', playerName: '阿序', text: '经常需要在固定的地方等它。', round: 2 },
        { playerId: 'ai-2', playerName: '弥生', text: '通常会按照自己的路线移动。', round: 2 },
      ],
      publicEliminations: [],
    },
  };
}

async function main(): Promise<void> {
  const showPrompts = process.argv.includes('--prompts');
  const client = new DeepSeekClient();
  const origin: TraceOrigin = { sourceType: 'CLI_DEMO', entrypoint: 'cli', modelKind: 'real' };
  client.setOrigin?.(origin);
  if (!client.isConfigured()) {
    console.error(
      '未配置 DEEPSEEK_API_KEY，无法运行真实模型 persona-probe；Fake 不能冒充真实行为。请先在 .env 配置 DEEPSEEK_API_KEY。',
    );
    process.exitCode = 1;
    return;
  }

  const rows: Array<{ persona: string; description: string; vote: string; reason: string }> = [];
  for (const strategy of listAgentStrategies()) {
    const context = fixedCase(strategy.id);
    const describePrompt = buildDescribePrompt(context);
    const votePrompt = buildVotePrompt(context, ALLOWED_TARGETS);
    console.error(
      `\n===== ${strategy.displayName}（${strategy.id}） describeHash=${renderPromptHash(describePrompt.version, describePrompt.messages).slice(0, 12)} voteHash=${renderPromptHash(votePrompt.version, votePrompt.messages).slice(0, 12)} =====`,
    );
    if (showPrompts) {
      console.log(`\n## ${strategy.displayName}`);
      console.log('system:');
      console.log(describePrompt.messages[0].content);
      console.log('user:');
      console.log(describePrompt.messages[1].content);
    }

    let description = '(失败)';
    try {
      description = await client.describe(context);
    } catch (error) {
      description = `ERR: ${error instanceof Error ? error.message : String(error)}`;
    }
    let voteTarget = '(失败)';
    let reason = '';
    try {
      const result = await client.vote(context, ALLOWED_TARGET_PLAYERS);
      voteTarget = result.targetId;
      reason = result.reason;
    } catch (error) {
      voteTarget = `ERR: ${error instanceof Error ? error.message : String(error)}`;
    }
    rows.push({ persona: strategy.displayName, description, vote: voteTarget, reason });
    console.error(`[${strategy.displayName}] description: ${description}`);
    console.error(`[${strategy.displayName}] vote: ${voteTarget} | reason: ${reason}`);
  }

  console.log('\n| Persona | Description | Vote | Reason |');
  console.log('| --- | --- | --- | --- |');
  for (const row of rows) console.log(`| ${row.persona} | ${row.description} | ${row.vote} | ${row.reason} |`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
