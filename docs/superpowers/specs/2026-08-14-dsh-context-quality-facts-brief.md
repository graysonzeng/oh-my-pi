---
Date: 2026-08-15
Status: R8-Draft
Scope: L
design_author: grok
design_author_identity: GrokDesigner
original_author_agent_id: Opus5Designer
original_author_model: gateway/claude-opus-5
prior_replacement_author_agent_id: Opus5DesignerR2
prior_replacement_author_model: gateway/claude-opus-5
current_replacement_author_agent_id: GrokDesigner
current_replacement_author_model: gateway/grok-4.6
planned_reviewer: DSHGateReviewer（gateway/gpt-5.6-sol，xhigh，只读）
implementation_authorization: design-only
authorization_source: 用户 2026-08-14 原要求将 DSH 对照分析沉淀为可评审设计并在新会话 review 后实现；用户随后明确停止使用 Claude，改用 Grok 4.6 完成设计；当前仍未授权实现
revision_chain: R1=29376c342d51623b4fffec99744f3e95e9311bb73d879487d8507fea02914d25 R2=35ae33776c345a05503f01b1aec9d2c61d390fc52a0536a2307dc4fc605d2a75 R3=c7f886c4ecae8d674d242a0c1d1ed2e2050fc279574c3fe7cdce516b2fb082c4 R4_reviewed_revision=cfc3287dcc8c720edfe0a99f4e1094e7025759e0349df067e9d2bd293ad42c32 R4_design_raw_sha256=ef959c5eef5483051c5bbd9347c30b4e76cfbfc3ffc4108f0dbfb67cfd5c13c9 R5_reviewed_revision=12d3704d0e2860286a01687a17c320c710560fb402ee903e5c1a74c3f59e9459 R5_design_raw_sha256=60bf21b25db4cb798b0e8880fec61f759124521533f8436d6fd606034c7a133f R6_reviewed_revision=a5d09b488400c47d99ef2826dfc5ff5edbacba38da5e8fa8476808e93e5f2fc0 R6_design_raw_sha256=8bc89ced38d6c602b813b203e3dbab99c4c941f93adcd4695436de6b23576b5c R7_reviewed_revision=72a6e043f5f07c6d8ac1997be6013a5d5a1abbc3d55665bd3234ec4f2fe188ea R7_design_raw_sha256=5c7b96810a2f052b6d41d4568ded41a22d15eb05ed59fbd0ca728fbeef593751 R7_facts_raw_sha256=30327b413acaabaad381d36ee18160b77869eda6f5ce4e326ff967596b164f5a
failed_no_write_attempts: Opus5DesignerR3, Opus5DesignerR4（provider/auth/account，无正文落盘，不是 content author）
r7_reviewed_revision_note: R7 reviewed_revision 仅为历史 Gate 证据，不是本 R8 正文 digest；本文件不伪造 reviewed_revision
---

# DSH Context Quality：事实简报（第八版 · GrokDesigner）

> **标注规则**：[历史事实] = 已读当前源码直接观察；[推导] = 从事实推导；[未验证假设] = 合理但尚未验证；[拟议但已确定] = 本设计作者给出的拟议值，供实现/实验 owner 执行，不得当作当前源码已存在的事实。
>
> **当前正文作者**：仅 `GrokDesigner` / `gateway/grok-4.6`。Claude 作者只属于 R1–R7 历史修订。`Opus5DesignerR3` / `Opus5DesignerR4` 是无写盘失败尝试，不是 content author。
>
> **design-only**：本文件不修改产品代码，不授权实现。

---

## 0. 本版相对 R7 的证据纠正

R7 facts 把 `CompactionEntry.firstKeptEntryId` 标成 `session-entries.ts:100`。当前源码该字段在 `packages/coding-agent/src/session/session-entries.ts:96`；`:100` 是 `preserveData?`。[历史事实]

R7 设计把尚不存在的 `DshFeatureOverrides` / `effectiveSetting` / `globalDshKillSwitch` 写成 session feature-flag canonical owner。当前 `AgentSessionConfig`（`agent-session-types.ts:100-233`）没有这些字段。[历史事实]

