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
| A5 | Targeted tests, static checks, typecheck, and production build | Pass | 66/66 scoped tests (excluding the separately tracked history-maintenance rollback baseline); `bun check`; `bun run build` |
| A6 | A new logical session clears checkpoint/rewind runtime state | Pass (regression) | `test/agent-session-checkpoint-rewind-branch.test.ts` |
| A7 | Bash retry identity changes after Git HEAD/index/worktree/untracked or hashed invocation state changes and fails open when authority is unavailable | Pass (unit + real CLI) | `test/latency/bash-attempt-ledger.test.ts`; current real CLI state-change smoke |
| A8 | Real CLI read/Bash scenario invalidates evidence after an edit | Pass (provider-backed) | 3 reads + 3 Bash failures; second calls optimized, post-edit calls full/no-advisory; 0 tool error events |
| A9 | Real workflow reaches implementation, verification, and code-review completion with exact child identity evidence | Pass (provider-backed path proof) | optimized `bugfix-null-deref`: pass=true, firstPass=true, fallback=0, scope=adhered, runtime=`gateway/claude-fable-5` |

## What changed

1. **Bash fingerprint noise**: `normalizeBashFailureExcerpt` strips `Wall time: …` noise so repeated `false` (or another exit≠0 differing only by wall time) collides and can emit advisory.
2. **Built-in profiles**: added `luna` / `terra` / `sol` (priority 10, deterministic truncation, summarizer off) and expanded `grok` patterns for gateway ids.
3. **Read dedupe verification**: `SessionManager.getArtifactContent` verifies path-backed and no-session in-memory artifacts; `#verifyReadArtifact` uses content SHA, not path-only evidence.
4. **Session isolation**: `AgentSession.newSession()` again clears checkpoint/rewind runtime state at the committed logical-session boundary.
5. **Authoritative Bash state**: retry receipts cover Git HEAD, staged/unstaged binary diffs, non-ignored untracked file content, and hashed invocation environment/timeout/PTY state. Changed state invalidates prior attempts; missing or racing Git authority records the failure but suppresses identical-failure advice. Git-visible config and dependency-input changes are therefore covered without storing their values.
6. **Live benchmark provenance**: fixed-model profiles now carry strict catalog-family identity. Intentional legacy degraded routing remains available for same-model planner/reviewer runs, but provenance passes only when every required child stage has verified exact identity, selected-profile agreement, and zero fallback/skip ambiguity.

## Explicit non-claims

- No latency arm default flipped to `true`.
- The live optimized workflow is an end-to-end path proof, not a paired quality-gate pass; the report is intentionally inconclusive without a baseline arm.
- No ≥30-pair formal savings claim; the pilot has 6 comparable combined-arm pairs and no context-only ablation.
- `readDedupe` and `bashAdvisory` remain separate, default-off arms; their correctness evidence does not authorize default-on rollout.

## Verification commands

```bash
cd packages/coding-agent
bun test \
  test/agent-session-checkpoint-rewind-branch.test.ts \
  test/session-manager/new-session-boundary.test.ts \
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

The broader 10-file focused command also includes `test/agent-session-history-maintenance-rollback.test.ts`; current result is 67 pass / 1 fail. That fail-closed rollback regression was already recorded before this fix scope and does not exercise `newSession()`, Bash state identity, model-profile activation, or live workflow provenance.

## Single-switch readiness decision

**Ready for a controlled cohort; not ready for default-on.** Enable only the context-optimization arm for ordinary `gateway/gpt-5.6-luna` sessions:

```yaml
modelOptimization.enabled: true
```

Keep every `latency.arms.*` setting `false`. The switch resolves the built-in `luna` profile without an overlay; workflow stages continue to own independent workflow profiles. Start with the live-proven Luna cohort because Terra/Sol/Grok currently have resolver coverage but no equivalent paired live pilot.

Roll forward only while the existing stop rules hold: no attributed P0/P1 escape, completion drop ≤2pp, rework rise ≤10%, cost p50 ≤1.5×, and latency improvement ≥10%. Roll back immediately by setting the single switch to `false` if any stop fires or attribution is unknown.

## Rollback

```yaml
modelOptimization.enabled: false
latency.arms.readDedupe: false
latency.arms.bashAdvisory: false
```
