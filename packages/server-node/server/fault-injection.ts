/**
 * 故障注入
 *
 * 用于验证可靠性与恢复链路：
 * - FaultInjectingModel：按 FaultSpec 精确注入脚本化故障（测试用）；
 * - ManagedFaultModel：管理后台可动态武装/清除故障场景（admin 用）；
 * - 注入的故障会写入 model_call trace，供评测与回放观察重试行为。
 */
import { FakeGameModel } from './test-utils.js';
import type { DescriptionRequest } from './description-quality.js';
import { performance } from 'node:perf_hooks';
import { ModelError, type GameModel } from './model.js';
import type { AgentContext, GameReview, GameState, Player } from './types.js';
import type {
  ModelDiagnostic,
  ModelErrorType,
  ModelTask,
  TraceModelKind,
  TraceSink,
} from './trace.js';

export type FaultType = 'timeout' | 'invalid_json' | 'schema_validation' | 'rate_limit' | 'provider_5xx';

/** 一次故障的精确匹配条件：任务 + agent + 轮次 + 尝试序号。 */
export interface FaultSpec {
  task: ModelTask;
  agentId: string;
  round: number;
  attempt: number;
  faultType: FaultType;
}

/** 确定性故障模型：包一层 FakeGameModel，命中条件即抛对应模型错误。 */
export class FaultInjectingModel implements GameModel {
  readonly model = 'fault-injected-fake-model';
  readonly modelKind: TraceModelKind = 'fake';
  private readonly delegate = new FakeGameModel();
  private traceSink?: TraceSink;
  private readonly consumedFaults = new Set<number>();

  constructor(private readonly faults: readonly FaultSpec[]) {}

  setTraceSink(sink: TraceSink): void {
    this.traceSink = sink;
  }

  isConfigured(): boolean {
    return true;
  }

  /** 描述调用：命中注入故障则抛错，否则委托给底层假模型。 */
  async describe(context: AgentContext, _request?: DescriptionRequest): Promise<string> {
    return this.withFaults('describe', context, () => this.delegate.describe(context));
  }

  /** 投票调用。 */
  async vote(context: AgentContext, allowedTargets: Player[]): Promise<{ targetId: string; reason: string }> {
    return this.withFaults('vote', context, () => this.delegate.vote(context, allowedTargets));
  }

  /** 复盘调用。 */
  async review(game: GameState): Promise<GameReview> {
    return this.withFaults('review', game, () => this.delegate.review(game));
  }

  /** 统一调用骨架：命中故障按诊断决定重试/抛出，未命中则正常执行并记成功 trace。 */
  private async withFaults<T>(
    task: ModelTask,
    context: AgentContext | GameState,
    operation: () => Promise<T>,
  ): Promise<T> {
    const maxAttempts = 2;
    let lastError: ModelError | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const fault = this.matchFault(task, context, attempt);
      if (fault) {
        const diagnostic = diagnosticForFault(fault.faultType, attempt);
        const willRetry = diagnostic.retryable && attempt < maxAttempts;
        this.trace(context, task, attempt, diagnostic, willRetry, 'failure');
        lastError = new ModelError(`故障注入：${fault.faultType}`, undefined, diagnostic);
        if (!willRetry) throw lastError;
        continue;
      }
      const result = await operation();
      this.trace(context, task, attempt, undefined, false, 'success');
      return result;
    }
    throw lastError ?? new ModelError('故障注入失败');
  }

  /** 匹配尚未消费的故障（一次性），命中后标记已消费。 */
  private matchFault(task: ModelTask, context: AgentContext | GameState, attempt: number): FaultSpec | undefined {
    const agentId = 'identity' in context ? context.identity.playerId : 'review';
    const round = 'identity' in context ? context.game.round : context.round;
    const index = this.faults.findIndex(
      (fault, faultIndex) =>
        !this.consumedFaults.has(faultIndex) &&
        fault.task === task &&
        fault.agentId === agentId &&
        fault.round === round &&
        fault.attempt === attempt,
    );
    if (index < 0) return undefined;
    this.consumedFaults.add(index);
    return this.faults[index];
  }

  /** 记录注入故障的 model_call trace（失败）。 */
  private trace(
    context: AgentContext | GameState,
    task: ModelTask,
    attempt: number,
    diagnostic: ModelDiagnostic | undefined,
    willRetry: boolean,
    outcome: 'success' | 'failure',
  ): void {
    if (!this.traceSink) return;
    const isGame = 'players' in context;
    this.traceSink.record({
      eventType: 'model_call',
      gameId: isGame ? context.id : context.game.gameId,
      round: isGame ? context.round : context.game.round,
      phase: isGame ? context.phase : context.game.phase,
      ballot: isGame ? context.ballot : context.game.ballot,
      task,
      agentId: isGame ? 'review' : context.identity.playerId,
      agentName: isGame ? '复盘' : context.identity.name,
      strategyId: isGame ? undefined : context.identity.strategyId,
      attempt,
      errorType: diagnostic?.errorType,
      httpStatus: diagnostic?.httpStatus,
      latencyMs: 0,
      willRetry,
      outcome,
    });
  }
}

