# Code Review: Latency Arms, Plan Review V2, and Subagent Timeouts

- Date: 2026-08-04
- Scope: latest eight commits `93927e87ab6965a0d1ff60528a311c697f70adce..c36dd14cbf76482806bb127679d7297e70e6c98a`
- Mode: design-consistency + code review; reviewed implementation/configuration remained read-only
- Conclusion: **NEEDS_FIX**

## 1. Review inputs

### Design inputs

- `docs/superpowers/specs/2026-08-03-latency-optimization-plan-design.md`
- `docs/superpowers/specs/2026-08-04-plan-review-pipeline-design.md`
- `docs/superpowers/specs/2026-08-04-proactive-subagent-delegation-design.md`
- `docs/design/subagent-lifecycle-observability-v2.md`

### Implementation and acceptance input

- `docs/superpowers/plans/2026-08-04-latency-implementation-acceptance.md`
- Production code and focused tests under `packages/coding-agent/`

## 2. Design-consistency assessment

The implementation contains real, default-off runtime paths rather than only schemas:

- ordinary read dedupe has local/URL identity producers and fail-open artifact verification;
- Bash advisory/bounded modes share a session ledger;
- concurrency declarations, work-package lowering, capture/apply merge, and model routing are wired into `WorkflowEngine`;
- PlanReview V2 is parsed at the stage boundary, reviewer identity is retained, and arbitration has a runtime route;
- queued-start and runtime timeout controls are wired into task execution.

The implementation is not safe to call design-complete. The strongest gates are incomplete at trust boundaries: PlanReview validates the plan against the plan itself, arbitration can replay or exceed budget, concurrency accepts tampered declarations and can drop required units, and timeout/Bash terminal accounting has race and exactly-once defects.

### Explicitly deferred, not counted as new defects

The acceptance record already identifies these as incomplete: paired A/B receipts; context-budget tuning experiments; full eval owner cutover; production arbitrator registration; persisted workflow latency-arm snapshots; QualityRouteSnapshotV2; standalone arbitration stage; human authority receipt UI and resumable awaiting-human flow; five plan-review A/B arms; full SQLite atomic control-state migration; and remaining post-acquire timeout interleavings. `docs/design/subagent-lifecycle-observability-v2.md` is still DRAFT/NEEDS_REVISION, so its P1/P2 lifecycle proposal is not treated as shipped functionality.

## 3. Findings

### [HIGH] Correctness: Validate coverage against an authoritative requirements snapshot

**File**: `packages/coding-agent/src/workflow/engine.ts:3039-3043`; `packages/coding-agent/src/workflow/context-builder.ts:57-61`

**Problem**: `#planRequirementsSnapshot()` uses the model-authored PlanArtifact ref and hash as the “requirements snapshot”, and the reviewer context contains only that plan. The schema checks only coverage rows the reviewer emits. A plan that omits a user/spec requirement can therefore return `approved` with `coverage: []` and proceed.

**Impact**: The advertised 100% mandatory-coverage gate cannot detect requirements that the planner omitted. An incomplete plan may be approved and implemented.

**Recommendation**: Persist an engine-owned snapshot of workflow request/spec requirements before planning, assign stable requirement IDs, include that authoritative set in reviewer context, and reject approval unless every applicable mandatory ID appears with valid evidence and the frozen hash matches.

### [HIGH] Trust boundary: Enforce basis-specific finding evidence

**File**: `packages/coding-agent/src/workflow/schemas.ts:156-168,194-255`

**Problem**: The V2 schema validates field types independently but does not enforce the design’s cross-field rules. These values currently parse: `basis="repo_evidence"` with `sourceRefs=[]`; `basis="spec_requirement"` with `requirementId=null`; and `basis="missing_authority"` with `missingAuthority=null`.

**Impact**: Unsupported findings can drive replan, arbitration, blocked, or approval transitions while appearing to satisfy the strict V2 envelope.

**Recommendation**: Add basis-dependent `superRefine` rules and matching model-facing schema constraints: requirement bases require a requirement ID; repo/safety bases require non-empty source refs; missing-authority requires a concrete authority description and blocked decision.

