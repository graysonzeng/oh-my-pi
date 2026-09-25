# Reviewer Shadow Mind 独立 Design Review — Round 2

## Verdict

**PASS_WITH_NOTES**

- `review_mode`: `host-native`
- `reviewer_agent_id`: `ShadowMindDesignReviewR2`
- `reviewer_model`: `composer-2.5-fast`（Cursor Composer）
- `reviewer_effort`: （宿主默认）
- `planned_reviewer`: `sol-xhigh-reviewer`（gateway/gpt-5.6-sol @ xhigh）
- `planned_reviewer_note`: 原 planned reviewer 因 Other Models 额度失败，本轮改用 Composer；仍与 `design_author_identity: cursor-grok-4.6` 异模型，非作者自审
- `design_author`: `grok`
- `design_author_identity`: `cursor-grok-4.6`
- `reviewed_revision`: `d38bb45464b8ec011841820b57297817d79ae841a5f7fe71a9e07cdbd34d92c6`
- `review_date`: `2026-08-17`
- `prior_review`: `docs/superpowers/plans/2026-08-17-reviewer-shadow-mind-subagent-review.md`（R1 `NEEDS_REDESIGN`）

**结论依据**：R2 已将 canonical owner 从 R1 的 `ExtensionRunner` 布尔屏障改为 reviewer 会话上的 `AsyncJobManager` cohort job + 现有 `async-result` delivery；对照当前 `executor.ts` / `agent-session.ts` / `job-manager.ts` 源码，**cohort 在第一次 `prompt` 前登记即可让首次 terminal `yield` 停驻**，job 完成必走 `#enqueueDelivery` → `async-result` 从而失效旧 yield。R1 两项 Blocking 与五项 Major 在**设计合同层**均已关闭。剩余问题为实现期的 `isolatedChild` SDK 细节与 rollout 纪律，不构成 redesign。

本结论**授权实现**（`implementation_authorization=authorized` 仍有效），但实现须按 §6.1 全部门禁与下文 Major notes 落地；§6.2 A/B 未完成前不得声称质量已证明。

## Executive Summary

1. **[事实] R2 核心合同与现有 yield 状态机对齐。** `AsyncJobManager.register()` 同步将 job 置为 `running`（`job-manager.ts:208-211`）；reviewer 子会话继承进程 singleton 且按 `#agentId` 注册 delivery sink（`agent-session.ts:1282-1290`）；`hasPendingAsyncWork()` 过滤 owner running jobs / pending deliveries / yield queue 上的 `async-result`（`:1771-1795`）；monitor 在 `yield` 结束时若 `sessionHasPendingAsyncWork()` 则 `requestYieldTurnStop()` 而非 terminate（`executor.ts:1442-1448`）；`async-result` 注入使 `yieldCalled` 清零（`:1354-1358`）；`driveSessionToYield` 循环 `settleAsyncWork()` 直至 quiescence（`:1938-1978`）。
2. **[事实] R1 Blocking 根因已在 R2 删除。** 不再 propose `hasBackgroundWork` / `shadow-report` custom type / 扩展 `turn_end` 完成锁。
3. **[事实] fail-open 与 prompt 不再互斥。** unqualified / register 失败 / `restrictToolNames` → 不登记 job；prompt 仅「有 shadow-review async-result 则复核，无则单核，禁止等待」（spec §5.4-5.5）。
4. **[推导] `isolatedChild` 是正确的新 seam，但当前仓库尚不存在该选项**（`grep isolatedChild` 零命中）；能否同时保留 `report_to_main` 并挡住 inline/MCP/write 取决于实现是否严格复刻 spec §5.4 分支，而非 `restrictToolNames` 误用。
5. **[事实] 默认 `task.shadowReview.enabled: true` 与 A/B 未完成：spec 已显式允许**——§6.1 通过后可合并，须 kill switch + changelog 标明 A/B 未完成（§6.2）。**不构成 Design Gate Blocking**；属运营/质量 Major note。
6. **[事实] 无第二套完成引擎。** Shadow 为 executor 调用的 library；单 cohort job、单次 delivery；不在 `turn_end` 再开第二轮。
7. **[未验证假设]** 本轮未跑测试/build/真模型 smoke；停驻/失效/fail-open 结论来自静态源码对照，非运行时证据。

## Reviewed Inputs

以下 SHA-256 基于评审时文件原始 bytes（lowercase hex）。路径为相对仓库根 `/Users/sheng/tencent/oh-my-pi` 的 normalized POSIX path。`../pi-shadow-mind/**` 为 sibling 上游只读对照。

