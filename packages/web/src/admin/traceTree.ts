import type { GameVotesPayload, PromptTraceRecord, RuntimeEvent } from './adminApi';

export type ObservationKind =
  | 'human'
  | 'agent'
  | 'generation'
  | 'quality_gate'
  | 'retry'
  | 'commit'
  | 'atomic_commit'
  | 'resume'
  | 'error'
  | 'fallback'
  | 'event'
  | 'review';

export interface TraceObservation {
  id: string;
  kind: ObservationKind;
  title: string;
  status: 'ok' | 'fail' | 'warn' | 'neutral';
  detail?: string;
  output?: string;
  durationMs?: number;
  event?: RuntimeEvent;
  prompt?: PromptTraceRecord;
  children: TraceObservation[];
}

export interface TraceItem {
  id: string;
  name: string;
  status: 'ok' | 'fail' | 'warn' | 'neutral';
  durationMs: number;
  round?: number;
  task: 'description' | 'vote' | 'review' | 'resume';
  tree: TraceObservation;
}

export interface TraceSession {
  id: string;
  startedAt: string;
  traces: TraceItem[];
}

/** 来源/模型的展示标签（中文）。 */
export const SOURCE_LABELS: Record<string, string> = {
  USER_GAME: '真人对局',
  ADMIN_PROBE: '管理员实验',
  EVAL_RUN: '自动评测',
  CLI_DEMO: '控制台演示',
  TEST: '工程测试',
};

export const MODEL_LABELS: Record<string, string> = {
  real: 'Real',
  fake: 'Fake',
  none: '—',
};

/** 从 Session 的事件中统计最主要的来源/入口/模型类型（旧数据无标记时为 undefined）。 */
export function sessionOrigin(session: TraceSession): {
  sourceType?: string;
  entrypoint?: string;
  modelKind?: string;
} {
  const sourceCount = new Map<string, number>();
  const entrypointCount = new Map<string, number>();
  const modelCount = new Map<string, number>();
  const visit = (node: TraceObservation): void => {
    const event = node.event as (RuntimeEvent & {
      sourceType?: string;
      entrypoint?: string;
      modelKind?: string;
    }) | undefined;
    if (event) {
      if (event.sourceType) sourceCount.set(event.sourceType, (sourceCount.get(event.sourceType) ?? 0) + 1);
      if (event.entrypoint) entrypointCount.set(event.entrypoint, (entrypointCount.get(event.entrypoint) ?? 0) + 1);
      if (event.modelKind) modelCount.set(event.modelKind, (modelCount.get(event.modelKind) ?? 0) + 1);
    }
    for (const child of node.children) visit(child);
  };
  for (const trace of session.traces) visit(trace.tree);
  const top = (map: Map<string, number>): string | undefined =>
    [...map.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];
  return {
    sourceType: top(sourceCount),
    entrypoint: top(entrypointCount),
    modelKind: top(modelCount),
  };
}

export function mergeVoteOutputs(
  sessions: TraceSession[],
  votesByGame: Map<string, GameVotesPayload>,
): TraceSession[] {
  if (votesByGame.size === 0) return sessions;
  for (const session of sessions) {
    const payload = votesByGame.get(session.id);
    if (!payload) continue;
    const nameById = new Map(payload.players.map((player) => [player.id, player.name]));
    for (const trace of session.traces) {
      visit(trace.tree, (node) => {
        if (node.kind !== 'generation' || node.event?.task !== 'vote') return;
        const vote = payload.votes.find(
          (item) =>
            item.voterId === node.event?.agentId && item.round === Number(node.event?.round),
        );
        if (vote) {
          node.output = `→ ${nameById.get(vote.targetId) ?? vote.targetId}：${vote.reason}`;
        }
      });
    }
  }
  return sessions;
}

function visit(node: TraceObservation, fn: (node: TraceObservation) => void): void {
  fn(node);
  for (const child of node.children) visit(child, fn);
}

