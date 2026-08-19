# M2 Persona evidence — small-sample acceptance

## Boundary

- M2 product baseline: `a878e5e` (`docs: document agent strategy architecture`).
- The evaluation-only observability layer was selectively transplanted from M1 as
  `65ba4e2` (versioned/redacted report) and `2f94ca3` (aggregate usage/cost).
  No M1 evidence, M3 sequencing, M4 quality gate, M5 fault handling, or M6 batch
  comparison is included.
- `schemaVersion: 3` reports record the evaluated M2 baseline in `run.commit` as
  `a878e5e`. The generator commits above are recorded here to avoid treating the
  report format as part of the M2 product change.

## Reproducible commands

```powershell
# Deterministic engineering regression
npm run eval:node -- --games 20 --seed 42 --model fake --commit a878e5e --run-id m2-fake-persona-seed-42

# Real-model small smoke; the existing root .env is preloaded without copying it
$env:NODE_OPTIONS='-r dotenv/config'
$env:DOTENV_CONFIG_PATH='D:\pp\code\project\who-is-spy\.env'
npm run eval:node -- --games 3 --seed 42 --model real --commit a878e5e --run-id m2-real-persona-smoke-seed-42 --cost-model deepseek-v4-flash --cost-currency USD --input-token-price-per-1m 0.14 --output-token-price-per-1m 0.28 --cost-source https://api-docs.deepseek.com/quick_start/pricing/ --cost-source-date 2026-08-19
```

The cost is an estimate using DeepSeek's published cache-miss input price and
output price. The provider payload does not expose cache-hit/miss splits.

## FakeModel — deterministic wiring regression

`fake-persona-report.json` records 20/20 completed games and Gate PASS with
100% completion, 100% valid votes, 0% invalid outputs, no exact-description or
public-state leaks, and homogeneity `0`. All four strategy groups are present:
`cautious`, `intuitive`, `analytical`, and `contrarian` (20 games each).

This verifies the profile → `strategyId` → `AgentContext` → strategy registry →
model/evaluation path and reproducibility. It does **not** prove real-model
Persona quality.

## DeepSeek — small Persona smoke

`real-persona-smoke-report.json` records one fixed-seed, 3-game small sample:

| Metric | Result |
| --- | --- |
| Gate / completion / valid votes | PASS / 3 of 3 / 100% |
| Invalid output rate | 0% |
| Description homogeneity | 0.0239 |
| Latency P50 / P95 | 8500.9498 / 43306.5196 ms |
| Input / output / total tokens | 20386 / 35474 / 55860 |
| Internal retries / retry-added tokens | 1 / 1348 |
| Estimated total cost | 0.0128 USD |
| Exact description leaks / public-state leaks | 0 / 0 |
| Vote-reason secret mentions / review secret mentions / alias exposure | 8 / 6 / 6 |

Each strategy has three game-level observations. Redacted first-round samples
show the intended directional differences: cautious uses broad, low-exposure
usage wording and evidence confidence; intuitive uses sensory association;
analytical cites category/use mismatch; contrarian challenges overly safe or
consensus-like wording. These are qualitative observations only, not a
statistically significant ranking or a final Baseline-vs-Improved conclusion.

The non-zero vote/review mention and alias-exposure counts are retained as a
known risk. They do not claim an exact description leak, and they are not
silently collapsed into `leaks=0`; M4 needs deterministic regression coverage
and enforcement policy for this class of exposure.

## Evidence safety and limits

Both JSON reports are produced by `runEvaluation()` and use its redacted trace.
They contain no API key, Authorization header, prompt/messages, raw provider
response, hidden reasoning, or complete secret word. The reports are a M2
smoke, not M6-scale multi-seed quality, latency, or cost evaluation.
