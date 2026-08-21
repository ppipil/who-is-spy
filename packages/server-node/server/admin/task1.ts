/**
 * Task1 实验台（开发/验收用）
 *
 * 用真实代码路径回答三个验收点：
 * A. 顺序上下文：后发 agent 实际收到了哪些同轮公开描述（从真实 prompt 溯源提取）；
 * B. persona 探针：同一固定局面下切换 persona，观察描述/投票变化（真实模型）；
 * C. 质量门禁：真实 DescriptionQualityGate 对被拒/通过候选的判定与 GameState 证据。
 */
import { listAgentStrategies } from '../agent-strategy.js';
import { DescriptionQualityGate } from '../description-quality.js';
import { GameEngine } from '../game-engine.js';
import type { GameModel } from '../model.js';
import {
  buildDescribePrompt,
  buildVotePrompt,
  renderPromptHash,
  sanitizePromptForDebug,
  type PromptMessage,
} from '../prompt.js';
import type { AgentContext, AgentStrategyId, GameState, Player, Role } from '../types.js';
import type { PromptDebugRecord } from '../prompt.js';
import type { TraceSink } from '../trace.js';
import { WORD_PAIRS } from '../words.js';
import { PERSONA_META, PERSONA_PROBE_EVIDENCE, QUALITY_GATE_EVIDENCE } from './task1-evidence.js';

/** 同轮公开描述（实验台展示用）。 */
export interface SameRoundDescription {
  playerId: string;
  playerName: string;
  text: string;
}

/** A 证据：从真实 prompt 溯源中还原出的“老墨实际看到的内容”。 */
export interface SameRoundEvidence {
  agentId: string;
  agentName: string;
  round: number;
  gameId: string;
  promptVersion: string;
  promptHash: string;
  publicDescriptionCount: number;
  sameRoundPublicDescriptionCount: number;
  timestamp: string;
  sameRoundDescriptions: SameRoundDescription[];
}

/** Task1 汇总响应：关系说明 + 各子证据。 */
export interface Task1Evidence {
  relation: { label: string; meaning: string };
  sameRound: SameRoundEvidence | null;
  contextRecords: ContextRecordSummary[];
  persona: typeof PERSONA_PROBE_EVIDENCE;
  qualityGate: typeof QUALITY_GATE_EVIDENCE;
}

/** 上下文记录摘要（最近 20 条描述 prompt）。 */
export interface ContextRecordSummary {
  gameId: string;
  round: number;
  agentId: string;
  agentName: string;
  sameRoundPublicDescriptionCount: number;
  publicDescriptionCount: number;
  timestamp: string;
  promptVersion: string;
  sameRoundDescriptions: SameRoundDescription[];
}

/** 上下文重算入参（可编辑同轮描述）。 */
export interface ContextBuildInput {
  agentId: string;
  round: number;
  publicDescriptions: SameRoundDescription[];
  role?: Role;
  word?: string;
}

/** 上下文重算结果：含真实 prompt hash 与脱敏消息。 */
export interface ContextBuildResult {
  agentId: string;
  agentName: string;
  strategyId: AgentStrategyId;
  round: number;
  sameRoundPublicDescriptionCount: number;
  publicDescriptionCount: number;
  promptVersion: string;
  promptHash: string;
  messages: PromptMessage[];
}

/** persona 探针入参：固定局面 + 目标角色/词。 */
export interface PersonaRunInput {
  role: Role;
  word: string;
  round: number;
  publicDescriptions: SameRoundDescription[];
}

/** 探针中某个任务的 prompt 视图。 */
export interface PersonaPromptView {
  promptVersion: string;
  promptHash: string;
  messages: PromptMessage[];
}

/** 单个 persona 的探针结果：描述/投票/prompt。 */
export interface PersonaRunCase {
  personaId: 'cautious' | 'intuitive' | 'analytical' | 'contrarian';
  personaName: string;
  agentName: string;
  risk: string;
  description: string;
  voteTarget: string;
  reason: string;
  strategyFocus: string;
  prompts: { describe: PersonaPromptView; vote: PersonaPromptView };
}

/** persona 探针整体结果。 */
export interface PersonaRunResult {
  generatedAt: string;
  model: string;
  scenario: string;
  cases: PersonaRunCase[];
}

