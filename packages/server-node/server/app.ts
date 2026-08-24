import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { z } from 'zod';
import { createAdminEvaluationRouter } from './admin/evaluation-routes.js';
import { createAdminFaultRouter } from './admin/fault-routes.js';
import { createAdminTraceRouter } from './admin/trace-routes.js';
import { DescriptionQualityError } from './core/description-quality.js';
import { GameEngine, GameRuleError } from './core/game-engine.js';
import { DeepSeekClient, ModelError, type GameModel } from './core/model.js';
import { setPromptDebugCollector, type PromptDebugRecord } from './core/prompt.js';
import { CompositeTraceSink, InMemoryTraceSink, createAdminRuntimeTraceSink, createTraceSinkFromEnv, stampTraceOrigin } from './trace/trace.js';

const descriptionInput = z.object({ text: z.string() });
const voteInput = z.object({ targetId: z.string().min(1) });

export function createApp(model: GameModel = new DeepSeekClient()) {
  const app = express();
  const adminConsoleEnabled = process.env.ENABLE_ADMIN_CONSOLE !== '0';
  const runtimeTrace = adminConsoleEnabled ? createAdminRuntimeTraceSink() : new InMemoryTraceSink();
  const promptTraceRecords: PromptDebugRecord[] = [];
  const envTrace = createTraceSinkFromEnv();
  const traceSink = stampTraceOrigin(
    envTrace ? new CompositeTraceSink([runtimeTrace, envTrace]) : runtimeTrace,
    { sourceType: 'USER_GAME', entrypoint: 'web', modelKind: model.model === 'fake' ? 'fake' : model.isConfigured() ? 'real' : 'none' },
  );
  setPromptDebugCollector((record) => {
    promptTraceRecords.push(record);
    if (promptTraceRecords.length > 500) promptTraceRecords.splice(0, promptTraceRecords.length - 500);
  });
  const engine = new GameEngine(model, Math.random, undefined, traceSink, {
    sourceType: 'USER_GAME',
    entrypoint: 'web',
    modelKind: model.model === 'fake' ? 'fake' : model.isConfigured() ? 'real' : 'none',
  });
  const progressStreams = new Map<string, Set<express.Response>>();
  engine.subscribeToPublicProgress((event) => {
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const stream of progressStreams.get(event.gameId) ?? []) stream.write(payload);
  });
  app.use(express.json({ limit: '16kb' }));

  app.get('/api/health', (_request, response) => {
    response.json({
      ok: true,
      model: model.model,
      configured: model.isConfigured(),
    });
  });

  app.post('/api/games', (_request, response) => {
    response.status(201).json(engine.createGame());
  });

  app.get('/api/games/:id', (request, response, next) => {
    try {
      response.json(engine.getGame(request.params.id));
    } catch (error) {
      next(error);
    }
  });

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

  app.post('/api/games/:id/describe', async (request, response, next) => {
    try {
      const input = descriptionInput.parse(request.body);
      response.json(await engine.submitHumanDescription(request.params.id, input.text));
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/games/:id/description/resume', async (request, response, next) => {
    try {
      response.json(await engine.resumeDescription(request.params.id));
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/games/:id/vote', async (request, response, next) => {
    try {
      const input = voteInput.parse(request.body);
      response.json(await engine.submitHumanVote(request.params.id, input.targetId));
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/games/:id/continue', async (request, response, next) => {
    try {
      response.json(await engine.continueAsSpectator(request.params.id));
    } catch (error) {
      next(error);
    }
  });

  if (adminConsoleEnabled) {
    app.use('/api/admin', createAdminTraceRouter({ model, runtimeTrace, promptTraceRecords }));
    app.use('/api/admin', createAdminEvaluationRouter(model, runtimeTrace));
    app.use('/api/admin', createAdminFaultRouter(runtimeTrace));
  } else {
    app.use('/api/admin', (_request, response) => response.status(404).json({ error: 'admin console disabled' }));
  }
  if (process.env.NODE_ENV === 'production') {
    const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
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

  return { app, engine };
}
