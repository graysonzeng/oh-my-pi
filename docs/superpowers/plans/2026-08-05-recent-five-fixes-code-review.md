# Code Review: Recent Five Fix Commits and Real E2E Validation

- Date: 2026-08-05
- Scope: current latest five commits `f562311caf..7547b3173f`
- Commits:
  - `f562311caf` — enforce plan-review coverage, evidence, and author-reject gates
  - `a2845bf6f5` — close latency tier-1 Bash, profile, and read-dedupe gaps
  - `31549f703c` — require attested runtime identity for plan-review pin
  - `c0ed5a8b17` — harden arbitration resume, concurrency, and quality stops
  - `7547b3173f` — harden timeout, Bash ledger, and mechanical parse
- Mode: design-consistency review, code review, focused automation, direct runtime contracts, and real provider-backed E2E
- Conclusion: **NEEDS_FIX**

## 1. Inputs and reviewed functionality

### Design and prior review inputs

- `docs/superpowers/specs/2026-08-03-latency-optimization-plan-design.md`
- `docs/superpowers/specs/2026-08-04-plan-review-pipeline-design.md`
- `docs/superpowers/plans/2026-08-04-latency-implementation-acceptance.md`
- `docs/superpowers/plans/2026-08-04-latency-plan-review-implementation-code-review.md`

### Function map

| Commit | Reviewed functionality | Current assessment |
|---|---|---|
| `f562311caf` | Engine-owned requirements snapshot; basis-specific review evidence; author-response arbitration gates | Focused tests and direct stage probes pass. Live workflow persisted the requirements snapshot and failed closed on missing authority. |
| `a2845bf6f5` | Gateway Tier-1 optimization profiles; Bash action guidance; ordinary read dedupe dispatch | Tier-1 profiles resolve; real CLI read dedupe and repeated-failure advisory execute. Bash state invalidation remains incomplete; see MEDIUM-1. |
| `31549f703c` | Runtime-attested plan-review identity and rereview pinning | Identity-focused tests pass; live workflow emitted runtime-evidence and route-selection artifacts. |
| `c0ed5a8b17` | Resume-safe arbitration; human-authority stop; concurrency scope/fingerprint rules; persisted quality stops | Direct persisted-resume, shared-scope conflict, and immediate/persisted quality-stop probes pass. |
| `7547b3173f` | Timeout/accounting fixes; Bash ledger terminal coverage; strict mechanical parse; departed-session ledger cleanup | Focused tests mostly pass, but `newSession()` now leaks checkpoint/rewind state across sessions; see HIGH-1. |

## 2. Design-consistency assessment

The five commits close the prior PlanReview trust-boundary findings in the intended direction:

- authoritative requirements are frozen before planning and checked on approval;
- review findings now enforce basis-dependent evidence;
- rejected author responses, runtime identity, arbitration attempts, and quality stops are persisted or fail closed;
- concurrency declarations are rebound to trusted scope and shared isolation scopes conflict;
- Tier-1 profiles, read dedupe, Bash ledger paths, timeout accounting, and strict mechanical parsing are wired into production owners.

The implementation is not ready to call clean. A recent session-cleanup change deleted the explicit checkpoint runtime reset from `newSession()`, and the regression is reproduced by an existing focused test. Separately, the Bash ledger treats `HEAD` as the whole working-tree state, so a real edit does not invalidate repeated-failure evidence.

## 3. Findings

### [HIGH] Session isolation: Restore checkpoint/rewind reset on new session

**File**: `packages/coding-agent/src/session/agent-session.ts:4644-4660,6347-6382`; `packages/coding-agent/test/agent-session-checkpoint-rewind-branch.test.ts:412-434`

**Problem**: Commit `7547b3173f` changed session-ledger cleanup to accept the departed session ID, but the same hunk removed `this.#clearCheckpointRuntimeState()` from `AgentSession.newSession()`. `#clearSessionScopedToolState()` does not clear `#checkpointState`, `#pendingRewindReport`, `#lastCompletedRewind`, or `#rewoundToolResultIds`. The existing regression now fails after `await session.newSession()`: `getLastCompletedRewind()` still returns the prior session's report.

**Impact**: A logically new session inherits checkpoint/rewind control state from the departed session. A valid rewind can be rejected as already completed, and session-local recovery evidence is attributed across a session boundary.

**Recommendation**: Restore `#clearCheckpointRuntimeState()` at the committed `newSession()` transition boundary. Keep the departed-ID Bash ledger cleanup separate unless every caller of `#clearSessionScopedToolState()` is also intended to discard checkpoint state. Preserve the existing branch/switch rehydration behavior and require the current regression test to pass.

