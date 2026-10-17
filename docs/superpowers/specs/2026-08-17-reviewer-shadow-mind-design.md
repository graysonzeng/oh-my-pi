# Design: Reviewer 会话接入 Shadow Mind 全方位 code review

- Date: 2026-08-17
- Status: R2-Draft（Gate NEEDS_REDESIGN 后重做核心合同）
- Scope: M
- revision_round: 2
- design_author: grok
- design_author_identity: cursor-grok-4.6
- planned_reviewer: sol-xhigh-reviewer（gateway/gpt-5.6-sol @ xhigh，只读）
- implementation_authorization: authorized
- authorization_source: 用户 2026-08-17 原话「分析原理，并安装到 oh-my-pi 中，当使用 reviewer 进行 code review 的时候，使用该项目进行全方位评审」；随后确认激活范围、产出形态、sol-xhigh-reviewer 在 code review 时支持；2026-08-17 Gate `NEEDS_REDESIGN` 后用户要求按评审修订方案并再审
- prior_review: docs/superpowers/plans/2026-08-17-reviewer-shadow-mind-subagent-review.md
- scheme: R1（AsyncJobManager 单 owner；显式 invocation metadata；isolatedChild seam）
- r1_reviewed_revision: 2c74addab0f54be9f5a987276224bfe38552e91c（历史 Gate 证据，不是本 R2 正文 digest；本文件不伪造 reviewed_revision）

当前正文作者仅 `cursor-grok-4.6` / grok。R1 与 R2 同一作者 lineage，替换整篇正文。本文在独立 reviewer `PASS` / `PASS_WITH_NOTES` 前不得实现。

证据标签：[历史事实]=源码直接观察；[推导]=由已确认事实推出；[未验证假设]=尚未验证；[拟议但已确定]=本设计拍板；[拟议验收目标]=实现后必须达到的运营/质量门槛。

## 1. 设计目标和范围

### 1.1 要解决的问题

把 `~/tencent/pi-shadow-mind` 的并行认知核接到 oh-my-pi 的 code-review 会话：合格 reviewer 在读 diff 的同时，确定性并行跑 4 个只读 Shadow；Shadow 结论作为 **owner async-result** 回到同一会话；最终 findings / verdict 仍由该 reviewer 写。R1 把完成合同接在扩展布尔值上，无法停驻/失效/settle 现有 yield 状态机；R2 改用已有 `AsyncJobManager` 作为唯一 owner。

### 1.2 成功标准

1. bundled `reviewer` 在 shadow-review 能力开启时，一次并行激活全部 4 维；不是随机 heartbeat。
2. `sol-xhigh-reviewer` **仅当 spawn 显式 `shadowReview: "code"`** 时启动；默认设计评审路径零激活。含 `code review` 字样的 Design Review 不得启动。
3. 主 Agent、`flash-reviewer`、workflow plan/code reviewer、Shadow 子会话自身：零激活。
4. bundled `reviewer` 的 `yield` schema 不变。Shadow 文本不能直接变成 finding。
5. Shadow 子会话不能加载本模块、不能获得 write/bash/MCP/LSP/未授权 custom tools，不能占用 `MAIN_AGENT_ID` 或互相覆盖 registry。
6. 任一维 timeout/error/aborted 时 reviewer 仍能给出 verdict；`silent` / `NOT_RELEVANT` 计为已覆盖无 finding，不得标 uncovered。
7. 扩展未加载、能力关闭、`restrictToolNames`、factory/start 失败时 **fail-open**：不注册 job，reviewer 单核正常结束，prompt 不要求等待报告。
8. 终止 `overall_correctness` yield 在 cohort job 仍 pending 时被停驻；job 的 `async-result` 使旧 yield 失效；最终成功 payload 来自报告到达后的 fresh yield。

### 1.3 本次范围

