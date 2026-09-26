# Delivery-first optimization round (adopted 2026-09-26)

**Baseline commit (fixed):** `9c0f8c743f` on `workflow`  
**North star:** Raise the rate of “one delivery that accepts”; cut follow-up
investigation, fix round-trips, and repeated verification. Do **not**
prioritize raising concurrency or globally lowering model tier this round.

## Package map (implementation order)

| # | Priority | Deliverable | Primary surfaces |
|---|---|---|---|
| 1 | P0 | Cost baseline for correctly finishing a task | `delivery-cost-baseline.ts`, `stats:subagents` |
| 2 | P0 | Child delivery as directly usable evidence | `child-delivery-evidence.ts`, EvidenceHandoff |
| 3 | P1 | Layered verification | `layered-verification.ts`, verification-validity |
| 4 | P1 | Read dedupe **and** stable-prefix cache (separate) | `read-dedupe-experiment.ts`, `stable-prefix-cache-experiment.ts`, `docs/delivery-read-cache-experiments.md` |
| 5 | P2 | Model/effort calibration — **docs + gates only** | `docs/p2-optimization-blocked-until.md` |

Package 5 does **not** flip production model/effort/concurrency defaults.
Paid live-net experiments need separate authorization.

## Hard constraints

- Prefer task-correctness / e2e evidence over micro-opts; one factor per experiment
- Do not claim live latency wins without paired runs
- Do not zero-fill unknown; do not sum parallel durations as serial e2e
- No Track E prompts without thrash human attribution; Track C stays closed
- No production default flips for P2 runtime levers until live evidence
- Safety ≠ proven latency
- Extend existing surfaces — do not build a second platform

## Related

- `docs/research/2026-09-09-subagent-harness-next-optimizations.md`
- `docs/p2-optimization-blocked-until.md`
- `docs/delivery-read-cache-experiments.md`
- `docs/context-strategy-experiment.md`
