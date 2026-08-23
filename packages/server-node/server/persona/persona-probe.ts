import 'dotenv/config';
import { listAgentStrategies } from '../core/agent-strategy.js';
import { DeepSeekClient } from '../core/model.js';
import { flagLowInformationClue } from './persona-diagnostics.js';
import { buildDescribePrompt, buildVotePrompt, renderPromptHash } from '../core/prompt.js';
import type { AgentContext, AgentStrategyId, Player } from '../core/types.js';

const ALIVE_PLAYERS = [
  { id: 'human', name: '你' },
  { id: 'ai-1', name: '阿序' },
  { id: 'ai-2', name: '弥生' },
  { id: 'ai-3', name: '老墨' },
  { id: 'ai-4', name: '小满' },
];

function allowedTargetsFor(playerId: string): Array<{ id: string; name: string }> {
  return ALIVE_PLAYERS.filter((player) => player.id !== playerId);
}

function targetPlayers(targets: Array<{ id: string; name: string }>): Player[] {
  return targets.map(({ id, name }) => ({
    id,
    name,
    avatar: name.slice(-1),
    isHuman: id === 'human',
    role: 'civilian',
    word: '占位词',
    alive: true,
  }));
}

interface ProbeCase {
  id: string;
  label: string;
  context: (strategyId: AgentStrategyId) => AgentContext;
}

// 同一 Case 内保持 same role / same word / same round / same publicDescriptions /
// same model / same temperature，只切 Persona。私有词只进模型上下文，不出现在输出表。
const PROBE_CASES: ProbeCase[] = [
  {
    id: 'case-1',
    label: 'Case 1：卧底 · 第2轮 · 后手位（老墨）',
    context: (strategyId) => ({
      identity: { playerId: 'ai-3', name: '老墨', strategyId, role: 'undercover', word: '高铁' },
      game: {
        gameId: 'persona-probe-1',
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
    }),
  },
  {
    id: 'case-2',
    label: 'Case 2：平民 · 第2轮 · 后手位（弥生）',
    context: (strategyId) => ({
      identity: { playerId: 'ai-2', name: '弥生', strategyId, role: 'civilian', word: '地铁' },
      game: {
        gameId: 'persona-probe-2',
        round: 2,
        phase: 'describing',
        ballot: 1,
        alivePlayers: ALIVE_PLAYERS,
        publicDescriptions: [
          { playerId: 'human', playerName: '你', text: '它很常见，城市里到处都有。', round: 2 },
          { playerId: 'ai-1', playerName: '阿序', text: '很多人每天都会用到。', round: 2 },
          { playerId: 'ai-3', playerName: '老墨', text: '和生活联系很紧密。', round: 2 },
        ],
        publicEliminations: [],
      },
    }),
  },
  {
    id: 'case-3',
    label: 'Case 3：卧底 · 第3轮 · 后手位（小满）',
    context: (strategyId) => ({
      identity: { playerId: 'ai-4', name: '小满', strategyId, role: 'undercover', word: '猫' },
      game: {
        gameId: 'persona-probe-3',
        round: 3,
        phase: 'describing',
        ballot: 1,
        alivePlayers: ALIVE_PLAYERS,
        publicDescriptions: [
          { playerId: 'human', playerName: '你', text: '常在野外或者故事里出现。', round: 3 },
          { playerId: 'ai-1', playerName: '阿序', text: '让人想到聪明和狡猾。', round: 3 },
          { playerId: 'ai-2', playerName: '弥生', text: '有条毛茸茸的大尾巴。', round: 3 },
        ],
        publicEliminations: [],
      },
    }),
  },
];

function selectedCases(args: string[]): ProbeCase[] {
  const index = args.indexOf('--case');
  if (index === -1 || !args[index + 1]) return PROBE_CASES;
  const requested = args[index + 1].toLowerCase();
  const matched = PROBE_CASES.filter(
    (probeCase) => probeCase.id === requested || probeCase.id === `case-${requested}`,
  );
  if (matched.length === 0) {
    console.error(`未知 Case：${args[index + 1]}（可选 ${PROBE_CASES.map((probeCase) => probeCase.id).join(' / ')}）`);
    process.exit(1);
  }
  return matched;
}

interface ProbeRow {
  persona: string;
  risk: string;
  description: string;
  flag: string;
  vote: string;
  reason: string;
}

async function main(): Promise<void> {
  const showPrompts = process.argv.includes('--prompts');
  const cases = selectedCases(process.argv);
  const client = new DeepSeekClient();
  if (!client.isConfigured()) {
    console.error(
      '未配置 DEEPSEEK_API_KEY，无法运行真实模型 persona-probe；Fake 不能冒充真实行为。请先在 .env 配置 DEEPSEEK_API_KEY。',
    );
    process.exitCode = 1;
    return;
  }

  console.error('Risk gradient（同一安全上限内的信息预算）：LOW → MEDIUM_LOW → MEDIUM_HIGH → HIGH');
  for (const probeCase of cases) {
    console.error(`\n########## ${probeCase.label} ##########`);
    const rows: ProbeRow[] = [];
    for (const strategy of listAgentStrategies()) {
      const context = probeCase.context(strategy.id);
      const targets = allowedTargetsFor(context.identity.playerId);
      const describePrompt = buildDescribePrompt(context);
      const votePrompt = buildVotePrompt(context, targets);
      console.error(
        `\n===== ${strategy.displayName}（${strategy.id}） risk=${strategy.persona.riskTolerance} ` +
          `describeHash=${renderPromptHash(describePrompt.version, describePrompt.messages).slice(0, 12)} ` +
          `voteHash=${renderPromptHash(votePrompt.version, votePrompt.messages).slice(0, 12)} =====`,
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
        const result = await client.vote(context, targetPlayers(targets));
        voteTarget = result.targetId;
        reason = result.reason;
      } catch (error) {
        voteTarget = `ERR: ${error instanceof Error ? error.message : String(error)}`;
      }

      const matches = flagLowInformationClue(description);
      const flag =
        matches.length > 0 ? ` ⚠ generic(${matches.map((match) => match.phrase).join('、')})` : '';
      rows.push({
        persona: strategy.displayName,
        risk: strategy.persona.riskTolerance,
        description,
        flag,
        vote: voteTarget,
        reason,
      });
      console.error(`[${strategy.displayName}] description: ${description}${flag}`);
      console.error(`[${strategy.displayName}] vote: ${voteTarget} | reason: ${reason}`);
    }

    console.log(`\n### ${probeCase.label}`);
    console.log('| Persona | Risk | Description | Vote | Reason |');
    console.log('| --- | --- | --- | --- | --- |');
    for (const row of rows) {
      console.log(`| ${row.persona} | ${row.risk} | ${row.description}${row.flag} | ${row.vote} | ${row.reason} |`);
    }
    const flagged = rows.filter((row) => row.flag.length > 0);
    console.error(
      flagged.length > 0
        ? `[diagnostic] ${flagged.length} 条描述命中 low-information generic clue（仅诊断，不拦截）`
        : '[diagnostic] 本轮无 generic clue 命中（仅诊断，不拦截）',
    );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
