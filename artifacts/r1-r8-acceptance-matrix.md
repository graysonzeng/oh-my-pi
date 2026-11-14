# R1–R8 Acceptance Matrix

- HEAD: `aba424f1da5147586d95e366b933756f74f17c3d` (branch `workflow`)
- Plan: `docs/design/workflow-consolidation-implementation-plan.md`
- Defaults / experiments unchanged; **no git commit / push / PR**; dirty tree retained
- `completed ≠ accepted`; no `claimedLiveWin`; paired evidence stays false
- Measurement JSON: `artifacts/r4-wire-fixture-report.json`, `artifacts/e3-hash-wallclock-report.json`

## R1–R8 summary

| Item | Result | Evidence |
| --- | --- | --- |
| R1 Code identity / validity / final gate | **pass** | `content:<sha>` via `captureVerificationWorkspace`; empty-checks deleted; eval ≠ bash execution |
| R2 Child delivery + shared consume | **pass** | Shared settle; host_verification → terminalChecksPassed (E4); parent-owns-verify → `parent_coordinate` |
| R3 Budget + gate retry | **pass** | `knownCostLowerBoundUsd`; `gate-retry.ts`; C5/C6 tests |
| R4 Context / handoff dedupe | **pass** | `projectPlanForPrompt`; SEE_PLAN; D4 wire fixture |
| R5 Read dedupe cost | **pass** | `saveWithIdentity`; E3 hash/disk/wall table |
| R6 Strategy / duplicate code | **pass** | Shared `buildOutputTruncation` / `buildConservativeOutputTruncation`; intentional summarization divergence kept; **no KDL model-family migration** (defaults unchanged; catalog taxonomy untouched) |
| R7 Engine persist / observe | **pass** | Incremental routing-audit; resume clears caches; hydrate skips routing-audit bodies (G4); full coordinator rewrite not required for acceptance |
| R8 Entry boundary + offline docs | **pass** | `docs/workflow.md` defaults + offline comparison; `deliveryQualityOutcomes` in baseline report; subagent-report --help |

## A1–H4

| ID | Result | Evidence |
| --- | --- | --- |
| A1 | **pass** | `workspace-code-version.test.ts`; final-verify-reuse workspace change |
| A2 | **pass** | verification-validity tracked/index/binary/untracked |
| A3 | **pass** | Capture fail-closed outside repo / empty version |
| A4 | **pass** | Empty/skipped-only rejected; eval-only not bash candidate |
| A5 | **pass** | evaluateWorkflowFinalCompletion + engine happy path |
| A6 | **pass** | Host-gate bash candidate + docs |
| B1 | **pass** | `e4-host-terminal-checks.test.ts` host receipts → integrate when version matches |
| B2 | **pass** | Forged/stale/out-of-scope/unreleased ownership tests |
| B3 | **pass** | parent-owns-verify → parent_coordinate |
| B4 | **pass** | parent-settle-shared task/workpool same classification |
| B5 | **pass** | No host receipts → checksNotRun; finalAccepted false |
| C1–C4 | **pass** | Budget ledger + gate-retry tests + engine budget-stop |
| C5 | **pass** | c5 unit + engine already-applied/prepared resume mergeCalls=0 |
| C6 | **pass** | c6-tool-free-final + executor-wall-clock |
| D1–D5 | **pass** | context-builder-r4 + r4-wire-fixture + runtime-invocation W5 |
| E1–E5 | **pass** | read-dedupe ordinary + e3 measurements + experiment mutex |
| F1–F4 | **pass** | shared-defaults-r6 (shared builders); quality-route fingerprints; bun check; KDL family tables left as-is (no default churn) |
| G1–G6 | **pass** | engine-resume G1 clear; incremental audit; cancel/lock; hydrate skips routing-audit load |
| H1–H4 | **pass** | docs ordinary≠workflow; subagent-report --help; quality outcomes unknown unless labeled; defaults matrix |

## Commands that establish pass evidence

See `artifacts/r1-r8-verification.md`.
