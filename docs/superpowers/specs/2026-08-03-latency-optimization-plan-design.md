# Design: omp Latency Optimization Plan

- Date: 2026-08-03
- Status: Draft
- design_author: claude-opus-5 (xhigh)
- design_author_identity: LatencyOptimizationPlanDesigner
- planned_reviewer: gpt-5.6-sol xhigh native reviewer agent
- revision_round: 1
- implementation_authorization: design-only (future implementation authorized scope: core items must-implement)
- authorization_source:
  1. "上下文体积的事前管理，普通会话也做 tool-output truncation（不等 compaction 才裁剪，输出进上下文前止血）"
  2. "workflow 门禁链并行化，甚至编排层并行"
  3. "workflow 中每一次都可以尽可能地让主 agent 控制并主动发起并发，主 agent 控制并发边界与合理编排"

## 1. Background & Constraints

### 1.1 Evidence Base

**Historical corpus**: 689 real sessions (from 886 JSONL files), 306.6h active time, decomposed into:

| Pool | Time | % Active | Key Evidence |
|---|---|---|---|
| Model gen | 174.3h | 57% | gpt-5.6-sol 17,205 turns, avg 29s/turn |
| TTFT | 92.0h | 30% | sol avg 16s/turn; ctx<100k 15.6s → ctx≥200k 29.1s → ctx≥350k 51.0s |
| hub wait | 21.3h / 3,559× | 7% | avg 22s; critical sessions avg 1.4m, often 2-3m full-timeout polling |
| bash retry | 6.2h / 5,534× | 2% | E2E scripts 3-5.5m, same failure ≥8 retries ≈ 30m |
| eval gates | 3.7h / 578× | 1.2% | single longest 13.9m (LLM gate in eval) |
| web_search | 3.7h / 285× | 1.2% | avg 47s/call |

Secondary waste: read 19,117 times (same spec read 42 times); compaction triggered at 316-371k tokens (too late); sessions run at 200-300k ctx chronically.

