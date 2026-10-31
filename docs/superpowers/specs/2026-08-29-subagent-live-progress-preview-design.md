# Design: Subagent live progress preview

- Date: 2026-08-29
- Status: Draft
- Scope: M
- design_author: sol
- design_author_identity: SolDesignAuthor
- planned_reviewer: grok-4.6-xhigh（host-native read-only subagent）
- implementation_authorization: original_request=design-only；current_session_goal=仅在后续 Design Review Gate 判定 PASS / PASS_WITH_NOTES 后授权实现
- authorization_source: 原始用户请求要求调研其他开源 CLI 后给出最佳实现方案，明确可基于社区 PR #3821，但未授权写代码；当前会话目标仅授权在修订后的 Design Review Gate 判定 PASS / PASS_WITH_NOTES 后进入实现。本轮只修订设计，不实现。Grok 原作者卡住被取消后由 sol 从 facts brief 整篇重写。

## 1. 设计目标和范围

### 1.1 要解决的问题
- 当父 agent 通过 `hub wait` 等待 detached subagent 时，运行中 job 行目前只有名称、模型和时长；hub 路径先在 detached spawn copy 中丢失 current-tool args/start timestamp，再在 `JobSnapshot` 丢失其余 live activity，导致 result frame 没有可显示的 gist。用户因此无法从默认等待视图判断子 agent 是否仍在工作。
- 同一份 live activity 在同步 `task` 工具块已经表现为 current/recent tool 子行，但 detached subagent 的 Subagents HUD 和 `hub wait` / `hub jobs` 没有一致呈现。设计需复用现有进度采集与刷新链路，而不是创建第二套 progress engine。

### 1.2 成功标准
- 运行中的 detached subagent 一旦具有 current tool 或 recent tool，`hub wait` / `hub jobs` 的 job 行下方显示一条紧凑 activity 子行：tool、经过清洗和宽度预算的 intent/关键参数，以及仅针对长时间运行 current tool 的 elapsed 提示。
- Subagents HUD 使用与 `hub wait` 相同的 current-tool-first、recent-tool-fallback 语义，采用社区 PR #3821 已验证可接受的 tool 子行样式。
- 继续使用现有约 150ms 的 `AgentProgress` 发射、registry/channel 和 `hub wait` 500ms 刷新；不增加 progress bus、轮询器或后台任务。
- 8–15 个并发 job 时，每个 agent 最多增加一条 compact 子行；不内联多行输出，不让每次刷新携带 reasoning/thinking stream。
- tool label、intent、参数和路径均经过现有 TUI sanitizer 与 viewport width budget；超长 MCP/custom tool 名不会越界，绝对 home path 不会原样泄露。
- settled result/error preview、Agent Hub detail、同步 `task` 展开输出和既有 job 状态语义不回归。

### 1.3 本次范围
- 为 active detached subagent 的 Subagents HUD 增加 compact current/recent tool 子行，并吸收 PR #3821 的两个 maintainer should-fix：tool label 也纳入宽度预算；参数先经过路径缩短再截断。
- 让 detached spawn 的既有 `forwardSyncProgress` copy 保留 `currentToolArgs` 和 `currentToolStartMs`，并在 executor snapshot 于 tool end 清空字段时同步清空；不新增 channel。
- 让 `snapshotJobs()` 从它已经遍历的 task progress 中保留一个最小 live activity view，并让 `jobsRenderResult` 在 running result frame 中显示同样的 compact 子行。
- 扩展 HUD 与 job renderer 的现有 contract tests；hub 测试覆盖 spawn-copy-to-render，整体覆盖 running、recent fallback、宽度/路径清洗、无 activity 和 settled compatibility。
- 更新 `packages/coding-agent/CHANGELOG.md` 的 `[Unreleased]` 条目。

