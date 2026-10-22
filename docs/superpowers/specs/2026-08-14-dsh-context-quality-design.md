# Design: DSH 上下文质量实验

- Date: 2026-08-15
- Status: R8-Draft（R8R7 Gate NEEDS_REVISION 修订；关闭 R8R7-H1 / M1）
- Scope: L
- design_author: grok
- design_author_identity: GrokDesignerR10
- original_author_agent_id: Opus5Designer
- original_author_model: gateway/claude-opus-5
- prior_replacement_author_agent_id: Opus5DesignerR2
- prior_replacement_author_model: gateway/claude-opus-5
- current_replacement_author_agent_id: GrokDesignerR10
- current_replacement_author_model: gateway/grok-4.6
- facts_brief_author_agent_id: GrokDesigner
- facts_brief_author_model: gateway/grok-4.6
- planned_reviewer: DSHGateReviewer（gateway/gpt-5.6-sol，xhigh，只读）
- implementation_authorization: design-only
- authorization_source: 用户 2026-08-14 原要求将 DSH 对照分析沉淀为可评审设计并在新会话 review 后实现；用户随后明确停止使用 Claude，改用 Grok 4.6 完成设计；当前仍未授权实现
- facts_brief: docs/superpowers/specs/2026-08-14-dsh-context-quality-facts-brief.md
- scheme: A
- r7_reviewed_revision: 72a6e043f5f07c6d8ac1997be6013a5d5a1abbc3d55665bd3234ec4f2fe188ea（历史 Gate 证据，不是本 R8 正文 digest；本文件不伪造 reviewed_revision）

当前正文作者仅 `GrokDesignerR10` / `gateway/grok-4.6`。Claude 作者只属 R1–R7 历史。`Opus5DesignerR3`/`R4` 无写盘，不是 content author。`GrokDesigner` 写 facts brief（本轮 R8-M1 标签纠正由 GrokDesignerR10 写入）。`GrokDesignerR9` 未完成草稿已被整篇替换。本文 design-only：不改产品代码/测试/CI/migration/rollout，不授权实现。本文件不伪造 `reviewed_revision`。

证据标签：[历史事实]=源码或 facts 直接观察；[推导]=由已确认事实推出；[未验证假设]=尚未验证；[拟议但已确定]=本设计拍板。

## 1. 设计目标和范围

### 1.1 要解决的问题

在 omp 会话上做四项上下文质量实验，且必须挂在已有 behavior-arm / quality-stop 生产 owner 上，禁止第二套引擎。

已通过局部含义（R7 对 A1/A2/A3 与 A4 reserve 局部 PASS；本版保留）：

1. A1 `session_search`：当前 branch raw journal 检索 compaction 后消失的 assistant / toolCall / toolResult。
2. A2：臂开时从 active goal prompt 去掉 `timeUsedSeconds`。
3. A3：`shouldResetGoalContextHash`（id/objective/status/enabled/mode；usage 不 reset）；shadow 相邻比较分母；versioned custom entry 单 owner。
4. A4：headless continuation 一等调度器（accepted / onSkip / onError / final-settle）；queued-user 必须 `#scheduleQueuedMessageDrain`。

R7 `NEEDS_REDESIGN` 因为上一版新建 `DshFeatureOverrides` + process Map kill + 第二 ledger/stop，并与 `isTerminal:false` 自相矛盾。本版 Scheme A 关闭 R7-D1…D4。

### 1.2 成功标准

1. 唯一 owner：泛化后的 `packages/coding-agent/src/latency/arms.ts`。Latency 与 DSH 同 owner + 新 arm ID，不是 adapter 双 lifecycle。
2. 删除：`DshFeatureOverrides`、`effectiveSetting` 三层解析、`globalDshKillSwitch`、第二 SQLite ledger、第二 cohort evaluator、第二 rollback/stop lifecycle。
3. Snapshot 在 `createTools` 前冻结并挂现有 ToolSession arm seam。同 `sessionId` resume 恢复；fork/new 才重分配。
4. 控制臂 resolved 显式 `false`。capability 类型 ≠ feature-enable。`goal.continuationModes` 专用 array resolver（`.includes("headless")`）。
5. DSH 实验是同一 owner 上的**正交 dimension**（H1 模型 1），不是“A23 为唯一 combination、A1/A4 可与默认四臂并行却不算 combination”。每个允许 active-set 有 registered combination、cohort key、matched control key、rollback target。
6. 仅当 `submit` 返回 `accepted` 且该 `deliveryId` 的 settle owner 已安装时才发 `isTerminal:false`。skip/error/retry/finalSettle 全部绑定该 `deliveryId`。
7. 同一 JSONL 是 tagged union：`latency_rollout_observation` ∪ `latency-rollout-decision`。parser 不再丢 decision。replay：observation 按 `event_id` 去重 latest-wins；decision 按 `(scope, targetArm)` 去重 latest-wins。
8. 逐文件实现表自包含。样本单位 = **session**（R8-M2）。

### 1.3 本次范围

关闭 R7-D1/D2（§5.1–5.4）与 R8-H1/H2/H4（正交 dimension、decision 行、A/B assignment）；保留 A1/A2/A3 局部设计（§5.5）；关闭 R7-D3/R8-H3（§5.6 deliveryId）；关闭 R7-D4/R8-M2（§5.7 session 样本）。授权保持 design-only。

### 1.4 非目标

不实现。不重开已 PASS 的 A1 抽取合同、A2 文案、A3 reset predicate。不新建 repeat guard（已有 `ToolCallLoopGuard`）。不改 prune。不为 A1 预建第二 journal 索引。不把 capability 写成 settings boolean，不把 `goal.continuationModes` 当 `?? false`。不用“session 仍存活 / 下次用户输入”满足 `isTerminal:false`。

## 2. 背景与约束

- 唯一生产 arm/quality-stop owner [历史事实]：`latency/arms.ts:4-11` session-frozen、independently rollbackable；注释要求 combined experiments 必须 registered。`LatencyArmSnapshotV1`（`:44-57`）：`arms` / `combinedArmId?` / `childArms?` / `frozenAt` / `fingerprint`。`resolveLatencyArmsFromSettings`（`:74-84`）：`get(path)===true` 才 true，否则 false。`freezeLatencyArmSnapshot`（`:90-105`）只要求 `combinedArmId` 出现时 `childArms.length>=2` 且 ID 合法，**不**验证 child set === 全部 active。[历史事实] `deriveLatencyCombination`（`:209-217`）把**全部** active 折成一个 `combined:<sorted.join("+")>`。`buildLatencyRolloutDecision`（`:270-273`）只要 `combinedArmId` 存在且 `childArms.length>=2` 就 `attributionKnown=true`，**不是** exhaustive fail-closed。[历史事实] causal rollback 只 disable fired∩active，否则全部 active（`:284-288`）。四个默认 true 的背景臂：`modelOptimization.enabled`、`readDedupe`、`bashAdvisory`、`bashBoundedInjection`。[历史事实]
- 已有 seam [历史事实]：ToolSession `isLatencyArmEnabled` / `getLatencyArmSnapshot` / `markLatencyArmFired` / `getFiredLatencyArms` / `invalidateLatencyArmSnapshot`（`tools/index.ts:327-336`）。AgentSession 实现 snapshot/fired/invalidation（`agent-session.ts:4694-4745`）并在 session-end 消费 cohort（`:4754-4793`）。`LatencyRolloutCohortStore` 默认 `~/.omp/workflow-artifacts/latency-rollout-cohort.jsonl`。
- 当前缺口 [历史事实]：`#ensureLatencyArmSnapshot` lazy。SDK `createTools` 在 `sdk.ts:1900`，`new AgentSession` 在 `:3424`；`sessionId` 已由 `SessionManager`（`:1388-1402`）存在。SDK 闭包调用时解引用 `session`（`:1846-1847`），未挂 fired/invalidate。observation 无 `event_id`/`sequence`/`phase`/`snapshot.fingerprint`。`Settings.override` runtime 不落盘，污染共享 Settings 的 subagent。
- A1 现状 [历史事实]：`BUILTIN_TOOL_NAMES` 无 `session_search`。factory 返回 `null` 则跳过。slate 在 start 推导一次（`session-tools.ts:816-824`）；仅 `computer` 有动态 enable/disable。
- goal / continuation [历史事实]：`goal.continuationModes` array，default `["interactive"]`。TUI 用 `.includes("interactive")`。无 `goalHeadlessContinuation` / `allowHeadlessGoalContinuation` settings key。`AgentSessionConfig` 无 `dshFeatureOverrides`。`renderGoalPrompt` 仍插值 `timeUsedSeconds`。`#schedulePostPromptTask` 无 `onError`、无 accepted；`#queueHiddenNextTurnMessage(true)` catch 空。`isTerminal:false` = async delivery will resume before true final settle（`agent-session-events.ts:14-16`）。
- resume/fork [历史事实]：resume `this.#sessionId = header.id`（`session-manager.ts:997-1002`）。fork 才 `mintSessionId()`。
- 授权：design-only。R7 digest 只作历史证据。

## 3. 根因分析

### 3.1 是否需要根因分析

需要。方案选择依赖两个已证实成因：仓库已有 canonical arm owner，再造第二引擎即双 truth；`isTerminal:false` 合同与 hidden-next-turn 实现互相矛盾。

### 3.2 已确认事实

1. R7 把不存在的 `DshFeatureOverrides`/`effectiveSetting`/`globalDshKillSwitch` 写成 owner；`AgentSessionConfig` 与 `ToolSession` 均无这些字段。[历史事实]
2. SDK 先 `createTools` 后 `new AgentSession`。overrides 只放 Config 必晚于 A1 factory。[历史事实]（R7-D2.2）
3. `goal.continuationModes` 是 `string[]`；`allowHeadlessGoalContinuation` 无 settings key。[历史事实]
4. `get(path)===true` 才为 true。control 写成 `false（undefined）` 会 fall through 到用户全局 settings。[历史事实+推导]
5. process Map 只在调用 `effectiveSetting` 时生效；已注册 A1 executor 不再读 Map；跨进程改不了别的进程的 Map。[历史事实+推导]
6. `#queueHiddenNextTurnMessage(true)` skip/catch 不补 terminal；ordinary-obligation 却 `return true` 使 `willContinue=true`。[历史事实]
7. Resume 保持同一 `sessionId`。[历史事实]
8. 现有 observation 按行 parse，无 `event_id`，无 dedupe；`append` 失败吞掉。[历史事实]

