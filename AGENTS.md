# Repository guidance

- Develop the candidate solution in `packages/server-node`; keep `packages/server-go` unchanged.
- Treat `npm run contract:node` as a hard compatibility gate.
- Never expose another player's role or word, API keys, full unredacted prompts, or hidden reasoning.
- After changing `AgentContext`, run isolation tests, Node tests, and the Node contract.
- After changing `GameEngine`, run domain tests, Node tests, and the Node contract.
- After changing model calls, run provider, quality-gate, fault, Node, and contract tests.
- Update the matching section of `DECISIONS.md` at each milestone with only real commands and evidence.
- Commit only after relevant tests pass; keep milestones in separate, meaningful commits.
- Avoid unrelated heavy frameworks and keep deterministic game rules server-authoritative.
- A milestone is complete only when implementation, tests, contract, documentation, diff review, and secret scan agree.