R8 Gate（R8-M1）：`freezeLatencyArmSnapshot`（`arms.ts:90-105`）只检查 `combinedArmId` 出现时 `childArms.length >= 2` 且 ID 合法；`buildLatencyRolloutDecision`（`:270-273`）只检查 `combinedArmId` 存在且 `childArms.length >= 2`。二者都**不**验证 `childArms` 集合等于全部 active arms。把 “exhaustive registered combination / 未注册 multi-arm 一定 `missing_attribution` fail-closed” 写成当前源码能力是过强标签。[历史事实]

四个默认 `true` 的 latency arm：`modelOptimization.enabled`（`settings-schema.ts:4511-4513`）、`latency.arms.readDedupe`（`:4540-4542`）、`latency.arms.bashAdvisory`（`:4573-4575`）、`latency.arms.bashBoundedInjection`（`:4584-4586`）。因此生产 snapshot 在只开一个 DSH 臂时仍是 multi-arm，不是单臂。[历史事实]

`deriveLatencyCombination`（`arms.ts:209-217`）对 ≥2 个 active 生成**单一** `combined:<sorted.join("+")>`，`childArms` = 全部 active。`deriveLatencyCohortKey`（`rollout-cohort.ts:44-49`）在 active≥2 时只有一个 key。[历史事实]

`LatencyRolloutCohortStore.readAll`（`rollout-cohort.ts:181-201`）丢弃 `kind !== "latency_rollout_observation"` 的行。`LATENCY_ROLLOUT_DECISION_KIND = "latency-rollout-decision"`（`arms.ts:223`）今日**不**写入该 JSONL；decision 只用于进程内 `settings.override`。[历史事实]

exact-set validation（`childArms` 排序后 === 全部 active，且该集合在 `REGISTERED_COMBINATIONS` 内，否则 `attributionKnown=false`）是同一 owner 上的 **[拟议但已确定]** 增强，不是当前源码行为。

---

## OutputSink API [历史事实]

- `DEFAULT_MAX_BYTES = 50 * 1024`（50 KiB UTF-8 bytes）（`packages/coding-agent/src/session/streaming-output.ts:11`）。
- `OutputSinkOptions.spillThreshold`（**不是** `maxBytes`）是 inline body budget（`:53-61`）。
- 公共写入：`push(chunk: string): void`（`:853-865`）。
- 获取结果：`async dump(notice?: string): Promise<OutputSummary>`（`:1263-1275`），返回 `{ output, truncated, ... }`。
- `truncateHeadBytes(data, maxBytes): ByteTruncationResult`（`:255-257`）走 `truncateBytesWindowed(..., "head")`，UTF-8 boundary-safe。用于 args_snippet 展示截断（拟议上限 256 UTF-8 bytes，无 U+FFFD）。

---

## Session Journal [历史事实]

- omp session journal 是 JSONL，由 `SessionManager` 管理。
- `getAgentDbPath()` 的 `agent.db` 用于 settings/auth（如 `cli/auth-broker-cli.ts` 打开 `SqliteAuthCredentialStore`），不存储 session entries；repo 中不存在 `session_entries` 表。
- `HistoryStorage`（`session/history-storage.ts:31-70`）只索引 `history.prompt`（及 cwd/session_id），不是 session journal owner。
- `SessionManager.appendCustomEntry(customType, data)`（`session-manager.ts:2038-2041`）向 JSONL 追加 `CustomEntry`。
- `SessionManager.flush()`（`session-manager.ts:1515-1518`）：persist 时 flush writer；dispose 前可调用确保落盘。

---

## Session Entry 类型与 AgentMessage 结构 [历史事实]

- `SessionMessageEntry`（`session-entries.ts:63-66`）：`{ type: "message"; message: AgentMessage }`。
- **`ToolCall`**（`packages/ai/src/types.ts:753-758`）：`{ type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }`（omp normalized shape，不是 provider wire `tool_use/input`）。
- **`TextContent`**（`types.ts:643-647`）：`{ type: "text"; text: string }`。
- **`ToolResultMessage`**（`types.ts:886-915`）：`{ role: "toolResult"; toolCallId; toolName; content: (TextContent | ImageContent)[]; isError: boolean }`。

