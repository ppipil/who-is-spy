/**
 * Express 应用装配
 *
 * - 对局 API：建局/查局/描述/投票/观战/描述恢复 + SSE 进度推送；
 * - 开发者管理后台（ENABLE_ADMIN_CONSOLE=1 开启，无鉴权、仅演示）：
 *   trace 查询、prompt 溯源、故障注入、批量评测运行与 Task1 证据接口。
 * 注意：admin 是 demo-only 开发面，不能当作生产安全边界。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { z } from 'zod';
import { DescriptionQualityError, type DescriptionQualityEvent } from './description-quality.js';
import { ManagedFaultModel } from './fault-injection.js';
import { GameEngine, GameRuleError } from './game-engine.js';
import { DeepSeekClient, ModelError, type GameModel } from './model.js';
import {
  DEFAULT_ADMIN_PROMPT_TRACE_PATH,
  readPromptTraceJsonl,
  setPromptDebugCollector,
  writePromptTraceJsonl,
  type PromptDebugRecord,
} from './prompt.js';
import {
  ConsoleTraceSink,
  DEFAULT_ADMIN_TRACE_PATH,
  InMemoryTraceSink,
  JsonlTraceSink,
  createTraceSinkFromEnv,
  readJsonlTrace,
  stampTraceOrigin,
  type TraceEntrypoint,
  type TraceModelKind,
  type TraceOrigin,
  type RuntimeTraceEvent,
} from './trace.js';
import { evaluationData } from './admin/evaluation-data.js';
import {
  DEFAULT_ADMIN_EVAL_RUNS_PATH,
  EvaluationRunBusyError,
  EvaluationRunStore,
  type EvaluationRunner,
} from './admin/evaluation-runs.js';
import { runEvaluation } from './evaluation.js';
import {
  buildContextEvidence,
  buildTask1Evidence,
  runPersonaProbe,
  runQualityGateCheck,
  runSequentialRound,
} from './admin/task1.js';

// 对局 API 入参校验。
const descriptionInput = z.object({ text: z.string() });
const voteInput = z.object({ targetId: z.string().min(1) });

// 评测运行入参：games 1–100，seed 可复现，model 二选一。
const evaluationRunInput = z.object({
  games: z.number().int().min(1).max(100).default(20),
  seed: z.number().int().default(42),
  model: z.enum(['fake', 'real']).default('fake'),
});

// Task1 实验台各接口的入参 schema（context/quality/persona/sequential）。
const task1ContextInput = z.object({
  agentId: z.enum(['ai-1', 'ai-2', 'ai-3', 'ai-4']),
  round: z.number().int().min(1).max(12),
  publicDescriptions: z
    .array(z.object({ playerId: z.string().min(1), playerName: z.string().min(1), text: z.string().min(1) }))
    .max(40),
  role: z.enum(['civilian', 'undercover']).optional(),
  word: z.string().max(20).optional(),
});

const task1PersonaInput = z.object({
  role: z.enum(['civilian', 'undercover']),
  word: z.string().min(1).max(20),
  round: z.number().int().min(1).max(12),
  publicDescriptions: z
    .array(z.object({ playerId: z.string().min(1), playerName: z.string().min(1), text: z.string().min(1) }))
    .max(40),
});

const task1QualityInput = z.object({
  attempt1Candidate: z.string().min(1),
  attempt2Candidate: z.string().min(1),
  acceptedSameRound: z.array(z.string().min(1)).max(20),
  threshold: z.number().min(0).max(1),
  allSecrets: z.array(z.string().min(1)).max(10),
});

const task1SequentialInput = z.object({
  civilianWord: z.string().min(1).max(20),
  undercoverWord: z.string().min(1).max(20),
  humanDescription: z.string().min(2).max(60),
  round: z.number().int().min(1).max(12).default(1),
});

/** 默认评测 runner：fake 用内置假模型，real 用 DeepSeek，均写入同一个内存 trace。 */
function createDefaultEvaluationRunner(
  runtimeTrace: InMemoryTraceSink,
  entrypoint: TraceEntrypoint,
): EvaluationRunner {
  return async ({ games, seed, model, onProgress, runId }) => {
    if (model === 'fake') {
      return runEvaluation({
        games,
        seed,
        modelKind: 'fake',
        onProgress,
        runId,
        traceSink: runtimeTrace,
        entrypoint,
      });
    }
    const client = new DeepSeekClient();
    if (!client.isConfigured()) {
      throw new Error('real model is not configured: set DEEPSEEK_API_KEY');
    }
    return runEvaluation({
      games,
      seed,
      modelKind: 'real',
      model: client,
      onProgress,
      runId,
      traceSink: runtimeTrace,
      entrypoint,
    });
  };
}

