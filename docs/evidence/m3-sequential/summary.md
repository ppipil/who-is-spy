# M3 sequential-description evidence — small-sample acceptance

## Boundary

- M3 product baseline: `8ce7f23` (`docs: explain staged atomic description flow`).
- Evaluation-only observability was selectively reused as `d78cbe2` (versioned, redacted report) and `06f4386` (aggregate usage/cost); no M2 evidence or M4/M5/M6 product feature is included.
- This branch adds `schemaVersion: 4`: each redacted `describe` call records only `sameRoundPublicAiDescriptionCount` and `sameRoundHumanDescriptionPresent`. It records no description context, prompt, secret, or provider response.

## Reproducible commands

```powershell
npm run eval:node -- --games 20 --seed 42 --model fake --commit 8ce7f23 --run-id m3-fake-sequential-seed-42

$env:NODE_OPTIONS='-r dotenv/config'
$env:DOTENV_CONFIG_PATH='D:\pp\code\project\who-is-spy\.env'
npm run eval:node -- --games 3 --seed 42 --model real --commit 8ce7f23 --run-id m3-real-sequential-smoke-seed-42 --cost-model deepseek-v4-flash --cost-currency USD --input-token-price-per-1m 0.14 --output-token-price-per-1m 0.28 --cost-source https://api-docs.deepseek.com/quick_start/pricing/ --cost-source-date 2026-08-19
```

Cost is an estimate using the published cache-miss input and output price. The provider usage payload does not expose cache-hit/miss splits.

## FakeModel — deterministic sequencing (original staged baseline)

`fake-sequential-report.json` records 20/20 completed games and Gate PASS: 100% completion, 100% valid votes, 0% invalid output, homogeneity `0`, no exact description or public-state leaks, and all four strategy groups present (20 games each).

The first game's four round-one `describe` calls record `sameRoundPublicAiDescriptionCount = [0, 1, 2, 3]`, with the human description present for all four calls. At the time this report was produced, `game-engine.test.ts` also asserted full rollback on a fourth-Agent failure because the product used action-local staging.

This is deterministic wiring evidence for the original staged product baseline. It proves Context presence, not that a real model necessarily uses the prefix well. The later incremental-public-commit extension is documented separately in `incremental-public-commit.md`; it intentionally replaces the rollback behavior with a valid partial `describing` state.

## DeepSeek — fixed-seed small smoke

`real-sequential-smoke-report.json` records a 3-game smoke with `seed=42`:

| Metric | Result |
| --- | --- |
| Gate / completion / valid votes | PASS / 3 of 3 / 100% |
| Invalid output / homogeneity | 0% / 0.0211 |
| Exact description leaks / public-state leaks | 0 / 0 |
| Vote-reason mentions / review mentions / alias-semantic exposure | 10 / 5 / 6 |
| Latency P50 / P95 | 5013.7933 / 16715.952 ms |
| Whole-run duration | 168740.53 ms |
| Input / output / total tokens | 17517 / 21942 / 39459 |
| Internal retries / retry-added tokens | 0 / 0 |
| Estimated total cost | 0.0086 USD |

Each game records round-one prefixes `ai-1:0`, `ai-2:1`, `ai-3:2`, `ai-4:3`; the human description is present for every AI call. The report's redacted timeline supplies the corresponding `Human → AI1 → AI2 → AI3 → AI4` public description sequence.

Qualitative, non-causal observations from the three redacted timelines:

| Game | Later-description pattern | Interpretation boundary |
| --- | --- | --- |
| 1 | Later Agents move from a broad weather-use clue to contrast, transport comparison, and fold/coverage constraints. | The comparison/constraint progression is consistent with using earlier text; the prefix field proves availability, not causality. |
| 2 | Later Agents add night-use, far/near, then visibility-boundary constraints to an initial distance-view clue. | Progressive elaboration is observable, but could also arise independently from each private word. |
| 3 | Later Agents differentiate episodic, feature-length, and cliffhanger angles after a broad leisure clue. | The distinct angles suggest contextual interaction; no statistical or causal claim is made. |

## Direction-only M2 → M3 comparison

Both are one 3-game, fixed-seed DeepSeek smoke; model output remains stochastic, so these are not significance tests or an M6 conclusion.

| Metric | M2 smoke | M3 smoke | Direction-only reading |
| --- | ---: | ---: | --- |
| Completion / valid votes | 3/3 / 100% | 3/3 / 100% | No observed regression. |
| Homogeneity | 0.04 | 0.0211 | Lower in this sample only. |
| Whole-run duration | 147980.38 ms | 168740.53 ms | Higher overall, consistent with serial calls. |
| Per-call P50 / P95 | 7979.53 / 23020.94 ms | 5013.7933 / 16715.952 ms | Lower provider-call percentiles here; not attributable to orchestration because responses vary. |
| Total tokens / estimated cost | 39193 / about 0.01 USD | 39459 / 0.0086 USD | Similar small-sample spend. |
| Vote/review/alias exposure | 8 / 6 / 4 | 10 / 5 / 6 | No safety improvement claim; retain as M4 risk. |

## Limits retained

- This is not a full seat-order scheduler: Human is fixed first; AI order comes from fixed `players[]` / profile order.
- This report predates incremental browser display. The later extension polls the existing public game endpoint to show each committed description and current speaker; see `incremental-public-commit.md`.
- M3 adds no quality gate, duplicate control, targeted repair, fault injection, fallback, replay, or M6 multi-seed comparison.
- The reports contain no API key, Authorization header, prompt/messages, raw provider response, hidden reasoning, or complete secret word.