---

## UTF-8 Boundary-safe 截断约束 [推导]

- `Buffer.from(json,"utf-8").slice(0,256).toString("utf-8")` 不 boundary-safe（可产生 U+FFFD 或展示字节超限）。
- 正确方法：`truncateHeadBytes(JSON.stringify(arguments), 256).text`。
- 查询匹配须用完整 `JSON.stringify(arguments)`，只在展示时截断。
- 验收：`Buffer.byteLength(args_snippet,"utf8") <= 256`；无 U+FFFD；ASCII/CJK/4-byte emoji 边界正确。

---

## firstKeptEntryId 与 active/compacted 分类 [历史事实]

- `CompactionEntry.firstKeptEntryId: string` 在 `session-entries.ts:96`。无顶层 `remoteReplacementHistory` 字段。
- remote compaction 相关数据在 `preserveData`（`session-context.ts:368-371` 读 `compaction.preserveData?.openaiRemoteCompaction`）。其存在不意味着 local raw entries 不可用。
- 分类方法（`session-context.ts:401-437`）：找 compaction 在 branch path 中的 index；从 path 起点走到 compaction 之前，`entry.id === firstKeptEntryId` 起为 kept/active 起点；compaction 之后的 path 段为 post-compaction。无 compaction 则全 path 发射。
- A1 拟议分类（与 context builder 对齐，但是检索用）：P = `entry.id === latestCompaction.firstKeptEntryId` 的 position；`path[0..P-1]` = compacted，`path[P..currentCallPos-1]` = active。[拟议但已确定]
- journal 不完整（walk 结束仍 `foundFirstKept===false`）[推导]：fail-loud，`isError: true`。

---

## ToolSession Seam [历史事实]

- `ToolSession.sessionManager?`（`tools/index.ts:250-251`）：`Pick<SessionManager, "appendCustomEntry" | "ensureOnDisk" | "flush" | "getBranch" | "getEntries">`，可选。
- Executor 收到 `toolCallId`（例：`tools/todo.ts:826-832` 的 `execute(_toolCallId, ...)`）。
- 已有 arm seam（`tools/index.ts:327-336`）：
  - `isLatencyArmEnabled?: (arm: LatencyArmId) => boolean`
  - `getLatencyArmSnapshot?: () => LatencyArmSnapshotV1`
  - `markLatencyArmFired?: (arm: LatencyArmId) => void`
  - `getFiredLatencyArms?: () => LatencyArmId[]`
  - `invalidateLatencyArmSnapshot?: () => void`
- `ToolSession` **没有** `config` / `dshFeatureOverrides` 字段。
- `ToolFactory = (session: ToolSession) => Tool | null | Promise<Tool | null>`（`tools/index.ts:426`）。`createTools` 对 factory 返回 `null` 会跳过该工具（`:680-688`）。
- `BUILTIN_TOOL_NAMES`（`tools/builtin-names.ts:1-31`）当前无 `session_search`。`HIDDEN_TOOL_NAMES` 仅为 `yield` / `goal`。

---

## Settings Schema 合法值 [历史事实]

- 合法 `SettingTab`（`settings-schema.ts:74-84`）：`appearance | model | interaction | context | memory | files | shell | tools | tasks | providers`。
- `tools` tab groups（`:141-151`）：`Available Tools | Todos | Grep & Browser | Computer | GitHub | Output Limits | Execution | Discovery & MCP | Developer`。
- `tasks` tab groups（`:152`）：`Modes | Subagents | Isolation | Commands & Skills`。
- `UiBase` 强制 `label: string` 与 `description: string`（`:190-198`）；`group` 若填写必须属于 `TAB_GROUPS[tab]`。
- `goal.continuationModes`（`:4342-4351`）：`type: "array"`，default `["interactive"]`，tab `tasks` / group `Modes`。
- latency arm settings（`:4511-4627`）已存在，且注释写明 independently rollbackable、production quality-stop wiring。`context_optimization` 复用 `modelOptimization.enabled`。