function nodeSelfText(node: TraceObservation): string {
  return [
    node.title,
    node.detail ?? '',
    node.output ?? '',
    node.event ? JSON.stringify(node.event) : '',
    ...(node.prompt?.messages ?? []).map((message) => message.content),
  ]
    .join('\n')
    .toLowerCase();
}

export function filterTreeByKeyword(
  node: TraceObservation,
  keyword: string,
): TraceObservation | null {
  const normalized = keyword.trim().toLowerCase();
  if (!normalized) return node;
  const children = node.children
    .map((child) => filterTreeByKeyword(child, normalized))
    .filter((child): child is TraceObservation => child !== null);
  const selfMatch = nodeSelfText(node).includes(normalized);
  if (!selfMatch && children.length === 0) return null;
  return { ...node, children };
}

export function filterSessionsByKeyword(
  sessions: TraceSession[],
  keyword: string,
): TraceSession[] {
  const normalized = keyword.trim();
  if (!normalized) return sessions;
  const result: TraceSession[] = [];
  for (const session of sessions) {
    const traces: TraceItem[] = [];
    for (const trace of session.traces) {
      const tree = filterTreeByKeyword(trace.tree, normalized);
      if (tree) traces.push({ ...trace, tree });
    }
    if (traces.length > 0) result.push({ ...session, traces });
  }
  return result;
}

const AGENT_ORDER = ['ai-1', 'ai-2', 'ai-3', 'ai-4'];
const PERSONA_NAMES: Record<string, string> = {
  cautious: '谨慎观察',
  intuitive: '直觉敏锐',
  analytical: '逻辑派',
  contrarian: '出其不意',
};

const BACKOFF_MS = 600;
const DUPLICATE_THRESHOLD = 0.72;

function statusOf(outcome: string): 'ok' | 'fail' | 'warn' | 'neutral' {
  if (outcome === 'success') return 'ok';
  if (outcome === 'failure') return 'fail';
  if (outcome === 'fallback') return 'warn';
  return 'neutral';
}

function personaName(strategyId: unknown): string {
  return typeof strategyId === 'string' ? (PERSONA_NAMES[strategyId] ?? strategyId) : '—';
}

function traceDuration(events: RuntimeEvent[]): number {
  let total = 0;
  for (const event of events) {
    const latency = Number(event.latencyMs);
    if (Number.isFinite(latency) && latency > 0) total += latency;
  }
  if (total > 0) return Math.round(total);
  if (events.length >= 2) {
    const first = new Date(events[0].timestamp).getTime();
    const last = new Date(events[events.length - 1].timestamp).getTime();
    if (Number.isFinite(first) && Number.isFinite(last) && last >= first) return last - first;
  }
  return 0;
}

function findPrompt(
  records: PromptTraceRecord[],
  gameId: string,
  round: number,
  agentId: string,
  task: string,
  index = 0,
): PromptTraceRecord | undefined {
  const matched = records
    .filter(
      (record) =>
        record.gameId === gameId && record.round === round && record.agentId === agentId && record.task === task,
    )
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  return matched[index] ?? matched[matched.length - 1];
}

