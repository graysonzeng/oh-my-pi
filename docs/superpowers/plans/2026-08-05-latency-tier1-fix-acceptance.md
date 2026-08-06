# Latency Tier-1 Fix Acceptance

- Date: 2026-08-05
- Package: `packages/coding-agent/`
- Design: `docs/superpowers/plans/2026-08-04-latency-tier1-fix-and-profile-design.md`
- Pilot residual: `docs/superpowers/plans/2026-08-04-latency-tier1-live-pilot-receipt.md`

## Scope delivered

| ID | Acceptance | Status | Evidence |
|---|---|---|---|
| A1 | Two identical bash failures differing only by wall-time share one fingerprint and fire advisory | Pass (unit) | `test/latency/bash-attempt-ledger.test.ts` wall-time case |
| A2 | Ordinary session, opt+profile+readDedupe: second full read → model-visible `context ref` | Pass (integration) | `test/latency/read-dedupe-ordinary-session.test.ts` (sessioned + in-memory) |
| A3 | `gateway/gpt-5.6-luna` / terra / sol / grok gateway ids resolve built-in profiles when enabled | Pass (unit) | `test/model-optimization/profile-resolver.test.ts` gateway production cases |
| A4 | All latency arms remain default-off | Pass | `test/latency/contracts.test.ts` |
| A5 | Targeted tests, static checks, typecheck, and production build | Pass | 68/68 scoped tests across 10 files; `bun check`; `bun run build` |
| A6 | A new logical session clears checkpoint/rewind runtime state | Pass (regression) | `test/agent-session-checkpoint-rewind-branch.test.ts` |
| A7 | Bash retry identity changes after Git HEAD/index/worktree/untracked or hashed invocation state changes and fails open when authority is unavailable | Pass (unit + real CLI) | `test/latency/bash-attempt-ledger.test.ts`; current real CLI state-change smoke |
| A8 | Real CLI read/Bash scenario invalidates evidence after an edit | Pass (provider-backed) | 3 reads + 3 Bash failures; second calls optimized, post-edit calls full/no-advisory; 0 tool error events |
| A9 | Real workflow reaches implementation, verification, and code-review completion with exact child identity evidence | Pass (provider-backed path proof) | optimized `bugfix-null-deref`: pass=true, firstPass=true, fallback=0, scope=adhered, runtime=`gateway/claude-fable-5` |
| A10 | Failed history-prune persistence restores both branch and live context | Pass (regression) | `test/agent-session-history-maintenance-rollback.test.ts`; success-path persistence remains covered by `test/agent-session-prune-persistence.test.ts` |

## What changed

1. **Bash fingerprint noise**: `normalizeBashFailureExcerpt` strips `Wall time: …` noise so repeated `false` (or another exit≠0 differing only by wall time) collides and can emit advisory.
2. **Built-in profiles**: added `luna` / `terra` / `sol` (priority 10, deterministic truncation, summarizer off) and expanded `grok` patterns for gateway ids.
3. **Read dedupe verification**: `SessionManager.getArtifactContent` verifies path-backed and no-session in-memory artifacts; `#verifyReadArtifact` uses content SHA, not path-only evidence.
4. **Session isolation**: `AgentSession.newSession()` again clears checkpoint/rewind runtime state at the committed logical-session boundary.
5. **Authoritative Bash state**: retry receipts cover Git HEAD, staged/unstaged binary diffs, non-ignored untracked file content, and hashed invocation environment/timeout/PTY state. Changed state invalidates prior attempts; missing or racing Git authority records the failure but suppresses identical-failure advice. Git-visible config and dependency-input changes are therefore covered without storing their values.
6. **Live benchmark provenance**: fixed-model profiles now carry strict catalog-family identity. Intentional legacy degraded routing remains available for same-model planner/reviewer runs, but provenance passes only when every required child stage has verified exact identity, selected-profile agreement, and zero fallback/skip ambiguity.
7. **Transactional history pruning**: per-turn pruning retains lightweight references to original tool-result content until the atomic rewrite commits. Persistence failure restores branch and live-agent messages before surfacing the error; success still rewrites exactly once.

## Explicit non-claims

- No `latency.arms.*` setting default flipped to `true`; only `context_optimization` (`modelOptimization.enabled`) is default-on as of 2026-08-06.
- The live optimized workflow is an end-to-end path proof, not a paired quality-gate pass; the report is intentionally inconclusive without a baseline arm.
- No ≥30-pair formal savings claim; the pilot has 6 comparable combined-arm pairs and no context-only ablation.
- `readDedupe` and `bashAdvisory` remain separate, default-off arms; their correctness evidence does not authorize default-on rollout.