- 将 Shadow 运行时（轨迹净化、`report_to_main`、并行临时 Session、逐维终态）作为 **library** 放进 `packages/coding-agent/src/shadow-mind/`，由 **task executor** 在合格 spawn 上登记 owner async job。不是 Pi 扩展 factory，不走 `inlineExtensions`。
- 新增 `CreateAgentSessionOptions.isolatedChild` seam，用于 Shadow 子会话。
- Agent frontmatter `shadow-review` 与 task spawn 参数 `shadowReview`。
- 设置项：全局与按 agent 的 enable/rollback。
- 修改 bundled `reviewer.md`：若收到 shadow-review async-result 则当证据复核；**不得**无条件等待。
- 修改 `.omp/agents/sol-xhigh-reviewer.md`：说明仅 spawn `shadowReview: "code"` 时才会收到该类证据；设计评审 schema 仍为 PASS / PASS_WITH_NOTES / NEEDS_REVISION / NEEDS_REDESIGN。

### 1.4 非目标

- 主会话随机旁路（上游默认产品形态）。
- workflow `plan-reviewer.md` / `code-reviewer.md`。
- `flash-reviewer`。
- 文档维护 Shadow。
- 改 findings schema，或让 Shadow 直接 `yield`。
- `create_shadow` 等管理工具；不写 `~/.omp/agent/shadow-minds/`。
- 把 `pi-shadow-mind` 当 npm/plugin 依赖；不改上游仓库。
- 新建第二套 yield/quiescence 引擎，或给 `ExtensionRunner` 加只有计数的 `hasBackgroundWork`。
- 用 prompt 子串判断 `sol-xhigh-reviewer` 是否在做 code review。
- 自动把 kill switch 持久写进用户 settings（进程内 fail-open + 设置项由操作者关闭）。

## 2. 背景与约束

[历史事实] 上游 Shadow Mind：`turn_end` heartbeat（默认 1/3）后按 Shadow `activation_probability`（默认 0.3）抽选，最多 2 路。每次激活新建临时 Session，继承主 system prompt，净化轨迹；`report_to_main` 终止。首次 session 会建 registry/config **目录结构**，但不创建默认 Shadow **定义**。`ShadowRunResult.reason` 为 `report | silent | timeout | aborted | error`。来源：`~/tencent/pi-shadow-mind/src/config.ts`、`scheduler.ts`、`runtime.ts`、`shadow-runner.ts:72-100`、`protocol.ts`、`README.md:84-101`。

[历史事实] 子 Agent 终止 yield 是否停驻，由 monitor 在工具结束时调用 `sessionHasPendingAsyncWork()` 决定（`executor.ts:1129-1130,1442-1448`）。`hasPendingAsyncWork()` 看 owner 名下未抑制的 running jobs、pending deliveries、以及 yield queue 上的 `async-result`（`agent-session.ts:1771-1796`）。`settleAsyncWork()` 等待 owner jobs、drain deliveries、再 `waitForIdle`（`:1806-1811`）。旧 yield 仅在 `customType === "async-result"` 注入时失效（`executor.ts:1354-1358`；`ASYNC_RESULT_MESSAGE_TYPE` 于 `async-job-delivery.ts:21`）。

[历史事实] `AsyncJobManager.register("bash"|"task", label, run, { ownerId, agentId })` 在 job 完成时 `#enqueueDelivery`，由该 owner 的 delivery sink 注入 `async-result`（`job-manager.ts:177-261`；`agent-session.ts` 为每个 agentId 登记 sink）。

[历史事实] `restrictToolNames: true` 跳过 inline factories 与 custom-tool 发现，但也丢弃 `options.customTools`（`sdk.ts:2048-2097,2707-2710`）。`disableExtensionDiscovery` 不跳过 inline factories。未传 `model` 时从 settings 选模型；未传 `sessionManager` 时创建持久 session；未传 `agentId` 时默认 `MAIN_AGENT_ID`/`"main"`（`sdk.ts:384-396,1394-1398,1702-1706`）。`AgentRegistry.register` 同 key 覆盖（`agent-registry.ts:89-104`）。