| Path | SHA-256 |
|---|---|
| `../pi-shadow-mind/src/protocol.ts` | `d4b671457ea0634a28972bb964b320ed96742c495da746c0fbe6ecaea22729af` |
| `../pi-shadow-mind/src/shadow-runner.ts` | `e06739c3b8a9c5daea4a8a1fdd3b4b8bea75edfce0c8e87ff301c9fb7dfe9f2f` |
| `.omp/agents/sol-xhigh-reviewer.md` | `d2804781e167be302c9ebbb1aca03dfe8d9c5413ace8d44129b2d3fe6be287ea` |
| `docs/superpowers/plans/2026-08-17-reviewer-shadow-mind-subagent-review.md` | `533b64214c481f8aadab57f385c8f50d83c7fa0d0343656a1e323cdd62c0f519` |
| `docs/superpowers/specs/2026-08-17-reviewer-shadow-mind-design.md` | `03a870d61441be1f093bd297191c806d45e893c1c3fc670d27a29ee3e8661b9a` |
| `packages/coding-agent/src/async/job-manager.ts` | `6b39f56e926ba25857e40ad096130387b15cb7bca1aa695e8a58100876d59f8d` |
| `packages/coding-agent/src/extensibility/extensions/runner.ts` | `50494b50694db3f6ef93e09b8f3e35a2581823c2a624d89e279bfb127ddab920` |
| `packages/coding-agent/src/extensibility/extensions/types.ts` | `d4f81c9de7323da730b7528b7142c318f0f4d9c3a94afc5bdfa95b55b650500a` |
| `packages/coding-agent/src/prompts/agents/reviewer.md` | `ee25d477281320bed33b28782d154ead95dccaa4484dc44a68cb522affc4184f` |
| `packages/coding-agent/src/sdk.ts` | `aab1a3c883a7cd618b29f35ee02854a29a0b807127e3bd5cefd3859d654828d7` |
| `packages/coding-agent/src/session/agent-session.ts` | `0dfb85ffb3b494d69b5f302da234623d3e459548b819dc1abb62d351e92ebaf1` |
| `packages/coding-agent/src/session/async-job-delivery.ts` | `3b1f48f6e88a3045f24a587bc9174019839bfae9973f0ad0f986835e62325f9d` |
| `packages/coding-agent/src/task/executor.ts` | `c064f6f9eccd351a37926e18f1d49acf036f0946faad475db1155abf684c5814` |
| `packages/coding-agent/src/task/types.ts` | `75809ebe62e591b808b2d621d764b0a760718da8ec6cc9b7192b9684eca10bd9` |

`reviewed_revision` = SHA-256(UTF-8 manifest)，manifest 为上表按 path 字典序的 `<path>\t<sha256>\n` 行拼接。

## Evidence Discipline

- **[历史事实]** 当前源码或上游 sibling 源码直接观察。
- **[推导]** 由已引用控制流推出的后果；未冒充已运行测试。
- **[未验证假设]** 未跑 formatter/linter/build/测试/真模型。
- **[拟议验收目标]** 设计拍板但仓库尚未存在的行为（如 `isolatedChild`、`TaskParams.shadowReview`）。

本报告**未**把 spec 自述当作现状；**未**修改 spec、`packages/`、测试或配置。

## R1 阻断/ Major 关闭对照

| ID | R1 摘要 | R2 关闭状态 | 核验摘要 |
|---|---|---|---|
| **B-01** | `ExtensionRunner` 后台 registry 不可登记、未接入 yield/quiescence | **已关闭** | R2 删除 `hasBackgroundWork`/`shadow-report`；canonical owner 改为 reviewer `AsyncJobManager.register("task", …, { ownerId, agentId })` + 现有 `async-result`（spec §5.1-5.3, §7.1）。源码：`hasPendingAsyncWork` / `settleAsyncWork` / monitor 停驻 / `isAsyncResultInjection` 失效链完整存在。 |
| **B-02** | 静态 prompt 等待 vs fail-open 矛盾 | **已关闭** | spec §5.4-5.5：prompt「有则复核、无则单核、禁止等待」；fail-open = 不登记 job。当前 `reviewer.md` 尚无 shadow 等待文案（尚未实现），R2 合同方向正确。 |
| **M-01** | Shadow 子会话隔离/identity/lifecycle 不完整 | **已关闭（设计）** | spec §5.4 `isolatedChild` + 显式 `model`/`thinkingLevel`/`SessionManager.inMemory`/唯一 `agentId`/`parentAgentId`/`toolNames`/`customTools:[report_to_main]`。上游对照：`shadow-runner.ts:181-233` 同类合同。实现依赖新 seam（见 Finding MJ-01）。 |
| **M-02** | `sol-xhigh-reviewer` prompt 子串 vs 设计评审零激活 | **已关闭** | spec §5.2：仅 spawn `shadowReview:"code"` 或 bundled `reviewer` frontmatter；**禁止** prompt 子串；corpus 含 design-review 反例。 |
| **M-03** | `silent` 误记为 uncovered | **已关闭** | spec §5.4 `completed_no_finding` ∈ covered；§5.5 silent/NOT_RELEVANT 映射。上游 `protocol.ts:6-11`、`shadow-runner.ts:72-100` 支持该区分。 |
| **M-04** | 新增 `ExtensionContext` 必填字段 | **已关闭** | spec §5.4 明确「不改 ExtensionContext 必填字段」；thinking 读现有 `thinkingLevel` 创建选项。 |
| **M-05** | 验收缺行为闭环/A/B/rollback | **已关闭（设计）** | spec §6.1 含停驻/失效/fail-open/isolatedChild/corpus/reap/真 session smoke；§6.2 补 A/B ledger/stop conditions/独立 rollback。A/B 仍为 **[拟议验收目标]**，非合并前 Blocking（见 Finding MJ-02）。 |

