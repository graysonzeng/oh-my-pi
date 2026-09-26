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
(same shape as Package 4 read-dedupe). **Enabling the setting alone does not
mutate live session context** — call `applyPhaseHandoffExperiment` from a
harness or an explicit phase-boundary call site. Live compaction remains
unchanged until that apply path is wired.

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
