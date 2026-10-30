# R1–R8 Verification

## Environment

- HEAD: `aba424f1da5147586d95e366b933756f74f17c3d`
- Bun 1.4.2; dirty tree (**no git commit / push / PR**)

## Commands run (pass)

| Command | Result |
| --- | --- |
| `bun check` | pass (0 errors) |
| Focused R1–R8 suite (23 files: gate/budget/completion/host-gate/verifier/workspace-code-version/child-delivery/e4/c5/c6/context/r4-wire/routing-audit/shared-defaults/artifacts/parent-settle/read-dedupe/runtime-invocation/engine-happy/resume/budget-stop/subagent-report) | **154 pass / 0 fail** |
| `bun scripts/session-stats/subagent-report.ts --help` (repo root) | pass |
| Measurement writers | `r4-wire-fixture-report.json`, `e3-hash-wallclock-report.json` |

## Not run (explicit)

- Full CI mega-suite / paid model calls / paired A/B
- `gen:compat` / `gen:models` (no KDL taxonomy edits — truncation constructors shared in TS without changing numeric defaults)
- Install / replace `~/.local/bin/omp`
- Git commit / push / PR

## Honesty

- Live quality/cost wins: **not** claimed
- Catalog KDL model-family pattern merge: intentionally skipped to avoid default churn; shared truncation builders close E13 constructor duplication
- Full engine “single run-snapshot type” rewrite: not done; G1/G4 contracts closed via clear-on-resume + skip observe hydrate + incremental audit