## 重点核验（用户指定）

### 1. Cohort job 在 prompt 前登记 → 第一次 overall yield 停驻

| 环节 | 结论 | 证据 |
|---|---|---|
| 登记时机 | **[推导] 可行** | `executeTask` 在 `createAgentSession`（`executor.ts:2920-2933`）之后、`driveSessionToYield`（`:3087`）之前有明确插入点（`:3067-3086` 之间）。spec §5.3 step 2 要求 `prompt(task)` 前 register。 |
| `hasPendingAsyncWork` 为 true | **[事实]** | `register()` 同步创建 `status:"running"` job（`job-manager.ts:208-211,266-267`）；`#hasPendingAsyncWake()` 用 `getRunningJobs({ ownerId: this.#agentId })`（`agent-session.ts:1774-1776`）。cohort 设 `ownerId = reviewerAgentId` 与子会话 `#agentId` 一致即可。 |
| 首次 terminal yield 停驻 | **[事实]** | `tool_execution_end` + `yield` + `sessionHasPendingAsyncWork()` → `requestYieldTurnStop()`（`executor.ts:1442-1446`），非 `requestAbort("terminate")`。 |
| 子会话 AsyncJobManager | **[事实]** | 子会话 `scopedAsyncJobManager = AsyncJobManager.instance()`（`sdk.ts:1700`）；delivery sink 按 `#agentId` 注册（`agent-session.ts:1282-1286`）。 |

### 2. Job 返回值 → `async-result` → 旧 yield 失效

| 环节 | 结论 | 证据 |
|---|---|---|
| 完成必 delivery | **[事实]** | job promise resolve 后 `#enqueueDelivery(id, text)`（`job-manager.ts:248-250`）；失败亦 delivery errorText（`:258-261`）。cancelled **不** delivery（`:243-246`），与 spec §5.5 abort 路径一致。 |
| customType | **[事实]** | `ASYNC_RESULT_MESSAGE_TYPE = "async-result"`（`async-job-delivery.ts:21,72`）。R2 禁止非 `async-result` 的 `shadow-report`（spec §5.5）。 |
| 失效旧 yield | **[事实]** | `isAsyncResultInjection` + `yieldCalled = false`（`executor.ts:1355-1357`）。 |
| fresh final yield | **[事实]** | `driveSessionToYield` while 循环在 settle 后继续 ladder（`:1938-1978`）；与 `executor-async-quiescence.test.ts:1-7` 注释合同一致。 |

### 3. `isolatedChild` 能否保留 `report_to_main` 并挡住 inline/MCP/write

| 约束 | 现状 | R2 设计 |
|---|---|---|
| `restrictToolNames:true` 丢弃 `customTools` | **[事实]** `sdk.ts:2707-2710` | R2 正确放弃单独使用该 flag |
| `toolNames` 不限制 extension/custom 泄漏 | **[事实]** `alwaysInclude` 强制并入 sdk/extension tools（`:3067-3078`） | `isolatedChild` 须走独立分支：无 inline factory、无 discovery、`alwaysInclude` 仅 caller `customTools` |
| `disableExtensionDiscovery` 不跳过 inline | **[事实]** `sdk.ts:2048-2097` vs `:2112-2114` | `isolatedChild` 须等价跳过 inline + discovery |
| 上游 `report_to_main` + allowlist | **[事实]** `shadow-runner.ts:207-230` | OMP 移植为 `customTools:[report_to_main]` + `toolNames:[read,grep,glob,report_to_main]` |

