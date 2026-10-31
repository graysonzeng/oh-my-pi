# Reviewer Shadow Mind 独立 Design Review

## Verdict

**NEEDS_REDESIGN**

- `review_mode`: `host-native`
- `reviewer_agent_id`: `ShadowMindDesignReview`
- `reviewer_model`: `gateway/gpt-5.6-sol`
- `reviewer_effort`: `xhigh`
- `design_author`: `grok`
- `design_author_identity`: `cursor-grok-4.6`
- `reviewed_revision`: `2c74addab0f54be9f5a987276224bfe38552e91c`
- `review_date`: `2026-08-17`

结论依据：设计中存在 2 项 Blocking 与 5 项 Major。核心问题不是局部措辞或漏测，而是后台工作的 canonical owner、终止 `yield` 的停驻/失效/settle 状态机、以及 Shadow 子会话隔离合同尚未闭合。按当前方案实现，无法可靠保证“报告到达前 reviewer 不结束”，并可能在扩展未加载时把单核回退变成无法完成的评审。因此必须先重做这些核心合同，再重新执行 Design Review Gate；本结论不授权实现。

## Executive Summary

1. **[事实] 历史事实大体可靠。** 上游 Shadow Mind 的 heartbeat/activation/并发默认值、终止型 `report_to_main`、净化轨迹、OMP 扩展兼容层、30s/2s handler 超时、bundled reviewer schema 与子 Agent display name 传递，均可由当前源码复核。
2. **[事实] 完成屏障方案没有接上现有 structured-concurrency owner。** spec 只给 `ExtensionRunner` 增加 `trackBackgroundWork`/`hasBackgroundWork`，但 Extension factory/handler 没有可调用该登记器的接口；现有终止 `yield` 是否停驻、结果是否令旧 yield 失效、等待哪一代工作、以及如何 settle，分别由 `SubagentRunMonitor`、`AgentSession` 与 `AsyncJobManager` 协同完成，不是给 `driveSessionToYield` 多加一个布尔条件即可。
3. **[事实] fail-open 叙述自相矛盾。** spec 同时要求 `restrictToolNames`/factory 失败时单核继续，又要求静态 reviewer prompt 在看到 `shadow-report` 前不得提交 `overall_correctness`；扩展未加载时没有任何 owner 能发送解锁摘要。
4. **[事实] Shadow 子会话调用合同不完整。** 设计列出的 `createAgentSession` 参数没有固定父模型、内存 SessionManager、唯一 agent identity、原生 `toolNames` 限制、custom-tool discovery 隔离或父会话 shutdown/dispose 所有权；`disableExtensionDiscovery` 也不会跳过 `sdk.ts` 的 inline extensions。
5. **[事实] `sol-xhigh-reviewer` 的正/负信号规则违反范围。** spec 明定“设计评审不启动”，却又规定正信号与设计合同同时出现时仍启动；任何评审 code-review 设计本身的 design-review prompt 都可能命中。
6. **[事实] `silent` 成功被误记为 `uncovered`。** 上游协议允许“无值得报告内容时静默结束”，并将其与 timeout/error 分开；spec 却把“无 report”整体当未覆盖。
7. **[未知] 质量、延迟和费用没有可接受性证据。** spec 明确把真模型端到端冒烟排除在合并门禁外，且没有 control/treatment 可比性、非重叠区间 ledger、跨 Shadow 去重、按 agent 独立回滚或质量 stop condition，无法证明 4 路并行提高而非降低最终 review 质量。

## Reviewed Inputs

以下 SHA-256 均基于评审时文件原始 bytes 计算，使用 lowercase hex；路径按相对当前仓库根目录的 normalized POSIX path 排序。`../pi-shadow-mind/**` 是相对于 `/Users/sheng/tencent/oh-my-pi` 的只读 sibling 上游输入。

