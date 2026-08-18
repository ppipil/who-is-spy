# Candidate delivery plan

## Guardrails

- Preserve `README.md`, `CANDIDATE_TASK.md`, and `contract/CONTRACT.md` as official baseline documents.
- Use the Node/TypeScript backend only; do not modify the Go implementation.
- Keep the HTTP contract, server-authoritative rules, secret isolation, and atomic state transitions intact.
- Separate deterministic FakeModel evidence from explicitly enabled real-model evidence.

## Milestones

- [x] Verify the copied source against the original source directory by relative path, size, and SHA-256.
- [x] Create the clean baseline commit and `baseline-v1` tag.
- [x] Re-run baseline Node tests, contract, and build; record the Windows launcher issue and fix it separately.
- [x] Add a seeded multi-game evaluation harness and capture pre-strategy baseline metrics.
- [x] Introduce an extensible strategy boundary used by description and vote behavior.
- [ ] Generate descriptions sequentially against staged public context and commit the round atomically.
- [ ] Add composable description quality rules with bounded targeted repair.
- [ ] Add redacted structured traces, deterministic fault injection, and timeline replay.
- [ ] Re-run enhanced evaluation under the same seeds and thresholds.
- [ ] Run explicitly enabled real-model validation when a candidate-owned `.env` is available.
- [ ] Complete final security review, contract/build verification, candidate documents, and Git history review.
