# 普通会话默认主动委派：自动并行感知 + 轻量阶段推进 + 既有模型路由

- 日期：2026-08-04
- 状态：最终评审修复完成（round 2 reviewer）
- revision_round: 2
- reviewer_input_sha256: `bf0dfc7ad334e4bc8653c27a059b4f12e0ba18186a9dec6c7778fa5e95ec009f`
- reviewed_at: 2026-08-04
- effective_config_sha256: `1eb09e44cb35d1a2ad0dda2162c0e711d044e039e9e4c18fba9b070c756bd5f1`
- 范围：`packages/coding-agent/`
- 关联：`magic-keywords`（workflowz）、`task.eager`、`task.batch`、agent frontmatter、`task.agentModelOverrides`、bundled agent 注册（`task/agents.ts`）、`prompts/tools/workflow.md` canonical owner、`docs/superpowers/specs/2026-08-04-plan-review-pipeline-design.md`

## 1. 背景与需求

普通主会话在 `task` 工具可用时已经具备委派能力，但仓库 schema 的 `task.eager` 默认仍为 `"default"`，不会渲染正面主动委派指引；本机 effective config 已显式设为 `"preferred"`。`task` 并非“每个会话常驻”：subagent 可受工具 allowlist 与递归深度限制，plan mode subagent 还会被强制收窄为只读工具。`workflowz` 则需要用户显式输入关键词，注入 eval 编排 notice，属于另一条确定性 recipe。

需求：

1. **自动感知 parallel/parallelize**：用户明确说 `parallel`/`parallelize` 时继续强制 fan out（现有行为）；未明说时，只有在 scope 后存在至少 2 个独立、可立即运行的切片，才默认 batch fan out。
2. **主动委派轻量工作**：task 只承接已 scope 的独立切片；只读探索走 scout；具体 patch 的 critique 可走 reviewer。禁止“spawn 一个写任务然后主 agent 空等”；单 subagent 默认仅允许只读 scout 这一现有例外，reviewer 必须与 parent verification 或另一独立切片并行。
3. **复用 canonical workflow owner**：完整 design→plan-review→implement→verify→code-review→repair 门禁一律走既有 `workflow`；task 自组织轻链不复制 WorkflowArtifact、持久状态、deterministic verifier、repair、receipt、resume 或仲裁。
4. **保持姿态性而非 workflowz 确定性**：主动委派是 SHOULD，模型先 scope 再自组织，不注入 workflow notice，不强制 eval recipe。
5. **保留既有模型路由**：通用 worker 保持 `@task`；不新增 planner bundled agent；reviewer 仓库定义保持 Sol→Opus→`@task` 候选链。阶段路由实验只选择既有 agent，不重写其 frontmatter 或 fallback owner。

## 2. 现状与约束（证据）

**配置基线**（`reviewed_at=2026-08-04`；本机 `/Users/sheng/.omp/agent/config.yml:609-650`；完整文件 hash 见页首）：

| 配置键 | 当前 effective 值 | 来源 | schema/default 区分 |
|---|---|---|---|
| `task.eager` | `"preferred"` | [当前本机 effective] 显式键 | [当前 schema 默认] `"default"`（`settings-schema.ts:4645-4648`） |
| `task.batch` | `true` | [当前本机 effective] 显式键 | [当前 schema 默认] `true`（`:4662-4665`），不是 false |
| `async.enabled` | `true` | [当前本机 effective] 显式键 | [当前 schema 默认] `true`（`:4134-4136`） |
| `compaction.thresholdPercent` | `70` | [当前本机 effective] 显式键 | [当前 schema 默认] `-1`（`:2154-2156`），不是 70 |
| `compaction.idleEnabled` | `true` | [当前本机 effective] 显式键 | [当前 schema 默认] `false`（`:2248-2256`），不是 true |
| `compaction.idleThresholdTokens` | `200000` | [当前 schema 默认] default-derived；本机未显式覆盖 | schema 默认见 `:2259-2262` |
| `task.agentModelOverrides` | `{scout: Flash:max, designer: Sol:high, task: Luna:max, reviewer: Sol:xhigh}` | [当前本机 effective] 四个显式键 | [当前 schema 默认] `{}`（`:4817-4820`） |
| `modelRoles.plan` | `gateway/gpt-5.6-luna:max` | [当前本机 effective] 显式键 | schema record 无此默认项 |
| `modelRoles.default` | `gateway/deepseek-v4-flash:max` | [当前本机 effective] 显式键 | schema record 无此默认项 |
| `defaultThinkingLevel` | `"high"` | [当前 schema 默认]；本机未显式覆盖 | classifier 仅 thinking=`auto` 时激活（`settings-defs.ts:126-129`） |
| `modelOptimization.enabled` | `false` | [当前 schema 默认]；本机未显式覆盖 | ordinary-session truncation seam 已存在，只是默认关闭 |

**能力与约束**：

