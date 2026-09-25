# Design Review Gate — DevFlow Autopilot Pipeline (subagent-sol r6)

- **Design**: `docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md`
- **SHA-256**: `e30e112208b176125885e606593ab89cc55d9cfbb2aa9beadcc354e5b86f514b`
- **reviewed_revision**: `f03e724cf9370f841f04465c6160b75e281a26d547f9c83103ecba2cfcdd0c8b`
- **review_mode**: host-native
- **author**: GrokDesignAuthor / gateway/grok-4.6
- **reviewer**: subagent-sol / gateway/gpt-5.6-sol (shadowReview: code)
- **review_fallback**: none
- **implementation_authorization**: design-only
- Parent spawn: `SolDesignGateR6` (r5 findings were adopted; this is the re-review of the rewritten body).

## Reviewer body

- **Reviewer:** subagent-sol / gateway/gpt-5.6-sol
- **Author:** grok / GrokDesignAuthor
- **Mode:** design-only; read-only review
- **Reviewed input:** `docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md`
- **Measured SHA-256:** `e30e112208b176125885e606593ab89cc55d9cfbb2aa9beadcc354e5b86f514b`
- **Verified `reviewed_revision`:** `f03e724cf9370f841f04465c6160b75e281a26d547f9c83103ecba2cfcdd0c8b`

## Findings

### P1 — `replanFromRedesign` can clear a different live runner’s lock

**Trigger:** A concurrent `resume` claims the workflow after the redesign pause but before `replanFromRedesign` reads state. The proposed method checks kind/status/sidecar but not `runner_owner`, then executes a CAS that sets `runner_owner=NULL` with predicates only on id, status, and version (`docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:237-249`). If the other runner claimed before the method’s read, the method reads the new version, so its CAS can succeed and erase that live owner.

**Impact:** The first `#runLoop` continues in memory after losing its durable lock; the coordinator can then call `resume` and admit a second runner. That breaks the store’s exclusive-runner invariant and can duplicate attempts or stage side effects. The current owner explicitly protects claims with `(runner_owner IS NULL OR runner_owner = ?)` and rejects a different owner (`packages/coding-agent/src/workflow/sqlite-store.ts:456-480`), so the new mutation must preserve that boundary rather than bypass it.

**Required revision:** Require `runner_owner IS NULL` in both the method precondition and the single CAS `WHERE` clause, returning `runner_lock_held`/policy error with zero writes when another owner exists. Add a concurrency test that claims another owner first and proves `replanFromRedesign` neither clears it nor inserts a transition. This preserves all r5 requirements: exactly one successful `UPDATE workflows`, `runner_owner=NULL` in that statement, version `+1`, and no post-commit `releaseRunner`.

### P1 — The specified `/delivery` entry has no registration or dispatch owner

**Trigger:** The design says its file list is exhaustive, but assigns `/delivery` only to a new `packages/coding-agent/src/modes/delivery.ts` (`docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:227-230,253-257`). Built-in slash commands are not discovered by scanning `modes/`; they come from statically imported command arrays (`packages/coding-agent/src/slash-commands/builtin-registry.ts:1-16`) assembled into the sole lookup registry (`packages/coding-agent/src/slash-commands/builtin-registry.ts:38-50`). Mode commands themselves are declared as `SlashCommandSpec` entries in `BUILTIN_MODE_SLASH_COMMANDS` (`packages/coding-agent/src/slash-commands/builtin-modes.ts:172-185`).

**Impact:** Implementing the listed paths literally leaves `/delivery` unavailable and undispatchable, so the primary user acceptance path cannot start `workflow op=run pipeline=devflow`.

**Required revision:** Name the canonical slash-command owner: either add a `delivery` `SlashCommandSpec` to `builtin-modes.ts`, or add a dedicated built-in command array and import it from `builtin-registry.ts`; wire that handler to the delivery coordinator. Add an availability/dispatch test proving `/delivery` reaches `op=run pipeline=devflow`. `modes/delivery.ts` may remain the orchestration implementation, but it cannot be the only listed integration point.