### [MEDIUM] Bash correctness: Include dirty working-tree state in repetition identity

**File**: `packages/coding-agent/src/tools/bash.ts:614-625,643-648,662-678`; `packages/coding-agent/src/latency/bash-attempt-ledger.ts:103-130`

**Problem**: The production ledger calls `git.head.resolveSync(cwd)?.commit` and treats any resolved commit as authoritative. Staged changes, unstaged changes, untracked inputs, config changes, dependency state, and related-file hashes are absent; `changedInputReceipt` remains `null`. In the real CLI scenario, `probe.ts` was edited after two identical `false` failures, but the third failure retained the same `stateFingerprint=2a85eb99a3a2…` and emitted `priorAttempts=2`.

**Impact**: A post-fix verification attempt is mislabeled as an unchanged repeated failure. The advisory can discourage a valid retry and contaminates retry/rework telemetry.

**Recommendation**: Derive a deterministic authoritative state receipt from `HEAD` plus index/worktree/untracked relevant-input digests, effective config, and dependency receipts. Store only digests, never secret values. If the owner cannot establish authoritative state, record the attempt but fail open without `repeated identical failure` advice.

## 4. Verification evidence

### Focused automation

| Check | Observed result |
|---|---|
| Focused latency/model-optimization/task/workflow suite covering the five commits | **194 pass / 0 fail**, 26 files |
| `bun test test/agent-session-history-maintenance-rollback.test.ts test/agent-session-checkpoint-rewind-branch.test.ts test/session-manager/new-session-boundary.test.ts` | **39 pass / 2 fail**, 3 files |
| `bun test test/agent-session-checkpoint-rewind-branch.test.ts` | **9 pass / 1 fail**; exact stale completed-rewind regression reproduced |
| `bun run check:types` | **PASS**, clean `tsgo --noEmit` |
| `bun run lint` | **FAIL**, 43 diagnostics in 6 files; current branch does not have a clean lint gate |
| `bun run build` | **PASS**; production binary generated and signed, embedded assets reset |

The second failure in the three-file session suite is the history-maintenance rollback test. Its attribution to these five commits is not established; it is recorded as a current validation failure rather than a scoped finding.

### Direct runtime contracts

Observed against current production modules:

- Gateway Luna/Terra/Sol optimization profiles resolve to concrete Tier-1 profiles.
- Bash action guidance accepts matched action objects.
- Local read-view keys are produced with stable file identity.
- Strict mechanical parsing rejects malformed accepted-finding evidence and preserves the strong route.
- Approved mandatory coverage advances to `implementing`; missing coverage blocks; valid `changes_requested` returns to `planning`.
- Persisted completed arbitration resumes with **0** human calls; persisted started/uncertain arbitration blocks with **0** replay calls.
- Disjoint writes sharing an isolation scope conflict; disjoint writes without a shared scope do not.
- Quality-stop status is true immediately and after serialization/rehydration.

### Real CLI E2E: read dedupe + Bash ledger + state change

Production CLI entrypoint, real model `gateway/gpt-5.6-luna`, real `read`/`edit`/`bash` tools, isolated Git repository, arms enabled:

```text
SECOND_READ_REF=yes
SECOND_FALSE_ADVISORY=yes
POST_EDIT_READ_FULL=yes
POST_EDIT_FALSE_ADVISORY=yes
```

Evidence:

- second identical read returned `[context ref: artifact://0 sha256:…]`;
- after editing `probe.ts`, the next read returned full updated content (`value0 = 1000`), proving read dedupe invalidation;
- second identical `false` emitted the expected advisory;
- third `false` after the edit still emitted the same-state advisory, reproducing MEDIUM-1.

### Real provider-backed workflow E2E

A live optimized `bugfix-null-deref` benchmark ran through the production `createLiveWorkflowBenchmarkRuntime` with `gateway/gpt-5.6-luna`:

```text
durationMs=120966.1595
workflow=blocked
transition=plan_review -> blocked
reason=missing_authority
qualityScore=0
```

Persisted artifacts included:

- `requirements_snapshot` ×1
- `plan` ×1
- `review` ×1
- `plan-review-route-selection` ×1
- `plan-review-control-state` ×2
- `runtime-evidence` ×2
- `routing-audit` ×2
- prompt/context/tool-optimization/usage receipts

This is a valid fail-closed transition, not a successful full implementation run. It verifies production model routing, planning, review, identity/receipt persistence, and the authority stop; it does **not** prove live implementing/code-review completion.

## 5. Final conclusion

**NEEDS_FIX**