### 1.4 非目标
- 不采集、保存或显示 `thinking_delta`；现有事实未证明 #3821 风格 tool 子行需要 reasoning 内容。
- 不把 `recentOutput` 的 8 行/8KB tail 搬入每 500ms 的 `hub wait` snapshot，也不实现 Codex 式三行 activity feed。
- 不重写 Agent Hub，不改变其 observe/attach、完整 transcript 或 detail panel。
- 不实现 Background Jobs panel（#2512）、model-facing progress（#2762）、OpenCode/Claude 风格 session navigation 或 task overlay。
- 不新增设置项、feature flag、遥测、重试策略、持久化 schema、外部 API 或新的 progress channel。
- 不重构同步 `task` 的完整 renderer；本次只以它的 current/recent tool precedence 和视觉层级作为既有行为基准。
- 不直接 cherry-pick PR #3821；该 PR 仅作为行为和视觉参考，按当前 main 的现有导出与 sanitizer 约束手工落地。

## 2. 背景与约束
- canonical owner 是 `packages/coding-agent/`。`AgentProgress` 已包含 `lastIntent`、`currentTool`、`currentToolArgs`、`currentToolStartMs`、`recentTools`、`recentOutput`、retry state 和 inflight task details；executor 已通过现有 channel/registry 合并发射 progress。证据：`docs/superpowers/specs/2026-08-29-subagent-live-progress-preview-facts-brief.md:26-50`。
- 同步 `task` renderer 已实现 current tool 优先、recent completed tool 回退、`lastIntent ?? args` detail、current tool 超过 5 秒显示 elapsed；expanded 模式才显示 `recentOutput`。证据：facts brief `:51-61`。
- `renderSubagentHudLines` 当前只显示 active detached subagent 的 id/role/description，最多 8 个；sync task 和 eval agent 被排除。PR #3821 的 HUD 子行符合用户跟进意见，但它没有修改 hub 路径。证据：facts brief `:63-75,110-144`。
- hub 路径有两次已确认的字段丢失：detached spawn 的 `forwardSyncProgress` copy 未复制 `currentToolArgs` / `currentToolStartMs`；随后 `snapshotJobs()` 遍历 `latestDetails.progress[]` 时只复制 `resolvedModel`，`JobSnapshot` 没有 live fields。HUD 通过 `TASK_SUBAGENT_PROGRESS_CHANNEL` 取得完整 executor snapshot，不受第一次丢失影响。`jobsRenderResult` 对 running job 仅能从 settled-only 的 `resultText`/`errorText` 取 preview；`hub wait` 已每 500ms 触发一次 update。证据：facts brief Surface C。
- Gemini 默认每 agent 一行 compact activity；Codex history 最多三行、六项、240 graphemes；#3815 明确指出 8–15 个并发 row 下不能始终内联完整输出。证据：facts brief `:155-175,194-200`。
- 所有新文本必须复用 `replaceTabs`、`shortenPath`、`truncateToWidth`、`PREVIEW_LIMITS` / `TRUNCATE_LENGTHS` 等现有约束；不得自造固定 viewport width。tool label 与 detail 必须一起参与预算。
- 变更是内部 TUI view-model 和 renderer 行为，不改变模型可见工具协议。running snapshot 的新增字段必须保持 optional，使非-task job、尚无 activity 的 task job 和 settled job 继续使用既有路径。

## 3. 根因分析（按需）

### 3.1 是否需要根因分析
- 需要。
- 理由：用户截图中的空白可能来自采集、传输或渲染任一层；已确认根因决定了最小修复应覆盖 spawn-copy 与 snapshot/render 两个既有 seam，而不是新增 thinking 采集或 progress bus。

### 3.2 已确认事实
- executor 已在 tool start 设置 `currentToolArgs` / `currentToolStartMs`，并在 tool end 将二者与 `currentTool` 一起清空。detached spawn 的 `forwardSyncProgress` 把 executor snapshot 复制到 job-owned progress 时会复制 `currentTool`、`lastIntent`、`recentTools`、`recentOutput`，但未复制 `currentToolArgs` / `currentToolStartMs`；`buildAsyncDetails()` 随后把这个 reduced copy 放入 `latestDetails.progress[]`。这是 hub 路径的第一次丢失。HUD 经 `TASK_SUBAGENT_PROGRESS_CHANNEL` 直接取得完整 executor snapshot，因此不受影响。证据：facts brief Surface C；`packages/coding-agent/src/task/executor.ts:1510-1542`；`packages/coding-agent/src/task/index.ts:993-1001,1325-1334`。
- `snapshotJobs()` 再遍历 `latestDetails.progress[]` 时只复制 `resolvedModel`，`JobSnapshot` 因而丢失 spawn copy 中仍存在的 current/recent activity。这是 hub 路径的第二次丢失。证据：facts brief Surface C。
- running renderer 只从 settled-only 的 `resultText`/`errorText` 生成 preview，因此活动 job 的 gist 为空；现有 500ms refresh 已足够承载小型 gist。证据：facts brief Surface C。

