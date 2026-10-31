# Quality-routing reliability review — session handoff

- Date: 2026-08-02
- Branch: `workflow`
- HEAD: `6c66726938686150bbbd9a94effbfd2f3af26ff4`
- Fixed review point: `bbde26097`
- Lifecycle owner: existing Goal Mode quality-routing goal and confirmed design
- Scope: L; `ArchitectureReviewRequired=yes`
- Status: **partial implementation; not completion evidence**
- Stop reason: user requested durable handoff to a new Goal Mode session

## 1. Non-negotiable contract

Continue the original reliability task. Do not shrink scope.

- Preserve the worktree. NEVER `reset`, `checkout`, `clean`, commit, or push.
- Treat unrelated changes as user work; adapt, never revert.
- Keep `workflow.maxBudgetUsd=5`; do not print credentials.
- Reuse `WorkflowEngine`, `ModelRouter`, canonical identity collector, artifact store, benchmark report producer, and existing merge seam.
- Do not add a second router, compatibility shim, deprecated alias, caller-specific identity guard, or independent recovery engine.
- TypeScript: no `any`, `ReturnType<>`, inline/dynamic imports. Prompt assets remain static `.md`.
- Before exported-symbol edits, try LSP references. Current session result: `No language server found for this action`; then use bounded `grep`.
- Final completion still requires every original focused/broad/live/review gate.

Required baseline documents:

1. `docs/superpowers/specs/2026-07-30-quality-gated-multi-model-optimization-design.md`
2. `docs/superpowers/specs/2026-08-01-quality-first-model-routing-goal-design.md`
3. `docs/superpowers/plans/2026-07-30-quality-gated-multi-model-optimization-implementation.md`
4. `docs/superpowers/plans/2026-07-30-quality-gated-multi-model-optimization-code-review.md`
5. `progress.md:150-220`
6. `docs/workflow.md`
7. `CONTRIBUTING.md`
8. TypeScript/Bun/testing/coding-agent/catalog/prompt rules

## 2. Current worktree facts

Last observed `git status --short --branch` before this handoff document:

```text
branch workflow...origin/workflow
staged 0, unstaged 12, untracked 1
M packages/ai/test/openai-codex-stream.test.ts
M packages/coding-agent/src/workflow/engine.ts
M packages/coding-agent/src/workflow/identity-receipt.ts
M packages/coding-agent/src/workflow/policy-experiment.ts
M packages/coding-agent/src/workflow/runtime-invocation.ts
M packages/coding-agent/src/workflow/work-packages.ts
M packages/coding-agent/test/workflow/engine-quality-routes.test.ts
M packages/coding-agent/test/workflow/engine-work-packages.test.ts
M packages/coding-agent/test/workflow/identity-receipt.test.ts
M packages/coding-agent/test/workflow/policy-experiment.test.ts
M packages/coding-agent/test/workflow/runtime-invocation.test.ts
M packages/coding-agent/test/workflow/work-packages.test.ts
?? docs/research-async-compaction.md
```

`docs/research-async-compaction.md` appeared during this session but is unrelated user work. It was not read, edited, or removed. Re-run status first; do not assume this list remains complete.

Current tracked diff before documentation: 12 files, `+333/-197`. The pre-existing Codex test fix remains:

```ts
preferWebsockets: false
```

in `packages/ai/test/openai-codex-stream.test.ts`, test `scopes x-codex-turn-state to the current turn on SSE requests`.

## 3. Confirmed findings and current implementation

### 3.1 Same-response identity conflict — fixed locally

Root cause: `normalizedAttestedIdentity()` selected `gatewayModel ?? providerModel ?? metadataModel`, hiding contradictory coordinates inside one provider response.

Current change:

- Collect every non-empty gateway/provider/body model coordinate.
- Normalize model strings through `parseModelString()`.
- Any distinct normalized model → no attestation; strict routes fail closed.
- Collect all checkpoint headers/body fields; any distinct checkpoint → no attestation.
- Preserve existing gateway-attestation versus provider-echo provenance/provider selection; no caller-side guard.

Regression tests:

- target provider header + conflicting `metadata.model` → `indeterminate`, provenance `unknown`, no actual identity.
- matching model + conflicting checkpoint header/body → same fail-closed result.