[历史事实] 扩展 `turn_end` handler 超时 30s（`runner.ts:73-104`）。`ExtensionAPI.sendMessage` 返回 `void`；executor 只在 `session_start` 后 drain `pendingExtensionMessages`（`executor.ts:3005-3063`）。

[历史事实] bundled `reviewer.md` 为 code review + yield schema；`.omp/agents/sol-xhigh-reviewer.md` 为设计评审，verdict 四选一含 `PASS_WITH_NOTES`，带 `write`。

[推导] 任何不经 `AsyncJobManager` 且不以 `async-result` 注入的 Shadow 报告，都不会停驻终止 yield，也不会使旧 yield 失效。

[推导] 现有 flags 无法同时「只要 `report_to_main` + read/grep/glob」且「不要 inline/MCP/LSP/发现到的 custom tools」。需要新的 `isolatedChild` seam，而不是改 `restrictToolNames` 的历史语义。

## 3. 根因分析

### 3.1 是否需要根因分析

- 需要
- 理由：R1 Gate 因核心合同失败。方案选择取决于「完成/yield 的 canonical owner 是谁」；该成因已由源码核验，不再未知。

### 3.2 已确认事实

- 完成屏障的 owner 是 `AsyncJobManager` + `SubagentRunMonitor` + `async-result` delivery，不是 `ExtensionRunner`。证据：§2 引用的 executor / agent-session / async-job-delivery。
- R1 拟议的 `trackBackgroundWork` 无法从 `ExtensionFactory`/`ExtensionContext` 登记，也没有 settle/delivery/invalidation。证据：R1 spec 与 `types.ts` ExtensionAPI 表面。
- 静态 prompt 等待与 fail-open 互斥。证据：R1 spec §5.4/5.5 与 `sdk.ts` restrictToolNames 跳过 inline。

### 3.3 未确认假设

- 4 路真模型并行的净质量、p95、费用。[拟议验收目标] 用固定 corpus 的 control/treatment 测量，不在设计阶段假装已知。

### 3.4 对设计的影响

- 必须改用 AsyncJobManager 单 owner（方案 R1），放弃扩展布尔屏障（旧方案 1）。
- prompt 只能消费证据，不能当完成锁。
- 资格必须是 spawn/frontmatter/settings 显式 metadata，不能是 prompt 子串。

## 4. 方案对比

### 4.1 方案 R1（选定）

- 核心思路：task executor 在合格 spawn 上、第一次 `prompt` 之前，向 reviewer 的 `AsyncJobManager` 登记 **一个** cohort job（`type: "task"`，`ownerId = reviewer agentId`）。job 内并行 4 个 `isolatedChild` Session；完成后把结构化报告作为 job 返回值，走现有 `async-result` delivery。
- 优点：停驻、settle、delivery、fresh-yield、abort/reap 全部复用现有合同；fail-open = 不登记 job；无 30s handler 问题；不引入第二引擎。
- 缺点：要加 `isolatedChild` 与 spawn/frontmatter/settings；Shadow 不是 Pi 扩展（运行时仍移植）。
- 适用前提：要可靠完成语义，且可改 coding-agent。

### 4.2 方案 R2

- 核心思路：保留 Extension factory，但 `ExtensionAPI` 增加 `registerAsyncJob`，内部只转调同一 `AsyncJobManager`。
- 优点：更像上游「扩展」。
- 缺点：合格判定仍要在 handler 里做；`turn_end` 仍受 30s 限制（只能 fire-and-forget 再 register job——但 job 应在 prompt 前登记才能从第一轮就停驻）；扩展加载失败时仍无 handshake，和 fail-open 纠缠。相对 R1 多一层无必要的 API。
- 适用前提：必须保持 extension 形态。