### 3.3 未确认假设

- 当前分支扫描典型 journal P95<20ms；超标另开索引设计，本文不预建。[未验证假设]
- 跨进程 control-plane 与 cohort JSONL 同目录、同权限。[未验证假设]
- 独立 eval harness 可构造 paired toolCall/toolResult 而不写用户 journal。[未验证假设]

### 3.4 对设计的影响

先选 owner 再写 A1–A4。选 A：泛化 `arms.ts`。快照必须在 `createTools` 前且不依赖未构造的 `AgentSession`。ledger 只记 resolved snapshot+fingerprint+fired。capability / array mode / boolean arm 分类型。A4 先有 settle owner 才能发 nonterminal。observation 扩现有 cohort schema。

## 4. 方案对比

### 4.1 方案 A — 泛化 `latency/arms.ts` 为唯一 behavior-arm owner

核心：加宽同一模块的 arm 集合；DSH 只加 ID、settings path、registered combination、cohort 字段。共用 freeze、ToolSession/AgentSession seam、`invalidateLatencyArmSnapshot`、`evaluateLatencyQualityStop` / `buildLatencyRolloutDecision`、`LatencyRolloutCohortStore`。不引入 adapter，不引入第二 lifecycle。

优点：对齐 R7-D1 第一条路线；零第二引擎；fired attribution 直接覆盖 A1/A4 独立回滚与 A23 combination；跨进程文件已在。

缺点：模块名仍带 `latency/`；DSH 字段进入同一 schema，需向后兼容（缺测保持 `null`，聚合跳过 null）。[历史事实：现有 observation 已用 null 表示缺测]

前提：现有 owner 足以承载 context-quality arms。R7 未证明它不能。

### 4.2 方案 B — 抽通用 arm interface，latency 与 DSH 都做 adapter

核心：先证 latency contract 缺口，再引入单一上层 interface；两者做 adapter，共享 interface 但不共享 freeze/ledger 实现。

优点：若未来 freeze 时机或账本真不能共用，边界更干净。

缺点：今天没有已被证明的缺口。新建 interface+两 adapter 会立刻出现两套 snapshot/kill/ledger，正是 R7-D1 要消灭的双 truth。

前提：仅当实现阶段证实 snapshot/JSONL 无法扩展时才成立。当前证据不足，不得选用。

### 4.3 选型结论

选择方案 A。R7-D1 要求以 existing arm/rollout 为起点。现有模块已具备 session-frozen、independent rollback、registered combination、fired attribution、quality-stop、seam、跨进程 JSONL。DSH 需要的是新 arm ID + 字段扩展，不是第二套引擎。B 在缺口未证实时会重演 R7 失败。

## 5. 详细方案

### 5.1 核心思路（Scheme A，关闭 R7-D1）

[拟议但已确定] 原地加宽 `packages/coding-agent/src/latency/arms.ts`，不新建 `dsh/arms.ts`，不新建 `BehaviorArmEngine`。

1. 现有 9 个 `LATENCY_ARM_IDS` 不变。新增：A1=`dsh_session_search`，A2=`dsh_omit_goal_time`，A3=`dsh_goal_hash_shadow`，A4=`dsh_headless_continuation`。
2. `LATENCY_ARM_SETTINGS` 增加对应 path。解析沿用 `get(path)===true` 才 true，否则显式 `false`。禁止 `undefined` fall through。
3. **H1 选择模型 1（正交 experiment dimensions），不是模型 2（互斥冻结非目标臂）。** 理由：生产默认已有四臂 true；模型 2 会为每个 DSH 实验关掉 `context_optimization`/`read_dedupe`/bash 对，treatment 与真实生产背景不可比，且会破坏已有 latency quality-stop。模型 1 在同一 `arms.ts` owner 上把 snapshot 从“一个 all-active combination”泛化为“背景 latency 集合 × 若干已登记 DSH dimension”，仍只有一套 freeze / fired / stop / JSONL。
4. 不改名、不加第二 snapshot 类型。DSH 写入同一 `arms` map；fingerprint 仍为 payload SHA-256。observation / decision 只记 resolved `true|false` + fingerprint + fired receipts，不记 raw optional override。
5. 禁止再现：`DshFeatureOverrides`、`effectiveSetting`、`globalDshKillSwitch`、`dsh_ledger`/`dsh_ledger_meta`、第二 evaluator、第二 stop lifecycle。
6. exact-set validation 是同一 owner 的 **[拟议但已确定]** 增强（R8-M1）：`freezeLatencyArmSnapshot` / `buildLatencyRolloutDecision` 必须验证每个 registered dimension 的 `childArms` 排序后等于该 dimension 声明的集合；未登记的 active 超集 → 该 dimension `attributionKnown=false` 并 fail-closed。当前源码没有这个检查。

#### 5.1.1 正交 dimension 合同（关闭 R8-H1）[拟议但已确定]

**背景集合 `BG`** = 当前 snapshot 上所有非 DSH、值为 true 的 latency arm。生产默认 `BG0 = {context_optimization, read_dedupe, bash_advisory, bash_bounded_injection}`。用户关掉其中某个时，`BG` 跟着变；匹配必须按**同一 `BG` 指纹**，不能拿“全部 arm false”的 `baseline` 当 DSH control。[历史事实：`deriveLatencyCohortKey` 的 `baseline` = 零 active]

**三个正交 DSH dimension**（互不共享 child arm）：

| dim | childArms（固定） | treatment 条件 | control 条件 |
|---|---|---|---|
| `dim.a1` | `[dsh_session_search]` | A1 true | A1 false |
| `dim.a23` | `[dsh_goal_hash_shadow, dsh_omit_goal_time]`（已排序） | A2∧A3 true | A2∧A3 皆 false |
| `dim.a4` | `[dsh_headless_continuation]` | A4 true | A4 false |

A2 与 A3 必须同开或同关。`(A2 xor A3)` 是损坏/不一致输入：freeze **在任何 A2/A3 行为之前** fail-closed——两臂都解析为显式 `false`，`dim.a23.role="excluded"`，写一条 `kind:"dsh-arm-assignment"` 的 invalid 行（及可选 decision，`disabledArms=["dsh_omit_goal_time","dsh_goal_hash_shadow"]`）。**禁止**按各自 boolean 执行未监控 partial treatment。不得计入 EXP-A23 样本。

**同一 session 允许同时持有多个 dimension 的 treatment 或 control**（factorial）。A1+A4 并行是合法 factorial cell。一个 all-false 且两实验都 eligible 的 session 同时是 A1 control **和** A4 control，各写一条 metrics。EXP-A23 与 EXP-A1 **时间互斥**（§5.7.3 washout），热路径不会出现 A1∧A23 同时 treatment。

泛化后的 snapshot 增加（仍是 `LatencyArmSnapshotV1` 字段扩展，缺省 `null`）：

```ts
type ExperimentDimensionId = "dim.a1" | "dim.a23" | "dim.a4";
type DimensionSlice = {
  id: ExperimentDimensionId;
  childArms: LatencyArmId[];
  assignedTreatment: boolean;  // hash 分桶结果；resume 不改
  treatment: boolean;          // effective：assignedTreatment && !stopApplied
  stopApplied: boolean;        // 有未过期 stop decision 覆盖
  role: "treatment" | "control" | "excluded";
  cohortKey: string | null;    // excluded 为 null
  controlKey: string | null;
};
// snapshot.dimensions?: DimensionSlice[]
// snapshot.backgroundArmId?: string  // "bg:" + sorted(BG).join("+") 或 "bg:none"
```

`deriveLatencyCombination` 保留给**纯 latency** 调用方（无 DSH dim 被 assignment 命中时仍生成 all-active `combined:…`）。只要任一 experiment `role!=="excluded"`，DSH cohort 走 `snapshot.dimensions[]`，禁止再用 all-active 单一 `combinedArmId` 当 DSH key。**eligible control（`role=control`，全部 DSH 臂 effective false）仍是 DSH 样本**，必须带对应 `DimensionSlice` 与 control `cohortKey`。latency 质量字段继续按 `BG` 聚合，与 DSH dimension 分开。

**cohort key 格式**（一个 snapshot 可发出多条 observation，每 dim 一条，避免把 A1 与 A4 揉成一个 key）：

- treatment: `dsh:<dim>:t|bg:<bgFingerprint>`
- control:   `dsh:<dim>:c|bg:<bgFingerprint>`

`bgFingerprint` = `sorted(BG).join("+")` 或 `none`。

#### 5.1.2 允许的 active-set 与 rollback 目标

行按 **assignment role** 分，不按“DSH 臂是否全 false”混称。`BG0` = 生产默认四臂；其它 `BG*` 只与同 `bgFingerprint` 配对。`L` = 纯 latency all-active key。

| assignment-aware 行 | registered dims | DSH cohort / metrics | matched control key | rollback |
|---|---|---|---|---|
| 全部 experiment `excluded`（无 eligibility） | 无 slice | **无 DSH sample**；不写 DSH metrics | — | 无 |
| A1 control ∧ A4 control（两实验 eligible，DSH 臂全 false） | `dim.a1` c + `dim.a4` c | **两条** control metrics：`dsh:dim.a1:c\|bg:BG0` 与 `dsh:dim.a4:c\|bg:BG0` | 各行即该 dim 的 control 池 | 无 |
| 仅 A1 control（A4 `excluded`，如 TUI capability=false） | `dim.a1` c | 一条 A1 control metrics | `dsh:dim.a1:c\|bg:BG0` | 无 |
| 仅 A4 control（A1 `excluded`） | `dim.a4` c | 一条 A4 control metrics | `dsh:dim.a4:c\|bg:BG0` | 无 |
| A23 control（窗内 eligible，A2=A3=false） | `dim.a23` c | 一条 A23 control metrics | `dsh:dim.a23:c\|bg:BG0` | 无 |
| 仅 A1 treatment（A4 control 或 excluded） | `dim.a1` t（+ 可选 A4 c） | A1 t metrics（+ 可选 A4 c） | A1 → `dsh:dim.a1:c\|bg:BG0` | A1 only |
| 仅 A4 treatment | `dim.a4` t | A4 t | `dsh:dim.a4:c\|bg:BG0` | A4 only |
| A1 t + A4 t | 两 dim t | 两条 treatment metrics | 各对同 BG 的 c | 按 fired dim 分别 disable |
| 仅 A23 treatment | `dim.a23` t | A23 t | `dsh:dim.a23:c\|bg:BG0` | A2+A3 一起 |
| A23 t + A4 t/c | 两 dim | 各一条 | 各对同 BG | A23 与 A4 独立 |
| A2 xor A3（损坏输入） | 无有效 dim.a23 | 写 invalid-assignment observation；**不**进 EXP-A23 | 无 | 两臂强制 false；不执行 A2/A3 处理行为 |
| A1+A23 同时 assigned t | 热路径禁止 | 两实验 `excluded`，不写 t/c 样本 | — | 若 freeze 见到：两臂组都强制 false |