Fresh evidence: `bun test packages/coding-agent/test/workflow/identity-receipt.test.ts` → 12 pass / 0 fail (`artifact://12`).

### 3.2 Quality policy corruption/missing snapshot — fixed locally, needs final architecture review

Root causes:

- `#parsePolicy()` returned `{}` on invalid JSON.
- `#activateQualityRouteFromPolicy()` interpreted missing snapshot as legacy routing.
- quality snapshot artifact parse/fingerprint failures were swallowed in hydration.

Current change in `engine.ts`:

- Persist `qualityRouteRequired: true` with new quality workflows.
- On resume, infer quality expectation from persisted request `qualityTier`, existing quality-route artifact, or policy marker.
- Invalid/non-object policy JSON throws deterministic `quality_route_policy_invalid`.
- Expected quality route without snapshot throws `quality_route_snapshot_missing`.
- Hydrated quality-route artifact must verify and match policy fingerprint; corruption/mismatch rethrows policy error.
- Valid legacy policy without quality evidence still restores configured legacy router.

Tests mutate SQLite `policy_json` after start, rebuild engine with changed config, then assert:

- truncated JSON rejects before stage attempt/model call;
- valid JSON with deleted snapshot rejects before stage attempt/model call;
- mutated current profiles never become active.

Fresh evidence:

- quality/availability/tool focused group: 27 pass / 0 fail (`artifact://28`).
- post-format targeted quality + policy group: 21 pass / 0 fail (`artifact://57`).

Review risk: invalid legacy policy now fails closed rather than silently becoming `{}`. Valid legacy behavior is retained; final Spec review must explicitly accept this corruption behavior.

### 3.3 Start preflight orphan — fixed locally, needs final architecture review

Confirmed reproduction: old `start()` called `createWorkflow()` before fail-closed preflight; thrown preflight left a `created` row whose ID never reached the tool caller.

Current change:

- Run start preflight before `createWorkflow()` using a temporary preflight ID.
- Suppress budget persistence until the workflow row exists.
- Persist workflow only after successful/advisory preflight, then save budget totals and rewrite report `workflowId` to the durable ID.

Behavior test: force quality planner unavailable; `start()` throws `required_role_unavailable`; direct SQLite count remains zero; no model call.

Known review question: preflight probes can now consume provider budget before workflow-row persistence. Budget remains in memory and is persisted after successful creation; a storage failure after preflight has no durable workflow record. Decide whether this is acceptable versus an auditable blocked-row design. Do not reintroduce an unreachable `created` row.

### 3.4 Strict dependent work packages — conservative fallback fixed locally

Confirmed defect: `dependsOn` only ordered waves; dependent package isolation still used the original repository baseline and never received predecessor patch state.

Current change:

- `buildWorkPackageExecutionPlan()` returns `null` when any package has `dependsOn`.
- Engine therefore uses the existing whole-plan serial implementation path.
- Independent packages with disjoint ownership remain parallel.
- Removed tests claiming dependent waves work; added engine behavior proving A adds an API and B consumes it through one whole-plan call with full plan context, zero per-package calls.

Fresh evidence: work-package unit + engine suites → 21 pass / 0 fail (`artifact://18`).

Do not restore dependent waves unless each dependent isolation baseline includes every verified predecessor patch and ownership/scope/resume/atomic merge contracts have end-to-end tests.

### 3.5 Artifactless context truncation — fixed locally, coverage expansion still required

Confirmed root cause in `prepareWorkflowInvocation()`:

- `contextPolicy.maxArtifactBytes` and artifact-inclusion cap were misused as total prompt caps.
- untyped dynamic context was heuristically evicted and sliced without a recovery artifact.
- typed entries were appended, then the full assembled prompt was sliced.
- `ContextLedger`/prompt receipt described pre-slice bytes while provider received post-slice text.

Current change:

- Removed `applyContextStrategyEviction()` from untyped workflow prompt assembly.
- Removed pre-split and post-assembly `maxArtifactBytes` slices.
- Provider receives exactly `assembled.text`; prompt receipt and ledger now describe the sent assembly.
- Existing typed optimization remains artifact-backed; absent store or integrity failure keeps inline content.

New regression uses a tiny artifact inclusion cap plus:

- large nonreplaceable current tool result;
- large attachment;
- history tail marker;
- `[raw output: artifact://42]` recovery URI.

