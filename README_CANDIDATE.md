# Candidate delivery · AI 谁是卧底 Multi-Agent extension

This document describes candidate-owned implementation and evidence. The official baseline requirements remain in `README.md`, `CANDIDATE_TASK.md`, and `contract/CONTRACT.md` and are intentionally not rewritten here.

## Why Node

The candidate implementation uses `packages/server-node`. Its TypeScript types make the `AgentContext`, strategy, quality-policy, trace, and evaluation boundaries directly reviewable alongside the existing React client. The existing Vitest injection points also support deterministic orchestration and fault tests without changing the HTTP contract. `packages/server-go` remains the untouched equivalent baseline implementation.

## Baseline and candidate scope

`baseline-v1` identifies the exact 44-file baseline imported from the provided source. Candidate-owned files start after that tag. The implementation scope is the Node backend plus evaluation/diagnostic CLIs, tests, and candidate documents. The official root README and protected task documents are not candidate reports.

The first post-baseline code change makes the official contract runner launch its Node backend reliably on Windows by invoking the installed `tsx` CLI with the current Node executable. It does not change HTTP assertions or contract semantics.

## Multi-Agent strategy

Implemented strategies are `cautious`, `intuitive`, `analytical`, and `contrarian`. Description guidance, vote evidence organization, and quality policy live behind a registry-backed interface rather than player-name branches in `GameEngine`. Strategy IDs enter the allowlisted Agent context and evaluation dimensions; trace aggregation will use the same ID. Deterministic evidence and limitations are in `docs/ARCHITECTURE.md`.

## Description and voting orchestration

Descriptions will be generated sequentially into an action-local staged list. Each later Agent will see only previously accepted public descriptions from the same round plus the existing allowlisted history. The staged list will be committed to `GameState` only after every required description succeeds. Voting will continue to use a single public snapshot and may remain parallel so current-ballot votes cannot influence one another.

## Quality gate

The planned composable gate covers empty/invalid length, direct secret leakage, and excessive similarity to accepted same-round descriptions. Rejections will carry typed violations, targeted repair guidance, and bounded retries. Exhaustion will abort without a partial round commit. Thresholds will be justified with fixed samples and measured baseline behavior in `DECISIONS.md` and `docs/EVALUATION.md`.

## Evaluation and gates

The evaluation CLI supports seeded FakeModel regression and explicitly selected real-model sampling. Metrics include completion, quality rejection types, valid votes, retries, latency percentiles, token usage, strategy outcomes, and a description-homogeneity proxy. Hard correctness gates are deterministic and non-zero on failure; noisy real-model metrics are reported separately with sample-size limitations. Baseline values and limitations are in `docs/EVALUATION.md`.

## Trace, fault injection, and replay

The planned trace sink records stable IDs, game/round/Agent/task/attempt coordinates, latency, status/error type, prompt version, and token usage. It will not record API keys, full words, other players' secret roles, full unredacted prompts, or hidden reasoning. Deterministic fault scenarios and a replay CLI will reconstruct the key decision timeline without replaying secrets.

## Information isolation

Agent input continues to be rebuilt through an explicit allowlist. No complete `GameState` is passed into an Agent and then redacted. Pre-finale public DTOs remain free of player secret fields, while the human receives only their own secret and the finale retains the official full reveal.

## Commands

```bash
npm install
npm run test:node
npm run contract:node
npm run build
npm run eval:node -- --games 20 --seed 42 --model fake
```

The fault and replay commands will be documented here after their implementations have been run successfully. Current baseline verification evidence is in `docs/BASELINE_AUDIT.md`.

## FakeModel versus real-model acceptance

FakeModel proves deterministic state progression, isolation, retry accounting, fault recovery, and CI gates without API spend. It does not prove external provider availability or real Agent quality. Real-model acceptance must be explicitly enabled with a candidate-owned `.env`, exercise `/api/health`, a complete game, a structured raw response, a small evaluation, one controlled retry/fault, and redacted trace inspection.

## Git iteration and Coding Agent use

The history begins with an unchanged baseline import and `baseline-v1`, then keeps portability, audit/specification, evaluation, strategy, orchestration, quality, observability, and final validation changes in reviewable commits. Actual Coding Agent use, human review, rejected suggestions, commands, and outcomes are recorded incrementally in the preserved `DECISIONS.md` template.

## Known issues

- The provided lockfile resolves packages through `bnpm.byted.org`; fresh installation currently fails in this environment with `ECONNRESET`. The already installed dependency tree passes `npm ls --all --depth=0`.
- Real-model acceptance is pending confirmation of a candidate-owned local `.env`; no key will be copied from the Prototype or placed in Git.
- The evaluation, strategy, quality, trace, fault, and replay milestones are not claimed complete until their tests and evidence exist.

## Earlier Prototype

Before the formal baseline arrived, a separate from-scratch Prototype was developed in the sibling `ai-undercover` repository. It remains independent and is not copied into this repository. A public link will be added only if its publication status is confirmed.
