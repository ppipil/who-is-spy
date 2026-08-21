import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runEvaluation } from './evaluation.js';
import type { PromptDebugRecord } from './prompt.js';
import { readPromptTraceJsonl, writePromptTraceJsonl } from './prompt.js';
import {
  EvaluationRunStore,
  type EvaluationRunner,
} from './admin/evaluation-runs.js';
import {
  InMemoryTraceSink,
  JsonlTraceSink,
  readJsonlTrace,
} from './trace.js';

let tempDir = '';

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-persist-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('trace JSONL persistence', () => {
  it('continues sequence after preloading history and appends full events without duplicates', () => {
    const file = path.join(tempDir, 'trace.jsonl');
    const jsonl = new JsonlTraceSink(file);
    const first = new InMemoryTraceSink([], (full) => jsonl.recordFull(full));
    first.record({
      eventType: 'public_event',
      gameId: 'g1',
      round: 1,
      phase: 'describing',
      publicEventType: 'description',
      text: '第一条',
      outcome: 'success',
    });
    expect(first.events[0].sequence).toBe(1);

    // 模拟重启：从文件恢复，新事件 sequence 从历史最大值继续
    const second = new InMemoryTraceSink(readJsonlTrace(file), (full) => jsonl.recordFull(full));
    expect(second.events).toHaveLength(1);
    second.record({
      eventType: 'public_event',
      gameId: 'g1',
      round: 1,
      phase: 'voting',
      publicEventType: 'vote_result',
      text: '被投出局',
      outcome: 'success',
    });
    expect(second.events[1].sequence).toBe(2);

    const reloaded = readJsonlTrace(file);
    expect(reloaded.map((event) => event.sequence)).toEqual([1, 2]);
  });

  it('skips corrupt lines instead of failing the whole read', () => {
    const file = path.join(tempDir, 'corrupt.jsonl');
    fs.writeFileSync(file, '{"eventType":"public_event"}\nnot-json-line\n', 'utf8');
    const events = readJsonlTrace(file);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('public_event');
  });
});

describe('prompt trace JSONL persistence', () => {
  it('round-trips sanitized records and skips corrupt lines', () => {
    const file = path.join(tempDir, 'prompt.jsonl');
    const record: PromptDebugRecord = {
      timestamp: '2026-08-21T00:00:00.000Z',
      gameId: 'g1',
      round: 1,
      task: 'describe',
      agentId: 'ai-1',
      role: 'civilian',
      strategyId: 'cautious',
      promptTemplateVersion: 'describe-v3',
      promptHash: 'abc123',
      publicDescriptionCount: 1,
      sameRoundPublicDescriptionCount: 1,
      messages: [
        { role: 'system', content: 'system text' },
        { role: 'user', content: '{"context":{}}' },
      ],
    };
    writePromptTraceJsonl(file, record);
    fs.appendFileSync(file, 'broken-line\n', 'utf8');
    const loaded = readPromptTraceJsonl(file);
    expect(loaded).toEqual([record]);
  });
});

describe('evaluation run history persistence', () => {
  it('restores run summaries after recreating the store and keeps the 20-run cap', async () => {
    const file = path.join(tempDir, 'runs.json');
    const runner: EvaluationRunner = async ({ onProgress }) => {
      onProgress({ completedGames: 1, totalGames: 1 });
      return runEvaluation({ games: 1, seed: 42, modelKind: 'fake' });
    };
    const store1 = new EvaluationRunStore(runner, { filePath: file });
    const run = store1.start({ games: 1, seed: 42, model: 'fake' });
    for (let i = 0; i < 100 && run.status === 'running'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(run.status).toBe('completed');
    expect(run.gate?.passed).toBe(true);

    const store2 = new EvaluationRunStore(runner, { filePath: file });
    const restored = store2.list();
    expect(restored).toHaveLength(1);
    expect(restored[0].runId).toBe(run.runId);
    expect(restored[0].gate?.passed).toBe(true);
    expect(restored[0].metrics?.completionRate).toBe(1);
    expect(restored[0].result).toBeUndefined();
  });

  it('caps restored history at 20 runs and tolerates corrupt files', async () => {
    const file = path.join(tempDir, 'runs-corrupt.jsonl');
    fs.writeFileSync(file, 'not-json', 'utf8');
    const runner: EvaluationRunner = async ({ onProgress }) => {
      onProgress({ completedGames: 1, totalGames: 1 });
      return runEvaluation({ games: 1, seed: 42, modelKind: 'fake' });
    };
    const corrupt = new EvaluationRunStore(runner, { filePath: file });
    expect(corrupt.list()).toHaveLength(0);

    const goodFile = path.join(tempDir, 'runs.json');
    const store = new EvaluationRunStore(runner, { filePath: goodFile });
    for (let i = 0; i < 25; i += 1) {
      const r = store.start({ games: 1, seed: 42, model: 'fake' });
      for (let j = 0; j < 100 && r.status === 'running'; j += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    const reloaded = new EvaluationRunStore(runner, { filePath: goodFile });
    expect(reloaded.list()).toHaveLength(20);
  });
});