### [HIGH] Correctness: Gate second-rejection arbitration on real author evidence

**File**: `packages/coding-agent/src/workflow/engine.ts:1292-1298,1401-1407`; `packages/coding-agent/src/workflow/stages/plan-review.ts:136-151`

**Problem**: Every second `changes_requested` triggers arbitration, and the engine fabricates `max_cycles_author_reject` when no other trigger exists. No planner-produced author-response artifact exists: `authorResponses` is forced from the prior review, so the reviewer is effectively reusing reviewer-owned data rather than an author’s rejected P0/P1 finding with evidence.

**Impact**: Ordinary second rejection is escalated to an arbitrator instead of failing closed with `max_plan_cycles_exceeded`; the core disagreement condition is never proven.

**Recommendation**: Produce and persist author responses during replan, validate finding ownership/disposition/evidence, derive `max_cycles_author_reject` only from rejected P0/P1 findings with non-empty evidence refs, and block the no-trigger second rejection.

### [HIGH] Identity: Require attested runtime identity before pinning a reviewer

**File**: `packages/coding-agent/src/workflow/engine.ts:146-192`

**Problem**: `resolvePlanReviewerIdentity()` falls back from attested coordinates to configured/local coordinates and finally profile configuration. A run with no runtime attestation can establish a “pin”; rereview then proves only that configuration remained the same, not that the provider/model runtime did.

**Impact**: Provider drift or gateway substitution can bypass the same-reviewer runtime identity contract.

**Recommendation**: Pin only a strict, validated runtime identity receipt; persist its attested provider/model/lineage; fail closed when attestation is absent or not exact; use those attested coordinates for rereview equality.

### [HIGH] Resume safety: Do not replay an uncertain or already-persisted arbitration

**File**: `packages/coding-agent/src/workflow/engine.ts:1250-1269,3051-3089`

**Problem**: The engine persists `substate="arbitration", arbitrationCycles=0` before the external call. Any resume in that state calls the arbitrator again. This replays both crash windows: provider call started/completed but no artifact was persisted, and arbitration review persisted at lines 3059-3061 but control state/cycle was not persisted yet.

**Impact**: A paid arbitration can run twice and return a different decision. A trusted persisted decision can be ignored and replaced.

**Recommendation**: Persist a pre-call attempt phase/id and reserve the sole arbitration cycle before launch. If launch is uncertain without a trusted artifact, fail closed to human authority. If a trusted artifact already exists, validate its hash/identity and idempotently finish the transition without another model call.

### [HIGH] Budget enforcement: Recheck limits immediately before arbitration

**File**: `packages/coding-agent/src/workflow/engine.ts:1401-1434,2819-2866`; `packages/coding-agent/src/workflow/budget-ledger.ts:73-139`

**Problem**: The stage precheck occurs before the initial review. Arbitration is then invoked directly in the same stage without another global/profile request gate or a durable max-arbitration-cycle reservation.

**Impact**: The review can consume the last allowed request/cost, followed by an arbitration request that exceeds workflow or profile limits.

**Recommendation**: Re-run global and selected-profile gates immediately before the external call, add a configured/persisted arbitration-cycle limit, reserve it atomically, and settle usage consistently on success/cancel/failure.

### [HIGH] Concurrency trust: Verify declaration fingerprint and approved scope

**File**: `packages/coding-agent/src/latency/concurrency-declaration.ts:197-215`; `packages/coding-agent/src/workflow/engine.ts:1940-1967`

**Problem**: Validation checks only that `scopeArtifactSha256` is non-empty. It neither recomputes `fingerprint` nor compares scope ref/hash/revision to the approved plan. A policy declaration can be mutated after fingerprinting or can supply an arbitrary scope hash and still execute.

**Impact**: Stale or rewritten assignments/paths can cross the fail-closed scope boundary and reach write execution.

**Recommendation**: Recompute the canonical declaration fingerprint during validation. In the engine, bind scope ref/hash/revision to the approved PlanArtifact/work-package snapshot and reject any mismatch.

### [HIGH] Concurrency safety: Honor isolation scope independently of path overlap