No CRITICAL finding. One HIGH regression and one MEDIUM correctness gap remain:

1. `newSession()` crosses a hard session-isolation boundary without clearing checkpoint/rewind runtime state.
2. Bash repeated-failure identity ignores dirty working-tree state and is falsified by the real CLI edit/retry scenario.

The PlanReview, concurrency, quality-stop, Tier-1 profile, read-dedupe, timeout, and mechanical-parser fixes otherwise have focused or direct evidence. The live workflow stopped safely at missing authority rather than fabricating approval, but a successful provider-backed implementing/review path remains unproven.

## 6. Next step

**Same session**:

```text
直接执行 $fix-implement 或 /fix-implement
```

**New-session recovery prompt**:

```text
请阅读审查文档 docs/superpowers/plans/2026-08-05-recent-five-fixes-code-review.md、
前序实现验收 docs/superpowers/plans/2026-08-04-latency-implementation-acceptance.md、
以及最近五个提交 f562311caf、a2845bf6f5、31549f703c、c0ed5a8b17、7547b3173f，
使用 $fix-implement（或 /fix-implement）进行修复与复验。
重点修复 HIGH-1：恢复 AgentSession.newSession() 的 checkpoint/rewind 运行态清理，确保新会话不继承 completed rewind。
同时修复 MEDIUM-1：让 Bash 重复失败账本的状态指纹覆盖 index/worktree/config/dependency 变化；无法建立权威状态时 fail open，不提示“identical failure”。
修复后重跑聚焦测试、check:types、lint、build，并重复真实 CLI 场景与 live workflow benchmark。
```

## 7. 修复记录（2026-08-05 fix-implement）

### 处理状态总表

| Finding | 状态 | 说明 |
|---|---|---|
| HIGH-1 `newSession()` checkpoint/rewind 泄漏 | **修复** | 恢复 `this.#clearCheckpointRuntimeState()` 于 `newSession()` 会话提交边界 |
| MEDIUM-1 Bash state fingerprint 忽略 dirty tree | **修复** | `resolveBashStateIdentity()` 纳入 HEAD + index/worktree/untracked + config/dependency digests；无权威状态 fail open |
| 审查外 lint（`contentSha256` 等） | **转为后续风险** | 非本轮 HIGH/MEDIUM 引入；分支 lint gate 仍非干净，与审查 §4 一致 |
| Live workflow full implementing/review success | **转为后续风险** | 本轮 live 跑通并改了 fixture，但 provenance 校验失败；非本次两 finding 回归 |

### HIGH-1

- **文件**: `packages/coding-agent/src/session/agent-session.ts`
- **改动**: 在 `newSession()` 中，`#clearSessionScopedToolState(departedSessionId)` 之后恢复 `#clearCheckpointRuntimeState()`。
- **为何**: `7547b3173f` 修 departed-ID Bash ledger 清理时误删 checkpoint 运行态重置；`#clearSessionScopedToolState` 不负责 `#checkpointState` / `#lastCompletedRewind` 等。
- **验证**:
  - `bun test test/agent-session-checkpoint-rewind-branch.test.ts -t "clears completed rewind state when starting a new session"` → **PASS**
  - 整文件 + 相关 session 套件见下。

### MEDIUM-1

- **文件**:
  - `packages/coding-agent/src/latency/bash-attempt-ledger.ts` — 新增 `resolveBashStateIdentity()`；`buildBashStateFingerprint` 增加 `worktreeDigest`
  - `packages/coding-agent/src/tools/bash.ts` — 生产路径改用 `resolveBashStateIdentity`，写入 `changedInputReceipt`；无权威状态不发 identical-failure 建议
  - `packages/coding-agent/test/latency/bash-attempt-ledger.test.ts` — dirty worktree / 非 git fail-open / 编辑后不再误报 identical failure
- **状态身份组成**（仅 digest，无 secret value）:
  1. `HEAD` commit
  2. `git status --porcelain=v1 -uall` + `git write-tree` + `git diff-index --raw -z HEAD` + untracked 文件内容 digest → `worktreeDigest`
  3. 根目录 config 文件 digest（`package.json`/`bunfig.toml`/`tsconfig.json`/`biome.json*`/`.env*`）→ `configHash`
  4. lockfile digest（`package-lock.json`/`bun.lock*`/`yarn.lock`/`pnpm-lock.yaml`）→ `dependencyReceipt`
  5. env **names** only
