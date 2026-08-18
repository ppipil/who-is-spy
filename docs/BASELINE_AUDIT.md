# Baseline audit

## Document ownership

Official baseline documents:

- `README.md`
- `CANDIDATE_TASK.md`
- `contract/CONTRACT.md`

Candidate implementation documents begin with `README_CANDIDATE.md`, `PLAN.md`, `AGENTS.md`, this audit, and later files under `docs/`. `DECISIONS.md` remains the official candidate-fill template; its original headings and prompts are preserved.

## Source consistency check

- Formal working directory: `D:\pp\code\project\who-is-spy`
- Original comparison source: `D:\pp\code\project\ai-undercover\who-is-spy`
- Method: recursively enumerate regular files, normalize relative paths, compare file count, byte length, and SHA-256.
- Excluded during comparison: `node_modules/`, `.npm-cache/`, any `dist/`, `.git/`, four `official-*.log` files, and `.env`.
- Result: 44 source files versus 44 working-directory files; zero missing, extra, length-different, or hash-different files.

Protected document hashes at import:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `README.md` | 6,187 | `0765C1A5EA7D77FD4CEF56EAB949FF3D653B2A5D3476A7B6CAD65BC591E139EB` |
| `CANDIDATE_TASK.md` | 10,571 | `FB0C07713365939C1344432D8D5B5755C8A8CF04789570905372FBA57270F2A9` |
| `contract/CONTRACT.md` | 3,938 | `374F770BC1C27852F6422D4FF860DD127469F06B1DE73E42C19CE7EA30A2ECAB` |

## Baseline Git import

- Root commit: `7d98e194ee57bb078ed45e9831ad42ff68a57b56` (`chore: import provided baseline`)
- Tag: `baseline-v1`, pointing to the same commit.
- Scope: exactly the 44 matched official source/document files.
- Local-only `.git/info/exclude` kept dependencies, caches, logs, `packages/web/dist/`, and `.env` out of the import.
- No `AGENTS.md`, `PLAN.md`, `README_CANDIDATE.md`, candidate docs, ignore-rule edits, or candidate code entered the root commit.

## Environment and dependency state

- OS/shell used for evidence: Windows PowerShell.
- Node: `v22.22.0` (meets the recommended Node 22 line).
- npm: `10.9.4`.
- `npm install --cache .npm-cache`: failed twice with `ECONNRESET` while fetching a lockfile URL under `https://bnpm.byted.org/`; the second attempt had approved network access and failed identically.
- `npm ls --all --depth=0`: exit 0; all declared workspaces and top-level dependencies are present in the existing installation.
- The official lockfile was not rewritten to hide the installation failure.

## Baseline command evidence

Commands were rerun after repository initialization; older logs were not treated as evidence.

| Command | Exit | Result |
| --- | ---: | --- |
| `npm run test:node` | 0 | 3 test files passed; 6 tests passed; duration 632 ms on the first baseline run. |
| `npm run contract:node` (unmodified runner) | 1 | Backend launch failed before assertions: `spawn npx ENOENT` on Windows. |
| `npm run build` | 0 | Web TypeScript/Vite build passed (1,797 modules); Node `tsc --noEmit` passed. |

The launcher failure was fixed after `baseline-v1` in commit `5f6232c` by resolving filesystem URLs with `fileURLToPath` and invoking the installed `tsx` CLI through `process.execPath`. A proposed `npx.cmd` substitution was tested independently and rejected because it produced `spawn EINVAL` on this runtime. After the fix:

| Command | Exit | Result |
| --- | ---: | --- |
| `npm run contract:node` | 0 | 28 contract assertions passed; 0 failed. |
| `npm run test:node` | 0 | 3 test files passed; 6 tests passed. |
| `npm run build` | 0 | Web production build and Node typecheck passed. |

## Observed baseline behavior

- Agent isolation: `buildAgentContext` reconstructs identity plus public facts through an allowlist. Existing tests prove another player's role/word is absent.
- Strategy gap: the four profile `style` values exist only in `AI_PROFILES`; they are discarded while creating players and never reach `AgentContext`, description prompts, vote prompts, traces, or metrics. All Agents therefore use identical model instructions.
- Description orchestration: `generateDescriptions` uses `Promise.all` against one immutable game snapshot. Every AI sees the human description and previous rounds, but no AI sees an earlier AI description from the current generation batch.
- Atomicity: generated descriptions are appended only after the entire `Promise.all` resolves, so failure avoids a partial formal state; sequential staging must preserve this property.
- Voting: AI votes use `Promise.all` and the same public snapshot. Current-ballot votes are not exposed in `AgentContext`, which should remain true.
- Model validation/retry: Zod validates description/vote/review shapes; description checks only the current Agent's word; invalid results and transport failures are retried in nested two-attempt loops. Error types, attempt coordinates, latency, and token use are not externally observable.
- Human quality checks: length is 2–60 normalized characters and direct inclusion of the human word is rejected.
- Missing capabilities: no batch evaluation, fixed-seed CLI, threshold gate, strategy aggregation, description similarity rule, structured trace sink, deterministic fault injection, or decision replay.

## Boundaries that must not regress

- One human plus four AI players and server-authoritative deterministic elimination/tie/win rules.
- Frozen HTTP paths and minimum DTO shapes.
- No secret fields in pre-finale `players[]`; only the human's own secret under `human`; full reveal only after finish.
- Model-backed AI description, vote, and review with an injectable FakeModel.
- Agent context built from allowed fields rather than full-state redaction.
- No Go implementation changes for this candidate solution.

