import { GameEngine } from '../core/game-engine.js';
import type { PublicGameState } from '../core/types.js';
import {
  recordTraceRun,
  type ModelCallTraceEvent,
  type RecoveryActionTraceEvent,
  type RuntimeTraceEvent,
  type TraceEventStore,
} from '../trace/trace.js';
import { FaultInjectingModel, scenarioFaults, type FaultSpec } from './fault-injection.js';

export const faultDemoScenarios = [
  { id: 'describe-timeout', name: 'AI Provider Timeout', description: '模拟 Provider 持续超时，安全暂停后由操作员恢复。' },
  { id: 'describe-bad-json', name: 'Bad JSON', description: '拒绝非法 JSON，不提交脏数据，并执行有界自动重试。' },
  { id: 'review-failure', name: 'Agent / Review Failure', description: 'Review 重试耗尽后使用本地复盘兜底。' },
] as const;
export type FaultDemoScenarioId = (typeof faultDemoScenarios)[number]['id'];
export type FaultDemoOutcome =
  | 'PAUSED SAFELY'
  | 'RECOVERED BY RETRY'
  | 'RECOVERED BY MANUAL RESUME'
  | 'RECOVERED BY FALLBACK'
  | 'SAFE ABORT'
  | 'NOT EXECUTED';

export interface FaultDemoStep {
  sequence: number;
  kind: 'attempt' | 'retry' | 'manual_resume' | 'fallback';
  status: 'FAILED' | 'SUCCESS' | 'SCHEDULED' | 'STARTED' | 'RECOVERED' | 'EXHAUSTED';
  title: string;
  attempt?: number;
  errorType?: string;
  willRetry?: boolean;
}

export interface FaultDemoResult {
  scenario: FaultDemoScenarioId;
  scenarioName: string;
  faultStatus: 'FAULT TRIGGERED' | 'TARGET FAULT NOT REACHED';
  outcome: FaultDemoOutcome;
  injectedFault: FaultSpec['faultType'];
  gameId: string;
  runId: string;
  round: number;
  phase: string;
  agentId: string;
  task: FaultSpec['task'];
  targetAttempt: number;
  canRecover: boolean;
  recoveryAction: string;
  stateEvidence: string[];
  timeline: FaultDemoStep[];
  stopReason?: string;
}

interface FaultDemoSession {
  engine: GameEngine;
  scenario: FaultDemoScenarioId;
  scenarioName: string;
  target: FaultSpec;
  gameId: string;
  createdAt: number;
  stopReason?: string;
}

export class FaultDemoService {
  private readonly sessions = new Map<string, FaultDemoSession>();

  constructor(private readonly trace: TraceEventStore) {}

  /**
   * 启动一次独立的确定性故障演示。
   * 创建专属 run/session、接入 TraceSink 并驱动到目标阶段；可恢复的描述终态会保留 session，其他场景直接形成终局结果。
   */
  async start(scenario: FaultDemoScenarioId): Promise<FaultDemoResult> {
    this.cleanup();
    const definition = faultDemoScenarios.find((item) => item.id === scenario);
    if (!definition) throw new Error(`未知 fault demo: ${scenario}`);
    const faults = faultsForDemo(scenario);
    const target = faults[0];
    const engine = new GameEngine(new FaultInjectingModel(faults), fixedRandom(), undefined, this.trace, {
      sourceType: 'FAULT_RUN', entrypoint: 'admin', modelKind: 'fake',
    });
    let game = engine.createGame();
    const session: FaultDemoSession = {
      engine, scenario, scenarioName: definition.name, target, gameId: game.id, createdAt: Date.now(),
    };
    this.recordLifecycle(session, 'running', 'NOT EXECUTED');
    try { game = await driveToTarget(engine, game, scenario); }
    catch (error) { session.stopReason = error instanceof Error ? error.message : String(error); game = engine.getGame(game.id); }

    const targetReached = this.targetFailures(session).length > 0;
    const canRecover = scenario === 'describe-timeout' && targetReached && game.phase === 'describing';
    const outcome = determineOutcome(scenario, targetReached, canRecover, this.targetEvents(session));
    if (canRecover) this.sessions.set(game.id, session);
    this.recordLifecycle(session, canRecover ? 'running' : targetReached ? 'completed' : 'failed', outcome);
    return this.result(session, game, outcome, canRecover);
  }