function buildDescriptionTree(
  gameId: string,
  round: number,
  events: RuntimeEvent[],
  prompts: PromptTraceRecord[],
): TraceObservation {
  const children: TraceObservation[] = [];
  const commits = events.filter(
    (event) => event.eventType === 'public_event' && event.publicEventType === 'description' && event.round === round,
  );
  const humanCommit = commits.find((event) => event.agentId === 'human') ?? commits[0];
  if (humanCommit) {
    children.push({
      id: `${gameId}-r${round}-human-commit`,
      kind: 'human',
      title: 'Human description',
      status: 'ok',
      detail: String(humanCommit.text ?? ''),
      event: humanCommit,
      children: [],
    });
  }

  for (const agentId of AGENT_ORDER) {
    const generations = events.filter(
      (event) =>
        event.eventType === 'model_call' &&
        event.task === 'describe' &&
        event.round === round &&
        event.agentId === agentId,
    );
    const gates = events.filter(
      (event) => event.eventType === 'quality_violation' && event.round === round && event.agentId === agentId,
    );
    const commit = commits.find((event) => event.agentId === agentId);
    if (generations.length === 0 && gates.length === 0 && !commit) continue;

    const first = generations[0];
    const agentName = first?.agentName ? String(first.agentName) : agentId;
    const strategyId = first?.strategyId;
    const agentChildren: TraceObservation[] = [];
    let finalFailed = false;
    let lastSuccessGen: TraceObservation | undefined;
    for (const generation of generations) {
      const attempt = Number(generation.attempt ?? 1);
      const prompt = findPrompt(prompts, gameId, round, agentId, 'describe', attempt - 1);
      const genNode: TraceObservation = {
        id: `${gameId}-r${round}-${agentId}-gen-${attempt}`,
        kind: 'generation',
        title: `Generation · attempt ${attempt}`,
        status: statusOf(String(generation.outcome)),
        detail: generation.errorType ? String(generation.errorType) : undefined,
        durationMs: Number(generation.latencyMs),
        event: generation,
        prompt,
        children: [],
      };
      agentChildren.push(genNode);
      if (generation.outcome === 'success') lastSuccessGen = genNode;
      const gate = gates.find((item) => Number(item.attempt) === attempt);
      if (gate) {
        agentChildren.push({
          id: `${gameId}-r${round}-${agentId}-gate-${attempt}`,
          kind: 'quality_gate',
          title: `Quality Gate · ${gate.willRetry ? 'REJECT' : 'BLOCK'}`,
          status: 'fail',
          detail: String(gate.violationType),
          event: gate,
          children: [],
        });
      }
      if (generation.outcome === 'failure') {
        finalFailed = true;
        if (generation.willRetry) {
          agentChildren.push({
            id: `${gameId}-r${round}-${agentId}-retry-${attempt}`,
            kind: 'retry',
            title: 'Retry',
            status: 'warn',
            detail: `backoff ${BACKOFF_MS}ms`,
            event: generation,
            children: [],
          });
        }
      }
    }
    if (commit) {
      if (lastSuccessGen) lastSuccessGen.output = String(commit.text ?? '');
      agentChildren.push({
        id: `${gameId}-r${round}-${agentId}-commit`,
        kind: 'commit',
        title: 'Commit',
        status: 'ok',
        detail: String(commit.text ?? ''),
        event: commit,
        children: [],
      });
      finalFailed = false;
    } else if (finalFailed) {
      agentChildren.push({
        id: `${gameId}-r${round}-${agentId}-failed`,
        kind: 'error',
        title: 'Description Failed',
        status: 'fail',
        children: [],
      });
    }
    children.push({
      id: `${gameId}-r${round}-${agentId}-agent`,
      kind: 'agent',
      title: `${agentName} · ${personaName(strategyId)}`,
      status: commit ? 'ok' : finalFailed ? 'fail' : 'neutral',
      children: agentChildren,
    });
  }
  return {
    id: `${gameId}-r${round}-description`,
    kind: 'event',
    title: `R${round} · Description`,
    status: children.some((child) => child.status === 'fail') ? 'fail' : 'ok',
    children,
  };
}