All remain provider-visible; prompt receipt byte count equals sent payload; typed bucket bytes match inline content.

Fresh evidence: runtime invocation + ledger + adapter → 34 pass / 0 fail (`artifact://22`).

Remaining coverage from original request: explicit large attachment/history/handoff cases through async adapter; artifact verification failure; artifact persistence failure; confirm no orphan artifact after verification failure.

### 3.6 Policy receipt replay — exploit reproduced; production activation disabled, full authority binding not implemented

Confirmed root cause:

- caller self-reported `live_paired`, 30 cases, 5 repetitions, gate pass, approval, fingerprints;
- receipt hashed its own fields;
- `productionPolicyFeatureGates()` treated self-consistency as activation authority;
- stale/fake/cross-model receipts could activate compiler levers.

Current safe change:

- Production-mappable levers always receive `verified_rollout_authority_unavailable`.
- `evaluatePolicyLever()` therefore emits `shadow`, `applied=false` even for self-reported approved live evidence.
- Raw active gates remain stripped at production consumers.
- Comment explicitly states SHA-256 self-consistency is not rollout authority.

Fresh evidence: policy experiment suite → 10 pass / 0 fail (`artifact://34`); included again in the 104-test checkpoint group.

This is a fail-closed containment, not full benchmark authority implementation. The repository currently has no verifiable rollout approval producer binding canonical `BenchmarkReport`, current candidate compiled-policy fingerprint, current `ModelFacts` fingerprint, suite/version, provider/model/API/runtime provenance, fallback/identity status, report fingerprint, and approval provenance. Keep compiler shadow unless a canonical producer/consumer contract is implemented and tested. Never re-enable activation from a self-hash alone.

### 3.7 Codex SSE test network dependency — preserved fix

Confirmed earlier in the session:

- named SSE test attempted real Codex WebSocket first;
- waited 10-second connection timeout before SSE fallback;
- fixed by `preferWebsockets: false` in test options.

Fresh checkpoint regression: provider response + Codex stream → 84 pass / 0 fail (`artifact://44`).

## 4. Confirmed defects still open

### 4.1 Durable strict ordinary write commit

Files: `engine.ts`, existing work-package recovery helpers/types/tests.

Required:

1. Before ordinary strict implement/repair merge, persist revisioned commit state containing validated implementation artifact, patch path/content evidence, identity receipt, profile/model family, scope evidence, stage/attempt.
2. Merge once through existing `mergeCapturedChanges` seam.
3. Persist applied state immediately after merge returns, before implementation artifact/transition.
4. Resume reads persisted patch and proves `reverseApplies=true && forwardApplies=false` before recovery.
5. Missing/reverted/ambiguous evidence fails closed.
6. Never rerun model or merge when applied state is proved.
7. Cover implement and repair.

Existing reusable owner: work-package `capture_then_apply` state and `#recoverAppliedWorkPackageImplementation()` forward/reverse proof. Do not create a second recovery engine or SQLite table.

### 4.2 Cancellation during merge

Confirmed race: `cancel()` aborts controller then unconditionally finishes attempt/terminal-transitions `cancelled`; git apply may finish after merge started, leaving changed tree with cancelled state.

Required atomic point:

- cancellation before durable prepared state/merge start may cancel;
- after merge begins, runner must persist applied/committed outcome before cancellation becomes terminal;
- `cancel()` must coordinate with in-flight durable commit state, not merely check the signal after apply;
- new engine resume must detect applied patch;
- controlled merger/abort test; no duplicate model/merge call.

### 4.3 Live benchmark child provenance

Current defect remains untouched:

- `benchmark/live-runtime.ts` labels outer `session.model` as child workflow `runtime_observed` identity;
- child fallback/missing attestation/mixed model identities are invisible;
- production fallback count commonly unknown.

Required:

- derive provenance from `WorkflowEngine.getStatusReport()` persisted runtime evidence + routing audit;
- every required model-backed stage must have verified attested exact fixed provider/model/checkpoint;
- no fallback/skip ambiguity;
- all exact same identity → runtime provenance;
- fallback, missing, mixed → runtime provenance unknown and live acceptance fails closed;
- tests for all four paths.

### 4.4 Full policy benchmark authority (only if activation is to exist)

Current system intentionally shadow-only. Re-enable only after canonical `BenchmarkReport` producer derives a receipt bound to:

