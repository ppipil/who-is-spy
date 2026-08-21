# Evaluation

## Reproducible command

```bash
npm run eval:node -- --games 20 --seed 42 --model fake
```

The CLI writes the human-readable table to stderr and schema-versioned JSON to stdout, so stdout can be redirected to a machine-readable evidence file without mixing secrets or display text. `--model fake` is the default and consumes no external API quota. `--model real` is an explicit live-model choice and requires local provider configuration.

## Determinism and automation

- A Mulberry32 random source seeded by `--seed` drives word-pair selection, identity assignment, word swapping, and deterministic tie resolution.
- The harness creates a fresh `GameEngine` per game, submits deterministic human descriptions/votes, and uses the normal spectator path if the human is eliminated.
- An instrumenting `GameModel` wrapper measures logical model calls without changing production game behavior.
- Repeated FakeModel runs compare stable game counts, description attempts, homogeneity, and strategy aggregates. Latency is measured but intentionally excluded from equality assertions.

## Baseline metrics

Captured before strategy, sequential generation, quality gate, or trace changes:

| Metric | Baseline (`20 games`, `seed 42`, FakeModel) |
| --- | ---: |
| startedGames / completedGames | 20 / 20 |
| completionRate | 100% |
| descriptionAttempts | 174 |
| secretLeakRejectRate | 0% (no baseline quality-gate events) |
| duplicateRejectRate | 0% (no baseline quality-gate events) |
| invalidOutputRate | 0% |
| validVoteRate | 100% |
| retryRate | 0% (inner provider retries are not observable in baseline) |
| latency p50 / p95 | 0.0408 / 0.0851 ms (local FakeModel; informational only) |
| input / output / total tokens | 0 / 0 / 0 (`source: unavailable`) |
| descriptionHomogeneity | 0.7692 |
| strategy grouping | `baseline-unassigned`: 80 Agent-game seats, 67.5% role win rate, 29.89% vote accuracy |

The homogeneity proxy is mean pairwise Dice similarity over normalized character bigrams for AI descriptions in the same round. The high FakeModel baseline is expected because all descriptions share one template and differ mainly by Agent name. It is a comparison signal, not currently a hard quality threshold.

## Hard gate rationale

The initial non-zero gate covers deterministic correctness only:

- completion rate must equal 1.0;
- valid vote rate must equal 1.0;
- committed descriptions must contain no complete game word;
- pre-finale public DTOs must expose no secret/reveal fields;
- no evaluation game may end in an illegal or incomplete state.

These thresholds are exact because FakeModel and engine randomness are controlled; accepting anything lower would normalize a correctness regression. A test injects an invalid vote and proves the gate fails. Real-model quality rates and latency are deliberately not hard-gated at the baseline stage because the sample is small and provider behavior is noisy. Quality thresholds will be added only after fixed violation samples and enhanced measurements justify them.

## Metric limitations at baseline

- `descriptionAttempts` counts logical `GameModel.describe` calls, not hidden HTTP/schema retry attempts inside `DeepSeekClient`.
- Token usage is unavailable because the baseline client discards provider usage metadata.
- Rejection and retry rates remain zero until typed quality/trace events enter the evaluator.
- FakeModel outcome rates prove regression behavior, not real-model Agent quality.

## Admin console batch evaluation

The same harness is exposed as an on-demand developer-console workflow (no auth, demo-only):

```bash
ENABLE_ADMIN_CONSOLE=1 npm run dev:node   # backend, default http://localhost:8787
npm run dev:web                          # frontend, http://localhost:5173/admin → Evaluation tab
```

API:

- `POST /api/admin/evaluation/run` with `{ games, seed, model }` returns `202 { runId }`; only one run may be active at a time (`409` otherwise). `games` is validated to 1–100, `model` to `fake|real`; `real` requires provider configuration (`400` otherwise).
- `GET /api/admin/evaluation/runs` lists in-memory run history with gate result and key metrics.
- `GET /api/admin/evaluation/runs/:runId` returns progress while running, then the full schema-versioned result.
- `GET /api/admin/evaluation` still serves the canonical M6 baseline-vs-final evidence used for delta comparison.

The page shows live progress (`completed/total games`), a PASS/FAIL gate banner with the exact failure list, a metrics table with delta vs the canonical baseline, per-strategy win/vote breakdown, token usage (input/output/total and per-task) and estimated cost when the provider returns usage, safety detail, and a run history with a reproducibility badge for repeated `fake` runs with the same seed.

### Trace association

Evaluation runs are linked to the admin trace: every run stamps its events with `runId` and `source: 'evaluation'`, and publishes per-game lifecycle events (`evaluation_game_start` / `evaluation_game_completed` / `evaluation_game_failed`). Real-model runs also carry the underlying `model_call`, `quality_violation`, and `prompt_provenance` events with the same stamp. `GET /api/admin/traces?runId=…` filters to one run, and the Evaluation page has a “在 Trace 中查看本评测” action that jumps to the Trace tab pre-filtered by that run. This makes gate failures diagnosable (e.g. which game aborted and why), instead of only seeing aggregate counts.

Each evaluation game also publishes its **public** per-round content to the trace: every committed description (`publicEventType: 'description'`) and vote with reason (`publicEventType: 'vote_result'`), so the Trace tab shows what each agent actually said and how they voted. Exact game words are redacted as `[SECRET]` before publishing; only content that was already public in the game is exposed.

## Live token and cost measurement

`runEvaluation` now records provider `usage` when the model exposes it (`DeepSeekClient.setUsageRecorder`). When a real-model run returns `usage`, the report includes input/output/total tokens, per-game averages, per-task splits (describe/vote/review), and an estimated cost using the DeepSeek `deepseek-chat` public price snapshot ($0.27/$1.10 per 1M tokens, USD) with the formula recorded in `cost.formula`. Fake runs report `source: 'unavailable'` for both. The CLI prints the same fields.

