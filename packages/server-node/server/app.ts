import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { z } from 'zod';
import { GameEngine, GameRuleError } from './game-engine.js';
import { DeepSeekClient, ModelError, type GameModel } from './model.js';

const descriptionInput = z.object({ text: z.string() });
const voteInput = z.object({ targetId: z.string().min(1) });

export function createApp(model: GameModel = new DeepSeekClient()) {
  const app = express();
  const engine = new GameEngine(model);
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

  app.post('/api/games/:id/describe', async (request, response, next) => {
    try {
      const input = descriptionInput.parse(request.body);
      response.json(await engine.submitHumanDescription(request.params.id, input.text));
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
        response.status(502).json({ error: error.message });
        return;
      }
      console.error(error);
      response.status(500).json({ error: '服务暂时出错，请稍后重试' });
    },
  );

  return { app, engine };
}