| 事实 | 证据 |
|---|---|
| `task` 非每会话常驻；subagent 可有受限工具集，递归深度达到上限后不再暴露 `task` | `tools/index.ts:481-487,639-640`；`task.maxRecursionDepth` schema 默认 2（`settings-schema.ts:4719-4722`） |
| plan mode 的 task child 被强制替换为只读工具集、移除 `spawns`/prewalk；isolation/apply/merge 控制被拒绝 | `task/structured-subagent.ts:194-220,256-279`；`test/task/structured-subagent.test.ts:151-165` |
| 委派姿态由 `task.eager` 驱动 | `sdk.ts:2774-2775`：`eagerTasks = task.eager !== "default"`；`eagerTasksAlways = task.eager === "always"` |
| 系统提示 Delegation 段按 `eagerTasks` 条件渲染 | `prompts/system/system-prompt.md:155-190`；GPT-5.6 分支判定在 `task/prompt-policy.ts:7` |
| 当前 prompt 的 codex-default 禁止 spawn 与无条件 “Default to parallel” 直接冲突 | `system-prompt.md:162` vs `:175-177`；这是必须永久修正的 correctness bug，不作为可回滚实验 arm |
| 用户明确说 `parallel`/`parallelize` 的 MUST 规则已存在 | `system-prompt.md:112` |
| Delegation gates 已规定 scope-first、禁止 spawn-one-then-wait、width=真实独立性 | `system-prompt.md:181-190` |
| `always` 的首轮 eager task prelude 仅主会话且非 plan mode 渲染 | `session/todo-tracker.ts:159-173` |
| bundled agent frontmatter 当前为 scout/librarian=`@smol`、designer=`@designer`、task=`@task`；reviewer 为 Sol→Opus→`@task` | `prompts/agents/{scout,librarian,designer,reviewer}.md`；`task/agents.ts:31-75` |
| 本机 reviewer override 为单一 `gateway/gpt-5.6-sol:xhigh`，会先于 reviewer frontmatter 候选链生效 | config receipt；`task/structured-subagent.ts:297-304` |
| bundled agents 由 `task/agents.ts` 的 `EMBEDDED_AGENT_DEFS` 显式嵌入，不做目录扫描 | `task/agents.ts:8-15,31-75` |
| project/user agent 优先于 bundled agent，同名覆盖 | `task/discovery.ts:63-67,121-137` |
| 模型解析优先级为 per-call `request.model` > `task.agentModelOverrides[agent]` > agent frontmatter > active/session fallback | `task/structured-subagent.ts:297-304`；`config/model-resolver.ts:1104-1150` |
| `@task` 是模型角色/会话继承标记；通用 worker 保持它才能尊重用户 role 与 active-session fallback | `config/model-roles.ts:22-65`；`model-resolver.ts:960-972,1104-1150` |
| task-agent 候选 fallback 由 `model-resolver.ts` + `task/executor.ts` 的 retry fallback chain 处理；workflow 的 family-aware `model-router.ts` 不拥有普通 task 路由 | `task/executor.ts:150-225,2625-2688` |
| `task.maxEffort` 默认 `"max"`，仅调用方显式传 `effort` 时 clamp；frontmatter 的显式 xhigh 不受该 ceiling 降低 | `settings-schema.ts:4798-4810`；`task/executor.ts:2696-2718` |
| 完整 gated pipeline 的 canonical owner 已存在 | `prompts/tools/workflow.md:1-9`：“plan → plan review → implement (isolated) → verify → code review → repair → final verify” |
| 当前 workflow plan reviewer 是只读 `ReviewArtifactV1` 三态评审；D 文档拟议在同一 owner 上增加反锚定字段、同评审复审与仲裁，不是当前已实现事实 | `prompts/workflow/plan-reviewer.md:1-24`；D 文档 §§3-5 |
| task 的 generic reviewer 是 patch-only code reviewer，输出 `overall_correctness: correct|incorrect` | `prompts/agents/reviewer.md:1-76` |
| 现有 `task.eager` 显式值回归覆盖恰有六个文件 | `test/agent-session-eager-task.test.ts`、`agent-session-eager-compaction.test.ts`、`agent-session-plan-reference-compaction.test.ts`、`agent-session-plan-reference-setup-bail.test.ts`、`settings-manager.test.ts`、`acp-lazy-startup.test.ts` |
| ordinary-session tool output optimization 已复用共享 seam，当前缺口只是 `modelOptimization.enabled=false` | `session/agent-session.ts:3046-3085`；`workflow/tool-output-manager.ts:364-401` |

## 3. 设计目标

- 仓库默认最终获得“prefer 主动”的正面委派姿态，但必须先通过 §8 的独立 A/B arms。
- 自动并行只在 scope 后存在 **≥2 个独立可运行切片**时默认 fan out；不为了并行制造切片。
- task 轻量委派只覆盖已 scope 切片与只读 exploration/critique；完整门禁交给 workflow。
- 单写任务不得 spawn-one-then-wait；单只读 scout 可用于隔离大体量探索上下文。
- plan mode 只允许只读 child；共享 eager 文案不得给出正向 working-tree/implementation 指令。
- 阶段选择复用既有 task/scout/reviewer agent；保持 `@task`、reviewer 候选链与用户 override/fallback。
- `task.eager: default` 始终是绝对 opt-out；GPT-5.6 codex-default 不收到互相矛盾的指令。

## 4. 设计决策