禁止再写“无 DSH 臂 = 无样本 = 同时又是 control 池”。control 池 = `role=control` 且写出的 metrics 行。

`BG` ≠ `BG0` 只与同指纹 control 比。跨 `BG` 聚合禁止。latency stop 继续用 `L` / 今日 `baseline`。

A1+A4 factorial：同一 session 可向两个 experiment 各贡献一条 session 样本。quality-stop 按 dim fired 回滚，禁止用 A1 指标 disable A4。

### 5.2 控制流（关闭 R7-D2 时序）

[拟议但已确定]

1. `SessionManager` 已在，`sessionId` 已知（resume 则为 `header.id`）。[历史事实]
2. **`createTools` 之前**：新 session 读 `ExperimentDefinition` + assignment 再 freeze；resume restore assignment 后先 `readActiveDecisions()`（effective 可被 stop 打成 false），禁止重抽。
3. ToolSession 的 `isLatencyArmEnabled` / `getLatencyArmSnapshot` 关闭在该 snapshot 对象上，不关闭在未构造的 `AgentSession` 上。A1 factory 只读该对象。SDK「调用时解引用 session」对 factory 构造期不安全，A1 不得走那条路径。
4. `createTools`：A1 factory 若 `dsh_session_search!==true` 返回 `null`；若 true 注册 `session_search`，executor 再 gate。
5. 之后 `new AgentSession` 接收并采用同一 snapshot，禁止第二次 freeze。session-end 仍走 `#evaluateLatencyRolloutAtSessionEnd`，并按 §5.7.1 把 decision 行写入同一 JSONL。
6. 同 `sessionId` resume 从 session journal custom entry 恢复（§5.7.4）；JSONL assignment 行只作 journal 缺失时的后备。fork 或全新 session 才按 live settings + assignment 重 freeze。

### 5.3 类型分离（关闭 R7-D2 类型）

[拟议但已确定] 三种值三种类型，禁止互相 `??`。

| 种类 | 类型 | Owner | 合法读法 | 非法读法 |
|---|---|---|---|---|
| Feature enable（A1–A4） | resolved `true`/`false` | `arms.ts` snapshot | `snapshot.arms[id]===true` | `settings.get(path)??false`；`undefined` 当 control |
| Continuation mode | `string[]` | `goal.continuationModes` | `continuationModesIncludes(settings,"headless")` ≡ `.includes("headless")` | 当 boolean；映射 `goalHeadlessContinuation` |
| Runner capability | `boolean` | 构造方显式传入拟议字段 `allowHeadlessGoalContinuation`（当前 Config 不存在） | 只读该字段 | 写入 settings；当作 arm；塞进 `effectiveSetting` |

Capability 真值表（facts「capability 不是 arm」）：TUI interactive main（绑 timer）=`false`；TUI 额外 top-level（不绑 timer）=`true`；task subagent=`true`；plain/SDK/RPC headless 无 defer=`true`；ACP 且 `deferAgentInitiatedTurns && !#allowAcpAgentInitiatedTurns`=`false`。

A4 处理同时需要：snapshot `dsh_headless_continuation===true` **且** `continuationModesIncludes(...,"headless")` **且** `allowHeadlessGoalContinuation===true`。控制 = snapshot 该键显式 `false`；即使用户全局 modes 已含 `"headless"`，控制会话也不得 fall through 成处理。

### 5.4 回滚、已注册 A1、跨进程（关闭 R7-D2）

[拟议但已确定] Kill/disable 只允许：

1. freeze 时即为控制（resolved `false`）。
2. quality-stop / causal rollback：复用 `evaluateLatencyQualityStop` + `buildLatencyRolloutDecision`；对 **该 dimension 的** fired∩active `settings.override(LATENCY_ARM_SETTINGS[arm], false)` + `invalidateLatencyArmSnapshot()`。跨进程生效只认同一 JSONL 里 `kind:"latency-rollout-decision"` 行（§5.7.1），在 **下一次 freeze 之前** 由 `readActiveDecisions()` 读入并把目标臂解析为显式 false。`Settings.override` 仍只是本进程。[历史事实：现有 session-end 已 override+invalidate，但 decision **不**写 JSONL]
3. A4 本轮 `onSkip`/`onError`：只 `finalSettle(deliveryId)`，不写全局表，不改 snapshot。

禁止 process `Map`、模块级可变 kill 表、平行 raw override truth。

已注册 A1 两层缺一不可：

- Executor re-gate：每次 execute 先查当前 snapshot（invalidation 后下次 lookup 按 live/override 再 freeze）。不再为 true 则 `isError:true`，不碰 journal。
- 动态移除：按 `computer` 的 `setComputerToolEnabled`，从 active set 去掉 `session_search`、保留 registry。仅“新 session 生效”不够（R7-D2.6）。

新 session：读 persist 后的 live settings → freeze 显式 false → factory `null`。

跨进程 owner = 现有 cohort JSONL + persist 回同一文件的 `buildLatencyRolloutDecision` 结果（§5.7 扩字段）。`Settings.override` 仍是本进程、不落盘、污染共享 Settings 的 subagent——这是现有 latency 行为，不得再称为全局生产 rollback。跨进程只认 JSONL 决策。本文不另开“干净”平行 override。

### 5.5 保留的 A1 / A2 / A3 局部设计

本节只迁移 R7 已 PASS 的合同到 Scheme A owner。不重开抽取边界、最终文案或 reset predicate。

#### 5.5.1 A1 `session_search` [拟议但已确定]

**身份**：builtin 名 `session_search`。加入 `packages/coding-agent/src/tools/builtin-names.ts` 的 `BUILTIN_TOOL_NAMES`。新模块 `packages/coding-agent/src/tools/session-search.ts`。`HIDDEN_TOOL_NAMES` 不加它。factory 在 `createTools` / `BUILTIN_TOOLS` 注册；返回 `null` 则不暴露。

**读取源**：当前 session 的 **current-branch** raw journal。经 `ToolSession.sessionManager.getBranch` / `getEntries`。[历史事实] 这些方法已在 ToolSession 的 `Pick` 上。禁止读 `agent.db`、禁止读 `HistoryStorage`（只索引 `history.prompt`）、禁止把 remote `preserveData.openaiRemoteCompaction` 当作 raw 已不可用的证据。remote compaction 存在 ≠ local raw entries 不可用。

**分类**（与 context builder 对齐，但是检索用）[拟议但已确定 + 历史事实 `session-context.ts:401-437` / `session-entries.ts:96`]：

1. 在 current-branch path 上找 latest compaction。`CompactionEntry.firstKeptEntryId` 在 `session-entries.ts:96`（不是 `:100`；`:100` 是 `preserveData?`）。
2. `P` = `entry.id === latestCompaction.firstKeptEntryId` 的 position。
3. `path[0..P-1]` = compacted（检索主空间：模型上下文已丢掉、raw 仍在）。
4. `path[P..currentCallPos-1]` = active（仍在模型上下文；默认可搜，见参数）。
5. 无 compaction：全 path 视为 active；compacted 为空。
6. walk 结束仍 `foundFirstKept===false`：fail-loud，`isError: true`，不静默当“无结果”。

**可检索条目**（仅这些）：

- compacted（及可选 active）段里、role 为 assistant 的 **text**。
- 同一段里的 **canonical `ToolCall`**：`{ type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }`（`packages/ai/src/types.ts:753-758`）。禁止把 provider wire `tool_use`/`input` 当合同。
- 配对的 **`ToolResultMessage`**（`types.ts:886-915`）：只抽取 `content` 中 `type:"text"` 的 `text`。忽略 image。`isError` 原样回传。

**查询匹配**：对 `JSON.stringify(arguments)` **完整字符串**做匹配。展示截断不得参与匹配。

**输出**：新建 `OutputSink`（`streaming-output.ts`）。只走公共 API：`push(chunk)` 然后 `await dump(notice?)`。inline budget 用 `spillThreshold`（不是 `maxBytes`）。默认 `DEFAULT_MAX_BYTES = 50 * 1024` UTF-8 bytes。`args_snippet` 展示截断必须 `truncateHeadBytes(JSON.stringify(arguments), 256).text`，禁止 `Buffer.from(json,"utf-8").slice(0,256).toString("utf-8")`。验收：`Buffer.byteLength(args_snippet,"utf8") <= 256`；无 U+FFFD；ASCII / CJK / 4-byte emoji 边界正确。

**模型面 schema**（参数字面量）：

```ts
{
  name: "session_search",
  description:
    "Search this session's raw journal on the current branch. Use after compaction to recover assistant text, tool calls, and tool results that left the model context. Matches full tool-call arguments; snippets are display-only.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Substring matched against assistant text, tool name, and JSON.stringify(arguments)." },
      include_active: { type: "boolean", description: "If true, also search the post-firstKeptEntryId active segment. Default false." },
      limit: { type: "integer", description: "Max hits. Default 20, hard cap 50." },
    },
    required: ["query"],
  },
}
```

**Executor 合同**：

1. 先 re-gate：`snapshot.arms.dsh_session_search !== true` → `{ isError: true, content: [{type:"text", text:"session_search disabled by arm snapshot"}] }`，不读 journal。
2. `sessionManager` 缺失 → 同样 fail-loud。
3. 成功：text hits 列表（entry id、zone=`compacted|active`、role/name、`args_snippet`、result text excerpt）。命中即 `markLatencyArmFired("dsh_session_search")`。
4. 不写第二套索引。全量当前 branch 扫描。P95 假设见 §3.3。
#### 5.5.2 A2 去掉 `timeUsedSeconds` [拟议但已确定]

**仅当** `snapshot.arms.dsh_omit_goal_time === true` 时，`renderGoalPrompt` 对 **active / continuation** 不再插值 `timeUsedSeconds`。控制臂保持当前行为：`runtime.ts:79-92` 仍 `timeUsedSeconds: String(goal.timeUsedSeconds)`。[历史事实：当前无 `omitTimeUsedSeconds` 参数]

