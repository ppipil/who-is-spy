# M3 incremental public-description commit

## Scope

This extension keeps the M3 product boundaries: the Human is fixed first, living AI players use the existing stable `players[]` / profile order, and voting, elimination, ties, roles, secrets, and server-side adjudication are unchanged. It does not add a seat scheduler, Quality Gate, provider retry/fallback/replay, or batch evaluation.

## State flow

Before this extension, AI descriptions were generated sequentially into an action-local list and committed as one batch. Now the flow is:

```text
Human public description
  → AI1 generate → public description + event commit
  → AI2 reads formal public prefix → commit
  → AI3 reads formal public prefix → commit
  → AI4 reads formal public prefix → commit
  → phase: voting
```

`GameEngine.commitDescription` is the sole description/event commit point. `enterVoting` runs only after all required living AI descriptions return successfully. Thus a failed fourth AI leaves the Human plus the first three AI descriptions public and the phase at `describing`; no failed or later-player description is created. Recovery is intentionally an M5 concern.

## Browser delivery

The browser performs one ordinary `POST /describe`. While that request is pending, it polls the existing public `GET /api/games/:id` endpoint every 250 ms. THE ROUND TABLE and the event feed therefore render each already-committed description independently, while the action status identifies the next living AI and its `n/5` progress. This is polling, not SSE or WebSocket; it carries only the existing public game DTO and never provider prompts, responses, reasoning, roles, or words.

## Deterministic evidence

`game-engine.test.ts` pauses the model between each AI response. It observes the formal description IDs change from `human` to `human, ai-1`, then through all four AI players, before each next model call is released. The captured contexts still show same-round public AI prefix counts `[0, 1, 2, 3]`.

The injected fourth-AI failure test observes exactly `human, ai-1, ai-2, ai-3` in both descriptions and public description events, no voting transition, and no fourth-AI description. `app.test.ts` starts a real HTTP `/describe` request with the same paused model and verifies that intermediate `GET /api/games/:id` responses expose the Human-only prefix and then the first-AI prefix, with no role or word fields in player DTOs.

These are deterministic product/API tests. No new DeepSeek call was needed for this UI/state delivery change, and the earlier 3-game DeepSeek report remains evidence for the original `8ce7f23` sequential-context baseline rather than a formal result for this extension.