### 3.3 未确认假设
- PR #3821 是否可无冲突 rebase 到当前 main 未验证；设计不依赖该假设。
- 不同终端主题下最终 glyph/color 的主观观感尚未实机确认；行为正确性不依赖特定颜色。

### 3.4 对设计的影响
- 推荐方案必须修复 hub 的两个既有 transport seam：先让 `forwardSyncProgress` 将 args/start timestamp（包括 tool end 的清空）带入 job-owned progress，再让 `snapshotJobs()` 把 compact activity 带入 `JobSnapshot` 并呈现。HUD 沿用完整 executor snapshot；不需要新 channel 或采集 `thinking_delta`。PR #3821 只覆盖 HUD，不能单独解决 primary `hub wait` surface。

## 4. 方案对比

### 4.1 方案 A：双 surface 单条 tool activity 子行
- 核心思路：在 Subagents HUD 与 running hub job 下各显示最多一条 current/recent tool 子行；沿用 OMP 同步 `task` 的 precedence 和 >5s elapsed 规则，视觉上采用修正后的 #3821 子行，密度对应 Gemini collapsed one-line 模式。
- 优点：直接修复用户截图中的 `hub wait` hole；只传递 tool、detail、elapsed 三类小字段；不采集新事件；每 agent 高度有严格的一行上限；能够同时修正 HUD 与 wait 两个默认可见 surface 的不一致。
- 缺点：不能像 Codex/Gemini expanded view 那样展示多步历史或 reasoning；在第一个 tool 开始前会诚实保留无 activity 的状态；两个 surface 的树形前缀和宽度上下文不同，需要分别渲染。
- 适用前提：用户需要的是“看起来仍活着”的低噪声 gist，并接受 PR #3821 式 tool 子行；这些前提均由用户跟进和 facts brief 确认。

### 4.2 方案 B：最多三行的 bounded activity feed
- 核心思路：参考 Codex 的三行上限和 Gemini expanded activity list，为每个运行 agent 显示 current tool、recent tool/output 的最近若干项；仍使用现有 progress，但把 `recentOutput` 与更多 history 纳入 snapshot/render。
- 优点：信息量更高；无 current tool 时可用最近 text output 填补；对长时间推理或多阶段任务更容易理解上下文。
- 缺点：每 500ms 复制、清洗和 diff 更多内容；8–15 个并发 job 时高度和视觉噪声显著增加；`recentOutput` 可能包含更敏感或更难稳定截断的文本；需要定义 output/tool 的排序、去重、过期和 settled 切换规则，形成更深的展示契约。
- 适用前提：产品明确要求可回看多步活动或文本输出，且愿意接受额外高度、payload 和隐私审查；当前请求没有这一约束。

### 4.3 选型结论
- 选择：方案 A。
- 理由：两种方案都能让运行中的 child 可观察，但方案 A 是更浅的最小充分落地：它复用已经存在的 progress、刷新周期、current/recent 语义和 #3821 视觉，不引入 activity history contract。Gemini 的 collapsed default、OMP 同步 task 子行和用户对 #3821 的接受共同支持 compact one-line；Codex 的三行 cap 说明 richer feed 也必须受限，但没有证据要求 OMP 此次承担该复杂度。

## 5. 详细方案

> 本节只展开方案 A。

### 5.1 核心思路
- `packages/coding-agent/src/task/index.ts`
  - 作为 hub transport 的既有 owner，在 `#registerSpawnJob` 的 `forwardSyncProgress` copy list 上增加 `currentToolArgs` 与 `currentToolStartMs`。
  - 两个字段都按 executor snapshot 直接赋值；snapshot 在 `tool_execution_end` 清空字段时，job-owned progress 也必须清空，不能用保留旧值的 fallback。`buildAsyncDetails()` 继续复用现有 spread 将该 copy 放入 `latestDetails.progress[]`；不新增 channel。
