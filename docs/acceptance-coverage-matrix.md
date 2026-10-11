# Acceptance coverage matrix (D1)

Offline visibility for **why** acceptance coverage is missing. Built on existing `parent_final_verification` and child delivery evidence — not a second evidence schema.

## API

- `packages/coding-agent/src/latency/acceptance-coverage-matrix.ts`
- Wired into `buildSubagentBaselineReport` → `acceptanceCoverage` + formatted section in `formatSubagentBaselineReport`

## Reason codes

| Code | Meaning |
|---|---|
| `no_parent_final_receipt` | No trusted parent-final receipt (stop/exit 0 ≠ accept) |
| `receipt_lacks_authority` | v1+ receipt without trusted authority |
| `fixture_authority_excluded` | Fixture excluded from production coverage |
| `acceptance_contract_missing` | No acceptance items on receipt |
| `code_state_missing` | No code fingerprint binding |
| `evidence_refs_missing` | No evidence refs |
| `episode_linkage_missing` | No episode/attempt linkage |
| `receipt_failed` | Explicit failed verification |
| `child_unproven` | Child delivery unproven |
| `pending_parent_integrate` | `done_valid` / integrate-eligible — **not** accepted |
| `stale_or_scope_unknown` | Code/scope drift |
| `candidate_not_user_confirmed` | Goal `candidate_complete` awaiting `/goal complete` |
| `price_unknown` | Reserved for cost cohort nulls |

## Semantics preserved

- `candidate_complete` ≠ accepted
- Fields existing on a receipt ≠ production coverage complete
- Fixture authority stays labeled/excluded in production stats
