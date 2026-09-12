# Code Review: P0 Subagent Timeouts + Latency Arms

- Date: 2026-08-04
- Reviewer: Cursor Grok 4.5（只读 code-review / code-audit / review-agent / tacit-knowledge）
- Repo revision reviewed: `1ee29e0f09bbfd6292afc228c87dda514b8aa55f`
- Prior skeleton: `c3e0f5bd7e133e930f4b695e3a465f1b74b62b05`
- Branch: `workflow`（ahead of `origin/workflow`）
- Mode: 设计一致性 + 缺陷优先 code review（只读被审对象；本文为审查输出）

## 1. 审查范围

### 1.1 P0（主交付）

| 项 | 权威输入 | 实现锚点 |
|---|---|---|
| `task.maxRuntimeMs` 默认 0→3_600_000 | `docs/design/subagent-lifecycle-observability-v2.md` §5.1.3 / §8 Phase 0 | `settings-schema.ts` |
| `task.queuedStartupTimeoutMs` 新增默认 120_000 | 同上 §5.1.3 / §5.2.4；复审 F1/F4/F8 | `task/index.ts` `#registerSpawnJob` |
| 运行墙钟超时既有路径 | §1.2 / F8 状态语义 | `task/executor.ts`（本轮未改逻辑） |
| 测试 | §7 + 验收表 | `task-spawn` / `executor-wall-clock` / `settings-manager` |

### 1.2 延迟优化（前半段 + harden）

| 项 | 权威输入 | 实现锚点 |
|---|---|---|
| default-off arms / session freeze | A §6.2 | `latency/arms.ts` |
| read dedupe / bash ledger / concurrency / Flash / eval / plan-review | A + D | `c3e0f5bd7` + `1ee29e0f0` harden |
| 文档集体评审状态 | collective review | 5/5 `NEEDS_REVISION`（设计文档侧） |

### 1.3 非本轮

- P1 staleness / Hub lifecycle delivery（`docs/design/_p1-epic-inputs/`）
- PlanReview 完整 D 五 arms 合同（仍属 partial）

## 2. 方案一致性评估

### 2.1 P0：整体对齐，局部契约未闭合

**事实（有代码/设计证据）**

- 默认值与命名符合 §5.1.3 / F8（`queuedStartupTimeoutMs` 而非 `queuedTimeoutMs`）；`0` 独立禁用。
- `#registerSpawnJob` 实现了 token + `AbortSignal.any` + acquire 独立 try/catch + `semaphoreHeld=true` 立即置位 + `releasePermit` + timer `finally` + `settleOnce`，方向正确。
- F8 状态分层正确：queued timeout → `AgentProgress.status="failed"` + `TaskJobError` → AsyncJob `failed`；runtime timeout → progress `aborted` + 外层 `failed`。
- 聚焦测试本轮复跑：**97 pass / 0 fail**（`task-spawn` + `executor-wall-clock` + `settings-manager`）。

**合理 defer（非 P0 缺口）**

- Phase 0 正文仍写「四个新字段」，但文档开篇已把 `async.staleness*` 划到 P1。本轮只交 timeout 两字段与开篇 P0 范围一致；应在交付说明写清，避免把 Phase 0 全文当验收清单。

**不一致 / 未闭合**

- acquire `catch` 用 `combinedSignal.reason **OR** queuedAbortController.signal.reason` 判定 queued timeout，破坏 AbortSignal.any 的 first-cause（见 HIGH-1）。
- 复审要求的 cancel/timeout 同 tick、post-acquire 竞态测试未齐全；现有测试只覆盖「排队等待超时 + permit 不泄漏」主路径。
- 进程内 `queued_timeout_triggered` / `runtime_timeout_triggered` 计数是有用的测试可观测性，**不能**等价于复审要求的 rollout/cohort ledger。

### 2.2 Latency：骨架可用，treatment 多数仍不可生效或未接运行时

| 能力 | 状态 | 证据摘要 |
|---|---|---|
| arm default-off + freeze helper | 已落地 | `latency/arms.ts` |
| context optimization seam | partial | 依赖既有 `modelOptimization` |
| read_dedupe | partial → 实际不可命中 | identity 字段无生产方，恒 fail-open（HIGH-2） |
| bash ledger | partial | managed 路径有记录；interactive create-timeout 旁路（MEDIUM-2） |
| concurrency declaration/execution | partial | schema/lowering 有；与完整 workflow 合同仍薄 |
| Mechanical Flash repair | partial | `flash_repair` profile + router；plan_reviewer 排除 |
| eval parity gate | partial | gate/receipt；非 native cutover |
| PlanReview V2 / 仲裁 | partial | types/schema/`#runPlanArbitration` 有；stage 仍强制 V1（HIGH-3） |