**File**: `packages/coding-agent/src/latency/concurrency-declaration.ts:300-324,412-426`

**Problem**: Both validator and `unitsConflict()` return early when declared paths are disjoint. Two ready write units with different paths but the same non-empty `isolationScope="workspace"` validate and auto-parallelize.

**Impact**: Units explicitly declaring the same shared workspace/resource can mutate it concurrently.

**Recommendation**: Treat identical non-empty isolation scopes as a conflict independently of path overlap; lower to serial or blocked resolution.

### [HIGH] Concurrency completeness: Never drop required read units

**File**: `packages/coding-agent/src/workflow/engine.ts:1979-2001`

**Problem**: Once a mixed declaration passes ready/conflict checks, engine lowering filters to `mode === "write"`. A required read/evidence unit is silently discarded while the remaining write packages can complete the workflow.

**Impact**: Required evidence or preconditions are skipped without state, receipt, or failure.

**Recommendation**: Lower every supported unit through RuntimePort, or reject mixed declarations as unsupported. Never filter out `required: true` units.

### [HIGH] Compatibility: Persist V1/V2 cohort before the first legacy review

**File**: `packages/coding-agent/src/workflow/engine.ts:1294-1299,3320-3418`

**Problem**: Legacy mode is inferred from the latest hydrated review artifact. A pre-upgrade workflow that persisted a V1 plan and reached `plan_review` but crashed before its first review has no review artifact, so resume silently switches to the V2 schema/prompt.

**Impact**: Persisted workflows can change protocol mid-flight and fail or produce non-comparable review artifacts.

**Recommendation**: Persist a workflow-level review schema/cohort marker before the first review and resume from that marker; migrate legacy state deterministically.

### [HIGH] Rollout safety: Keep P0/P1 escapes at zero tolerance

**File**: `packages/coding-agent/src/latency/arms.ts:122-130`; `docs/superpowers/plans/2026-08-04-latency-phase0-baseline-receipt.md:111`; `docs/superpowers/plans/2026-08-04-latency-implementation-acceptance.md:49`

**Problem**: Design §6.5 says any treatment-attributed P0/P1 escape stops rollout immediately. Code and acceptance instead encode `p0p1RisePct: 10`; the constant also has no production consumer enforcing a stop.

**Impact**: A rollout gate could tolerate severe correctness/security escapes and the acceptance record misstates the authoritative safety rule.

**Recommendation**: Represent P0/P1 as a zero-tolerance attributed-event condition, retain 10% only for rework, wire the stop condition into the rollout evaluator before experiments, and correct the baseline/acceptance wording.

### [MEDIUM] Functional gap: Concurrency is flat-wave scaffolding, not the accepted durable DAG contract

**File**: `packages/coding-agent/src/workflow/work-packages.ts:86-94`; `packages/coding-agent/src/workflow/engine.ts:1979-2001`; `docs/superpowers/plans/2026-08-04-latency-implementation-acceptance.md:65-68`

**Problem**: `buildWorkPackageExecutionPlan()` immediately returns null when any package has `dependsOn`; engine state is rebuilt as all `declared` rather than resuming durable declaration state. A DAG with two independent roots and a join falls back to one whole-plan implementation call. Join/quorum/idempotency/resume/cancel lifecycle is not wired, although acceptance labels declaration/execution implemented.

**Impact**: Valid DAG treatment silently becomes control behavior; restart attribution is impossible; the reported Phase 1 implementation status is stronger than the production path.

**Recommendation**: Either implement topological ready waves plus durable state/receipts, resume/cancel/idempotency and join/quorum semantics, or relabel acceptance/changelog as flat independent-wave scaffolding and defer the full 4.a/4.b contract.

### [MEDIUM] Acceptance evidence: Add real owner-path smoke receipts

**File**: `docs/superpowers/plans/2026-08-04-latency-implementation-acceptance.md:83-107`

**Problem**: The report records unit tests and typecheck, while design §§6.3-6.4 require isolated and combined real-path smoke scenarios: read/change/view, Bash fail→change→success, dependent concurrency with cancel/resume, and eval parity.

