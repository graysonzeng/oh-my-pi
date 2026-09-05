# Design Review Gate — DevFlow Autopilot Pipeline (subagent-sol r5)

- **Design**: `docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md`
- **SHA-256**: `258d99032b14e0d5f401f3d9804bd5c05c4ee87a8464ddd10cb83a6640fec3ca`
- **reviewed_revision**: `31e110e5bcd80b2aad73c734d4e1b10e8b0824dd23af3a40099c583517d5265e`
- **review_mode**: host-native
- **author**: GrokDesignAuthor / gateway/grok-4.6
- **reviewer**: subagent-sol / gateway/gpt-5.6-sol (shadowReview: code)
- **review_fallback**: none
- **implementation_authorization**: design-only
- Parent spawn: `SolDesignGateR5` (prior r4 verdict NEEDS_REVISION was adopted; this is the re-review of the rewritten body).

## Reviewer body

- **Mode:** design-only, read-only
- **Author:** GrokDesignAuthor / grok
- **Reviewed input:** `docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md`
- **Measured SHA-256:** `258d99032b14e0d5f401f3d9804bd5c05c4ee87a8464ddd10cb83a6640fec3ca`
- **Implementation authorization:** remains `design-only`

## Findings

### P1 — Persist the devflow discriminator and initial grilling sidecar in the workflow’s creation write

**Trigger:** A process stops after `engine.start` creates the workflow row but before the design’s subsequent “immediate” write of pre-stage Q&A to `grill.answers`, or the workflow is hydrated after restart and must decide whether it is legacy or `devflow`.

**Impact:** The design requires restart-safe answers and says absence of `pipelineKind` selects the legacy graph, but it specifies only a type-level `pipelineKind` and a new sidecar column—not where the discriminator is durably stored or how either value enters the initial `INSERT`. A restarted row can therefore lose the devflow branch and use the legacy reviewer/auditor behavior. The initial request still contains folded Q&A, but the required same-row `grill.answers` replay/audit state is not guaranteed at the creation boundary.

**Evidence:**

- Restart durability is a success criterion at `docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:34-35`.
- The detailed flow performs `engine.start` and only then writes the initial sidecar, while separately asserting that the row has `pipelineKind: "devflow"`, at `docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:183-185`.
- The storage design names only `overlay_sidecar_json TEXT`; `pipelineKind` is specified only in `types.ts`, and the legacy rule depends on its absence, at `docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:224-226`, `:245`, and `:360`.
- The current canonical create/hydrate path explicitly inserts and maps a fixed field list with neither value at `packages/coding-agent/src/workflow/sqlite-store.ts:140-178`.
- The proposed restart test covers answers already present in store, not the pre-start Q&A creation boundary, at `docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:331`.

**Required revision:** Define one atomic creation contract—e.g. `createWorkflow(request, policy, { pipelineKind, overlaySidecar })`—that writes the discriminator and initialized sidecar in the initial workflow-row `INSERT`. Specify migration/hydration for the discriminator (a same-row column or an explicitly documented canonical encoding), and add a restart test beginning from pre-start grilling Q&A that discards process memory immediately after row creation.

### P1 — Make `GateResultArtifact` a context-bound, total input to the existing review schemas

**Trigger:** A reviewer emits valid JSON with the wrong known `subject`, stale `workflowId`/`attemptId`, claimed reviewer identity that differs from the actual invocation, or `NEEDS_REVISION` with the currently permitted default empty `findings` array.

**Impact:** Schema validity alone does not bind the model-produced envelope to the current workflow stage. A code-review result mislabeled `subject: "plan"` can enter the plan-only `replan_exempt` intent, while a plan result mislabeled `subject: "implementation"` can become terminal `block`. Separately, the design promises to derive an existing `ReviewArtifact`/`PlanReviewArtifactV2`, but its Gate schema omits required conversion data and permits an empty finding list for `NEEDS_REVISION`; the canonical review schemas require confidence and at least one finding for `changes_requested`. The transport is therefore not yet a total, fail-closed conversion.

**Evidence:**