### 4.3 方案 R0（已否决的 R1 正文）

- 核心思路：`ExtensionRunner.hasBackgroundWork` + prompt 等待 `shadow-report`。
- 优点：表面上像扩展。
- 缺点：B-01/B-02 已证明不能停驻 yield、不能 fail-open。
- 适用前提：无。

### 4.4 选型结论

- 选择：方案 R1
- 理由：唯一把 Shadow 工作接到现有 structured-concurrency owner 上、且能 fail-open 的路径。R2 多一层扩展 API 却仍要把 job 登记提前到 prompt 之前，等于把逻辑放回 executor。

## 5. 详细方案

### 5.1 核心思路

```text
parent spawn reviewer（shadow-review 能力开启）
        │
        ▼
createAgentSession(reviewer)
        │
        ├─ 若 qualified：asyncJobManager.register("task", "shadow-review", cohortRun,
        │       { ownerId: reviewerAgentId, agentId: reviewerAgentId })
        │     此时 hasPendingAsyncWork() === true
        │
        ▼
driveSessionToYield → prompt(task)   ← 与 cohort 并行
        │
        ├─ cohort job：
        │     4 × isolatedChild Shadow（read/grep/glob + report_to_main）
        │     墙钟 drain → 返回结构化文本
        │     #enqueueDelivery → async-result follow-up
        │
        ├─ 若 reviewer 在 job 完成前 yield overall_correctness
        │     monitor 见 pending async work → 停驻，不 terminate
        │     async-result 注入 → 旧 yield 失效 → fresh yield
        │
        └─ 若未 qualified / 设置关闭：不登记 job，单核结束
```

Shadow 模块是 executor 调用的 library，**不**注册 `createShadowMindExtension`。

### 5.2 资格判定（显式 metadata，禁止 prompt 子串）

Canonical 信号只有三层，按优先级：

1. **Spawn 参数** `TaskParams.shadowReview`：`"code"` | `"off"`。缺省则看下一层。
2. **设置** `task.shadowReview.enabled`（bool，默认 `true`）与 `task.shadowReview.agents`（`Record<string, boolean>`）。agent 键为 agent `name`。某 agent 显式 `false` 则关闭。全局 `enabled: false` 关闭所有。
3. **Agent frontmatter** `shadow-review: code`。仅 bundled `reviewer.md` 设置此项。`sol-xhigh-reviewer.md` **不**设，因此默认不启动。

Qualified 当且仅当：全局 enabled **且** 该 agent 未被 per-agent false **且**（spawn `"code"` **或**（spawn 缺省 **且** frontmatter `code`））。spawn `"off"` 永远 unqualified。

[拟议但已确定] 不读取 `before_agent_start.prompt`。评审「code-review 功能设计」的 `sol-xhigh-reviewer` 任务即使含 `git diff` / `overall_correctness` 也不启动。要用该 agent 做 code review，调用方必须传 `shadowReview: "code"`。

False-positive / false-negative corpus（测试必须覆盖）：

| 调用 | 期望 |
|---|---|
| bundled `reviewer`，无 spawn 覆盖，enabled true | 启动 |
| bundled `reviewer`，`shadowReview: "off"` | 不启动 |
| bundled `reviewer`，`task.shadowReview.enabled: false` | 不启动 |
| `sol-xhigh-reviewer`，无 spawn 覆盖，prompt 含 `code review`+`NEEDS_REDESIGN` | 不启动 |
| `sol-xhigh-reviewer`，`shadowReview: "code"` | 启动 |
| `flash-reviewer` / `"main"` / workflow code-reviewer | 不启动 |
| Shadow 子会话 `agentDisplayName` 以 `shadow:` 开头 | 不启动 |

### 5.3 关键数据流 / 控制流

