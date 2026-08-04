# Latency Optimization Implementation Acceptance Report

- Date: 2026-08-04
- Repo revision (Phase 0 freeze): `93927e87ab6965a0d1ff60528a311c697f70adce`
- Design authority: `docs/superpowers/specs/2026-08-03-latency-optimization-plan-design.md` (A)
- Phase 0 receipt: `docs/superpowers/plans/2026-08-04-latency-phase0-baseline-receipt.md`

## 1. Phase 0 baseline

### Effective latency-control keys (current host)

| Setting | Effective | Class |
|---|---|---|
| `task.agentModelOverrides` | scout/designer/task/reviewer explicit | explicit |
| `task.eager` | `preferred` | explicit |
| `task.batch` | `true` | explicit |
| `async.enabled` | `true` | explicit |
| `compaction.thresholdPercent` | `70` | explicit |
| `compaction.idleEnabled` | `true` | explicit |
| `compaction.idleThresholdTokens` | `200000` | default-derived |
| `defaultThinkingLevel` | `high` | default-derived |
| `modelOptimization.enabled` | `false` | default-derived |

Current config SHA-256: `996a4953b3e7c60bbb2855056030244f57d4632b48fe1a194ed391c47df14fd5`  
(Design-dated hash `1eb09e44…` drifted only on non-§1.4 keys such as `modelRoles.default`; §1.4 latency keys still match.)

### Residual pool (treatment still OFF / missing before this change)

Historical active 306.6h = gen 174.3 + TTFT 92.0 + tools 40.3 (not residual savings).  
Residual arms implemented this round (all default-off): context optimization activation path, read dedupe, bash ledger, concurrency declaration/execution, mechanical Flash route, eval parity gate.

## 2. Arms, switches, rollback

| Arm | Switch (default false) | Owner | Rollback |
|---|---|---|---|
| `context_optimization` (1.a) | `modelOptimization.enabled` | modelOptimization + agent-session + tool-output-manager | set false |
| `read_dedupe` (1.c) | `latency.arms.readDedupe` (+ requires modelOptimization) | context-ledger + agent-session | set false |
| `context_budget_tuning` (1.b) | `latency.arms.contextBudgetTuning` | profile thresholds | set false |
| `role_static_split` (2) | `latency.arms.roleStaticSplit` | model-router + QualityRouteSnapshot | set false / restore control snapshot |
| `bash_advisory` (3) | `latency.arms.bashAdvisory` | tools/bash + BashAttemptLedgerV1 | set false |
| `bash_bounded_injection` (3) | `latency.arms.bashBoundedInjection` | same ledger | set false (keep ledger) |
| `concurrency_declaration` (4.a) | `latency.arms.concurrencyDeclaration` | WorkflowConcurrencyDeclarationV1 | set false |
| `concurrency_execution` (4.b) | `latency.arms.concurrencyExecution` | task/parallel + work-packages / RuntimePort | set false |
| `eval_gate_migration` (5) | `latency.arms.evalGateMigration` | eval bridges + EvalGateParityReceiptV1 | set false → bridge control |

Session-frozen snapshot helper: `freezeLatencyArmSnapshot` / `resolveLatencyArmsFromSettings` in `packages/coding-agent/src/latency/arms.ts`.  
Combined experiments require explicit `combinedArmId` + ≥2 `childArms`.

Quality stop (any arm): completion/verifier/review −>2pp, rework/dup-read +>10%, any treatment-attributed P0/P1 escape (zero tolerance) → rollback that arm only.

## 3. What landed (canonical owners only)

### Direction 1 — Context volume
- 1.a ordinary truncation: existing seam (`modelOptimization.enabled` → profiles → `#optimizeOrdinaryToolResult` → `processToolOutputDetailedAsync`).
- 1.c ReadViewKeyV1 + tool_result eligible dedupe in `workflow/context-ledger.ts`; ordinary session map in `agent-session.ts`; fail-open on incomplete identity / hash / artifact verify. No `fresh` param.

### Direction 3 — Bash ledger
- Single `BashAttemptLedgerV1` + session WeakMap store.
- Wired in `tools/bash.ts` for advisory / bounded injection; cancel not failure; env **names** only in state fingerprint.

### Direction 5 — Eval migration gate
- `EvalGateParityReceiptV1` + `recordOrRequireEvalParity` / `mayMigrateEvalGate`.
- Migration stays bridge-control unless arm on **and** parity=`proven`. Re-exported from `tools/eval.ts`.