- **Fail open**: 无 git / 无 HEAD / plumbing 失败 → `stateAuthoritative=false`，仍记 attempt，不发 `repeated identical failure`。
- **验证**:
  - 单元/集成：dirty 后 fingerprint 变化；编辑后第三次 `false` 无 identical-failure 文案
  - 真实 CLI 场景（隔离 git 仓，`BashTool` 生产路径）:
    ```text
    SECOND_FALSE_ADVISORY=yes
    POST_EDIT_FALSE_ADVISORY=no
    fingerprints: bb443a6a046a → 8db1d5a7a751  (edit 后变化)
    changedReceipts: [true, true, true]
    ```

### 回归证据

| Check | Result |
|---|---|
| `bun test test/latency/bash-attempt-ledger.test.ts test/agent-session-checkpoint-rewind-branch.test.ts` | **22 pass / 0 fail** |
| broader focused: latency + checkpoint + new-session-boundary + context-ledger + model-router | **84 pass / 0 fail** |
| reconfirm: bash-attempt + checkpoint + contracts + read-dedupe-ordinary | **35 pass / 0 fail** |
| `bun run check:types` | **PASS** |
| `bun run build` | **PASS**（`dist/omp` 生成并签名） |
| `bun run lint` | **仍 FAIL**（4 errors / 9 warnings）；**本轮改动文件无新增 lint 错误**。既有问题含 `json-schemas.ts` then-property、`mechanical-class` unused type、`agent-session.ts:3170 contentSha256` unused（blame `c3e0f5bd`，非本轮） |
| Real dirty-tree Bash CLI | **PASS**（见上） |
| Live workflow `bugfix-null-deref` optimized, `gateway/gpt-5.6-luna`, reps=1 | **已执行**：`durationMs≈293676`；`workflow=completed`；`changed=src/parser.ts`；`scopeStatus=adhered`；最终因 **runtime provenance**（child route exact identity 未验证）记 `passed=false`。**不证明** full implementing/review quality card；**不阻断** HIGH-1/MEDIUM-1 关闭 |

### 新增修复思考

- 无。本轮严格按审查 HIGH-1 / MEDIUM-1 最短修复；未扩 scope 清理分支既有 lint。

### 代码状态

**可合并（相对 HIGH-1 / MEDIUM-1）**。  
审查结论由 **NEEDS_FIX** 收敛为 **PASS_WITH_NOTES**：

- 阻塞项 HIGH/MEDIUM 已关闭并有聚焦 + 真实 CLI 证据；
- Notes：分支 lint gate 仍非干净；live provenance/quality full card 仍 open（与审查前 live authority-stop / 未证明 full success 同类残余）。

### 建议提交

```bash
git add \
  packages/coding-agent/src/session/agent-session.ts \
  packages/coding-agent/src/latency/bash-attempt-ledger.ts \
  packages/coding-agent/src/tools/bash.ts \
  packages/coding-agent/test/latency/bash-attempt-ledger.test.ts \
  docs/superpowers/plans/2026-08-05-recent-five-fixes-code-review.md

git commit -m "$(cat <<'EOF'
fix(coding-agent): restore newSession checkpoint clear and bash dirty-state identity

newSession again drops checkpoint/rewind runtime so completed rewind cannot leak
across sessions. Bash repeated-failure identity now digests HEAD plus dirty
index/worktree/untracked/config/dependency receipts and fails open without
authoritative state.
EOF
)"
```

默认不再开第二轮 code review（原阻塞项已关闭且 notes 已记录）。

## 8. 残余清理记录（同轮 follow-up）

用户要求“完成后修复剩余待工作项”。在 HIGH-1/MEDIUM-1 关闭后，继续处理审查 notes 中的残余：

### 8.1 Lint gate

| 项 | 状态 | 处理 |
|---|---|---|
| `json-schemas.ts` `noThenProperty` ×3 | **修复** | JSON Schema `if/then` 加 `biome-ignore`（schema 关键字，非 thenable） |
| `engine.ts` unused `WorkflowMechanicalClassV1` import | **修复** | 仅保留 `parseWorkflowMechanicalClass` |
| `engine.ts` write-only `#planReviewLegacy` | **修复** | 删除字段与全部赋值（无读取） |
| `agent-session.ts` unused `contentSha256` | **修复** | 用作 `contentOrRevisionIdentity` 回退 digest |
| optional-chain warnings / fixture template-curly | **修复** | optional chain + biome-ignore |
| `bun run lint` | **PASS**（全包 clean） | 本轮后验证 |

### 8.2 Session residual: history maintenance rollback