### D1 — 默认翻转采用“先开关、后推广”

目标状态仍是 `task.eager` schema 默认从 `"default"` 改为 `"preferred"`。为避免先全局翻转再补实验：

1. 先实现 §4 D2 的三个独立 guidance 开关，默认 false；
2. 用显式 `task.eager: preferred` 做 pilot；
3. arm 1 通过停止条件后，才把 schema 默认改为 `"preferred"`；
4. 三个 guidance arm 分别通过后才逐项推广默认，不捆绑上线。

已显式保存 `"default"` 的用户不受 schema 默认翻转影响；boolean `false` 迁移仍归一为 `"default"`（`config/settings.ts:1421-1424`）。

### D2 — 三个 prompt/route 开关复用 settings canonical owner

新增三个布尔设置，均嵌套在 `eagerTasks` 总 gate 下：

- `task.proactive.autoParallel`：控制 ≥2 独立切片的默认 batch 文案。
- `task.proactive.pipelineGuidance`：控制轻量 task 边界与升级 workflow 文案。
- `task.proactive.stageRouting`：控制 task/scout/reviewer 的阶段选择文案；不修改 agent frontmatter。

`task.eager: default` 时三者即使为 true 也不得渲染。实验阶段三者默认 false；推广时逐项翻转，确保 arm、snapshot 与 rollback 独立。所有开关继续由现有 `config/settings-schema.ts`、`sdk.ts`、`system-prompt.ts` 与 `system-prompt.md` 承载，不新增第二个委派引擎。

### D3 — 永久修复 system prompt 矛盾

- 把 `system-prompt.md:175-177` 的无条件 “Default to parallel for complex changes” 删除并并入 `task.proactive.autoParallel` 文案；该文案同时受 `eagerTasks` gate 约束。
- codex-default（`eagerTasks=false`）只保留 “Do not spawn…” 与通用 gates，不再出现默认 parallel。
- 新文案明确：**scope 后至少 2 个独立可运行切片才默认 batch**。单 planner、单 worker、串行 reviewer 链均不满足。
- 这是 correctness 修复；不得将恢复无条件冲突文案定义为 rollback arm。

### D4 — task 与 workflow canonical owner 的唯一边界

**task 主动委派可做**：
- 已 scope、可独立运行的轻量切片；写切片只有在同批 ≥2 个独立切片，或 parent 同时继续另一独立切片时才委派。
- 单个只读 scout，用于把大体量探索隔离出 parent context。
- patch critique reviewer，但 reviewer 运行时 parent 必须继续 verification 或另一独立切片；否则 inline review，或进入 workflow 完整 gate。

**必须升级 workflow**：
- 方案/架构设计需要 plan review；
- 跨模块 contract/schema 变更；
- 需要持久 artifact、deterministic verifier、repair、rollback/resume；
- 需要完整 design→plan-review→implement→code-review 门禁。

轻量 task 链不得宣称执行 D 的 plan-review 管线，也不得建立平行 PlanArtifact/ReviewArtifact/仲裁状态机。

### D5 — plan reviewer 与 code reviewer 分离

- **Plan review**：唯一落点为 workflow 的 `prompts/workflow/plan-reviewer.md`。当前输入 PlanArtifact、输出 `ReviewArtifactV1`（`approved|changes_requested|blocked`）；D 文档拟议的目标合同为“单强评审 + 同评审复审 + 分歧仲裁”，并在同一 prompt/schema/stage owner 上增加 anti-anchoring、finding basis 与 coverage。E 不复制实现。
- **Task patch critique/code review**：落点为 `prompts/agents/reviewer.md`，遵守 patch-only `overall_correctness: correct|incorrect` 契约。
- generic reviewer 不承担 plan review；workflow plan reviewer 不改成 N-reviewer/any-block 投票。

### D6 — 保留 `@task`、reviewer 候选链与 fallback owner

- 通用 task worker frontmatter 继续为 `model: "@task"`；不改为 literal Flash。
- 不改全局 `modelRoles.task`；用户仍可通过 per-call model、`task.agentModelOverrides.task`、`modelRoles.task` 或 active session model 控制。
- reviewer 仓库定义继续为 `gateway/gpt-5.6-sol:xhigh` → `gateway/claude-opus-5:max` → `@task`。本机单值 reviewer override 是 [当前本机 effective]，不是仓库默认候选链。
- 普通 task fallback 由 `resolveAgentModelPatterns`、auth fallback 与 executor retry chain 处理。`resolvedModel`/`resolvedModelIsFallback` 可作为 A/B receipt；不虚构普通 task 已有 workflow-style degraded/family receipt。
- D 的 family-aware plan-review route 属 WorkflowEngine；E 的 stage-routing arm只选择既有 agent，不新增 planner、不绕过 workflow route。

### D7 — 不新增 planner bundled agent

workflow 已有确定性 planner；designer 是 UI/UX agent；generic task 足以承担已 scope 切片内部的局部规划。方案/架构规划走 workflow，轻量委派不注册 `planner.md`、不改 `EMBEDDED_AGENT_DEFS`、不留下 thinking-level 占位符。

### D8 — plan mode 不渲染正向 implementation guidance