1. `executeTask` 解析 agent 后计算 `qualified`（§5.2）。`restrictToolNames === true` 的 **reviewer 会话**视为 unqualified（与「restricted 单核」一致，fail-open）。
2. `createAgentSession` 得到 reviewer session 后、`prompt(task)` 前：若 qualified 且 `session.asyncJobManager` 与 `session.getAgentId()` 均存在，则 `register` 一个 cohort job。登记失败（无 manager、达 maxRunningJobs）→ 记日志，**不**阻塞 spawn，fail-open。
3. `driveSessionToYield` 原样运行。不改 yield schema。不改 `sessionHasPendingAsyncWork` 的实现；它已经会看到该 job。
4. cohort `run`：
   1. `markRunning()`。
   2. 并行启动 4 个 Shadow（`Promise.allSettled`），每个 `timeout_seconds = 90`（[拟议但已确定]，不是上游默认 300s）。
   3. 墙钟 `drainTimeoutSeconds = 120`（[拟议但已确定]）到点则 abort 未完成 child。
   4. 汇总逐维终态，返回 **纯文本报告**（LLM 展示层）+ 在 job `latestDetails` 写入结构化 `dimensions[]`。
   5. 返回字符串；manager 按现有路径 delivery。
5. Reviewer 侧把 `async-result`（label `shadow-review`）当证据。bundled reviewer 按原 criteria 复核后才写入 findings。
6. Parent abort / reviewer session shutdown / 新用户 input：`cancel` 该 job；job 的 `signal` abort 全部 child；每个 child `finally session.dispose()`，exactly-once。
7. 每个 reviewer epoch/spawn 只登记一轮。不在 `turn_end` 再启动第二轮。

Shadow 启动与 reviewer 第一轮 **并行**（不等第一轮 turn_end），以降低墙钟延迟。轨迹在启动时可能只有 spawn task；各 Shadow 用 read/grep/glob 独立读 packet/diff。

### 5.4 接口 / 配置 / 数据结构变更

**Library 落点**

`packages/coding-agent/src/shadow-mind/`：`runShadowCohort`、轨迹净化（移植上游 `sanitizeTrajectory`）、`report_to_main`、四份 shadow markdown。executor 调用；**不** `inlineExtensions.push`。

**`CreateAgentSessionOptions.isolatedChild`**（[拟议但已确定] 新 seam）

当 `isolatedChild: true`：

- 不跑 inline factories（含 autoresearch 与任何将来的 builtin）。
- `disableExtensionDiscovery` 视为 true。
- 不发现 custom tools / MCP / LSP / skills / commands；`enableMCP: false`，`enableLsp: false`。
- **保留** 调用方传入的 `customTools` 与 `toolNames`。
- 调用方必须同时传：`model`、`thinkingLevel`（现有 `ConfiguredThinkingLevel`，来自父 session 的 `session.thinkingLevel`）、`sessionManager: SessionManager.inMemory(cwd)`、唯一 `agentId`、`parentAgentId`、`agentDisplayName: "shadow:<id>"`。

每个 Shadow 的 `agentId` 为 `${reviewerAgentId}:shadow:${shadowId}`，保证四路与 Main 不撞 `AgentRegistry` key。

工具：`toolNames: ["read","grep","glob","report_to_main"]`，`customTools: [report_to_main]`。`report_to_main` 调用后 terminate 该 Shadow loop（与上游一致）。

system prompt：`parent.getSystemPrompt().join("\n\n")` 再套上游 Shadow protocol 包装（`buildShadowSystemPrompt` / `buildShadowRequest` 的 omp 移植）。thinking 只读 `session.thinkingLevel` / 创建选项，**不**给 `ExtensionContext` 新增 `thinkingLevel` 字段。

**不改 `ExtensionContext` 必填字段。** 不新增 `hasBackgroundWork`。资格不依赖 `agentDisplayName` 字符串匹配作为唯一信号（frontmatter/spawn/settings 才是 canonical；displayName 仅用于 Shadow child 标识）。