### Direction 4 — Concurrency + plan review
- `WorkflowConcurrencyDeclarationV1` validation (cycle, path overlap, unknown fields).
- `buildConcurrencyExecutionPlan` lowers ready wave via `mapWithConcurrencyLimitAllSettled` + `Semaphore`; auto-parallel only when `shouldAutoParallel` (≥2 independent ready, no write/isolation conflict).
- Engine arm-gated declaration validation + work-package conversion.
- Plan review: pin initial reviewer profile/identity for rereview; max cycles → `#runPlanArbitration` (prefer non-author/non-reviewer lineage) or `blocked:arbitration_required`. No N-reviewer voting. Prompts unchanged: `plan-reviewer.md` / `agents/reviewer.md`.

### Direction 2 — Mechanical Flash
- `WorkflowMechanicalClassV1` + `roleStaticSplitEnabled` only influence **repair** Flash preference in `model-router.ts`.
- Never applied to `plan_reviewer`.

### Forbidden names
No `task-batch.ts`, `tool-output-processor.ts`, `performance.contextVolume.truncation.*`, or `fresh` parameter.

## 4. Verification evidence

Commands (packages/coding-agent):

```text
bun test test/latency
→ 25 pass / 0 fail

bun run check:types
→ clean (noEmit)

broader focused regression:
bun test test/latency test/workflow/context-ledger.test.ts \
  test/workflow/model-router.test.ts test/workflow/work-packages.test.ts \
  test/workflow/engine-plan-rejection.test.ts \
  test/model-optimization/after-tool-call-optimization.test.ts \
  test/task/parallel.test.ts test/workflow/stages/plan-review.test.ts
→ 59 pass / 0 fail
```

Contract coverage includes:
- all arms default-off + freeze snapshot / combinedArmId rules
- ReadViewKey eligibility + branch/selector/provider invalidation
- bash repeated failure advisory; cancel ignored
- concurrency cycle/path/unknown-field reject; auto-parallel ≥2 only; effective concurrency min
- mechanical Flash on repair only; plan_reviewer unchanged
- eval parity gate blocks until proven
- plan_review single-reviewer replan + arbitration_required block path

## 5. Open / follow-ups (not blocking this implementation gate)

### Closed after acceptance (2026-08-04 follow-up commits)

- PlanReview V2 stage wiring + engine-owned fields / C1–C3 regressions (`c67d8cd64`, `a5daa5d8b`).
- Read identity production for local + URL paths (F4/F7) and bash create/poll timeout ledger (MEDIUM bash).
- Queued-timeout first-cause + F8 once-key cleanup (`37e9b44d8`, `c67d8cd64`).
- Session-fallback fixture identity for plan-review pin (`a5daa5d8b`).

### Still open / deferred

1. **Pilot A/B receipts** (≥30 pairs / arm) not run — design requires clean-context paired experiments with double ledger before claiming latency savings.
2. **1.b context budget tuning** flag exists; profile threshold experiments deferred until 1.a has receipts.
3. **Eval native migration path** is gated only; full bridge→workflow owner cutover still needs proven fixtures per decision enum + cancel/resume parity.
4. **Plan arbitrator profiles** in default quality routes may need explicit `grok_plan_arbitrator` registration in production config for non-block arbitration (code supports resolve + degraded policy).
5. **Session-frozen arm snapshot** helper exists; optional persistence into session custom entries / workflow artifacts can be wired at session start without changing defaults.
6. Host `modelRoles.default` drift (grok vs historical flash) is outside arm treatment; freeze actual model identity in A/B lineage.
7. **Explicit deferred epics** (do not claim closed): QualityRouteSnapshotV2 full, standalone `plan-arbitration.ts`, human receipt UI, five plan-review A/B arms rollout, D §10 full SQLite control-state migration.
8. **Post-acquire timeout interleaving** beyond current first-cause tests remains partial (MEDIUM-3 residual); sync fanout has no `queuedStartupTimeoutMs` (documented non-goal).

## 6. Rollback checklist (operator)

```yaml
# emergency: all latency treatments off
modelOptimization.enabled: false
latency.arms.readDedupe: false
latency.arms.contextBudgetTuning: false
latency.arms.roleStaticSplit: false
latency.arms.bashAdvisory: false
latency.arms.bashBoundedInjection: false
latency.arms.concurrencyDeclaration: false
latency.arms.concurrencyExecution: false
latency.arms.evalGateMigration: false
```

Do not flip control baseline (`task.eager`/`batch`/`async`/`compaction`) when rolling back a single arm.
