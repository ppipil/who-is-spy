import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { z } from 'zod';
import { DescriptionQualityError } from './description-quality.js';
import { GameEngine, GameRuleError } from './game-engine.js';
import { DeepSeekClient, ModelError, type GameModel } from './model.js';
import { setPromptDebugCollector, type PromptDebugRecord } from './prompt.js';
import { CompositeTraceSink, InMemoryTraceSink, createTraceSinkFromEnv, listTraceRuns, stampTraceOrigin } from './trace.js';

const descriptionInput = z.object({ text: z.string() });
const voteInput = z.object({ targetId: z.string().min(1) });

export function createApp(model: GameModel = new DeepSeekClient()) {
  const app = express();
  const runtimeTrace = new InMemoryTraceSink();
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
  const engine = new GameEngine(model, Math.random, undefined, traceSink);
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

  if (process.env.ENABLE_ADMIN_CONSOLE === '1') {
    app.get('/api/admin/status', (_request, response) => {
      response.json({
        model: model.model,
        configured: model.isConfigured(),
        runtimeTrace: 'ON',
        activeGames: listTraceRuns(runtimeTrace.events).filter((run) => run.status === 'running').length,
        adminEnabled: true,
      });
    });

    app.get('/api/admin/traces', (request, response) => {
      let events = [...runtimeTrace.events];
      const { gameId, round, agent, task, errorType, runId } = request.query;
      if (typeof gameId === 'string' && gameId) events = events.filter((event) => event.gameId === gameId);
      if (typeof runId === 'string' && runId) events = events.filter((event) => event.runId === runId || event.gameId === runId);
      if (typeof round === 'string' && round) events = events.filter((event) => event.round === Number(round));
      if (typeof agent === 'string' && agent) events = events.filter((event) => 'agentId' in event && event.agentId === agent);
      if (typeof task === 'string' && task) events = events.filter((event) => 'task' in event && event.task === task);
      if (typeof errorType === 'string' && errorType) {
        events = events.filter((event) => 'errorType' in event && event.errorType === errorType);
      }
      response.json({ count: events.length, events: events.slice(-500) });
    });

    app.get('/api/admin/prompt-traces', (request, response) => {
      let records = [...promptTraceRecords];
      const { gameId, round, agentId, task, runId } = request.query;
      if (typeof gameId === 'string' && gameId) records = records.filter((record) => record.gameId === gameId);
      if (typeof runId === 'string' && runId) records = records.filter((record) => record.runId === runId || record.gameId === runId);
      if (typeof round === 'string' && round) records = records.filter((record) => record.round === Number(round));
      if (typeof agentId === 'string' && agentId) records = records.filter((record) => record.agentId === agentId);
      if (typeof task === 'string' && task) records = records.filter((record) => record.task === task);
      response.json({ count: records.length, records: records.slice(-200) });
    });
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