- `packages/coding-agent/src/modes/interactive-mode.ts`
  - 在既有 `renderSubagentHudLines` 的 active detached subagent 主行后，读取对应 `AgentProgress`。
  - activity 选择顺序固定为：`currentTool`；否则 `recentTools[0]`；二者都不存在则不画子行。
  - detail 固定为：`lastIntent`；否则 current tool 使用 `currentToolArgs`，recent tool 使用该 recent entry 的 args。
  - current tool 只有在 `currentToolStartMs` 对应 elapsed 大于 5 秒时显示 elapsed；recent tool 不显示不断增长的时长，避免把历史 activity 误称为当前执行。
  - 子行沿用 #3821 的层级样式，但 tool label 和 detail 共同进入 viewport budget。顺序为 tab replacement、home/absolute path shortening、使用现有 preview limit 截断；不得只截 detail 而让 custom tool label 溢出。
  - 保持现有最多 8 个 HUD agent、overflow 提示以及 sync/eval 排除规则不变。
- `packages/coding-agent/src/tools/hub/types.ts`
  - 给内部 `JobSnapshot` 增加 optional `liveActivity` view-model；它只携带 renderer 所需的 `tool`、optional `detail`、optional `elapsedMs`，不复制完整 `AgentProgress`、`recentTools` 数组或 `recentOutput`。
  - optional 设计保证非-task job、尚未产生 tool activity 的 task job及既有调用方无需伪造占位值。
- `packages/coding-agent/src/tools/hub/jobs.ts`
  - `snapshotJobs()` 在现有遍历 `latestDetails.progress[]` 的位置，除 `resolvedModel` 外按相同 precedence 选择 current/recent tool，并构造最小 `liveActivity`。current tool elapsed 在 snapshot 刷新时计算；recent fallback 不带 elapsed。
  - `jobsRenderResult` 对 running snapshot 在既有 job 主行下追加一条 compact activity 子行；对 settled snapshot 继续使用现有 `errorText`/`resultText` preview，并忽略 live activity，避免结算瞬间出现双 preview。
  - 渲染时复用现有 tree indentation、style 和 sanitizer。整行以实际 viewport 宽度预算 tool、detail 与 elapsed；优先保留 tool，再在剩余宽度内显示 detail，elapsed 只在能够完整放下时追加。
  - 没有 `liveActivity` 时维持当前 running row，不显示虚构的 “thinking” 或 “no activity” 文本。
- `packages/coding-agent/test/subagent-hud-render.test.ts`
  - 扩展既有 HUD contract tests，覆盖 current tool、recent fallback、>5s elapsed、无 activity 不增行、超长 tool label、absolute home path 清洗和窄宽度不越界。
- `packages/coding-agent/test/job-renderer-preview.test.ts`
  - 扩展既有 job renderer contract tests，覆盖经 detached spawn copy 的 running live activity snapshot-to-render 路径、current/recent precedence、sanitization/width、missing activity compatibility，以及 settled result/error preview 不被 live row 改写。
- `packages/coding-agent/CHANGELOG.md`
  - 在 `[Unreleased]` 记录 detached subagent 在 HUD 与 `hub wait` / `hub jobs` 中显示 compact live tool activity。

以上均为既有文件更新；不新增 progress 模块、renderer engine 或配置文件。同步 `task` 的 full renderer 保持 canonical behavior reference，但不为了抽取几行选择逻辑扩大本次回归面。两个 surface 共享明确的 selection invariant，并由两组 contract tests锁定；它们仍各自拥有适配自身 tree/viewport 的 presentation。

### 5.2 关键数据流 / 控制流
1. child executor 按现有逻辑处理 `tool_execution_start`、tool completion 和 `text_delta`，更新完整 `AgentProgress`，并通过现有约 150ms coalesced progress channel 发射 snapshot；不改变采集事件或增加 channel。
2. HUD path：executor snapshot → `TASK_SUBAGENT_PROGRESS_CHANNEL` → session registry 的 `session.progress` → `renderSubagentHudLines`；HUD 读取完整 snapshot，选择 current/recent tool，清洗并绘制至多一个子行。
3. hub path：executor snapshot → detached spawn `forwardSyncProgress` copy（含 args/start 及其清空）→ `buildAsyncDetails()` 的 `latestDetails.progress[]` → `snapshotJobs()` 的 `JobSnapshot.liveActivity` → `jobsRenderResult`。
4. `hub wait` 继续以现有 500ms `onUpdate` 获取新 snapshot；`jobsRenderResult` 在 partial/running result frame 中渲染 job 主行和 optional activity 子行。tool 或 intent 改变时，下一次既有 refresh 即反映变化。
5. job settled 后，renderer 走原有 result/error preview；live activity 不再显示。Agent Hub detail 和完整 transcript 不受影响。

