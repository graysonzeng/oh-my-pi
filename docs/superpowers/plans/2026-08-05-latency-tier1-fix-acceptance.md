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

- All latency arms default `true` as of 2026-08-06 (user decision, live re-verification day); every arm keeps its fail-closed/fail-open guard and the documented rollback path below.
- The live optimized workflow is an end-to-end path proof, not a paired quality-gate pass; the report is intentionally inconclusive without a baseline arm.
- No ≥30-pair formal savings claim; the pilot has 6 comparable combined-arm pairs and no context-only ablation.
- Default-on means "guarded rollout": each arm still requires session-frozen snapshots, quality-stop monitoring, and immediate rollback on stop-rule fire.

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

## All-arms default-on decision (2026-08-06)

**Every latency arm now defaults `true`** (`modelOptimization.enabled` plus all 8 `latency.arms.*`), per user decision, ordered by measured benefit from `docs/long-session-latency-analysis.md` (689 sessions, 306.6h active):

| Order | Arm | Benefit basis | Evidence on HEAD | Guard |
|---|---|---|---|---|
| 0 | `modelOptimization.enabled` | ordinary tool-output truncation (compaction 11.5M tokens / 26 sessions) | live optimized workflow pass + `session-switch.test.ts` | per-profile, default profiles resolve gateway ids |
| 1 | `readDedupe` | read 19117 calls, same-file repeats up to 42×; repeated full payload is pure waste | A8 provider-backed CLI; `read-dedupe-ordinary-session.test.ts` (real AgentSession, 6 scenarios) | fail-open on unknown identity; SHA verify before ref |
| 2 | `bashAdvisory` | bash 6.2h / 5534 calls; E2E reruns ≥8× ≈30m | A7 real CLI state smoke; `bash-attempt-ledger.test.ts` (real git repo + real BashTool) | does not block execution; cancellation not counted |
| 3 | `bashBoundedInjection` | same ledger; bounded context injection on repeat | same suite (`bounded summary` integration) | bounded payload; does not auto-skip |
| 4 | `concurrencyDeclaration` | hub sync waits 21.3h (7% of active) | `concurrency-execution.test.ts`; `engine-work-packages.test.ts` real engine waves | strict schema; unknown field fails closed |
| 5 | `concurrencyExecution` | same; lowering onto existing task/workflow runtimes | same suites | requires declaration arm; serial when <2 ready units |
| 6 | `contextBudgetTuning` | profile threshold tuning on top of context optimization | `session-switch.test.ts` (maxToolCalls 8 / targetUtilization 0.7 vs 10 off) | applied only with an active optimization profile |
| 7 | `roleStaticSplit` | mechanical repair → Flash (repair-stage only) | `model-router-mechanical.test.ts` + `mechanical-class.ts` | never downgrades plan reviewer; malformed class → strong route |
| 8 | `evalGateMigration` | eval gates 3.7h (1.2% of active) | `eval-parity.test.ts` | native only when parity proven; otherwise bridge control |

Rollback (all independently revertible):

```yaml
modelOptimization.enabled: false
latency.arms.readDedupe: false
latency.arms.contextBudgetTuning: false
latency.arms.roleStaticSplit: false
latency.arms.bashAdvisory: false
latency.arms.bashBoundedInjection: false
latency.arms.concurrencyDeclaration: false
latency.arms.concurrencyExecution: false
latency.arms.evalGateMigration: false
```

Stop rules unchanged: no attributed P0/P1 escape, completion drop ≤2pp, rework rise ≤10%, cost p50 ≤1.5×, latency improvement ≥10%.

## 2026-08-07 amendment (2): default-on set restored with the quality-stop data plane wired

Review `docs/superpowers/plans/2026-08-07-latency-all-arms-default-on-code-review.md` found the
2026-08-06 all-arms default-on failed the rollout-quality gate: most arms lacked paired ≥30-task
evidence, the all-arm combination was neither registered nor persisted, and the quality stop had
no production callsite. Amendment (1) restored evidence-based defaults (bash pair only).

This amendment wires the missing production guardrails and re-enables the **high-benefit
ordinary-session pair** by default. The paired task matrices remain the standing evidence
requirement for the remaining behavior-changing arms:

| Arm | Default (now) | Guardrail / gate to re-enable |
|---|---|---|
| `modelOptimization.enabled` | `true` | wired quality stop (cohort + fired-arm attribution + session-end consumer) |
| `latency.arms.readDedupe` | `true` | same wired quality stop; requires model optimization active |
| `latency.arms.contextBudgetTuning` | `false` | long-session pairs |
| `latency.arms.roleStaticSplit` | `false` | false-positive + repair-quality pairs |
| `latency.arms.bashAdvisory` | `true` | low-risk, never blocks (A7/A8) |
| `latency.arms.bashBoundedInjection` | `true` | low-risk, bounded (A7/A8) |
| `latency.arms.concurrencyDeclaration` | `false` | compatibility/live DAG coverage |
| `latency.arms.concurrencyExecution` | `false` | independent/dependent/cancel-resume quality pairs |
| `latency.arms.evalGateMigration` | `false` | real native cutover + parity/cancel-resume proof |

**Quality-stop data plane added** (this commit):

- **Cohort store** (`latency/rollout-cohort.ts`): every workflow terminal appends a
  `latency_rollout_observation` (key = single arm / registered combination / `baseline`) to the
  durable JSONL at `~/.omp/workflow-artifacts/latency-rollout-cohort.jsonl`. The stop evaluator
  now receives real cohort aggregates — completion drop, rework rise, cost P50/P95 multiples,
  latency improvement, spawned-agent P95 — once both the treatment cohort and the no-arm
  baseline accumulate ≥8 samples (below that only P0/P1 and attribution rules act).
- **Fired-arm attribution**: sessions record which arms actually engaged (`markLatencyArmFired`;
  read dedupe/context optimization on rewrite, bash advisory/bounded summary on emission, eval
  native control, concurrency declaration/execution and role static split on the workflow
  engine). A stop disables **only fired arms**; a stop with no fired arm fails closed on the
  whole active set. “Enabled but inactive” no longer counts as treatment.
- **Ordinary-session consumer**: `AgentSession` evaluates the stop at teardown (exit kind known)
  against the same cohort aggregates and its own fired arms, and rolls back via the settings
  override.
- **Rollback invalidation**: after a stop override, the frozen snapshot is invalidated so later
  lookups re-read live settings instead of the pre-rollback arm map.

Verification on the amended HEAD: `test/latency` + `test/model-optimization` + `test/session` +
`test/workflow` (spawn-limited environment: the 9 process-spawning integration tests and the
pre-existing fork-header test require a full `bun test` host; all other suites pass); `bun run
check` and `bun run build` pass.
