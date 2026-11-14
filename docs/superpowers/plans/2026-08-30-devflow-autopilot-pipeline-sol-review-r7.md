# Design Review Gate — DevFlow Autopilot Pipeline (subagent-sol r7)

- **Design**: `docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md`
- **SHA-256**: `98ba31752d21c0631741fc6c718b8922ef2c204219030b552043ed8e4632ec8f`
- **reviewed_revision**: `19cbf1b10e5294bbaf7c2e13b32985780e82b41973f9034c2440ae04abd535b9`
- **review_mode**: host-native
- **author**: GrokDesignAuthor / gateway/grok-4.6
- **reviewer**: subagent-sol / gateway/gpt-5.6-sol (shadowReview: code)
- **review_fallback**: none
- **implementation_authorization**: design-only
- Parent spawn: `SolDesignGateR7` (r6 findings were adopted; this is the re-review of the rewritten body).

## Reviewer body

- **Reviewer:** subagent-sol / gateway/gpt-5.6-sol
- **Mode:** read-only, design-only
- **Measured SHA-256:** `98ba31752d21c0631741fc6c718b8922ef2c204219030b552043ed8e4632ec8f`
- **Reviewed input:** `docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md` — `98ba31752d21c0631741fc6c718b8922ef2c204219030b552043ed8e4632ec8f`
- **Authorization:** design-only; no implementation or file writes performed (`docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:10-11,357`).

## Findings

### [P2] Make the low-priority blocking rule unambiguous and test its second predicate arm

- **Trigger:** A `PASS` / `PASS_WITH_NOTES` result contains an open P2/P3 finding with `blocking: true`.
- **Impact:** The exact predicate correctly rejects every open finding where `blocking === true` or priority is P0/P1, but the following sentence says “P2/P3 **or** `blocking!==true` notes are allowed.” Read literally, that sentence permits a blocking P2/P3 finding and contradicts both the predicate and the adapter table. The verification plan covers open P0 and non-blocking P3, but not the independent `blocking === true` branch (`docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:208,276-277,330`).
- **Action:** Replace the permissive sentence with “open P2/P3 **and** `blocking !== true` notes are allowed,” and add plan plus implementation cases for `PASS_WITH_NOTES` with open P2/P3 + `blocking: true`, asserting fail-closed before persistence/transition and no downgrade to `NEEDS_REVISION`.
- **Why non-blocking for this Gate:** The operative condition is already stated exactly and repeatedly at `docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:38,208,252,256,295`, and the two subject paths and their baseline tests are named. This is a wording/branch-coverage correction, not an unresolved ownership or control-flow decision.

## Gate Evidence

### 1. Runner lock contract — closed

The current baseline confirms the race identified in r6: `claimRunner` only updates when the lock is null or already held by the same owner, while `releaseRunner` is a separate `UPDATE workflows` that clears the owner and increments the version (`packages/coding-agent/src/workflow/sqlite-store.ts:458-485,499-508`).

The revised design now specifies all required protections:

- `replanFromRedesign` checks `runner_owner IS NULL`; any held lock returns `runner_lock_held` with zero writes (`docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:43,245-247`).
- The transactional CAS has `WHERE ... status='plan_review' AND version=? AND runner_owner IS NULL`, and its sole `UPDATE workflows` sets status/sidecar plus `runner_owner=NULL` (`docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:237-241`).
- The success path performs no post-commit `releaseRunner`/`clearRunnerOwner`; the already-successful path is a zero-`UPDATE` no-op that does not touch even a currently held lock (`docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:244-250`).
- The verification plan claims another owner first, checks `runner_lock_held`, no transition, unchanged owner, exactly one successful workflow update, no subsequent release, version `+1`, and a zero-write idempotent second call (`docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:332`).

This closes the lock-stealing, double-version-bump, and idempotence gaps without introducing another runner engine.

### 2. `/delivery` slash-command owner — closed

The current registry is static: `BUILTIN_SLASH_COMMAND_REGISTRY` spreads `BUILTIN_MODE_SLASH_COMMANDS`, and lookup reads that map (`packages/coding-agent/src/slash-commands/builtin-registry.ts:38-50,173-174`). `BUILTIN_MODE_SLASH_COMMANDS` is the existing owner at `packages/coding-agent/src/slash-commands/builtin-modes.ts:178`; `/goal` demonstrates the same ownership pattern at `packages/coding-agent/src/slash-commands/builtin-modes.ts:278-300`.

The design now explicitly requires:

- a `SlashCommandSpec` with `name: "delivery"` in `builtin-modes.ts`;
- its handler to call the coordinator in `modes/delivery.ts`;
- that coordinator to invoke `workflow op=run pipeline=devflow`;
- no new registry and no `workflowz` coupling (`docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:202,229-236,327,344`).

The lookup and handler-routing tests at `docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:327` cover both discovery and dispatch, so the prior “coordinator exists but command is undiscoverable” hole is closed at the canonical owner.

### 3. Subject-independent PASS* blockers — closed, with the P2 note above