**Impact**: The record proves selected contracts, not end-to-end behavior or Phase 1 exit; the dependency fallback above remained invisible.

**Recommendation**: Add reproducible smoke receipts with inputs, frozen arm snapshot, actual owner path, output/artifact hashes, and outcome. Until then, label the result `unit-verified scaffolding; Phase 1 smoke acceptance pending`.

### [MEDIUM] Timeout lifecycle: Publish a terminal update for queued timeout

**File**: `packages/coding-agent/src/task/index.ts:1206-1212`

**Problem**: `failQueuedTimeout()` mutates progress and settlement state, then throws without `reportProgress()`.

**Impact**: The AsyncJob fails and delivers an error, but the original asynchronous task block can remain on its last pending/running snapshot because no terminal tool update finalizes/untracks it.

**Recommendation**: Publish `buildDetails()` through `reportProgress` before throwing; add an `onUpdate` regression that holds one permit and lets a queued job time out.

### [MEDIUM] Timeout attribution: Preserve cancellation when runtime timeout fires later

**File**: `packages/coding-agent/src/task/executor.ts:1056-1073`

**Problem**: `requestAbort("timeout")` sets `runtimeLimitExceeded=true` before checking whether another abort already won. A cancellation just before the deadline can later be relabeled as runtime timeout while session teardown is pending.

**Impact**: Final status, user message, and `runtime_timeout_triggered` metric report the wrong first cause.

**Recommendation**: Set timeout/budget flags only when that cause wins the single abort transition; preserve one immutable first-cause token; test cancel-first/runtime-later with delayed session abort.

### [MEDIUM] Observability: Record runtime timeout metrics for synchronous fanout

**File**: `packages/coding-agent/src/task/index.ts:1304-1315,1379-1437`

**Problem**: `runtime_timeout_triggered` is recorded only inside the AsyncJob registration path. Blocking agents, disabled async mode, or absent AsyncJobManager use the same executor timeout but bypass the metric branch.

**Impact**: Sync timeouts are missing from timeout/salvage denominators and async-vs-sync metrics are not comparable.

**Recommendation**: Move runtime-timeout accounting to the common settled-result path with one per-invocation key; add sync/async parity coverage.

### [MEDIUM] Routing trust: Strictly parse mechanical evidence before Flash routing

**File**: `packages/coding-agent/src/latency/mechanical-class.ts:55-69`; `packages/coding-agent/src/workflow/engine.ts:1761-1772`

**Problem**: The engine casts arbitrary policy objects to `WorkflowMechanicalClassV1`; eligibility checks neither schemaVersion/enums nor the required ref/provenance for deterministic or accepted-finding evidence. A malformed `{class:"mechanical_repair", evidence:{source:"accepted_finding"}, ...}` is Flash-eligible without a finding ref.

**Impact**: Unproven reasoning repairs can be downgraded to a weaker mechanical route when the arm is enabled.

**Recommendation**: Add a strict runtime parser; require and verify deterministic-rule/accepted-finding refs against persisted accepted provenance; route incomplete evidence to the existing strong model.

### [MEDIUM] Bash correctness: Invalidate repetition evidence when authoritative state changes

**File**: `packages/coding-agent/src/tools/bash.ts:611-656`; `packages/coding-agent/src/latency/bash-attempt-ledger.ts:107-131`

**Problem**: Production Bash calls build state identity from cwd and env names only. Code revision, config hash, related-file hashes, and dependency receipt are always the same `unknown` placeholders, and `changedInputReceipt` is always null.

**Impact**: After source/config changes, the same command and error excerpt can be mislabeled as an identical stale retry rather than a new verification attempt.

**Recommendation**: Supply verified working-tree/config/dependency receipts. If authoritative state identity is unavailable, fail open and do not emit repeated-failure advice.

### [MEDIUM] Bash accounting: Record managed terminal outcomes exactly once and surface notices

**File**: `packages/coding-agent/src/tools/bash.ts:907-959`

**Problem**: Managed async/auto-background non-zero or timeout results are recorded once, then `finalResult.isError` throws and the catch records a second generic terminal attempt. Notices returned by the first record call are ignored.

