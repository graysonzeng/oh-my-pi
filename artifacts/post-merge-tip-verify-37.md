# Post-merge tip verify — PR #37 (D1–D8 review defect fixes)

| Field | Value |
|---|---|
| Branch base | `workflow` |
| Merge tip SHA | `8128f5e4d799c5bcaf21e6449ef4f6e461c6823e` |
| Confirmed `git rev-parse HEAD` | `8128f5e4d799c5bcaf21e6449ef4f6e461c6823e` |
| Prior tip (before #37) | `f4b85f1f4214e0544a12997cb18b3e2698e4709b` |
| Merged PR | https://github.com/graysonzeng/oh-my-pi/pull/37 |
| Merged head | `65bb5d3030670da67940ae36094f01cce512c661` |
| Verify date (UTC) | 2026-09-27 |
| `paired_evidence_ready` | **false** |
| **Verdict** | **Conditional GO** |

Pattern note: `artifacts/post-merge-tip-verify-36.md` was not present in this checkout; this report mirrors the #37 claimed focused suite set from the PR body / `artifacts/d1-d8-implementation-matrix.md`.

## What #37 brought (high level)

Merge commit: `fix(coding-agent): close confirmed D1–D8 review defects (#37)`.

Mechanism / wiring fixes only (no production experiment flip, no paid A/B):

- **D1** — acceptance coverage matrix: all parent-final receipts by episode/attempt; authority/legacy gates; command-check vs review/manual fingerprint; candidateComplete + child integrate wiring.
- **D2** — nominateComplete preserves no-progress observation fields; host seal fields on fingerprints.
- **D3** — `/context` recommended action/reason/impact; managed-skill freshness correction.
- **D4** — memory transfer integrity (checksum trust, confirm binding, scope AND-gate, format fail-closed).
- **D5** — `diagnoseRuleSources` on `/context`; thinning docs with call-site evidence.
- **D6** — Hub action hints from ask/approval/goal/integrate; cancel-then-late + dedupe.
- **D7** — computer coordinate product contracts (frame/capture/stale/multi-monitor) replacing parallel mapModelPoint algorithm test.
- **D8** — limiter attribution observation on `/context` + `/jobs`; `unifiedSemaphore` stays false.

## Verdict rationale

**Conditional GO** — tip SHA confirmed; the same 12 focused D1–D8 defect regression files claimed by #37 re-run clean on this tip (**68 pass / 0 fail**); `check:types` clean for coding-agent / tui / ai; deliveryExperiment defaults remain off; no accidental production default flips found vs prior tip.

Conditioned on still-open external surfaces below (live Hub TUI paint, live computer platforms, paid A/B, cross-backend migrate). Mechanism verify only — **no live cost / latency / product-win claims**.

## Environment notes

| Gap | Handling |
|---|---|
| Fresh VM: bun + `node_modules` absent at boot | Installed bun 1.4.2; `bun install` (414 packages) |
| `pi_natives` missing; `ninja` initially absent | Installed `ninja-build`; `bun --cwd=packages/natives run build` → `pi_natives.linux-x64-modern.node` |
| Before natives build | 4/12 suites errored at load (`no-progress`, `acceptance-coverage-matrix`, `sharpshooter-transfer`, `limiter-observation`) — **not** product regressions; re-run after build is the authoritative result |
| `~/.local/bin/omp` | Not replaced; not present |
| Paid A/B / live Hub / live computer platforms | Not run (hard constraint / external) |

Raw logs: `artifacts/logs/focused-d1-d8-tip37.log` (pre-natives), `artifacts/logs/focused-d1-d8-tip37-after-natives.log` (authoritative), `artifacts/logs/check-types-tip37.log`, `artifacts/logs/natives-build-tip37.log`, `artifacts/logs/extra-memory-acp-tip37.log`.

## Focused suites (authoritative — after natives)

Command:

```bash
cd packages/coding-agent && bun test \
  test/goals/no-progress.test.ts \
  test/latency/acceptance-coverage-matrix.test.ts \
  test/memory-backend/local-transfer.test.ts \
  test/memory-backend/sharpshooter-transfer.test.ts \
  test/memory-backend/transfer-cli.test.ts \
  test/slash-commands/context-decision.test.ts \
  test/modes/hub-action-hints.test.ts \
  test/latency/limiter-observation.test.ts \
  test/latency/limiter-attribution.test.ts \
  test/capability/rule-source-diagnosis.test.ts \
  test/tools/computer-coordinate-boundary.test.ts \
  test/agent-hub-action-queue.test.ts
```

Result summary: **68 pass / 0 fail / 12 files** (matches #37 PR claim).

| Suite | Area | Result | Counts |
|---|---|---|---|
| `test/goals/no-progress.test.ts` | D2 | PASS | 13 pass / 0 fail |
| `test/latency/acceptance-coverage-matrix.test.ts` | D1 | PASS | 12 pass / 0 fail |
| `test/memory-backend/local-transfer.test.ts` | D4 | PASS | 10 pass / 0 fail |
| `test/memory-backend/sharpshooter-transfer.test.ts` | D4 | PASS | 4 pass / 0 fail |
| `test/memory-backend/transfer-cli.test.ts` | D4 | PASS | 3 pass / 0 fail |
| `test/slash-commands/context-decision.test.ts` | D3 | PASS | 3 pass / 0 fail |
| `test/modes/hub-action-hints.test.ts` | D6 | PASS | 4 pass / 0 fail |
| `test/latency/limiter-observation.test.ts` | D8 | PASS | 2 pass / 0 fail |
| `test/latency/limiter-attribution.test.ts` | D8 | PASS | 4 pass / 0 fail |
| `test/capability/rule-source-diagnosis.test.ts` | D5 | PASS | 3 pass / 0 fail |
| `test/tools/computer-coordinate-boundary.test.ts` | D7 / coordinate | PASS | 6 pass / 0 fail |
| `test/agent-hub-action-queue.test.ts` | D6 | PASS | 4 pass / 0 fail |
| **Total (12 focused)** | D1–D8 | **PASS** | **68 / 0** |

### Adjacent cheap memory suites (extra; not in #37 12-file claim)

```bash
cd packages/coding-agent && bun test \
  test/memory-backend-resolve.test.ts \
  test/agent-session-memory-backend.test.ts \
  test/slash-commands/memory.test.ts \
  test/memory-redaction.test.ts
```

| Suite | Result | Counts |
|---|---|---|
| memory-backend-resolve + agent-session-memory-backend + slash memory + memory-redaction | PASS | 32 pass / 0 fail |

ACP protocol suite battery was not part of the #37 claim set; not expanded further. Coordinate coverage is already in the D7 focused file above.

## Types check

```bash
(cd packages/coding-agent && bun run check:types)  # EXIT 0
(cd packages/tui && bun run check:types)             # EXIT 0
(cd packages/ai && bun run check:types)              # EXIT 0
```

All clean.

## Default / experiment safety (tip vs prior)

Spot-check `f4b85f1f42..8128f5e4d7`:

| Check | Result |
|---|---|
| `deliveryExperiment.readDedupe.enabled` default | `false` (unchanged) |
| `deliveryExperiment.stablePrefixCache.enabled` default | `false` (unchanged) |
| `deliveryExperiment.phaseHandoff.enabled` default | `false` (unchanged) |
| Experiment factors default | `"none"` (unchanged) |
| `unifiedSemaphore` | remains hard `false` in limiter attribution/observation |
| `#37` settings default flips to `true` | none found |
| Production model/effort/concurrency defaults | no flips observed in tip delta |
| `~/.local/bin/omp` replaced | no |
| Paid A/B run | no |

## Evidence flags

```yaml
paired_evidence_ready: false
claimedLiveWin: false
live_cost_claims: none
```

No paired-evidence artifacts discovered on tip under `artifacts/` (nothing invented).

## External still-open (not tip-blocking for mechanism GO)

- Live Hub TUI paint / interactive Needs-me session
- Live computer platforms (wayland / macOS / win / browser) beyond fixture + adapter contracts
- Paid / live A/B and production coverage statistics
- Cross-backend memory migrate (hindsight / mnemopi) end-to-end
- Full rule/prompt deletion thinning pending zero-caller proof

## NO-GO triggers (none hit)

Would have been NO-GO if: tip SHA mismatch; focused suite product fail after natives available; types fail on coding-agent/tui/ai; deliveryExperiment defaults flipped ON; accidental production default flip in tip delta.

None of those occurred after environment remediation (ninja + natives build).