| Path | SHA-256 |
|---|---|
| `../pi-shadow-mind/README.md` | `68ad9336638d1dfc7af0c62975c5c6c000185391c67cd5993ecebef82459ad5c` |
| `../pi-shadow-mind/src/config.ts` | `22c5c614e0a98a0ee90b08e42dc6d4981ee5a185b48185a4d5cf9ea3b8f97b35` |
| `../pi-shadow-mind/src/protocol.ts` | `d4b671457ea0634a28972bb964b320ed96742c495da746c0fbe6ecaea22729af` |
| `../pi-shadow-mind/src/registry.ts` | `ee3c1809b60308e6b171e5913bae055675af4360baedeb9c0f92b7c3fc965c9b` |
| `../pi-shadow-mind/src/runtime.ts` | `6a30891be638b8e1bbbf650f3a3ea6bae58a743dc99256382dcc5ab570292a23` |
| `../pi-shadow-mind/src/scheduler.ts` | `66c8c83939e0011025cf7f0e5b1ba4a1ad967c91e5b45d8f381f0e5d0e4cd414` |
| `../pi-shadow-mind/src/shadow-runner.ts` | `e06739c3b8a9c5daea4a8a1fdd3b4b8bea75edfce0c8e87ff301c9fb7dfe9f2f` |
| `../pi-shadow-mind/src/trajectory.ts` | `a6daa284c3cb84a6c7c3f44b37f7ff1182cba042dcc5006f043ef1f6265346eb` |
| `.omp/agents/sol-xhigh-reviewer.md` | `d2804781e167be302c9ebbb1aca03dfe8d9c5413ace8d44129b2d3fe6be287ea` |
| `docs/handoffs/2026-08-17-1512-reviewer-shadow-mind-方案评审-handoff.md` | `89de9d0ba60dc0316a0a517295e30e79479e5ddf597596968a6a7e7b6d7fd7eb` |
| `docs/skills/authoring-extensions.md` | `e52fd67f3a85429d304059f32f7b3a91af55c77b10c0e2f57a9dce57ea7a7527` |
| `docs/superpowers/specs/2026-08-17-reviewer-shadow-mind-design.md` | `5df8ef3bcd3571b756d80eb8676e399dfff491960b1d8512576fce73c33a8396` |
| `packages/coding-agent/src/extensibility/extensions/runner.ts` | `50494b50694db3f6ef93e09b8f3e35a2581823c2a624d89e279bfb127ddab920` |
| `packages/coding-agent/src/extensibility/extensions/types.ts` | `d4f81c9de7323da730b7528b7142c318f0f4d9c3a94afc5bdfa95b55b650500a` |
| `packages/coding-agent/src/extensibility/legacy-pi-coding-agent-shim.ts` | `9013df1122cc16ca96b7c6c25c9c1e713221265a9fe5119d1b35fed231f82de9` |
| `packages/coding-agent/src/index.ts` | `7f82cf6f009e314991321e85c422cc34d4a9abdfadff665952fc6d1b1d27de6d` |
| `packages/coding-agent/src/prompts/agents/reviewer.md` | `ee25d477281320bed33b28782d154ead95dccaa4484dc44a68cb522affc4184f` |
| `packages/coding-agent/src/registry/agent-registry.ts` | `fd9c89f103f4e7835a4f66ad33deb20f6a80bbb9cd19890d5de361fa22b5ad9f` |
| `packages/coding-agent/src/sdk.ts` | `aab1a3c883a7cd618b29f35ee02854a29a0b807127e3bd5cefd3859d654828d7` |
| `packages/coding-agent/src/session/agent-session.ts` | `0dfb85ffb3b494d69b5f302da234623d3e459548b819dc1abb62d351e92ebaf1` |
| `packages/coding-agent/src/task/executor.ts` | `c064f6f9eccd351a37926e18f1d49acf036f0946faad475db1155abf684c5814` |
| `packages/coding-agent/src/task/structured-subagent.ts` | `41a1c7cf26501dfa4c90567bbddf9f42126ad87d051a4ed06bc921dfaaf2cdbf` |
| `packages/coding-agent/test/task/executor-async-quiescence.test.ts` | `227a54eed11002d3cb156258dbf74dc794b0641185496e114f2ce4ddbb6feb29` |
| `packages/utils/src/dirs.ts` | `7519c8474c5f5cba906aca2fcf45dbe4e640121f616527790c4c51e1c91a3bcc` |

## Evidence Discipline

- **[历史事实]** 只在当前源码或上游只读源码中直接观察到的现状。
- **[推导]** 从已引用的控制流/类型合同推出的后果；不冒充已运行结果。
- **[未验证假设]** 本轮未运行真模型、测试、build、linter 或 formatter，无法由静态源码确认的运行时结果。
- **[拟议验收目标]** 设计希望实现但当前仓库尚不具备的行为。

