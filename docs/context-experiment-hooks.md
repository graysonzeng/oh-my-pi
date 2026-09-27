# Experiment switches (D3 Phase D) — remain OFF by default

Single-factor experiment facilities already exist. This round **does not** enable them, run paid A/B, or flip production defaults.

| Experiment | Setting gate | Default | claimedLiveWin | paired_evidence_ready |
|---|---|---|---|---|
| Context strategy | `compaction.experiment.enabled` | `false` | always false in judge | requires live corpus |
| Stable-prefix cache | latency experiment module | opt-in / off | always false | — |
| Read-dedupe | latency experiment module | opt-in / off | always false | — |
| Phase handoff | phase-handoff experiment | off | always false | — |
| Delivery Batch1 status | `batch1-status.ts` | — | — | `false` until live evidence |

Owners: `SessionMaintenance`, existing latency experiment modules. No second scheduler.

See: `docs/context-strategy-experiment.md`, `docs/delivery-read-cache-experiments.md`, `docs/p2-optimization-blocked-until.md`, `docs/context-freshness-table.md`.