实现落点：给 `renderGoalPrompt` 增加显式参数或从同一 frozen snapshot 读取；禁止另开平行 renderer。只改 **active goal prompt** 的插值。不改 `Goal.timeUsedSeconds` 字段本身、不改 persist、不改 footer。

Fired：实际渲染了一份省略该字段的 prompt 时 `markLatencyArmFired("dsh_omit_goal_time")`。

A2 xor A3：freeze 已把两臂打成显式 false（§5.1.1）。`renderGoalPrompt` / shadow **必须**按 false 执行（保持插值 `timeUsedSeconds`、不写 A23 treatment 行为）。禁止“一边 omit time、一边不 shadow”的 partial treatment。

#### 5.5.3 A3 hash reset + shadow [拟议但已确定]

**Canonical final string** [历史事实 `agent-session.ts:5024-5035`]：`#buildGoalModeMessage` 先 `#goalRuntime.buildActivePrompt()`，再 `prompt.render(goalModeContextPrompt, { goalContext, todoContext })`。A3 比较必须用这份 **wrapper 后的 final string**，不是 inner goal prompt。

**`shouldResetGoalContextHash`**（单函数，单 owner）。输入：prev/next 的 `Goal` + `GoalModeState` + compaction 边界信号。输出：boolean。

| 场景 | reset? | 依据 |
|---|---|---|
| pause / resume / complete / drop | 是 | `status` 和/或 `enabled`/`mode` |
| goal replace / new | 是 | `id` / `objective` |
| null↔state（rehydrate / 清除） | 是 | rehydrate 强制首注 |
| compaction（`auto_compaction_end`） | 是 | context 边界变化；当前 handler `:1926-1928` 只清 read-dedupe，本设计补清 goal hash |
| tokens / `timeUsedSeconds` 更新 | **否** | usage 不 reset |

`setGoalModeState`（`:4631-4633`）今日只赋值、无 hash reset。本设计在该赋值之后调用 `shouldResetGoalContextHash`；为 true 则丢弃缓存 hash，使下一轮必须重注入。

**Shadow（相邻比较分母）**：

- 单 owner：`SessionManager.appendCustomEntry`。`customType` 字面量：`dsh.goal_hash_shadow.v1`。禁止第二 customType、禁止 SQLite。
- payload（versioned）：

```ts
type GoalHashShadowV1 = {
  v: 1;
  sessionId: string;
  goalId: string;
  snapshotFingerprint: string;
  finalHash: string;          // sha256(canonical final string)
  injected: boolean;          // 本轮是否真注入
  resetReason: "id" | "objective" | "status" | "enabled" | "mode" | "compaction" | "rehydrate" | "none";
  adjacentPrevHash: string | null;
  adjacentIdentical: boolean | null; // 与上一份 finalHash 是否相同；无 prev 则为 null
};
```

- **分母** = 有 `adjacentPrevHash !== null` 的相邻对。分子 = `adjacentIdentical===true`。禁止用“本 session 总 turn 数”当分母。
- A2 shadow 推广阈值（facts 选定值，不是源码常量）：median ≥10% identical + P25 ≥5%，且 ≥100 sessions。
- `SessionManager.flush()` 在 persist / dispose 前调用，保证 custom entry 落盘。
- Fired：写出一条 shadow entry 时 `markLatencyArmFired("dsh_goal_hash_shadow")`。

**GoalRuntime reserve / rehydration**（A3 相关、A4 计数预留）：`Goal` 今日无 `headlessContinuationCount`。[历史事实] persist 只写 `{ goal: state.goal }`；`interactive-mode.ts:2222-2246` `#goalFromModeData` **显式逐字段复制**，未列出的新字段会被丢弃。因此：

1. 若 A4 需要计数，必须把 `headlessContinuationCount: number` 加进 `Goal`（default 0），并在 `#goalFromModeData` 的逐字段复制里写出该键；旧 session 缺字段 → `0`。
2. 不得把计数只放在 `GoalModeState` 顶层（顶层不落盘）。
3. `GoalRuntime.#commitState` / `#withAccounting` 已是 async；reserve 必须走现有 async lock，禁止平行 lock。

#### 5.5.4 Settings 完整字面量 [拟议但已确定]

加在 `packages/coding-agent/src/config/settings-schema.ts`，紧挨现有 `latency.arms.*` 块。`UiBase` 强制 `label`+`description`；`group` 必须属于 `TAB_GROUPS[tab]`。四个键 default 全部 `false`（实验未过 matrix 前保持关；与现有“未过 matrix 的 behavior-changing arm 保持 off”注释一致）。

`arms.ts` 映射：

```ts
dsh_session_search:        "latency.arms.dshSessionSearch",
dsh_omit_goal_time:        "latency.arms.dshOmitGoalTime",
dsh_goal_hash_shadow:      "latency.arms.dshGoalHashShadow",
dsh_headless_continuation: "latency.arms.dshHeadlessContinuation",
```

字面量：

```ts
"latency.arms.dshSessionSearch": {
  type: "boolean",
  default: false,
  ui: {
    tab: "tools",
    group: "Available Tools",
    label: "Session Search (DSH A1)",
    description:
      "When true, register session_search so the model can retrieve compacted raw assistant/tool journal on the current branch. Independently rollbackable. Default off until the DSH quality matrix passes. Control is explicit false; never inferred from a missing key.",
  },
},
"latency.arms.dshOmitGoalTime": {
  type: "boolean",
  default: false,
  ui: {
    tab: "tasks",
    group: "Modes",
    label: "Omit Goal Time (DSH A2)",
    description:
      "When true, active goal prompts omit timeUsedSeconds so the clock does not force re-injection every turn. EXP-A23 treatment requires this and dshGoalHashShadow both true (dim.a23). Assignment, not this toggle alone, decides treatment vs control. Default off.",
  },
},
"latency.arms.dshGoalHashShadow": {
  type: "boolean",
  default: false,
  ui: {
    tab: "tasks",
    group: "Modes",
    label: "Goal Hash Shadow (DSH A3)",
    description:
      "When true, persist versioned adjacent-comparison shadow entries for the canonical final goal-mode string. Usage (tokens/time) does not reset the hash. Default off. EXP-A23 treatment requires this and dshOmitGoalTime both true.",
  },
},
"latency.arms.dshHeadlessContinuation": {
  type: "boolean",
  default: false,
  ui: {
    tab: "tasks",
    group: "Modes",
    label: "Headless Goal Continuation (DSH A4)",
    description:
      "When true, the session may request headless goal continuation. Actual injection also requires goal.continuationModes to include \"headless\" (array resolver, not a boolean) and the runner capability allowHeadlessGoalContinuation. Independently rollbackable. Default off.",
  },
},
```

`goal.continuationModes` **已存在**，不新建 boolean 键。A4 处理读取它的方式只能是 `.includes("headless")`。用户把 `"headless"` 放进该数组，只表示 mode 允许；没有 snapshot `true` + capability `true` 仍不得注入。

不存在、且禁止新增的 settings key：`goalHeadlessContinuation`、`allowHeadlessGoalContinuation`、任何 `dsh.feature.*` 平行树。


### 5.6 A4 一等 hidden-next-turn 调度器（关闭 R7-D3）

R7 已 PASS 的局部：async lock、`HEADLESS_GOAL_CONTINUATION_CAP = 20`、safe-consume、ACP defer 分支、error 不静默。本版保留这些，并补上 **accepted / onSkip / onError / final-settle**，消灭“nonterminal 已发出但无人 settle”的洞。[历史事实：`#schedulePostPromptTask` 无 `onError`、无 accepted；`#queueHiddenNextTurnMessage(true)` catch 空；ordinary-obligation `:8736-8768` 在 queue 后 `return true`；`isTerminal:false` 表示 async delivery **will resume before its true final settle**（`agent-session-events.ts:14-16`）]

#### 5.6.1 合同 [拟议但已确定]

在 `AgentSession` 内把 hidden-next-turn 提升为一等调度器（扩展现有 `#schedulePostPromptTask` / `#scheduleAgentContinue` / `#scheduleQueuedMessageDrain` / `#queueHiddenNextTurnMessage`，**不**新建第二套 timer/queue）。状态挂在 session 对象上，禁止进程全局 Map。

```ts
type DeliveryId = string; // opaque; mint = `dlv:${sessionId}:${kind}:${n}` 单调 n，不复用
type DeliveryState = "submitted" | "accepted" | "running" | "settled";
type SettleOwner = "hidden-next-turn" | "queued-user";

type ScheduleAccepted = {
  status: "accepted";
  deliveryId: DeliveryId;
  settleOwner: SettleOwner;
  attempt: number; // 从 1 起；retry 同 id 递增
};

type ScheduleSkip = {
  status: "skip";
  deliveryId: DeliveryId;
  phase: "pre-accept" | "post-accept";
  reason:
    | "aborted"
    | "stale-generation"
    | "preflight"
    | "acp-defer"
    | "disposed"
    | "capability"
    | "arm-off"
    | "cap"
    | "already_settled";
};

type ScheduleError = {
  status: "error";
  deliveryId: DeliveryId;
  phase: "pre-accept" | "post-accept";
  reason: "prompt-failed" | "persist-failed" | "invariant";
  retryable: boolean;
};

type ScheduleDecision = ScheduleAccepted | ScheduleSkip | ScheduleError;

interface HiddenNextTurnScheduler {
  submit(input: {
    kind: "headless-goal" | "queued-user";
    generation: number;
    resumeDeliveryId?: DeliveryId; // retry：必须传入已 accepted 的同一 id
  }): ScheduleDecision;
  onSkip(deliveryId: DeliveryId, skip: ScheduleSkip): void;
  onError(deliveryId: DeliveryId, err: ScheduleError): void;
  finalSettle(deliveryId: DeliveryId, reason: ScheduleSkip["reason"] | "completed" | "error"): void;
}
```

**状态机**：`submitted → accepted → running → settled`。`submit` 同步 skip/error（pre-accept）在回到调用方之前进入 `settled`，**不**经过 `accepted`。`settled` 是终态。

**Exactly-once guard**：session 内 `Map<DeliveryId, {state, attempt, emittedNonterminal, emittedTerminal}>`。`finalSettle` 对已 `settled` 的 id 是 no-op。未知 id → invariant，当前 turn 若尚未 terminal 则补一条。