/** 顺序描述实验入参：指定词对 + 人类描述。 */
export interface SequentialRunInput {
  civilianWord: string;
  undercoverWord: string;
  humanDescription: string;
  round: number;
}

/** 顺序实验中单个 agent 的一步：所见上下文 + 实际提交文本。 */
export interface SequentialAgentStep {
  agentId: string;
  agentName: string;
  personaId: string;
  personaName: string;
  round: number;
  sameRoundPublicDescriptionCount: number;
  publicDescriptionCount: number;
  receivedSameRound: SameRoundDescription[];
  promptVersion: string;
  promptHash: string;
  messages: PromptMessage[];
  description: string;
}

/** 顺序实验整体结果。 */
export interface SequentialRunResult {
  gameId: string;
  round: number;
  completedRounds: number;
  civilianWord: string;
  undercoverWord: string;
  humanDescription: string;
  steps: SequentialAgentStep[];
  endedNote?: string;
}

/** 质量门禁实验入参：两个候选 + 本轮已接受文本 + 阈值。 */
export interface QualityGateCheckInput {
  attempt1Candidate: string;
  attempt2Candidate: string;
  acceptedSameRound: string[];
  threshold: number;
  allSecrets: string[];
}

/** 门禁实验输出：逐次判定 + 最终提交/未提交文本。 */
export interface QualityGateCheckResult {
  attempts: Array<{
    attempt: number;
    candidate: string;
    gate: 'REJECTED' | 'PASSED';
    reason?: string;
    similarity?: number;
    threshold?: number;
    willRetry: boolean;
  }>;
  committed: string | null;
  notCommitted: string[];
}

const AGENT_NAMES: Record<string, string> = {
  'ai-1': '阿序',
  'ai-2': '弥生',
  'ai-3': '老墨',
  'ai-4': '小满',
};

const AGENT_PERSONA: Record<string, AgentStrategyId> = {
  'ai-1': 'cautious',
  'ai-2': 'intuitive',
  'ai-3': 'analytical',
  'ai-4': 'contrarian',
};

const PERSONA_NAMES: Record<AgentStrategyId, string> = {
  cautious: '谨慎观察',
  intuitive: '直觉敏锐',
  analytical: '逻辑派',
  contrarian: '出其不意',
};

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

// A：从真实 prompt provenance（sanitized input）里提取 ai-3 实际收到的同轮公开描述，
// 不重新构建上下文，直接复用模型真正收到的消息体。
export function buildSameRoundEvidence(records: readonly PromptDebugRecord[]): SameRoundEvidence | null {
  const describe = [...records]
    .filter(
      (record) =>
        record.task === 'describe' &&
        record.agentId === 'ai-3' &&
        record.sameRoundPublicDescriptionCount >= 2,
    )
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))[0];
  if (!describe) return null;
  const sameRoundDescriptions = extractSameRoundDescriptions(describe);
  if (sameRoundDescriptions.length === 0) return null;
  return {
    agentId: 'ai-3',
    agentName: '老墨',
    round: describe.round,
    gameId: describe.gameId,
    promptVersion: describe.promptTemplateVersion,
    promptHash: describe.promptHash,
    publicDescriptionCount: describe.publicDescriptionCount,
    sameRoundPublicDescriptionCount: describe.sameRoundPublicDescriptionCount,
    timestamp: describe.timestamp,
    sameRoundDescriptions,
  };
}

/** 从脱敏 prompt 记录中还原 publicDescriptions（按轮过滤）。 */
function extractSameRoundDescriptions(record: PromptDebugRecord): SameRoundDescription[] {
  const userMessage = record.messages.find((message) => message.role === 'user');
  if (!userMessage) return [];
  try {
    const parsed = JSON.parse(userMessage.content) as {
      context?: {
        game?: {
          publicDescriptions?: Array<{ playerId: string; playerName?: string; text: string; round: number }>;
        };
      };
    };
    const publicDescriptions = parsed.context?.game?.publicDescriptions ?? [];
    return publicDescriptions
      .filter((description) => description.round === record.round)
      .map((description) => ({
        playerId: description.playerId,
        playerName: description.playerName ?? description.playerId,
        text: description.text,
      }));
  } catch {
    return [];
  }
}