---

## AgentSessionConfig [历史事实]

- `AgentSessionConfig`（`agent-session-types.ts:100-233`）含 `agent`、`sessionManager`、`settings`、`agentKind?: "main" | "sub"` 等。
- **没有** `dshFeatureOverrides` / `allowHeadlessGoalContinuation` 字段。
- `agentKind`：`sdk.ts:1700` 按 `taskDepth/parentTaskPrefix` 赋 `"sub"` 或 `"main"`。

---

## Canonical behavior-arm / rollout owner [历史事实]

现有唯一生产 arm/quality-stop owner 在 latency 子系统，不是一套空壳注释：

- `packages/coding-agent/src/latency/arms.ts:4-11`：arms 为 session-frozen、independently rollbackable；combined experiments 必须有 registered combination；生产 quality-stop data plane + fired-arm attribution。
- `LATENCY_ARM_IDS`（`:14-24`）九个 latency arm；`LATENCY_ARM_SETTINGS`（`:29-39`）映射到 settings path。
- `LatencyArmSnapshotV1`（`:44-57`）：`arms`、`combinedArmId?`、`childArms?`、`frozenAt`、`codeRevision?`、`configHash?`、`fingerprint`。
- `resolveLatencyArmsFromSettings`（`:74-84`）：`get(path) === true` 才为 true，否则 false。
- `freezeLatencyArmSnapshot`（`:90-122`）：fingerprint = SHA-256(JSON payload)；`combinedArmId` 必须带至少两个 `childArms`。
- `deriveLatencyCombination`（`:209-217`）：≥2 个 active arm 时生成 `combined:<sorted.join("+")>`。
- `evaluateLatencyQualityStop`（`:161-173`）：当调用方传入 `attributionKnown===false` 时返回 `missing_attribution` 并 stop。[历史事实]
- `buildLatencyRolloutDecision`（`:270-273`）：`attributionKnown = (active.length < 2) || Boolean(combinedArmId && childArms.length >= 2)`。**不**比较 child set 与全部 active；有 `combinedArmId` 且 `childArms.length>=2` 即视为已知，即使 child 不是 exhaustive。[历史事实]
- causal rollback（`:284-288`）：stop 时 disable `fired ∩ active`，否则 disable 全部 active。[历史事实]
- `packages/coding-agent/src/latency/rollout-cohort.ts`：
  - `LatencyRolloutObservationV1`（`:26-42`）是 completed-run observation；缺测字段为 `null`，聚合跳过 null，不当 0。
  - `LATENCY_COHORT_MIN_SAMPLES = 8`（`:19`）。
  - 默认跨进程文件：`~/.omp/workflow-artifacts/latency-rollout-cohort.jsonl`（`:155-156`）。
  - `LatencyRolloutCohortStore.append` 同步 best-effort，失败吞掉（`:170-178`）。
  - `readAll()` 按行 JSON.parse，不校验 `event_id`，无 dedupe（`:181-201`）。
- `AgentSession.#ensureLatencyArmSnapshot()`（`agent-session.ts:4694-4717`）是 **lazy**：第一次 lookup 才 freeze。
- `isLatencyArmEnabled` / `getLatencyArmSnapshot` / `markLatencyArmFired` / `getFiredLatencyArms` / `invalidateLatencyArmSnapshot`（`:4720-4745`）。
- `#evaluateLatencyRolloutAtSessionEnd`（`:4754-4793`）：有 snapshot 且存在 active latency arm 时，读 cohort、`buildLatencyRolloutDecision`；若 stop，则 `settings.override(LATENCY_ARM_SETTINGS[arm], false)` + `invalidateLatencyArmSnapshot()`。
- `Settings.override`（`settings.ts:515-527`）是 **runtime、不落盘**，原地改共享 `#overrides`。
- `structured-subagent.ts:442`：`settings: session.settings`，subagent 复用同一 Settings 实例。
- SDK ToolSession 闭包（`sdk.ts:1846-1847`）把 arm lookup 转到 `session.isLatencyArmEnabled` / `session.getLatencyArmSnapshot`，在 **调用时** 解引用 `session`。
- SDK **没有** 给 ToolSession 挂 `markLatencyArmFired` / `getFiredLatencyArms` / `invalidateLatencyArmSnapshot`。