**Retry 沿用同一 `deliveryId`**（关闭 R8R-H4；不换 id，因此不需要 transfer 事件）：

1. 可重试只允许 `phase:"post-accept"` 且该 id 已发过 `isTerminal:false`。
2. `onError(id, {retryable:true, phase:"post-accept"})` 调用 `submit({resumeDeliveryId: id})`。成功则 `attempt += 1`，state 回到 `accepted`/`running`，**不** `finalSettle`，**不** mint 新 id。
3. retry `submit` 失败：`finalSettle(id, "error")` 发 **同一 id** 的配对 terminal。
4. 新 `deliveryId` 不得在旧 id 仍为 `accepted`/`running` 时存在。禁止 `supersedes`。

**两类 skip（禁止双 terminal）**：

| 类 | 何时 | 谁发 terminal |
|---|---|---|
| pre-accept | `submit` 同步返回 skip/error；尚未 `accepted`；当前 `agent_end` 还没带 `willContinue` | **当前**这次 `agent_end` 直接 `isTerminal:true`（带该 id，或 ACP defer 不 mint running id）。`onSkip` **不得再**补发第二条 `agent_end`。 |
| post-accept | 已 `accepted` 且已发出 `isTerminal:false` 的 `agent_end` | `onSkip`/`onError`/`finalSettle` 必须再发 **同一 id** 的配对 terminal。`finalSettle` 是唯一补发入口。 |

**硬不变式（R7-D3 + R8-H3 + R8R-H4）**：

1. 只在 `submit` 已 `accepted` 且该 id settle owner 已安装时，才允许 `willContinue=true` / `isTerminal:false`。该 `agent_end` **必须**带 `deliveryId`。
2. 每个已发出 nonterminal 的 `deliveryId` 必须有且仅有一条同 id terminal。retry 不改变这条配对，只延长到达 terminal 的时间。
3. pre-accept skip：整段对该 id 的 `agent_end` 恰好一条，且为 terminal。
4. queued-user 唯一 drain：`#scheduleQueuedMessageDrain`。其 id 与 hidden id 不得共用。
5. dispose/abort：每个已 nonterminal 且未 settled 的 id 一条 terminal；尚未 accepted 的 id 不另发。

#### 5.6.2 现有调用点如何改 [拟议但已确定]

| 调用点 | 今日 [历史事实] | 本设计 |
|---|---|---|
| `#schedulePostPromptTask` `:2864-2889` | `onSkip` only | 增加 `onError`；返回含 `deliveryId`+`phase` 的 decision。 |
| `#scheduleAgentContinue` `:2896-2943` | skip/error 只回调 | pre-accept skip：当前 end 直接 terminal。post-accept：`onSkip`/`onError` → 同 id terminal 或同 id retry。 |
| `#scheduleQueuedMessageDrain` `:5828-5845` | canonical drain | 唯一 queued-user 入口；accepted 才 `willContinue`+该 id。 |
| `#queueHiddenNextTurnMessage(..., triggerTurn)` `:5878-5908` | catch 空 | `true` 必须 `submit`。pre-accept reject：当前 end terminal，不另发。catch 且已 accepted：`onError(id)`。`false` 只入队。 |
| `#promptQueuedHiddenNextTurnMessages` `:5911-5933` | throw | `onError(id)`；retryable 则同 id `submit({resumeDeliveryId:id})`。 |
| ordinary-obligation `:8736-8768` | queue 后 `return true` | 三门后 `submit`。仅 accepted 才 `return true` 并在将发的 `agent_end` 写 id。 |
| ACP defer `:6076-6104` | queue false, `return false` | 当前 end terminal。若 `submit` 则 `phase:"pre-accept"` + `acp-defer`，不另发。 |
| dispose | 无配对 | 仅 post-accept 未 settled 的 id：`finalSettle(id,"disposed")`。 |

`#schedulePostPromptTask` 的 stale-generation / aborted 继续当 skip，但必须 settle。

#### 5.6.3 A4 reserve / cap / safe-consume [拟议但已确定]

保留 R7 局部 PASS：

1. 计数在 `Goal.headlessContinuationCount`（default 0；rehydrate 逐字段复制，缺省 0）。禁止只放 `GoalModeState`（顶层不落盘）。
2. reserve 走现有 `GoalRuntime` async lock（`#commitState` / `#withAccounting`），禁止平行 lock。
3. `HEADLESS_GOAL_CONTINUATION_CAP = 20`。`count >= 20` 时 `submit` 回 `skip/cap`，零容忍：写 metrics 后 quality-stop 必须停 A4（与 facts T 表一致）。
4. **safe-consume**：只在 `submit` 已 accepted **之后** 才 `count += 1` 并 persist。accepted 之前失败不占额度。persist 失败 → `onError({reason:"persist-failed", retryable:true})`；retry 仍失败则 terminal，count 回滚到 persist 成功前。
5. `count > cap`（崩溃双增等）= 零容忍 stop，立即 invalidation A4。

A4 处理三门缺一不可（§5.3）。任一门假：`skip/capability` 或 `skip/arm-off`，当前 turn terminal，不 queue hidden message。

Fired：accepted 且 hidden prompt 实际发出时 `markLatencyArmFired("dsh_headless_continuation")`。skip 不 fired。

#### 5.6.4 事件序验收（按 deliveryId，关闭 R8R-H4）

按 **`deliveryId`** 断言，禁止只数全局 terminal：

1. 每个 `isTerminal:false` 的 `agent_end` 带 `deliveryId=D`。
2. 随后有限时间内出现 **同一 `D`** 的 terminal `agent_end`（retry 期间可有更多 start，但终态仍是 `D`）。
3. 每个 `D` 的 terminal `agent_end` 至多一条。
4. pre-accept skip：对该次调用恰好一条 terminal，零 nonterminal。

覆盖：

1. preflight reject — pre-accept；当前 end 一条 terminal；`onSkip` 不补发
2. generation skip — 若已 nonterminal(`D`) 则 post-accept terminal(`D`)；否则走 pre-accept
3. abort — 同 id terminal
4. scheduler error — non-retryable：terminal(`D`)；retryable：同 id `attempt+=1`，最终仍 terminal(`D`)，**没有 D2**
5. ACP defer — 一条 terminal，零 nonterminal
6. queued-user race — `D_h` 与 `D_q` 两 id，各自一条 terminal
7. dispose — 每个已 nonterminal 未 settled 的 id 一条 terminal

禁止只断言“session 继续存活”。

### 5.7 Observation / resume / 幂等（关闭 R7-D4）

#### 5.7.1 同一 JSONL 的 tagged union（关闭 R8-H2）[拟议但已确定]

唯一账本文件：`~/.omp/workflow-artifacts/latency-rollout-cohort.jsonl`，owner 仍是 `LatencyRolloutCohortStore`。[历史事实] 今日 `append` 只接受 `LatencyRolloutObservationV1`；`readAll`（`:181-201`）丢弃 `kind !== "latency_rollout_observation"`。`LATENCY_ROLLOUT_DECISION_KIND = "latency-rollout-decision"`（`arms.ts:223`）已存在但**不**写入该文件。

**禁止**第二文件、第二 SQLite、`dsh_ledger*`。

```ts
type CohortFileRecord =
  | LatencyRolloutObservationV1   // kind: "latency_rollout_observation"；仅 metrics
  | DshArmAssignmentRecordV1      // kind: "dsh-arm-assignment"
  | DshRunIntentRecordV1          // kind: "dsh-run-intent"
  | LatencyRolloutDecisionV1      // kind: "latency-rollout-decision"
  | ExperimentDefinitionV1;       // kind: "dsh-experiment-definition"

interface LatencyRolloutObservationV1 {
  // 现有必填：schemaVersion, kind, key, status, completed, endedAt
  // 现有可空：workflowId?, repairCycles, p0p1Escapes, costUsd, stageTimeMs,
  // spawnedAgents, firedArms
  event_id: string;
  phase: "metrics";               // 新写入必须是 metrics。缺省/旧行视为 metrics
  snapshotFingerprint: string | null;
  sessionId: string | null;
  experimentId: "EXP-A1" | "EXP-A23" | "EXP-A4" | null;
  dimensionId: "dim.a1" | "dim.a23" | "dim.a4" | null;
  assignmentRestored: boolean | null;
  bgFingerprint: string | null;
  sampleUnit: "session";
  stopApplied: boolean | null;    // R8R2-M2
  dshGetBranchError: boolean | null;
  dshGoalInjected: boolean | null;
  dshAdjacentIdentical: boolean | null;
  dshHeadlessCount: number | null;
}

interface DshArmAssignmentRecordV1 {
  kind: "dsh-arm-assignment";
  event_id: string;               // `dsh:${sessionId}:assignment:${fingerprint}`
  sessionId: string;
  payload: DshAssignmentV1;
  endedAt: string;
}

interface DshRunIntentRecordV1 {
  kind: "dsh-run-intent";
  event_id: string;               // `dshint:${sessionId}:${experimentId}:${executionId}`
  sessionId: string;
  experimentId: "EXP-A1" | "EXP-A23" | "EXP-A4";
  executionId: string;            // UUID；一次 session-end execution / resume run
  state: "pending" | "committed";
  startedAt: string;
  committedAt: string | null;
  metricsEventId: string | null;  // session-level `dsh:${sessionId}:metrics:${experimentId}`
  expiresAt: string;
}

interface LatencyRolloutDecisionV1 {
  // 现有：schemaVersion, kind:"latency-rollout-decision", workflowId,
  // status, snapshot, attributionKnown, observed, disabledArms, evaluatedAt
  event_id: string;               // `dshdec:${crypto.randomUUID()}`
  revision: string;               // 与 event_id 的 UUID 相同
  scope: "machine";
  reason: string;
  expiresAt: string;
  // 不存在 targetArms。kill 集合的唯一字段是现有 disabledArms（R8R2-M1）
}
```

**H1 选择方案 2**：assignment **不是** observation。禁止再写 `phase:"assignment"` 的 observation。journal `dsh.arm_assignment.v1` 仍是 session 内 restore 源；JSONL 的 `dsh-arm-assignment` 是跨进程后备。二者都不是第二 ledger。

**Parser**：