/** 汇总 Task1 证据：关系说明 + 同轮上下文 + 记录列表 + persona/门禁证据。 */
export function buildTask1Evidence(records: readonly PromptDebugRecord[]): Task1Evidence {
  return {
    relation: {
      label: 'Sequential Context → Persona Strategy → Quality Gate',
      meaning: '看到了什么 → 怎么决策 → 什么允许公开',
    },
    sameRound: buildSameRoundEvidence(records),
    contextRecords: listContextRecords(records),
    persona: PERSONA_PROBE_EVIDENCE,
    qualityGate: QUALITY_GATE_EVIDENCE,
  };
}

/** 列出最近 20 条带同轮上下文的描述 prompt 摘要。 */
export function listContextRecords(records: readonly PromptDebugRecord[]): ContextRecordSummary[] {
  return [...records]
    .filter((record) => record.task === 'describe' && record.sameRoundPublicDescriptionCount >= 1)
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
    .slice(0, 20)
    .map((record) => ({
      gameId: record.gameId,
      round: record.round,
      agentId: record.agentId,
      agentName: AGENT_NAMES[record.agentId] ?? record.agentId,
      sameRoundPublicDescriptionCount: record.sameRoundPublicDescriptionCount,
      publicDescriptionCount: record.publicDescriptionCount,
      timestamp: record.timestamp,
      promptVersion: record.promptTemplateVersion,
      sameRoundDescriptions: extractSameRoundDescriptions(record),
    }));
}

// A：用真实的 buildDescribePrompt 构造上下文，允许编辑同轮描述后重算
// （promptHash 由真实 prompt 内容计算，改动任何文本都会反映到 hash/计数）。
export function buildContextEvidence(input: ContextBuildInput): ContextBuildResult {
  const strategyId = AGENT_PERSONA[input.agentId] ?? 'cautious';
  const agentName = AGENT_NAMES[input.agentId] ?? input.agentId;
  const context = buildPersonaContext(
    {
      role: input.role ?? 'civilian',
      word: input.word ?? '占位词',
      round: input.round,
      publicDescriptions: input.publicDescriptions,
    },
    strategyId,
    input.agentId,
    agentName,
  );
  const prompt = buildDescribePrompt(context);
  const sameRound = context.game.publicDescriptions.filter((description) => description.round === input.round).length;
  return {
    agentId: input.agentId,
    agentName,
    strategyId,
    round: input.round,
    sameRoundPublicDescriptionCount: sameRound,
    publicDescriptionCount: context.game.publicDescriptions.length,
    promptVersion: prompt.version,
    promptHash: renderPromptHash(prompt.version, prompt.messages),
    messages: sanitizePromptForDebug(prompt),
  };
}

// B：复用 persona-probe 的同一固定局面构造 + 真实模型 describe/vote。
export async function runPersonaProbe(
  model: GameModel,
  input: PersonaRunInput,
  traceSink?: TraceSink,
): Promise<PersonaRunResult> {
  if (traceSink) model.setTraceSink?.(traceSink);
  const cases: PersonaRunResult['cases'] = [];
  for (const strategy of listAgentStrategies()) {
    const context = buildPersonaContext(input, strategy.id, 'ai-3', '老墨');
    const meta = PERSONA_META[strategy.id];
    const describePrompt = buildDescribePrompt(context);
    const votePrompt = buildVotePrompt(context, ALLOWED_TARGETS);
    let description = '(失败)';
    try {
      description = await model.describe(context);
    } catch (error) {
      description = `ERR: ${error instanceof Error ? error.message : String(error)}`;
    }
    let voteTarget = '(失败)';
    let reason = '';
    try {
      const result = await model.vote(context, ALLOWED_TARGET_PLAYERS);
      voteTarget = result.targetId;
      reason = result.reason;
    } catch (error) {
      voteTarget = `ERR: ${error instanceof Error ? error.message : String(error)}`;
    }
    cases.push({
      personaId: strategy.id,
      personaName: strategy.displayName,
      agentName: meta.agentName,
      risk: meta.risk,
      description,
      voteTarget,
      reason,
      strategyFocus: meta.strategyFocus,
      prompts: {
        describe: {
          promptVersion: describePrompt.version,
          promptHash: renderPromptHash(describePrompt.version, describePrompt.messages),
          messages: sanitizePromptForDebug(describePrompt),
        },
        vote: {
          promptVersion: votePrompt.version,
          promptHash: renderPromptHash(votePrompt.version, votePrompt.messages),
          messages: sanitizePromptForDebug(votePrompt),
        },
      },
    });
  }
  return {
    generatedAt: new Date().toISOString(),
    model: model.model,
    scenario: `自定义局面：Round ${input.round} · ${input.role} · word=${input.word} · 同轮公开描述 ${input.publicDescriptions.length} 条 · 仅切换 persona`,
    cases,
  };
}