设计文档集体评审仍为 5/5 `NEEDS_REVISION`；实现超前于已修订权威合同的风险仍在，尤其是 A↔D plan_review 形态。

## 3. 主要发现

### [HIGH] 正确性: cancel 先到时仍可能被记成 queued timeout

**文件**: `packages/coding-agent/src/task/index.ts:1195-1204`

**问题**: acquire `catch` 在 `combinedSignal.reason` 不是 timeout token 时，仍用 `queuedAbortController.signal.reason` 二次判定。AbortSignal.any 是 first-abort-wins；若 user cancel 先 abort，随后 timeout timer 也 fire，OR 分支会把 cancel 误报为 queued startup timeout。

**影响**: AsyncJob/`AgentProgress` 错误归因；文案与指标 `queued_timeout_triggered` 污染；违反复审 F4 first-cause 合同。

**建议**: 只信任 `combinedSignal.reason`（或显式记录 first-cause，在 timer/cancel 回调写入一次）。删除对 `queuedAbortController.signal.reason` 的 OR 回退。补同 tick 测试：cancel-before-timeout、timeout-before-cancel。

**证据**: 本地 Node 复现：`cancel` 先 abort 后 `q.abort(token)` → `isQueued(combined) || isQueued(q)` === `true`。

### [HIGH] 功能空洞: read_dedupe arm 开启也不会命中

**文件**: `packages/coding-agent/src/session/agent-session.ts:3171-3215`；`packages/coding-agent/src/latency/read-view-key.ts:61-69`

**问题**: dedupe 要求 `branchOrWorktreeScope` / `providerViewIdentity` / `contentOrRevisionIdentity` 非空才 `eligible`。全 `tools/` 无这些字段的生产方；session 侧缺省为 `""`，因此 `eligible` 恒为 false，arm on 也永远 fail-open。

**影响**: Direction 1.c 不可做 A/B；acceptance 若宣称 read dedupe 已落地会误导。

**建议**: 在 `read`（及 ordinary session 等价路径）写入可验证 identity；或降低 eligibility 合同并更新 Spec；补 read→第二次 ref 的端到端测试。

### [HIGH] 契约漂移: PlanReview stage 仍强制 V1，V2/仲裁合同未接入该 seam

**文件**: `packages/coding-agent/src/workflow/stages/plan-review.ts:59-67`；对照 `workflow/schemas.ts` `PlanReviewArtifactV2Schema`、`engine.ts` `#runPlanArbitration`

**问题**: stage 固定 `ReviewArtifactSchema` + `schemaVersion: 1`，绕过 V2 schema。引擎侧仲裁 helper 存在，但不能宣称 D「单强评审 + 冻结 identity 复审 + 条件仲裁」完整运行时合同已闭合。

**影响**: 文档/acceptance 若把 V2 写成已接入会过度承诺；strict gate / coverage / human arbitration 字段在该路径不生效。

**建议**: 要么 stage 解析 V2 并接仲裁状态机，要么在 acceptance 明确标 `partial / not runtime-wired`，禁止当 D 合同完成。

### [MEDIUM] 可维护性: timeout 去重 Set 跨 session 无界增长

**文件**: `packages/coding-agent/src/task/index.ts`（`timeoutMetricOnce` 模块级 Set）

**问题**: per-job key 写入后仅测试 reset 清空；长寿命进程唯一 agentId 持续增长。

**影响**: 低流量可忽略；长期 daemon 式进程有内存泄漏面。

**建议**: job finally 清理 once-key，或改为 totals-only / WeakRef，或限制上限。

### [MEDIUM] 合同缺口: bash interactive create-timeout 不记 ledger

**文件**: `packages/coding-agent/src/tools/bash.ts:1349-1363`

**问题**: create 阶段 timeout 走 `#throwIfUnfinished`，未调用 `#recordBashAttempt`；普通完成/managed 路径会记录。

**影响**: Direction 3 对「超时重试环」证据不全；与 P0/墙钟类失败叙事耦合。

**建议**: 所有 timeout/cancel 终端路径统一记账（含 create-timeout / poll-timeout）。

### [MEDIUM] 测试缺口: first-cause / post-acquire 竞态未覆盖