### 5.3 接口 / 配置 / 数据结构变更
- 接口：不改变模型可见的 `task`、`hub wait`、`hub jobs` tool schema，也不改变外部 API。内部 `jobsRenderResult` 的输入仍是 `JobSnapshot`；只识别新增 optional view-model。
- 配置：无新增配置、设置或 feature flag；沿用现有 refresh interval、preview limits、theme 和 HUD 可见数上限。
- 数据结构：
  ```ts
  // Proposed internal view-model; exact readonly style follows local convention.
  liveActivity?: {
    tool: string;
    detail?: string;
    elapsedMs?: number;
  };
  ```
  `elapsedMs` 只为超过阈值的 current tool 提供；recent fallback 不设置。`AgentProgress` 本身不增加字段，尤其不增加 thinking storage。
- 不变量：current tool 始终优先于 recent tool；每个 running agent 最多一条 live row；settled preview 与 live row 互斥；所有用户可见 activity 都在渲染前清洗并按实际宽度截断。

### 5.4 错误处理与回退策略
- 找不到匹配 progress、progress 尚无 tool、字段缺失或 job 不是 task 类型：省略 `liveActivity`，保留既有 running row；不得抛错或伪造状态。
- current tool 缺少 start timestamp：仍显示 tool/detail，但不显示 elapsed。时间差为负或不可用时同样省略 elapsed。
- detail 为空：只显示经过预算的 tool label。tool label 极长时必须截断；整行不得突破 viewport。
- 参数含 tab、控制布局的长文本或 absolute home path：依次使用现有 sanitizer 与 width helper；不把 raw value作为 fallback 输出。
- job 在一次 refresh 间隔内 settled：下一 snapshot 只呈现既有 settled result/error preview；无需保留最后一条 live row，也不创建过渡状态。
- spawn-copy seam 已确认：`forwardSyncProgress` 必须直接复制 `currentToolArgs` / `currentToolStartMs`，并在 executor snapshot 清空它们时把 `undefined` 继续传到 job-owned progress。若 tool end 后仍保留旧 args/start，或 tool start 后 `latestDetails.progress[]` 缺少它们，属于本方案实现失败；不得以新 channel、`thinking_delta` 或新增 bus 绕过。
- 回退策略：本变更没有持久化和 schema migration。出现 TUI 回归时可整体回退新增 optional snapshot field及两处子行渲染，现有 job 主行和 settled preview仍可工作。

### 5.5 风险与缓解
- 风险：500ms refresh 中 elapsed 或 activity 变化增加 TUI diff churn。
  - 缓解：每 agent 限制为一行、snapshot 只携带三个小字段、沿用现有 refresh；elapsed 采用现有可读粒度，不引入更高频 timer。
- 风险：tool args 或 custom tool name 泄露 home path或导致窄终端溢出。
  - 缓解：落实 PR #3821 review 的两个 should-fix；tool 与 detail 一起预算，路径先 `shortenPath`，再使用既有 truncation helpers，并用 contract tests覆盖。
- 风险：recent tool 看起来像仍在执行。
  - 缓解：只有 current tool显示长耗时 elapsed；recent fallback 只表达“最近 activity”，不显示增长中的时长。
- 风险：HUD 与 hub 的 selection 语义未来漂移。
  - 缓解：在两组 contract tests中固定同一 precedence/detail/elapsed 不变量；本次不抽取跨 surface renderer，避免引入未知依赖方向和同步 task 回归面。
- 风险：8–15 个并行 agent 时界面仍变高。
  - 缓解：严格一条子行，不显示 `recentOutput` 或三行 feed；保留 HUD 现有 8-agent limit 和 overflow 行。