function buildVoteTree(
  gameId: string,
  round: number,
  events: RuntimeEvent[],
  prompts: PromptTraceRecord[],
): TraceObservation {
  const children: TraceObservation[] = [];
  const generations = events.filter(
    (event) => event.eventType === 'model_call' && event.task === 'vote' && event.round === round,
  );
  for (const agentId of AGENT_ORDER) {
    const generation = generations.find((event) => event.agentId === agentId);
    if (!generation) continue;
    const attempt = Number(generation.attempt ?? 1);
    const prompt = findPrompt(prompts, gameId, round, agentId, 'vote', attempt - 1);
    children.push({
      id: `${gameId}-r${round}-${agentId}-vote`,
      kind: 'agent',
      title: `${String(generation.agentName ?? agentId)} · Vote`,
      status: statusOf(String(generation.outcome)),
      children: [
        {
          id: `${gameId}-r${round}-${agentId}-vote-gen`,
          kind: 'generation',
          title: `Generation ${generation.outcome === 'success' ? '✓' : '✕'}`,
          status: statusOf(String(generation.outcome)),
          durationMs: Number(generation.latencyMs),
          event: generation,
          prompt,
          children: [],
        },
      ],
    });
  }
  const resolution = events.find(
    (event) =>
      event.eventType === 'public_event' &&
      event.round === round &&
      (event.publicEventType === 'vote_result' || event.publicEventType === 'elimination'),
  );
  const anyFailed = generations.some((event) => event.outcome === 'failure');
  const committed = Boolean(resolution) && !anyFailed;
  children.push({
    id: `${gameId}-r${round}-vote-commit`,
    kind: 'atomic_commit',
    title: 'Atomic Commit',
    status: committed ? 'ok' : 'fail',
    detail: committed
      ? `✓ ${generations.length}/${generations.length} 已提交`
      : anyFailed
        ? `✕ NOT COMMITTED（${generations.filter((event) => event.outcome === 'failure').length} 个 vote 失败）`
        : '✕ NOT COMMITTED（无结算事件）',
    event: resolution,
    children: [],
  });
  return {
    id: `${gameId}-r${round}-vote`,
    kind: 'event',
    title: `R${round} · Vote`,
    status: committed ? 'ok' : 'fail',
    children,
  };
}

function buildReviewTree(gameId: string, events: RuntimeEvent[], prompts: PromptTraceRecord[]): TraceObservation {
  const children: TraceObservation[] = [];
  const reviewCalls = events.filter(
    (event) => event.eventType === 'model_call' && event.task === 'review',
  );
  for (const call of reviewCalls) {
    const prompt = findPrompt(prompts, gameId, Number(call.round ?? 0), 'review', 'review', 0);
    const fallback = call.outcome === 'fallback';
    children.push({
      id: `${gameId}-review-${Number(call.sequence ?? 0)}`,
      kind: 'review',
      title: 'Review Generation',
      status: fallback ? 'fail' : statusOf(String(call.outcome)),
      durationMs: Number(call.latencyMs),
      event: call,
      prompt,
      children: fallback
        ? [
            {
              id: `${gameId}-review-fallback`,
              kind: 'fallback',
              title: 'Local Fallback ✓',
              status: 'ok',
              detail: 'Review 不影响胜负状态，因此允许本地降级。',
              children: [],
            },
          ]
        : [],
    });
  }
  return {
    id: `${gameId}-final-review`,
    kind: 'event',
    title: 'Final Review',
    status: reviewCalls.every((call) => call.outcome === 'fallback' || call.outcome === 'failure') ? 'warn' : 'ok',
    children,
  };
}

