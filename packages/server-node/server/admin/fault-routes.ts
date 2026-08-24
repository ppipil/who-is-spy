import { Router } from 'express';
import { z } from 'zod';
import { FaultDemoService, FaultDemoSessionError, faultDemoScenarios } from '../fault/fault-demo.js';
import type { TraceEventStore } from '../trace/trace.js';

const runInput = z.object({ scenario: z.enum(['describe-timeout', 'describe-bad-json', 'review-failure']) });

export function createAdminFaultRouter(runtimeTrace: TraceEventStore): Router {
  const router = Router();
  const service = new FaultDemoService(runtimeTrace);
  router.get('/fault-demos', (_request, response) => response.json({ scenarios: faultDemoScenarios }));
  router.post('/fault-demos/run', async (request, response, next) => {
    try { response.status(201).json(await service.start(runInput.parse(request.body).scenario)); }
    catch (error) { next(error); }
  });
  router.post('/fault-demos/:runId/recover', async (request, response, next) => {
    try { response.json(await service.recover(request.params.runId)); }
    catch (error) {
      if (error instanceof FaultDemoSessionError) { response.status(404).json({ error: error.message }); return; }
      next(error);
    }
  });
  return router;
}