**[推导]** 设计方向正确且为当前 SDK 下唯一可行 seam；**[未验证假设]** 实现前无法在仓库内证明已生效。

### 4. 默认 `enabled: true` + A/B 未完成

- **[事实]** spec §6.2 写明：§6.1 通过后可合并且默认 `enabled:true`，但必须 kill switch + changelog 标明 A/B 未完成；「未跑 §6.2 不得声称质量已证明」。
- **[推导]** 这是**有纪律的 rollout 选择**，不是设计合同缺失；**不构成 Blocking**。
- **[拟议验收目标]** stop conditions、observation ledger 须在实现/运营阶段兑现。

### 5. 第二套完成引擎 / prompt 死等

- **[事实]** R2 明确非目标：第二 yield 引擎、ExtensionRunner 计数、`turn_end` 第二轮（spec §1.4, §5.1, §7.1）。
- **[事实]** 当前 `reviewer.md` 无「等待 shadow」procedure；R2 prompt 修改为条件消费（spec §5.4）。

## Findings

### Blocking

（无）

### Major

#### MJ-01 — Major — `isolatedChild` SDK 分支须显式禁止 preload 与 `alwaysInclude` 泄漏

- **Spec 位置**：`docs/superpowers/specs/2026-08-17-reviewer-shadow-mind-design.md:206-214,291`
- **源码证据**：
  - **[事实]** 子 agent 创建路径会转发 `preloadedExtensionPaths` / `preloadedCustomToolPaths`（`executor.ts:2870-2871`）；`sdk.ts:3067-3078` 在非 `restrictToolNames` 下把 extension/sdk custom tools **强制**加入 active set，与 `toolNames` 过滤无关。
  - **[事实]** 仓库内尚无 `isolatedChild` 实现（全库零命中）。
- **影响**：**[推导]** 若 `runShadowCohort` 未显式传 `preloadedExtensionPaths:[]`、`preloadedCustomToolPaths:[]`、`extensions:[]` 并实现独立 `alwaysInclude` 逻辑，Shadow 仍可能获得 bash/write/MCP/inline autoresearch，违反成功标准 §1.2.5 与 §6.1.5。
- **所需动作（实现期，非 redesign）**：在 `CreateAgentSessionOptions.isolatedChild` 实现中写清：跳过 inline/discovery/preload；`alwaysInclude` 仅 caller `customTools`；§6.1.5 测试断言 active tools 精确集合。

#### MJ-02 — Major — 默认 `enabled:true` 合并前须兑现 changelog + kill switch；A/B 仍为质量 Gate

- **Spec 位置**：`docs/superpowers/specs/2026-08-17-reviewer-shadow-mind-design.md:233-234,311-325`
- **证据**：
  - **[事实]** spec 允许 §6.1 通过后以默认 `enabled:true` 合并，但要求 changelog 标明 A/B 未完成、并提供全局/per-agent rollback 与 stop conditions。
  - **[未验证假设]** 质量/费用/p95 收益仍未知（spec §3.3, §6.2）。
- **影响**：**[推导]** 不构成 Design Blocking；若实现省略 changelog 或 stop conditions，则违反 spec 自身合并纪律。
- **所需动作**：实现 CHANGELOG 条目 + settings kill switch；按 §6.2 跑 pilot 前不得对外声称「Shadow 提高 review 质量」。

#### MJ-03 — Major — cohort 登记 callsite 与 abort 传播须在实现中钉死

- **Spec 位置**：`docs/superpowers/specs/2026-08-17-reviewer-shadow-mind-design.md:186-196,279,293-296`
- **源码证据**：
  - **[事实]** 推荐插入点：`monitor.attach(session)`（`:3067`）之后、`driveSessionToYield`（`:3087`）之前；teardown 已有 `jobManager.cancelAll({ ownerId: id })`（`:3140-3143`）。
  - **[事实]** cohort `run` 收到 `signal`（`job-manager.ts:235-238`），spec 要求 propagate 到四 child。
- **影响**：**[推导]** 登记若晚于 `driveSessionToYield` 内首次 yield，或 child 未订阅 cohort `signal`，会出现早 terminate 或泄漏；属实现顺序风险，设计意图正确。
- **所需动作**：实现时在 executor 单函数内集中 `qualified → register → driveSessionToYield`；§6.1.7 reap 测试 + child `finally dispose`。

### Minor

#### m-01 — Minor — spec 写 `toolNames`，实现须对齐 `CreateAgentSessionOptions.toolNames`

