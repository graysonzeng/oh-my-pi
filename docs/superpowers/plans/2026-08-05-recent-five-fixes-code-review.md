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
