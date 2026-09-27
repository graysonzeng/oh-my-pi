# D1–D8 Implementation Matrix

Base tip: `08b957745792fbb489678e1190647d55111545c7` (workflow + merged #35 thin-orch Batch1).
Date: 2026-09-27.

Labels: **已有且验证** / **本次实现** / **条件不满足暂缓**

## Phase A

| ID | Item | Status | Evidence |
|---|---|---|---|
| D1 | Acceptance types (episode/attempt/parent-final/child delivery) | 已有且验证 | Batch1 F3 + `task-episode.ts`, `parent-final-verification.ts`, `child-delivery-evidence.ts`; thin-orch tests |
| D1 | Coverage matrix with **missing coverage reasons** | 本次实现 | `latency/acceptance-coverage-matrix.ts` wired into `subagent-report`; `test/latency/acceptance-coverage-matrix.test.ts` |
| D1 | candidate_complete ≠ accepted visibility | 本次实现 | Reason `candidate_not_user_confirmed`; docs `acceptance-coverage-matrix.md` |
| D1 | Fixture authority excluded from production coverage | 本次实现 | `fixture_authority_excluded` cell status |
| D3 | Freshness table (asset → invalidate → visibility) | 本次实现 | `docs/context-freshness-table.md` (no TTL defaults flipped) |
| D5 | Source diagnosis (winner/shadowed/disabled) | 本次实现 | `capability/rule-source-diagnosis.ts` + tests |
| D5 | Discovery warnings surfaced once | 本次实现 | `sdk.ts` logs `formatRuleDiscoveryWarnings`; doc gap closed in `rulebook-matching-pipeline.md` |
| D8 | Lifecycle modes table | 本次实现 | `docs/background-lifecycle-modes.md` (no new permanent service) |

## Phase B

| ID | Item | Status | Evidence |
|---|---|---|---|
| D2 | `consecutiveContinueCount` exists (≠ no-progress) | 已有且验证 | `goals/state.ts` / runtime; documented separation |
| D2 | Progress observation fields + fingerprint | 本次实现 | `lastProgressFingerprint`, `noProgressCount`, `lastObservedNominationId`, `lastPauseReason`; `goals/no-progress.ts` |
| D2 | Opt-in no-progress policy (default OFF) | 本次实现 | `goal.hostGate.noProgressPolicy` default `false`; threshold default 3 (fixture); wired in `complete.ts` / `runtime.applyNominationResult` |
| D2 | Cancel / late / replay / unpaired wait semantics | 本次实现 | Tests: nomination dedupe, unpaired_tools wait, evaluator unavailable, non-continue clear |
| D2 | Permanent failure→regression corpus library | 条件不满足暂缓 | No authorized live failure corpus / packaging pipeline this round; reuse existing unit tests only |

## Phase C

| ID | Item | Status | Evidence |
|---|---|---|---|
| D5 | Evidence-backed thinning (warnings + candidates) | 本次实现 | Warnings fix + `docs/thin-harness-candidates.md`; **no module deletion** without caller proof |
| D5 | Delete duplicate global flow / forwarders | 条件不满足暂缓 | Needs full call-graph + behavioral proof per plan §9.3 |
| D6 | Hub action queue projection | 本次实现 | `tui/.../agent-hub-action-queue.ts` + `test/agent-hub-action-queue.test.ts` + `docs/agent-hub.md` |
| D6 | Inspector **Needs me** paint | 本次实现 | `agent-hub.ts` + `formatAgentActionNeeds`; optional `actionHints` on overlay deps |
| D6 | Live Hub TUI session / interactive paint | 条件不满足暂缓 / **未验证** | No interactive TUI session in this environment |
| F1/F2/F3/F6 thin-orch | Batch1 already on tip | 已有且验证 | PR #35 / tests `thin-orch-f{1,2,3,6}-*` |

## Phase D

| ID | Item | Status | Evidence |
|---|---|---|---|
| D3 | Single-factor experiment facilities | 已有且验证 | SessionMaintenance + context/stable-prefix/read-dedupe experiments exist |
| D3 | Keep experiments OFF; no paid A/B | 本次实现 | `docs/context-experiment-hooks.md`; no default flips; `claimedLiveWin` untouched |
| D3 | Live paired evidence / claimedLiveWin | 条件不满足暂缓 | `paired_evidence_ready` stays false; no paid model runs |

## Phase E

| ID | Item | Status | Evidence |
|---|---|---|---|
| D4 | MemoryBackend transfer types | 本次实现 | `memory-backend/transfer-types.ts` optional methods on `MemoryBackend` |
| D4 | Local backend export/preview/import | 本次实现 | `local-transfer.ts` + `local-backend` wiring; tests round-trip + scope conflict + dedupe |
| D4 | `/memory export` / import-preview / import-apply | 本次实现 | ACP + TUI CommandController; `transfer-cli.ts`; off backend reports unsupported |
| D4 | Second backend full traverse seam (sharpshooter) | 本次实现 | `sharpshooter-transfer.ts` walks architecture/product/style.md; omits queue/state/lock; apply needs `replaceSystemArtifacts` |
| D4 | hindsight / mnemopi full migrate | 条件不满足暂缓 | Remote/auth traverse not available this round |
| D4 | Entry delete | 条件不满足暂缓 | Explicit unsupported; must not fake via `clear` |

## Phase F

| ID | Item | Status | Evidence |
|---|---|---|---|
| D7 | Coordinate / stale / multi-monitor fixtures | 本次实现 | `test/tools/computer-coordinate-boundary.test.ts` |
| D7 | Native InvalidCoordinateFrame before capture | 已有且验证 | `packages/natives/test/desktop.test.ts` |
| D7 | Live browser/desktop platform matrix | 条件不满足暂缓 / **未验证** | No target desktop/browser session in this environment |
| D7 | `read_only` not sandbox | 已有且验证 | `docs/computer-use.md` + existing computer approval tests |
| D8 | Lifecycle docs / rate-limit separation | 本次实现 | `docs/background-lifecycle-modes.md` |
| D8 | Limiter-attribution fixture | 本次实现 | `latency/limiter-attribution.ts` + tests; provider ≠ task ≠ job; `unifiedSemaphore` always false |
| D8 | Cross-process daemon | 条件不满足暂缓 | Explicitly out of scope — no new permanent service |

## Defaults / safety (must hold)

| Constraint | Status |
|---|---|
| No production model/effort/concurrency default flips | Held |
| `goal.hostGate.noProgressPolicy` default false | Held |
| No second evidence schema / task ledger / Dreaming / unified semaphore | Held |
| No auto-publish/merge; CHANGELOG not edited | Held |
| Provider / task / job rate limits not merged | Documented in D8 + `attributeLimiterState` fixture |

## Offline verify (this environment)

```text
Focused D1–D8 + this increment (no-progress, rule-source-diagnosis, hub queue,
local/transfer-cli/sharpshooter-transfer, limiter-attribution, memory-command,
subagent-report): 66 pass / 0 fail

Plus coordinate fixtures + coverage matrix + ACP /memory export|import-preview:
all new/related cases pass. `bun run check:types` clean for coding-agent and tui.

Full acp-builtins file also ran: 1 pre-existing fail (`/todo append` custom-entry
length) unrelated to memory transfer; all /memory cases in that file passed.
```

## Unverified / residual risk

- Live Hub TUI session (inspector Needs me is wired; interactive session not run here).
- Live computer-use platforms (Wayland/macOS/Win) beyond fixture + existing native reject-before-capture.
- Paid/live A/B and production coverage statistics on real user sessions.
- Cross-backend memory migrate (hindsight / mnemopi).
- Full rule/prompt deletion thinning pending call-graph evidence.
