# M4 Quality Gate evidence

## Scope

- Product commit under test: `806c05c feat(game): gate AI descriptions before publication`
- Eval branch: `eval/m4-quality-gate`
- M4 only gates AI `description` output before public commit.
- It does not gate vote reasons or final reviews, and it does not implement M5 replay/fallback or M6 batch comparison.

## Product behavior verified

The server flow is:

```text
AI describe -> DescriptionQualityGate -> commit public description/event on PASS -> next AI context
```

Rejected descriptions are not written to `GameState.descriptions`, are not emitted as public events, and are not sent over SSE. If attempts are exhausted, the already accepted prefix remains public, the phase stays `describing`, and the game does not enter `voting`.

Rules currently enforced:

- Empty or invalid length.
- Exact secret leak against the current game's secret words.
- Lexical duplicate against already accepted descriptions in the same round, using normalized character bigram Dice similarity.
- Targeted repair guidance and bounded retry from `qualityPolicy.maxDescriptionAttempts`.

## Verification commands

```text
npm.cmd test --workspace packages/server-node
npm.cmd run contract:node
npm.cmd run build
npm.cmd run --silent eval:node -- --games 20 --seed 42 --model fake --commit 806c05c --run-id m4-fake-quality-gate-seed-42
npm.cmd run --silent eval:node -- --games 3 --seed 42 --model real --commit 806c05c --run-id m4-real-quality-gate-smoke-seed-42 --cost-model deepseek-v4-flash --cost-currency USD --input-token-price-per-1m 0.14 --output-token-price-per-1m 0.28 --cost-source https://api-docs.deepseek.com/quick_start/pricing --cost-source-date 2026-08-19
```

The real smoke command was run with `DOTENV_CONFIG_PATH` pointing at the local root `.env`. The key value was not printed or committed.

## Test results

- Node tests: 6 files / 23 tests passed.
- Node contract: 28 passed / 0 failed.
- Web + Node build: passed.
- Sensitive scan: no API key, unredacted provider payload, non-public reasoning content, or complete secret-word evidence committed.

Quality Gate deterministic tests cover:

- Empty/invalid length/exact secret rejection.
- Duplicate rejection threshold.
- Secret leak retry and redacted repair guidance.
- Duplicate retry and repair commit.
- Retry exhausted final state.
- M3 compatibility: accepted prefix remains public, failed output is not committed, phase remains `describing`.
- Integration: AI2 duplicate is rejected, AI2 repair is committed, AI3 sees accepted AI1 + repaired AI2.

## Fake deterministic regression

Report: `fake-quality-gate-report.json`

| Metric | Result |
| --- | ---: |
| Games | 20/20 |
| Gate | PASS |
| completionRate | 1.0 |
| validVoteRate | 1.0 |
| invalidOutputRate | 0 |
| secretLeakRejectRate | 0 |
| duplicateRejectRate | 0 |
| retryRate | 0 |
| final description exact leaks | 0 |
| latency P50/P95 ms | 0.0235 / 0.1028 |
| token/cost | unavailable for FakeModel |

Interpretation: FakeModel confirms deterministic regression, persona grouping, legal votes, and no committed description leak. Positive reject/retry behavior is covered by deterministic Quality Gate and engine integration tests rather than by the normal FakeModel behavior.

## DeepSeek real smoke

Report: `real-quality-gate-smoke-report.json`

| Metric | Result |
| --- | ---: |
| Games | 3/3 |
| Gate | PASS |
| completionRate | 1.0 |
| validVoteRate | 1.0 |
| invalidOutputRate | 0 |
| descriptionAttempts | 20 |
| secretLeakRejectRate | 0.05 |
| duplicateRejectRate | 0 |
| retryRate | 0.05 |
| final description exact leaks | 0 |
| latency P50/P95 ms | 7757.1355 / 44454.8239 |
| input/output/total tokens | 27537 / 41758 / 69295 |
| average total tokens/game | 23098.3333 |
| internal provider retries | 2 |
| retry-added tokens | 3933 |
| estimated total cost | 0.0156 USD |

Interpretation: The real smoke observed one Quality Gate exact-secret rejection and one repair retry. The rejected text did not reach committed public descriptions; final public description exact leaks remained 0. This is a small smoke sample, not M6 statistical comparison.

## Known limitations

- Only description output is gated in M4.
- Vote reasons and final reviews may still mention secret words in the model's generated explanation fields; those remain measurement/reporting concerns here, not blocked output.
- Alias or semantic exposure is measured as a risk signal but is not blocked by M4.
- DeepSeek smoke is small-sample validation, not a formal quality benchmark.
- Provider-level detailed attempt trace, fallback/recovery, replay, and fault injection remain M5.
- Baseline vs improved large-sample comparison remains M6.
