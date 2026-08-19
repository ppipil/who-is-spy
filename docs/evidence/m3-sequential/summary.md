# M3 sequential-description evidence -- final smoke acceptance

## Boundary

- Product commit under acceptance: `1f3cf9e` (`feat(game): stream m3 sequential progress`), built on the M3 baseline `8ce7f23`.
- M3 includes sequential AI description generation, immediate public commit per successful description, SSE progress delivery to the browser, and private AI vote prefetch after `voting`.
- It does not add a real seat scheduler, M4 quality gate, M5 retry/fallback/replay, or M6 multi-seed batch comparison.
- Reports use `schemaVersion: 4` and are redacted. They contain no API key, Authorization header, raw prompt/messages, raw provider response, hidden reasoning, role/word leakage before finale, or complete secret words.

## Reproducible commands

```powershell
npm.cmd test --workspace packages/server-node
npm.cmd run contract:node
npm.cmd run build
npm.cmd run eval:node -- --games 20 --seed 42 --model fake --commit 1f3cf9e --run-id m3-final-fake-sequential-sse-prefetch-seed-42

$env:NODE_OPTIONS='-r dotenv/config'
$env:DOTENV_CONFIG_PATH='D:\pp\code\project\who-is-spy\.env'
npm.cmd run eval:node -- --games 3 --seed 42 --model real --commit 1f3cf9e --run-id m3-final-real-sequential-sse-prefetch-seed-42 --cost-model deepseek-v4-flash --cost-currency USD --input-token-price-per-1m 0.14 --output-token-price-per-1m 0.28 --cost-source https://api-docs.deepseek.com/quick_start/pricing/ --cost-source-date 2026-08-19
```

Cost is an estimate using the configured input/output price and provider token usage. The provider payload used here does not expose cache-hit/miss splits.

## FakeModel deterministic regression

`fake-sequential-report.json` records 20/20 completed games and Gate PASS:

| Metric | Result |
| --- | ---: |
| Completion / valid votes / invalid output | 100% / 100% / 0% |
| Description homogeneity | 0 |
| Exact description leaks / public-state leaks | 0 / 0 |
| Retry / retry-added tokens | 0 / 0 |
| Token/cost source | unavailable for FakeModel |
| Strategy groups | cautious, intuitive, analytical, contrarian all present with 20 games each |

The report still records first-round describe prefixes `sameRoundPublicAiDescriptionCount = [0, 1, 2, 3]` with the human description present for all four AI calls. Tests additionally prove that each successful AI description is committed to formal public state before the next AI starts, SSE emits only public fields, and vote prefetch does not write votes or adjudicate before the human vote.

## DeepSeek small smoke

`real-sequential-smoke-report.json` records a 3-game DeepSeek smoke with `seed=42`:

| Metric | Result |
| --- | ---: |
| Gate / completion / valid votes | PASS / 3 of 3 / 100% |
| Invalid output / retry rate | 0% / 0% |
| Description homogeneity | 0.0051 |
| Exact description leaks / public-state leaks | 0 / 0 |
| Vote-reason mentions / review mentions / alias-semantic exposure | 7 / 5 / 5 |
| Latency P50 / P95 | 7680.3248 / 27263.8088 ms |
| Whole-run duration | 263025.9631 ms |
| Input / output / total tokens | 21096 / 30883 / 51979 |
| Avg total tokens per game | 17326.3333 |
| Internal retries / retry-added tokens | 0 / 0 |
| Estimated total / average cost | 0.0116 / 0.0039 USD |

Token usage by task:

| Task | Input | Output | Total |
| --- | ---: | ---: | ---: |
| describe | 7497 | 12839 | 20336 |
| vote | 8495 | 11140 | 19635 |
| review | 5104 | 6904 | 12008 |

## Sequential observation samples

Every real game records round-one prefixes `ai-1:0`, `ai-2:1`, `ai-3:2`, `ai-4:3`; the human description is present for every AI call. This proves context availability. The redacted descriptions below show qualitative use signals, but they are not causal proof.

| Game | Redacted round-one public sequence | Interpretation boundary |
| --- | --- | --- |
| 1 | Human generic clue -> AI1 bad-weather clothing -> AI2 checks a small item in a bag -> AI3 contrasts with `[OTHER_SECRET]_ALIAS` and folding -> AI4 notes wind and fit. | Later turns add contrast and constraints consistent with reading earlier descriptions; exact causality is not claimed. |
| 2 | Human generic clue -> AI1 observation tool -> AI2 far scenery pulled close -> AI3 contrasts near-sight glasses -> AI4 warns against strong light. | Later descriptions avoid simple repetition and refine the same public frame. |
| 3 | Human generic clue -> AI1 audiovisual form -> AI2 family watching a bright screen -> AI3 fixed opening and scheduled time -> AI4 many sections, pause/resume. | Later descriptions elaborate format and viewing behavior rather than repeating the first clue. |

## Direction-only M2 to M3 comparison

Both are 3-game, fixed-seed DeepSeek smokes. Model output is stochastic, so this is not a significance test or M6 conclusion.

| Metric | M2 smoke | Final M3 smoke | Direction-only reading |
| --- | ---: | ---: | --- |
| Completion / valid votes | 3/3 / 100% | 3/3 / 100% | No observed regression. |
| Homogeneity | 0.04 | 0.0051 | Lower in this sample only. |
| Whole-run duration | 147980.38 ms | 263025.9631 ms | Higher overall, consistent with serial describe calls plus this sample's provider latency. |
| Per-call P50 / P95 | 7979.53 / 23020.94 ms | 7680.3248 / 27263.8088 ms | Similar P50, higher P95 in this small smoke. |
| Total tokens / estimated cost | 39193 / about 0.01 USD | 51979 / 0.0116 USD | Higher token/output spend in this sample. |
| Vote/review/alias exposure | 8 / 6 / 4 | 7 / 5 / 5 | Still a safety risk for M4; no quality claim. |

## Limits retained

- Human remains fixed first; AI order comes from stable `players[]` / profile order, not a shared real seat scheduler.
- SSE progress is public-only and best-effort. The final `/describe` response still converges the browser state if the stream disconnects.
- Private AI vote prefetch binds results to `gameId + round + ballot + eligibleTargetIds`; ballot 2 regenerates votes from the new eligible set. Votes remain private until the human submits.
- M3 adds no quality gate, duplicate control, targeted repair, provider fault injection, fallback, replay, or formal M6 multi-seed comparison.
