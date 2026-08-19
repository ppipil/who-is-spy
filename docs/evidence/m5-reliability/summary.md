# M5 Reliability evidence

## Scope

- Product commit under test: `49eb39d feat(reliability): add fault injection and replay`
- Eval branch: `eval/m5-reliability`
- Goal: prove deterministic fault injection, precise fault localization, redacted runtime trace, replay, and safe recovery/abort behavior.

This is M5 reliability evidence. It is not M6 model-quality comparison.

## Safety boundary

- Fault Injection is artificial and deterministic. It does not claim DeepSeek really returned the injected errors.
- Transport tests mock the HTTP transport but exercise the real `DeepSeekClient` classification/retry logic.
- Replay reads public events plus redacted runtime trace. It does not call the LLM again.
- JSONL runtime logs are local and gitignored under `packages/server-node/traces/*.jsonl`.
- The committed summary contains no API key, full secret words, raw model inputs, raw provider payloads, or non-public reasoning.

## Product verification on main

```text
npm.cmd test --workspace packages/server-node
npm.cmd run contract:node
npm.cmd run build
```

Results:

- Node tests: 8 files / 33 tests passed.
- Node contract: 28 passed / 0 failed.
- Web + Node build: passed.
- Product sensitive scan: zero hits in changed M5 files.

## Fault scenarios

`npm run fault-demo -- --list` exposes:

- `describe-timeout`
- `describe-bad-json`
- `schema-failure`
- `vote-rate-limit`
- `describe-final-failure`
- `vote-final-failure`
- `review-failure`

## Transport error classification

Command:

```text
npm.cmd test --workspace packages/server-node -- --run server/model.test.ts server/fault-injection.test.ts
```

Result: 2 files / 12 tests passed.

Coverage:

| Case | Classification | Retry behavior |
| --- | --- | --- |
| timeout | `timeout` | retryable, bounded |
| HTTP 429 | `rate_limit` | retryable, bounded |
| HTTP 5xx | `provider_5xx` | retryable, bounded |
| HTTP 401/403 | `http_non_retryable` | no retry |
| invalid JSON | `invalid_json` | retryable, bounded |
| schema validation | `schema_validation` | retryable, bounded |
| network error | `network` | retryable, bounded |

## Core scenario evidence

### `describe-timeout`

- Fault source: Fault Injection.
- Location: round 1, describing phase, 弥生 (`ai-2`), task `describe`.
- Attempt #1: `timeout`; retry.
- Attempt #2: success.
- Result: recovered.
- State safety: SAFE.

### `vote-final-failure`

- Fault source: Fault Injection.
- Location: round 1, voting phase, 弥生 (`ai-2`), task `vote`.
- Attempt #1: `rate_limit`, HTTP 429; retry.
- Attempt #2: `rate_limit`, HTTP 429; retry exhausted.
- First private ballot batch discarded.
- Human vote and AI votes were not half-committed.
- Failed pending vote was cleared.
- Same ballot retry succeeded.
- Result: recovered after safe abort.
- State safety: SAFE.

Replay excerpt:

```text
【第一次 ballot batch：私有预生成】
✗ 弥生（ai-2） vote #1
  错误：API 请求被限流
  errorType: rate_limit, HTTP: 429
  → 自动重试
✗ 弥生（ai-2） vote #2
  错误：API 请求被限流
  errorType: rate_limit, HTTP: 429
  → 重试耗尽 / 明确中止
→ 本批存在最终失败，整批 private candidates discard，未提交 GameState

【重新尝试后的第二次 batch：私有预生成】
✓ 阿序（ai-1） vote #1 成功（私有候选，等待整批结算）
✓ 弥生（ai-2） vote #1 成功（私有候选，等待整批结算）
✓ 老墨（ai-3） vote #1 成功（私有候选，等待整批结算）
✓ 小满（ai-4） vote #1 成功（私有候选，等待整批结算）
→ 本批 AI votes 全部成功，连同 Human vote 正式提交并结算
```

### `review-failure`

- Fault source: Fault Injection.
- Location: round 3, finished phase, review task.
- Attempt #1: `provider_5xx`, HTTP 502; retry.
- Attempt #2: `provider_5xx`, HTTP 502; retry exhausted.
- Recovery: local fallback review.
- Final state: `phase=finished`.
- State safety: SAFE.

Replay excerpt:

```text
✗ 复盘（review） review #1
  错误：模型服务端异常
  errorType: provider_5xx, HTTP: 502
  → 自动重试
✗ 复盘（review） review #2
  错误：模型服务端异常
  errorType: provider_5xx, HTTP: 502
  → 重试耗尽 / 明确中止
↳ review 失败，使用 local fallback
```

## DeepSeek happy-path smoke

Command pattern:

```text
DOTENV_CONFIG_PATH=<local root .env> npm.cmd run --silent eval:node -- --games 1 --seed <seed> --model real
```

Results:

| Seed | Result | completionRate | validVoteRate | invalidOutputRate | Gate |
| --- | --- | ---: | ---: | ---: | --- |
| 42 | real invalid vote / incomplete game observed | 0 | 0.8333 | 0.05 | FAIL |
| 43 | completed | 1 | 1 | 0 | PASS |
| 44 | completed | 1 | 1 | 0 | PASS |

Interpretation:

- M5 product changes did not prevent successful real describe/vote/review completion in seeds 43 and 44.
- Seed 42 surfaced a real model-output failure in the evaluation drive. This was not an injected fault and is recorded as a reliability observation, not hidden.
- The main eval schema still reports token usage as unavailable.
- This smoke is not M6 statistical evaluation.

## Known limitations

- Product runtime trace is available through `M5_TRACE_CONSOLE=1` and/or `M5_TRACE_JSONL=<path>`, but the current main eval harness does not attach runtime trace to real smoke reports.
- Automated eval does not retry a user action after a safe vote abort; the product path supports retrying the same ballot.
- No database, dashboard, OpenTelemetry, web replay, multi-provider fallback, or M6 comparison is included.