1. 空行跳过。`JSON.parse` 失败（含残缺末行）跳过。
2. `kind==="latency_rollout_observation"` 且 `typeof key==="string"` 且 `typeof completed==="boolean"` → observation。无 `phase` 视为 `"metrics"`。若显式 `phase==="assignment"`：**拒绝该行**（旧错误写入），记 parser 计数，不进任何 aggregate。
3. `kind==="dsh-arm-assignment"` 且有 `sessionId`+`payload.fingerprint` 且 `endedAt` 为可解析 ISO-8601 字符串 → assignment。缺/非法 `endedAt`：**拒绝该行**（R8R3-M2）。此 kind **没有** `completed`，旧 `readAll` 因 kind 丢掉它，不污染 legacy completion。
4. `kind==="dsh-run-intent"` 且有 `sessionId`+`experimentId`+`executionId` 且 `startedAt` 为可解析 ISO → intent。`state` 必须是 `pending|committed`。缺 `executionId`：**拒绝**。
5. `kind==="latency-rollout-decision"` 且 `Array.isArray(disabledArms)` 且 `typeof revision==="string"` → decision。若存在 `targetArms` 且与 `disabledArms` 排序后不完全相等：**拒绝该行**。只认 `disabledArms`。
6. `kind==="dsh-experiment-definition"` 且有 salt/window → definition。
7. 其它 kind 跳过。旧 `readAll` 仍只返回 observation。intent/assignment/decision **不进** legacy completion。

**唯一 replay 权威（关闭 R8R2-H3）——禁止 `sequence` 字段**：

| kind | dedupe key | 胜出 |
|---|---|---|
| observation | `event_id` | `endedAt` 最新；并列后出现 |
| assignment | `event_id` | `endedAt` 最新；并列后出现 |
| intent | `event_id` = `dshint:${sessionId}:${experimentId}:${executionId}` | 同 executionId 内：committed 胜 pending。**不同 executionId 互不覆盖**。禁止再用无 executionId 的旧 key。 |
| decision | `sorted(disabledArms).join("+")` | `evaluatedAt` 最新；并列 `revision` 字典序更大。过期无效 |
| definition | `experimentId` | 同 decision |

**Aggregate 过滤**：只消费 `kind===observation && phase==="metrics"`。assignment / intent / decision / definition **不进** completed 分母。

**API**：

- **Execution 边界（R8R7-M1）**：metrics 只在 **session-end / 该 execution 的 terminal settle** 写一次。因此每个 `(sessionId, experimentId)` 在一次 execution 里只 mint **一条** pending，不得每个 ordinary model turn mint。`executionId` 在下列时刻 mint 一次并写入 journal assignment 副本（resume 可恢复）：(a) 新 session 第一次对该 experiment `role!==excluded` 的 assignment；(b) **同 sessionId resume 开启新的 session-end 周期**（新 execution，新 UUID）。同一 execution 内后续 turn 复用该 `executionId`，不再写新 pending。
- `appendRunIntent(pending)`：仅在上述 mint 点成功写入 `executionId` 对应 pending。失败 → 该 dim `excluded`。没有该 execution 的 pending 不得跑 treatment。
- `appendObservation`：session-end 写 `phase:"metrics"`（session 样本仍 latest-wins on `(sessionId, experimentId)`）。成功后立刻 commit **同一 executionId**：`appendRunIntent({state:"committed", executionId, metricsEventId, committedAt})`。commit 不得指向其它 executionId。metrics 或同 execution commit 失败 → degraded，不得 evaluate / 不得 complete。
- `appendDecision`：**同步有界重试，禁止内存 queue**。owner = `#evaluateLatencyRolloutAtSessionEnd`。返回 / 正常 teardown 之前必须到达下列 **互斥终态之一**：
  1. JSONL decision append 成功（最多 3 次同步：10ms / 50ms / 200ms）→ stop **已持久**。随后只 unlink **本 writer 拥有的** fence 文件（见 H1）。
  2. JSONL 三次都失败，但 **本 writer 的独立 fence 文件写成功** → stop **已持久**（via 该 fence）。本进程 override+invalidate。
  3. JSONL 与本 writer fence **都失败** → stop **未持久**。本进程 override+invalidate，置 store 实例 `controlPlaneDegraded=true`（挂在 `LatencyRolloutCohortStore` / SDK 构造上下文，**不是**模块级 Map）。**正常 teardown / 正常 process exit 被阻断**：`appendDecision` 不得返回成功；session-end 必须继续同步重试直到 (1) 或 (2)，或调用方选择 `abortExit(1)`。不得在未持久时走“干净退出”。
- **R8R4-H1 选方案 2：per-revision fence 文件集**（不用无 CAS 的固定文件 RMW）：
  - 路径：`latency-rollout-cohort.fence.<revision>`，`revision` = 本次 decision UUID。
  - 内容一行 JSON：`{revision, disabledArms, evaluatedAt, expiresAt}`。tmp+rename 只写自己的文件，从不改别人的。
  - `readActiveDecisions()` **union 目录内全部**未过期 `latency-rollout-cohort.fence.*` 的 `disabledArms`，再并上 JSONL 胜出 decision。任一未清 fence 都保护其集合。
  - **只许删除自己拥有的文件**：JSONL 里出现覆盖 `this.disabledArms` 的成功 decision 后，仅 `unlink(latency-rollout-cohort.fence.<this.revision>)`。ENOENT = 已删，算成功。禁止读-改-写别人的 fence，禁止固定文件名覆盖。
  - 测试：两并发 writer（A1 与 A4）；交错读空后各自写自己的 fence；B 持久化 A4 并删除 **自己的** fence 后，A1 fence 必须仍在。任一未持久 decision 必须仍有未删除 fence。
- **R8R4-H2 强保证 + R8R5-H1/H2 完整性**（probe 成功 ≠ 过去 stop 已持久）：
  - both-fail 不得正常退出，见终态 3。
  - store **不是**每个 session 各 mint 一个 `bootNonce`。SDK process-scoped canonical rollout context（`createCodingAgent` / 进程根）构造 **一个** `LatencyRolloutCohortStore`，mint **一次** `bootNonce`+`startupAt`，所有 session 共享该实例。新 `new LatencyRolloutCohortStore()` 若未注入该 context，**禁止**再 mint nonce 来绕过 process-level gate（R8R6-M1）。ack consume 后同一实例置 `ackAcceptedForBoot=true`，本 boot 后续 assignment 仍认这笔 ack，不必文件还在。
  - SIGKILL / 崩溃后下一启动 **默认 DSH degraded**，直到下面 **一条** 成立：
    1. 未过期 fence 或 JSONL decision 可见；或
    2. `recomputeStopsFromDurableMetrics()` 返回 `{complete:true}`。必须：
       - 重读 JSONL；无残缺无法判定的区间；
       - 枚举全部 `expiresAt > now` 的 intent，**按 `executionId` 逐条**（不同 executionId 互不覆盖）；
       - **每一个 executionId** 的胜出行 `state==="committed"`，且 commit 引用的 `metricsEventId` 存在合法 metrics（session 样本仍可 `(sessionId,experimentId)` latest-wins）；
       - 任一 execution 仍 `pending` / 缺同 execution commit / 行损坏 → `complete:false`；
       - 旧 execution committed **不能**让新 execution pending 消失。evaluate 只用本次重读 snapshot。全部未过期 execution 已 committed 但低于 min-sample → `complete:true, stops=[], belowMinSample:true`。
    3. **本次 boot** operator-ack：`bootNonce`+`createdAt>=startupAt`，consume 后 `ackAcceptedForBoot=true`。旧 ack 不解禁。ack ≠ definition。
  - 测试：
    - 同机 A/B 两 session：仅 A 的 execution committed，B pending → `complete:false`。
    - **同 session 旧 execution committed + resume 新 execution pending + crash → `complete:false`**；新 execution committed 后才 `complete:true`。
    - 不得因旧 key / lastSessionId / 旧 commit 解禁。
  - `probe()` 只回答现在能不能写，单独成功不解 degraded。
- **Writability probe（R8R4-M1）**：每次 `probe()` 使用 **唯一** 路径 `latency-rollout-cohort.probe.<uuid>`。写 `{pid,at}`（tmp+rename）再 `unlink` 自己的文件。`unlink` ENOENT = 成功。不得使用固定 `.probe` 名。并发 probe 互不影响；测试两进程同时 probe 均成功。失败（ENOSPC/EACCES/只读）→ 全部 excluded。probe 不是 ledger，不参与 replay。残留 `probe.*` 可在下次启动扫年龄 >5min 后删除，删除失败忽略。
- **读路径**：`readActiveDecisions()` = JSONL 胜出 ∪ **全部** 未过期 per-revision fence。cohort 不可读 → 全部 DSH 不得 treatment。不得把“读不到 decision 行”当成“没有 stop”。
- 无跨 session 内存 queue。正常 teardown 不得在终态 1/2 之前返回。
- `appendExperimentDefinition`：开窗一次性写入。
- `readAllRecords` / `readActiveDecisions(now)` / `probe()` / `recomputeStopsFromDurableMetrics()` / `readActiveExperimentDefs` / `applyDecisionsToGetSetting`（只读 `disabledArms`）。

**Precedence（freeze 与 resume；assignment 前先 `probe()`，但 probe 成功不解 degraded）**：

1. 本 store 实例 `controlPlaneDegraded`，或启动时不满足解除条件（无 fence/decision、**任一未过期 executionId 未 committed**、无本 boot `ackAcceptedForBoot`）→ 全部 excluded。
2. `probe()` 失败或 cohort 不可读 → 全部 excluded（现在不可写/不可读）。
3. 任一未过期 per-revision fence 或 `readActiveDecisions()` 命中 → 命中臂 effective false，`stopApplied=true`。
4. journal assignment：恢复 `assignedTreatment`/`role`，禁止重抽。effective = `assignedTreatment && !stopApplied`。
5. live settings。
6. 缺省 DSH false。

**Expiry**：每条 fence / decision 各自 `expiresAt = max(evaluatedAt + 30d, def.windowEnd + 7d)`。零容忍至少 `evaluatedAt+30d`。过期 fence 读取时忽略，但不自动 unlink（避免并发误删）。

**测试**：并发 fence 互不删除；双失败阻断正常 teardown；旧 ack+crash 零 treatment；A/B 两 session 缺 B commit → `complete:false`；**旧 execution committed + 新 execution pending + crash → `complete:false`；新 execution committed → `complete:true`**；不得每 turn mint pending。


#### 5.7.2 event_id 与 session 样本（关闭 R8-M2）[拟议但已确定]

**样本单位 = session**。每个 `(sessionId, experimentId)` 最多一条计入分母的 metrics。resume / rewrite / 重试合并为这一条。