**文件**: `packages/coding-agent/test/task/task-spawn.test.ts`（现有 queued timeout 用例）

**问题**: 有主路径与 permit 不泄漏断言；缺 cancel-vs-timeout 同 tick、post-acquire abort、runtime_timeout metric 断言。

**影响**: HIGH-1 类回归可静默通过 CI。

**建议**: 用受控 deferred/fake clock 补齐复审要求的四个 interleaving。

### [MEDIUM] 发布风险: `maxRuntimeMs` 默认 1h 改变既有无配置会话语义

**文件**: `packages/coding-agent/src/config/settings-schema.ts`（default `3_600_000`）

**问题**: 设计标注 [拟议验收目标] 且有意默认开启；对 >1h 合法长任务是行为变更，不是 additive。

**影响**: 未显式配 `0` 的老用户可能突然 aborted；eval bridge 等 override 路径需确认。

**建议**: changelog / migration note；监控 `runtime_timeout_triggered`；保留 `0` 回滚开关（已有）。

### [LOW] 范围说明: sync fanout 无 queuedStartupTimeout

**文件**: `packages/coding-agent/src/task/index.ts` `#executeSyncFanout`

**问题**: 设计 §5.2.4 锚定 async `#registerSpawnJob`；sync 路径仍可在 semaphore 上无限等待。

**影响**: blocking agent / async 不可用时仍可能挂起。

**建议**: 记为已知 non-goal 或后续对称补齐。

## 4. Standards 轴（简）

- 仓库无独立 `CODING_STANDARDS.md`；`CONTRIBUTING.md` 要求大改先讨论——本改动跨 settings 默认行为，发布说明应齐全。
- Smell（judgement）：acquire 失败分类逻辑略 Feature Envy / 重复（fail helpers 已部分抽出，但 first-cause 判定仍分叉）——修 HIGH-1 时可一并收敛。
- 测试导出 `__reset/__getTaskTimeoutMetricsForTests` 可接受；勿当成生产 telemetry API。

## 5. 验证证据

| 命令 | 结果 |
|---|---|
| `bun test test/task/task-spawn.test.ts test/task/executor-wall-clock.test.ts test/settings-manager.test.ts`（`packages/coding-agent`） | **97 pass / 0 fail**（本轮复跑） |
| latency / workflow 全量回归 | **未跑** |
| `check:types` | 用户声称绿；**本轮未复跑** |

## 6. 最终结论

**NEEDS_REVISION**

- P0 主路径（默认值、queued timeout fail、permit 不泄漏、F8 状态分层）大体合格，**不能**在修复 HIGH-1 前视为竞态/归因合同闭合。
- Latency harden 有骨架与部分 profile/schema，但 read_dedupe 空洞与 PlanReview V2 未接线使「评审修复已闭环」不成立。

## 7. 下一步

**同会话继续**:
直接执行 $fix-implement 或 /fix-implement

**新会话恢复 prompt**:
```
请阅读实现文档 docs/superpowers/plans/2026-08-04-latency-implementation-acceptance.md、
审查文档 docs/superpowers/plans/2026-08-04-subagent-timeout-latency-code-review.md、
设计输入 docs/design/subagent-lifecycle-observability-v2.md 与 docs/superpowers/specs/2026-08-03-latency-optimization-plan-design.md、
以及本次代码变更（HEAD 起自 1ee29e0f0），
使用 $fix-implement（或 /fix-implement）进行方案修复及代码实现。
重点修复 HIGH-1：task/index.ts acquire catch 仅用 combinedSignal.reason 做 queued-timeout first-cause，删除对 queuedAbortController.signal.reason 的 OR 回退，并补 cancel/timeout 同 tick 测试。
```

---

## 8. 修复记录（2026-08-04 / fix-implement）

- **修复范围授权**：用户本轮明确要求重点修复 HIGH-1（first-cause）；其余项按证据决定修复 / 转为后续风险。
- **修复 revision**：工作区未提交变更（基于 `1ee29e0f0`）。

### 8.1 审查意见处理状态

