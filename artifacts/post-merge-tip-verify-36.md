# Post-merge tip verification — PR #36 (D1–D8)

Date: 2026-09-27  
Verifier: independent post-merge agent (read-only; no production default flips)  
Tip branch: `workflow`  
Tip SHA: `f4b85f1f4214e0544a12997cb18b3e2698e4709b`  
Prior tip: `08b957745792fbb489678e1190647d55111545c7` (ancestor confirmed)  
PR: https://github.com/graysonzeng/oh-my-pi/pull/36  
Implementation agent: `bc-5527da7c-7715-570d-8d92-e79bafaa0b64`

## Verdict

**Conditional GO**

Offline mechanism closed-loop for D1–D8 holds on tip: focused suites green, typechecks clean, default-safe seams still present. No tip-blocking bug found.  
**Not** a production GO for live cost/latency wins. `paired_evidence_ready` remains **false** (no invented paired evidence; no claimedLiveWin).

## Tip identity

| Check | Result |
|---|---|
| `git rev-parse HEAD` | `f4b85f1f4214e0544a12997cb18b3e2698e4709b` |
| Subject | `feat(coding-agent): implement D1–D8 architecture plan (#36)` |
| Prior tip is ancestor | yes (`merge-base --is-ancestor 08b9577… HEAD` → 0) |
| #36 merge present | yes (squash/merge commit is tip itself) |

## Commands + pass/fail

Environment note: clean warm-fork snapshot lacked `bun` / `node_modules` / natives; verifier installed Bun 1.4.2, `bun install`, ninja, and `bun run build:native` locally. Did **not** replace `~/.local/bin/omp`.

### Core focused suite (implementer 66-pass spirit)

```bash
cd packages/coding-agent && bun test \
  test/goals/no-progress.test.ts \
  test/capability/rule-source-diagnosis.test.ts \
  test/agent-hub-action-queue.test.ts \
  test/memory-backend/local-transfer.test.ts \
  test/memory-backend/transfer-cli.test.ts \
  test/memory-backend/sharpshooter-transfer.test.ts \
  test/latency/limiter-attribution.test.ts \
  test/modes/controllers/memory-command.test.ts \
  test/latency/subagent-report.test.ts
```

**Result: 66 pass / 0 fail** (9 files, 300 expect calls)

### Closely related regressions (coverage matrix + coordinate boundary)

```bash
cd packages/coding-agent && bun test \
  test/latency/acceptance-coverage-matrix.test.ts \
  test/tools/computer-coordinate-boundary.test.ts
```

Combined with core (11 files): **75 pass / 0 fail**  
Breakdown: +6 coverage-matrix, +3 coordinate-boundary.

### ACP `/memory` transfer cases

```bash
cd packages/coding-agent && bun test test/acp-builtins.test.ts \
  -t '/memory export|/memory import-preview'
```

**Result: 2 pass / 0 fail** (86 filtered out). Full `acp-builtins` not re-run (prior unrelated `/todo append` fail noted by implementer; out of #36 scope).

### Honesty guard (paired evidence)

```bash
cd packages/coding-agent && bun test test/latency/delivery-batch2-wiring.test.ts \
  -t 'paired_evidence_ready'
```

**Result: 1 pass / 0 fail** — `paired_evidence_ready` stays false.

### Typechecks

```bash
cd packages/coding-agent && bun run check:types   # tsgo --noEmit → exit 0
cd packages/tui && bun run check:types           # tsgo --noEmit → exit 0
```

Broader root `bun check` (oxlint + rust) **not** run this pass (not required for tip verify; types were the prior #36 gate).

## Spot-check: default-safe seams

| Seam | Evidence | Status |
|---|---|---|
| D2 `goal.hostGate.noProgressPolicy` default OFF | `workflow-settings.ts` `default: false`; tests prove pause only when policy true; observe-only never pauses | Held |
| D3 delivery experiments OFF | `deliveryExperiment.readDedupe/stablePrefixCache/phaseHandoff.enabled` all `default: false` in `context-settings.ts` | Held |
| D8 `attributeLimiterState` separate domains | `unifiedSemaphore: false` typed + always returned; owners `provider_request` / `task_concurrency` / `async_job_capacity` | Held |
| D4 ACP + TUI memory transfer | TUI `CommandController` handles export / import-preview / import-apply; ACP cases pass for export + import-preview | Held (wiring) |
| D6 Hub **Needs me** | `projectHubActionQueue` + `formatAgentActionNeeds`; docs: view/roster projection, **not a scheduler** | Held (code+unit) |
| completed ≠ accepted | Coverage matrix tests: `candidate_complete` / `done_valid` ≠ accepted; missing receipt ≠ accepted | Held |

## Mechanism vs effect evidence

### Mechanism closed-loop (verified this tip)

- D1 coverage matrix cells + missing-reason codes (unit)
- D2 fingerprint / opt-in pause / continue tally separation (unit)
- D3 experiment master gates remain default-off (settings source + honesty test)
- D4 local/sharpshooter transfer + CLI + TUI/ACP command paths (unit)
- D5 rule-source diagnosis + discovery warning format (unit)
- D6 action-queue projection + inspector Needs me wiring (unit + source)
- D7 coordinate / multi-monitor / stale-frame fixtures (unit)
- D8 limiter attribution without unified semaphore (unit)
- Typechecks coding-agent + tui clean

### Effect evidence (not claimed)

| Claim | Status |
|---|---|
| Live cost/latency win | **Not claimed** |
| `paired_evidence_ready` | **false** (reconfirmed) |
| `claimedLiveWin` | Not asserted true; prior delivery honesty contracts still false in related tests |
| Live Hub TUI interactive paint | **未验证** |
| Live computer platforms (Wayland/macOS/Win) | **未验证** |
| Paid / live A/B | **未验证** (explicitly not run) |
| Production session coverage stats | **未验证** |
| hindsight / mnemopi migrate | **条件不满足暂缓** |
| Cross-process daemon | Out of scope / not introduced |

## Residuals / risks

1. Interactive Hub TUI session still unverified — Needs me is unit-wired only.
2. Computer-use beyond offline fixtures still unverified on real desktops/browsers.
3. No paid paired runs; do not promote tip to “effect proven.”
4. Full harness thinning / module deletion still deferred pending call-graph proof.
5. Cross-backend memory migrate (hindsight/mnemopi) still deferred.
6. Full `acp-builtins` file retains a known unrelated `/todo append` failure mode if run whole-file — not attributed to #36.

## Constraints respected

- Read-only verify: no production default flips, no deliveryExperiment ON, no CHANGELOG edit, no merge, no paid A/B, no claimedLiveWin.
- Did not replace `~/.local/bin/omp`.
- Mechanism closed-loop separated from effect evidence above.
- completed ≠ accepted defended in D1 matrix tests.
- No fix PR opened (no tip-blocking bug found).
