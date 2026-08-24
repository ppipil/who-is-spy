import { Router } from 'express';
import type { GameModel } from '../core/model.js';
import type { PromptDebugRecord } from '../core/prompt.js';
import { listTraceRuns, replayTrace, type RuntimeTraceEvent, type TraceEventStore } from '../trace/trace.js';

interface AdminTraceRouterOptions {
  model: GameModel;
  runtimeTrace: TraceEventStore;
  promptTraceRecords: PromptDebugRecord[];
}

export function createAdminTraceRouter(options: AdminTraceRouterOptions): Router {
  const router = Router();
  const { model, runtimeTrace, promptTraceRecords } = options;

  router.get('/status', (_request, response) => {
    response.json({
      model: model.model,
      configured: model.isConfigured(),
      runtimeTrace: 'ON',
      activeGames: listTraceRuns(runtimeTrace.events).filter((run) => run.status === 'running').length,
      adminEnabled: true,
    });
  });

  router.get('/trace-runs', (request, response) => {
    const { id, sourceType } = request.query;
    let runs = listTraceRuns(runtimeTrace.events);
    if (typeof id === 'string' && id) runs = runs.filter((run) => run.runId === id || run.gameId === id);
    if (typeof sourceType === 'string' && sourceType) runs = runs.filter((run) => run.sourceType === sourceType);
    response.json({ count: runs.length, runs: runs.slice(0, 100) });
  });

  router.get('/traces/:runId/replay', (request, response) => {
    const events = runtimeTrace.events.filter((event) => event.runId === request.params.runId || event.gameId === request.params.runId);
    if (events.length === 0) { response.status(404).json({ error: 'Trace run 不存在' }); return; }
    response.json({ runId: request.params.runId, replay: replayTrace(events, request.params.runId) });
  });

  router.get('/traces', (request, response) => {
    const events = filterTraceEvents([...runtimeTrace.events], request.query);
    response.json({ count: events.length, events: events.slice(-500) });
  });

  router.get('/prompt-traces', (request, response) => {
    const records = filterPromptRecords([...promptTraceRecords], request.query);
    response.json({ count: records.length, records: records.slice(-200) });
  });

  return router;
}

function filterTraceEvents(events: RuntimeTraceEvent[], query: Record<string, unknown>): RuntimeTraceEvent[] {
  const { id, sourceType, gameId, round, agent, task, errorType, runId } = query;
  let filtered = events;
  if (typeof id === 'string' && id) {
    filtered = filtered.filter((event) => event.runId === id || event.gameId === id);
  }
  if (typeof sourceType === 'string' && sourceType) {
    filtered = filtered.filter((event) => event.sourceType === sourceType);
  }
  if (typeof gameId === 'string' && gameId) filtered = filtered.filter((event) => event.gameId === gameId);
  if (typeof runId === 'string' && runId) {
    filtered = filtered.filter((event) => event.runId === runId || event.gameId === runId);
  }
  if (typeof round === 'string' && round) filtered = filtered.filter((event) => event.round === Number(round));
  if (typeof agent === 'string' && agent) {
    filtered = filtered.filter((event) => 'agentId' in event && event.agentId === agent);
  }
  if (typeof task === 'string' && task) {
    filtered = filtered.filter((event) => 'task' in event && event.task === task);
  }
  if (typeof errorType === 'string' && errorType) {
    filtered = filtered.filter((event) => 'errorType' in event && event.errorType === errorType);
  }
  return filtered;
}

function filterPromptRecords(records: PromptDebugRecord[], query: Record<string, unknown>): PromptDebugRecord[] {
  const { id, gameId, round, agentId, task, runId } = query;
  let filtered = records;
  if (typeof id === 'string' && id) {
    filtered = filtered.filter((record) => record.runId === id || record.gameId === id);
  }
  if (typeof gameId === 'string' && gameId) filtered = filtered.filter((record) => record.gameId === gameId);
  if (typeof runId === 'string' && runId) {
    filtered = filtered.filter((record) => record.runId === runId || record.gameId === runId);
  }
  if (typeof round === 'string' && round) filtered = filtered.filter((record) => record.round === Number(round));
  if (typeof agentId === 'string' && agentId) filtered = filtered.filter((record) => record.agentId === agentId);
  if (typeof task === 'string' && task) filtered = filtered.filter((record) => record.task === task);
  return filtered;
}