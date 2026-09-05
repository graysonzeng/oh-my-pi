# Design Review Gate — DevFlow Autopilot Pipeline (subagent-sol)

- **Design**: `docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md`
- **SHA-256**: `c12991e95272c5134ee9deb8ff38b59ca7b8e088a4442d9d456d97e2ed5fd386`
- **reviewed_revision**: `c713622a060f4122956e13b701a41a395f8713c35f1cb9cebd2db30e62e896e5`
- **review_mode**: host-native
- **author**: GrokDesignAuthor / gateway/grok-4.6
- **reviewer**: subagent-sol / gateway/gpt-5.6-sol (shadowReview: code)
- **review_fallback**: none（本轮鉴权可用）
- **implementation_authorization**: design-only
- Parent spawn: `SolDesignGateR4`. Prior sol attempts (`SolDesignGate-2`, `SolDesignGateR3`) produced no verdict.

## Reviewer body

- **Reviewer:** subagent-sol / gateway/gpt-5.6-sol
- **Review mode:** host-native, read-only
- **Design author:** grok
- **review_fallback:** none
- **Verdict:** **NEEDS_REVISION**

## Reviewed Inputs

| Input | Coverage | SHA-256 |
|---|---:|---|
| `docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md` | Full file, 352 lines | `c12991e95272c5134ee9deb8ff38b59ca7b8e088a4442d9d456d97e2ed5fd386` |

The hash was freshly computed and matches the Gate brief exactly.

## Findings

### P1 — The four-value Gate verdict has no typed, validated transport into `gate-adapter`

**Trigger:** A native `subagent-sol`/`subagent-grok` review returns any Gate verdict, especially plan-level `NEEDS_REDESIGN`.

**Evidence:**

- The design establishes that the existing review artifact can represent only `approved | changes_requested | blocked`, not the Dev Flow four-value verdict (`docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:69`).
- It simultaneously requires the reviewer output to fit `PlanReviewArtifactV2`, forbids putting the four-value verdict into `review.decision`, and says the four-value verdict reaches `gate-adapter` separately (`docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:177`).
- The proposed schema work adds only `CompletenessAuditorArtifact`; no Gate-result schema or runtime response envelope is defined (`docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:231-234`).

**Impact:** There is no specified producer/parser/persistence seam that can supply `NEEDS_REDESIGN` to the pure adapter. Encoding it as existing `changes_requested` would violate F1 and consume `planRejectionCount`; parsing it from prose would be unversioned and fail to meet the design’s artifact/fail-closed model. Consequently, the central `replan_exempt` path is not implementable from the specified contracts.

**Required revision:** Define a versioned Gate-result artifact or typed RuntimeAdapter envelope containing at least `verdict`, `subject`, findings/notes, reviewer identity, and schema version; define its parser, validation/fail-closed behavior, persistence owner, and exact conversion into both overlay intent and the existing durable review record. Add a test that round-trips plan `NEEDS_REDESIGN` from reviewer output to `replan_exempt` without ever materializing `changes_requested`.

### P1 — In-flight grilling answers are neither persisted nor added to the resumed planner input

**Trigger:** Planning completeness reaches `awaiting_grill`, or plan review returns `NEEDS_REDESIGN`, and the user supplies the requested clarification.

**Evidence:**

- The initial transcript is collected into `request` before the workflow starts (`docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:169-171`).
- For the two in-flight pauses, the design says only to call existing `resume` or `replanFromRedesign` after the user answers (`docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:174,181`).
- The durable sidecar stores round, last question, missing items, reason, retry count, and note references, but no answer/clarification payload or reference to one (`docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:233`).
- The recovery path claims that a killed session can restore the pause and resume it (`docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:268`).

**Impact:** After the user answers, the resumed planner has no specified durable source for that answer. It can therefore regenerate from the old request, repeat the same question, or redesign without the authority the user just supplied; after process/session loss, the clarification is definitively unrecoverable from the proposed sidecar contract.