本报告未把 spec 自述当现状证据，也未运行 formatter、linter、build 或测试套件。

## Source Verification

### 1. 上游 Shadow Mind 原理

| Spec claim | 核验 | 源码证据 |
|---|---|---|
| heartbeat 默认 `1/3`、并行默认 `2` | **成立，[历史事实]** | `../pi-shadow-mind/src/config.ts:7-13` 的 `DEFAULT_CONFIG`；`../pi-shadow-mind/src/scheduler.ts:3-38` 先 heartbeat roll，再逐 Shadow activation roll，最后按 slot 采样。 |
| activation 默认 `0.3` | **成立，[历史事实]** | `../pi-shadow-mind/src/registry.ts:82-86` 的 `probabilityValue(..., 0.3, ...)`。 |
| `turn_end` 触发；新非 extension 输入增加 epoch 并 abort | **成立，[历史事实]** | `../pi-shadow-mind/src/runtime.ts:64-79`，symbol `ShadowMindRuntime.registerEvents`。 |
| 继承主 system prompt、使用净化轨迹、`report_to_main` 终止 | **成立，[历史事实]** | `../pi-shadow-mind/src/shadow-runner.ts:181-231`，symbol `ShadowRunner.bootstrapSession`；`../pi-shadow-mind/src/trajectory.ts:53-82`，symbol `sanitizeTrajectory`；`../pi-shadow-mind/src/protocol.ts:3-11`。 |
| 安装不创建 Shadow | **基本成立，但措辞需精确** | `../pi-shadow-mind/README.md:84-101` 表明首次 session 会创建 registry/config 目录结构，但明确 “No default Shadow Mind is created”。准确说法应是“不创建默认 Shadow 定义”，而不是“不产生任何 registry/config 文件”。 |

### 2. OMP 扩展与 Agent 现状

| Spec claim | 核验 | 源码证据 |
|---|---|---|
| `pi.extensions` 可发现；legacy shim 提供核心 API | **成立，[历史事实]** | `docs/skills/authoring-extensions.md:80-95`；`packages/coding-agent/src/extensibility/legacy-pi-coding-agent-shim.ts:663-666,898-899,1239-1245,1381-1384`；`packages/coding-agent/src/index.ts:8`。 |
| `getAgentDir()` 指向 `~/.omp/agent` | **成立于默认 profile/config，[历史事实]** | `packages/utils/src/dirs.ts:492-495`；路径仍受文件顶部所述环境/profile 配置影响，因此不是不可变绝对路径。 |
| bundled reviewer 有结构化 yield 且 `spawns: scout` | **成立，[历史事实]** | `packages/coding-agent/src/prompts/agents/reviewer.md:2-5,13-29,67-69,131-134`。 |
| `sol-xhigh-reviewer` 是 design reviewer 且带 `write` | **成立，[历史事实]** | `.omp/agents/sol-xhigh-reviewer.md:2-6,9-25`。该文件当前 verdict 实际为四选一并包含 `PASS_WITH_NOTES`；spec 第 56 行列出的三项不完整。 |
| 子 Agent display name 与扩展路径继承 | **成立，[历史事实]** | `packages/coding-agent/src/task/executor.ts:2870-2871,2895-2899`；plan mode 另见 `packages/coding-agent/src/task/structured-subagent.ts:450-452`。 |
| `ExtensionContext` 无 display name/thinking/mode，system prompt 是数组；handler 30s、shutdown 2s | **成立，[历史事实]** | `packages/coding-agent/src/extensibility/extensions/types.ts:413-467`；`packages/coding-agent/src/extensibility/extensions/runner.ts:73-104,663-686`。 |
| inline extension 在 `restrictToolNames` 时跳过 | **成立，[历史事实]** | `packages/coding-agent/src/sdk.ts:2048-2097`。但 `disableExtensionDiscovery` 不等于跳过 inline factory，见 Finding M-01。 |
| `driveSessionToYield` 会等 owner async work | **成立但被 spec 过度简化，[历史事实]** | `packages/coding-agent/src/task/executor.ts:1129-1130,1442-1448,1948-1978` 与 `packages/coding-agent/src/session/agent-session.ts:1771-1811` 共同构成停驻、pending、delivery、settle、fresh-yield 合同。 |

## Findings

