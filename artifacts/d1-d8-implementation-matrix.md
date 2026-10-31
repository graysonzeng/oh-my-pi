# D1–D8 Implementation Matrix

Base tip (pre-fix): `f4b85f1f4214e0544a12997cb18b3e2698e4709b` (workflow + merged D1–D8 #36).
Review range: `08b9577457...f4b85f1f42`. Defect-fix branch tip updates this matrix.
Date: 2026-09-27 (review-defect fix increment).

Labels: **已有且验证** / **本次修复** / **真实外部阻塞**

## Phase A

| ID | Item | Status | Evidence |
|---|---|---|---|
| D1 | Acceptance types (episode/attempt/parent-final/child delivery) | 已有且验证 | Batch1 F3 + `task-episode.ts`, `parent-final-verification.ts`, `child-delivery-evidence.ts` |
| D1 | Coverage matrix — all receipts by episode/attempt | 本次修复 | `subagent-report` uses `groupVerificationsByEpisode`; never last-receipt-only; `ReturnType<>` → `AcceptanceCoverageCell[]` |
| D1 | legacy/missing authority ≠ covered | 本次修复 | `missing_authority` / `legacy_compat`; never covered without trusted authority |
| D1 | candidateComplete / child integrate wiring | 本次修复 | mode_change goal facts + `classifyChildIntegrateCoverage` from delivery evidence |
| D1 | verification-type branching | 本次修复 | review/manual-only do not force code fingerprint; command-check still does |
| D3 | Freshness table (asset → invalidate → visibility) | 本次修复 | `docs/context-freshness-table.md` — managed skill row corrected (not accept-gated); recommended action/reason/impact; edit/external/refresh/clear/new/restart matrix |
| D3 | Recommended action on existing exit | 本次修复 | `/context` via `recommendContextAction` + `appendContextDiagnosisSections` |
| D5 | Source diagnosis (winner/shadowed/disabled) | 本次修复 | Wired into `/context` with live `loadCapability` items/all + `ttsr.disabledRules` |
| D5 | Discovery warnings surfaced once | 已有且验证 | `sdk.ts` logs `formatRuleDiscoveryWarnings` |
| D8 | Lifecycle modes table | 本次修复 | `docs/background-lifecycle-modes.md` exit/revoke matrix + limiter observation notes |

## Phase B

| ID | Item | Status | Evidence |
|---|---|---|---|
| D2 | nominateComplete preserves observation fields | 本次修复 | Spreads existing hostGate; streak survives re-nominate |
| D2 | complete.ts wires real host facts | 本次修复 | acceptanceRevision / trustedFailureIds / provenAcceptanceIds from seals + goal revision |
| D2 | Opt-in no-progress policy default OFF | 已有且验证 | `goal.hostGate.noProgressPolicy` default false |
| D2 | Progress / incomparable / replay / cancel / late / resume regressions | 本次修复 | `test/goals/no-progress.test.ts` + nominate preserve cases |

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
| D4 | Scope gate per-record (no AND smuggle) | 本次修复 | Foreign `record.scope` conflicts even when manifest matches |
| D4 | Content checksum + fingerprint re-verify + version hard fail | 本次修复 | `transfer-integrity.ts`; apply-boundary re-check; never parse warning text |
| D4 | Confirm binding source/target/preview | 本次修复 | `--confirm-cross-scope=<binding>`; bare flag refused |
| D4 | Redact before fingerprint; learned bullet boundaries | 本次修复 | `buildExportRecord` + `splitLearnedLessonBullets`; no silent truncate drop |
| D4 | Reuse `saveLearnedLesson` owner + sharpshooter lock | 本次修复 | `memories/learned.ts`; exclusive transfer lock; inspectable `errors`/`writtenIds` |
| D4 | Preview reads target; idempotency; overwrite explicit | 本次修复 | dup/skip/overwrite vs live target; system artifacts need replaceSystemArtifacts |
| D4 | Completeness vs omittedFields | 本次修复 | `complete=false` when omitted existing assets / sharpshooter bank dump incomplete |
| D4 | Learning candidate ≠ formal activation | 本次修复 | candidates → learned.md only; system facts require explicit replace |
| D4 | hindsight / mnemopi migrate | 真实外部阻塞 | Remote/auth traverse unavailable |
| D4 | Entry delete | 真实外部阻塞 | Explicit unsupported; must not fake via `clear` |

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

## Offline verify (this environment)

```text
Focused D1–D8 defect regressions (12 files):
68 pass / 0 fail

Suites: no-progress + nominate preserve, acceptance-coverage-matrix (+wiring),
local/sharpshooter/transfer-cli, context-decision, hub-action-hints,
limiter-observation/attribution, rule-source-diagnosis,
computer-coordinate-boundary, agent-hub-action-queue
```

## Unverified / residual risk

- Live Hub TUI session (Needs me wired; interactive paint 未验证).
- Live computer-use platforms beyond fixture + adapter.
- Paid/live A/B and production coverage statistics.
- Cross-backend memory migrate (hindsight / mnemopi).
- Full rule/prompt deletion thinning pending zero-caller proof.
- pi-natives addon not built in this VM (ninja missing); D4 transfer tests avoid natives graph.