// Tab1：真实顺序描述实验。使用真实 GameEngine 的正常分配/生成流程，
// 仅注入随机源选中用户指定的词对；后发 Agent 的上下文由引擎真实 staged 生成。
export async function runSequentialRound(
  model: GameModel,
  input: SequentialRunInput,
  promptRecords: readonly PromptDebugRecord[],
  traceSink?: TraceSink,
): Promise<SequentialRunResult> {
  const pairIndex = WORD_PAIRS.findIndex(
    (pair) =>
      (pair as readonly string[]).includes(input.civilianWord) &&
      (pair as readonly string[]).includes(input.undercoverWord),
  );
  if (pairIndex < 0) {
    throw new Error(`词对（${input.civilianWord}/${input.undercoverWord}）不在内置词表，无法用真实引擎构造`);
  }
  const pair = WORD_PAIRS[pairIndex];
  const seeded = mulberry32(1);
  let randomCalls = 0;
  const random = (): number => {
    randomCalls += 1;
    // 引擎 createGame 的前三次随机调用顺序固定：词对 → 卧底席位 → 是否交换平民/卧底词
    if (randomCalls === 1) return (pairIndex + 0.5) / WORD_PAIRS.length;
    if (randomCalls === 2) return 0.9;
    if (randomCalls === 3) return input.civilianWord === pair[0] ? 0.1 : 0.9;
    return seeded();
  };
  const engine = new GameEngine(
    model,
    random,
    (event) => {
      traceSink?.record({
        eventType: 'quality_violation',
        gameId: event.gameId,
        round: event.round,
        agentId: event.agentId,
        strategyId: event.strategyId,
        attempt: event.attempt,
        violationType: event.violationType,
        willRetry: event.willRetry,
      });
    },
    traceSink,
  );
  const publicGame = engine.createGame();
  const steps: SequentialAgentStep[] = [];
  let completedRounds = 0;
  let endedNote: string | undefined;

  for (let round = 1; round <= input.round; round += 1) {
    const humanText = round === 1 ? input.humanDescription : `第${round}轮我想到一种常见体验`;
    let internal: GameState;
    try {
      await engine.submitHumanDescription(publicGame.id, humanText);
      internal = engine.getInternalGame(publicGame.id);
    } catch (error) {
      endedNote = `第 ${round} 轮 Human 描述被拒：${error instanceof Error ? error.message : String(error)}`;
      break;
    }
    const humanCommitted = internal.descriptions.find(
      (description) => description.round === round && description.playerId === 'human',
    );
    steps.push({
      agentId: 'human',
      agentName: 'Human',
      personaId: 'human',
      personaName: '人类',
      round,
      sameRoundPublicDescriptionCount: 0,
      publicDescriptionCount: internal.descriptions.filter((item) => item.round === round).length - 1,
      receivedSameRound: [],
      promptVersion: '',
      promptHash: '',
      messages: [],
      description: humanCommitted?.text ?? humanText,
    });
    for (const agent of internal.players.filter(
      (player) => player.id !== 'human' && player.alive,
    )) {
      const strategyId = agent.strategyId ?? 'cautious';
      const record = [...promptRecords]
        .filter(
          (item) =>
            item.gameId === publicGame.id &&
            item.agentId === agent.id &&
            item.task === 'describe' &&
            item.round === round,
        )
        .sort((left, right) => left.timestamp.localeCompare(right.timestamp))[0];
      const committed = internal.descriptions.find(
        (description) => description.round === round && description.playerId === agent.id,
      );
      const receivedSameRound = record ? extractSameRoundDescriptions(record) : [];
      steps.push({
        agentId: agent.id,
        agentName: agent.name,
        personaId: strategyId,
        personaName: PERSONA_NAMES[strategyId],
        round,
        sameRoundPublicDescriptionCount: record?.sameRoundPublicDescriptionCount ?? 0,
        publicDescriptionCount: record?.publicDescriptionCount ?? 0,
        receivedSameRound,
        promptVersion: record?.promptTemplateVersion ?? '',
        promptHash: record?.promptHash ?? '',
        messages: record?.messages ?? [],
        description: committed?.text ?? '(未提交)',
      });
    }
    completedRounds = round;

    if (round < input.round) {
      // 平票会进入加票 ballot，循环推进到离开投票阶段为止。
      let ballotSafety = 0;
      while (ballotSafety < 4) {
        ballotSafety += 1;
        const voting = engine.getInternalGame(publicGame.id);
        if (voting.phase !== 'voting') break;
        const human = voting.players.find((player) => player.isHuman);
        if (!human?.alive) {
          endedNote = `第 ${round} 轮后人类被淘汰，实验提前结束`;
          break;
        }
        const target =
          voting.eligibleTargetIds?.[0] ??
          voting.players.find((player) => player.alive && !player.isHuman && player.id !== human.id)?.id;
        if (!target) {
          endedNote = `第 ${round} 轮后没有可投票目标`;
          break;
        }
        try {
          await engine.submitHumanVote(publicGame.id, target);
        } catch (error) {
          endedNote = `第 ${round} 轮投票失败：${error instanceof Error ? error.message : String(error)}`;
          break;
        }
      }
      if (endedNote) break;
      const after = engine.getInternalGame(publicGame.id);
      if (after.phase === 'finished') {
        endedNote = `第 ${round} 轮后对局结束（winner: ${after.winner}）`;
        break;
      }
      if (after.phase !== 'describing') {
        endedNote = `第 ${round} 轮后状态异常（${after.phase}）`;
        break;
      }
    }
  }

  return {
    gameId: publicGame.id,
    round: input.round,
    completedRounds,
    civilianWord: input.civilianWord,
    undercoverWord: input.undercoverWord,
    humanDescription: input.humanDescription,
    steps,
    endedNote,
  };
}

