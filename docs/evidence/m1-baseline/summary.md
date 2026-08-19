# M1 Baseline Evaluation Evidence

## Scope

| Ref | Meaning |
| --- | --- |
| `7d98e19` | Official original baseline import. |
| `fc9821c` | M1 instrumented baseline: baseline plus evaluation harness and evidence docs. |
| FakeModel | Deterministic engineering regression path. |
| DeepSeek Real | Live-model smoke path for behavior and latency. |

`fc9821c` does not change the Node `DeepSeekClient` prompt, `AgentContext`, model schemas/checks, `GameEngine`, or public DTO/types relative to `7d98e19`. It adds the versioned evaluation/reporting harness used here.

## Commands

```bash
npm run eval:node -- --games 20 --seed 42 --model fake --commit fc9821c --run-id m1-fake-baseline-seed-42
npm run eval:node -- --games 3 --seed 42 --model real --commit fc9821c --run-id m1-real-smoke-seed-42
npm run eval:node -- --games 1 --seed 42 --model real --commit fc9821c --run-id m1-real-usage-smoke-seed-42 \
  --cost-model deepseek-v4-flash --cost-currency USD \
  --input-token-price-per-1m 0.14 --output-token-price-per-1m 0.28 \
  --cost-source https://api-docs.deepseek.com/quick_start/pricing/ --cost-source-date 2026-08-19
```

Both reports use the same chain:

```text
eval-cli -> runEvaluation -> GameEngine -> observable model -> FakeGameModel/DeepSeekClient
```

## Result Summary

| Model | Games | Gate | Description calls | Invalid output rate | Valid vote rate | Latency p50 / p95 | Token/cost |
| --- | ---: | --- | ---: | ---: | ---: | ---: | --- |
| FakeModel | 20/20 | PASS | 174 | 0% | 100% | 0.0449 / 0.0962 ms | unavailable |
| DeepSeek Real | 3/3 | PASS | 16 | 2.86% | 100% | 6767.5141 / 47245.0955 ms | unavailable in historical v2 smoke |
| DeepSeek Real usage smoke | 1/1 | PASS | 4 | 0% | 100% | 6867.1445 / 35089.5028 ms | 4413 / 6822 / 11235 tokens; estimated 0.0025 USD |

The Real smoke proves the M1 harness can drive the live DeepSeek path through complete games. It is not a formal quality comparison and does not complete task line ② by itself.

## Trace and Gate

- `schemaVersion`: `3` for newly generated usage-capable reports. The retained 3-game Real smoke remains historical schema `2`.
- `gateSource`: `runEvaluation`.
- The original CLI gate and trace are produced from the same `EvaluationResult`.
- The trace records runId, commit, model, seed, gameId, round, agentId, task, attempt, latency, status, and errorType.
- The trace does not record API keys, Authorization headers, complete secret words, raw prompts/messages, raw model responses, or hidden reasoning.
- M1 now records aggregate provider token usage, average tokens per game, tokens by task, aggregate internal retry count, retry-added tokens, and estimated cost when explicit pricing is configured.
- The usage smoke uses `deepseek-v4-flash` pricing in USD from the DeepSeek official pricing page on 2026-08-19: input cache-miss `0.14` / 1M tokens and output `0.28` / 1M tokens. Cache-hit detail is not available from the current usage payload, so this report uses the configured conservative input price.

## Additional Real Smoke Metrics

The retained 3-game Real smoke report also includes:

- `descriptionHomogeneity`: `0.0546`.
- `publicStateLeakOccurrences`: `0`.
- `secretLeakOccurrences`: `0`.
- `voteReasonSecretMentions`: `9`.
- `reviewSecretMentions`: `5`.
- `aliasOrSemanticExposure`: `2`.
- `secretLeakRejectRate`, `duplicateRejectRate`, and `retryRate`: `0`.
- Strategy bucket: `baseline-unassigned`.

## Leak and Exposure Categories

| Category | Meaning |
| --- | --- |
| `descriptionExactSecretLeaks` | Complete secret word appears in committed/public description. |
| `voteReasonSecretMentions` | Vote reason mentions exact secret or configured obvious alias. |
| `reviewSecretMentions` | Review mentions exact secret or configured obvious alias. |
| `aliasOrSemanticExposure` | Non-exact but obvious alias/semantic exposure observed by the redaction pass. |

The terminal UI may reveal full words at finale as product behavior. GitHub evidence and PPT material must remain redacted.

Earlier one Real CLI run reported `secretLeakOccurrences=1`, but it lacked event-level trace and was not reproduced in the 3-game traced smoke. Treat it as an unlocated historical observation and convert it into an M4 deterministic regression sample.

## Representative Timelines

FakeModel needed multiple rounds because its deterministic vote pattern first eliminated the human and then AI players. Real smoke often ended in round 1 because live model descriptions made the target easier to identify. The same seed fixes game setup and deterministic human actions; it does not fix DeepSeek output.

See:

- `fake-baseline-report.json`
- `real-smoke-report.json`
- `real-usage-smoke-report.json`

## Remaining Limits

- Real Smoke is a smoke test, not formal batch quality evaluation.
- Token/cost are now available as M1 aggregate smoke evidence when the provider returns usage and explicit pricing is configured.
- Per-attempt trace detail, replay, fallback, rollback, and fault recovery still belong to M5.
- Baseline-vs-improved DeepSeek batch comparison belongs to M6.