### B-01 — Blocking — 新建 `ExtensionRunner` 后台 registry 既不可登记，也没有接入完整 yield/quiescence 状态机

- **Spec 位置**：`docs/superpowers/specs/2026-08-17-reviewer-shadow-mind-design.md:62-64,119-135,166-169,186-193,228-229,249-251,268-269`。
- **源码证据**：
  - **[事实]** `ExtensionFactory` 仅接收 `ExtensionAPI`：`packages/coding-agent/src/extensibility/extensions/types.ts:1373-1374`。当前 `ExtensionAPI`/`ExtensionContext` 没有 background-work 登记方法；完整 context surface 见同文件 `413-467,1059-1240`，`ExtensionRunner.createContext` 的唯一对象构造见 `packages/coding-agent/src/extensibility/extensions/runner.ts:663-686`。
  - **[事实]** 终止 `yield` 是否停驻由 monitor 在工具结束瞬间调用 `sessionHasPendingAsyncWork()` 决定：`packages/coding-agent/src/task/executor.ts:1129-1130,1442-1448`。spec 只修改 `driveSessionToYield` 的后置判断，未修改该停驻判定。
  - **[事实]** canonical settle 不是轮询布尔值：`AgentSession.settleAsyncWork()` 会等待 owner jobs、drain deliveries、再等 injected follow-up idle，见 `packages/coding-agent/src/session/agent-session.ts:1794-1811`；driver 在 `packages/coding-agent/src/task/executor.ts:1948-1978` 调用它。拟议 `ExtensionRunner` 只有 `trackBackgroundWork`/`hasBackgroundWork`，没有对应的 await/settle/delivery primitive。
  - **[事实]** 旧 yield 只在识别到 `async-result` 注入时失效：`packages/coding-agent/src/task/executor.ts:1354-1358`。`shadow-report` 是另一 custom type，spec 未定义其 fresh-yield 失效合同。
  - **[事实]** `ExtensionAPI.sendMessage`/`SendMessageHandler` 返回 `void`：`packages/coding-agent/src/extensibility/extensions/types.ts:1204-1207,1402-1410`。subagent executor 虽把底层 send Promise 放入 `pendingExtensionMessages`，却只在 `session_start` 后 drain 一次，见 `packages/coding-agent/src/task/executor.ts:3005-3024,3061-3063`；`turn_end` 后发送的 report 不在现有完成屏障内。
  - **[事实]** 现有回归测试明确要求“pending owner work 停驻 terminal yield，异步结果令旧 yield 失效，最终 yield 必须晚于所有 delivery”：`packages/coding-agent/test/task/executor-async-quiescence.test.ts:1-7`。
- **影响**：
  - **[推导]** terminal yield 可能在 Shadow 工作仍运行时直接走 `requestAbort("terminate")`，报告被丢弃。
  - **[推导]** 即使只把 `hasBackgroundWork()` 并入 driver while 条件，`settleAsyncWork()` 对 ExtensionRunner work 会立即返回，形成空转/饥饿，且不能证明 report turn 已完成。
  - **[推导]** `sendMessage` 被调用不等于 report 已送达、report turn 已完成或失败已被 owner 观察；“报告注入后 drainPromise resolve”不足以建立 completion happens-before。
- **所需修订**：重新选择**单一 canonical owner**。后台 Shadow drain、发送、delivery、fresh-yield invalidation、settle、abort/reap 必须由一个 session-level structured-concurrency contract 管理；扩展 handler 必须通过明确的 public context/API 登记该 owner work。不得在 `ExtensionRunner` 另建只有计数而无 delivery/settle 语义的第二引擎。设计须给出所有 predicate/callsite，而非只改 `driveSessionToYield` 一处。

### B-02 — Blocking — 静态 prompt 门闩与“扩展缺失时单核回退”矛盾，fallback 会无法完成

- **Spec 位置**：`docs/superpowers/specs/2026-08-17-reviewer-shadow-mind-design.md:162,170,208,220-223,228-229,242`。
- **源码证据**：
  - **[事实]** spec 要求 bundled `reviewer.md` 静态 procedure 在看到 `shadow-report`/超时摘要前不得 yield `overall_correctness`（第 208 行）。
  - **[事实]** 同一 spec 又规定 `restrictToolNames` 时 inline extension 不加载并单核评审、factory 抛错时 session 继续并单核评审（第 162、221-222 行）。当前 `sdk.ts:2048-2097,2116-2119` 证实 restricted session 确实不会运行 inline factory。
  - **[事实]** “全未覆盖摘要解锁”只可能由已成功加载并 armed 的 Shadow 扩展发送；扩展没加载或 factory 初始化失败时没有该 sender。