  /**
   * 对处于 PAUSED SAFELY 的描述故障执行第二阶段恢复。
   * 复用 GameEngine.resumeDescription 而不是篡改内部状态，成功后更新 lifecycle；无效、过期或不可恢复 runId 会明确拒绝。
   */
  async recover(runId: string): Promise<FaultDemoResult> {
    this.cleanup();
    const session = this.sessions.get(runId);
    if (!session) throw new FaultDemoSessionError('Fault Demo 不存在、已恢复或已过期');
    try {
      const game = await session.engine.resumeDescription(session.gameId);
      this.sessions.delete(runId);
      this.recordLifecycle(session, 'completed', 'RECOVERED BY MANUAL RESUME');
      return this.result(session, game, 'RECOVERED BY MANUAL RESUME', false);
    } catch (error) {
      session.stopReason = error instanceof Error ? error.message : String(error);
      const game = session.engine.getGame(session.gameId);
      this.recordLifecycle(session, 'running', 'PAUSED SAFELY');
      return this.result(session, game, 'PAUSED SAFELY', true);
    }
  }

  private result(session: FaultDemoSession, game: PublicGameState, outcome: FaultDemoOutcome, canRecover: boolean): FaultDemoResult {
    const targetReached = this.targetFailures(session).length > 0;
    return {
      scenario: session.scenario,
      scenarioName: session.scenarioName,
      faultStatus: targetReached ? 'FAULT TRIGGERED' : 'TARGET FAULT NOT REACHED',
      outcome: targetReached ? outcome : 'NOT EXECUTED',
      injectedFault: session.target.faultType,
      gameId: game.id,
      runId: game.id,
      round: session.target.round,
      phase: game.phase,
      agentId: session.target.agentId,
      task: session.target.task,
      targetAttempt: session.target.attempt,
      canRecover,
      recoveryAction: recoveryLabel(targetReached ? outcome : 'NOT EXECUTED'),
      stateEvidence: stateEvidence(game, outcome),
      timeline: buildTimeline(this.targetEvents(session), session.target),
      ...(session.stopReason ? { stopReason: session.stopReason } : {}),
    };
  }

  private targetEvents(session: FaultDemoSession): RuntimeTraceEvent[] {
    return this.trace.events.filter((event) => event.gameId === session.gameId && (
      event.eventType === 'recovery_action' ||
      (event.eventType === 'model_call' && event.task === session.target.task && event.agentId === session.target.agentId && event.round === session.target.round)
    ));
  }

  private targetFailures(session: FaultDemoSession): ModelCallTraceEvent[] {
    return this.targetEvents(session).filter((event): event is ModelCallTraceEvent =>
      event.eventType === 'model_call' && event.outcome === 'failure' && event.errorType === session.target.faultType);
  }

  private recordLifecycle(session: FaultDemoSession, status: 'running' | 'completed' | 'failed', scenarioOutcome: FaultDemoOutcome): void {
    recordTraceRun(this.trace, {
      runId: session.gameId, gameId: session.gameId, sourceType: 'FAULT_RUN', entrypoint: 'admin', modelKind: 'fake',
      status, createdAt: new Date().toISOString(), scenario: session.scenario,
      targetAgent: session.target.agentId, faultType: session.target.faultType, scenarioOutcome,
    });
  }

  private cleanup(): void {
    const expiresBefore = Date.now() - 30 * 60 * 1000;
    for (const [runId, session] of this.sessions) if (session.createdAt < expiresBefore) this.sessions.delete(runId);
    while (this.sessions.size > 20) this.sessions.delete(this.sessions.keys().next().value as string);
  }
}

export class FaultDemoSessionError extends Error {}

function faultsForDemo(scenario: FaultDemoScenarioId): FaultSpec[] {
  if (scenario === 'describe-timeout') return [
    { task: 'describe', agentId: 'ai-4', round: 1, attempt: 1, faultType: 'timeout' },
    { task: 'describe', agentId: 'ai-4', round: 1, attempt: 2, faultType: 'timeout' },
  ];
  return scenarioFaults(scenario);
}

async function driveToTarget(engine: GameEngine, initial: PublicGameState, scenario: FaultDemoScenarioId): Promise<PublicGameState> {
  let game = await engine.submitHumanDescription(initial.id, '这是一句安全的公开描述');
  if (scenario !== 'review-failure') return game;
  for (let step = 0; step < 12 && game.phase !== 'finished'; step += 1) {
    const human = game.players.find((player) => player.isHuman);
    if (!human?.alive) return engine.continueAsSpectator(game.id);
    if (game.phase === 'describing') game = await engine.submitHumanDescription(game.id, '继续提供安全的公开描述');
    else {
      const target = game.players.find((player) => player.alive && !player.isHuman);
      if (!target) break;
      game = await engine.submitHumanVote(game.id, target.id);
    }
  }
  return game;
}