- 共享 eager 文案不列“single-module implementation/local refactor”等正向 write 示例，只说 active mode 允许的 scoped slice。
- plan mode 的 task preflight 已在 `structured-subagent.ts` 把 child 强制为只读工具、移除 spawns，并拒绝 isolation/apply/merge；设计复用该 owner。
- plan mode 遇到实现诉求时只走既有 plan proposal handoff；不得启动 write-capable workflow/task path。
- 新测试同时核对 prompt 文案与 `resolveEffectiveSubagentPolicy(planMode=true)` 的只读工具集合。

### D9 — 不动的能力

- `workflowz` 检测、eval notice 与 recipe 不动。
- `eager-task.md` 的 `always` prelude 不动。
- bundled task/scout/reviewer/designer frontmatter 不动；不新增 planner。
- `prompts/workflow/plan-reviewer.md` 与 `prompts/agents/reviewer.md` 在 E 中不改；D 单独拥有 plan-review 目标合同。

## 5. 阶段模型路由表（保持既有 owner）

| 场景 | agent/owner | 仓库 selector | 本机 effective | fallback/说明 |
|---|---|---|---|---|
| 已 scope 一般切片 | `task` | `@task` | `task.agentModelOverrides.task=Luna:max` | 保持 `@task`；per-call/user override 优先 |
| 只读探索 | `scout` | `@smol` | `task.agentModelOverrides.scout=Flash:max` | 单 scout 是允许的只读例外 |
| 具体 patch critique | `reviewer` | Sol:xhigh→Opus:max→`@task` | 单值 override Sol:xhigh | 只在与 parent verification/另一切片并行时用于轻量链 |
| UI/UX | `designer` | `@designer` | Sol:high | 不属于通用方案 planner |
| 方案/架构设计 | workflow planner | workflow quality route | 由 quality-tier snapshot 解析 | 不新增 bundled planner |
| 方案评审 | workflow plan reviewer | D：单强评审+同评审复审+仲裁 | 由 workflow route 解析 | 唯一 prompt 为 `prompts/workflow/plan-reviewer.md` |

覆盖顺序：per-call `request.model` > `task.agentModelOverrides[agentName]` > agent frontmatter > active/session fallback。`task.maxEffort` 只 clamp 显式 `effort`；不把 frontmatter xhigh 当成受该 ceiling 自动降低。

## 6. 具体改动

### 6.1 `config/settings-schema.ts`

1. 新增 `task.proactive.autoParallel`、`task.proactive.pipelineGuidance`、`task.proactive.stageRouting` 三个独立 boolean；实验初始默认 false。
2. 保持 `task.eager` schema 默认 `"default"` 直至 arm 1 通过；推广时单独改为 `"preferred"`。
3. UI 明示 `"default"` 是 opt-out；Preferred 只渲染已通过并启用的 proactive guidance。
4. 不改 `task.batch` 默认（当前已是 true），不新增 agent/model 配置键。

### 6.2 `sdk.ts` + `system-prompt.ts` + `prompts/system/system-prompt.md`

`buildSystemPrompt` 增加三项布尔模板输入，并由现有 settings 读取；共享块位于 codex/非 codex split 之后、Delegation gates 之前：

```handlebars
{{#if eagerTasks}}
{{#if taskProactiveAutoParallel}}
- **Auto-parallelize only real width.** After you scope the request and identify at least 2 independent runnable slices, treat that as an implicit `parallel`/`parallelize`: fan them out together via `{{toolRefs.task}}`. Do not serialize them, invent padding, or spawn one worker and wait.
{{/if}}
{{#if taskProactivePipelineGuidance}}
- **Delegate only scoped slices.** Keep the top-level plan and cross-slice contracts yourself. A lone write-capable spawn that you wait behind remains prohibited; a single proactive spawn is reserved for a read-only scout that keeps bulk exploration out of parent context.
- **Escalate complete gated delivery to workflow.** If the work needs solution/architecture design with plan review, cross-module contracts, or persistent verify/repair/rollback/resume, use `{{toolRefs.workflow}}`. In plan mode remain read-only and use the plan proposal handoff; never start a write-capable delivery path.
{{/if}}
{{#if taskProactiveStageRouting}}
- **Route through existing agents.** General scoped slice → `task`; read-only exploration → scout; concrete patch critique → reviewer only while you continue verification or another independent slice. Preserve each agent's configured selectors and fallbacks; never add a generic planner agent.
{{/if}}
{{/if}}
```

删除旧的无条件 “Default to parallel…” 行，避免重复与 codex-default 冲突。

**渲染矩阵**：

| 会话 | eager 总 gate | 三个独立 flag | 结果 |
|---|---:|---:|---|
| Pilot control | preferred | 对应 arm=false | 只缺该 arm 文案，其余配置冻结 |
| Pilot treatment | preferred | 对应 arm=true | 只增加该 arm 文案 |
| `task.eager: default` | false | 任意 | proactive 三段均不渲染；codex-default 无矛盾 |
| `task.eager: always` | true | 按 flag | 现有 MUST/prelude 保留；新增文案仍受独立 flag 控制 |
| plan mode | 可为 true | 按 flag | 文案无正向 implementation 示例；child policy 强制只读 |

