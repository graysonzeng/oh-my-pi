# Session history optimization supplement (S0–S4)

**Baseline tip:** delivery-first Packages 1–5 + review fix #14 (`cursor/delivery-first-review-fixes-0bff`, stacked on `cursor/p2-calibration-gates-a0e4`).  
**Authoritative research:** `docs/research/2026-09-26-session-history-optimization-supplement.md`  
**Desensitized stats:** `docs/research/2026-09-26-session-history-optimization-evidence.json`

This stack is an **independent add-on**. It does **not** rewrite or weaken
delivery-first Packages 1–5, and it does **not** merge to `workflow`.

## Package map

| # | Priority | Deliverable | Primary surfaces |
|---|---|---|---|
| S0 | P0 | Credential/route unavailable early-fail + bounded recovery | `credential-route-unavailable.ts`, availability preflight, turn-recovery |
| S1 | P0 | Acceptance metric readiness + observe handoff (no schema expand) | delivery-cost / parent_final / evidence-handoff observe |
| S2 | P1 | Opt-in main-session context / phase-handoff experiment | `phase-handoff-experiment.ts`, `docs/phase-handoff-experiment.md` |
| S3 | P1 | Pagination / continue-read contract fidelity | `composeReadPaginationArgs`, read tool selectors |
| S4 | P1 | thinking-loop / stream-interrupt replayable fixtures | turn-recovery fixtures |

## S0 contract

- Classify failures: `config_unavailable` vs `short_cooldown` vs `transport_blip` vs `unknown`.
- Only config failures enter the process-local unavailable registry.
- Cross-sibling sharing uses the existing preflight probe dedupe key + shared registry — no new scheduler.
- `provider_health_breaker` stays workflow/profile-scoped and default-off; S0 does **not** global-enable it or add `authentication` to its trip kinds.
- Preserve user-visible failure reasons; no credential leaks; healthy routes remain usable after success clears the mark.

## S1 contract

- **Cost per accepted task remains future** until explicit `parent_final_verification` receipts exist in the corpus. History alone (0/351 parent finals) cannot compute first-pass rate or cost-per-accepted-task.
- When a receipt exists (workflow `final_verify` or `AgentSession.recordParentFinalVerification`), Package 1 producers already emit what `stats:subagents` / `deliveryCost` need — including `verifiedAtMs` from `buildParentFinalVerificationDetails`.
- Evidence-handoff observe path (`evidence-handoff-observe.ts`): generate → consume/inspect → reject-stale → reuse decision, via metrics/logging/tests only. **No schema expansion** this round.
- Normal session stop / tool success never invent acceptance.

## S2 contract

- Opt-in only (`deliveryExperiment.phaseHandoff.enabled`, default `false`).
- Single factor `phase_boundary_carry_slim`: drop bulky carry at phase boundaries;
  retain open constraints, modification state, and acceptance basis.
- No model/concurrency change in the same experiment; no global 200k forced cap;
  `claimedLiveWin` always false on harness receipts.

## S3 contract

- Prefer next-page locators (`artifact://…:raw:301-`) and compose optional
  `offset`/`limit` onto path when no range selector is present.
- Stale kwargs with an existing range selector get **explicit** feedback — not a
  silent page-1 re-read.
- No global “don’t re-read” prompt rules (strict identical-text re-read was only
  0.94% of successful reads).

## Out of scope

Raising global concurrency, globally lowering effort, expanding handoff schema,
uniform output shortening, new coordinator agents, paid live A/B, claiming live
latency/cost savings from history alone.
