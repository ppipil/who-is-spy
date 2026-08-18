#!/usr/bin/env node
// 语言无关黑盒契约测试。
//
//   node contract/run.mjs node   # 对 packages/server-node 打
//   node contract/run.mjs go     # 对 packages/server-go 打
//
// 它只验证「基线硬门槛」(见 CONTRACT.md),不断言候选人二次开发的内部实现。
// 任一后端 + 候选人改动后都必须持续通过。任一断言失败 -> 进程非 0 退出。

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import process from 'node:process';

const target = process.argv[2] ?? 'node';
const PORT = Number(process.env.CONTRACT_PORT ?? 8790);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = new URL('..', import.meta.url).pathname;

const backends = {
  node: {
    cmd: 'npx',
    args: ['tsx', 'server/index.ts'],
    cwd: `${ROOT}packages/server-node`,
  },
  go: {
    cmd: 'go',
    args: ['run', '.'],
    cwd: `${ROOT}packages/server-go`,
  },
};

const backend = backends[target];
if (!backend) {
  console.error(`未知后端「${target}」,可选:node | go`);
  process.exit(2);
}

// ---- 迷你断言框架 ----
let passed = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function api(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { status: response.status, body: payload };
}

const SECRET_FIELDS = ['role', 'word'];
const REVEAL_FIELDS = ['revealedRole', 'revealedWord'];

function hasNoSecrets(player) {
  return SECRET_FIELDS.every((field) => !(field in player));
}
function hasNoReveal(player) {
  return REVEAL_FIELDS.every((field) => !(field in player));
}

async function waitForHealth(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return true;
    } catch {
      // not up yet
    }
    await sleep(400);
  }
  return false;
}

async function createCivilianHumanGame(maxAttempts = 20) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const created = await api('POST', '/api/games');
    if (created.status !== 201) return created;
    if (created.body?.human?.role === 'civilian') return created;
  }
  throw new Error(`连续 ${maxAttempts} 次开局都未得到平民人类玩家`);
}

async function runContract() {
  console.log(`\n契约:健康与就绪`);
  const health = await api('GET', '/api/health');
  check('GET /api/health 返回 200', health.status === 200, `status=${health.status}`);
  check('health.ok === true', health.body?.ok === true);
  check('health.model 是非空字符串', typeof health.body?.model === 'string' && health.body.model.length > 0);
  check('health.configured 是布尔值', typeof health.body?.configured === 'boolean');

  console.log(`\n契约:开局与信息隔离(终局前)`);
  // 后续固定验证“人类出局后继续观战”路径。随机发牌时先挑选人类为平民的对局,
  // 避免人类恰为卧底并被淘汰后直接终局,导致断言数量在 27/28 之间波动。
  const created = await createCivilianHumanGame();
  check('POST /api/games 返回 201', created.status === 201, `status=${created.status}`);
  const game = created.body ?? {};
  check('玩家数为 5', Array.isArray(game.players) && game.players.length === 5);
  check(
    '恰好 1 名人类玩家',
    Array.isArray(game.players) && game.players.filter((p) => p.isHuman).length === 1,
  );
  check(
    '终局前所有玩家不含 role/word',
    Array.isArray(game.players) && game.players.every(hasNoSecrets),
  );
  check(
    '终局前所有玩家不含 revealedRole/revealedWord',
    Array.isArray(game.players) && game.players.every(hasNoReveal),
  );
  check('human 携带自己的身份与密词', typeof game.human?.word === 'string' && game.human.word.length > 0);
  check('初始阶段为 describing', game.phase === 'describing');
  const gameId = game.id;
  const humanWord = game.human?.word;

  console.log(`\n契约:描述阶段校验`);
  const reveal = await api('POST', `/api/games/${gameId}/describe`, { text: `答案就是${humanWord}` });
  check('直接说出密词被拒绝(4xx)', reveal.status >= 400 && reveal.status < 500, `status=${reveal.status}`);
  check('拒绝时返回可读 error', typeof reveal.body?.error === 'string');

  const tooShort = await api('POST', `/api/games/${gameId}/describe`, { text: '一' });
  check('过短描述被拒绝(4xx)', tooShort.status >= 400 && tooShort.status < 500, `status=${tooShort.status}`);

  const described = await api('POST', `/api/games/${gameId}/describe`, { text: '这是一段合规的中文描述' });
  check('合规描述被接受(200)', described.status === 200, `status=${described.status}`);
  check('进入 voting 阶段', described.body?.phase === 'voting');
  check(
    '本轮公开描述含 5 条(1 人类 + 4 AI)',
    Array.isArray(described.body?.descriptions) &&
      described.body.descriptions.filter((d) => d.round === 1).length === 5,
  );
  check(
    '描述阶段公开 DTO 仍不泄露 role/word',
    Array.isArray(described.body?.players) && described.body.players.every(hasNoSecrets),
  );

  console.log(`\n契约:非法请求处理`);
  const badVote = await api('POST', `/api/games/${gameId}/vote`, { targetId: '' });
  check('空 targetId 返回 400', badVote.status === 400, `status=${badVote.status}`);
  const missing = await api('GET', `/api/games/does-not-exist`);
  check('不存在的对局返回 404', missing.status === 404, `status=${missing.status}`);

  console.log(`\n契约:投票、确定性裁决与终局揭示`);
  // Fake 模型下:4 个 AI 全投人类,人类被淘汰;随后 /continue 由 AI 跑到终局。
  const voted = await api('POST', `/api/games/${gameId}/vote`, { targetId: 'ai-1' });
  check('人类投票被接受(200)', voted.status === 200, `status=${voted.status}`);
  const humanAfterVote = voted.body?.players?.find((p) => p.id === 'human');
  check('人类在多数票下被淘汰', humanAfterVote?.alive === false);

  let finalState = voted.body;
  if (finalState?.phase !== 'finished') {
    const spectate = await api('POST', `/api/games/${gameId}/continue`);
    check('出局后可继续观战(200)', spectate.status === 200, `status=${spectate.status}`);
    finalState = spectate.body;
  }
  check('对局能推进到 finished', finalState?.phase === 'finished', `phase=${finalState?.phase}`);
  check('终局产生 winner', finalState?.winner === 'civilian' || finalState?.winner === 'undercover');
  check(
    '终局揭示所有玩家 role',
    Array.isArray(finalState?.players) && finalState.players.every((p) => p.revealedRole),
  );
  check(
    '终局揭示所有玩家 word',
    Array.isArray(finalState?.players) && finalState.players.every((p) => p.revealedWord),
  );
  check('终局产生复盘(review)', finalState?.review && finalState.review.turningPoints?.length > 0);
}

let child;
async function main() {
  console.log(`\n▶ 启动后端「${target}」(GAME_MODEL=fake, PORT=${PORT})…`);
  child = spawn(backend.cmd, backend.args, {
    cwd: backend.cwd,
    env: { ...process.env, GAME_MODEL: 'fake', NODE_ENV: 'test', PORT: String(PORT) },
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  const ready = await waitForHealth();
  if (!ready) {
    console.error('后端在超时时间内未就绪');
    process.exitCode = 1;
    return;
  }

  await runContract();

  console.log(`\n结果:${passed} 通过 / ${failures.length} 失败`);
  if (failures.length > 0) {
    console.error('\n失败项:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exitCode = 1;
  }
}

function shutdown() {
  if (child && !child.killed) {
    child.kill('SIGTERM');
  }
}

main()
  .catch((error) => {
    console.error('契约运行器异常:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    shutdown();
    await sleep(300);
    process.exit(process.exitCode ?? 0);
  });