- Runtime extraction and adapter routing are specified at `docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:186-190` and `:268-274`.
- The proposed schema accepts either known subject, defaults findings to `[]`, and treats only missing/unknown fields as parse errors at `docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:246-254`.
- The same envelope carries model-provided `reviewerIdentity`, `workflowId`, and `attemptId` at `docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:252-253`, but no equality/stamping rule binds them to the runtime invocation.
- Canonical `ReviewArtifactSchema` requires typed findings and confidence, and rejects `changes_requested` without a finding, at `packages/coding-agent/src/workflow/schemas.ts:121-136`. `PlanReviewArtifactV2Schema` has additional required fields and the same non-empty-finding invariant at `packages/coding-agent/src/workflow/schemas.ts:233-267`.
- `#persistArtifact` stores the supplied body unchanged while indexing it with separately supplied workflow/attempt metadata, so mismatched body identity is not corrected automatically, at `packages/coding-agent/src/workflow/engine.ts:3656-3682`.

**Required revision:** Define `parseGateResultArtifact(raw, expectedContext)` or an equivalent engine-owned envelope step that fail-closes unless `subject` matches the current stage and that stamps or verifies `workflowId`, `attemptId`, timestamps, and reviewer identity against runtime-owned evidence. Define one exact Gate finding schema and a total derivation to one named canonical review schema, including every required field. Add conditional validation/tests for stage/subject mismatch, stale IDs, identity mismatch, and `NEEDS_REVISION` without actionable findings.

### P1 — Remove the second workflow-row update from `replanFromRedesign`

**Trigger:** A successful `replanFromRedesign` reaches the design’s post-commit `releaseRunner` step.

**Impact:** The design and its required test say the method executes exactly one `workflows` update, but the canonical `releaseRunner` is itself another `UPDATE workflows` and increments `version` when ownership matches. This contradicts the same-row/one-update contract and makes the specified store-mock assertion fail; when a runner is held, it also advances the version a second time outside the transition CAS.

**Evidence:**

- The transition CAS is specified as one transaction at `docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:217-218`, followed by a separate `releaseRunner` at `:219`.
- The storage contract reiterates that one `replanFromRedesign` invocation contains only one workflow-row update at `docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:225-226`; the test requires “恰好一次 `UPDATE`” at `:330`.
- The existing canonical release implementation executes `UPDATE workflows SET runner_owner = NULL, … version = version + 1` at `packages/coding-agent/src/workflow/sqlite-store.ts:500-506`.

**Required revision:** Either prove and specify that `replanFromRedesign` cannot hold a runner and remove the release call, or clear `runner_owner` in the same status+sidecar CAS and remove the post-commit workflow update. The verification plan should count executed workflow-row update statements, not merely rows changed.

## Verified Gate coverage

- **Hash/input:** The measured hash exactly matches the assigned current revision. The full current design was read.
- **F1 transport direction:** The design now persists `GateResultArtifact`, calls the adapter, and only afterward derives legacy review decisions; plan `NEEDS_REDESIGN` explicitly avoids `changes_requested` and `planRejectionCount` at `docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:186-190`, `:246-274`, and `:329`.
- **F2 post-create answer flow:** For `incomplete_plan` and `needs_redesign`, the answer is appended before `resume`/`replanFromRedesign`, retained in the sidecar, injected into planner context, and covered by a store-only rehydration test at `docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:185`, `:192-193`, `:256-260`, and `:331`. Finding 1 is limited to the initial creation boundary and durable discriminator.
- **F3 transition semantics:** The design uses the existing `plan_review → planning` edge and explicitly bypasses the counted rejection path at `docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:190`, `:213-218`, and `:330`. The edge exists at `packages/coding-agent/src/workflow/transitions.ts:3-7`. Current counted rejection behavior is confirmed at `packages/coding-agent/src/workflow/engine.ts:1598-1611` and `:1626-1640`; awaiting-human becomes terminal `blocked` at `packages/coding-agent/src/workflow/engine.ts:3591-3607`.
- **32-step cap:** The design preserves and exposes the limit; the current engine uses `maxSteps = singleStep ? 1 : 32` at `packages/coding-agent/src/workflow/engine.ts:880-889`.
- **Boundaries:** The design keeps `WorkflowEngine` as canonical owner, adds no `WorkflowStatus`/`WorkflowRole`, keeps Flash as a non-authoritative oneshot, preserves ordinary `/goal complete`, separates `/delivery` from `workflowz`, and prohibits grok reviewing grok-authored work at `docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:41-60`, `:171-180`, `:227-240`, and `:341-362`.

## Verdict

**NEEDS_REVISION**

The overlay architecture remains the correct canonical-owner choice, and the prior Gate’s three intended mechanisms are now materially present; a redesign is not warranted. Implementation is still blocked because the creation write, Gate envelope boundary, and exact-one-update replan contract are not yet closed enough to implement without violating named durability and fail-closed requirements.