### 6.3 测试

| 文件 | 合同 |
|---|---|
| 新建 `test/system-prompt-delegation.test.ts` | 三 flag 可独立开关；`eagerTasks=false` 全部不渲染；auto-parallel 文案含“至少 2 个独立 runnable slices”；旧无条件 “Default to parallel” 不再存在；GPT-5.6 codex-default 无冲突 |
| `test/task/structured-subagent.test.ts` | plan mode child 仅 `read/grep/glob/web_search/ast_grep`，无 spawns；隔离/apply/merge 被拒绝 |
| `test/settings-manager.test.ts` 或 schema 测试 | 三 flag 初始默认 false；推广变更单独测试；`task.eager: default` 为绝对 opt-out |
| 现有六文件回归 | `agent-session-eager-task`、`eager-compaction`、`plan-reference-compaction`、`plan-reference-setup-bail`、`settings-manager`、`acp-lazy-startup` |

### 6.4 Release note（功能通过 smoke/A/B 后）

说明默认委派姿态、≥2 独立切片门槛、workflow canonical owner、plan-mode 只读边界与 `task.eager: default` opt-out。未通过 §8 前不宣称全局默认已推广。

## 7. 验证步骤

1. `bun test test/system-prompt-delegation.test.ts test/task/structured-subagent.test.ts test/agent-session-eager-task.test.ts test/agent-session-eager-compaction.test.ts test/agent-session-plan-reference-compaction.test.ts test/agent-session-plan-reference-setup-bail.test.ts test/settings-manager.test.ts test/acp-lazy-startup.test.ts`。
2. repo 标准 typecheck 与相关 lint。
3. 手动渲染四组：GPT-5.6/non-GPT × eager true/false；确认 codex-default 没有任何默认 spawn/parallel 指令。
4. 手动进入 plan mode，调用 task preflight；确认 child 工具只读、无 spawns，且共享 prompt 不出现正向 implementation 示例。
5. 用一个“3 个互不相交模块”的 fixture 验证 treatment 一次 batch ≥2；用一个单文件 bug fixture 验证不 spawn-one-then-wait。
6. 用 reviewer 路由 fixture 验证结果记录 `resolvedModel` 与 `resolvedModelIsFallback`；本机 override 与仓库 frontmatter 必须分别记录。

## 8. A/B 测试与护栏（Blocking 5）

### 8.1 四个独立 feature arms

| Arm | Control | Treatment | 独立开关/owner | Snapshot | 独立 rollback |
|---|---|---|---|---|---|
| `eager_default` | schema 默认 `default` | schema 默认 `preferred` | `task.eager` | settings revision + effective config hash | 恢复 schema 默认 `default`；不动其余 arms |
| `auto_parallel_copy` | `task.proactive.autoParallel=false` | `true` | system prompt setting | prompt hash + rendered text hash | 关闭该 flag |
| `pipeline_guidance` | `task.proactive.pipelineGuidance=false` | `true` | system prompt setting | prompt hash + workflow prompt hash | 关闭该 flag |
| `stage_model_routing` | 轻量委派统一走 generic `task` | 按 task/scout/reviewer 阶段选择 | `task.proactive.stageRouting` | agent source/hash + requested selectors + effective override + resolved model/fallback | 关闭该 flag；不改 frontmatter/`@task` |

无条件 “Default to parallel” 的 gate 修正是 correctness baseline，不是第五 arm，也不得回滚到冲突状态。

### 8.2 配对、随机化与双账本

- **单-arm 隔离**：测 `eager_default` 时三 guidance flags 均 false；测 arms 2-4 时 control/treatment 均固定 `task.eager=preferred`，只翻一个 flag。
- **同任务配对**：同一 user-request/fixture hash、同 parent model、同 agent discovery source/hash、同模型可用性、同 `task.batch`/`async` snapshot，各跑 control 与 treatment。
- **随机化**：每对随机或交叉平衡先后顺序；同一 host 上 control/treatment interval 不重叠，避免 provider/CPU contention 污染。
- **样本量**：pilot ≥30 对；正式 ≥100 对，或预注册 CI 固定集与判定区间。
- **Canonical interval-union ledger**：记录 parent 与全部 descendants 的 `[startedAt, endedAt)`；对区间做 union，重叠并行时间只计一次。
- **Legacy sum ledger**：把 parent/child 各 interval 直接相加，仅用于历史复算；不得与 union ledger混成“节省”。
- **成本总量**：每 task 把 parent+完整子树的 requests、tokens、USD、spawned-agent count 全部相加；成本是 additive，不做 interval union。
- **路由 receipt**：使用现有 `AgentProgress`/`SingleResult` 的 requests、tokens、usage、durationMs、`resolvedModel`、`resolvedModelIsFallback`；若开始/结束时间未持久化，只扩展现有 task lifecycle/result，不新建 scheduler。

### 8.3 质量与成本停止条件

以下均为 [拟议验收目标]。单-arm 实验触发时只关闭该 arm；组合实验触发时先 fail closed 关闭组合，随后只能逐 arm 重新启用定位，不把组合效应冒充单 arm 边际贡献。

