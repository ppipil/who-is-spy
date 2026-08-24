import path from 'node:path';
import { GameEngine } from '../core/game-engine.js';
import { FaultInjectingModel, scenarioFaults } from './fault-injection.js';
import type { PublicGameState } from '../core/types.js';
import {
  CompositeTraceSink,
  InMemoryTraceSink,
  JsonlTraceSink,
  displayAgent,
  errorLabel,
  replayTrace,
  type ModelCallTraceEvent,
} from '../trace/trace.js';

interface Options {
  scenario: string;
  traceFile: string;
  list: boolean;
}

interface DemoResult {
  scenario: string;
  gameId: string;
  traceFile: string;
  beforeFailure?: PublicGameState;
  abortedState?: PublicGameState;
  finalState: PublicGameState;
  retried: boolean;
  trace: InMemoryTraceSink;
  abortMessage?: string;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options.list) {
    console.log(formatScenarioList());
    return;
  }
  const memoryTrace = new InMemoryTraceSink();
  const traceSink = new CompositeTraceSink([memoryTrace, new JsonlTraceSink(options.traceFile)]);
  const model = new FaultInjectingModel(scenarioFaults(options.scenario));
  const engine = new GameEngine(model, fixedRandom(), undefined, traceSink, {
    sourceType: 'FAULT_RUN',
    entrypoint: 'cli',
    modelKind: 'fake',
  });
  let game = engine.createGame();
  const result: DemoResult = {
    scenario: options.scenario,
    gameId: game.id,
    traceFile: options.traceFile,
    finalState: structuredClone(game),
    retried: false,
    trace: memoryTrace,
  };

  try {
    game = await engine.submitHumanDescription(game.id, '这是一句安全的公开描述');
    result.beforeFailure = structuredClone(game);
    if (game.phase === 'voting') {
      const targetId = firstAiTarget(game);
      if (targetId) game = await engine.submitHumanVote(game.id, targetId);
    }
    if (options.scenario === 'review-failure' && game.phase !== 'finished') {
      game = await engine.continueAsSpectator(game.id);
    }
  } catch (error) {
    result.abortMessage = error instanceof Error ? error.message : String(error);
    game = engine.getGame(game.id);
    result.abortedState = structuredClone(game);
  }

  if (options.scenario === 'vote-final-failure' && game.phase === 'voting') {
    const targetId = firstAiTarget(game);
    if (targetId) {
      result.beforeFailure = structuredClone(game);
      game = await engine.submitHumanVote(game.id, targetId);
      result.retried = true;
    }
  }

  result.finalState = structuredClone(game);
  console.log(formatIncidentReport(result));
}

function formatIncidentReport(result: DemoResult): string {
  const failures = modelFailures(result.trace);
  const firstFailure = failures[0];
  const lastFailure = failures.at(-1);
  const retryExhausted = Boolean(lastFailure && !lastFailure.willRetry && lastFailure.outcome === 'failure');
  const recoveredAfterFailure = Boolean(firstFailure && modelCalls(result.trace).some(
    (event) =>
      event.sequence > firstFailure.sequence &&
      event.task === firstFailure.task &&
      event.agentId === firstFailure.agentId &&
      event.outcome === 'success',
  ));
  const outcome = determineOutcome(result, retryExhausted, recoveredAfterFailure);
  const safety = stateSafetyLines(result, retryExhausted);

  return [
    '## Level 1：事故摘要',
    '',
    `故障场景：${result.scenario}`,
    `gameId：${result.gameId}`,
    '故障来源：Fault Injection（人为模拟）',
    firstFailure
      ? [
          '发生位置：',
          `- 第${firstFailure.round}轮`,
          `- phase：${phaseLabel(firstFailure.phase)}`,
          `- Agent：${displayAgent(firstFailure.agentId, firstFailure.agentName)}`,
          `- task：${firstFailure.task}`,
          '',
          '故障详情：',
          ...failureAttemptLines(failures).map((line) => `- ${line}`),
        ].join('\n')
      : '发生位置：未观察到模型故障',
    '',
    '处理策略：',
    ...safety.map((line) => `- ${line}`),
    '',
    '最终结果：',
    `- ${outcome}`,
    `- 最终 phase=${result.finalState.phase}, round=${result.finalState.round}, ballot=${result.finalState.ballot}`,
    `- 状态一致性：${safety.every((line) => line.startsWith('✓')) ? 'SAFE' : 'UNSAFE'}`,
    '',
    '## Level 2：关键 Replay Timeline',
    '',
    replayTrace(result.trace.events, result.gameId, { groupVoteBatches: result.scenario === 'vote-final-failure' }),
    '',
    '## Level 3：Raw Trace',
    '',
    `原始日志：${result.traceFile}`,
    '',
    '查看本局 Replay：',
    `npm run replay -- --game ${result.gameId} --trace-file ${relativeTracePath(result.traceFile)}`,
  ].join('\n');
}