- 风险：直接采用 stale/conflicting PR 产生合并或旧 API 问题。
  - 缓解：只移植行为，不 cherry-pick；按当前 main 已有导出、style 和 sanitizer 实现，并执行当前 checkout 的 tests与实机 smoke。

## 6. 验证计划
- `packages/coding-agent/test/subagent-hud-render.test.ts`
  - current tool + intent 优先；无 intent 时使用 args。
  - current 缺失时使用最近 completed tool；recent row 不显示增长 elapsed。
  - current tool 超过 5 秒显示 elapsed，未超过阈值不显示。
  - 无 tool activity 时保持原 HUD 行数；sync/eval agent 与 8-agent overflow contract 不变。
  - long custom/MCP tool、absolute home path、tab 和窄 viewport 均被清洗并限制在宽度内。
- `packages/coding-agent/test/job-renderer-preview.test.ts`
  - hub snapshot-to-render 场景必须经过 detached spawn 的 `forwardSyncProgress` copy path；若本地 test seam 只能使用 fixture，则 fixture 必须从不含这两个字段的 job-owned progress 开始并执行等价 copy step，禁止把完整 `AgentProgress` 直接塞入 `latestDetails.progress[]`。
  - 验证 current-tool args 与 start timestamp 经 `forwardSyncProgress` → `latestDetails.progress[]` → `snapshotJobs()` → `jobsRenderResult` 后仍存在，并分别驱动无 intent 的 args detail 与 >5s elapsed；验证 tool end 的 cleared fields 也穿过 copy，随后 recent fallback 生效。
  - 验证 current/recent precedence、detail fallback、elapsed threshold、无 activity compatibility和非-task job compatibility。
  - 验证 running live row 与 settled `resultText`/`errorText` preview 互斥；既有 envelope stripping assertions 保持通过。
  - 验证 renderer 使用 viewport budget，tool label 本身也会截断，home path 不原样出现。
- 运行 `packages/coding-agent/` 现有最小范围 TypeScript/build check，以及上述两个定向 test 文件；不以 source-grep 代替行为断言。
- 实机 TUI smoke：启动一个会执行至少两个不同 tool 的 detached subagent，在父 transcript 调用 `hub wait`，观察 job 子行在现有刷新周期内出现并切换；同时检查 footer HUD 的同语义子行。
- 实机边界 smoke：在窄终端使用长 custom tool name和含 home path 的参数，确认无换行破坏、无 raw home path；启动多个 detached subagent，确认每个最多一条 live row、HUD limit/overflow 仍生效。
- settled smoke：让同一 job成功和失败各一次，确认完成后只显示既有 result/error preview，且 Agent Hub仍可打开完整详情。
- transport seam 验证：通过上述 spawn-copy-to-render test 锁定两次已确认的字段丢失，证明 current-tool args / elapsed 仅在 copy path 已执行后可见；不以直接构造完整 `latestDetails.progress[]` 的 fixture 掩盖第一次丢失。

## 7. 关键决策摘要
- 采用“HUD + hub running result frame 各一条 compact tool activity 子行”，不采用三行 output/activity feed。
- `AgentProgress`、`task/index.ts` 的 detached spawn `forwardSyncProgress` copy、现有 channel/registry、`renderSubagentHudLines`、`snapshotJobs()` / `jobsRenderResult` 和 sanitizer 是唯一既有 owner；hub args/elapsed 必须先由 spawn-copy owner 保留，再进入 snapshot/render；不新增 progress bus或第二套采集。
- `JobSnapshot` 只增加 optional 最小 `liveActivity` view-model，不搬运完整 progress或 `recentOutput`。
- current tool优先、recent tool回退、intent优先于 args、current >5s 才显示 elapsed；settled preview与 live row互斥。
- `thinking_delta` 明确保持非目标；用户接受的 #3821-style row 不依赖 thinking collection。
- PR #3821 作为视觉/行为参考手工适配，并必须修复 tool label overflow 与 absolute home path两个 review问题。

## 8. Handoff