```ts
type DshAssignmentV1 = {
  v: 1;
  sessionId: string;
  arms: Record<string, boolean>;
  assignedArms: Record<string, boolean>;
  dimensions: DimensionSlice[];
  fingerprint: string;
  frozenAt: string;
  experimentDefRevision: string;
  experiments: Array<{
    experimentId: "EXP-A1" | "EXP-A23" | "EXP-A4";
    dimensionId: "dim.a1" | "dim.a23" | "dim.a4";
    role: "treatment" | "control" | "excluded";
    stopApplied: boolean;
  }>;
};
```

`event_id` 只从 durable 身份推导，**没有 `sequence` 字段**：

- assignment（`dsh-arm-assignment`）：`dsh:${sessionId}:assignment:${fingerprint}`
- metrics observation：`dsh:${sessionId}:metrics:${experimentId}`

rewrite / resume / 重试 = **同一 `event_id`**，latest-wins 只看 `endedAt`（并列 = 文件后出现）。crash 仅有 assignment kind、无 metrics observation：不进 completed 分母。factorial A1+A4 = 两条 metrics observation，不是两个随机单位。

**R8R2-M2 样本规则（ITT 审计 ≠ efficacy 分母）**：

| 集合 | 谁进 | 用途 |
|---|---|---|
| ITT 审计 | `role=treatment` 的 session，含后来 `stopApplied=true` | 只报表，**不**驱动 NI / re-enable |
| Efficacy / NI / min-sample / T1 T2 | `role=treatment\|control` **且** `stopApplied!==true` 的 metrics observation | 唯一可触发 quality-stop 与重新启用判断的分母 |
| Censored | `stopApplied===true` 的 metrics | 保留审计；从 efficacy 剔除。该 dim 在 `expiresAt` 前不得再被 hash 成新 treatment（新 session 因 active decision/fence 已 effective false） |
| 无 metrics | 仅 assignment kind | 两分母都不进 |

不得用 disabled 行为数据判断“是否该重新打开臂”。测试：一条 `stopApplied=true` 的 treatment metrics 增加 ITT 计数、不改变 efficacy completion/NI 分母。

#### 5.7.3 A/B assignment（关闭 R8-H4）[拟议但已确定]

live settings freeze **不是**实验分配。分配算法在 freeze 之前跑，输出每个 dim 的 `role`，再把对应 DSH 臂写成显式 `true`/`false` 后 freeze。

**共同 primary outcome**（三实验相同，保证可比）：session 是否在无 P0/P1 escape 的情况下达到 `completed===true`（沿用 `LatencyRolloutObservationV1.completed`）。次要：A1=`dshGetBranchError`；A23=`dshGoalInjected` + `dshAdjacentIdentical`；A4=`dshHeadlessCount` 与 cap 违规。non-inferiority 的分母 = 同 `bgFingerprint`、同 `experimentId`、`role=control` 的 session 样本在**同一日历窗**内的 primary outcome 率；treatment 率 − control 率 < −10pp 则 stop。不得拿“全部 arm false”的 latency `baseline` 当分母。

**Pre-treatment eligibility**（任一实验）：

1. `agentKind==="main"` 或 task subagent 明确 opt-in；TUI interactive main 对 EXP-A4 因 capability=false → A4 `excluded`，仍可进 A1/A23。
2. 非 ACP-defer 会话才可进 EXP-A4 treatment；ACP 会话 A4=`excluded`（不是 control——不可比）。
3. 必须能在 `createTools` 前得到稳定 `sessionId`。
4. 不在另一实验的 washout 黑名单里（见下）。
5. `BG` 可解析。eligibility **在**读 DSH 臂 live settings 之前判定，避免“用户已手动打开 session_search”自选进入 treatment。

**稳定 assignment key**：`sha256(sessionId + ":" + experimentId + ":" + experimentDef.salt)`。salt / 日历窗 / washout **不**由 session 先写后读。

**Canonical owner（关闭 R8R-M1）**：同一 JSONL 的 `kind:"dsh-experiment-definition"`，owner 仍是 `LatencyRolloutCohortStore`，不是第二引擎。

```ts
const EXPERIMENT_DEFINITION_KIND = "dsh-experiment-definition" as const;
type ExperimentDefinitionV1 = {
  kind: typeof EXPERIMENT_DEFINITION_KIND;
  event_id: string;     // `dshdef:${experimentId}:${revision}`
  revision: string;     // UUID；新开窗 mint 新 UUID
  experimentId: "EXP-A1" | "EXP-A23" | "EXP-A4";
  salt: string;         // 开窗 mint，窗内不变
  windowStart: string;
  windowEnd: string;
  washoutEnd?: string;  // EXP-A1：windowEnd+3d
  evaluatedAt: string;
};
```

`readActiveExperimentDefs(now)` 见 §5.7.1。无当前窗 definition → 该实验全部 `excluded`（fail-closed，不自制 salt）。开窗 = 一次性 `appendExperimentDefinition`（实现授权后由发布清单写出三行 definition）。**发布清单另列 boot-bound operator-ack**：仅用于“本进程打印的 `bootNonce` 确认这次启动没有未知未持久 stop”。ack **不**开窗、**不**提供 salt、**不**替代 definition。初次无 metrics 时启动默认 degraded，必须先有 definition，再按需写 **当前** bootNonce 的一次性 ack。

| 实验 | 窗（definition） | 桶 | 互斥 |
|---|---|---|---|
| EXP-A1 | 14d | `<32768` → t；否则 c | 与 A23 时间互斥 |
| EXP-A4 | 14d，可与 A1 重叠 | 独立 salt | 与 A1 factorial；与 A23 时间互斥 |
| EXP-A23 | A1 `windowEnd+3d` 起 21d | t ⇒ A2∧A3 true；c ⇒ 皆 false | washout 内 A1 与 A23 都 excluded |

50/50。手工打开 DSH settings 且 hash 分到 control → 强制 control（仍是可比 control，不是 excluded）。

**Exclusion / 不双计**：

- 同一 `(sessionId, experimentId)` 一条 outcome。resume 合并。
- washout：读 A1 definition 的 `washoutEnd`；期内 A1 已 assigned 的 session 及其 fork 不得进 EXP-A23。
- A2 xor A3：两臂强制 false + `dsh-arm-assignment` invalid 行；不进 EXP-A23。
- A1+A23 同时 assigned t：两实验 excluded，两臂组强制 false。
- ACP / capability 不足 → 仅该 dim `excluded`。

**A1+A4 = factorial**。各用自己的 control key（同 `bgFingerprint`）。

#### 5.7.4 Resume / fork 身份 [拟议但已确定]

[历史事实] resume：`session-manager.ts:997-1002` `this.#sessionId = header.id`。fork：`mintSessionId()`。

1. 同 `sessionId` resume：restore assignment，禁止重抽。先 `readActiveDecisions()`（及 fence）：命中则 effective false + `stopApplied=true`。`createTools` 用 effective 臂。ITT 审计保留原 `role`；efficacy/NI **剔除** `stopApplied` 行（§5.7.2）。
2. journal 与 JSONL assignment 都缺或 fingerprint 损坏：事故路径。按当前 `ExperimentDefinition` 重 hash，写 `assignment_reissued`。热路径不得走。
3. fork / 新 session：新 `sessionId`，读当前 definition 重新 eligibility + hash。不继承 parent assignment；仍受 active stop 约束。

`dsh.arm_assignment.v1` 与 `dsh.goal_hash_shadow.v1` 同一 `appendCustomEntry` owner，不是第二 ledger。

#### 5.7.5 Quality-stop（同一 evaluator）[拟议但已确定]

`evaluateLatencyQualityStop` / `buildLatencyRolloutDecision` 仍是 **唯一** stop evaluator。DSH 规则按 **dimension** 附加。A2 xor A3 在 freeze 已强制两臂 false，不会作为“未监控 treatment”到达 evaluator。exact-set validation（R8-M1）是拟议增强：`childArms` 必须等于该 dim 声明集合，否则该 dim `attributionKnown=false` → `missing_attribution`。这不是当前源码。

| 规则 | 值 | 样本 | 动作 |
|---|---|---|---|
| A1 T1 getBranch `isError` | >5%（5 min） | EXP-A1 efficacy treatment（`stopApplied!==true`） | disable A1 |
| A23 T2 goal 零注入 | >2% session | EXP-A23 efficacy t | disable A2+A3 |
| A23/A4 non-inferiority | t − matched c < −10pp | efficacy 分母；同 bgFingerprint；**不含** stopApplied | disable 该 dim |
| A4 count > cap | 零容忍 | 任一 session（含 stop 前） | disable A4 |
| 全局 token | >3× 同 bg control 且 >30min | efficacy session | 按 dim fired |
| min sample | A1/A23=200；A4=100 | **仅** efficacy 行 | 未满只跑零容忍 |

latency 字段继续用 `LATENCY_COHORT_MIN_SAMPLES=8`。因果 rollback：只 disable 该 dim 的 fired∩active；无 fired 则 disable 该 dim 全部 child。**禁止**因 A1 stop 而 disable 背景四臂或 A4。

决策写入同一 JSONL 的 `latency-rollout-decision` 行（§5.7.1）。新进程 freeze 前 `applyDecisionsToGetSetting`。


### 5.8 错误处理与回退

| 失败 | 行为 | 回退 |
|---|---|---|
| freeze 前 settings 缺 DSH key | resolved `false`（与 `get(path)===true` 规则一致） | 控制臂；不 fall through |
| journal 缺 `firstKeptEntryId` 目标 | A1 `isError:true` | 不伪造 compacted 空集 |
| A1 factory 时 session 未构造 | 不发生：factory 只读预冻 snapshot | 禁止闭包解引用未构造 AgentSession |
| quality-stop | 现有 evaluator + `settings.override(false)` + `invalidateLatencyArmSnapshot` + A1 动态移除 + executor re-gate | 新 session 读 JSONL 决策 |
| A4 persist 失败 | `onError` retry；仍失败 terminal，count 回滚 | 不留 nonterminal |
| JSONL `appendDecision` 失败 | 同步 3 次；再失败写自己的 fence；双失败阻断正常 teardown | 强杀后默认 excluded。任一 pending intent → recompute incomplete |
| JSONL `appendObservation` / intent commit 失败 | pending 保留；degraded；不得 complete | 不声称 machine-complete |
| 实现授权 | 无 | 未获独立授权前零产品改动 |