**Impact**: One execution inflates attempt/A-B accounting, and repeated-failure advisory/bounded notices are absent from background results.

**Recommendation**: Use one terminal finalizer with an `outcomeRecorded` guard; append returned notices to the final result; catch should synthesize an error record only when no terminal result was recorded.

### [MEDIUM] Bash completeness: Record thrown ACP/foreground terminal errors

**File**: `packages/coding-agent/src/tools/bash.ts:1264-1300,1550-1586`

**Problem**: ACP `createTerminal()`/`waitForExit()` rejection and foreground executor rejection leave before post-await ledger recording.

**Impact**: Repeated backend/tool failures never enter the canonical ledger, while other paths may double-enter it.

**Recommendation**: Consolidate success/exit/timeout/cancel/error capture in route-level try/catch/finally and guarantee exactly one terminal record.

### [MEDIUM] Resource lifetime: Clear the departed session’s Bash ledger

**File**: `packages/coding-agent/src/session/agent-session.ts:4651-4659,6339-6378,7509-7514`

**Problem**: The module-level ledger store is keyed by session ID, but session cleanup reads the current ID after `newSession()`/session switch. It clears the new/target store, leaving the departed store retained; a late background completion can also resolve the wrong current owner.

**Impact**: Long-lived processes leak per-session ledgers and can attribute late attempts to the wrong session.

**Recommendation**: Capture and clear the departed session ID before transition; bind background jobs to their launch-time ledger owner.


## 4. Verification evidence

| Check | Result |
|---|---|
| `bun test test/latency test/task/task-spawn.test.ts test/workflow/stages/plan-review.test.ts test/workflow/work-packages.test.ts` from `packages/coding-agent` | **63 pass / 0 fail** |
| Direct runtime reproduction: same `isolationScope` + disjoint paths | validator `ok=true`; `shouldAutoParallel=true` |
| Direct runtime reproduction: mutate declaration after fingerprinting | stale fingerprint unchanged; validator `ok=true` |
| Direct runtime reproduction: malformed accepted-finding mechanical class without schema/ref | `isMechanicalFlashEligible(..., true) === true` |

The green focused suite does not cover the reproduced trust-boundary failures; it is not evidence that these paths are correct.

## 5. Delegated review

- Latency/runtime reviewer: inspected read dedupe, Bash ledger, concurrency, mechanical routing, and eval migration; acceptance required exact production paths and actionable path:line findings. Result: concurrency trust/safety, Bash accounting/state, mechanical validation, and session-lifetime findings; read identity/artifact verification and eval fail-open path confirmed sound.
- Timeout reviewer: inspected queue/runtime first-cause, permit/timer cleanup, sync/async parity, and tests. Result: three MEDIUM findings; current first-cause queued timeout and permit cleanup otherwise sound.
- PlanReview V2 reviewer: inspected schema, stage/engine state machine, identity, arbitration, resume, budget, and legacy behavior. Result: seven HIGH findings; runtime read-only arbitrator mapping and usage persistence confirmed sound.
- Design-claims reviewer: compared implementation/acceptance language with the four design inputs; explicit deferrals are separated above rather than mislabeled as implemented behavior.

## 6. Final conclusion

**NEEDS_FIX**

The implementation has substantial working structure, but multiple fail-closed claims do not hold. Highest priority: authoritative requirements snapshot and complete coverage gate; basis/evidence validation; author-evidence arbitration gate; non-replayable budgeted arbitration; and concurrency declaration scope/fingerprint enforcement. The focused tests pass because these adversarial boundaries are not covered.

## 7. Next step

**Same session**:

直接执行 $fix-implement 或 /fix-implement

**New-session recovery prompt**:

