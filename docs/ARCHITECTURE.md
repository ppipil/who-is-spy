# Candidate architecture

## Frozen baseline boundary

The Node candidate implementation keeps `GameEngine` authoritative for phase changes, legal targets, ballots, elimination, and winner calculation. `buildAgentContext` remains the only Agent-input constructor and uses explicit allowed fields. The public DTO keeps official pre-finale isolation and finale reveal behavior.

## Strategy boundary

`agent-strategy.ts` owns a registry of four `AgentStrategy` policies:

| ID | Public intent | Description evidence style | Vote evidence style |
| --- | --- | --- | --- |
| `cautious` | low exposure | broad category plus one defensible detail | evidence first, lower confidence when evidence is sparse |
| `intuitive` | natural association | sensory atmosphere or lived moment | linguistic naturalness and hesitation |
| `analytical` | structured comparison | use/category/boundary dimension | incompatibilities across category and use |
| `contrarian` | resist consensus bias | valid but less obvious scene or limitation | suspiciously safe consensus-following language |

Each policy also owns its description attempt budget and duplicate-similarity threshold. Adding a strategy is localized to the strategy ID/type, registry implementation, and profile assignment; `GameEngine` contains no player-name strategy branches.

AI profiles carry stable `strategyId` values into `Player`, then into the allowlisted `AgentContext.identity`. `DeepSeekClient.describe` and `.vote` resolve the strategy and supply task-specific guidance. `FakeGameModel` uses the same ID to produce deterministic differentiated behavior, allowing call-chain and evaluation tests without API spend.

## Evidence and limitation

- A fixed test gives all four strategies the same role, word, round, public descriptions, and legal targets. It observes four description outputs, four vote reasons, and more than one target tendency.
- The seeded 20-game Fake evaluation groups each strategy independently and reduces the description-homogeneity proxy from baseline 0.7692 to 0.
- This is deterministic engineering evidence only. Real-model strategy differentiation remains unclaimed until explicit live sampling is run.

## Sequential description orchestration

`GameEngine.generateDescriptions` iterates living AI players in stable `players[]` / profile order (this is not a seat scheduler). The Human description is committed first; every successful AI output is then immediately appended to formal `GameState.descriptions` and recorded as a public `description` event. The next `buildAgentContext` reads this formal public history through its existing allowlist, so it observes the current-round AI prefix without access to roles or words.

The phase changes to `voting` only after the final required AI description succeeds. If an Agent throws—including the fourth—the already-public prefix is retained and the phase remains `describing`; the failed and later players contribute no description. This is an intentional partial-round state, with retry/recovery deferred to M5. Tests observe prefix sizes `0, 1, 2, 3`, verify each success is externally visible before the next AI begins, and inject a fourth-Agent failure to verify the retained three-AI prefix.

The browser starts the normal `POST /describe` action once and refreshes the existing public `GET /api/games/:id` endpoint while it is pending. That small polling loop surfaces each committed description and event without streaming provider data or exposing any private model input/output. It stops before applying the final action response, so a delayed poll cannot overwrite the transition to `voting`.

Voting remains `Promise.all` over one snapshot. `AgentContext` contains no votes, so current-ballot choices cannot influence later voters.

## Planned quality and observability

Quality policies will be enforced through composable server-side rules. A redacted trace sink will then connect model attempts, quality decisions, evaluation metrics, fault injection, and replay without placing secrets in trace records.
