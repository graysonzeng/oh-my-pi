# D1–D8 Implementation Matrix

Base tip: `08b957745792fbb489678e1190647d55111545c7` (workflow + merged #35 thin-orch Batch1).
Date: 2026-09-27 (review-defect fix increment).

Labels: **已有且验证** / **本次修复** / **真实外部阻塞**

## Phase A

| ID | Item | Status | Evidence |
|---|---|---|---|
| D1 | Acceptance types (episode/attempt/parent-final/child delivery) | 已有且验证 | Batch1 F3 + `task-episode.ts`, `parent-final-verification.ts`, `child-delivery-evidence.ts` |
| D1 | Coverage matrix with missing coverage reasons | 已有且验证 | Prior fix on branch; `latency/acceptance-coverage-matrix.ts` |
| D3 | Freshness table (asset → invalidate → visibility) | 本次修复 | `docs/context-freshness-table.md` — managed skill row corrected (not accept-gated); recommended action/reason/impact; edit/external/refresh/clear/new/restart matrix |
| D3 | Recommended action on existing exit | 本次修复 | `/context` via `recommendContextAction` + `appendContextDiagnosisSections` |
| D5 | Source diagnosis (winner/shadowed/disabled) | 本次修复 | Wired into `/context` with live `loadCapability` items/all + `ttsr.disabledRules` |
| D5 | Discovery warnings surfaced once | 已有且验证 | `sdk.ts` logs `formatRuleDiscoveryWarnings` |
| D8 | Lifecycle modes table | 本次修复 | `docs/background-lifecycle-modes.md` exit/revoke matrix + limiter observation notes |

## Phase B

| ID | Item | Status | Evidence |
|---|---|---|---|
| D2 | Opt-in no-progress + observation fields | 已有且验证 | Prior fix on branch |

## Phase C

| ID | Item | Status | Evidence |
|---|---|---|---|
| D5 | Evidence-backed thinning batch | 本次修复 | `docs/thin-harness-candidates.md` Batch 1 with call-site evidence + migration checklist; **no blind deletes** |
| D6 | Hub actionHints from real owners | 本次修复 | `collectHubActionHints` + `createAgentHubRuntime.actionHints` + selector ask-dialog overlay |
| D6 | Inspector Needs me | 已有且验证 | Projection + paint; now fed by real hints |
| D6 | Live Hub TUI session | 真实外部阻塞 / **未验证** | No interactive TUI session in this environment |

## Phase D

| ID | Item | Status | Evidence |
|---|---|---|---|
| D3 | Experiments OFF; no paid A/B | 已有且验证 | `docs/context-experiment-hooks.md` |
| D3 | Live paired evidence | 真实外部阻塞 | `paired_evidence_ready` false |

## Phase E

| ID | Item | Status | Evidence |
|---|---|---|---|
| D4 | Local transfer + sharpshooter seam + CLI | 已有且验证 | Prior work on branch (most of D4) |
| D4 | hindsight / mnemopi migrate | 真实外部阻塞 | Remote/auth traverse unavailable |

## Phase F

| ID | Item | Status | Evidence |
|---|---|---|---|
| D7 | Delete parallel mapModelPoint algorithm | 本次修复 | `computer-coordinate-boundary.test.ts` uses `adaptDesktopSession` product contracts |
| D7 | Multi-monitor / Retina / stale / transport | 本次修复 | Adapter fixtures for neg origin, scale/sourceWidth, layout-change InvalidCoordinateFrame |
| D7 | Live browser/desktop platforms | 真实外部阻塞 / **未验证** | wayland/macOS/win/browser live sessions absent |
| D8 | Limiter attribution on real diagnose path | 本次修复 | `observeLimiterAttribution` on `/context` + `/jobs`; unknown when occupancy missing; `unifiedSemaphore: false` |
| D8 | Cross-process daemon | 真实外部阻塞 | Out of scope — no new permanent service |

## Defaults / safety (must hold)

| Constraint | Status |
|---|---|
| No production model/effort/concurrency default flips | Held |
| No second evidence schema / task ledger / Dreaming / unified semaphore | Held |
| No CHANGELOG edit | Held |
| No TTL / second SessionMaintenance scheduler | Held |

## Unverified / residual risk

- Live Hub TUI session (Needs me wired; interactive paint 未验证).
- Live computer-use platforms beyond fixture + adapter.
- Paid/live A/B and production coverage statistics.
- Cross-backend memory migrate (hindsight / mnemopi).
- Full rule/prompt deletion thinning pending zero-caller proof.
