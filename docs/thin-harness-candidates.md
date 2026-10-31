# Thin harness candidates (D5) — evidence-backed only

This round does **not** delete modules unless a duplicate forwarder has proven zero callers.
Candidates below require caller migration + behavioral proof before removal.

## Batch 1 (this increment) — document with call-site evidence

| Candidate | Call-site evidence | Migration checklist | Behavior evidence required | Status |
|---|---|---|---|---|
| Duplicate global flow reminders already enforced by host-gate / workflow | Host gate: `goals/host-gate.ts` `evaluateGoalHostGate`; workflow budget: `workflow/budget-ledger.ts`; cancel paths in `goals/runtime.ts` + agent abort | 1) Inventory prompt sections that restate cancel/deadline/budget/permission/trusted seal 2) Confirm each remaining entrypoint still hits the code guard 3) Keep MUST lines that have no code twin | Cancel, deadline, budget, permission, trusted seal still fail-closed after any prompt trim | **Documented only** — no deletion |
| Pure forwarder layers with no semantic encapsulation | Needs full `rg` of export → import graph per candidate; prior Batch1 F1–F3 already thinned workflow identity/preflight/acceptance (`thin-orch-f{1,2,3,6}-*` tests) | 1) List every import of the forwarder 2) Retarget callers to the leaf owner 3) Delete only when import count is 0 in package + tests | Error paths / isolation unchanged; no new silent drop | **Deferred** — no zero-caller forwarder proven this round |
| Repeated verification orchestration in multiple entrypoints | Batch1 F1–F3 already consolidated identity/preflight/acceptance; tests under `test/workflow/thin-orch-*` | Do not re-open without a new duplicate entrypoint finding | Layered verification validity (`verification-validity.ts`) | **Already thinned (Batch1)** — no further delete this round |
| `diagnoseRuleSources` as a second diagnostics owner | Wired into existing `/context` diagnosis exit via `appendContextDiagnosisSections` (not a new command) | Keep single format helper; do not add a parallel `/rules diagnose` | Winner/shadowed/disabled rows + `disabledRules` filter; no priority change | **Wired (this increment)** — keep |

Completed this round:

- Rule discovery warnings logged once (`formatRuleDiscoveryWarnings` in `sdk.ts`) — was documented gap in `rulebook-matching-pipeline.md`.
- `diagnoseRuleSources` explains winner / shadowed / disabled without changing priority; **now consumed** by `/context` with live `loadCapability("rules")` items/all + `ttsr.disabledRules`.
- Thinning: **no module deletion** — zero-caller forwarder not proven; Batch1 workflow thinning retained.

### Migration checklist (any future delete)

1. Name the concrete module / prompt section.
2. `rg` all callers (packages + tests); record count in this table.
3. Confirm hard guarantees remain in code (cancel, deadline, budget, permission, trusted seal).
4. Migrate callers → leaf owner in one PR.
5. Run focused behavioral tests for the affected contract; no source-grep tests.
6. Only then delete.

Not done (needs more evidence): deleting any specific prompt section or skill-izing safety MUST lines.