- **影响**：**[推导]** fallback 不再 fail-open：模型若遵守新 prompt，就不能提交最终 verdict；没有 background owner 时也不会生成解锁消息，最终只能耗尽 yield reminder/runtime 或产出不完整结果，直接违反成功标准第 6 项。
- **所需修订**：prompt 不得无条件等待。设计必须定义可观测的 `shadow-status`/capability handshake，仅在本 epoch 确认 armed 且 owner work 已登记时启用门闩；restricted、ineligible、factory error、startup error 路径必须显式 fail-open。更优先的是让代码级 quiescence contract 决定等待，prompt 只负责“若收到报告则复核”，不能承担唯一正确性锁。

### M-01 — Major — OMP-native Shadow 子会话创建、只读隔离、身份与生命周期合同不完整

- **Spec 位置**：`docs/superpowers/specs/2026-08-17-reviewer-shadow-mind-design.md:27,52,113,130,167,195-205,223-225,252-253`。
- **源码证据**：
  - **[事实]** spec 第 167 行列出的调用没有 `model`、`sessionManager`、`agentId`/`parentTaskPrefix`、`toolNames`、`preloadedCustomToolPaths`、MCP/LSP/skills 禁用或 parent abort signal。
  - **[事实]** OMP `createAgentSession` 未传 `model` 时从 settings/首个可用模型选择（`packages/coding-agent/src/sdk.ts:384-396`），未传 `sessionManager` 时创建持久 session（`sdk.ts:1394-1398`），未传 child identity 时默认为 `MAIN_AGENT_ID`/`"main"`（`sdk.ts:1702-1706`）。四路并发默认 identity 会通过 `AgentRegistry.register` 覆盖同一 map key（`packages/coding-agent/src/registry/agent-registry.ts:89-104`）。
  - **[事实]** `disableExtensionDiscovery` 不控制 inline factories；inline factories 由 `!restrictToolNames` 控制并始终追加（`sdk.ts:2048-2097`）。因此“设 `disableExtensionDiscovery` 且不传本 factory”不能证明内置 Shadow extension 不加载。
  - **[事实]** 非 restricted session 会发现 custom tools（`sdk.ts:2080-2084`），extension/SDK custom tools不受 `toolNames` filter、会被强制激活（`sdk.ts:3067-3076`）。反过来，`restrictToolNames: true` 又会丢弃 `customTools: [report_to_main]`（`sdk.ts:2707-2710`）。当前设计没有解决这组约束；按第 167 行展示的调用，Shadow 并非只读。
  - **[事实]** 上游实现显式传 parent `model`、thinking、tool allowlist、custom report tool、resource loader 与 SessionManager（`../pi-shadow-mind/src/shadow-runner.ts:181-231`）；非 debug 使用 `SessionManager.inMemory`（`277-281`），finally dispose child（`174-177`），并过滤 self extension（`201-205`）。上游 parent 在 `session_shutdown` abort 全部运行（`../pi-shadow-mind/src/runtime.ts:81-90`）。这些 owner/lifecycle 语义在 spec 中没有 OMP 映射。
- **影响**：
  - **[推导]** Shadow 可能使用错误模型、污染持久 session/全局 agent registry、获得 write/bash/custom tools、重复加载内置扩展，或在 parent reviewer 已退出后继续消耗模型与尝试发送报告。
  - **[推导]** 缺少唯一 child identity 还可能让四个 Shadow 与真实 `Main` 的 registry generation 相互覆盖/注销。
- **所需修订**：给出完整的 OMP-native child-session options 与 ownership 表：固定 `ctx.model`、复用 canonical thinking API、`SessionManager.inMemory`、每路唯一 `agentId`/`parentTaskPrefix`/parent link、明确只读 active tool assembly、清空 custom-tool/path discovery、禁 MCP/LSP/skills/commands、显式 self-inline suppression、parent abort 传播、每路 finally dispose、四路统一 reap。若现有 option 组合无法同时保留 `report_to_main` 并关闭其它 custom/inline tools，必须先设计一个最小且通用的 SDK 隔离 seam，而不是靠现有 flags 的错误组合。