**Quantitative label discipline** (from evidence base #1 and #2):
- [历史事实] = directly from analysis docs or verified current repo capability
- [算术上限] = mathematical upper bound, not a commitment
- [推导] = inference requiring new-session evidence
- [未验证假设] = must be A/B validated
- [拟议验收目标] = proposed acceptance threshold, not already achieved

### 1.2 Current Default Latency Safeguards (verified 2026-08-03)

From `~/.omp/agent/config.yml` and codebase:

1. **Model routing**: `modelRoles.default = gateway/deepseek-v4-flash:max` (low-TTFT primary); `task.agentModelOverrides.scout/task/designer/reviewer` use flash/luna/sol by role; workflow quality routes with role/tier/lineage.
2. **Context management**: `compaction.thresholdPercent = 70`, `compaction.idleEnabled = true` (idle threshold 200k); ContextLedger exact-hash dedupe in workflow; work-package CWL eviction.
3. **Concurrency**: `async.enabled = true`, `task.eager = preferred`, `task.batch = true`; hub wait = event-driven `Promise.race(job/IRC/timeout/abort)`, smart ladder `[5s,10s,30s,60s,300s]`.
4. **Auto-thinking**: per-prompt effort classifier (`packages/coding-agent/src/auto-thinking/classifier.ts`) dynamically clamps effort to model support; online backend uses smol model (default).
5. **Workflow**: tool-output truncation/summarization (`processToolOutputDetailed`), work-package auto-parallelism, CWL eviction—all exist in workflow path only.

**Coverage gap** (from information base §2):
- Ordinary sessions: no tool-output truncation, no read content dedupe (only workflow has ContextLedger).
- Gen pool (174.3h): auto-thinking adjusts effort but never switches model; sol roles still gen 29s + TTFT 16s per turn.
- Verification loops: no failure-cause injection, no mechanized retry discipline.
- eval gates: parent session blocked; single call max 13.9m.

### 1.3 User Core Scope (Must-Implement)

From user instructions (2026-08-03), the following are **mandatory** for future implementation plans:

1. **Context-volume pre-management**: ordinary sessions ALSO get tool-output truncation (not waiting for compaction; stop bleeding at ingestion).
2. **Workflow gate-chain parallelization**, even orchestration-layer parallelism.
3. **Main-agent concurrency control**: in workflow, every step should allow main agent to actively initiate concurrency—main agent controls concurrency boundary and orchestration.

Other directions (role static subdivision, verification-loop mechanization, eval gate migration) are discretionary; implement when reasonable.

### 1.4 Prior Design (Plan B Recap)

Evidence base #2 round 4 recommended **Plan B**: narrow runtime guardrail path with 5 independent features (all default-off, independently rollback-able):
- `promptPolicy`: one-time gated system block for long-session discipline
- `compaction.targetTokens=200k`: session-level earlier threshold
- `asyncWait.smartMaxSeconds=60`: cap empty-wait tail, repeat advisory after 2nd wait
- `bashFailureAdvisory`: safe fingerprint + advisory on repeat failure (fail-open, never hard-block)
- `evalBudget`: 600s wall-clock + 2 calls per session; typed failure on exceed

**Plan B blind spot** (from information base §2.3): all 5 features are "after-the-fact" guardrails—reduce wait/retry/long-tail, but do not change gen time, do not prevent context bloat at source, do not reduce sol-role TTFT. Estimated direct action on ≤10% of historical active time; 87% model pool (gen+TTFT) only indirectly affected via compaction.

### 1.5 Constraints (from evidence base #2 §2.3)

- Reuse existing canonical owners: model-resolver/role-models, workflow engine, task-batch, compaction pure functions, hub Promise.race + auto-delivery, eval bridge, ContextLedger/processToolOutputDetailed truncation seams. No second router/waiter/compactor/cache/verifier engine.
- No dynamic per-turn value-guessing model routing in ordinary sessions (deferred in evidence base #2); static role/tier subdivision within existing seams is allowed.
- No sidecar/parallel compaction of live session.
- bash failure advisory must stay advisory-only (no hard blocking); eval budget fails closed as typed failure; agent() inline/isolation semantics unchanged.
- No double-counting: combination arm reports only S_combined; compaction vs direction-1 TTFT interaction and direction-2 vs auto-thinking gen must be stratified; hub savings exclude child actual runtime.
- Every feature: independent on/off switch, session-start frozen snapshot, per-feature rollback, A/B with same task stratification, quality stop conditions (completion/verifier/independent-review not degrading >2pp, rework/repeat-read not rising >10%).

## 2. Problem Statement & Benefit Quantification

### 2.1 Which Directions Have Biggest Benefit

From information base §4.7 arithmetic upper bounds (not commitments, require A/B validation):

| Direction | Target Pool | Arithmetic Upper Bound | Risk | User Priority |
|---|---|---|---|---|
| 2: Role static subdivision | gen 174.3h + sol TTFT 75.7h | **40-60h** (if 30-40% sol turns route to luna/terra: TTFT 75.7×0.35≈26h + gen conservatively 15%≈20h) | High (quality/lineage) | Discretionary (but highest benefit, deep design warranted) |
| 1: Context-volume pre-management (+ ordinary truncation) | TTFT 92h (all turns) | **10-18h** (if 30% turns migrate from ≥200k bucket to <100k: 92×0.3×(13.5s/29.1s)≈13h) | Low | **Must-implement** |
| 4: Gate-chain parallelization (+ orch-layer) | hub 21.3h | **7-10h** (30-50%串行空等/满时长轮询 can be eliminated; child actual runtime cannot) | Medium | **Must-implement** (main-agent concurrency boundary) |
| 3: Verification-loop mechanization | bash 6.2h + retry waste | **3-6h** (E2E ≥8 retries ≈ 30m/session-level) | Low | Discretionary |
| 5: eval gate migration | eval 3.7h | **2-3h** (parent blocked interval eliminated) | Low | Discretionary |

**Non-additive disclaimer**: same-turn TTFT may be affected by both direction 1 and 2; use stratified/factorial arms to report interaction term. Hub savings exclude child actual runtime. Combination arms report only `S_combined` vs same control.

**Benefit order**: Direction 2 (40-60h) > Direction 1 (10-18h) > Direction 4 (7-10h) > Direction 3 (3-6h) > Direction 5 (2-3h). User-mandated core scope (1, 4) covers "low-risk, mechanistic" high-benefit items; highest-benefit direction 2 is discretionary—this design recommends: deep-design direction 2 as **priority follow-up** (§4.d implementation design), progressing in parallel with must-do items 1 and 4; directions 3 and 5 have low implementation cost and can be bundled.

## 3. Option Comparison & Selection

### 3.1 Three-Option Recap (from Evidence Base #2)

- **Plan A** (Config/discipline): only tune existing settings, no new long-session runtime behavior. Minimal code invasion, but model discipline cannot be guaranteed; indirect levers on gen/TTFT pools.
- **Plan B** (Narrow runtime guardrail): Plan A + 5 independent fail-open/typed-failure features (promptPolicy, compaction target, wait cap, bash advisory, eval budget). Direct control of confirmed waste (empty-wait, same-failure retry, eval long-tail, late compaction), but all "after-the-fact"—do not change gen time or prevent context bloat at source.
- **Plan C** (Aggressive orchestration + dynamic per-turn routing + external-call optimization): includes dynamic single-turn value-guessing model routing for ordinary primary sessions, async eval agent(), search caching. Highest potential ceiling, but breaks "no dynamic per-turn routing in ordinary sessions" constraint; requires new router/cache engine; quality/lineage/freshness risks.

### 3.2 Selection: Plan B + Five Directions (Modular Expansion)

**Recommended approach**: retain Plan B's 5 features as low-risk first-round arms; add 5 implementation modules (directions 1-5) that address Plan B's blind spots—primarily context-volume pre-management (direction 1, must-do) and gate-chain parallelization (direction 4, must-do). Directions 2/3/5 are discretionary but direction 2 (role subdivision, highest benefit) warrants deep file-level design even as discretionary.

**Rationale**:
- Plan B alone acts on ≤10% of historical active time; does not touch gen pool or prevent context bloat.
- Direction 1 (context pre-management) is mechanistic, low-risk, affects all turns (including sol roles), user-mandated.
- Direction 4 (gate-chain parallel + orch-layer + main-agent concurrency boundary) is user-mandated; directly reduces parent blocked interval in hub pool.
- Direction 2 (role static subdivision) has highest arithmetic upper bound (40-60h) but quality/lineage risk; design to file-level even though discretionary, as priority follow-up.
- All directions reuse existing canonical owners; no second engine.


## 4. Detailed Design (File/Module-Level)

### 4.a Direction 1: Context-Volume Pre-Management (Must-Implement)

**Sub-items**:
1. Read content dedupe/fingerprint for ordinary sessions
2. Conclusion transmission via memory-bank / '/Users/sheng/.omp/agent/sessions/-tencent-oh-my-pi/2026-08-03T14-23-16-193Z_019fc801-e8e1-7000-9c22-2f5a05f1c21c/local' artifacts
3. **Ordinary-session tool-output truncation** (user-specified core item)

**Design rationale**: [历史事实] TTFT scales with context (<50k 8.1s → 100-150k 19.6s → 200-300k 28-29s → ≥350k 51s), affecting **all models all turns**; [历史事实] same spec read 42 times, same source file 29 times; [当前能力事实] ordinary sessions have no read content dedupe (only workflow has ContextLedger exact-hash); workflow has tool-output truncation/summarization (`processToolOutputDetailed`, per-model `ToolStrategy`, CWL eviction) but ordinary sessions do not. Compaction is reactive (blocking, rewrites history, has cost); pre-management is proactive—stop bloat at source.

**Implementation design (file-level)**:

| File/Module | Change | Explicitly NOT Doing |
|---|---|---|
| `packages/coding-agent/src/tools/read.ts` | Maintain session-scoped `sha256(path + content)` fingerprint + LRU; when content unchanged, return compact marker "already in context (read #N, M tokens)" without re-injecting full text; invalidate on file change or explicit `fresh` request | No cache of file content across sessions; no fingerprint of user secrets |
| `packages/coding-agent/src/session/tool-output-processor.ts` (new or extract from workflow) | Extract workflow's `processToolOutputDetailed` equivalent as shared utility; ordinary sessions apply token-budget truncation to tool result before ingestion; truncated portion retained at `artifact://` recoverable address with `[truncated: X/Y tokens]` marker; recovery semantics match workflow existing impl (not building second truncator) | Not creating new truncation engine; byte-equivalent reuse of workflow implementation |
| `packages/coding-agent/src/context/context-ledger.ts` (or extend) | Extend ContextLedger exact-hash dedupe seam (currently workflow-only) to ordinary sessions; track content hash + turn number + token count | Not reimplementing dedupe logic; reuse workflow ContextLedger seam |
| `packages/coding-agent/src/config/settings-schema.ts` | Add `performance.contextVolume.*` strict schema (default off): `readDedupe.enabled`, `truncation.enabled`, `truncation.maxTokens`, `artifactRecovery.enabled`; range and mutual-exclusion validation | Not hardcoding model names, pricing, or provider ranks in general defaults |
| `packages/coding-agent/src/session/session-manager.ts` | Record dedupe hit/miss, injection token delta, truncation events into existing session/artifact paths via `appendCustomEntry("omp.contextVolume.event.v1", …)` | Not creating parallel metrics store |

**Control flow**:
1. Session start: load settings, validate `performance.contextVolume` schema, freeze feature snapshot (§1.3 frozen snapshot contract).
2. On tool result (read/bash/etc): if `truncation.enabled`, apply token-budget truncation before ingestion; retain full output at `artifact://`.
3. On read specifically: if `readDedupe.enabled`, check session-scoped fingerprint LRU; return compact marker if content unchanged.
4. Record: dedupe hit/miss, tokens injected/truncated, artifact recovery addresses into existing session event stream.

**Config contract** (defaults off):
```yaml
performance:
  contextVolume:
    readDedupe:
      enabled: false
      lruSize: 100
    truncation:
      enabled: false
      maxTokens: 4000
    artifactRecovery:
      enabled: true
```

**Failure paths**: fingerprint miss-match (actual content changed but cache hit) → need content hash + explicit invalidation on file write/mutation signals. Truncation too aggressive → same quality gates as workflow (completion/verifier/review not degrading >2pp).

**Rollback**: disable `readDedupe.enabled` and/or `truncation.enabled` independently; session snapshot does not change mid-session; resume uses frozen snapshot.

**Acceptance evidence** (new-session A/B):
- [拟议验收目标] Same-task control/treatment: average per-turn injection tokens decrease, ctx≥200k turn ratio decrease, repeat-read count decrease, TTFT P50/P95 in affected turns decrease ≥10%, rework/omission not rising >10%.

**Implementation steps**:
1. Extract shared truncation function (byte-equivalent reuse of workflow `processToolOutputDetailed`)
2. Read fingerprint dedupe seam
3. Ordinary-session assembly (tool-output-processor → read → session-manager)
4. Receipt + focused contract tests (fingerprint hit/miss/invalidation, truncation→artifact recovery, injection token delta)
5. A/B arm (stratified by context-window bucket)

### 4.b Direction 4: Gate-Chain Parallelization + Orchestration-Layer Concurrency (Must-Implement)

**User-specified core**: workflow gate-chain parallelization, even orchestration-layer parallelism; workflow every step allow main agent to actively initiate concurrency—**main agent controls concurrency boundary and orchestration**.

**Design rationale**: [历史事实] hub 21.3h/3,559 calls, critical sessions 103 calls avg 1.4m, often 2-3m full-timeout polling; [当前能力事实] hub already event-driven + auto-delivery, work-package auto-parallelism landed. Current bottleneck: plan_review / code_review single-reviewer serial chain—multiple independent reviewers can run in parallel (real independent slice, use existing task batch), combine with `await:true` event-driven to replace full-timeout polling. Eliminates "serial chain empty-wait", not child actual runtime (no double-counting with child runtime).

**Concurrency boundary** (user requirement): maxConcurrent, dependency order, isolation scope explicitly controlled by main agent / orchestration layer, not implicit guessing.

**Implementation design (file-level)**:

| File/Module | Change | Explicitly NOT Doing |
|---|---|---|
| `packages/coding-agent/src/workflow/engine.ts` | plan_review / code_review stages support N independent reviewers **in parallel**; convergence point aggregates verdicts; finding merge/dedupe (reuse advisor dedupe mode); gate result semantically equivalent to serial | Not creating second workflow engine |
| `packages/coding-agent/src/task/task-batch.ts` | Orchestration-layer concurrency boundary—maxConcurrent, dependency graph, isolation scope **explicitly declared by main agent** (concurrency group, count, rendezvous point), engine executes; no implicit parallelism guessing | Not inferring concurrency from task descriptions; main agent declares |
| `packages/coding-agent/src/tools/hub/index.ts` | `await:true` event-driven (already exists) replaces full-timeout polling: wait only blocks when job incomplete; completion returns immediately | Not creating new event bus or polling protocol; reuse existing Promise.race |
| `packages/coding-agent/src/workflow/finding-aggregator.ts` (new or extend) | Parallel reviewer findings merge/dedupe (can reference advisor's existing dedupe seam `packages/coding-agent/src/advisor/`); conflict resolution policy | Not creating third dedupe engine; reuse advisor patterns |
| `packages/coding-agent/src/config/settings-schema.ts` | Add `performance.orchestration.*` (default off): `parallelReview.enabled`, `parallelReview.maxConcurrent`, `concurrencyDeclaration` contract | Not hardcoding which reviews can parallelize; declaration-based |

**Control flow**:
1. Workflow gate (e.g., design_review): main agent declares concurrency group (e.g., "independent reviewers: designer-A, designer-B, max 2 concurrent").
2. Orchestration layer (task-batch / workflow engine): spawn N reviewer subagents in parallel (existing task batch mechanism).
3. Each reviewer produces independent verdict + findings; parent `hub wait` with `await:true` (event-driven, no polling).
4. Convergence point: aggregate verdicts (all-pass / any-block), merge/dedupe findings (reuse advisor dedupe).
5. Gate result semantically equivalent to serial chain: if any reviewer blocks, gate blocks.

**Config contract** (defaults off):
```yaml
performance:
  orchestration:
    parallelReview:
      enabled: false
      maxConcurrent: 3
    concurrencyDeclaration:
      requireExplicit: true
```

**Failure paths**: parallel review findings conflict/duplicate → engine-side dedupe (reference advisor dedupe mode). Review semantics must remain equivalent to serial.

**Rollback**: disable `parallelReview.enabled`; workflow reverts to serial single-reviewer chain.

**Acceptance evidence** (new-session A/B):
- [拟议验收目标] Parent session blocked interval decrease, gate-chain critical path shortens, finding quality and independence equivalent to serial (verdict consistency, dedupe rate).

**Implementation steps**:
1. Gate concurrency primitive (explicit concurrency-group declaration by main agent)
2. Reviewer parallel spawn + finding aggregation/dedupe (reuse advisor dedupe seam)
3. Work-package / independent-slice parallelism (already exists; ensure orchestration layer respects main-agent declaration)
4. Receipt + focused contract tests (parallel reviewers semantically equivalent to serial, finding dedupe, blocked interval measurement)
5. A/B arm (parent blocked interval via non-overlap ledger)

### 4.c Direction 3: Verification-Loop Mechanization (Discretionary)

**Design rationale**: [历史事实] E2E same-command retry ≥8 times ≈ 30m; bash pool 6.2h; [历史事实] long-tail pattern "Running critical E2E" → "Rerunning critical E2E" → "Verifying…" same command repeated. Plan B's advisory too weak (model can ignore); mechanized approach: **failure-cause injection**—bash failure automatically appends sanitized failure-output summary (truncated, secrets removed) to next invocation of same command, so model sees reason before deciding retry; configure verification command stratification (targeted first → full suite).

**Implementation design (file-level)**:

| File/Module | Change | Explicitly NOT Doing |
|---|---|---|
| `packages/coding-agent/src/tools/bash.ts` | On structured failure result from executor, generate safe fingerprint (irreversible digest, no secrets) from: normalized command + cwd + exit status + timedOut + controlled error excerpt | Not hard-blocking; advisory only |
| `packages/coding-agent/src/exec/bash-executor.ts` | Return structured failure metadata (`isError`, `exitCode`, `timedOut`, artifact) unchanged; caller (bash tool) generates fingerprint | Not swallowing `isError` or replacing existing `ToolCallLoopGuard` |
| `packages/coding-agent/src/session/stream-guards.ts` (or new) | On repeat same-fingerprint call: auto-inject failure-cause summary (≤ fixed token budget) into tool context; if exceeds budget, degrade to advisory-only | Not injecting unbounded context; token budget enforced |
| `packages/coding-agent/src/config/settings-schema.ts` | Add `performance.bashRetry.*` (default off): `failureCauseInjection.enabled`, `maxTokens`, `fingerprintTTL` | Not hardcoding command patterns |

**Control flow**:
1. Bash execution fails → structured result with `isError`, `exitCode`, `timedOut`, artifact.
2. Generate safe fingerprint: `sha256(normalized_command + cwd + exit_status + timedOut + sanitized_error_excerpt)`.
3. First failure: return as-is; record fingerprint + failure summary (sanitized, ≤ token budget).
4. Repeat same-fingerprint call: auto-inject prior failure summary into tool context (≤ token budget); if exceeds, degrade to advisory marker only.
5. Fingerprint changes (command/cwd/input mutated or explicit reason given) → new fingerprint, fresh failure tracking.

**Failure paths**: fingerprint collision (different commands same hash) → use cryptographic hash + sufficient entropy (command+cwd+status). Summary injection increases context → enforce ≤ fixed token budget (e.g., 500 tokens); exceed → advisory-only fallback.

**Rollback**: disable `failureCauseInjection.enabled`; revert to original executor + existing `ToolCallLoopGuard`.

**Acceptance evidence**:
- [拟议验收目标] Same-fingerprint retry count decrease, failure total duration decrease, legitimate retry (environment fix) zero false suppression, context increment within budget.

### 4.d Direction 2: Role Static Subdivision (Discretionary, Highest Benefit, Deep Design)

**Design rationale**: [历史事实] sol 17,205 turns gen 136.9h (avg 29s) + TTFT 75.7h (avg 16s); [当前能力事实] `slow`/designer/reviewer roles blanket-use sol; FindingTracker already has reasoning/mechanical repair fork seam; `workflow.qualityRoutes.<tier>.<role>` already ordered profile lists. **No dynamic per-turn value-guessing routing** (constraint from evidence base #2); within existing role/tier seam, statically subdivide—mechanical repairs, format/consistency reviews route to luna/terra (TTFT ~4s), deep architectural reviews route to sol. Auto-thinking already adjusts per-turn effort but never switches model; static role subdivision is the only remaining seam within doc constraints that can still save sol TTFT.

**Risk**: low-difficulty task mis-sent to low-tier model causes quality regression → explicit task class / severity fork + independent review hard-stop; same-turn TTFT benefit not double-counted with direction 1 (stratified arm).

**Implementation design (file-level)**:

| File/Module | Change | Explicitly NOT Doing |
|---|---|---|
| `packages/coding-agent/src/session/role-models.ts` | Role/tier internal static subdivision—by explicit task class / finding severity select model tier (mechanical/format → luna/terra, deep reasoning → sol) | Not introducing per-turn value-guessing dynamic routing |
| `packages/coding-agent/src/config/model-resolver.ts` | Extend role resolution to consume task class / severity metadata; static mapping (no LLM self-guessing) | Not inferring task difficulty from prompt text; explicit classification |
| `packages/coding-agent/src/workflow/finding-tracker.ts` (or equivalent) | Extend existing reasoning/mechanical repair fork to review severity fork (P0/P1 → sol, P2/P3 mechanical → fast model) | Not creating second finding engine |
| `packages/coding-agent/src/config/settings-schema.ts` | Extend `workflow.qualityRoutes.<tier>.<role>` to support sub-roles (e.g., `reviewer.mechanical` / `reviewer.deep`) or explicit class-based fork; static declaration not LLM guess | Not relying on LLM self-classification |
| `packages/coding-agent/src/workflow/quality-route-snapshot.ts` | Route snapshot includes task class / severity → model mapping; frozen at session start; resume uses frozen snapshot | Not allowing mid-session route drift |

**Key invariants**: reviewer vs implementer different lineage; provider attestation; effort support verified by catalog; any fork change enters routing audit.

**Control flow**:
1. Task classification: explicit task class (mechanical repair / format check / deep architecture) or finding severity (P0/P1/P2/P3) determined at workflow stage entry (not per-turn guessing).
2. Role resolution: `role-models.ts` consumes class/severity, selects model tier via static mapping.
3. Provider attestation: catalog verifies strict identity + lineage + effort support; if cannot prove independence, fail closed.
4. Route receipt: record configured/local-resolved/provider-attested identity into existing routing audit path.

**Config contract** (defaults off; example):
```yaml
workflow:
  qualityRoutes:
    high:
      reviewer:
        deep: gateway/gpt-5.6-sol:xhigh
        mechanical: gateway/gpt-5.6-luna:max
      implementer: gateway/gpt-5.6-luna:max
```

Or extend existing `modelRoles`:
```yaml
modelRoles:
  reviewer.deep: gateway/gpt-5.6-sol:xhigh
  reviewer.mechanical: gateway/gpt-5.6-luna:max
```

**Failure paths**: low-difficulty mis-sent to low-tier → independent review hard-stop (if review pass rate degrades >2pp, disable fork); lineage independence not provable → fail closed (use fallback or reject).

**Rollback**: disable role subdivision; revert to blanket sol for all reviewer calls; static config change only, no code rollback.

**Acceptance evidence** (new-session A/B, stratified with direction 1 + auto-thinking):
- [拟议验收目标] Sol turn ratio decrease, TTFT/gen P50/P95 decrease, review pass rate and completion rate not degrade >2pp.

**Implementation steps**:
1. Define explicit task class / severity taxonomy (mechanical/format/deep; P0-P3 severity levels)
2. Extend role route to consume class/severity; static mapping (no LLM inference)
3. Provider attestation + lineage independence verification (use existing catalog + audit seam)
4. Receipt + focused contract tests (route snapshot immutability, lineage proof, class-fork correctness)
5. A/B arm (stratified with auto-thinking gen effect, do not double-count)

### 4.e Direction 5: Eval Gate Migration (Discretionary)

**Design rationale**: [历史事实] eval 3.7h/578 calls, Aegis session 2.51h/22 calls avg 6.8m, single longest 13.9m; [当前能力事实] bridge invocation uses `withBridgeTimeoutPause` to suspend cell timeout during LLM call, parent session fully blocked.异模型 gates should migrate to native task/workflow background jobs (parent not blocked, explicit artifact/identity receipt convergence); Plan C has full async design, but the discipline "gates use workflow not eval" and routing can proceed independently, zero risk.

**Implementation design (file-level)**:

| File/Module | Change | Explicitly NOT Doing |
|---|---|---|
| `packages/coding-agent/src/workflow/gate-runner.ts` (or extend engine) |异模型 gates spawn as native workflow background jobs (task/subagent via existing hub job mechanism); parent session continues; convergence via artifact/identity receipt | Not making `agent()` async; inline/isolation merge semantics unchanged |
| `packages/coding-agent/src/eval/agent-bridge.ts` | For gates migrated to workflow, bridge not invoked; bridge usage limited to legitimate computational eval cells (not LLM gates) | Not removing eval bridge entirely; preserving legitimate eval cell contract |
| `packages/coding-agent/src/tools/eval.ts` | Tool-level discipline: detect LLM gate pattern (异模型 review / design approval), recommend workflow path; if user insists eval, preserve existing bridge path | Not hard-blocking eval bridge; advisory + preferred path |

**Control flow**:
1. Workflow gate stage (e.g., design_review): instead of `eval { agent(reviewer_spec) }`, spawn native task/subagent via hub.
2. Parent session continues other work (or waits with `await:true` event-driven, no blocking).
3. Subagent completes → artifact + identity receipt → convergence point aggregates verdict.
4. Gate semantics (pass/block) equivalent to bridge path; receipt includes provider-attested identity + lineage.

**Failure paths**: native workflow vs eval bridge verdict semantics differ → require receipt equivalence validation (rejection rate / pass rate consistency).

**Rollback**: revert gates to eval bridge path; no model-resolver or workflow engine change required.

**Acceptance evidence**:
- [拟议验收目标] Parent session eval blocked interval eliminated, gate quality (rejection rate / pass rate) consistent with bridge path, `agent()` inline/isolation semantics unchanged.

**Implementation steps**:
1. Identify LLM gate patterns in current eval usage (异模型 review / design approval)
2. Migrate to native task/subagent spawn (reuse hub job mechanism)
3. Convergence via artifact/identity receipt (existing workflow seam)
4. Receipt + focused contract tests (verdict equivalence, blocked interval elimination, lineage proof)
5. A/B arm (eval blocked interval vs same control)


## 5. Implementation Order & A/B Plan

### 5.1 Four-Phase Landing (from Evidence Base #2 §5.1)

Reuse evidence base #2's four-layer approach for all features:

1. **Observe control** (Phase 0): establish new-session baseline with current config; verify receipt/attestation/identity via live probe; compute control P50/P95, normalized active hours, context buckets, quality gates.
2. **Config arm** (Phase 1): tune existing settings (compaction threshold, wait ladder, role overrides) as independent arms; no new runtime behavior.
3. **Narrow guardrail** (Phase 2): enable one feature at a time from Plan B (promptPolicy, compaction target, wait cap, bash advisory, eval budget) + directions 1/3/4/5; each feature independent arm vs same control.
4. **Combination & push** (Phase 3): combine safe arms, run combination vs control (report `S_combined` only), meet acceptance threshold → graduate to default-on.

### 5.2 Feature Prioritization (Must-Implement First)

**Must-implement items** (user core scope, §1.3):
1. **Direction 1.c: Ordinary-session tool-output truncation** (context pre-management core)
2. **Direction 1.a: Read content dedupe** (context pre-management supporting mechanism)
3. **Direction 4.a: Gate-chain parallelization** (parallel independent reviewers)
4. **Direction 4.b: Orchestration-layer concurrency** (main-agent explicit concurrency boundary)

**Discretionary items** (implement when reasonable):
- Direction 2 (role static subdivision): highest benefit (40-60h arithmetic upper bound), but quality/lineage risk; deep design provided (§4.d), implement after must-do items stable.
- Direction 3 (verification-loop mechanization): low risk, medium benefit (3-6h); can bundle with Phase 2.
- Direction 5 (eval gate migration): low risk, low cost; can bundle with Phase 2.
- Plan B features (promptPolicy, compaction target, wait cap, bash advisory, eval budget): retain as Phase 2 low-risk arms.

**Recommended implementation order**:
1. **Phase 0** (control baseline): new-session baseline with current config; verify receipt/attestation; compute P50/P95, context buckets, quality metrics.
2. **Phase 1** (config arms): existing settings tuning (role overrides, compaction threshold) as independent arms.
3. **Phase 2a** (must-do mechanistic, low-risk first):
   - Direction 1.a: read dedupe (reuse ContextLedger seam)
   - Direction 1.c: ordinary-session truncation (reuse workflow `processToolOutputDetailed`)
   - Direction 3: verification-loop mechanization (failure-cause injection)
   - Direction 5: eval gate migration (discipline + routing, no engine change)
4. **Phase 2b** (must-do orchestration):
   - Direction 4.a: gate-chain parallelization (parallel reviewers + finding dedupe)
   - Direction 4.b: orchestration-layer concurrency (main-agent explicit declaration)
5. **Phase 2c** (discretionary high-benefit, after stabilization):
   - Direction 2: role static subdivision (task class/severity fork, lineage proof)
6. **Phase 3** (combination): combine safe Phase 2 arms, run combination vs control, report `S_combined`.

### 5.3 Per-Feature A/B Arms

Each feature is independent arm vs same control; combination reports `S_combined` only (no additive claiming).

| Feature | Arm Name | Independent Variables | Stratification | Marginal Delta Metric |
|---|---|---|---|---|
| Direction 1.a (read dedupe) | `read_dedupe` | `readDedupe.enabled` | context window bucket, file-change rate | dedupe hit rate, injection token delta, repeat-read count |
| Direction 1.c (ordinary truncation) | `ordinary_truncation` | `truncation.enabled`, `maxTokens` | tool type, output size distribution | injection token delta, artifact recovery rate, rework ratio |
| Direction 2 (role subdivision) | `role_subdivision` | task class fork, severity fork | task class, finding severity, model tier | sol turn ratio, TTFT/gen P50/P95, review pass rate |
| Direction 3 (verification mechanization) | `failure_injection` | `failureCauseInjection.enabled` | command type, failure pattern | same-fingerprint retry count, failure duration, legitimate retry rate |
| Direction 4.a (gate parallel) | `gate_parallel` | `parallelReview.enabled`, `maxConcurrent` | gate type, reviewer count | parent blocked interval, gate critical path, finding dedupe rate |
| Direction 4.b (orch-layer concurrency) | `orch_concurrency` | `concurrencyDeclaration.requireExplicit` | work-package type, dependency depth | parent blocked interval, concurrency utilization, convergence latency |
| Direction 5 (eval gate migration) | `eval_migration` | gate pattern (LLM vs computational) | gate type, subagent model | eval blocked interval, verdict consistency, `agent()` semantics |
| Plan B promptPolicy | `prompt_policy` | `promptPolicy.enabled` | prompt token delta | discipline compliance rate, TTFT delta vs prompt cost |
| Plan B compaction target | `compaction_target` | `targetTokens=200k` | context window, session length | compaction trigger point, ctx≥200k turn ratio, TTFT bucket shift |
| Plan B wait cap | `wait_cap` | `smartMaxSeconds=60`, `repeatAdvisoryAfter=2` | hub call pattern, job duration | timeout ratio, repeat-wait count, parent wait interval |
| Plan B bash advisory | `bash_advisory` | `bashFailureAdvisory.enabled` | command type, failure pattern | repeat-failure count, advisory compliance rate |
| Plan B eval budget | `eval_budget` | `wallClockSeconds=600`, `callsPerSession=2` | eval pattern, bridge call count | eval blocked interval, budget-exceed rate, typed failure rate |
| **Combination** | `combined` | all safe features enabled | same control task stratification | **S_combined = T_control - T_all_treatment** |

### 5.4 Non-Overlap Interval Ledger (from Evidence Base #2 §5.3.4)

**Critical-path accounting**: event区间并集 (gen + TTFT + tool execution non-overlapping intervals) is the true active time; do not double-count.

- **Tool execution interval**: `tool_execution_start.startedAt` → `toolResult.timestamp`
- **Model generation interval**: prior event timestamp → `assistant.duration` (gen) + `assistant.ttft` (TTFT)
- **Hub wait interval**: parent blocked time (excluding child actual runtime, which is already in child's tool execution interval)
- **Compaction vs direction-1 TTFT interaction**: if compaction changes context bucket, and direction-1 also affects same-turn TTFT, use stratified/factorial arm to report interaction term; do not claim both savings additively.
- **Direction-2 vs auto-thinking gen**: auto-thinking adjusts effort, direction-2 switches model; stratify by model tier, report marginal delta of model switch holding effort constant.

**Ledger implementation** (from evidence base #2 §4.2.2 step 8):
- `SessionManager.appendCustomEntry("omp.longSession.performanceEvent.v1", { type: "started"|"finished", feature, timestamp, metadata })` appends started/finished event pairs (not in LLM context).
- Offline ledger consumer: after session end, scan active branch for event pairs, reconcile into non-overlap critical-path ledger, compute per-feature marginal delta.
- Branch-aware: resume from active branch; rewind/fork does not pollute event stream.

### 5.5 Combination Arm & S_combined Reporting

**No additive claiming**: individual feature marginal deltas (e.g., `S_compaction`, `S_wait`, `S_bash`) are relative to same control, only for understanding per-feature contribution. Combination arm is the true result:

- `S_combined = T_control - T_all_treatment` (control vs all-features-enabled treatment, same task stratification)
- Report P50/P95 active critical-path per session, per 100 turns, normalized active hours per 100 sessions.
- Do not sum individual feature deltas; overlapping effects resolved by combination measurement.

**Acceptance threshold** (from §1.2, evidence base #2 §1.2): combination arm must meet:
- P50 active time per session decrease ≥10%
- P95 active time per session decrease ≥15%
- Normalized active hours per 100 completed sessions decrease ≥10%
- Completion rate, verifier pass rate, independent review pass rate not degrade >2pp
- Rework, repeat-read not rise >10%
- Model lineage independence preserved (strict provider attestation)

## 6. Verification Plan & Quality Stop Conditions

### 6.1 Focused Contract Tests (Per-Feature)

Before A/B, each feature must pass focused contract tests:

| Feature | Contract Test Coverage |
|---|---|
| Direction 1.a | Read fingerprint hit/miss/invalidation; file mutation detection; LRU eviction; injection token delta |
| Direction 1.c | Tool-output truncation to token budget; artifact recovery from `artifact://`; truncation marker correctness; semantically equivalent to workflow truncation |
| Direction 2 | Role/tier fork by task class/severity; static mapping correctness; lineage independence proof; provider attestation; low-difficulty mis-send detection |
| Direction 3 | Bash fingerprint stability (same command → same hash); failure summary sanitization (no secrets); legitimate retry zero false suppression; context budget enforcement |
| Direction 4.a | Parallel reviewers spawn correctly; finding aggregation/dedupe equivalent to serial; verdict semantics match serial chain; parent blocked interval measurement |
| Direction 4.b | Main-agent concurrency declaration parsing; orchestration respects maxConcurrent/dependency/isolation; convergence point correctness; rendezvous semantics |
| Direction 5 | Native workflow gate spawn; artifact/identity receipt convergence; verdict equivalence to eval bridge; `agent()` inline/isolation unchanged |
| Plan B compaction | Target token calculation respects context window - reserve; fallback on mismatch; compaction trigger recording; no live-session consistency break |
| Plan B wait cap | `smartMaxSeconds` cap on empty-wait only (job completion still immediate); repeat advisory after Nth wait; pending ≠ success; auto-delivery unchanged |
| Plan B bash advisory | Safe fingerprint generation (no secrets); advisory metadata attachment; execution not blocked; original `isError`/`exitCode`/artifact preserved |
| Plan B eval budget | Started event durable write before invocation; `usedCalls` single source from event stream; branch-aware receiver; budget-exceed → typed failure; inline/isolation unchanged |
| Plan B promptPolicy | Gated system block injection (one-time); 4 static tool prompts unchanged (byte-level); off → control-equivalent; prompt token delta recording |

### 6.2 Quality Stop Conditions (from Evidence Base #2 §6.4)

Any feature triggering any stop condition is immediately disabled:

1. **Completion rate**: treatment vs control completion rate decrease >2 percentage points.
2. **Independent review**: treatment independent-review pass rate decrease >2pp (异模型 verifier/reviewer).
3. **Deterministic verifier**: treatment verifier pass rate (type-check, lint, build, test, smoke) decrease >2pp.
4. **Rework rate**: treatment rework/repair cycle increase >10%.
5. **Repeat-read**: treatment repeat-read count (same file/spec) increase >10%.
6. **Lineage independence**: any reviewer/author or implementer/reviewer model lineage independence break (same provider family, cannot prove independent training). Use model lineage proof, not transport provider string.
7. **False success**: any typed failure (eval budget exceed, bash timeout, compaction fallback) incorrectly reported as success; any `isError=true` swallowed or verdict forged.
8. **Quality regression**: final acceptance rate (human/steering/CI gate) decrease >2pp; blocking findings (P0/P1) increase >10%.

Stop condition triggers:
- Immediate: disable offending feature (independent rollback).
- Post-mortem: root-cause analysis via receipt/artifact/session replay.
- Re-enable: only after contract test additions confirm fix; new pilot arm required.

### 6.3 Historical Corpus Recomputation (Baseline Validation)

Use evidence base #1 methodology (`docs/long-session-latency-analysis.md`) to recompute baseline:

1. **Parse**: 886 JSONL → 689 real sessions; exclude `-tmp-*`, `-.claude*`, `*-fixture`.
2. **Event timeline**: `tool_execution_start`, `toolResult`, `assistant` message with `duration`/`ttft`/`contextSnapshot`.
3. **Interval union**: gen + TTFT + tool execution non-overlapping intervals = active time; wall-clock includes user idle/overnight.
4. **Pool decomposition**: model gen/TTFT by model/context-bucket; hub by intent pattern; bash by command type/failure pattern; eval by gate type; web_search by call count.
5. **Unit discipline**: characters vs bytes vs tokens must not mix; use `wc -m` (characters), `wc -c` (UTF-8 bytes), model tokenizer (tokens) separately; document which unit in every metric.
6. **Reproducibility**: analysis script + intermediate results preserved; key counts and active time reproducible within rounding error.

**Control baseline** (Phase 0): use current config (§1.2) to establish new-session control; verify:
- Model role/override receipt (configured/local-resolved/provider-attested)
- Compaction threshold effective value (explicit vs schema default)
- Async wait policy (`smart` ladder, auto-delivery functioning)
- Auto-thinking effort clamping (per-turn classifier active)
- Workflow tool-output truncation (functioning in workflow path, absent in ordinary path)

**Residual pool** ([未验证假设]): current config may have already consumed part of historical all-sol pool; new-session receipt must confirm remaining convertible turns before claiming arithmetic upper bound.

### 6.4 A/B Metrics & Reporting

**Primary metrics** (all stratified by same task taxonomy):
- P50/P95 active critical-path time per session (event interval union)
- P50/P95 TTFT per turn (by model tier, context bucket)
- P50/P95 gen time per turn (by model tier, effort level)
- Normalized active hours per 100 completed sessions
- Parent blocked interval (hub wait, eval gate) per session

**Secondary metrics**:
- Context bucket distribution (turns in <50k / 50-100k / 100-150k / 150-200k / 200-300k / ≥350k)
- Repeat-read count (same file/spec)
- Compaction trigger point (token count, turn number)
- Bash retry count (by fingerprint)
- Gate critical-path length (serial vs parallel)

**Quality guard metrics** (stop conditions):
- Completion rate (session reached final success state)
- Verifier pass rate (type-check, lint, build, test, smoke)
- Independent review pass rate (异模型 reviewer/verifier)
- Rework rate (repair cycle count)
- Final acceptance rate (human/steering/CI gate)

**Reporting format**:
- Per-feature marginal delta: `feature_arm` vs `control` (same task stratification)
- Combination result: `S_combined = T_control - T_all_treatment`
- Stratification: by task class, model tier, context window, session length
- Non-overlap ledger: critical-path interval union, no double-counting
- Quality gates: all guard metrics reported alongside performance metrics

## 7. Handoff

### 7.1 Review Contract

**Reviewer**: gpt-5.6-sol xhigh native reviewer agent (different model lineage from author claude-opus-5), as specified by user.

**Review inputs** (read all at full fidelity; compute SHA-256; list in reviewedInputs):
1. `docs/superpowers/specs/2026-08-03-latency-defaults-gaps-design.md` (information base: background, current-default latency guarantees, Plan B recap, benefit quantification §4.7, user core scope §4.0, directions 1-5 with file-level implementation designs)
2. `docs/long-session-latency-analysis.md` (evidence base #1: full-session latency analysis, 689 sessions, pool decomposition)
3. `docs/superpowers/specs/2026-08-03-long-session-performance-optimization-design.md` (evidence base #2: prior design round 4, recommends Plan B, constraints, canonical owners)
4. `.omp/agents/opus5-designer.md` (agent definition: role contract)

**Review scope**: verify this design's correctness, completeness, and implementability:
1. **Background facts**: 689 sessions, 306.6h, pool decomposition, current config (§1.2), auto-thinking existence, canonical owners.
2. **Coverage matrix** (§2 of information base): current default measures cover which pools, which gaps remain.
3. **Benefit quantification** (§2.1): arithmetic upper bounds 40-60h (dir2) > 10-18h (dir1) > 7-10h (dir4) > 3-6h (dir3) > 2-3h (dir5); non-additive disclaimer; stratified arms for interaction terms.
4. **User core scope** (§1.3): must-implement items (dir 1.c ordinary truncation, dir 1.a read dedupe, dir 4 gate-parallel + orch-concurrency + main-agent boundary) correctly prioritized and deeply designed.
5. **Detailed design** (§4): file-level implementation steps for directions 1/2/4; interfaces, config contracts, failure paths, rollback, acceptance evidence.
6. **Main-agent concurrency control** (§4.b): explicit declaration (concurrency group, maxConcurrent, dependency, rendezvous), not implicit guessing; orchestration layer respects declaration.
7. **No double-counting** (§5.4): event interval union, compaction vs dir1 TTFT interaction stratified, dir2 vs auto-thinking gen stratified, hub savings exclude child runtime.
8. **Quality stop conditions** (§6.2): completion/verifier/review not degrading >2pp, rework/repeat-read not rising >10%, lineage independence preserved.
9. **Plan B vs 5 directions**: Plan B alone acts on ≤10% active time; 5 directions address gen pool (dir2), context bloat at source (dir1), gate-chain serial wait (dir4).

**Review verdict** (must be exactly one):
- `PASS`: design is correct, complete, implementable; can proceed to implementation authorization (though this design is design-only per user instruction).
- `PASS_WITH_NOTES`: design is acceptable but reviewer has non-blocking observations/suggestions; document notes.
- `NEEDS_REVISION`: design has blocking issues (incorrect facts, missing implementation details, quality risk, double-counting); enumerate blocking items; author must revise.
- `NEEDS_REDESIGN`: fundamental approach is flawed (violates constraints, cannot meet acceptance threshold, architectural mismatch); recommend alternative direction.

**Review artifact path**: `docs/superpowers/plans/2026-08-03-latency-optimization-plan-review.md`

**Post-review**: this design is `implementation_authorization: design-only` per user instruction; regardless of verdict, implementation does NOT proceed this session. Future implementation session uses this design + review artifact as authoritative input.

### 7.2 Resume Prompt (Future Implementation Session)

```text
Read the reviewed inputs manifest (repo-relative POSIX paths):
1. docs/superpowers/specs/2026-08-03-latency-optimization-plan-design.md (this design)
2. docs/superpowers/plans/2026-08-03-latency-optimization-plan-review.md (gpt-5.6-sol xhigh review verdict + notes)
3. docs/superpowers/specs/2026-08-03-latency-defaults-gaps-design.md (information base)
4. docs/long-session-latency-analysis.md (evidence base #1)
5. docs/superpowers/specs/2026-08-03-long-session-performance-optimization-design.md (evidence base #2)

For each input, compute lowercase SHA-256 of file bytes; generate Reviewed Inputs manifest (UTF-8 `<path>\t<sha256>\n` serialized, then hash entire manifest as `reviewed_revision`). Do not fabricate hashes for nonexistent files.

Check review verdict:
- If PASS or PASS_WITH_NOTES: proceed to Phase 0 (control baseline) per §5.1.
- If NEEDS_REVISION: enumerate blocking items from review; revise design document; request re-review.
- If NEEDS_REDESIGN: halt implementation; consult user on alternative direction.

Implementation order (§5.2):
1. Phase 0: establish new-session control baseline; verify receipt/attestation.
2. Phase 1: config arms (existing settings tuning).
3. Phase 2a: must-do mechanistic (dir 1.a read dedupe, dir 1.c ordinary truncation, dir 3 failure injection, dir 5 eval migration).
4. Phase 2b: must-do orchestration (dir 4.a gate parallel, dir 4.b orch concurrency).
5. Phase 2c: discretionary high-benefit (dir 2 role subdivision, after stabilization).
6. Phase 3: combination arm, report S_combined.

Implementation contract:
- Every feature independent on/off switch, default-off, session-frozen snapshot.
- Reuse existing canonical owners (no second engine).
- Focused contract tests before A/B (§6.1).
- Quality stop conditions enforced (§6.2).
- Non-overlap interval ledger, no double-counting (§5.4).
- Main-agent concurrency boundary explicit declaration (§4.b).

This design is design-only; implementation authorization granted for future session with must-implement items (dir 1.a/1.c, dir 4.a/4.b) as core scope.
```

---

## Appendix: Reviewed Inputs Manifest

```
docs/superpowers/specs/2026-08-03-latency-defaults-gaps-design.md	cc8fbc97e9423224ced820b2b8fb9397f39ec890587dffda2ac70990c2242bb0
docs/long-session-latency-analysis.md	0fd71c4dc5ad665b65118f0d80381ee5800360c31b72ca0800715218e3048089
docs/superpowers/specs/2026-08-03-long-session-performance-optimization-design.md	42f8e15a22ae2c22f62be233200b2b2dcafd373b67f348303c60e56f39c269b9
.omp/agents/opus5-designer.md	cfd6eccacd6a6e95d4730d6eb6b98e74f9e4ec3a42895906bdbc7fef0430de9f
```

**reviewed_revision**: (SHA-256 of above UTF-8 serialized manifest)
```
echo -n "docs/superpowers/specs/2026-08-03-latency-defaults-gaps-design.md	cc8fbc97e9423224ced820b2b8fb9397f39ec890587dffda2ac70990c2242bb0
docs/long-session-latency-analysis.md	0fd71c4dc5ad665b65118f0d80381ee5800360c31b72ca0800715218e3048089
docs/superpowers/specs/2026-08-03-long-session-performance-optimization-design.md	42f8e15a22ae2c22f62be233200b2b2dcafd373b67f348303c60e56f39c269b9
.omp/agents/opus5-designer.md	cfd6eccacd6a6e95d4730d6eb6b98e74f9e4ec3a42895906bdbc7fef0430de9f
" | shasum -a 256
```
→ `630e37f1fec0eed59bcf5b0c23cf8a66793445462c6dd93bebbaa126f8d9eaee`