1. **完成率/人工通过率下降 >2pp**：关闭致因 arm。
2. **返工率上升 >10%**：以 revision/repair cycles 对比 control，关闭致因 arm。
3. **P0/P1 escape**：treatment 任一归因于该委派变更的 P0/P1 逃逸即停止；不以“control 也出现”为豁免。
4. **无效阻断或错误 reviewer 结论上升 >2pp**：关闭 `stage_model_routing` 或相关 guidance arm。
5. **成本 P50/P95**：每 task 总 requests/tokens/USD 的 P50 >1.5× control 或 P95 >2× control，且中位 interval-union latency 改善 <10%，停止对应 arm。
6. **agent 数膨胀**：spawned-agent count P95 >2× control 或超过配置并发上限导致排队，停止 `auto_parallel_copy`。
7. **合同违规**：出现 scope 前 spawn、单写 agent 等待、plan mode write-capable child、task 轻链伪装 plan review，立即停止相关 arm，不等统计显著性。

### 8.4 行为场景

| 场景 | 预期行为 | 证据 |
|---|---|---|
| “重构 3 个互不相交模块” | treatment scope 后一次 batch ≥2 | task batch size + non-overlap path receipt |
| 单文件 bug fix | inline 完成，不 spawn 单 worker 后等待 | child count=0 |
| 大范围只读探索 | 可单独 spawn scout | agent=`scout`、只读工具 |
| patch critique | reviewer 与 parent verification/另一切片并行；否则 inline/workflow | parent/child interval overlap |
| 需 plan review/跨模块 contract | 使用 workflow，不用 task 自组织完整链 | workflow artifact/receipt 存在；无 task plan-review artifact |
| plan mode | child 只读、无 spawns/apply/merge | structured-subagent policy + prompt snapshot |
| stage route | task/scout/reviewer 分别解析既有 selector；无 planner | agent source/hash + `resolvedModel` |
| fallback | 记录 `resolvedModelIsFallback`；不声称普通 task 有 workflow degraded receipt | task result fields |
| 停止条件 | 只回滚致因 arm；组合先全部关闭再逐 arm 重启 | settings snapshot + rollback receipt |

## 9. 风险与边界

- **R1 全局默认翻转**：影响所有未显式配置的新会话；通过 arm 1 后才推广，保留 `task.eager: default`。
- **R2 模型自觉性**：Preferred 是 SHOULD，触发率不确定；用行为 ledger 测量，不把 prompt 存在当行为已发生。
- **R3 codex-default 一致性**：auto-parallel 永远在 eager gate 内；无条件冲突行永久删除。
- **R4 plan mode**：prompt 不给正向 implementation 指令，task preflight 强制只读；任一 write-capable child 是合同违规。
- **R5 子会话递归**：subagent 只能在 `task.maxRecursionDepth` 内继续 spawn；达到默认深度 2 时 task 工具消失。
- **R6 workflow 边界误判**：通过明确触发条件与 workflow artifact receipt 检测；task 轻链不得补造状态机。
- **R7 本机配置已是 preferred**：arm 1 必须用未配置环境或显式 control，不能把本机现状当 schema 默认。
- **R8 agent 覆盖**：project/user 同名 agent 优先；A/B 必须冻结 agent source/hash，不能只记 agent 名。
- **R9 评审偏置**：generic reviewer 仅做 patch critique；plan review 始终走 D 的单强评审+同评审复审+仲裁，不以“PASS 早”决定模型路由。

## 10. 评审质量背景（引用 D；E 不重复实现）

### 10.1 文献与推断边界

1. **聚合收益不是通用 reviewer 结论**。[文献] MoA（arXiv:2406.04692）报告纯开源 layered ensemble 在 AlpacaEval 2.0 为 65.1%，GPT-4 Omni 为 57.5%；Self-Consistency（arXiv:2203.11171）报告 GSM8K +17.9%。[推导] 前者是有聚合层的开放生成，后者是可验证推理采样；两者都不能直接证明“多个便宜 plan reviewers 优于一个强 reviewer”。
2. **质量不等于模型数量**。[文献] Self-MoA（arXiv:2502.00674）报告单一顶级模型的 Self-MoA 在多种场景优于混合 MoA，并指出混入较弱模型会降低平均质量。[推导] E/D 因此不采用 N-reviewer any-block 投票。
3. **草案覆盖限制**。[文献] Huang et al.（ICLR 2024）报告无外部反馈的自我纠错在推理任务上可能降质。[推导] 对开放方案评审，弱草稿漏掉的维度不能假定 reviewer 一定补全，故 D 要求 anti-anchoring 与 finding basis。
4. **迭代改进数字**。[文献] Self-Refine（arXiv:2303.17651；NeurIPS 2023）报告跨七项任务平均约 +20% absolute；CriticGPT（OpenAI 2024）表明 critique assistance 可帮助发现模型输出问题。[推导] 这些结果支持“强草稿+强评审”作为质量优先候选，但不是仓库当前能力事实。[未验证假设] 收益递减；[拟议验收目标] review-refine 最多 1-2 轮。
5. **PASS 早**。[未验证假设] Flash draft + Sol review 比 Opus draft + Sol review 更早 PASS；本仓库可见 artifacts 不足以证明该比较。[推导] 攻击面/遵从度可能造成偏置。[未验证假设] family bias 可能存在，但缺少可复现的 Yang et al. 2026 标识，因此不作为实现前提或 `[文献]` 事实。