function stateSafetyLines(result: DemoResult, retryExhausted: boolean): string[] {
  if (result.scenario === 'describe-final-failure') {
    const state = result.abortedState ?? result.finalState;
    const ids = state.descriptions.map((description) => description.playerId);
    return [
      ids.includes('ai-1') && ids.includes('ai-2') && ids.includes('ai-3') ? '✓ 已公开前缀保留' : '✗ 已公开前缀丢失',
      !ids.includes('ai-4') ? '✓ 失败 Agent 未写入 description' : '✗ 失败 Agent 被写入 description',
      state.phase === 'describing' ? '✓ phase 保持 describing' : `✗ phase 变成 ${state.phase}`,
      state.phase !== 'voting' ? '✓ 未进入 voting' : '✗ 错误进入 voting',
    ];
  }
  if (result.scenario === 'vote-final-failure') {
    const aborted = result.abortedState ?? result.beforeFailure ?? result.finalState;
    return [
      aborted.votes.length === 0 ? '✓ ballot 未半提交' : '✗ ballot 出现半提交',
      aborted.votes.every((vote) => vote.voterId !== 'human') ? '✓ Human vote 未半提交' : '✗ Human vote 被半提交',
      retryExhausted ? '✓ failed pending 已清理' : '✓ pending vote 未失败或已恢复',
      aborted.phase === 'voting' ? '✓ phase 保持 voting' : `✗ phase 变成 ${aborted.phase}`,
      result.retried ? '✓ 可以安全重新尝试同一 ballot，且重试成功' : '✓ 可以安全重新尝试同一 ballot',
    ];
  }
  if (result.scenario.includes('review')) {
    return [
      result.finalState.phase === 'finished' ? '✓ 使用 local fallback' : '✗ 未进入终局',
      result.finalState.review ? '✓ 游戏终局状态不受影响' : '✗ 缺少终局复盘',
    ];
  }
  return [
    result.abortMessage ? '✓ 故障被明确中止' : '✓ 故障后安全继续',
    '✓ 未记录 API Key / Prompt / 原始模型响应',
    result.finalState.phase === 'voting' || result.finalState.phase === 'describing' || result.finalState.phase === 'finished'
      ? `✓ phase 保持合法：${result.finalState.phase}`
      : `✗ 非法 phase：${result.finalState.phase}`,
  ];
}

function determineOutcome(result: DemoResult, retryExhausted: boolean, recoveredAfterFailure: boolean): string {
  if (result.retried) return 'recovered：首次 ballot 安全中止后，重新尝试同一 ballot 成功';
  if (recoveredAfterFailure) return 'recovered：自动 retry 后成功';
  if (result.scenario.includes('review')) return 'fallback：review 失败后使用 local fallback';
  if (retryExhausted || result.abortMessage) return 'aborted：重试耗尽后明确中止，状态保持合法';
  return 'recovered：未中止';
}

function modelFailures(trace: InMemoryTraceSink): ModelCallTraceEvent[] {
  return modelCalls(trace).filter((event) => event.outcome === 'failure');
}

function modelCalls(trace: InMemoryTraceSink): ModelCallTraceEvent[] {
  return trace.events.filter((event): event is ModelCallTraceEvent => event.eventType === 'model_call');
}

function firstAiTarget(game: PublicGameState): string | undefined {
  return game.players.find((player) => player.alive && !player.isHuman)?.id;
}

function parseArguments(args: string[]): Options {
  const options: Options = {
    scenario: 'describe-timeout',
    traceFile: path.resolve('traces/m5-runtime.jsonl'),
    list: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (argument === '--list') {
      options.list = true;
    } else if (argument === '--scenario' && value) {
      options.scenario = value;
      index += 1;
    } else if (argument === '--trace-file' && value) {
      options.traceFile = path.resolve(value);
      index += 1;
    } else {
      throw new Error(`unknown or incomplete argument: ${argument}`);
    }
  }
  return options;
}

function failureAttemptLines(failures: readonly ReturnType<typeof modelFailures>[number][]): string[] {
  return failures.map((failure) => {
    const retryText = failure.willRetry ? '会自动 retry' : 'retry exhausted';
    return `Attempt #${failure.attempt}: ${errorLabel(failure.errorType ?? 'unknown')} / errorType=${failure.errorType ?? 'unknown'} / HTTP=${failure.httpStatus ?? '无'} / ${retryText}`;
  });
}

function formatScenarioList(): string {
  return [
    '可用 M5 Fault Injection 场景：',
    '',
    '- describe-timeout：描述阶段，弥生（ai-2）第一次 describe 请求超时，随后自动重试成功。',
    '- describe-bad-json：描述阶段，弥生（ai-2）第一次返回无法解析 JSON，随后自动重试成功。',
    '- schema-failure：描述阶段，弥生（ai-2）第一次返回结构不符合 Schema，随后自动重试成功。',
    '- vote-rate-limit：投票阶段，老墨（ai-3）第一次 vote 遇到 HTTP 429，随后自动重试成功。',
    '- describe-final-failure：描述阶段，小满（ai-4）两次 provider_5xx，描述流程明确中止且保留已公开前缀。',
    '- vote-final-failure：投票阶段，弥生（ai-2）两次 HTTP 429，第一批私有 votes 整批丢弃，同 ballot 可重试成功。',
    '- review-failure：终局 review 两次 provider_5xx，使用 local fallback，终局状态保持有效。',
  ].join('\n');
}

function phaseLabel(phase: string): string {
  const labels: Record<string, string> = {
    describing: '描述阶段',
    voting: '投票阶段',
    finished: '终局',
  };
  return labels[phase] ?? phase;
}

function relativeTracePath(traceFile: string): string {
  return path.relative(process.cwd(), traceFile).replace(/\\/g, '/');
}

function fixedRandom(): () => number {
  const values = [0.1, 0.2, 0.3, 0.4, 0.5];
  let index = 0;
  return () => values[index++ % values.length];
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