```
请阅读实现文档 docs/superpowers/plans/2026-08-04-latency-implementation-acceptance.md、
设计输入 docs/superpowers/specs/2026-08-03-latency-optimization-plan-design.md、
docs/superpowers/specs/2026-08-04-plan-review-pipeline-design.md、
docs/superpowers/specs/2026-08-04-proactive-subagent-delegation-design.md 与 docs/design/subagent-lifecycle-observability-v2.md、
审查文档 docs/superpowers/plans/2026-08-04-latency-plan-review-implementation-code-review.md，
以及本次代码变更，
使用 $fix-implement（或 /fix-implement）进行方案修复及代码实现。
重点修复 HIGH-1：使用 engine-owned 权威需求快照执行完整 mandatory coverage gate。
```

## 8. 修复记录

### Round 1 — HIGH-1 authoritative requirements snapshot + mandatory coverage gate (2026-08-04)

**Status**: HIGH-1 closed. Remaining HIGH/MEDIUM findings from §3 are **not** addressed in this round.

#### What changed

1. **Engine-owned `RequirementsSnapshotV1`**
   - New module: `packages/coding-agent/src/workflow/requirements-snapshot.ts`
   - Built from frozen `WorkflowRequest` (`request` + newline/bullet-split `constraints`) **before** planning / plan_review
   - Stable IDs: `user:req-001`, `user:constraint-NNN` (slot-stable, not content-hashed)
   - Canonical `sha256` via `stableSerialize` fingerprint (excludes `createdAt`)
   - Persisted as artifact kind `requirements_snapshot`; resume hydrates first/oldest and never regenerates on replan

2. **Reviewer context includes authoritative set**
   - `ContextBuilder.buildPlanReviewContext(plan, inclusion, requirementsSnapshot?)`
   - Template `context-plan-review.hbs.md` now injects snapshot JSON + mandatory-coverage instruction before the plan body

3. **Full mandatory coverage gate on `approved`**
   - After arbitration-trigger handling, V2 `decision=approved` runs `validateApprovedMandatoryCoverage`
   - Requires: snapshot hash match **and** every mandatory snapshot ID present with `satisfied|not_applicable`, non-empty evidence, and no `violated`/`missing_authority` row for that ID
   - Incomplete / hash-mismatch → `awaiting_human` / blocked (`incomplete_mandatory_coverage` / `requirements_snapshot_hash_mismatch`)
   - Same gate applied to successful arbitration `approved`

4. **Test support**
   - `planReviewArtifactV2("approved")` defaults to satisfied coverage for a shared default request so happy-path fixtures stay green
   - New tests: `test/workflow/requirements-snapshot.test.ts` (unit + engine block/pass/context injection)

#### Verification

```text
cd packages/coding-agent
bun test test/workflow/requirements-snapshot.test.ts \
  test/latency \
  test/workflow/stages/plan-review.test.ts \
  test/workflow/engine-plan-rejection.test.ts \
  test/workflow/engine-happy-path.test.ts \
  test/workflow/engine-budget-stop.test.ts \
  test/workflow/engine-resume.test.ts \
  test/workflow/engine-work-packages.test.ts \
  test/workflow/major-fixes.test.ts \
  test/workflow/security-policy.test.ts
→ 116 pass / 0 fail

bun run check:types
→ clean
```

#### Remaining risk / next review scope

- **Still open (HIGH)**: basis/evidence superRefine; author-evidence arbitration gate; attested reviewer pin; non-replayable arbitration; arbitration budget recheck; concurrency fingerprint/scope/isolation/read-units; V1/V2 cohort marker; P0/P1 zero-tolerance stop.
- **Still open (MEDIUM)**: concurrency DAG scaffolding honesty; smoke receipts; timeout terminal/first-cause/sync metrics; mechanical class parser; bash state identity/accounting/session lifetime.
- **Not claimed closed**: pilot A/B receipts; QualityRouteSnapshotV2; human authority UI; full SQLite control-state migration.

#### Code status

**Not merge-ready for the full review scope.** HIGH-1 is fixed and regression-covered; remaining HIGH items still block a clean merge of the plan-review/latency trust boundary work.

#### Handoff

**Same session**:

```
直接执行 $fix-implement 或 /fix-implement
继续修复审查文档剩余 HIGH 项；优先 HIGH-2 basis/evidence 交叉校验。
```

**New-session recovery prompt**:

