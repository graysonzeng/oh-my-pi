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
| Gate | `deliveryExperiment.phaseHandoff.enabled` — **default `false`** |
| Factor | `phase_boundary_carry_slim` (or `none`) |
| Retain | open constraints, modification state, acceptance basis |
| Drop (treatment) | bulky prior carry only when retained state is present |
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

## Programmatic harness

Settings under `deliveryExperiment.phaseHandoff.*` register the opt-in gate
(same shape as Package 4 read-dedupe). **Batch 2 honesty:** the library and
`SessionMaintenance.observePhaseHandoffBoundary` API exist and are covered by
fixtures, but **treatment is not production-wired** — no production caller yet
supplies real phase transitions + carried retain state, and
`shouldRewriteContext` is not fed into the compaction/elide owner. When the
flag is **off**, the production context path is unchanged. Treatment still
requires a detected boundary + semantic retained state (constraints, mods,
acceptance, and recovery locators when declared) — not merely “three arrays
non-empty”. `claimedLiveWin` stays false; `runtime_wired=false`; paired
evidence is insufficient.

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
    },
  },
});
// result.applied === true; bulkyCarry cleared; retained unchanged
```

## Success bar (offline)

Report retained-state fidelity + dropped bulky count together. Never claim
live e2e/cost wins from history concentration alone.
