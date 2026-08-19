# M3 incremental public-description commit

## Scope

This extension keeps the M3 product boundaries: the Human is fixed first, living AI players use the existing stable `players[]` / profile order, and elimination, ties, roles, secrets, and server-side adjudication remain authoritative on the server. It does not add a seat scheduler, Quality Gate, provider retry/fallback/replay, or batch evaluation.

## State flow

Before this extension, AI descriptions were generated sequentially into an action-local list and committed as one batch. The final M3 flow is now:

```text
Human public description
  -> AI1 generate -> public description + event commit
  -> AI2 reads formal public prefix -> commit
  -> AI3 reads formal public prefix -> commit
  -> AI4 reads formal public prefix -> commit
  -> phase: voting
  -> private AI vote prefetch for this game + round + ballot + eligibleTargetIds
```

`GameEngine.commitDescription` is the sole description/event commit point. `enterVoting` runs only after all required living AI descriptions return successfully. Thus a failed fourth AI leaves the Human plus the first three AI descriptions public and the phase at `describing`; no failed or later-player description is created. Recovery is intentionally an M5 concern.

## Browser delivery

The browser performs one ordinary `POST /describe`. While that request is pending, it subscribes to `GET /api/games/:id/events` with Server-Sent Events. The server emits only public progress events:

- `description_published`: `gameId`, public `playerId/playerName/text/round`, public event, phase, completed/total progress, and next public speaker.
- `phase_changed`: public phase/round/ballot/eligible target IDs and the public system event.

No role, word, provider prompt, provider response, private reasoning, or Authorization value is sent on the SSE channel. If SSE disconnects, the final `/describe` response still converges the browser to the authoritative public state.

THE ROUND TABLE now renders a completed description card as soon as a matching `description_published` event reaches the client. The public record uses the same event IDs and de-duplicates against the final `/describe` response to avoid duplicate entries or stale overwrite.

## Vote prefetch

When the game enters `voting`, the server starts AI vote generation in the background. These votes are private pending results and are not pushed to the browser, appended to `GameState.votes`, or used for adjudication until the Human submits a vote.

Pending votes are bound to:

```text
gameId + round + ballot + eligibleTargetIds
```

If ballot 1 ties, ballot 2 gets a new `eligibleTargetIds` set and therefore starts a fresh AI vote prefetch. The old pending result cannot be reused across ballot/round boundaries. This is a latency optimization only; it does not change the legal target set, tie behavior, elimination, or winner calculation.

## Deterministic evidence

`game-engine.test.ts` pauses the model between each AI response. It observes the formal description IDs change from `human` to `human, ai-1`, then through all four AI players, before each next model call is released. Captured contexts still show same-round public AI prefix counts `[0, 1, 2, 3]`.

The injected fourth-AI failure test observes exactly `human, ai-1, ai-2, ai-3` in both descriptions and public description events, no voting transition, and no fourth-AI description.

`app.test.ts` verifies the SSE endpoint streams `description_published` and `phase_changed` events with public-safe fields only.

The vote-prefetch test verifies AI votes are generated while the game is in `voting`, remain absent from formal `GameState.votes` before the Human vote, and are regenerated for ballot 2 with the restricted eligible target set.
