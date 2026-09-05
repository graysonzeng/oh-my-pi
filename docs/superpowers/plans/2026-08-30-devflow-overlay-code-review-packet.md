# Code review packet — DevFlow Autopilot Pipeline overlay

This packet is immutable for the spawned reviewers. Do not rerun an unscoped repository diff. Do not scan unrelated dirty files.

## Pinned SHAs

- Fixed point: `34f89830669c9720fc5401f77a6168e96f2007ea` (parent of overlay commit)
- HEAD: `969cd80df350019b7aa9ad33bb5dee2df5c11ec3`
- Branch: `workflow` (ahead origin/workflow 10)
- Overlay commit: `969cd80df3 feat: add DevFlow autopilot pipeline overlay and /delivery`
- Design SHA-256: `98ba31752d21c0631741fc6c718b8922ef2c204219030b552043ed8e4632ec8f`
- Sol r7 SHA-256: `a297453382e701c82b6fa0e12e3604e4ad9eae998aad5b6e1384a76e85282643`

## Spec source

- Authoritative: `docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md`
- Gate notes (PASS_WITH_NOTES, Continuity P2): `docs/superpowers/plans/2026-08-30-devflow-autopilot-pipeline-sol-review-r7.md`
- Implementation authorization: user verbally changed design-only to authorized; do not treat remaining `implementation_authorization: design-only` in the design file as a code defect.
- User landing constraints: scheme A overlay only; no second engine; no new WorkflowStatus/Role; no `/goal complete` change; no workflowz; `createWorkflow` one INSERT of `pipeline_kind`+`overlay_sidecar_json`; `/delivery` SlashCommandSpec in `builtin-modes.ts`; `GateResultArtifact` + `parseGateResultArtifact(raw, expected)`; `grill.answers`; `replanFromRedesign` CAS `WHERE runner_owner IS NULL`, same UPDATE `runner_owner=NULL`, no `releaseRunner`; PASS* must not retain open P0/P1/`blocking===true`; `op=run` ≤32 steps; Continuity P2 test; §6 tests under `packages/coding-agent/test/workflow/`; one user-facing changelog line.

## Standards sources

- `AGENTS.md` / `CLAUDE.md` (repo coding-agent rules): no `any`, no `ReturnType<>`, no inline imports, `#private` fields, prompts in static `.md` + Handlebars, bun APIs, logger not `console.*` in TUI paths, test contract rules, changelog under `[Unreleased]`.
- Fowler smell baseline (judgement calls only; repo docs win; skip tooling-enforced items): Mysterious Name, Duplicated Code, Feature Envy, Data Clumps, Primitive Obsession, Repeated Switches, Shotgun Surgery, Divergent Change, Speculative Generality, Message Chains, Middle Man, Refused Bequest.

## Captured diff

- Artifact: `docs/superpowers/plans/2026-08-30-devflow-overlay-code-review.diff`
- Contents: committed three-dot overlay paths + uncommitted overlay working tree + untracked overlay files (`pipeline-auditor.ts`, `session-engine.ts`, `completeness-auditor-user.hbs.md`).

## Changed-file manifest (in scope)

Committed (`34f8983066...HEAD`):

- `packages/coding-agent/src/modes/delivery.ts`
- `packages/coding-agent/src/prompts/tools/workflow.md`
- `packages/coding-agent/src/prompts/workflow/completeness-auditor.md`
- `packages/coding-agent/src/prompts/workflow/context-plan.hbs.md`
- `packages/coding-agent/src/prompts/workflow/gate-review-adapter.md`
- `packages/coding-agent/src/slash-commands/builtin-modes.ts`
- `packages/coding-agent/src/workflow/context-builder.ts`
- `packages/coding-agent/src/workflow/default-config.ts`
- `packages/coding-agent/src/workflow/engine.ts`
- `packages/coding-agent/src/workflow/gate-adapter.ts`
- `packages/coding-agent/src/workflow/gate-derive.ts`
- `packages/coding-agent/src/workflow/index.ts`
- `packages/coding-agent/src/workflow/json-schemas.ts`
- `packages/coding-agent/src/workflow/overlay.ts`
- `packages/coding-agent/src/workflow/runtime-adapter.ts`
- `packages/coding-agent/src/workflow/schemas.ts`
- `packages/coding-agent/src/workflow/sqlite-store.ts`
- `packages/coding-agent/src/workflow/types.ts`
- `packages/coding-agent/src/workflow/workflow-tool.ts`
- `packages/coding-agent/test/workflow/devflow-pipeline-overlay.test.ts`
- `packages/coding-agent/test/workflow/helpers.ts`

Uncommitted / untracked also in scope:

- `docs/workflow.md`
- `packages/coding-agent/CHANGELOG.md`
- `packages/coding-agent/src/tools/index.ts` (production engine factory → `session-engine`)
- `packages/coding-agent/src/workflow/pipeline-auditor.ts` (new)
- `packages/coding-agent/src/workflow/session-engine.ts` (new)
- `packages/coding-agent/src/prompts/workflow/completeness-auditor-user.hbs.md` (new)
- `packages/coding-agent/src/workflow/runtime-default.ts` (`shadowReview` forward)
- working-tree edits on `delivery.ts`, `overlay.ts`, `sqlite-store.ts`, `workflow-tool.ts`, overlay tests, `gate-derive.ts`, `json-schemas.ts`

## Out of scope (do not review)

- `packages/coding-agent/src/session/agent-session.ts`
- `packages/coding-agent/src/tools/read.ts`, `read-selector.ts`
- `packages/coding-agent/src/task/*` except as a consumer of `shadowReview`
- Other dirty docs/plans, consult/latency/shadow-mind tests
- `packages/coding-agent/src/goals/` (must remain untouched)
- `modes/workflow.ts` / workflowz
- Design-file `implementation_authorization: design-only` leftover wording

## Reviewer rules

- Read-only. No edits, no builds, no project-wide test suites.
- Consume this packet + the captured diff artifact + the named spec files.
- Ground findings at `file:line`. Distinguish fact / inference / unverified.
- Report an issue only when: provable impact, actionable fix, unintentional, introduced in this patch, no unstated assumptions.
- Do not wait for shadow-review async results.
