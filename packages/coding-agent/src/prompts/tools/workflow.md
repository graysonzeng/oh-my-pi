Multi-model coding workflow: plan → plan review → implement (isolated) → verify → code review → repair → final verify.

Operations (`op`):
- `start` — create a workflow from `request` (optional `constraints`, `degradedMode`). Does not skip policy gates.
- `status` — read-only snapshot: stage, attempts, artifact refs, budget totals.
- `resume` — continue from the persisted stage (refuses terminal workflows). Optional `singleStep`.
- `cancel` — abort in-flight work and persist `cancelled`.

Do not invent stage transitions. Only the engine advances stages after validated artifacts and deterministic verification.
Never call paid providers from tests; production uses configured model profiles.