### M-02 — Major — `sol-xhigh-reviewer` 的 prompt 子串资格规则与“设计评审零激活”直接冲突

- **Spec 位置**：`docs/superpowers/specs/2026-08-17-reviewer-shadow-mind-design.md:24,141-157,254-255,263`。
- **源码证据**：
  - **[事实]** spec 第 24 行要求设计评审不启动；第 151-155 行却规定命中任一 code-review 正信号即启动，且正信号与 design-review 合同同时出现时仍启动。
  - **[事实]** `BeforeAgentStartEvent` 只有 `prompt`/images/system prompt，没有 invocation kind：`packages/coding-agent/src/extensibility/extensions/types.ts:635-640`。AgentSession 传入的是本轮 `expandedText`：`packages/coding-agent/src/session/agent-session.ts:5680-5688`。
  - **[事实]** 设计文档本身反复包含 `code review`、`git diff`、`overall_correctness`、`Reviewed Inputs`、`NEEDS_REDESIGN`；评审“code-review 功能设计”的任务文本可以同时包含正信号和设计合同信号。
- **影响**：**[推导]** 合法 design review 会被误归类为 code review，产生 4 路额外费用并把 Shadow 证据注入错误合同；测试计划第 1 项还会把该错误 precedence 固化为期望行为。
- **所需修订**：使用父 spawn 时的显式 invocation kind/capability metadata 作为 canonical signal；若短期必须从 prompt 推断，design-review 合同至少应为否决条件，并应覆盖“评审一个关于 code review 的设计”这类反例。需列出 false-positive/false-negative corpus，而不是只列正向子串。

### M-03 — Major — `silent` 成功与 timeout/error 被混成 `uncovered`

- **Spec 位置**：`docs/superpowers/specs/2026-08-17-reviewer-shadow-mind-design.md:28,168,223-225,231-242,267`。
- **源码证据**：
  - **[事实]** 上游 `ShadowRunResult.reason` 明确区分 `report | silent | timeout | aborted | error`，见 `../pi-shadow-mind/src/shadow-runner.ts:72-100`。
  - **[事实]** 上游协议明确允许“没有值得报告内容时静默结束”，并允许不相关时返回 `NOT_RELEVANT`，见 `../pi-shadow-mind/src/protocol.ts:6-11`。
  - **[事实]** spec 第 168、242 行仅把成功调用 `report_to_main` 的内容列入 covered；无 report 时全部记 uncovered，没有 `completed/no finding` 状态。
- **影响**：**[推导]** 四个 Shadow 都成功审阅且没有发现时，reviewer 会收到“四维全部未覆盖”的虚假摘要；这会污染 explanation、误导质量观测，并把正常静默当失败。
- **所需修订**：定义逐维终态，例如 `reported`、`completed_no_finding`、`timeout`、`error`、`aborted/stale`。`covered` 必须包含前两类；只有 timeout/error/aborted/stale 才可列为 `uncovered`。对应测试须覆盖 silent 与 NOT_RELEVANT，不得仅测试 timeout。

### M-04 — Major — 新增 public `ExtensionContext` 字段重复 canonical owner，类型与兼容迁移未定义

- **Spec 位置**：`docs/superpowers/specs/2026-08-17-reviewer-shadow-mind-design.md:33,58,161,181-184`。
- **源码证据**：
  - **[事实]** 当前 `ExtensionContext` 已提供 `model: Model | undefined` 与 `getSystemPrompt(): string[]`：`packages/coding-agent/src/extensibility/extensions/types.ts:426-443`。
  - **[事实]** `ExtensionAPI` 已提供 `getThinkingLevel(): ThinkingLevel | undefined`：同文件 `1233-1240`。
  - **[事实]** spec 又增加必备 `thinkingLevel: string | undefined`，既重复 owner，又把精确 `ThinkingLevel` 扩宽为任意 string；并把 `agentDisplayName`/thinking 设为 public required fields，却没有外部 TypeScript consumer、测试 mock 或 legacy adapter 的迁移说明。