### 5.9 风险与缓解

- 风险：模块仍叫 `latency/`，后续作者再开 `dsh/` 平行树。缓解：§5.1 禁止清单 + Gate 扫符号 `DshFeatureOverrides`/`globalDshKillSwitch`/`dsh_ledger`。
- 风险：`Settings.override` 污染 subagent。缓解：承认为既有 latency 行为；跨进程只认 JSONL；本文不另开平行 override。
- 风险：A1 扫描 P95 超 20ms。[未验证假设] 缓解：实现期实测；超标另开索引设计，不预建。
- 风险：SDK 闭包再次绑未构造 session。缓解：§5.2 强制 snapshot 对象闭包；测试断言 `createTools` 前 snapshot 已冻结。
- 风险：`isTerminal:false` 回归。缓解：§5.6.4 七条事件序测试，禁止“session 仍存活”代替 terminal。

## 6. 验证计划

授权仍为 design-only。下列测试在**独立实现授权之后**才写入仓库。路径自包含，不依赖被替换的 R1–R7 设计正文。

### 6.1 单测

| 文件 | 断言 |
|---|---|
| `packages/coding-agent/test/latency/arms.test.ts`（新） | §5.1.2 control rows；xor 两臂 false |
| `packages/coding-agent/test/latency/rollout-cohort.test.ts`（扩） | 旧 execution committed + 新 execution pending + crash → `complete:false`；新 execution committed → `complete:true`；A/B 缺 B commit → `complete:false`；不得每 turn mint pending；旧 ack 不解禁；process-scoped bootNonce |
| `packages/coding-agent/test/tools/session-search.test.ts`（新） | current-branch；分区；ToolCall；OutputSink；re-gate |
| `packages/coding-agent/test/goals/goal-runtime.test.ts`（扩） | A2 开时无 timeUsedSeconds；xor 后仍插值 time |
| `packages/coding-agent/test/goals/goal-hash-shadow.test.ts`（新） | `dsh.goal_hash_shadow.v1`；相邻分母 |
| `packages/coding-agent/test/session/hidden-next-turn-scheduler.test.ts`（新） | §5.6.4：pre-accept 恰一 terminal；post-accept 同 id 配对；retry 同 id attempt++；无 D2；queued-user 两 id |
| `packages/coding-agent/test/session/dsh-assignment-resume.test.ts`（新） | salt 来自 definition 行；无 definition → excluded；resume 保留 assignedTreatment 但 stop 后 effective false；control 写 metrics |

### 6.2 集成 / smoke（实现授权后）

- 控制臂 session：无 `session_search`，goal prompt 仍含 `timeUsedSeconds`，无 hidden continuation。
- A1 处理：compaction 后工具能命中 compacted toolCall/toolResult。
- A23 处理：连续两 turn usage 变化不重注入；status 变化重注入；shadow 相邻分母可算。
- A4 处理：三门全真才 continuation；cap=20 后 skip+terminal；ACP defer 零 nonterminal。
- kill 后已注册 A1：下一次 execute `isError`，active set 已去掉该工具。
- 跨进程 / resume：union 全部 fence。重启按 **每个 executionId** 检查 commit，旧 commit 不能遮蔽新 pending。

### 6.3 根因前提核对

- 仓库无第二套 `dsh/arms.ts` / SQLite ledger / process Map kill。
- `isTerminal:false` 合同与调度器实现同文，不再互相否定。

## 7. 关键决策摘要

1. Scheme A：唯一 owner `latency/arms.ts`。
2. Assignment / intent / metrics 同 JSONL。aggregate 只吃 metrics observation。
3. **R8R7-H1**：intent key = `dshint:${sessionId}:${experimentId}:${executionId}`。commit 只完成同一 executionId。completeness 逐 execution 枚举。
4. **R8R7-M1**：一个 execution = 一次 session-end / resume run；只在 mint 点写一条 pending，不在每个 model turn 写。
5. Per-revision fence；只删自己的文件。both-fail 阻断正常退出。
6. durable-before-evaluate。旧 ack 不解禁。ack ≠ definition。
7. Replay：`event_id`+时间戳。Kill 集合只有 `disabledArms`。
8. `stopApplied` ITT ≠ efficacy。A4 同 id retry。
9. exact-set 仍是拟议增强。
10. design-only。不伪造 `reviewed_revision`。

## 7.1 逐文件实现表（关闭 R7-D4 自包含要求）

| 路径 | 变更 | 合同 |
|---|---|---|
| `packages/coding-agent/src/latency/arms.ts` | 加宽 IDs/settings；`dimensions[]`；`REGISTERED_COMBINATIONS`；exact-set validation（拟议） | 唯一 owner。H1 表。`get===true` 否则 false。 |
| `packages/coding-agent/src/config/settings-schema.ts` | 四个 boolean 字面量（§5.5.4） | default false；不新增 `goalHeadlessContinuation`。 |
| `packages/coding-agent/src/tools/builtin-names.ts` | 加 `"session_search"` | 不加 hidden。 |
| `packages/coding-agent/src/tools/session-search.ts` | **新** A1 工具 | §5.5.1。description **import** 自 md，模块内不写第二份长描述。 |
| `packages/coding-agent/src/prompts/tools/session-search.md` | **新** 唯一模型面描述 | 仓库惯例：builtin 用 `src/prompts/tools/*.md` + `import … with { type: "text" }`（见 `bash.ts`/`grep.ts`）。禁止把长描述再抄进 tool 模块。 |
| `packages/coding-agent/src/tools/index.ts` | `BUILTIN_TOOLS.session_search` | snapshot `!==true` → `null`。 |
| `packages/coding-agent/src/session/session-tools.ts` | `setSessionSearchToolEnabled` | 对照 `setComputerToolEnabled`。 |
| `packages/coding-agent/src/sdk.ts` | `createTools` 前 assignment+freeze；闭包绑 snapshot | 挂 fired/invalidate。 |
| `packages/coding-agent/src/session/agent-session.ts` | snapshot / A2A3 / A4 调度器 / session-end decision append+retry | 同 id retry；pre/post-accept skip；resume 先 apply stop |
| `packages/coding-agent/src/session/agent-session-types.ts` | `allowHeadlessGoalContinuation` | capability only。 |
| `packages/coding-agent/src/session/agent-session-events.ts` | `agent_end.deliveryId?` | 不改 `isTerminal` 语义。 |
| `packages/coding-agent/src/goals/runtime.ts` | A2 omit time | xor 后仍插值 time。 |
| `packages/coding-agent/src/goals/state.ts` | `headlessContinuationCount?` | default 0。 |
| `packages/coding-agent/src/interactive-mode.ts` | rehydrate count；TUI capability false | 缺字段 → 0。 |
| `packages/coding-agent/src/task/structured-subagent.ts` | capability true | 共享 settings。 |
| `packages/coding-agent/src/latency/rollout-cohort.ts` | `dsh-run-intent` key 含 `executionId`；session-end 边界 mint/commit | 旧 commit 不能遮蔽新 pending；每 execution 一条 pending |
| `packages/coding-agent/src/latency/arms.ts`（`:161-301`） | 同一 evaluator | 只读重开后的 durable cohort |
| 测试 | §6.1 | 旧 gen committed + 新 gen pending → complete:false |
| 禁止出现 | `DshFeatureOverrides`、`effectiveSetting`、`globalDshKillSwitch`、`dsh_ledger*`、`src/dsh/**` | Gate 扫描。 |

实现顺序（授权后）：(1) arms+settings 字面量与 combination；(2) snapshot 前移到 `createTools` 前；(3) A1 工具+动态移除；(4) A2/A3 renderer/reset/shadow/rehydrate；(5) A4 调度器+cap；(6) cohort 字段+replay+stop 规则；(7) §6 测试。任一步不满足则停，不靠平行引擎补洞。

## 8. Handoff

### 8.1 同会话继续

按当前宿主规则触发与 grok 异模型的只读 DSHGateReviewer（gateway/gpt-5.6-sol，xhigh）；不得通过 shell 启动模型 CLI / worker。

### 8.2 新会话恢复 prompt

```text
请读取完整设计输入集合 docs/superpowers/specs/2026-08-14-dsh-context-quality-design.md 与 docs/superpowers/specs/2026-08-14-dsh-context-quality-facts-brief.md，生成按 normalized path 排序的 path + SHA-256 `Reviewed Inputs` manifest，并计算 `reviewed_revision`；pre-review handoff 不伪造 digest。设计元数据：design_author=grok；design_author_identity=GrokDesignerR10；current_replacement_author_agent_id=GrokDesignerR10；current_replacement_author_model=gateway/grok-4.6；facts_brief_author_agent_id=GrokDesigner；implementation_authorization=design-only；authorization_source=用户 2026-08-14 原要求将 DSH 对照分析沉淀为可评审设计并在新会话 review 后实现；用户随后明确停止使用 Claude，改用 Grok 4.6 完成设计；当前仍未授权实现。
使用起草前选定且与全部内容作者异模型的只读 DSHGateReviewer（gateway/gpt-5.6-sol，xhigh）执行独立 Design Review；将完整 review artifact 持久化到 docs/superpowers/plans/2026-08-14-dsh-context-quality-subagent-review.md。按宿主记录 review_mode=host-native、author/reviewer native agent_id、model、verdict、授权来源与证据；不得通过 shell 启动模型 CLI / worker。
若文档包含根因分析，请一并核对根因判断、证据与设计方案是否一致。
评审结论必须为 PASS / PASS_WITH_NOTES / NEEDS_REVISION / NEEDS_REDESIGN 四选一，并附可复查证据；禁止作者自审。
NEEDS_REVISION 时回到当前设计文档修订；NEEDS_REDESIGN 时回到 design-brainstorm 重做方案；正文变更后均须重新执行 Gate，且在通过前不得实现。
PASS/PASS_WITH_NOTES 后，current Inputs manifest 等于 reviewed manifest 或存在覆盖全部输入的有效 Gate Continuity Note，且 implementation_authorization=authorized，才继续 design-implement；design-only 必须停止。
Review 后输入变化由未参与 author/reviewer/正文修改/implementation 的主协调者按 handoff 规则分类；非实质变化持久化覆盖完整 manifest 的 Gate Continuity Note，实质、不确定、遗漏输入或角色未分离时重跑 Gate。
```

design-only 停止：本文到 Review Gate 为止。未获独立实现授权前，不得修改产品代码、测试、CI、migration 或 rollout 数据。

