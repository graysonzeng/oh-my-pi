Multi-model coding workflow: plan → plan review → implement (isolated) → verify → code review → repair → final verify.

Operations (`op`):
- `start` — create from `request`; optional `constraints`, `qualityTier`, `degradedMode`, `pipeline=devflow`. Omit `qualityTier` for configured default (`balanced` unless configured); use `critical` for L/P0/high-risk work. Quality routes reject degraded mode. `start` does not execute stages.
- `run` — create (same fields as start) then execute immediately. A single invocation runs at most 32 stage steps; non-terminal returns `maxStepsReached=true` so the coordinator can `resume`. DevFlow overlay requires `pipeline=devflow`.
- `status` — read-only snapshot: stage, attempts, artifact refs, budget totals.
- `resume` — continue from the persisted stage (refuses terminal workflows). Optional `singleStep`. Same 32-step cap as `run`.
- `cancel` — abort in-flight work and persist `cancelled`.

You NEVER invent stage transitions. Only validated artifacts and deterministic verification advance stages.
You NEVER call paid providers from tests; production uses configured model profiles.