**Task / agent**

- `TaskParams.shadowReview?: "code" | "off"`；task 工具 schema 增加可选字段。
- `ParsedAgentFields.shadowReview?: "code"`；`parseAgentFields` 读取 `shadow-review`。
- bundled `reviewer.md` frontmatter：`shadow-review: code`。
- `sol-xhigh-reviewer.md`：不设该字段；正文增加一句：仅当调用方传 `shadowReview: "code"` 时可能收到 shadow-review async-result。

**设置**

- `task.shadowReview.enabled`: boolean，默认 `true`。
- `task.shadowReview.agents`: record，默认 `{}`。把 `sol-xhigh-reviewer` 设为 `false` 可在误传 spawn 时仍关闭。

**报告形状**

Job 返回文本（展示层）与 `details.shadowReview`（结构化，[拟议但已确定]）：

```ts
type ShadowDimensionStatus =
  | "reported"
  | "completed_no_finding"  // silent / NOT_RELEVANT
  | "timeout"
  | "error"
  | "aborted";

interface ShadowDimensionResult {
  id: string; // architecture-review | grounded-review | correctness-review | completion-review
  status: ShadowDimensionStatus;
  content?: string; // 仅 reported
  error?: string;
  durationMs: number;
}
```

`covered` = `reported` ∪ `completed_no_finding`。`uncovered` = `timeout` ∪ `error` ∪ `aborted`。

去重键（reviewer 侧，[拟议但已确定]）：`file_path` + `line_start` + 规范化 `title`。同一键只保留一条 finding；Shadow 与主 reviewer 撞键时保留主 reviewer 表述，explanation 可注明「与 shadow X 一致」。

**内置 4 维**（职责同 R1，终态语义按上表）：architecture-review、grounded-review、correctness-review、completion-review。

**prompt**

- `reviewer.md`：若本轮出现 label 为 `shadow-review` 的 async-result，将其当证据，经现有 criteria 复核后才可写入 findings；**没有**该消息时照常单核完成，**禁止**等待。
- `sol-xhigh-reviewer.md`：设计评审路径不变（四选一含 `PASS_WITH_NOTES`）。仅 spawn `shadowReview: "code"` 时把同类 async-result 当证据；不要求 `yield findings`。

### 5.5 错误处理与回退策略

| 情况 | 行为 |
|---|---|
| 未 qualified | 不登记 job；单核 |
| 无 AsyncJobManager / register 抛错 | 日志；单核 |
| 全局或 per-agent 关闭 | 不登记 job |
| 某 Shadow create/model 失败 | 该维 `error`；其余继续 |
| 单维 >90s | abort 该 child；`timeout` |
| 墙钟 >120s | abort 其余；已完成保留 |
| silent / NOT_RELEVANT | `completed_no_finding`；covered |
| job 被 cancel（parent abort/shutdown） | 全部 child abort+dispose；若尚未 delivery 则无 async-result，reviewer 因 job 结束而解除 pending；已 yield 则按现有 abort 分类 |
| delivery/send 失败 | job 仍会进入 completed/failed 并 enqueue；sink 失败已有 manager 日志。不得留下永久 pending running job |
| Shadow 无锚点声称 | reviewer 丢弃，不写 findings |
| 质量/成本越界 | 进程内跳过后续登记（fail-open）+ 日志；操作者把 settings 设 false 做持久 rollback |

不向 reviewer 注入非 `async-result` 的 `shadow-report` custom type（避免无法失效旧 yield）。

### 5.6 风险与缓解

