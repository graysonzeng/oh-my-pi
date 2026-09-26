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
| S2 | P1 | Opt-in main-session context / phase-handoff experiment | context-strategy experiment patterns |
| S3 | P1 | Pagination / continue-read contract fidelity | `read` tool selectors / artifact locators |
| S4 | P1 | thinking-loop / stream-interrupt replayable fixtures | turn-recovery fixtures |

## S0 contract

- Classify failures: `config_unavailable` vs `short_cooldown` vs `transport_blip` vs `unknown`.
- Only config failures enter the process-local unavailable registry.
- Cross-sibling sharing uses the existing preflight probe dedupe key + shared registry — no new scheduler.
- `provider_health_breaker` stays workflow/profile-scoped and default-off; S0 does **not** global-enable it or add `authentication` to its trip kinds.
- Preserve user-visible failure reasons; no credential leaks; healthy routes remain usable after success clears the mark.

## Out of scope

Raising global concurrency, globally lowering effort, expanding handoff schema,
uniform output shortening, new coordinator agents, paid live A/B, claiming live
latency/cost savings from history alone.