/** Task① 实验台统一来源：ADMIN_PROBE / admin。 */
function adminProbeOrigin(model: GameModel): TraceOrigin {
  return { sourceType: 'ADMIN_PROBE', entrypoint: 'admin', modelKind: model.modelKind ?? 'real' };
}

/**
 * 创建 Express 应用。
 * adminEnabled 决定是否暴露管理后台；测试可注入自定义 runner/probe 模型。
 */
export function createApp(
  modelInput: GameModel = new DeepSeekClient(),
  options: {
    adminEnabled?: boolean;
    evaluationRuns?: EvaluationRunStore;
    evaluationRunner?: EvaluationRunner;
    task1ProbeModel?: GameModel;
  } = {},
) {
  // Demo-only developer surface. Do not treat this hidden route as production security.
  const adminEnabled = options.adminEnabled ?? process.env.ENABLE_ADMIN_CONSOLE === '1';
  const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
  const MAX_TRACE_LOAD = 5000;
  // ---- Demo persistence：memory（实时） + local file（历史） ----
  const traceJsonlPath =
    process.env.M5_TRACE_JSONL ??
    (adminEnabled && process.env.NODE_ENV !== 'test' ? DEFAULT_ADMIN_TRACE_PATH : undefined);
  const promptJsonlPath =
    process.env.PROMPT_TRACE_JSONL ??
    (adminEnabled && process.env.NODE_ENV !== 'test' ? DEFAULT_ADMIN_PROMPT_TRACE_PATH : undefined);
  const evalRunsPath =
    process.env.ADMIN_EVAL_RUNS_JSON ??
    (adminEnabled && process.env.NODE_ENV !== 'test' ? DEFAULT_ADMIN_EVAL_RUNS_PATH : undefined);

  // 1) Runtime Trace：启动时从 JSONL 恢复最近 5000 条；新事件 sequence 从历史最大值继续，
  //    并同时写 memory + JSONL（+ 可选控制台）。损坏/缺失文件安全降级。
  let loadedTraceEvents: RuntimeTraceEvent[] = [];
  if (traceJsonlPath) {
    try {
      loadedTraceEvents = readJsonlTrace(traceJsonlPath).slice(-MAX_TRACE_LOAD);
    } catch (error) {
      console.warn(
        `[admin] 读取 trace JSONL 失败（${traceJsonlPath}），本次不恢复历史：`,
        error instanceof Error ? error.message : error,
      );
      loadedTraceEvents = [];
    }
  }
  const consoleTraceSink = process.env.M5_TRACE_CONSOLE === '1' ? new ConsoleTraceSink() : undefined;
  const jsonlTraceSink = traceJsonlPath ? new JsonlTraceSink(traceJsonlPath) : undefined;
  const runtimeTrace = new InMemoryTraceSink(loadedTraceEvents, (full) => {
    jsonlTraceSink?.recordFull(full);
    consoleTraceSink?.recordFull(full);
  });

  // 2) Prompt Trace：启动时恢复脱敏历史，之后由收集器统一做 内存 + JSONL 双写（避免重复落盘）。
  const promptTraceStore: PromptDebugRecord[] = [];
  if (promptJsonlPath) {
    try {
      promptTraceStore.push(...readPromptTraceJsonl(promptJsonlPath).slice(-MAX_TRACE_LOAD));
    } catch (error) {
      console.warn(
        `[admin] 读取 prompt JSONL 失败（${promptJsonlPath}），本次不恢复历史：`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  if (adminEnabled) {
    setPromptDebugCollector((record) => {
      promptTraceStore.push(record);
      if (promptJsonlPath) {
        try {
          writePromptTraceJsonl(promptJsonlPath, record);
        } catch (error) {
          console.warn(
            `[admin] 写入 prompt JSONL 失败（${promptJsonlPath}）：`,
            error instanceof Error ? error.message : error,
          );
        }
      }
    });
  }
  // 故障注入包装：admin 开启时模型调用可被脚本化注入故障/延迟。
  const faultModel = adminEnabled ? new ManagedFaultModel(modelInput) : undefined;
  const model = faultModel ?? modelInput;
  // ---- 统一来源标记：真实游玩(USER_GAME/web)；测试环境自动标记 TEST/test ----
  const testMode = process.env.NODE_ENV === 'test';
  const modelKind: TraceModelKind = model.modelKind ?? 'none';
  const userGameOrigin: TraceOrigin = {
    sourceType: testMode ? 'TEST' : 'USER_GAME',
    entrypoint: testMode ? 'test' : 'web',
    modelKind,
  };
  const userGameTrace = stampTraceOrigin(runtimeTrace, userGameOrigin);
  modelInput.setOrigin?.(userGameOrigin);
  const evaluationRuns =
    options.evaluationRuns ??
    new EvaluationRunStore(
      options.evaluationRunner ?? createDefaultEvaluationRunner(runtimeTrace, testMode ? 'test' : 'admin'),
      {
        filePath: evalRunsPath,
      },
    );
  const app = express();
  // admin：runtimeTrace 已通过回调写 memory + JSONL（+console）；非 admin 沿用环境 sink。
  const envSink = adminEnabled ? undefined : createTraceSinkFromEnv();
  const traceSink = adminEnabled ? userGameTrace : envSink;
  const engine = new GameEngine(
    model,
    Math.random,
    // 质量违例回调：admin 开启时转成 quality_violation trace 事件。
    adminEnabled
      ? (event: DescriptionQualityEvent) => {
          userGameTrace.record({
            eventType: 'quality_violation',
            gameId: event.gameId,
            round: event.round,
            agentId: event.agentId,
            strategyId: event.strategyId,
            attempt: event.attempt,
            violationType: event.violationType,
            willRetry: event.willRetry,
          });
        }
      : undefined,
    traceSink,
  );
  // SSE 进度订阅：把引擎的公开进度事件实时推给各局的事件流连接。
  const progressStreams = new Map<string, Set<express.Response>>();
  engine.subscribeToPublicProgress((event) => {
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const stream of progressStreams.get(event.gameId) ?? []) stream.write(payload);
  });
  app.use(express.json({ limit: '16kb' }));

  // 健康检查：暴露当前模型与配置状态。
  app.get('/api/health', (_request, response) => {
    response.json({
      ok: true,
      model: model.model,
      configured: model.isConfigured(),
    });
  });

  // 建局。
  app.post('/api/games', (_request, response) => {
    response.status(201).json(engine.createGame());
  });

  // 查局（公开视图）。
  app.get('/api/games/:id', (request, response, next) => {
    try {
      response.json(engine.getGame(request.params.id));
    } catch (error) {
      next(error);
    }
  });

  // 对局事件流（SSE）：描述发布/阶段切换的实时推送，15s 心跳保活。
  app.get('/api/games/:id/events', (request, response, next) => {
    try {
      engine.getGame(request.params.id);
      response.status(200);
      response.set({
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream',
      });
      response.flushHeaders();
      response.write(`event: ready\ndata: ${JSON.stringify({ gameId: request.params.id })}\n\n`);
      const streams = progressStreams.get(request.params.id) ?? new Set<express.Response>();
      streams.add(response);
      progressStreams.set(request.params.id, streams);
      const heartbeat = setInterval(() => response.write(': keepalive\n\n'), 15_000);
      request.on('close', () => {
        clearInterval(heartbeat);
        streams.delete(response);
        if (streams.size === 0) progressStreams.delete(request.params.id);
      });
    } catch (error) {
      next(error);
    }
  });

  // 人类提交描述。
  app.post('/api/games/:id/describe', async (request, response, next) => {
    try {
      const input = descriptionInput.parse(request.body);
      response.json(await engine.submitHumanDescription(request.params.id, input.text));
    } catch (error) {
      next(error);
    }
  });

  // 描述生成失败后的手动恢复。
  app.post('/api/games/:id/description/resume', async (request, response, next) => {
    try {
      response.json(await engine.resumeDescription(request.params.id));
    } catch (error) {
      next(error);
    }
  });

  // 人类提交投票。
  app.post('/api/games/:id/vote', async (request, response, next) => {
    try {
      const input = voteInput.parse(request.body);
      response.json(await engine.submitHumanVote(request.params.id, input.targetId));
    } catch (error) {
      next(error);
    }
  });

  // 出局后观战（服务器替人类自动行动直到终局）。
  app.post('/api/games/:id/continue', async (request, response, next) => {
    try {
      response.json(await engine.continueAsSpectator(request.params.id));
    } catch (error) {
      next(error);
    }
  });

  // admin 页面入口：生产环境回传前端构建产物，开发环境返回占位文本。
  app.get('/admin', (request, response) => {
    if (!adminEnabled) {
      response.status(404).json({ error: 'Not Found' });
      return;
    }
    if (process.env.NODE_ENV === 'production') {
      const distDirectory = path.resolve(currentDirectory, '../../web/dist');
      response.sendFile(path.join(distDirectory, 'index.html'));
      return;
    }
    response.status(200).send('Developer Console');
  });

  if (adminEnabled) {
    const adminRouter = express.Router();
    // 后台状态：模型、fault、活动局数与 trace 开关。
    adminRouter.get('/status', (_request, response) => {
      response.json({
        model: model.model,
        configured: model.isConfigured(),
        runtimeTrace: 'ON',
        fault: faultModel!.status(),
        activeGames: engine.activeGameCount(),
        adminEnabled: true,
      });
    });
    // trace 查询：按 gameId/round/agent/task/errorType/runId 过滤，最多返回 500 条。
    adminRouter.get('/traces', (request, response) => {
      const { gameId, round, agent, task, errorType, runId } = request.query;
      let events: RuntimeTraceEvent[] = runtimeTrace.events;
      if (gameId) events = events.filter((event) => event.gameId === gameId);
      if (round !== undefined) {
        const roundNumber = Number(round);
        events = events.filter((event) => event.round === roundNumber);
      }
      if (agent) events = events.filter((event) => 'agentId' in event && event.agentId === agent);
      if (task) events = events.filter((event) => 'task' in event && event.task === task);
      if (errorType) events = events.filter((event) => 'errorType' in event && event.errorType === errorType);
      if (runId) events = events.filter((event) => 'runId' in event && event.runId === runId);
      response.json({ count: events.length, events: events.slice(-500) });
    });
    // 内部审计搜索：在服务器端扫描内部 GameState（含未脱敏投票理由），
    // 只返回命中位置 + 脱敏片段，明文密词不出服务器。
    adminRouter.post('/traces/search', (request, response) => {
      const parsed = z.object({ keyword: z.string().trim().min(1).max(50) }).safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: 'invalid search keyword' });
        return;
      }
      const keyword = parsed.data.keyword.toLowerCase();
      const gameIds = new Set<string>();
      for (const event of runtimeTrace.events) gameIds.add(event.gameId);
      const matches: Array<{ gameId: string; round: number; field: string; text: string }> = [];
      for (const gameId of gameIds) {
        let game;
        try {
          game = engine.getInternalGame(gameId);
        } catch {
          continue;
        }
        const secrets = [...new Set(game.players.map((player) => player.word))];
        const redact = (text: string): string =>
          secrets.reduce((value, secret) => value.split(secret).join('[SECRET]'), text);
        const push = (field: string, round: number, text: string): void => {
          if (!text.toLowerCase().includes(keyword)) return;
          const snippet = redact(text);
          matches.push({
            gameId,
            round,
            field,
            text: snippet.length > 180 ? `${snippet.slice(0, 180)}…` : snippet,
          });
        };
        for (const description of game.descriptions) push('description', description.round, description.text);
        for (const vote of game.votes) {
          push('vote_reason', vote.round, `${vote.voterId} → ${vote.targetId}：${vote.reason}`);
        }
        for (const event of game.events) push('event', event.round, event.text);
      }
      response.json({ keyword: parsed.data.keyword, count: matches.length, matches });
    });
    // prompt 溯源查询（脱敏后的 prompt 记录），最多 200 条。
    adminRouter.get('/prompt-traces', (request, response) => {
      const { gameId, round, agentId, task } = request.query;
      let records = promptTraceStore;
      if (gameId) records = records.filter((record) => record.gameId === gameId);
      if (round !== undefined) {
        const roundNumber = Number(round);
        records = records.filter((record) => record.round === roundNumber);
      }
      if (agentId) records = records.filter((record) => record.agentId === agentId);
      if (task) records = records.filter((record) => record.task === task);
      response.json({ count: records.length, records: records.slice(-200) });
    });
    // 故障注入状态与开关。
    adminRouter.get('/faults', (_request, response) => {
      response.json(faultModel!.status());
    });
    // 武装一个故障场景（可指定目标 agent 与延迟）。
    adminRouter.post('/faults/arm', (request, response, next) => {
      const scenario = z.string().min(1).safeParse(request.body?.scenario);
      if (!scenario.success) {
        response.status(400).json({ error: 'scenario is required' });
        return;
      }
      const targetAgent = typeof request.body?.targetAgent === 'string' ? request.body.targetAgent : undefined;
      const delayMs = typeof request.body?.delayMs === 'number' ? request.body.delayMs : undefined;
      try {
        faultModel!.arm(scenario.data, targetAgent, delayMs);
        response.json(faultModel!.status());
      } catch (error) {
        next(error);
      }
    });
    // 清除故障注入。
    adminRouter.post('/faults/clear', (_request, response) => {
      faultModel!.clear();
      response.json(faultModel!.status());
    });
    // 规范基线 vs 改进的评测证据（只读，来自 committed evidence）。
    adminRouter.get('/evaluation', (_request, response) => {
      response.json(evaluationData);
    });
    // Task1 汇总证据（prompt 溯源 + persona 探针 + 质量门禁用例）。
    adminRouter.get('/task1', (_request, response) => {
      response.json(buildTask1Evidence(promptTraceStore));
    });
    // Trace 页：返回某局的投票明细（理由按密词脱敏，供 Vote 树展示）。
    adminRouter.get('/games/:id/votes', (request, response) => {
      let internal;
      try {
        internal = engine.getInternalGame(request.params.id);
      } catch {
        response.status(404).json({ error: 'game not found' });
        return;
      }
      const secrets = [...new Set(internal.players.map((player) => player.word))];
      const redact = (text: string): string =>
        secrets.reduce((value, secret) => value.split(secret).join('[SECRET]'), text);
      response.json({
        gameId: internal.id,
        players: internal.players.map(({ id, name }) => ({ id, name })),
        votes: internal.votes.map((vote) => ({
          voterId: vote.voterId,
          targetId: vote.targetId,
          reason: redact(vote.reason),
          round: vote.round,
          ballot: vote.ballot,
        })),
      });
    });
    // Task1：用真实 prompt 构建器重算某 agent 的上下文与 prompt hash。
    adminRouter.post('/task1/context', (request, response) => {
      const parsed = task1ContextInput.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: 'invalid task1 context input' });
        return;
      }
      response.json(buildContextEvidence(parsed.data));
    });
    // Task1：用真实质量门禁检查两个候选文本。
    adminRouter.post('/task1/quality', (request, response) => {
      const parsed = task1QualityInput.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: 'invalid task1 quality input' });
        return;
      }
      response.json(runQualityGateCheck(parsed.data));
    });
    // Task1：persona 探针（真实模型，同一固定局面切换 persona）。
    adminRouter.post('/task1/persona/run', async (request, response, next) => {
      const parsed = task1PersonaInput.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: 'invalid task1 persona input' });
        return;
      }
      const probeModel = options.task1ProbeModel ?? new DeepSeekClient();
      if (!probeModel.isConfigured()) {
        response.status(400).json({ error: 'real model is not configured: set DEEPSEEK_API_KEY' });
        return;
      }
      probeModel.setOrigin?.(adminProbeOrigin(probeModel));
      try {
        response.json(
          await runPersonaProbe(
            probeModel,
            parsed.data,
            stampTraceOrigin(runtimeTrace, adminProbeOrigin(probeModel)),
          ),
        );
      } catch (error) {
        next(error);
      }
    });
    // Task1：真实顺序描述实验（引擎真实 staged 生成）。
    adminRouter.post('/task1/sequential/run', async (request, response, next) => {
      const parsed = task1SequentialInput.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: 'invalid task1 sequential input' });
        return;
      }
      const probeModel = options.task1ProbeModel ?? new DeepSeekClient();
      if (!probeModel.isConfigured()) {
        response.status(400).json({ error: 'Real model unavailable: set DEEPSEEK_API_KEY' });
        return;
      }
      probeModel.setOrigin?.(adminProbeOrigin(probeModel));
      try {
        response.json(
          await runSequentialRound(
            probeModel,
            parsed.data,
            promptTraceStore,
            stampTraceOrigin(runtimeTrace, adminProbeOrigin(probeModel)),
          ),
        );
      } catch (error) {
        next(error);
      }
    });
    // 批量评测：202 返回 runId；已有运行返回 409；real 未配置返回 400。
    adminRouter.post('/evaluation/run', (request, response, next) => {
      const parsed = evaluationRunInput.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({
          error: parsed.error.issues.map((issue) => issue.message).join('; ') || 'invalid evaluation configuration',
        });
        return;
      }
      if (parsed.data.model === 'real' && !new DeepSeekClient().isConfigured()) {
        response.status(400).json({ error: 'real model is not configured: set DEEPSEEK_API_KEY' });
        return;
      }
      try {
        const run = evaluationRuns.start(parsed.data);
        response.status(202).json({ runId: run.runId, status: run.status });
      } catch (error) {
        if (error instanceof EvaluationRunBusyError) {
          response.status(409).json({ error: `评测已在运行：${error.activeRunId}`, activeRunId: error.activeRunId });
          return;
        }
        next(error);
      }
    });
    // 评测运行历史列表。
    adminRouter.get('/evaluation/runs', (_request, response) => {
      response.json({ runs: evaluationRuns.list() });
    });
    // 单次评测详情（运行中返回进度，结束后返回完整结果）。
    adminRouter.get('/evaluation/runs/:runId', (request, response) => {
      const run = evaluationRuns.get(request.params.runId);
      if (!run) {
        response.status(404).json({ error: 'run not found' });
        return;
      }
      response.json(run);
    });
    app.use('/api/admin', adminRouter);
  }
  // admin 未开启时所有 /api/admin 一律 404。
  app.use('/api/admin', (_request, response) => {
    response.status(404).json({ error: 'Not Found' });
  });

  if (process.env.NODE_ENV === 'production') {
    // 生产环境托管前端构建产物，非 API 的 GET 回退到 SPA index.html。
    const distDirectory = path.resolve(currentDirectory, '../../web/dist');
    app.use(express.static(distDirectory));
    app.use((request, response, next) => {
      if (request.method === 'GET' && !request.path.startsWith('/api/')) {
        response.sendFile(path.join(distDirectory, 'index.html'));
        return;
      }
      next();
    });
  }

  app.use(
    // 统一错误处理：按错误类型映射为对应的 HTTP 状态与响应结构。
    (
      error: unknown,
      _request: express.Request,
      response: express.Response,
      _next: express.NextFunction,
    ) => {
      if (error instanceof z.ZodError) {
        response.status(400).json({ error: '请求格式不正确', details: error.flatten() });
        return;
      }
      if (error instanceof GameRuleError) {
        response.status(error.status).json({ error: error.message });
        return;
      }
      if (error instanceof ModelError) {
        response.status(502).json({
          error: error.message,
          diagnostic: error.diagnostic
            ? {
                errorType: error.diagnostic.errorType,
                httpStatus: error.diagnostic.httpStatus,
                retryable: error.diagnostic.retryable,
                attempt: error.diagnostic.attempt,
              }
            : undefined,
        });
        return;
      }
      if (error instanceof DescriptionQualityError) {
        response.status(502).json({ error: error.message, violationType: error.violationType });
        return;
      }
      console.error(error);
      response.status(500).json({ error: '服务暂时出错，请稍后重试' });
    },
  );

  return {
    app,
    engine,
    // admin 句柄：测试可访问 faultModel/runtimeTrace/promptTraceStore。
    admin: adminEnabled ? { faultModel: faultModel!, runtimeTrace, promptTraceStore } : undefined,
  };
}