function determineOutcome(scenario: FaultDemoScenarioId, reached: boolean, canRecover: boolean, events: RuntimeTraceEvent[]): FaultDemoOutcome {
  if (!reached) return 'NOT EXECUTED';
  if (canRecover) return 'PAUSED SAFELY';
  if (events.some((event) => event.eventType === 'model_call' && event.outcome === 'fallback')) return 'RECOVERED BY FALLBACK';
  if (events.some((event) => event.eventType === 'model_call' && event.outcome === 'success')) return 'RECOVERED BY RETRY';
  return scenario === 'describe-timeout' ? 'PAUSED SAFELY' : 'SAFE ABORT';
}

/**
 * 从结构化 trace 提炼面试演示时间线：失败、是否计划重试、成功、耗尽或 fallback。
 * 展示数据来自真实事件而非 UI 硬编码，因此可与 replay 和状态证据互相核对。
 */
function buildTimeline(events: RuntimeTraceEvent[], target: FaultSpec): FaultDemoStep[] {
  const steps: FaultDemoStep[] = [];
  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    if (event.eventType === 'model_call') {
      if (event.outcome === 'fallback') {
        steps.push({ sequence: event.sequence, kind: 'fallback', status: 'RECOVERED', title: 'Local fallback review generated' });
        continue;
      }
      steps.push({
        sequence: event.sequence, kind: 'attempt', status: event.outcome === 'success' ? 'SUCCESS' : 'FAILED',
        title: event.outcome === 'success' ? `Attempt #${event.attempt} succeeded` : `Attempt #${event.attempt} failed: ${errorName(event.errorType)}`,
        attempt: event.attempt, ...(event.errorType ? { errorType: event.errorType } : {}), willRetry: event.willRetry,
      });
      if (event.outcome === 'failure') steps.push({
        sequence: event.sequence + 0.1, kind: 'retry', status: event.willRetry ? 'SCHEDULED' : 'EXHAUSTED',
        title: event.willRetry ? 'Automatic retry scheduled' : 'Automatic retry exhausted',
      });
    } else {
      const recovery = event as RecoveryActionTraceEvent;
      steps.push({
        sequence: event.sequence, kind: 'manual_resume',
        status: recovery.recoveryOutcome === 'recovered' ? 'RECOVERED' : recovery.recoveryOutcome === 'exhausted' ? 'EXHAUSTED' : 'STARTED',
        title: recovery.recoveryOutcome === 'recovered' ? 'Manual resume recovered the description flow'
          : recovery.recoveryOutcome === 'exhausted' ? 'Manual resume exhausted' : `Manual resume #${recovery.manualResumeIndex} started`,
      });
    }
  }
  return steps.length ? steps : [{ sequence: 0, kind: 'attempt', status: 'EXHAUSTED', title: `Target ${target.task} fault was not reached` }];
}

function stateEvidence(game: PublicGameState, outcome: FaultDemoOutcome): string[] {
  const evidence = [`Phase remains legal: ${game.phase}`, `Committed descriptions: ${game.descriptions.length}`, `Committed votes: ${game.votes.length}`];
  if (outcome === 'PAUSED SAFELY') evidence.push('Voting was not entered while the description was incomplete');
  if (outcome === 'RECOVERED BY FALLBACK') evidence.push('Game remained finished with a local review');
  return evidence;
}

function recoveryLabel(outcome: FaultDemoOutcome): string {
  const labels: Record<FaultDemoOutcome, string> = {
    'PAUSED SAFELY': 'Retry exhausted → state preserved → waiting for operator',
    'RECOVERED BY RETRY': 'Malformed response rejected → bounded retry succeeded',
    'RECOVERED BY MANUAL RESUME': 'Provider restored → existing description resume succeeded',
    'RECOVERED BY FALLBACK': 'Retry exhausted → local fallback review',
    'SAFE ABORT': 'Retry exhausted → state preserved',
    'NOT EXECUTED': 'None — target fault was not reached',
  };
  return labels[outcome];
}

function errorName(value: string | undefined): string {
  const labels: Record<string, string> = { timeout: 'request timeout', invalid_json: 'invalid JSON', provider_5xx: 'provider 5xx' };
  return labels[value ?? ''] ?? value ?? 'unknown error';
}

function fixedRandom(): () => number {
  const values = [0.1, 0.2, 0.3, 0.4, 0.5]; let index = 0;
  return () => values[index++ % values.length];
}
