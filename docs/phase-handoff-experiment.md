# Phase-handoff / carried-context experiment (history S2)

Single-factor **opt-in** experiment for high-cost main sessions. Default
**off** — production context/compaction path unchanged. Does **not** force a
global 200k cap, and must not change model or concurrency in the same run.

Aligns with `docs/session-history-optimization-supplement.md` (S2) and reuses
the Package 4 / P1-3 experiment harness shape (`claimedLiveWin: false`,
fail-closed multi-factor, settings under `deliveryExperiment.*`).

## What this is

| Item | Contract |
|---|---|
| Owner | `packages/coding-agent/src/session/phase-handoff-experiment.ts` |
| Production wire | `session-maintenance.ts#applyPhaseHandoffAtMaintenanceBoundary` via `checkCompaction` |
| Carry builders | `phase-handoff-carry.ts` (phase infer + semantic retain from branch) |
| Rewrite owner | existing `shake("elide")` (not a second memory/compaction system) |
| Gate | `deliveryExperiment.phaseHandoff.enabled` — **default `false`** |
| Factor | `phase_boundary_carry_slim` (or `none`) |
| Retain | open constraints, modification/branch state, acceptance basis, incomplete tools, failed attempts, artifact/recovery locators |
| Drop (treatment) | bulky prior carry only when retained state is present **and** rewrite is consumed via shake |
| Forbidden | global 200k cap; model/concurrency changes; live latency win claims without paired runs |

## Control

```yaml
deliveryExperiment:
  phaseHandoff:
    enabled: false
```

## Treatment

```yaml
deliveryExperiment:
  phaseHandoff:
    enabled: true
    factor: phase_boundary_carry_slim
```

## Production wiring (Batch 2 W6)

When the flag is **on**, `SessionMaintenance.checkCompaction` calls
`applyPhaseHandoffAtMaintenanceBoundary`, which:

1. **Shadow-observes** natural phase boundaries from the live branch (todo /
   tool signals; research→implement→verify or explicit stage complete) — no
   per-turn model summarizer, no forced 200k threshold.
2. **Builds semantic retain state** (not “three arrays non-empty”): pending
   constraints, acceptance contract, modification paths, incomplete tools,
   failed attempts, artifact recovery locators.
3. When treatment sets `shouldRewriteContext`, **consumes it** through the
   existing `shake("elide")` owner (idempotent; fail-open on shake failure or
   incomplete tool pairs).
4. Records shake tokens/drops into the `phase_handoff_maintenance` custom
   entry for observe — does **not** invent savings or set `claimedLiveWin`.

When the flag is **off**, the production context path is unchanged (no
observe, no shake from this path). `paired_evidence_ready` stays false until
authorized paired runs.

## Programmatic harness

```ts
import {
  applyPhaseHandoffExperiment,
  buildPhaseHandoffExperimentRun,
  defaultPhaseHandoffExperimentConfig,
  resolvePhaseHandoffExperiment,
} from "../session/phase-handoff-experiment";

const control = resolvePhaseHandoffExperiment(defaultPhaseHandoffExperimentConfig());
// control.applied === false

const result = applyPhaseHandoffExperiment({
  config: { enabled: true, factor: "phase_boundary_carry_slim" },
  carried: {
    bulkyCarry: ["old tool dump…"],
    retained: {
      openConstraints: ["must keep API compat"],
      modificationState: ["edited src/foo.ts"],
      acceptanceBasis: ["tests pass"],
      artifactLocators: ["artifact://9"],
    },
  },
});
// result.applied === true; bulkyCarry cleared; retained unchanged
```

## Success bar (offline)

Report retained-state fidelity + dropped bulky count together. Never claim
live e2e/cost wins from history concentration alone. Compaction’s own
tokens/rereads belong in total task cost observe — not as invented savings.