export type FaultArmState = 'normal' | 'armed' | 'triggered';

/** 管理后台的动态故障模型：可随时武装/清除，状态可查询。 */
export class ManagedFaultModel implements GameModel {
  readonly model: string;
  readonly modelKind: TraceModelKind | undefined;
  private armed: { faults: FaultSpec[]; consumed: Set<number>; scenario: string } | null = null;
  private triggeredCount = 0;
  private lastTriggered: { scenario: string; gameId: string; at: string } | null = null;
  private delayMs = 0;
  private traceSink?: TraceSink;

  constructor(private readonly delegate: GameModel) {
    this.model = delegate.model;
    this.modelKind = delegate.modelKind;
  }

  setTraceSink(sink: TraceSink): void {
    this.traceSink = sink;
    this.delegate.setTraceSink?.(sink);
  }

  isConfigured(): boolean {
    return this.delegate.isConfigured();
  }

  /** 武装一个命名故障场景（可覆盖目标 agent，可附加延迟）。 */
  arm(scenario: string, targetAgent?: string, delayMs = 0): void {
    const faults = scenarioFaults(scenario).map((fault) =>
      targetAgent ? { ...fault, agentId: targetAgent } : fault,
    );
    this.armed = { faults, consumed: new Set(), scenario };
    this.triggeredCount = 0;
    this.lastTriggered = null;
    this.delayMs = Math.min(60_000, Math.max(0, Math.round(Number.isFinite(delayMs) ? delayMs : 0)));
  }

  /** 清除故障注入，回到正常状态。 */
  clear(): void {
    this.armed = null;
    this.triggeredCount = 0;
    this.lastTriggered = null;
  }

  /** 当前故障状态：normal/armed/triggered + 触发统计。 */
  status(): {
    state: FaultArmState;
    scenario?: string;
    triggeredCount: number;
    remaining?: number;
    gameId?: string;
    triggeredAt?: string;
  } {
    if (!this.armed) {
      return {
        state: this.lastTriggered ? 'triggered' : 'normal',
        triggeredCount: this.triggeredCount,
        ...(this.lastTriggered
          ? {
              scenario: this.lastTriggered.scenario,
              gameId: this.lastTriggered.gameId,
              triggeredAt: this.lastTriggered.at,
            }
          : {}),
      };
    }
    const remaining = this.armed.faults.filter(
      (_, index) => !this.armed!.consumed.has(index),
    ).length;
    return { state: 'armed', scenario: this.armed.scenario, triggeredCount: this.triggeredCount, remaining };
  }

  /** 描述调用：命中武装故障则抛错，否则透传真实模型。 */
  async describe(context: AgentContext, request?: DescriptionRequest): Promise<string> {
    return this.withFaults('describe', context, () => this.delegate.describe(context, request));
  }

  /** 投票调用。 */
  async vote(context: AgentContext, allowedTargets: Player[]): Promise<{ targetId: string; reason: string }> {
    return this.withFaults('vote', context, () => this.delegate.vote(context, allowedTargets));
  }

  /** 复盘调用。 */
  async review(game: GameState): Promise<GameReview> {
    return this.withFaults('review', game, () => this.delegate.review(game));
  }

