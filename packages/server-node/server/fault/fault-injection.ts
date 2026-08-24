import { FakeGameModel } from '../support/test-utils.js';
import type { DescriptionRequest } from '../core/description-quality.js';
import { ModelError, type GameModel } from '../core/model.js';
import type { AgentContext, GameReview, GameState, Player } from '../core/types.js';
import type { ModelDiagnostic, ModelErrorType, ModelTask, TraceSink } from '../trace/trace.js';

export type FaultType = 'timeout' | 'invalid_json' | 'schema_validation' | 'rate_limit' | 'provider_5xx';

export interface FaultSpec {
  task: ModelTask;
  agentId: string;
  round: number;
  attempt: number;
  faultType: FaultType;
}

export class FaultInjectingModel implements GameModel {
  readonly model = 'fault-injected-fake-model';
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

  async describe(context: AgentContext, _request?: DescriptionRequest): Promise<string> {
    return this.withFaults('describe', context, () => this.delegate.describe(context));
  }

  async vote(context: AgentContext, allowedTargets: Player[]): Promise<{ targetId: string; reason: string }> {
    return this.withFaults('vote', context, () => this.delegate.vote(context, allowedTargets));
  }

  async review(game: GameState): Promise<GameReview> {
    return this.withFaults('review', game, () => this.delegate.review(game));
  }

  /**
   * 在 FakeGameModel 外包一层两次尝试的确定性故障调度。
   * 指定 attempt 命中 FaultSpec 时先写失败 trace，再按 retryable 决定继续或抛错；未命中则调用真实 delegate。
   */
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
        this.trace(context, task, attempt, diagnostic, willRetry, 'failure', fault);
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

  /** 按 task、agentId、round、attempt 精确匹配一次性故障；consumedFaults 保证同一 spec 不会重复触发。 */
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

  /** 写入与真实 DeepSeekClient 同结构的 model_call trace，并附 injectedFault，便于 UI 区分模拟故障和真实故障。 */
  private trace(
    context: AgentContext | GameState,
    task: ModelTask,
    attempt: number,
    diagnostic: ModelDiagnostic | undefined,
    willRetry: boolean,
    outcome: 'success' | 'failure',
    injectedFault?: FaultSpec,
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
      ...(injectedFault ? { injectedFault: {
        agentId: injectedFault.agentId,
        faultType: injectedFault.faultType,
        round: injectedFault.round,
        attempt: injectedFault.attempt,
      } } : {}),
    });
  }
}

/**
 * 将可读场景名映射成固定 FaultSpec 列表。
 * 场景是 allowlist，保证演示可复现且只能在预定 Agent/轮次/attempt 注入，不接受任意运行时代码。
 */
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

function diagnosticForFault(faultType: FaultType, attempt: number): ModelDiagnostic {
  const errorType: ModelErrorType = faultType;
  return {
    errorType,
    httpStatus: faultType === 'rate_limit' ? 429 : faultType === 'provider_5xx' ? 502 : undefined,
    retryable: true,
    attempt,
  };
}