## Verification commands

```bash
cd packages/coding-agent
bun test \
  test/agent-session-checkpoint-rewind-branch.test.ts \
  test/session-manager/new-session-boundary.test.ts \
  test/agent-session-history-maintenance-rollback.test.ts \
  test/latency/bash-attempt-ledger.test.ts \
  test/latency/read-dedupe.test.ts \
  test/latency/read-dedupe-ordinary-session.test.ts \
  test/latency/read-identity-production.test.ts \
  test/latency/contracts.test.ts \
  test/model-optimization/profile-resolver.test.ts \
  test/workflow/benchmark/live-runtime.test.ts
bun check
bun run build
bun src/cli.ts workflow-bench --mode live --provider gateway \
  --model claude-fable-5 --case bugfix-null-deref \
  --variant optimized --repetitions 1 \
  --output /tmp/omp-workflow-live-ready-v3-report.json
```

The full 10-file readiness command passes 68/68 tests, including the previously tracked history-maintenance rollback regression.

## 2026-08-06 live re-verification (HEAD 233137ecce)

Re-ran the provider-backed path proof on the current HEAD and fixed one fixture gap found live.

**Passing (optimized variant, real gateway):**

```bash
bun src/cli.ts workflow-bench --mode=live --provider=gateway --model=deepseek-v4-flash \
  --reviewer-provider=gateway --reviewer-model=gpt-5.6-luna \
  --case=bugfix-null-deref --variant=optimized --repetitions=1 \
  --output=/tmp/omp-workflow-live-retry-20260806
```

- `passed=true`, `firstPassed=true`, `fallback=0`, `scope=adhered`
- runtime provenance `runtime_observed gateway/deepseek-v4-flash` via `workflow-status-report:v1`
- `report.json` / `scorecard.json` / `gate.json` written (single-variant gate intentionally inconclusive)

**Fix: live start requests now carry authoritative path constraints.** The workflow start input only passed
`request.case.request` ("Touch only allowed paths" without a list), so the requirements snapshot had
`constraints: null` and a reviewer could fail the plan with a `missing_authority` finding (`PLAN-001`) that
blocked the scope. `buildLiveWorkflowStartInput` now emits `Allowed paths` / `Forbidden paths` as structured
constraints; covered by `test/workflow/benchmark/live-runtime.test.ts` ("carries authoritative allowed and
forbidden paths into the workflow start constraints").

**Known live variance (not a defect):** reviewer models are allowed `web_search` by design
(`READONLY_TOOLS`). A gpt-5.6-luna plan review can spend its whole 600s `maxRuntimeMs` on external Bun
documentation research; the engine aborts it and fails closed with `quality_route_candidates_exhausted`
(live profiles fix `retryPolicy` to zero retries by design). The optimized variant passed on the same reviewer
pairing; the baseline variant remains model-variance-sensitive.

**Static + test closure on HEAD:** `bun run check` passes; the changed-surface test set is green
(agent compaction structure 10, ai codex stream 77, coding-agent latency/model-opt/tools 73, workflow 96,
regression 15, workflow-benchmark 51, post-fix engine 44 — 0 failures).

**Environment prerequisites not available:** `gateway/claude-fable-5` currently returns `503 auth_unavailable`
(no usable Claude auth via this gateway), and `openai-codex` has no active credential, so Codex WS/SSE and
fable-5 live runs cannot execute; their protocol behavior stays covered by mocked tests.

## Single-switch readiness decision (2026-08-06: default-on)

**`context_optimization` is now default-on:** `modelOptimization.enabled` defaults to `true` (flipped 2026-08-06, per user decision, after the live re-verification). Every `latency.arms.*` setting stays `false`.

```yaml
modelOptimization.enabled: true   # default; no overlay needed
latency.arms.readDedupe: false    # still default-off
latency.arms.bashAdvisory: false  # still default-off
```

The switch resolves the built-in `luna` profile without an overlay; workflow stages continue to own independent workflow profiles. Rollout basis remains the live-proven Luna cohort because Terra/Sol/Grok currently have resolver coverage but no equivalent paired live pilot.

Roll forward only while the existing stop rules hold: no attributed P0/P1 escape, completion drop ≤2pp, rework rise ≤10%, cost p50 ≤1.5×, and latency improvement ≥10%. Roll back immediately by setting the single switch to `false` if any stop fires or attribution is unknown.

## Rollback

```yaml
modelOptimization.enabled: false
latency.arms.readDedupe: false
latency.arms.bashAdvisory: false
```