| ID | 严重度 | 处理 | 说明 |
|---|---|---|---|
| HIGH-1 | HIGH | **修复** | acquire `catch` 与 post-acquire double-check 均只信任 `combinedSignal.reason` / `combinedSignal.aborted`；删除对 `queuedAbortController.signal.reason` 的 `\|\|` / `??` 回退。 |
| HIGH-2 | HIGH | **转为后续风险** | read_dedupe identity 无生产方；属 latency Direction 1.c 空洞，不在本轮 P0 timeout 授权范围。替代：acceptance / 后续 epic 补 read identity 生产或下调 eligibility。 |
| HIGH-3 | HIGH | **转为后续风险** | PlanReview stage 仍强制 V1；属 latency/D 合同，非本轮 P0 timeout 范围。替代：acceptance 继续标 partial，或另开 stage V2 接线。 |
| MEDIUM-1 | MEDIUM | **转为后续风险** | `timeoutMetricOnce` 无界 Set；低流量可忽略。建议 job finally 清理 once-key。 |
| MEDIUM-2 | MEDIUM | **转为后续风险** | bash interactive create-timeout 不记 ledger；非本轮。 |
| MEDIUM-3 | MEDIUM | **部分修复** | 已补 cancel/timeout first-cause 与 AbortSignal.any 同序契约测试；post-acquire 受控 deferred / fake clock 四 interleaving 未全覆盖，剩余记入复审范围。 |
| MEDIUM-4 | MEDIUM | **转为后续风险** | `maxRuntimeMs` 默认 1h 行为变更；需 changelog / 监控，非代码缺陷。 |
| LOW-1 | LOW | **不采纳（本轮）** | sync fanout 无 queuedStartupTimeout；设计锚定 async `#registerSpawnJob`，记为已知 non-goal。 |

### 8.2 HIGH-1 修复内容

**文件**: `packages/coding-agent/src/task/index.ts`

1. acquire `catch`：`isQueuedTimeoutReason(combinedSignal.reason)` 为唯一 queued-timeout 判定；删除 `\|\| isQueuedTimeoutReason(queuedAbortController.signal.reason)`。
2. post-acquire：仅检查 `combinedSignal.aborted` + `combinedSignal.reason`（与设计 §5.2.4 / F1 first-cause 一致）。
3. 测试导出：`__makeQueuedTimeoutReasonForTests` / `__classifyAcquireAbortReasonForTests`（仅测试用）。

**测试**: `packages/coding-agent/test/task/task-spawn.test.ts`

- 集成：cancel 先于 timeout → `cancelled`、无 queued-timeout 文案、metric=0
- 集成：timeout 先于 late cancel → `failed` + queued-timeout、metric=1
- 契约：cancel-then-timeout / timeout-then-cancel 只按 `combinedSignal.reason` 分类

### 8.3 验证证据

| 命令 | 结果 |
|---|---|
| `bun test test/task/task-spawn.test.ts` | **13 pass / 0 fail** |
| `bun test test/task/task-spawn.test.ts test/task/executor-wall-clock.test.ts test/settings-manager.test.ts` | **101 pass / 0 fail** |
| `bun run check:types`（packages/coding-agent） | **clean** |
| latency / workflow 全量 | **未跑**（本轮未改 latency 路径） |

### 8.4 新增修复思考

- post-acquire 原先用 `combinedSignal.aborted \|\| runSignal.aborted \|\| queuedAbortController.signal.aborted` 再 `??` 回退 reason；在 AbortSignal.any 下冗余，且与 HIGH-1 同源风险面。一并收敛到 `combinedSignal` only（服务于同一 first-cause 合同，未扩 scope）。

### 8.5 剩余风险与复审范围

1. **确认 HIGH-1**：cancel/timeout 归因与 metric 不被二次 abort 污染。
2. **HIGH-2 / HIGH-3**：是否接受「转为后续风险」而不阻塞 P0 timeout 合并；若要闭合需另开 latency 修复。
3. **MEDIUM-3 余量**：post-acquire 四 interleaving（含 fake clock）仍可加强。
4. **MEDIUM-1**：长寿命进程 metric once-key 泄漏面。

### 8.6 代码状态

- **P0 queued-timeout first-cause（HIGH-1）**：已修复并验证，**对本轮授权范围可合并**。
- **整体审查原结论 NEEDS_REVISION**：因 HIGH-2/HIGH-3 仍为后续风险，**建议补一轮复审**确认 deferral 与 HIGH-1 修复。

**同会话继续**:
```
直接执行 $code-review 或 /code-review
```

**新会话恢复 prompt**:
```
请阅读实现文档 docs/superpowers/plans/2026-08-04-latency-implementation-acceptance.md、
审查文档 docs/superpowers/plans/2026-08-04-subagent-timeout-latency-code-review.md 的修复记录，
对本轮修复结果补做下一轮检查；重点关注文档中记录的剩余风险与复审范围。
```
