# Phase 0 — E1–E14 map (final dirty tree)

- HEAD tip audited at `aba424f1…`; dirty tree implements R1–R8 without commit.
- Audits: [Map E1-E5](bc-b86c93d7-a2b4-5bc9-b971-78dcfd7a1c5d), [Map E6-E14](bc-b1d19172-d78d-55f1-8617-ee63339ada88), [Audit R4-R8](bc-9d5733ff-562b-56b3-8185-d5ed83e13ff3).

| ID | Dirty tree | Notes |
| --- | --- | --- |
| E1–E3 | **Fixed** | content identity; bash-only gate; empty checks fail |
| E4 | **Fixed** | `extractHostTerminalChecksFromExecutorResult` + structured-subagent wire; no forge without evidence |
| E5–E6 | **Fixed** | known lower bound; gate-retry predicates |
| E7–E10 | **Fixed** | plan/handoff dedupe; bytes docs; single wrap; shared settle |
| E11 | **Fixed for G1/G4** | incremental audit; clear caches; hydrate skips routing-audit bodies (no full coordinator rewrite) |
| E12 | **Fixed** | saveWithIdentity trust path |
| E13 | **Fixed constructors** | shared `buildOutputTruncation` / conservative helper; KDL taxonomy not migrated |
| E14 | **Docs only** | stage chain unchanged |