- suite/version and report fingerprint;
- baseline/candidate compiled-policy fingerprints;
- current model-facts fingerprints;
- provider/model/checkpoint/API/adapter/parser provenance;
- exact child identity and known zero fallback;
- active lever;
- liveQualityUnknown=false, full acceptance sampling, hard gate pass;
- explicit rollout approval provenance.

Consumer must compare current candidate/facts/report authority. Ordinary SHA-256 is integrity metadata, not a signature.

## 5. Fresh checkpoint evidence

| Check | Result | Scope |
| --- | --- | --- |
| Changed workflow focused group | 104 pass / 0 fail, 11 files (`artifact://43`) | identity, work packages, quality routes, availability, tool, runtime context, ledger, adapter, policy |
| Quality + policy after final test binding fix | 21 pass / 0 fail (`artifact://57`) | SQLite corruption/missing snapshot/preflight + receipt shadow |
| Provider response + Codex | 84 pass / 0 fail (`artifact://44`) | existing provider regression + preserved SSE test fix |
| `cd packages/coding-agent && bun check` | PASS (`artifact://58`) | Biome + TypeScript after targeted formatter/fixes |

Initial full suites/build/smokes/live E2Es supplied in the original handoff were run **before** these source changes. They are historical baseline only, not post-fix completion evidence.

Not run after current source changes:

- full workflow suite;
- model-policy/model-optimization suites;
- catalog identity suites;
- `packages/ai` and `packages/catalog` checks;
- coding-agent build;
- source CLI smoke;
- local quality config validation;
- exact live probes;
- balanced/critical live E2Es;
- independent Standards/Spec reviews.

## 6. Required continuation order

1. Re-read this document, original user request, required specs/plans, and current status/diff.
2. Create/resume Goal Mode owner; record current dirty worktree without reverting anything.
3. Run focused checkpoint tests once to confirm handoff baseline.
4. Implement durable ordinary strict write state + crash recovery.
5. Define and test merge/cancel atomic point using the same state.
6. Replace benchmark outer identity with child-stage attestation aggregation.
7. Keep policy compiler shadow unless complete canonical report/approval binding is implemented.
8. Expand context failure-path coverage.
9. Run focused regressions for all changed owners.
10. Run every broad/check/build/smoke/live gate from the original request.
11. Read every fresh balanced/critical report stage-by-stage; do not trust exit code alone.
12. Run independent cross-lineage Standards and Spec reviews; repair every blocker.
13. Only after smoke/live success, update `docs/workflow.md`, changelog if required, and `progress.md` completion evidence.
14. Read Aegis `verification-before-completion` before any completion claim.

## 7. Short Goal Mode resume prompt

```text
进入 Goal Mode，继续 `/Users/sheng/tencent/oh-my-pi` `workflow` 分支质量路由可靠性修复。先读原始任务、`docs/superpowers/plans/2026-08-02-quality-routing-reliability-handoff.md`、两份 quality 设计、实现/评审计划、`progress.md:150-`、`docs/workflow.md`、CONTRIBUTING/rules；先跑 `git status --short --branch`，保留全部现有改动和无关 `docs/research-async-compaction.md`，禁止 reset/checkout/clean/commit/push。现有局部修复：Codex SSE 禁 WS；同响应 model/checkpoint 冲突 fail closed；quality policy 损坏/缺 snapshot fail closed且 preflight 不留 orphan；dependsOn 回退 whole-plan serial；取消 artifactless prompt slice；无 benchmark rollout owner时 compiler 强制 shadow。先复核当前 diff与 focused baseline，再完成：普通 strict implement/repair durable write-commit + applied-patch resume；merge/cancel 原子点；live benchmark 从 child runtime-evidence/routing-audit验证全部必需 stage exact identity、零 fallback，missing/mixed/fallback fail closed；仅有 canonical BenchmarkReport+当前 candidate/facts+审批 provenance 完整绑定时才允许 policy active，否则保持 shadow。补齐故障注入/上下文负测，然后执行原任务全部 workflow/model/provider/catalog checks、build、CLI smoke、配置验证、exact probes、balanced+critical fresh E2E逐 stage核对、跨 lineage Standards+Spec review；修全部 blocker后读取 Aegis verification-before-completion再交付。预算保持 $5，不输出 secret，不新增 router/恢复引擎/compat shim。
```