The baseline asymmetry is real: `PlanReviewArtifactV2Schema` rejects `approved` when an open finding is blocking/P0/P1 (`packages/coding-agent/src/workflow/schemas.ts:286-299`), while `ReviewArtifactSchema` only constrains `changes_requested` and `blocked`, with no corresponding approved invariant (`packages/coding-agent/src/workflow/schemas.ts:121-145`).

The revised design closes the implementation fail-open without changing the legacy schema:

- The exact check is subject-independent and runs before gate-result persistence or transition for both plan and implementation (`docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:38,194,207-208,252`).
- The implementation location is a pipeline-only `assertPassHasNoOpenBlockers` plus both derivation helpers; legacy `ReviewArtifactSchema` remains unchanged (`docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:256-257`).
- Failure retries once and then pauses fail-closed; it neither persists an invented approval nor transitions nor increments counters, and it explicitly must not auto-downgrade to `NEEDS_REVISION`/`replan_counted` (`docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:208,293-300`).
- The plan covers plan and implementation open-P0 rejection, no approved artifact/transition, a permitted non-blocking P3 case, and an explicit no-downgrade assertion (`docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:330`).

### 4. Grounding, quantitative claims, and canonical ownership

- The existing create path is one `INSERT INTO workflows` without pipeline kind/sidecar, and hydration omits those fields (`packages/coding-agent/src/workflow/sqlite-store.ts:145-178`). The design assigns the atomic schema/insert/hydration change to that same store and tests immediate SELECT plus crash hydration (`docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:204,237-240,328`).
- The existing engine uses `maxSteps = singleStep ? 1 : 32` (`packages/coding-agent/src/workflow/engine.ts:880-887`). The design preserves the 32-step cap and makes `maxStepsReached` an explicit non-terminal continuation result instead of wrapping a second loop engine around it (`docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:205,233-236,304,354`).
- The existing plan path increments `planRejectionCount` only for `changes_requested`, and exhausted cycles transition through awaiting-human to terminal `blocked` (`packages/coding-agent/src/workflow/engine.ts:1597-1598,1636-1648,3589-3606`). The current defaults are `maxPlanCycles=2` and `maxRepairCycles=3` (`packages/coding-agent/src/workflow/default-config.ts:706-710`). The design preserves that counted path while keeping `NEEDS_REDESIGN` on an exempt `plan_review → planning` CAS (`docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:209-216,244-250,263,278-281,331-334`).
- DeepSeek V4 Flash is grounded as an existing implementer profile (`packages/coding-agent/src/workflow/default-config.ts:288-300`); the design does not turn it into Gate authority or add a role. It uses a pipeline-only oneshot auditor while retaining deterministic verify stages (`docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:67-70,152,193-198,335,346`).
- The recommended path keeps SQLite, artifacts, isolation, budgets, cancellation, resume, and stage transitions under the existing `WorkflowEngine`; the rejected session-only option is not expanded into a second implementation design (`docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:35,62-80,157-180,185,341-346`). No second engine, leaked persistence seam, or speculative compatibility layer remains in the recommended design.

The root-cause analysis is consistent with these spot-checks: the problem is missing product wiring and typed overlay contracts—not absence of an execution engine—and the chosen changes land at the existing registry, store, schema, runtime-adapter, and engine owners (`docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:108-153`).

## Verdict

**PASS_WITH_NOTES**

All three r6 P1 contracts are now specified at concrete owners with observable tests: lock-safe exempt replanning, canonical `/delivery` registration and dispatch, and subject-independent fail-closed PASS* blockers without auto-downgrade. The remaining P2 is a local wording and missing predicate-branch test issue; it does not require redesign or reopen the accepted overlay architecture.

## Gate Continuity Notes

- Coordinator: Main（未担任本设计 author / reviewer / 正文修改者 / implementer；仅机械落盘评审与本 Note）
- Verdict unchanged: **PASS_WITH_NOTES**
- implementation_authorization unchanged: design-only
- Reviewed Inputs manifest (this Gate):
  - `docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md` SHA-256 `98ba31752d21c0631741fc6c718b8922ef2c204219030b552043ed8e4632ec8f`
- Current Inputs manifest (this Note): **identical**. Design body bytes were not edited after this Gate.
- Classification of the sole P2 (non-material; no design-body rewrite):
  - Operative predicate already rejects any open finding with `blocking===true` **or** P0/P1 (`design.md:208`).
  - The following sentence “P2/P3 或 `blocking!==true`” is a wording slip; implementation MUST treat it as **and**: open P2/P3 notes are allowed only when `blocking !== true`.
  - Add plan + implementation tests for `PASS_WITH_NOTES` + open P2/P3 + `blocking: true` → fail-closed, no persist/transition, no downgrade to `NEEDS_REVISION`.
- Unchanged: overlay owner = WorkflowEngine; `/delivery` in `builtin-modes.ts`; CAS `runner_owner IS NULL`; atomic create INSERT; GateResult expectedContext; grill.answers; F1/F2/F3; Flash 非 Gate; design-only.
- This Note covers the full Inputs set (single design file). It does not modify verdict or authorize implementation.
