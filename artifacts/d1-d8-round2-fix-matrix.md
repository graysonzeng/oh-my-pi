# D1–D8 Round-2 Fix Matrix

Base tip: `6d7f499f2dcf85a5f3cb89fd05638892829570a3` (workflow after #37 tip-verify).
Branch: `cursor/d1-d8-round2-fix-f6c1`.
`paired_evidence_ready=false` (no paid A/B; no live cost/latency claims).

Status legend: **verified** | **local incomplete** | **real tool blocked** | **out of scope**

## D4 (P1)

| Defect | Status | Evidence |
|---|---|---|
| Package↔preview binding; write only verified pkg bodies; refuse omitted pkg | **verified** | `bun test packages/coding-agent/test/memory-backend/local-transfer.test.ts` — refuses apply without pkg; mutated preview body → `preview_package_mismatch` |
| Silent truncate/eviction reported as full success | **verified** | same file — 2122-char import → `partial=true` + `lesson_truncated`; candidates staged |
| Sharpshooter `.transfer.lock` ≠ consolidation lock | **verified** | `sharpshooter-transfer.test.ts` holds `withFileLock(sharpshooterLockPath)` → apply refuses with `consolidate_lock` (natives built) |
| Intra-package MEMORY.md divergent bodies | **verified** | local-transfer — `intra_package_conflict` blocking; zero writes |
| Import candidates inject into context / source dropped | **verified** | candidates → `learned.candidates.md` with `(from: …)`; `learned.md` untouched |

## D1 (P1)

| Defect | Status | Evidence |
|---|---|---|
| Coverage from receipts only (episodes without PFV omitted) | **verified** | `acceptance-coverage-matrix.test.ts` episode-universe: A covered + B missing |
| Sticky `goalCandidateComplete` pollutes later episodes | **verified** (code) | per-episode `goalCandidateByEpisode` + clear on user_confirmed/continue; sticky session flag no longer sole input |
| Unknown receipt version v=999 still covered | **verified** | classifier `unknown_receipt_version`; parser rejects non-v1 |
| Cross-history eventId dedupe | **verified** | `seenEventIds` in coverage loop |
| Docs task type routing at goal-complete | **out of scope** | left to existing review/manual criteria path; not changed this round |

## D2 (P1)

| Defect | Status | Evidence |
|---|---|---|
| Nominate bumps `goalRevision` → streak stuck at 1 | **verified** | `no-progress.test.ts` nominate revision churn → counts `[1,2,3,4]`; `acceptanceRevision` from objective only |
| Code hash in fingerprint resets count | **verified** | hash churn keeps identical fingerprint; streak reaches 3 |
| Mixed `unpaired_tools`+other still pauses | **verified** | mixed reasons wait; `shouldPause=false` at threshold 1 |
| Stale seal as failure; resume baseline; fail-open→candidate | **verified** | stale seals omitted from failures; `resumeGoal` clears streak; fail-open maps to `continue` |

## D3

| Defect | Status | Evidence |
|---|---|---|
| Missing gate → false “no unfinished” at 95% | **verified** | `context-decision.test.ts` unknown unfinished → compact not new_session |
| Freshness doc vs real owner | **verified** | `docs/context-freshness-table.md` owner = session-tools rebuild |
| Local-feasible fingerprint/load/compression fields | **local incomplete** | decision tri-state + doc fixed; full `/context` fingerprint/lane rows not expanded this round |

## D5

| Defect | Status | Evidence |
|---|---|---|
| Diagnose ignores builtinRules / agent scope | **verified** | `rule-source-diagnosis.test.ts` builtinRules:false + agents scope |
| Thin-harness overclaim | **verified** (docs honesty) | matrix below: Documented only ≠ thinning delivered |

## D6

| Defect | Status | Evidence |
|---|---|---|
| Missing startedAt ≠ waiting approval | **verified** | hub-action-hints: no invent auth; explicit overlay only |
| outputPath+parked ≠ delivery evidence | **verified** | parked+outputPath not integrate without overlay |
| Live TUI / kitty-vt-wasm paint | **real tool blocked** | in-process hints verified; live Hub TUI paint 未验证 |

## D7

| Defect | Status | Evidence |
|---|---|---|
| Assert final hit coords for negative origin | **verified** | Rust `multi_monitor_negative_origin_maps_to_global_hit`; TS asserts click x/y |
| Constant self-test removed | **verified** | platform notes tautology deleted |
| Live multi-screen / Retina | **real tool blocked** | external platforms |

## D8

| Defect | Status | Evidence |
|---|---|---|
| Sum provider capacities masking saturation | **verified** | `stream.ts` worst-provider occupancy + `anyBlocking` |
| Unknown occupancy emits zeros+blocking=false | **verified** | format prints `unknown_occupancy (no sample — not idle)` |
| Wire TaskTool semaphore into `/context` | **local incomplete** | observe path accepts `taskSpawnSemaphore`; `/context` cannot reach TaskTool instance without new session seam |

## Focused verify commands

```bash
bun test packages/coding-agent/test/memory-backend/local-transfer.test.ts \
  packages/coding-agent/test/memory-backend/sharpshooter-transfer.test.ts \
  packages/coding-agent/test/goals/no-progress.test.ts \
  packages/coding-agent/test/latency/acceptance-coverage-matrix.test.ts \
  packages/coding-agent/test/modes/hub-action-hints.test.ts \
  packages/coding-agent/test/slash-commands/context-decision.test.ts \
  packages/coding-agent/test/latency/limiter-observation.test.ts \
  packages/coding-agent/test/latency/limiter-attribution.test.ts \
  packages/coding-agent/test/tools/computer-coordinate-boundary.test.ts \
  packages/coding-agent/test/capability/rule-source-diagnosis.test.ts

# types
(cd packages/coding-agent && bun run check:types)

# rust hit coords
cargo test -p pi-natives multi_monitor_negative_origin -- --nocapture
```

Focused result this VM: **77 pass / 0 fail**, `check:types` clean, Rust map_point ok.