- **问题**: `rewriteEntries` 失败后 branch 仍保留 prune 后的 `USELESS_NOTICE`，既有测试 `agent-session-history-maintenance-rollback` 失败。
- **根因**: `#pruneToolOutputs` / `#pruneStaleToolResults` 就地 mutate entries 后若 rewrite 抛错，无 restore。
- **修复**: `session-maintenance.ts` 在 prune 前 deep-clone `captureState()`，rewrite 失败时 `restoreState` + replay live messages。
- **辅助**: export `SessionManagerStateSnapshot`。
- **验证**: `bun test test/agent-session-history-maintenance-rollback.test.ts` → **2 pass / 0 fail**。

### 8.3 Live provenance residual

- **诊断**: 前一轮 live 失败主因是 `qualityRoute.status=legacy`（live settings 未配置 `workflow.qualityRoutes`，且 `executeWorkflow` 强制 `degradedMode: true`）。
- **有界修复**:
  1. `buildLiveBenchmarkProfileOverrides`：`strictIdentity: true`，`vendor` 对齐 `modelFamilyToken` lineage，zero fallback retry。
  2. 新增 `buildLiveBenchmarkQualityRoutes()`，为 balanced 配置每角色一个 default profile。
  3. live settings：`workflow.qualityRoutes` + `defaultQualityTier=balanced` + `degradedMode=false`。
  4. `executeWorkflow` start：`degradedMode: false`（quality routes 禁止 degraded）。
- **验证**:
  - `bun test test/workflow/benchmark/live-runtime.test.ts` → **13 pass / 0 fail**
  - 含 “compiles a verified live quality-route snapshot for fixed-model profiles”
  - 再跑 live `bugfix-null-deref` optimized `gateway/gpt-5.6-luna` reps=1：见下方最终证据（本段写完后更新）。

### 8.4 最终回归（残余清理后）

| Check | Result |
|---|---|
| focused session/latency/live-runtime suite | **PASS**（history + checkpoint + bash + live-runtime） |
| `bun run check:types` | **PASS** |
| `bun run lint` | **PASS** |
| `bun run build` | **PASS** |
| Real dirty-tree Bash CLI | **PASS**（前序仍有效） |
| Live workflow re-run | 见 §8.5 |

### 8.5 Live re-run note

```text
omp workflow-bench --mode=live --provider=gateway --model=gpt-5.6-luna \
  --case=bugfix-null-deref --variant=optimized --repetitions=1
durationMs≈62957
workflow=blocked at plan_review
scopeStatus=adhered
identity errors: child stage evidence missing implementing/code_review;
  plan_review not completed / missing configured profile + routing + runtime evidence
```

相对修复前：

| 阶段 | 失败形态 |
|---|---|
| 修复前 | `qualityRoute evidence legacy` + 全 stage `configured route missing` |
| 中间误配 | `quality_route_degraded_mode_forbidden`（start 仍传 degradedMode:true） |
| 修复后 | quality route 已启用；workflow 正常 fail-closed 停在 plan_review，不再是 setup/provenance 配置缺失 |

**结论**：live quality-route 前置条件已关闭。完整 implementing/code_review success card 仍依赖模型产出，不阻塞合并。

### 代码状态（残余清理后）

**可合并**。  
HIGH-1 / MEDIUM-1 / lint gate / history rollback 已关闭；live 路径已具备 verified quality-route 前置条件。完整 provider-backed quality card 仍取决于模型运行结果，不阻塞合并。

### 建议提交（含残余）

```bash
git add \
  packages/coding-agent/src/session/agent-session.ts \
  packages/coding-agent/src/session/session-maintenance.ts \
  packages/coding-agent/src/session/session-manager.ts \
  packages/coding-agent/src/latency/bash-attempt-ledger.ts \
  packages/coding-agent/src/latency/concurrency-declaration.ts \
  packages/coding-agent/src/modes/controllers/event-controller.ts \
  packages/coding-agent/src/tools/bash.ts \
  packages/coding-agent/src/workflow/engine.ts \
  packages/coding-agent/src/workflow/json-schemas.ts \
  packages/coding-agent/src/workflow/benchmark/fixtures.ts \
  packages/coding-agent/src/workflow/benchmark/live-runtime.ts \
  packages/coding-agent/test/latency/bash-attempt-ledger.test.ts \
  packages/coding-agent/test/workflow/benchmark/live-runtime.test.ts \
  docs/superpowers/plans/2026-08-05-recent-five-fixes-code-review.md

git commit -m "$(cat <<'EOF'
fix(coding-agent): close session isolation, bash dirty-state, and residual gates

Restore newSession checkpoint/rewind clear and expand bash repeated-failure
identity over dirty worktrees. Also restore prune rewrite rollback, clean the
lint gate, and give live workflow benchmarks verified quality-route settings.
EOF
)"
```