当前 observation **没有** `event_id`、`sequence`、`phase`、`snapshot.fingerprint` 字段。[历史事实]

当前 `LatencyRolloutDecisionV1` 在 session-end 计算后只用于进程内 `settings.override`，未见写入 cohort JSONL 或其它跨进程 control-plane 文件。[历史事实]

---

## SDK 时序：createTools 早于 AgentSession [历史事实]

- `let session!: AgentSession`（`sdk.ts:1672`）。
- `SessionManager` 在 `sdk.ts:1388-1392` 已创建；`providerSessionId = options.providerSessionId ?? sessionManager.getSessionId()`（`:1402`）。因此 session id 在工具创建前已存在。
- `createTools(toolSession, options.toolNames)` 在 `sdk.ts:1900`。
- `new AgentSession({...})` 在 `sdk.ts:3424`。
- 若 A1 factory 在 `createTools` 期间调用 `session.isLatencyArmEnabled`，会解引用尚未构造的 `session`。当前 latency factory 不在构造期读 arm；A1 若在 factory 读 arm，必须不经过未构造的 `session`。

---

## createTools 一次成型与动态工具 [历史事实]

- `session-tools.ts:816-824`：`createTools` 在 session start 推导 built-in slate **一次**；runtime settings override 本身不会丢掉已注册工具。
- `computer` 有后续动态路径 `setComputerToolEnabled`：disable 从 active set 移除但保留 registry；enable 走 factory。
- 其它 built-in（含拟议的 `session_search`）没有同等动态路径，除非新增。

---

## Settings.override 污染 [历史事实]

- `Settings.override(path, value)`（`settings.ts:518-527`）原地修改共享实例。
- subagent 复用 `session.settings`（`task/structured-subagent.ts:442`）。
- 因此用 `settings.override` 做 rollback 会污染同进程 subagent/sibling。这是现有 latency rollback 已有行为，不是可当作“跨进程全局 kill”的 control-plane。

---

## goal.continuationModes [历史事实]

- schema array，default `["interactive"]`（`settings-schema.ts:4342-4344`）。
- TUI 路径：`interactive-mode.ts:1326` 使用 `.includes("interactive")`，不是当 boolean 读。
- 不存在 `goalHeadlessContinuation` boolean settings key。
- 不存在 `allowHeadlessGoalContinuation` settings key。

---

## Goal Runtime / State [历史事实]

- `GoalStatus = "active" | "paused" | "budget-limited" | "complete" | "dropped"`（`goals/state.ts:3`）。
- `Goal`（`:5-14`）：`id, objective, status, tokenBudget?, tokensUsed, timeUsedSeconds, createdAt, updatedAt`。当前 **无** `headlessContinuationCount`。
- `GoalModeState`（`:16-21`）：`{ enabled; mode: "active" | "exiting"; reason?; goal }`。
- persist adapter（`agent-session.ts:1284-1289`）只写 `{ goal: state.goal }`；顶层 GoalModeState 字段不落盘。
- rehydrate：`interactive-mode.ts:2222-2246` `#goalFromModeData` **显式逐字段复制**；未列出的新字段会被丢弃。旧 session 缺字段必须在复制处给默认值。
- `GoalRuntime.#commitState` 私有且 async（`runtime.ts:168-179`）；`#withAccounting` async（`:148`）。
- `renderGoalPrompt`（`runtime.ts:79-92`）对 active/continuation **仍然插值** `timeUsedSeconds: String(goal.timeUsedSeconds)`。无 `omitTimeUsedSeconds` 参数。

---

## #buildGoalModeMessage final content [历史事实]

