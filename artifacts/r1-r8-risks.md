# R1–R8 Risks & Rollback

## Residual risks

1. **Content identity cost** — heavier than `HEAD:dirty` at capture boundaries.
2. **Legacy `HEAD:dirty` packets** — become stale vs content versions (safe fail-closed).
3. **Budget snapshot consumers** — must read `knownCostLowerBoundUsd` when total is unknown.
4. **Incremental routing-audit** — consumers must merge deltas; hydrate no longer loads audit bodies.
5. **No KDL truncation migration** — family `modelPattern` tables remain in TS; shared constructors remove copy-paste only.
6. **D4/E3 microbenches** — assembly/artifact boundary only; not production $ proof.
7. **host_verification seam** — requires executor-extracted tool data; absent → unverified auto packets (intentional).
8. **deliveryQualityOutcomes** — unknown unless labeled custom entries exist; never inferred from final_verify.

## Rollback

- Reverse `artifacts/r1-r8-full.patch` (do not `git reset` user work).
- Experiments already off; no new default-on experiment.

## Safety invariants retained

- Host owns transitions; empty checks cannot complete
- prepared→applied no re-merge (C5)
- Worker cannot mint parent-final acceptance
- Tool-free finals do not inject yield reminders (C6)
- Ordinary sessions not auto-wrapped as workflow