**Required revision:** Persist each accepted clarification as an immutable, versioned answer record (or an explicit sidecar field/reference), bind it to workflow ID, pause reason, question round, and workflow version, and specify how planner prompt assembly consumes it on the next attempt. Cover both `incomplete_plan` and `needs_redesign`, including a restart-after-answer test.

### P2 — `replanFromRedesign` does not define an atomic or idempotent state/sidecar commit

**Trigger:** The process exits or storage fails between the `plan_review → planning` transition and clearing the `needs_redesign` pause.

**Evidence:**

- The method is specified as first persisting the workflow transition and later clearing the sidecar (`docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:207-210`).
- The sidecar may be either a JSON column or a separate table, but the design defines no shared transaction, compare-and-swap invariant, or recovery reconciliation (`docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:233`).
- Durable recovery during grilling is an explicit requirement (`docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:268`).

**Impact:** A crash after the workflow transition but before sidecar clearing can leave `status=planning` with `reason=needs_redesign`; the pause guard can reject normal resume while `replanFromRedesign` rejects the now-wrong status. Reversing the write order creates the dual failure: `plan_review` appears runnable before the exempt transition was committed. Either outcome breaks the promised resumability.

**Required revision:** Require one `WorkflowStore` transaction/CAS operation to persist the versioned transition, preserve both counters, update the sidecar phase/reason, and commit the attempt record; release the runner only after commit. If a single transaction is impossible, define an idempotency key and explicit reconciliation rules for both partial states. Add crash-injection coverage at the transition/sidecar boundary.

## Mandatory Mechanism Checks

### F1 — `replanFromRedesign`

**Mechanism direction is correct, but the end-to-end contract is incomplete.** The design explicitly bypasses `changes_requested`, preserves `planRejectionCount`/`#planCycles`, and uses the existing legal edge (`docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:203-210`). The repository spot-check confirms why this is necessary: `changes_requested` increments the rejection count (`packages/coding-agent/src/workflow/engine.ts:1597-1598`), a max-cycle hit calls `#setPlanReviewAwaitingHuman` (`packages/coding-agent/src/workflow/engine.ts:1636-1646`), and that method transitions the top-level workflow to `blocked` (`packages/coding-agent/src/workflow/engine.ts:3592-3605`). The existing graph already permits `plan_review → planning` (`packages/coding-agent/src/workflow/transitions.ts:3-6`, with decision mapping at `packages/coding-agent/src/workflow/transitions.ts:38-40`).

F1 does not pass the Gate yet because Finding 1 leaves `NEEDS_REDESIGN` without a representable input channel, and Finding 3 leaves the exempt transition non-recoverable across a partial write.

### F2 — Planning completeness gate

**Placement and counter semantics are correctly specified:** after a valid PlanArtifact, before `planning → plan_review`; incomplete results remain in `planning`, do not invoke `getNextStage`, and cap at non-terminal `awaiting_grill` (`docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:172-176,211`). The verification plan covers incomplete/complete, cap behavior, legacy bypass, and malformed auditor output (`docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:298-300`).

F2 still needs the clarification-ingestion contract from Finding 2; otherwise the human pause cannot actually improve the next PlanArtifact.

### F3 — 32-step boundary

**Pass.** The design documents one invocation as bounded, returns `maxStepsReached`, and delegates any continuation to a later coordinator `resume` rather than raising the cap or nesting another engine loop (`docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:171,199-212,269,301`). The repository spot-check confirms `maxSteps = singleStep ? 1 : 32` and the single bounded `while` (`packages/coding-agent/src/workflow/engine.ts:880-887`). The proposed test explicitly rejects an engine-internal second `#runLoop` (`docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:301`).

## Gate Decision

The design has the correct architectural owner and correctly addresses the three previously identified engine constraints at the policy level. It nevertheless needs revision before implementation because the core Gate verdict is not representable by the proposed artifact contracts, user clarifications are not durably fed back into planning, and the redesign transition is not crash-consistent with its pause sidecar. These are bounded contract corrections within the recommended overlay; they do **not** require redesigning the selected architecture.
