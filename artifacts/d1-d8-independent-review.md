# Independent review notes (D1–D8)

Reviewer stance: adversarial pass after review-defect fixes (D3/D5–D8).

## Checklist

| Label | Meaning |
|---|---|
| 已有且验证 | Already correct on tip; re-checked |
| 本次修复 | Fixed in this defect-fix increment |
| 真实外部阻塞 | Cannot complete here (platform / auth / live session) |

## Defects addressed this increment

### D3 — 本次修复
- Managed skills row no longer claims accept-gating; documents `manage_skill`→`refreshSkills` vs `learn` skip refresh.
- Recommended action/reason/impact projected on `/context` (`context-decision.ts`).
- Visibility matrix covers edit / external / refresh / clear / new / restart.

### D5 — 本次修复
- `diagnoseRuleSources` wired into `/context` with real `disabledRules` + discovery `items`/`all`.
- Warnings path in `sdk.ts` kept.
- Thinning Batch 1 documented with call-site evidence + migration checklist; no blind module deletes.

### D6 — 本次修复
- `collectHubActionHints` feeds `createAgentHubRuntime.actionHints` from ask/approval pending tools, goal blocked/no-progress, integrate-eligible children.
- Selector passes live AskDialog focus for Main.
- Tests cover cancel-then-late, dedupe/refresh, advisor skip.
- Live TUI interactive session: **未验证** (真实外部阻塞).

### D7 — 本次修复
- Removed parallel `mapModelPointToDesktop` test algorithm.
- Product `adaptDesktopSession` contracts: pre-capture reject, Retina/sourceWidth, multi-monitor neg origin, stale layout change, closed/invalid target.
- Live platforms: **未验证**.

### D8 — 本次修复
- `observeLimiterAttribution` samples provider leases (when configured), task semaphore, async job capacity separately.
- Wired into `/context` diagnosis + `/jobs`.
- Missing occupancy → `unknown_occupancy=…`; `unifiedSemaphore` always false.
- Exit/revoke matrix expanded in lifecycle docs; no new daemon / no blind replay.

## Residual risks (not bugs)

- Live Hub TUI paint 未验证.
- Live computer platforms / paid A/B / hindsight+mnemopi migrate — 真实外部阻塞.
- Task spawn semaphore only observed when a TaskTool instance is passed; `/context` currently marks `task_concurrency` unknown unless wired — acceptable (unknown ≠ merged).

## Verify (this environment)

Focused suites for context-decision, hub-action-hints, limiter-observation/attribution, rule-source-diagnosis, computer-coordinate-boundary, plus prior D1/D2 suites as needed. See commit message for pass counts.