**结论：[推导] PASS 是内部一致性信号，不是最优性信号；E 的 stage-routing arm 必须用 §8 的质量指标，而不是 PASS 速度选路。**

### 10.2 Plan review 专属目标合同

适用对象仅为 workflow `prompts/workflow/plan-reviewer.md` 与 D 的 WorkflowEngine 方案；generic `prompts/agents/reviewer.md` 不承载：

1. anti-anchoring：列出草案未覆盖的约束、风险、备选方向；
2. finding basis：`spec_requirement | user_requirement | repo_evidence | safety_invariant | missing_authority`；`missing_authority` 转 blocked/human；
3. PASS coverage：逐项核对规格/需求并附证据密度；
4. [未验证假设] 收益递减；[拟议验收目标] 同 reviewer refine/review 最多 1-2 轮，分歧转仲裁；
5. 可验证维度由测试/lint/spec check 提供客观锚点。

当前 `plan-reviewer.md` v1 尚未包含全部 V2 字段；这是 D 的拟议实现，不得在 E 中写成已实现能力。

### 10.3 对 E 的影响

- task patch critique 使用 `prompts/agents/reviewer.md`，不输出 plan-review anti-anchoring schema。
- 完整 plan review 走 workflow + D；E 不实现 task adapter、N-reviewer 或第二评审引擎。
- stage-model-routing arm只验证既有 agent 选择与 route receipt；不以 §10.1.5 的 PASS 早假设为依据。

## 11. 实施与推广顺序

1. 永久修复无条件 “Default to parallel” 冲突。
2. 添加三个独立 settings/prompt flags，默认 false；补 prompt 与 plan-mode policy 测试。
3. 接入现有 task lifecycle 的 A/B interval/cost/route receipt；不新增 scheduler。
4. 逐 arm 做 pilot ≥30 对；通过后做 ≥100 对或预注册 CI。
5. 分别推广通过的 guidance flags；arm 1 通过后才翻 `task.eager` schema 默认。
6. smoke、A/B 与质量停止条件均通过后再写 release note。

改动 owner：`config/settings-schema.ts`、`sdk.ts`、`system-prompt.ts`、`prompts/system/system-prompt.md`、相关 tests；若 interval 起止尚未持久化，仅扩展 `task/executor.ts`/`task/types.ts` 现有 lifecycle/result。无 bundled agent 接线、无新 planner、无 workflow prompt/code 改动、无第二编排引擎。

## 12. Round 1 Blocking/Major 闭合核验

### Blocking 1-5

1. **canonical workflow owner** — **闭合**：§4 D4 限定 task 只做 scoped slices/read-only；完整门禁走 workflow；禁止 task plan-review adapter/第二状态机。
2. **plan/code reviewer 分离** — **闭合**：§4 D5；plan→`prompts/workflow/plan-reviewer.md`，task patch critique/code→`prompts/agents/reviewer.md`；当前 V1 与 D 拟议 V2 已区分。
3. **system-prompt 冲突与并行门槛** — **闭合**：§4 D3/§6.2；无条件行永久移入 eager+autoParallel gate；只有 ≥2 独立 runnable slices 才默认 batch；单 planner/worker/reviewer 等待被禁止。
4. **模型路由** — **闭合**：§4 D6/§5；保留 `@task` 与 task fallback owner；不新增 planner；reviewer 仓库定义保持 Sol→Opus→`@task`，并明确本机 override 的优先级。
5. **A/B、双账本与停止条件** — **闭合**：§8 四 arm 正确为 eager flip/auto-parallel copy/pipeline guidance/stage model routing；配对随机化、non-overlap、interval union+legacy sum、成本总量、独立 rollback、>2pp/>10%/P0-P1 stop 均已定义。

### Major

1. **§2 baseline 标签与事实** — **闭合**：explicit/default-derived 分离；纠正 `task.batch`、threshold、idle 默认；task 非每会话常驻，递归限制与 plan-mode read-only owner 均有源码证据。
2. **planner 必要性/占位符** — **闭合**：明确不新增 planner，无 thinking-level 或 manifest 占位符。
3. **agent 覆盖与 spawn policy** — **闭合**：project/user 优先、reviewer spawn 限制与 spawn-one gate均保留；stage arm冻结 agent source/hash。
4. **plan mode** — **闭合**：共享 prompt 不渲染正向 implementation 示例；structured-subagent 强制只读，测试合同已列。
5. **fallback/family 规则** — **闭合**：普通 task resolver/executor 与 workflow model-router 分开；不虚构 degraded receipt；D family-aware 规则只属 plan review。
6. **评审 output schema** — **闭合**：E 的 code reviewer 保持 patch schema；D 的 anti-anchoring/V2 是 workflow 专属拟议合同。
7. **`task.maxEffort`** — **闭合**：明确只 clamp 显式 `effort`，frontmatter xhigh 不受影响。
8. **测试枚举** — **闭合**：六个现有 eager 文件完整列出，另加 plan-mode policy test。
9. **文献标签** — **闭合**：MoA 65.1/57.5、GSM8K +17.9、Self-Refine约 +20% 均标 `[文献]`；1-2 轮分别标 `[未验证假设]`/`[拟议验收目标]`；不可复现 Yang 引用已降级。
10. **风险编号** — **闭合**：R1-R9 顺序连续；`task/agents.ts` 与 `task/prompt-policy.ts:7` 路径正确。

