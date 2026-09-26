# R1–R8 Changes

## Baseline

- Start HEAD: `aba424f1da5147586d95e366b933756f74f17c3d`
- Plan: `docs/design/workflow-consolidation-implementation-plan.md`
- **No git commit / push / PR**

## Product changes (by round)

| Round | Paths | Change |
| --- | --- | --- |
| R1 | `workspace-code-version`, `completion`, `verifier`, `host-gate` | Content identity; empty checks fail; bash-only verification candidates |
| R2 | `parent-delivery-consume`, `task/index`, `workpool`, `child-delivery-evidence`, `structured-subagent` | Shared settle; host_verification → terminalChecksPassed |
| R3 | `budget-ledger`, `gate-retry`, `engine` | Known lower bound; non-retryable gate errors |
| R4 | `context-builder`, `stage-handoff` | Plan projection; SEE_PLAN; handoff dedupe; bytesAfterHandoff docs |
| R5 | `artifacts`, `session-manager`, `agent-session` | `saveWithIdentity`; skip post-write reread |
| R6 | `tool-output-manager`, `default-profiles`, `default-config`, `runtime-invocation` | Shared truncation builders; remove dup wrap |
| R7 | `engine` | Incremental routing-audit; resume cache clear; hydrate skips routing-audit bodies |
| R8 | `docs/workflow.md`, `subagent-report` | Defaults matrix; offline comparison; deliveryQualityOutcomes rollup |

## Tests

New/updated: workspace-code-version, budget-ledger, gate-retry, context-builder-r4, r4-wire-fixture, c5/c6, e4-host-terminal, routing-audit-incremental, shared-defaults-r6, artifact-save-identity(+e3), parent-settle-shared, engine-resume G1, plus updated completion/host-gate/verifier/child-delivery.

## Defaults unchanged

- Model / effort / concurrency defaults not modified
- Experiments remain off
- Ordinary vs workflow `resultSummarization.enabled` divergence preserved (false vs true)
