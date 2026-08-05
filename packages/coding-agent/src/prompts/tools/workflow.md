Multi-model coding workflow: plan → plan review → implement (isolated) → verify → code review → repair → final verify.

Operations (`op`):
- `start` — create from `request`; optional `constraints`, `qualityTier`, `degradedMode`. Omit `qualityTier` for configured default (`balanced` unless configured); use `critical` for L/P0/high-risk work. Quality routes reject degraded mode.
- `status` — read-only snapshot: stage, attempts, artifact refs, budget totals.
- `resume` — continue from the persisted stage (refuses terminal workflows). Optional `singleStep`.
- `cancel` — abort in-flight work and persist `cancelled`.

You NEVER invent stage transitions. Only validated artifacts and deterministic verification advance stages.
You NEVER call paid providers from tests; production uses configured model profiles.