- `agent-session.ts:5024-5035`：先 `#goalRuntime.buildActivePrompt()`，再 `prompt.render(goalModeContextPrompt, { goalContext: content, todoContext })`。
- final string = rendered wrapper（含 todoContext），不仅是 inner goal prompt。A3 hash 比较必须用同一 canonical final string。
- `setGoalModeState`（`:4631-4633`）目前只赋值 `#goalModeState`，没有 hash reset。

---

## shouldResetGoalContextHash lifecycle [推导]

基于 `Goal` / `GoalModeState` 字段语义，hash 有效性应由下列字段决定，而不是 tokens/time：

| 场景 | reset? |
|---|---|
| goal pause / resume / complete / drop | 是（status 和/或 enabled/mode 变） |
| goal replace / new | 是（id/objective 变） |
| null↔state（rehydrate / 清除） | 是；rehydrate 强制首注 |
| compaction（`auto_compaction_end`） | 是（context 边界变化；当前 handler `:1926-1928` 只清 read-dedupe，不清 goal hash） |
| tokens/time 更新 | 否 |

---

## Settle 顺序 [历史事实]

`#processAgentEvent` 的 `agent_end` 分支（`agent-session.ts:2538-2834`）在发出通知前的 willContinue 来源包括：compaction continuation、rewind、plan、todo、ordinary-obligation、pending async wake、`#emitSessionStopEvent`。

`emitAgentEndNotification` 把 `isTerminal` 设为 `!options?.willContinue`（`:2548`）。

canonical 语义（`agent-session-events.ts:14-16`）：`isTerminal: false` 表示 **async delivery will resume the session before its true final settle**。session 对象仍存活，或未来用户可能输入，不等于当前 delivery 会 resume。

当前 **没有** headless goal continuation 注入点。

---

## Hidden next-turn 与 queued drain [历史事实]

- `#schedulePostPromptTask`（`agent-session.ts:2864-2889`）支持 `onSkip`（aborted / stale-generation），**没有** `onError`，也没有 accepted 返回值。
- `#scheduleAgentContinue`（`:2896-2943`）在 task 内做 preflight / `shouldContinue` / `#continueAgent`；有 `onSkip` 与 `onError`。skip/error **只回调**，不补发 terminal `agent_end`。
- `#scheduleQueuedMessageDrain`（`:5828-5845`）在可 drain 时调用 `#scheduleAgentContinue({ shouldContinue: hasQueuedMessages, onSkip/onError: 清 flag })`。这是 queued-user 的 canonical drain owner。
- `#queueHiddenNextTurnMessage(message, triggerTurn)`（`:5878-5908`）：
  - `triggerTurn=false` 只入队，不调度。
  - `triggerTurn=true` 调 `#schedulePostPromptTask`；task 调 `#promptQueuedHiddenNextTurnMessages`。
  - catch **空**，只把失败留给“下次 explicit prompt”；**不** emit terminal，**不** onError。
  - `onSkip` 只清 `#scheduledHiddenNextTurnGeneration`，**不** settle。
- `#promptQueuedHiddenNextTurnMessages`（`:5911-5933`）失败会把 messages 放回队列并 throw。
- ordinary-obligation（`:8736-8768`）在 cap 内直接 `#queueHiddenNextTurnMessage(..., true)` 然后 `return true`，从而让当前 `agent_end` 带 `willContinue=true`。它继承上述 hole：schedule 被 skip/catch 后，subscriber 已看到 nonterminal，但没有 pairing terminal owner。
- `sendCustomMessage` ACP defer（`:6076-6104`）：`#clientBridge?.deferAgentInitiatedTurns && !#allowAcpAgentInitiatedTurns` 时 `#queueHiddenNextTurnMessage(..., false)` 并 `return false`。该路径 **不** 开 turn，因此不是 settle owner。

---

## Resume 与 fork [历史事实]

- Resume 应用 header：`session-manager.ts:997-1002` `#applyEntries` 执行 `this.#sessionId = header.id`。resume **不** 铸造新 session id。
- Fork（`:1268-1291`）：`this.#sessionId = mintSessionId()`，新文件，`parentSession: path.resolve(oldSessionFile)`。

---

## 已撤销项（B1/B5）[历史事实 / 设计约束]

