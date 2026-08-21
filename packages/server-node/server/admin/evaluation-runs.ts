/**
 * 评测运行仓库（EvaluationRunStore）
 *
 * 管理后台批量评测的异步任务状态：
 * - 同一时刻只允许一个运行（busy 409）；
 * - 记录进度/结果/门禁/耗时，并保留最近 MAX_RUNS 条历史；
 * - 结果附带汇总指标（供列表页快速展示）。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import type { EvaluationModelKind, EvaluationResult } from '../evaluation.js';

export type EvaluationRunStatus = 'running' | 'completed' | 'failed';

/** 运行配置：局数/种子/模型类型。 */
export interface EvaluationRunConfig {
  games: number;
  seed: number;
  model: EvaluationModelKind;
}

/** 列表页展示的汇总指标（从完整结果抽取核心字段）。 */
export interface EvaluationRunSummaryMetrics {
  completionRate: number;
  validVoteRate: number;
  descriptionHomogeneity: number;
  latencyP50: number;
  latencyP95: number;
  tokensPerGame: number;
  costPerGame: number;
  providerRetryCount: number;
  qualityRepairCount: number;
}

/** 一次运行的公开状态记录。 */
export interface EvaluationRunSummary {
  runId: string;
  status: EvaluationRunStatus;
  createdAt: string;
  finishedAt?: string;
  durationMs?: number;
  config: EvaluationRunConfig;
  progress: { completedGames: number; totalGames: number };
  gate?: { passed: boolean; failures: string[] };
  metrics?: EvaluationRunSummaryMetrics;
  error?: string;
}

/** 详情：额外携带完整结果（schemaVersion 1）。 */
export interface EvaluationRunDetail extends EvaluationRunSummary {
  result?: EvaluationResult;
}

/** 实际执行评测的函数：接收配置+runId+进度回调，返回完整结果。 */
export type EvaluationRunner = (options: EvaluationRunConfig & {
  runId: string;
  onProgress: (progress: { completedGames: number; totalGames: number }) => void;
}) => Promise<EvaluationResult>;

/** 已有评测运行中时抛出的错误（HTTP 409）。 */
export class EvaluationRunBusyError extends Error {
  constructor(public readonly activeRunId: string) {
    super(`评测已在运行：${activeRunId}`);
    this.name = 'EvaluationRunBusyError';
  }
}

/** 保留的最大运行历史条数，超出后淘汰最早一条。 */
const MAX_RUNS = 20;

/** Admin 默认评测历史文件（启用 admin 且未显式配置 ADMIN_EVAL_RUNS_JSON 时使用）。 */
export const DEFAULT_ADMIN_EVAL_RUNS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../traces/eval-runs.json',
);

/** 持久化选项：filePath 设置后，运行结束会把 summary 历史写入该 JSON 文件。 */
export interface EvaluationRunStoreOptions {
  filePath?: string;
}

/** 运行仓库：启动、查询、列表，单活动运行互斥。 */
export class EvaluationRunStore {
  private readonly runs = new Map<string, EvaluationRunDetail>();
  private activeRunId: string | null = null;

  constructor(
    private readonly runner: EvaluationRunner,
    private readonly options: EvaluationRunStoreOptions = {},
  ) {
    if (options.filePath) this.load(options.filePath);
  }

  /** 启动时从 JSON 恢复 summary 历史（不含完整 result）。损坏/缺失安全降级。 */
  private load(filePath: string): void {
    try {
      if (!fs.existsSync(filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as EvaluationRunSummary[];
      const restored = Array.isArray(parsed) ? parsed.filter((run) => run?.runId) : [];
      for (const run of restored.slice(-MAX_RUNS)) {
        this.runs.set(run.runId, { ...run, result: undefined });
      }
    } catch (error) {
      console.warn(
        `[eval-runs] 读取评测历史失败（${filePath}），按空历史启动：`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /** 运行结束后把 summary 历史写回 JSON（只存列表页需要的元数据）。 */
  private save(): void {
    if (!this.options.filePath) return;
    try {
      fs.mkdirSync(path.dirname(this.options.filePath), { recursive: true });
      const summaries = [...this.runs.values()].map(({ result: _result, ...summary }) => summary);
      fs.writeFileSync(this.options.filePath, `${JSON.stringify(summaries, null, 2)}\n`, 'utf8');
    } catch (error) {
      console.warn(
        `[eval-runs] 写入评测历史失败（${this.options.filePath}）：`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /** 启动一次评测：立即返回 running 记录，后台 runner 完成后回填结果。 */
  start(config: EvaluationRunConfig): EvaluationRunDetail {
    if (this.activeRunId) throw new EvaluationRunBusyError(this.activeRunId);
    const runId = randomUUID();
    const record: EvaluationRunDetail = {
      runId,
      status: 'running',
      createdAt: new Date().toISOString(),
      config: { ...config },
      progress: { completedGames: 0, totalGames: config.games },
    };
    this.runs.set(runId, record);
    this.activeRunId = runId;
    const startedMs = performance.now();
    // 异步执行：进度回调更新记录，成功/失败/收尾各处理一次。
    this.runner({
      games: config.games,
      seed: config.seed,
      model: config.model,
      runId,
      onProgress: (progress) => {
        record.progress = { ...progress };
      },
    })
      .then((result) => {
        record.status = 'completed';
        record.finishedAt = new Date().toISOString();
        record.durationMs = round(performance.now() - startedMs);
        record.result = result;
        record.gate = result.gate;
        record.metrics = summarize(result);
        record.progress = {
          completedGames: result.metrics.completedGames,
          totalGames: result.metrics.startedGames,
        };
      })
      .catch((error: unknown) => {
        record.status = 'failed';
        record.finishedAt = new Date().toISOString();
        record.durationMs = round(performance.now() - startedMs);
        record.error = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        // 运行结束释放互斥，并裁剪超量历史。
        if (this.activeRunId === runId) this.activeRunId = null;
        while (this.runs.size > MAX_RUNS) {
          const oldest = this.runs.keys().next().value as string | undefined;
          if (oldest === undefined) break;
          this.runs.delete(oldest);
        }
        this.save();
      });
    return record;
  }

  /** 按 runId 查询详情。 */
  get(runId: string): EvaluationRunDetail | undefined {
    return this.runs.get(runId);
  }

  /** 按创建时间倒序列出全部历史。 */
  list(): EvaluationRunDetail[] {
    return [...this.runs.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  activeRunIdValue(): string | null {
    return this.activeRunId;
  }
}

/** 从完整结果中抽取列表页摘要指标。 */
function summarize(result: EvaluationResult): EvaluationRunSummaryMetrics {
  return {
    completionRate: result.metrics.completionRate,
    validVoteRate: result.metrics.validVoteRate,
    descriptionHomogeneity: result.metrics.descriptionHomogeneity,
    latencyP50: result.metrics.latencyMs.p50,
    latencyP95: result.metrics.latencyMs.p95,
    tokensPerGame: result.metrics.tokenUsage.averagePerGame.total,
    costPerGame: result.metrics.cost.averageCostPerGame,
    providerRetryCount: result.metrics.providerRetryCount,
    qualityRepairCount: result.metrics.qualityRepairCount,
  };
}

/** 四舍五入到 4 位小数。 */
function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