// C：用真实 DescriptionQualityGate 检查候选文本；被拒候选不会进入 accepted（GameState）。
/** C：用真实 DescriptionQualityGate 检查候选文本；被拒候选不会进入 accepted（GameState）。 */
export function runQualityGateCheck(input: QualityGateCheckInput): QualityGateCheckResult {
  const gate = new DescriptionQualityGate();
  const attempts: QualityGateCheckResult['attempts'] = [];
  const accepted = [...input.acceptedSameRound];
  const notCommitted: string[] = [];
  let committed: string | null = null;
  const candidates = [
    { attempt: 1, candidate: input.attempt1Candidate },
    { attempt: 2, candidate: input.attempt2Candidate },
  ];
  for (const { attempt, candidate } of candidates) {
    const violation = gate.check({
      text: candidate,
      allSecrets: input.allSecrets,
      acceptedSameRound: accepted,
      duplicateSimilarityThreshold: input.threshold,
    });
    if (!violation) {
      accepted.push(candidate);
      if (committed === null) committed = candidate;
      attempts.push({ attempt, candidate, gate: 'PASSED', willRetry: false });
    } else {
      notCommitted.push(candidate);
      attempts.push({
        attempt,
        candidate,
        gate: 'REJECTED',
        reason: violation.type,
        similarity: violation.similarity,
        threshold: input.threshold,
        willRetry: attempt < 2,
      });
    }
  }
  return { attempts, committed, notCommitted };
}

/** 构造实验台专用的 AgentContext（固定存活名单，publicDescriptions 来自入参）。 */
function buildPersonaContext(
  input: PersonaRunInput,
  strategyId: AgentStrategyId,
  playerId: string,
  playerName: string,
): AgentContext {
  return {
    identity: {
      playerId,
      name: playerName,
      strategyId,
      role: input.role,
      word: input.word,
    },
    game: {
      gameId: 'task1-probe',
      round: input.round,
      phase: 'describing',
      ballot: 1,
      alivePlayers: ALIVE_PLAYERS,
      publicDescriptions: input.publicDescriptions.map((description) => ({
        playerId: description.playerId,
        playerName: description.playerName,
        text: description.text,
        round: input.round,
      })),
      publicEliminations: [],
    },
  };
}

/** mulberry32 伪随机数生成器（实验台种子随机）。 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