- **影响**：**[推导]** 会产生两个 thinking 读取面并可能漂移；required structural field 会破坏构造 `ExtensionContext` 的外部/测试代码，广义 string 还允许 native session option 不接受的值。
- **所需修订**：只新增确实缺失的稳定身份字段，并说明是否 optional/readonly、默认值、semver/legacy mock 迁移；模型与 thinking 应复用 `ctx.model` 和 `pi.getThinkingLevel()`，使用现有 `ThinkingLevel`/`ConfiguredThinkingLevel` 类型，不创建第二份状态。

### M-05 — Major — 验收计划缺少行为闭环、A/B discipline、独立回滚和质量停止条件

- **Spec 位置**：`docs/superpowers/specs/2026-08-17-reviewer-shadow-mind-design.md:23-28,246-257,259-279`。
- **证据**：
  - **[事实]** 计划覆盖资格、启动次数、join、mocked `disableExtensionDiscovery`、timeout 摘要和一个简化 completion fixture，但没有覆盖 B-01 所需的 terminal-yield park、`shadow-report` invalidation、send completion/failure、parent shutdown/reap，也没有覆盖 M-01 的实际 active tool set、模型/identity/in-memory session 与 custom-tool isolation。
  - **[事实]** 第 4 项只断言传了 `disableExtensionDiscovery: true`，但源码已证明该 flag 不跳过 inline factories，因此该测试会在实现仍错误时通过。
  - **[事实]** 真模型端到端 spawn smoke 被明确列为“不作为合并门禁”（第 277-279 行），无法证明最终 reviewer 在四维 report 后重新提交了符合既有 schema 的 verdict。
  - **[事实]** 完整 spec 没有 control/treatment 可比性、non-overlap interval ledger、跨维度 finding 去重/不重复计数、bundled reviewer 与 `sol-xhigh-reviewer` 独立 rollback、kill switch、质量 stop condition。
  - **[未验证假设]** 4 路真实模型的延迟、费用、限流行为和净质量收益均未测；spec 自身也将其列为未知。
- **影响**：**[推导]** 即使所有拟议单测通过，仍可能交付一个会泄漏工具、提前结束、重复 findings、显著降质或无法快速关闭的功能；“全部 4 维被启动”也不等于“4 维有效完成且提高 review 质量”。
- **所需修订**：
  1. 将真 session smoke 升为实现完成门禁：固定 patch/evidence packet，观察 4 个逐维终态、单一 report batch、fresh final verdict、原 schema、正确 cleanup。
  2. 建立固定 corpus 的 control/treatment 评估；同一 reviewed revision/packet、相同最终 reviewer/model/effort，唯一变量为 Shadow；样本区间不得重叠并记录 ledger。
  3. 定义去重键与归因，避免同一 defect 被多个 Shadow/主 reviewer 重复计数。
  4. 为 bundled reviewer 与 `sol-xhigh-reviewer` 至少提供独立 enable/rollback；completion infrastructure 与每个 eligibility branch 也须可独立关闭且 fail-open。
  5. 在实施前拍板质量/成本/延迟 stop conditions（例如 schema 完成率、超时率、重复 finding 率、confirmed finding precision、p95 wall time 与模型调用上限）；越界自动/人工关闭 treatment，而不是只依赖 90s/120s 单次 timeout。

## Acceptance / Verification Review

| 原成功标准 | 当前验证计划评价 | Gate 结论 |
|---|---|---|
| bundled `reviewer` 一次启动 4 维 | mock 启动次数可覆盖；没有证明四维有效终态、报告消费和 fresh verdict | **不足** |
| `sol-xhigh-reviewer` 仅 code review 启动 | 单测计划固化“正信号覆盖设计合同”，与边界相反 | **失败** |
| 其它会话零激活 | 列出 main/flash/workflow；未覆盖 Shadow child 自身 inline reload 与显式 metadata | **不足** |
| reviewer yield schema 不变、Shadow 不直接成为 finding | schema 回归有计划；无 evidence provenance、跨 Shadow/主 reviewer 去重和恶意/无锚点 report 行为测试 | **不足** |
| Shadow 不加载本扩展 | 仅测试 `disableExtensionDiscovery` 参数；该参数不控制 inline factory | **失败** |
| 任一维度失败仍给 verdict，并列未覆盖 | timeout 摘要有测试；factory/restricted fail-open、send failure、silent success、parent abort 均未闭合 | **失败** |

### 必须补充的最小行为验证