  /** 统一调用骨架：命中故障先延迟（可选）再抛错，未命中直接透传。 */
  private async withFaults<T>(
    task: ModelTask,
    context: AgentContext | GameState,
    operation: () => Promise<T>,
  ): Promise<T> {
    const maxAttempts = 2;
    let lastError: ModelError | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const fault = this.matchFault(task, context, attempt);
      if (fault) {
        const startedAt = performance.now();
        if (this.delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.delayMs));
        }
        const diagnostic = diagnosticForFault(fault.faultType, attempt);
        const willRetry = diagnostic.retryable && attempt < maxAttempts;
        this.trace(context, task, attempt, diagnostic, willRetry, 'failure', Math.round(performance.now() - startedAt));
        lastError = new ModelError(`故障注入：${fault.faultType}`, undefined, diagnostic);
        if (!willRetry) throw lastError;
        continue;
      }
      // 正常调用不在这里记录 trace：真实 delegate（如 DeepSeekClient）自己会记 model_call，
      // 避免同一成功调用出现两条事件。
      return operation();
    }
    throw lastError ?? new ModelError('故障注入失败');
  }

  /** 匹配武装故障：一次性消费，全部命中后自动解除武装。 */
  private matchFault(task: ModelTask, context: AgentContext | GameState, attempt: number): FaultSpec | undefined {
    if (!this.armed) return undefined;
    const agentId = 'identity' in context ? context.identity.playerId : 'review';
    const round = 'identity' in context ? context.game.round : context.round;
    const index = this.armed.faults.findIndex(
      (fault, faultIndex) =>
        !this.armed!.consumed.has(faultIndex) &&
        fault.task === task &&
        fault.agentId === agentId &&
        fault.round === round &&
        fault.attempt === attempt,
    );
    if (index < 0) return undefined;
    const fault = this.armed.faults[index];
    this.armed.consumed.add(index);
    this.triggeredCount += 1;
    const gameId = 'identity' in context ? context.game.gameId : context.id;
    this.lastTriggered = { scenario: this.armed.scenario, gameId, at: new Date().toISOString() };
    if (this.armed.faults.every((_, faultIndex) => this.armed!.consumed.has(faultIndex))) this.armed = null;
    return fault;
  }

  /** 记录注入故障的 model_call trace（失败）。 */
  private trace(
    context: AgentContext | GameState,
    task: ModelTask,
    attempt: number,
    diagnostic: ModelDiagnostic,
    willRetry: boolean,
    outcome: 'failure',
    latencyMs: number,
  ): void {
    if (!this.traceSink) return;
    const isGame = 'players' in context;
    this.traceSink.record({
      eventType: 'model_call',
      gameId: isGame ? context.id : context.game.gameId,
      round: isGame ? context.round : context.game.round,
      phase: isGame ? context.phase : context.game.phase,
      ballot: isGame ? context.ballot : context.game.ballot,
      task,
      agentId: isGame ? 'review' : context.identity.playerId,
      agentName: isGame ? '复盘' : context.identity.name,
      strategyId: isGame ? undefined : context.identity.strategyId,
      attempt,
      errorType: diagnostic?.errorType,
      httpStatus: diagnostic?.httpStatus,
      latencyMs,
      willRetry,
      outcome,
    });
  }
}

/** 按名字返回内置故障剧本（每条精确到任务/agent/轮次/尝试）。 */
export function scenarioFaults(name: string): FaultSpec[] {
  const scenarios: Record<string, FaultSpec[]> = {
    'describe-timeout': [{ task: 'describe', agentId: 'ai-2', round: 1, attempt: 1, faultType: 'timeout' }],
    'describe-bad-json': [{ task: 'describe', agentId: 'ai-2', round: 1, attempt: 1, faultType: 'invalid_json' }],
    'vote-rate-limit': [{ task: 'vote', agentId: 'ai-3', round: 1, attempt: 1, faultType: 'rate_limit' }],
    'describe-final-failure': [
      { task: 'describe', agentId: 'ai-4', round: 1, attempt: 1, faultType: 'provider_5xx' },
      { task: 'describe', agentId: 'ai-4', round: 1, attempt: 2, faultType: 'provider_5xx' },
    ],
    'vote-final-failure': [
      { task: 'vote', agentId: 'ai-2', round: 1, attempt: 1, faultType: 'rate_limit' },
      { task: 'vote', agentId: 'ai-2', round: 1, attempt: 2, faultType: 'rate_limit' },
    ],
    'review-failure': [
      { task: 'review', agentId: 'review', round: 3, attempt: 1, faultType: 'provider_5xx' },
      { task: 'review', agentId: 'review', round: 3, attempt: 2, faultType: 'provider_5xx' },
    ],
    'schema-failure': [{ task: 'describe', agentId: 'ai-2', round: 1, attempt: 1, faultType: 'schema_validation' }],
  };
  const faults = scenarios[name];
  if (!faults) throw new Error(`未知 fault scenario: ${name}`);
  return faults;
}

/** 故障类型 → 模型诊断（限流/5xx 带 HTTP 状态，统一可重试）。 */
function diagnosticForFault(faultType: FaultType, attempt: number): ModelDiagnostic {
  const errorType: ModelErrorType = faultType;
  return {
    errorType,
    httpStatus: faultType === 'rate_limit' ? 429 : faultType === 'provider_5xx' ? 502 : undefined,
    retryable: true,
    attempt,
  };
}
