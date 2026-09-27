# Thin harness candidates (D5) — evidence-backed only

This round does **not** delete modules. Candidates below require caller migration + behavioral proof before removal.

| Candidate | Why it might be removable | Hard guarantee that must remain in code | Status |
|---|---|---|---|
| Duplicate global flow reminders already enforced by host-gate / workflow | Reduces prompt noise | Cancel, deadline, budget, permission, trusted seal | Documented only — no deletion |
| Pure forwarder layers with no semantic encapsulation | Fewer hops for callers | Error paths / isolation | Deferred pending call-graph evidence |
| Repeated verification orchestration in multiple entrypoints | Single owner | Layered verification validity | Batch1 F1–F3 already thinned workflow identity/preflight/acceptance |

Completed this round:

- Rule discovery warnings now logged once (`formatRuleDiscoveryWarnings`) — was documented gap in `rulebook-matching-pipeline.md`.
- `diagnoseRuleSources` explains winner / shadowed / disabled without changing priority.

Not done (needs more evidence): deleting any specific prompt section or skill-izing safety MUST lines.