1. terminal overall yield 在 Shadow owner work pending 时被停驻，而不是 terminate。
2. `shadow-report` delivery 使旧 overall yield 失效；最终成功 payload 必须来自 report 到达后的 fresh yield。
3. `sendMessage` 成功须等待 report turn 完成；失败须可观察、解除 owner work 且 fail-open。
4. restricted/factory-error/ineligible 三条路径均能在无 `shadow-report` 时正常单核完成。
5. 每个 child 的实际 model、thinking、system prompt、SessionManager、agent identity、active tools、extension/custom-tool set 与 parent link 符合合同；四路并发无 registry 覆盖。
6. parent caller abort、wall-clock timeout、session shutdown、新用户 input 均 abort 并 await/reap 全部 child，且每个 session exactly-once dispose。
7. `silent`/`NOT_RELEVANT` 计为已覆盖无 finding；timeout/error 才计未覆盖。
8. design-review task 即使包含 `code review`、`git diff`、`overall_correctness` 也不得误启动；真实 code-review metadata 才启动。
9. 固定真实 patch smoke 验证最终 reviewer schema、report provenance 与重复 finding 合并。

### A/B 与 rollout 审查

- Control/treatment comparability：**缺失**。
- Non-overlap interval ledger：**缺失**。
- No double-counting：**缺失**。
- Per-feature independent rollback：**缺失**。
- Quality stop conditions：**缺失**。
- 当前唯一“回退”是 timeout 或 unrelated `restrictToolNames`，二者都不是可运营的 rollout/kill-switch contract。

## Required Revisions

1. **重做 completion ownership**：使用单一 session-level canonical owner，完整覆盖 registration、park、settle、delivery、fresh-yield invalidation、abort/reap；删除只有 `hasBackgroundWork()` 计数语义的平行引擎方案。
2. **重做 fail-open handshake**：仅 armed/registered epoch 才等待；extension absent、restricted、factory/startup/send error 均可无 report 完成单核 verdict。
3. **补齐 OMP-native child adapter 合同**：当前模型、精确 thinking type、system prompt、净化 context、内存 session、唯一 identity、严格只读 tool set、无 custom/inline/MCP/LSP 泄漏、parent cancellation、finally dispose。
4. **用显式 invocation metadata 取代 prompt 子串 owner**；至少让 design contract 否决 code-review token，并补反例 corpus。
5. **修正逐维终态语义**：区分 reported、completed-no-finding、timeout、error、aborted/stale；silent 不得算 uncovered。
6. **收窄 public API 变更**：复用 `ctx.model`/`pi.getThinkingLevel()`，只新增必要身份信息并说明类型、默认、readonly/optional 与迁移。
7. **重写验证与 rollout 章节**：补上本报告列出的行为门禁、真 session smoke、control/treatment、非重叠 ledger、去重、独立 rollback/kill switch 和质量 stop conditions。
8. 修订 spec 后重新计算完整 Reviewed Inputs manifest，并由与作者分离的 reviewer 重跑 Gate；在 `PASS`/`PASS_WITH_NOTES` 前不得实现。

## Non-blocking Notes

1. **[事实]** spec 第 56 行把当前 `sol-xhigh-reviewer` verdict 写成三项；实际 `.omp/agents/sol-xhigh-reviewer.md:23-25` 包含 `PASS_WITH_NOTES`。修订时应保持四选一一致。
2. **[事实]** “安装时不创建任何 Shadow”应改为“首次 session 会建立 registry/config 结构，但不创建默认 Shadow 定义”，以对应 `../pi-shadow-mind/README.md:84-101`。
3. **[建议]** 固定 90s/120s/400ms 属于拟议运行参数，不是历史能力；修订时应显式标 `[拟议但已确定]` 或 `[拟议验收目标]`，避免与上游默认 300s 混读。
4. **[建议]** `shadow-report` 最好使用结构化 details 保存 per-dimension status、evidence anchors、duration/model/tool diagnostics，纯文本只作为 LLM 展示层；否则去重、验收与失败归因难以可靠实现。

## Review Boundary

本轮仅创建本报告；未修改 spec、handoff、产品代码、测试或配置，未实现设计，未运行 formatter、linter、build 或测试套件。仓库在评审开始前已有与本任务无关的 working-tree 改动；本 reviewer 未触碰这些文件。