- **Spec 位置**：§5.4
- **证据**：`sdk.ts:512` 字段名为 `toolNames`（非 `tools` 别名混用）。
- **动作**：实现与 schema 文档统一用 `toolNames`。

#### m-02 — Minor — `TaskParams.shadowReview` / frontmatter 解析尚未存在于 `task/types.ts`

- **证据**：当前 `TaskParams`（`types.ts:286-305`）无 `shadowReview`；`grep shadowReview` 零命中。
- **动作**：按 spec §5.4 增字段；§6.1.6 corpus 测试覆盖。

#### m-03 — Minor — bundled `reviewer.md` / `sol-xhigh-reviewer.md` prompt 变更尚未落盘

- **证据**：当前 prompt 文件无 shadow async-result 指引（`reviewer.md` 全文；`sol-xhigh-reviewer.md:1-25`）。
- **动作**：实现时按 spec §5.4 修改；§6.1.8 断言文案。

#### m-04 — Minor — R2 spec frontmatter 仍写 `planned_reviewer: sol-xhigh-reviewer`（元数据）

- **证据**：design spec L9-10；本轮实际 reviewer 为 Composer。
- **动作**：可选在 spec 增加 Gate Continuity Note；不影响技术合同。

## Source Verification（R2 关键声称）

| R2 claim | 核验 | 源码 |
|---|---|---|
| 停驻由 `sessionHasPendingAsyncWork()` 决定 | **成立 [历史事实]** | `executor.ts:1129-1130,1442-1448` |
| `hasPendingAsyncWork` 含 running jobs + pending deliveries + queued async-result | **成立 [历史事实]** | `agent-session.ts:1771-1795` |
| 仅 `async-result` 失效 yield | **成立 [历史事实]** | `executor.ts:1354-1358`; `async-job-delivery.ts:21` |
| `register` 完成 enqueue delivery | **成立 [历史事实]** | `job-manager.ts:248-261,687-699` |
| `restrictToolNames` 丢弃 `customTools` | **成立 [历史事实]** | `sdk.ts:2707-2710` |
| inline factory 由 `!restrictToolNames` 控制 | **成立 [历史事实]** | `sdk.ts:2048-2097` |
| 子会话继承 `AsyncJobManager.instance()` | **成立 [历史事实]** | `sdk.ts:1695-1700` |
| upstream `silent` ≠ error | **成立 [历史事实]** | `shadow-runner.ts:72-100`; `protocol.ts:6-11` |
| `isolatedChild` 已存在 | **不成立 [历史事实]** | 全库无符号；**[拟议但已确定]** |

## Acceptance / Verification Review（R2 §6）

| §6.1 项 | 评价 |
|---|---|
| 1 停驻 | **充分** — 对照 `executor-async-quiescence` 模式 |
| 2 失效 | **充分** |
| 3 fail-open | **充分** — 含 register 失败 / restrictToolNames |
| 4 终态/silent | **充分** — `completed_no_finding` |
| 5 isolatedChild active tools | **充分** — 实现须满足 MJ-01 |
| 6 资格 corpus | **充分** |
| 7 reap | **充分** |
| 8 prompt | **充分** — 待落盘 |
| 9 回归 | **充分** |
| 10 真 session smoke | **充分** — R1 缺口已补；**[未验证假设]** 尚未运行 |

§6.2 A/B：**设计已定义 [拟议验收目标]**；默认 enabled 合并纪律见 MJ-02。

## Required Actions Before / During Implementation

1. 实现 `isolatedChild` SDK 分支（MJ-01），禁止 preload/泄漏。
2. 在 `executor.ts` `driveSessionToYield` 前登记 cohort job（MJ-03）。
3. 增 `TaskParams.shadowReview`、settings、frontmatter 解析（m-02）。
4. 更新 `reviewer.md` / `sol-xhigh-reviewer.md`（m-03）。
5. 跑通 §6.1 全部测试 + 真 session smoke；合并时 changelog 标明 A/B 未完成（MJ-02）。
6. **不得** reintroduce `shadow-report` custom type 或 ExtensionRunner 计数屏障。

## Review Boundary

本轮**仅**创建本报告（`docs/superpowers/plans/2026-08-17-reviewer-shadow-mind-subagent-review-round-2.md`）。

**未**修改：`docs/superpowers/specs/2026-08-17-reviewer-shadow-mind-design.md`、`packages/coding-agent/**`、测试、配置、handoff。

**未**运行：formatter、linter、build、测试套件、真模型 CLI/worker。

**未**实现设计。

仓库在评审开始前已有与本任务无关的 working-tree 改动；本 reviewer 未触碰。