```
请阅读实现文档 docs/superpowers/plans/2026-08-04-latency-implementation-acceptance.md、
审查文档 docs/superpowers/plans/2026-08-04-latency-plan-review-implementation-code-review.md 的修复记录，
对本轮修复结果补做下一轮检查；重点关注文档中记录的剩余风险与复审范围。

若继续修复：使用 $fix-implement（或 /fix-implement），
优先 HIGH-2：Enforce basis-specific finding evidence（schemas superRefine）。
```

### Round 2 — HIGH-2 basis-specific finding evidence superRefine (2026-08-04)

**Status**: HIGH-2 closed. Remaining HIGH/MEDIUM findings from §3 are **not** addressed in this round.

#### What changed

1. **Zod fail-closed basis evidence (`PlanReviewFindingV2Schema`)**
   - `packages/coding-agent/src/workflow/schemas.ts`
   - Per-finding `superRefine`:
     - `spec_requirement|user_requirement` → non-empty `requirementId` + non-empty `sourceRefs`; `missingAuthority` must be null
     - `repo_evidence|safety_invariant` → non-empty `sourceRefs`; `missingAuthority` must be null
     - `missing_authority` → concrete non-empty `missingAuthority` description
   - Existing artifact-level rule retained: any `missing_authority` finding forces `decision=blocked`

2. **Model-facing JSON Schema lockstep**
   - `packages/coding-agent/src/workflow/json-schemas.ts` `planReviewFindingV2Item` gains `allOf` if/then constraints matching the Zod basis rules (guidance for structured output; Zod remains the fail-closed gate)

3. **Prompt wording**
   - `packages/coding-agent/src/prompts/workflow/plan-reviewer.md` states basis-specific required fields and blocked decision for `missing_authority`

4. **Regression tests**
   - `packages/coding-agent/test/workflow/schemas.test.ts` covers empty `sourceRefs`, null `requirementId`, null `missingAuthority`, non-blocked `missing_authority`, and well-formed multi-basis accept

#### Verification

```text
cd packages/coding-agent
bun test test/workflow/schemas.test.ts \
  test/workflow/stages/plan-review.test.ts \
  test/latency/plan-review-identity.test.ts \
  test/workflow/requirements-snapshot.test.ts \
  test/workflow/engine-happy-path.test.ts \
  test/workflow/engine-plan-rejection.test.ts
→ 40 pass / 0 fail

bun run check:types
→ clean
```

#### Remaining risk / next review scope

- **Still open (HIGH)**: author-evidence arbitration gate; attested reviewer pin; non-replayable arbitration; arbitration budget recheck; concurrency fingerprint/scope/isolation/read-units; V1/V2 cohort marker; P0/P1 zero-tolerance stop.
- **Still open (MEDIUM)**: concurrency DAG scaffolding honesty; smoke receipts; timeout terminal/first-cause/sync metrics; mechanical class parser; bash state identity/accounting/session lifetime.
- **Not claimed closed**: pilot A/B receipts; QualityRouteSnapshotV2; human authority UI; full SQLite control-state migration.

#### Code status

**Not merge-ready for the full review scope.** HIGH-1 and HIGH-2 are fixed and regression-covered; remaining HIGH items still block a clean merge of the plan-review/latency trust boundary work.

#### Handoff

**Same session**:

```
直接执行 $fix-implement 或 /fix-implement
继续修复审查文档剩余 HIGH 项；优先 HIGH-3：Gate second-rejection arbitration on real author evidence。
```

**New-session recovery prompt**:

```
请阅读实现文档 docs/superpowers/plans/2026-08-04-latency-implementation-acceptance.md、
审查文档 docs/superpowers/plans/2026-08-04-latency-plan-review-implementation-code-review.md 的修复记录，
对本轮修复结果补做下一轮检查；重点关注文档中记录的剩余风险与复审范围。

若继续修复：使用 $fix-implement（或 /fix-implement），
优先 HIGH-3：Gate second-rejection arbitration on real author evidence。
```

### Round 3 — HIGH-3 gate second-rejection arbitration on real author evidence (2026-08-05)