### P1 — An implementation `PASS*` can still carry an open blocking finding and be persisted as approved

**Trigger:** The proposed parser rejects empty findings only for `NEEDS_REVISION`; `PASS` and `PASS_WITH_NOTES` can carry findings, after which the engine derives `decision: "approved"` (`docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:203-210`). The current plan V2 schema rejects approval with any open `blocking`, P0, or P1 finding (`packages/coding-agent/src/workflow/schemas.ts:270-300`), but the implementation `ReviewArtifactSchema` has no equivalent approval invariant—it validates only `changes_requested` and `blocked` (`packages/coding-agent/src/workflow/schemas.ts:121-145`). Consequently, a context-valid implementation Gate result such as `PASS_WITH_NOTES` plus an open P0 finding passes `deriveReviewArtifact`, persists as approved, and follows `code_review → final_verify` (`packages/coding-agent/src/workflow/transitions.ts:50-55`).

**Impact:** The new supposedly fail-closed Gate boundary can authorize code while its own durable artifact records a blocker, skipping the repair loop.

**Required revision:** Make approval consistency a subject-independent Gate invariant: `PASS`/`PASS_WITH_NOTES` must reject any open finding with `blocking=true` or priority P0/P1 before persistence/transition (or enforce the same invariant in both derivation functions). Add plan and implementation tests for contradictory approval; P2/P3 non-blocking notes may remain allowed.

## Gate checks completed

- **Atomic create contract is now present:** the initial devflow row carries kind plus the sidecar/answers in the same INSERT, legacy calls write NULL, and `#mapState` hydrates both (`docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:31-39,195-200,233-240,352-356`). This directly closes the current store gap, whose INSERT and mapper omit both fields (`packages/coding-agent/src/workflow/sqlite-store.ts:145-178`).
- **Context-bound Gate parse is now present:** subject, optional supplied ids, and identity family are checked against expected context; the engine stamps ids/full identity; `NEEDS_REVISION` requires at least one finding; approve and counted-replan records are engine-derived; exempt redesign persists no `changes_requested` review (`docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:203-214,271-275,299-304,352-357`). The requirement is grounded by the existing `changes_requested ⇒ findings.length > 0` rules (`packages/coding-agent/src/workflow/schemas.ts:121-145,233-269`).
- **The intended redesign count behavior is correctly routed around the current counted path:** current code increments only on `changes_requested` and blocks at the configured ceiling (`packages/coding-agent/src/workflow/engine.ts:1596-1613,1630-1650`); the design’s exempt path does not create that decision or call that handler (`docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:211-214,243-250`). The existing `plan_review → planning` edge supports the dedicated transition without changing `VALID_TRANSITIONS` (`packages/coding-agent/src/workflow/transitions.ts:3-16`).
- **One-update/no-release shape is explicitly specified and tested:** the successful replan CAS updates status, sidecar, and `runner_owner=NULL`, increments version once, and performs no post-commit release (`docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:237-250,355-359`). This correctly avoids the current `releaseRunner` update and its additional version increment (`packages/coding-agent/src/workflow/sqlite-store.ts:500-506`), subject to the lock-ownership correction above.
- **The 32-step claim is grounded:** the design preserves the cap and exposes `maxStepsReached` rather than adding another engine loop (`docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:40-50,231-235,251-252`); current `#runLoop` uses `singleStep ? 1 : 32` (`packages/coding-agent/src/workflow/engine.ts:862-887`).
- **Architecture direction remains sound:** the recommended option keeps `WorkflowEngine` as canonical durable owner, leaves `WorkflowStatus`/`WorkflowRole` and `VALID_TRANSITIONS` closed, and does not introduce a second store or execution engine (`docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md:151-170,371-390`).

## Verdict

**NEEDS_REVISION**

The r5 atomic-create, expected-context, engine-derived-artifact, and one-update/no-release contracts are materially closed. The design does not need a new architecture, but the runner-ownership race, unreachable `/delivery` entry, and fail-open implementation approval are three implementation-blocking contract gaps that must be corrected before authorization.