function buildResumeTrace(gameId: string, round: number, events: RuntimeEvent[]): TraceItem {
  const resumes = events.filter(
    (event) => event.eventType === 'recovery_action' && event.round === round,
  );
  const outcome = resumes.find((event) => event.recoveryOutcome === 'exhausted')
    ? 'fail'
    : resumes.some((event) => event.recoveryOutcome === 'recovered')
      ? 'ok'
      : 'neutral';
  const children = resumes.map((event) => ({
    id: `${gameId}-resume-${round}-${Number(event.sequence ?? 0)}`,
    kind: 'resume' as const,
    title: `Resume · ${String(event.agentId ?? '')}`,
    status: (event.recoveryOutcome === 'exhausted' ? 'fail' : event.recoveryOutcome === 'recovered' ? 'ok' : 'warn') as
      | 'ok'
      | 'fail'
      | 'warn',
    detail: `missingAgent=${String(event.agentId ?? '')} · manualResumeIndex=${Number(event.manualResumeIndex ?? 1)} · remaining=${Number(
      event.manualRetriesRemaining ?? 0,
    )}`,
    event,
    children: [],
  }));
  return {
    id: `${gameId}-resume-${round}`,
    name: `Description Resume · R${round}`,
    status: outcome,
    durationMs: traceDuration(resumes),
    round,
    task: 'resume',
    tree: {
      id: `${gameId}-resume-${round}-root`,
      kind: 'event',
      title: `Description Resume · R${round}`,
      status: outcome,
      children,
    },
  };
}

export function buildTraceSessions(
  events: RuntimeEvent[],
  prompts: PromptTraceRecord[],
): TraceSession[] {
  const byGame = new Map<string, RuntimeEvent[]>();
  for (const event of events) {
    const list = byGame.get(event.gameId) ?? [];
    list.push(event);
    byGame.set(event.gameId, list);
  }
  const sessions: TraceSession[] = [];
  for (const [gameId, rawEvents] of byGame) {
    const sorted = [...rawEvents].sort(
      (left, right) =>
        Number(left.sequence ?? 0) - Number(right.sequence ?? 0) ||
        left.timestamp.localeCompare(right.timestamp),
    );
    const traces: TraceItem[] = [];
    const rounds = [...new Set(sorted.map((event) => Number(event.round ?? 0)).filter((round) => round > 0))].sort(
      (left, right) => left - right,
    );
    for (const round of rounds) {
      const describeEvents = sorted.filter(
        (event) =>
          event.round === round &&
          (event.eventType === 'model_call' ||
            event.eventType === 'prompt_provenance' ||
            event.eventType === 'quality_violation' ||
            event.eventType === 'public_event') &&
          (event.task === 'describe' ||
            event.publicEventType === 'description' ||
            event.eventType === 'quality_violation'),
      );
      const voteEvents = sorted.filter(
        (event) =>
          event.round === round &&
          (event.task === 'vote' ||
            event.publicEventType === 'vote_result' ||
            event.publicEventType === 'elimination'),
      );
      if (describeEvents.length > 0) {
        const tree = buildDescriptionTree(gameId, round, describeEvents, prompts);
        traces.push({
          id: `${gameId}-r${round}-description`,
          name: `R${round} · Description`,
          status: tree.status,
          durationMs: traceDuration(describeEvents),
          round,
          task: 'description',
          tree,
        });
      }
      if (voteEvents.length > 0) {
        const tree = buildVoteTree(gameId, round, voteEvents, prompts);
        traces.push({
          id: `${gameId}-r${round}-vote`,
          name: `R${round} · Vote`,
          status: tree.status,
          durationMs: traceDuration(voteEvents),
          round,
          task: 'vote',
          tree,
        });
      }
      const resumeEvents = sorted.filter(
        (event) => event.eventType === 'recovery_action' && event.round === round,
      );
      if (resumeEvents.length > 0) {
        traces.push(buildResumeTrace(gameId, round, sorted));
      }
    }
    if (sorted.some((event) => event.task === 'review' || (event.eventType === 'model_call' && event.task === 'review'))) {
      const reviewEvents = sorted.filter((event) => event.task === 'review');
      const tree = buildReviewTree(gameId, reviewEvents, prompts);
      traces.push({
        id: `${gameId}-final-review`,
        name: 'Final Review',
        status: tree.status,
        durationMs: traceDuration(reviewEvents),
        task: 'review',
        tree,
      });
    }
    sessions.push({
      id: gameId,
      startedAt: sorted[0]?.timestamp ?? '',
      traces,
    });
  }
  return sessions.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}