**Status**: HIGH-3 closed. Remaining HIGH/MEDIUM findings from §3 are **not** addressed in this round.

#### What changed

1. **Planner-produced author responses**
   - `PlanArtifactV1.authorResponses?` added (types + Zod + model-facing JSON schema)
   - Replan must answer every open P0/P1 prior finding; `rejected` requires non-empty `evidenceRefs`
   - Planner prompt documents the replan contract

2. **Engine-owned author-response artifact + validation**
   - New module: `packages/coding-agent/src/workflow/author-responses.ts`
   - `validateAuthorResponses` / `hasMaxCyclesAuthorReject` / durable `author_responses` artifact
   - On replan (`awaiting_replan`), engine validates planner responses against the prior review findings, persists `author_responses`, and stamps control `authorResponsesArtifactRef`
   - Resume hydrates the latest `author_responses` artifact (responses + prior finding priorities)

3. **Second-rejection arbitration gate**
   - Review artifacts no longer carry fabricated/model `authorResponses`; engine stamps engine-owned responses
   - `max_cycles_author_reject` is derived only when:
     - second `changes_requested` reaches `maxPlanCycles`, **and**
     - stored author responses reject a prior P0/P1 finding with non-empty evidence
   - Ordinary second rejection without author reject evidence → `blocked` / `awaiting_human` with reason `max_plan_cycles_exceeded` (no arbitrator call)
   - Contradiction / suspicious_pass triggers remain independent of author reject evidence

4. **Regression tests**
   - `test/workflow/author-responses.test.ts` unit coverage for validation + reject evidence
   - `test/latency/plan-review-identity.test.ts`:
     - second reject without author reject evidence blocks
     - F6 arbitration only when author rejects P0/P1 with evidence
     - replan fixtures emit authorResponses
   - `engine-policy-bounds` maxPlanCycles fixtures updated for accepted authorResponses

#### Verification

```text
cd packages/coding-agent
bun test test/workflow/author-responses.test.ts \
  test/latency \
  test/workflow/stages/plan-review.test.ts \
  test/workflow/engine-happy-path.test.ts \
  test/workflow/engine-plan-rejection.test.ts \
  test/workflow/engine-policy-bounds.test.ts \
  test/workflow/engine-resume.test.ts \
  test/workflow/schemas.test.ts \
  test/workflow/requirements-snapshot.test.ts
→ 92 pass / 0 fail

bun run check:types
→ clean
```

#### Remaining risk / next review scope

- **Still open (HIGH)**: attested reviewer pin; non-replayable arbitration; arbitration budget recheck; concurrency fingerprint/scope/isolation/read-units; V1/V2 cohort marker; P0/P1 zero-tolerance stop.
- **Still open (MEDIUM)**: concurrency DAG scaffolding honesty; smoke receipts; timeout terminal/first-cause/sync metrics; mechanical class parser; bash state identity/accounting/session lifetime.
- **Not claimed closed**: pilot A/B receipts; QualityRouteSnapshotV2; human authority UI; full SQLite control-state migration.
- **Residual for HIGH-3**: planner can still omit authorResponses and fail closed on replan (`author_responses_required_on_replan`); production prompts/models must be exercised before claiming end-to-end replan quality.

#### Code status

**Not merge-ready for the full review scope.** HIGH-1/2/3 are fixed and regression-covered; remaining HIGH items still block a clean merge of the plan-review/latency trust boundary work.

#### Handoff

**Same session**:

```
直接执行 $fix-implement 或 /fix-implement
继续修复审查文档剩余 HIGH 项；优先 HIGH-4：Require attested runtime identity before pinning a reviewer。
```

**New-session recovery prompt**:

```
请阅读实现文档 docs/superpowers/plans/2026-08-04-latency-implementation-acceptance.md、
审查文档 docs/superpowers/plans/2026-08-04-latency-plan-review-implementation-code-review.md 的修复记录，
对本轮修复结果补做下一轮检查；重点关注文档中记录的剩余风险与复审范围。

若继续修复：使用 $fix-implement（或 /fix-implement），
优先 HIGH-4：Require attested runtime identity before pinning a reviewer。
```