## 13. 跨文档契约一致性

1. plan_review 一律采用 D 的“单强评审 + 同评审复审 + 分歧仲裁”；E 不提出 N-reviewer/any-block。
2. E 的 reviewer 落点分离：plan→`prompts/workflow/plan-reviewer.md`；task patch/code critique→`prompts/agents/reviewer.md`。
3. 配置 receipt 固定 `reviewed_at=2026-08-04` 与 config sha256，逐项区分 [当前本机 effective]/[当前 schema 默认]。
4. E 不涉及 TTFT 19.87h、eval 23.04s、Flash 4s 等 A/B 文档算术，不重复或改写这些数值。
5. 并发 owner 只使用现有 task lifecycle/batch；不虚构 `task-batch.ts`、`session/tool-output-processor.ts`、`fresh` 或 `performance.contextVolume.truncation.*`。
6. 设计推断使用 `[推导]`、`[未验证假设]`、`[拟议验收目标]`；`[文献]` 与 `[当前…]` 是来源限定，不把推断伪装成历史/current capability。
7. A/B 每 arm 独立 switch/snapshot/rollback；control/treatment 不重叠，interval union 不双算，成本按完整子树总量相加。
8. scope 维持 design-only；本文只修设计文档，未改代码、配置或其他文档。

## Reviewed Inputs manifest（sha256）

以下均为 reviewer 实际读取的完整文件；无 selector 占位符：

```text
docs/superpowers/plans/2026-08-04-latency-delegation-docs-collective-subagent-review.md	d07eeeba8319d5094c0b3b75f1a35ecf9e0f27665450f2e382daf1efa0a4bea9
docs/superpowers/specs/2026-08-04-plan-review-pipeline-design.md	91504fac740d8b1b37df43333fbb64f0733bb128652555f3df98323909fd900e
packages/coding-agent/src/prompts/system/system-prompt.md	cf2e0c89b79f28468774fadff9eea7564b38e499215a10e9ea911670f7efac76
packages/coding-agent/src/prompts/system/plan-mode-active.md	364b1401dfa02d33c9a733238b6315252025696210e12ac3b8f317028295c92e
packages/coding-agent/src/prompts/agents/reviewer.md	ba152ff2ae1325b768fb9ed45d03e85542b7f66d40acca81b102c15f64a6f79b
packages/coding-agent/src/prompts/workflow/plan-reviewer.md	69e46b1fdedeb1a681205f943c861500b84c855b05097cfbfa41794d8914b4e5
packages/coding-agent/src/prompts/tools/workflow.md	2064652381b53ddbd47c358ecc8a0d61acfbc44e983828c1d18f97c8f35da2bd
packages/coding-agent/src/task/agents.ts	1b7e925e19b34fbe779e2222d9536de609cfb4afeabbbf60dd425a3ff3a9fcb8
packages/coding-agent/src/task/discovery.ts	4dab64e5c2b1f5756de584de5f12499189e03929baa485134fb43540994facf3
packages/coding-agent/src/task/structured-subagent.ts	41a1c7cf26501dfa4c90567bbddf9f42126ad87d051a4ed06bc921dfaaf2cdbf
packages/coding-agent/src/task/executor.ts	3ff079a59d6f502597c13728b0b076acf7cc33240de7937416ce6b0cd1df7961
packages/coding-agent/src/task/types.ts	828f330c9fe7508c490daf4c31cb52a49c9c87ff87218b2f77641198314d3af0
packages/coding-agent/src/tools/index.ts	cc25d2ac316bb27eb7ba9062e4d17991a64650b080b5451ea47b3a1a7dccfe44
packages/coding-agent/src/config/settings-schema.ts	eece9ec0fce4d4509a54b822e00ea2d4cdada7b50822f2b1eca45873cd35c382
packages/coding-agent/src/config/model-resolver.ts	4a0a88e284256b3b7329ebc4d2ecefbbaba4945a05fdcd4ebc1baa3385f64f07
packages/coding-agent/src/system-prompt.ts	2f52cabad6b5b36286fff0841e96acbb72643715bb07f1575b4a6d46d5b24e85
packages/coding-agent/src/sdk.ts	8165d78ef189e855ec099ddab7880bf2a6728e7a865b78abd4119c69fd335bef
packages/coding-agent/test/task/structured-subagent.test.ts	c488a99ffeeaf5eed4cfb1a6aa802b76ef354f8e5908a69f18541982eb04fa08
/Users/sheng/.omp/agent/config.yml	1eb09e44cb35d1a2ad0dda2162c0e711d044e039e9e4c18fba9b070c756bd5f1
```