- repeat guard：`ToolCallLoopGuard` 已有；不新建。
- prune：故意锚定 billed tokens；本设计不改 prune。

---

## R7 已通过且本版保留的能力缺口 [历史事实]

1. compaction 后 assistant / tool call / tool result 从模型上下文消失，omp 无工具检索 raw journal。
2. `renderGoalPrompt("active", goal)` 每步插入递增的 `timeUsedSeconds`，迫使每步重注入。
3. 无 headless 路径的 goal continuation（TUI 只认 `includes("interactive")`）。

---

## 被取消的平行 owner（R7 正文曾拟议，当前源码不存在，R8 不再采用）[拟议但已确定 · 取消]

下列名字若再出现在实现里，即再次违反 R7-D1：

- `DshFeatureOverrides`
- `effectiveSetting` 三层解析（process Map > optional override > `settings.get ?? false`）
- `globalDshKillSwitch` process Map 当作生产 rollback
- 第二套 assignment/metrics SQLite（`dsh_ledger` / `dsh_ledger_meta`）
- 第二套 cohort evaluator / 第二套 stop lifecycle
- 把 control 写成 `false（undefined）` 并 fall through 到用户全局 settings
- 把 runner capability 塞进 boolean settings resolver
- 把 `goal.continuationModes` 当 boolean `?? false`
- 用“session 仍存活 / 下次用户会输入”满足 `isTerminal:false`

---

## 拟议但已确定：capability 不是 arm

`allowHeadlessGoalContinuation` 是 runner capability，由构造 `AgentSession` 的 caller 显式传入（拟议字段，当前 Config 不存在）。它不是 settings boolean，也不是 quality arm。

| runner | capability | 依据 [历史事实 + 拟议] |
|---|---|---|
| TUI interactive main（`interactive-mode.ts` 绑定 timer） | `false` | 已有 `.includes("interactive")` timer 路径 |
| TUI 内额外 top-level（`sdk.ts:1678-1685` 所述 architect / 后续 top-level，不绑 TUI timer） | `true` | 无 TUI timer |
| task subagent（`structured-subagent.ts`） | `true` | 无 TUI timer |
| plain headless / SDK headless / RPC（无 defer） | `true` | 无 TUI timer，且无 ACP defer |
| ACP（`deferAgentInitiatedTurns && !#allowAcpAgentInitiatedTurns`） | `false` | `sendCustomMessage` 已 defer，不能开 agent-initiated turn |

---

## 拟议但已确定：数值

| 参数 | 值 |
|---|---|
| `HEADLESS_GOAL_CONTINUATION_CAP` | 20 |
| A1 stop T1（getBranch isError） | > 5%（5 min window） |
| A23 stop T2（goal 零注入） | > 2%（session 比例） |
| A23/A4 non-inferiority stop | > 10% absolute，对应 min sample |
| A4：count > cap | 零容忍 |
| 全局 token stop | > 3× baseline，> 30min |
| A1/A23 min sample | 200 eligible sessions per arm |
| A4 min sample | 100 eligible sessions per arm |
| EXP-A1 / EXP-A4 窗口 | 14d |
| EXP-A23 窗口 | 21d（EXP-A1 结束后） |
| washout | 3d |
| A2 shadow rollout threshold | median ≥10% identical + P25 ≥5%，≥100 sessions |

这些是实验/质量 stop 的作者选定值，不是当前源码常量（当前 `LATENCY_QUALITY_STOP` 与 `LATENCY_COHORT_MIN_SAMPLES=8` 是另一组 latency 阈值）。

---

## 未验证假设

- 方案 A 的当前分支扫描在典型 journal 上 P95 < 20ms。若实现阶段实测超过，再独立设计索引方案 B；本设计不预建第二索引引擎。
- 跨进程 control-plane 文件与现有 cohort JSONL 放在同一 `~/.omp/workflow-artifacts/` 目录，权限模型与现有 cohort 文件相同。
- 独立 eval harness 可以合法构造带 paired toolCall/toolResult 的 session，而不写入用户 journal。

---

**design-only 停止**：本文件不授权实现；实现须独立授权。
