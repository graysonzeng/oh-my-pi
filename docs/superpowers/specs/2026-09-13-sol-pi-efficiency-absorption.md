# SoL-Pi efficiency absorption (docs + contract only)

- Date: 2026-09-13
- Status: Documentation / test contract alignment — **no new runtime**
- Related: `docs/tools/eval.md` § "Couple a file mutation to its verifier",
  `packages/coding-agent/test/eval/mutation-then-verify.test.ts`

## Goal

Absorb a SoL-Pi style mutation→verifier **recipe** into existing eval tool
bridges so writers can gate a predetermined bash verifier after a successful
write. This is efficiency documentation and a locked contract test, not a
performance claim.

## What lands

1. Eval docs section named **"Couple a file mutation to its verifier"** with
   fail-closed write→verify control flow.
2. Contract test already present: write failure must not start verify; success
   runs verify once; failed verify keeps the write; background `running` is not
   success.

## What does not land

- No `then_run` helper or tool.
- No second ObservationPack layer.
- No write/bash rebuild.
- No claim that default sessions save a model turn.
- No transactional rollback.
- No Track E thrash prompt rules (see go/no-go below).

## Boundaries

| Topic | Rule |
|---|---|
| Transaction | Not a transaction; verify failure does not delete the write |
| Background ack | `async.state === "running"` ≠ verified |
| Cancel | Cancel does not guarantee verify re-run |
| Turn savings | Recipe does not automatically mean one fewer model turn |
| Measurement | Use existing receipts / offline reports; do not invent a parallel metrics stack |

## Thrash / Track E go/no-go

- Analysis of identical-view / repeated-read candidates has started.
- Counts such as “501 identical-view reads” (when observed in a local corpus)
  are **candidates only**, not proven redundant work.
- **Current decision: no-go** on additional Track E prompt rules until human
  attribution completes and explicitly flips to go.
- Prefer documenting status over expanding prompt scope.