- 风险：提前 terminate 丢报告。缓解：cohort job 使 `hasPendingAsyncWork` 在 prompt 前为 true；只用 `async-result` 失效 yield。
- 风险：prompt 死等。缓解：prompt 明确无消息则单核；不登记 job 时无消息。
- 风险：child 工具/扩展泄漏。缓解：`isolatedChild` + 唯一 agentId + inMemory + 显式 toolNames。
- 风险：设计评审误触发。缓解：显式 metadata；corpus 测试。
- 风险：silent 被当失败。缓解：`completed_no_finding` ∈ covered。
- 风险：费用与质量。缓解：kill switch、观测字段、§6 的 A/B 与 stop conditions。
- 风险：`isolatedChild` 改 SDK。缓解：additive 选项，默认关闭，不改变现有 `restrictToolNames` 语义。

## 6. 验证计划

### 6.1 合并门禁（必须写测试并跑过）

1. **停驻**：qualified spawn 在 cohort job running 时，模拟 overall yield；monitor 不得 `requestAbort("terminate")`；对照 `executor-async-quiescence.test.ts` 的 pending-owner 行为。
2. **失效**：job 完成后注入 `async-result`；`yieldCalled` 被清掉；最终 payload 来自后续 fresh yield。
3. **fail-open**：unqualified / enabled false / restrictToolNames / register 失败 → 无 job，单核 yield 可在无 async-result 时结束。
4. **终态**：四维 `reported`、`completed_no_finding`、`timeout`、`error` 各至少一条 fixture；silent 不得出现在 uncovered。
5. **isolatedChild**：child 的 active tools 仅为 read/grep/glob/report_to_main；无 bash/write；无 inline extension；`sessionFile` 为空（inMemory）；`agentId` 四路互异且不等于 `MAIN_AGENT_ID`；`model` 等于父 model。
6. **资格 corpus**：§5.2 表逐条。
7. **reap**：parent abort 后四 child dispose 次数 = 4，无第二次 dispose；无遗留 running jobs。
8. **prompt**：`reviewer.md` 含「有则复核、无则单核、禁止等待」；`sol-xhigh-reviewer.md` 保留四选一含 `PASS_WITH_NOTES`。
9. 现有 reviewer yield schema 测试与 `executor-async-quiescence` 保持通过。
10. **真 session smoke（实现完成门禁，不是「可选」）**：固定 fixture patch + evidence packet，spawn bundled `reviewer`；断言 4 个逐维终态、恰好一个 shadow-review async-result、fresh final yield 符合原 schema、child 已 dispose。可用 mock 模型，但必须走真实 `createAgentSession` + `AsyncJobManager` + `driveSessionToYield`，不得只 mock `disableExtensionDiscovery` 参数。

### 6.2 A/B 与运营（[拟议验收目标]，默认开启前必须有记录）

- Control：`task.shadowReview.enabled: false`。Treatment：`true`。同一 packet、同一 reviewer 模型与 effort，唯一变量为 Shadow。
- 每个 session 写 custom entry `shadow-review-observation`：`sessionId`、`arm`、`agent`、`dimensionStatuses`、`wallMs`、`findingFingerprints`、`startedAt`/`endedAt`。区间按 sessionId 不重叠；禁止同一 session 计入两个 arm。
- Pilot：固定 corpus ≥10 对 control/treatment。记录后再决定是否保持默认 `enabled: true`。
- 去重：最终 findings 按 §5.4 键唯一；重复率 = 1 - unique/total。
- 独立 rollback：全局 `enabled`；`task.shadowReview.agents.reviewer`；`task.shadowReview.agents.sol-xhigh-reviewer`。completion 基础设施（isolatedChild/job 登记）与资格分支可分别关闭：关资格即不登记 job。
- Stop conditions（越界则进程内不再登记 job，fail-open）：
  - 滚动 20 次 treatment：维度 `timeout|error` 率 > 25%
  - 最终 yield schema 完成率 < 90%
  - 去重后仍重复的 fingerprint 率 > 30%
  - p95 墙钟 > 2.5 × 同期 control
  - 任一 P0：child 出现 write/bash、parent 在 job running 时 terminate、registry agentId 碰撞