### 8.1 同会话继续
宿主原生路径（可复制执行）：`读取 docs/superpowers/specs/2026-08-29-subagent-live-progress-preview-design.md 与 docs/superpowers/specs/2026-08-29-subagent-live-progress-preview-facts-brief.md；确认 design_author=sol、planned_reviewer=grok-4.6-xhigh、implementation_authorization=原始请求 design-only 且当前会话目标仅在后续 Gate PASS/PASS_WITH_NOTES 后授权实现；按 subagent-delegation 触发只读 grok-4.6-xhigh（host-native subagent）执行独立 Design Review Gate，并将完整 artifact 写入 docs/superpowers/plans/2026-08-29-subagent-live-progress-preview-subagent-review.md。pre-review 阶段先生成完整 Reviewed Inputs manifest 与 reviewed_revision，不伪造 digest；禁止作者自审；本轮只修订设计，不实现，只有后续 Gate PASS/PASS_WITH_NOTES 且 Inputs continuity 成立后才可进入实现。`

### 8.2 新会话恢复 prompt
```text
请完整读取以下设计输入：
- docs/superpowers/specs/2026-08-29-subagent-live-progress-preview-design.md
- docs/superpowers/specs/2026-08-29-subagent-live-progress-preview-facts-brief.md

先以文件原始 bytes 计算 lowercase SHA-256，按 normalized repo-relative POSIX path 排序，生成 path + SHA-256 `Reviewed Inputs` manifest；将每项序列化为 UTF-8 `<path>\t<sha256>\n` 后计算 `reviewed_revision`。pre-review handoff 不伪造 digest。

设计元数据：
- design_author=sol
- design_author_identity=SolDesignAuthor
- planned_reviewer=grok-4.6-xhigh（host-native）
- implementation_authorization=original_request=design-only；current_session_goal=仅在后续 Design Review Gate 判定 PASS / PASS_WITH_NOTES 后授权实现
- authorization_source=原始用户请求要求调研其他开源 CLI 后给出最佳实现方案，明确可基于社区 PR #3821，但未授权写代码；当前会话目标仅授权在修订后的 Design Review Gate 判定 PASS / PASS_WITH_NOTES 后进入实现。本轮只修订设计，不实现。Grok 原作者卡住被取消后由 sol 从 facts brief 整篇重写。

使用只读 grok-4.6-xhigh（host-native subagent）执行独立 Design Review Gate；作者 sol / subagent-sol 不得自审。核对：hub 路径的两次已确认字段丢失（`task/index.ts` detached spawn `forwardSyncProgress` copy，以及 `snapshotJobs()`）是否都由推荐方案修复，HUD 是否仍读取完整 executor snapshot；方案是否复用 AgentProgress、现有 channel、renderSubagentHudLines、snapshotJobs/jobsRenderResult 和现有 sanitizers；是否错误引入 progress bus、thinking_delta、三行 output feed、Agent Hub rewrite、#2512、#2762 或新设置；推荐的 compact 双-surface 方案是否确为满足成功标准的更浅落地；文件级细节是否只展开推荐方案；测试是否经过 spawn-copy-to-render，并覆盖 HUD、sanitization、width 和 settled compatibility。

将完整 review artifact 持久化到：
- docs/superpowers/plans/2026-08-29-subagent-live-progress-preview-subagent-review.md

artifact 必须记录 review_mode=host-native、完整 Reviewed Inputs manifest、reviewed_revision、author/reviewer native agent_id 与 model、verdict、授权来源和可复查证据。评审结论必须为 PASS / PASS_WITH_NOTES / NEEDS_REVISION / NEEDS_REDESIGN 四选一。

NEEDS_REVISION 时回到当前设计文档修订；NEEDS_REDESIGN 时回到 design-brainstorm 重新设计。任何正文实质变化后均须重新执行 Gate，且 Gate 通过前不得实现。

PASS / PASS_WITH_NOTES 后，只有 current Inputs manifest 等于 reviewed manifest，或存在覆盖全部输入的有效 Gate Continuity Note，才算 Gate 连续。原始请求是 design-only；当前会话目标提供的条件式实现授权只有在该后续 Gate PASS / PASS_WITH_NOTES 且 continuity 成立后才生效。本轮不得实现。Review 后输入变化应由未参与 author、reviewer、正文修改或 implementation 的主协调者按 handoff 规则分类：仅非实质变化可持久化覆盖完整 manifest 的 Gate Continuity Note；实质、不确定、遗漏输入或角色未分离时必须重跑 Gate。
```