未跑完 §6.1 不得声称 fixed/passing。未跑 §6.2 不得声称质量已证明；默认 `enabled: true` 可在 §6.1 通过后合并，但必须带 kill switch，并在 changelog 标明 A/B 未完成。

## 7. 关键决策摘要

1. Canonical owner 是 reviewer 会话的 `AsyncJobManager` cohort job + 现有 `async-result` 停驻/失效/settle；删除 R1 的 `hasBackgroundWork` / `shadow-report` custom type。
2. Shadow 是 executor 调用的 library，不是 inline 扩展。
3. 资格只有 spawn / settings / frontmatter；禁止 prompt 子串。`sol-xhigh-reviewer` 默认关，需显式 `shadowReview: "code"`。
4. prompt 只消费证据，无条件等待禁止；fail-open = 不登记 job。
5. `isolatedChild` 是唯一新 SDK seam；不放宽、也不改变现有 `restrictToolNames` 丢弃 discovered tools 的语义。
6. 逐维终态含 `completed_no_finding`；silent 不是 uncovered。
7. 不新增 ExtensionContext 必填字段；模型用父 `session.model`，thinking 用现有 `thinkingLevel` 类型。
8. 单维 90s 与 cohort 墙钟 120s 均为 [拟议但已确定] 运行参数，不是上游默认 300s。R2 无独立 batch window：一个 cohort job 只 delivery 一次。
9. §6.1 真 session 闭环是合并门禁；§6.2 A/B 是质量证明门禁。

## 8. Handoff

### 8.1 同会话继续

宿主原生路径：`按当前宿主规则触发与 cursor-grok-4.6 异模型的只读 sol-xhigh-reviewer（gateway/gpt-5.6-sol @ xhigh）；不得通过 shell 启动模型 CLI / worker。落盘 docs/superpowers/plans/2026-08-17-reviewer-shadow-mind-subagent-review-round-2.md。`

### 8.2 新会话恢复 prompt

```text
请读取完整设计输入集合（docs/superpowers/specs/2026-08-17-reviewer-shadow-mind-design.md 与 docs/superpowers/plans/2026-08-17-reviewer-shadow-mind-subagent-review.md），生成按 normalized path 排序的 path + SHA-256 `Reviewed Inputs` manifest，并计算 `reviewed_revision`；pre-review handoff 不伪造 digest。设计元数据：design_author=grok；revision_round=2；implementation_authorization=authorized；authorization_source=用户 2026-08-17 原安装请求 + NEEDS_REDESIGN 后要求按评审修订并再审。
使用起草前选定且与全部内容作者异模型的只读 sol-xhigh-reviewer（gateway/gpt-5.6-sol @ xhigh）执行独立 Design Review；将完整 review artifact 持久化到 docs/superpowers/plans/2026-08-17-reviewer-shadow-mind-subagent-review-round-2.md。按宿主记录 review_mode=host-native、author/reviewer native agent_id、model、verdict、授权来源与证据；不得通过 shell 启动模型 CLI / worker。
必须逐条核验 R1 阻断项 B-01/B-02 与 Major M-01…M-05 是否被 R2 合同关闭，并对照 packages/coding-agent/src/task/executor.ts、session/agent-session.ts、async/job-manager.ts、session/async-job-delivery.ts、sdk.ts 的当前源码。
评审结论必须为 PASS / PASS_WITH_NOTES / NEEDS_REVISION / NEEDS_REDESIGN 四选一，并附可复查证据；禁止作者自审。
NEEDS_REVISION 时回到当前设计文档修订；NEEDS_REDESIGN 时回到 design-brainstorm 重做方案；正文变更后均须重新执行 Gate，且在通过前不得实现。
PASS/PASS_WITH_NOTES 后，current Inputs manifest 等于 reviewed manifest 或存在覆盖全部输入的有效 Gate Continuity Note，且 implementation_authorization=authorized，才继续 design-implement；design-only 必须停止。
```
