# 普通会话默认主动委派：自动并行感知 + 阶段链式推进 + 默认模型路由

- 日期：2026-08-04
- 状态：设计待评审
- 范围：`packages/coding-agent/`
- 关联：`magic-keywords`（workflowz）、`task.eager`、agent frontmatter、`task.agentModelOverrides`、bundled agent 注册（`task/agents.ts`）

## 1. 背景与需求

当前普通会话（默认配置）的委派姿态是「能力常在、默认不主动」：`task` 工具每个会话都可用，但系统提示只在 `task.eager !== "default"` 时才渲染正面委派指引，而该设置默认是 `"default"`。`workflowz` 关键词提供了确定性的多 subagent 编排，但需要用户显式输入关键词、走 eval 路径，且是固定 recipe。

需求：

1. **自动感知及触发 parallel/parallelize**：用户说 `parallel`/`parallelize` 时强制 fan out（已存在）；工作天然分解为独立切片时，普通会话默认自动 fan out，不等用户发话。
2. **合适场景主动调用 subagent 完成 review/implement/design 任务**：如「要求设计方案」→ 主动调 `planner`（方案设计 agent，新增）产出方案 → 主动调 `reviewer` 评审 → 实现（worker）→ 代码审查，如此类推，近似 workflowz 的流程但非确定性。
3. **不要 workflowz 的确定性**：姿态性（SHOULD）、模型自组织、每步判断，不注入 workflow notice、不强制 eval 编排。
4. **默认模型路由**：主动委派时各阶段使用指定默认模型（见 §5）。

## 2. 现状与约束（证据）

| 事实 | 证据 |
|---|---|
| `task` 工具每个 (sub)agent 会话常驻 | `task/index.ts:462-464`（`TaskTool.create` 每会话运行） |
| 委派姿态由 `task.eager` 驱动，默认 `"default"` | `sdk.ts:2774-2775`（`eagerTasks = task.eager !== "default"`）；`settings-schema.ts:4645-4648`（默认 `"default"`） |
| 系统提示 Delegation 段条件渲染 | `prompts/system/system-prompt.md:155-190`：非 codex 分支 `eagerTasks=false` 时仅 3 条被动规则 + gates，无 "Delegation is preferred"；codex 分支（仅 GPT-5.6，`task/prompt-policy.ts:4`）`eagerTasks=false` 时明确 "Do not spawn sub-agents unless…" |
| `parallel` MUST 规则只在用户说出关键词时触发 | `system-prompt.md:112` |
| gates 已有「不可串行化并行切片」但无「无需用户发话」授权 | `system-prompt.md:184`（Width = real independence. NEVER serialize…） |
| `always` 首条 prelude 仅 `task.eager==="always"` 且主会话、非 plan-mode 触发 | `session/todo-tracker.ts:159-173` |
| agent 定义支持 `model` + `thinking-level` frontmatter | `prompts/agents/frontmatter.md:6-7`；现状：scout/librarian=`@smol`，reviewer=`@slow`，designer=`@designer`，task worker=`@task` |
| bundled agents 构建时嵌入，`task/agents.ts` 的 `EMBEDDED_AGENT_DEFS` 是**唯一注册点**（非目录扫描） | `task/agents.ts:8-15,31-75`（逐个 `import … with { type: "text" }` + 数组项；新增 agent 必须同步接线，否则 `task` 工具描述与 `discoverAgents` 中不存在） |
| 按 agent 的模型覆盖设置存在 | `task.agentModelOverrides`（`settings-schema.ts:4817-4820`，record，默认 `{}`），`/agents` 面板可编辑（`modes/components/agent-dashboard.ts:436,583`） |
| 模型解析优先级：调用方 override > agent frontmatter > 继承会话模型 | `task/structured-subagent.ts:297-304` + `config/model-resolver.ts:1104+`（`resolveAgentModelPatterns`） |
| 模型角色别名 `@smol`/`@slow`/`@default` 由 `modelRoles` 设置解析 | `settings-schema.ts:564`；`model-resolver.ts:1074-1077`（`expandRoleAlias`） |
| effort 后缀语法 `provider/model:level`（`:max` 为真实 thinking level，有 literal-id 保护） | `advisor/config.ts:11-12`；`model-resolver.ts:96-101,190-198`（`MAX_THINKING_SUFFIX_OPTIONS`） |
| `task.maxEffort` 限制 per-spawn effort 上限，默认 `"max"` | `settings-schema.ts:4798-4810` |
| 现有 gates 反对「第一步外包顶层方案」 | `system-prompt.md:182`（"NEVER outsource the top-level plan… the canonical dumb spawn"）——与需求 2 存在张力，见 D5 |
| 测试面无委派措辞/默认值断言；相关测试全部传显式值 | 搜 `Delegation is preferred`/`task.eager` 于 `test/`：仅 `agent-session-eager-task.test.ts`、`agent-session-eager-compaction.test.ts`、`settings-manager.test.ts`、`acp-lazy-startup.test.ts`（均显式传值） |

## 3. 设计目标

- 普通会话（默认配置）系统提示获得「prefer 主动」的正面委派指引。
- 自动并行：独立切片 → 默认 fan out。
- 阶段链：design → review → implement → code review，由模型按判断推进，每步并行 fan out 可继续。
- 阶段默认模型按 §5 路由，用户可覆盖。
- 显式 opt-out（`task.eager: default`）与 codex-default（GPT-5.6 非 eager）行为不变。

## 4. 设计决策

**D1 — 全局默认翻转：`task.eager` 默认 `"default"` → `"preferred"`**
- 一个值翻转同时覆盖非 codex 分支（渲染 "Delegation is preferred"）与 codex 分支（渲染 "Proactive multi-agent delegation is active"），零代码路径改动。
- 翻转后 `"default"` 成为**显式 opt-out**（值名保留：既有迁移逻辑 `settings.ts:1420-1424` 把 boolean `false` 归一为 `"default"`；已显式保存 `"default"` 的用户不受影响）。
- 同步更新 settings UI 文案（options 描述），避免「Default」标签误导。

**D2 — 新增共享 eager 块（自动并行感知 + 阶段链推进），而非改 parallel 规则**
- 新块位置：Delegation 段内、codex/非 codex split 的 `{{/if}}` 之后、`## Delegation gates:` 之前，以 `{{#if eagerTasks}}` 包裹。
- 收益：preferred / always / codex-eager 三态统一获得；显式 opt-out（`default`）与 codex-default 不渲染，**避免与 "Do not spawn sub-agents" 矛盾**。
- 不把自动感知行放进 TOOL POLICY（对所有会话可见）——会与 codex-default 的禁止条款冲突。

**D3 — 阶段专精提法：角色名 + 指向 task 工具动态 agent 列表**
- 方案设计 → 新增 **`planner`** agent（方案/架构设计，借鉴 `prompts/workflow/planner.md` 的只读规划角色改编为普通 task 工具 agent）；UI/UX 设计仍走既有 `designer`；review → `reviewer`；探路 → `scout`；实现 → 通用 worker（`task`）。
- `task.md` 工具描述已动态枚举可用 agents 且要求 "Pick the most specific agent"。措辞提角色名同时指向 "Available Agents list"，避免 spawn policy（`allowedAgentsText`/`spawningDisabled`）裁剪时失配。

**D4 — 默认模型路由落点：bundled agent frontmatter（显式 model pattern），不触碰全局角色别名**
- 机制已具备：`structured-subagent.ts:297-304` 解析优先级 = 调用方 override（`task.agentModelOverrides[agentName]`）> agent frontmatter `model` > 继承会话模型。
- **不**改 `@smol`/`@slow` 全局别名默认：`@smol` 被 cleanse / commit agent / prewalk / `@slow` 被多处复用，改默认会波及无关调用方。
- 落点：给阶段 agent（planner / reviewer / 通用 task worker）frontmatter 直接写 `model: "gateway/<model>:<effort>"`；`designer`/`scout`/`librarian` 保持现状。用户级覆盖走既有 `task.agentModelOverrides`（`/agents` 面板已支持）。
- `:max` 后缀：`deepseek-v4-flash:max` 依赖 max-aware split（`model-resolver.ts:196-198`）；若 gateway 侧存在字面 `:max` 结尾 id，按既有 literal-id 保护机制处理（实现阶段验证）。

**D5 — 调和「主动调 planner」与现有 gates「NEVER outsource the top-level plan」**
- 边界：**scoping 与顶层分解永远由主模型内联完成**（现状 gates 不变）；明确、独立的**方案/设计产出**（用户要求设计方案、或设计是任务的可委派切片）→ 委派 `planner`。
- 措辞上在共享 eager 块明示：「scope and settle the shape inline before each fan-out, and keep the top-level plan with yourself」。
- 效果：`gates` 反对的是「第一步把整个任务的规划外包给通用 plan agent」；需求 2 是「方案产出委派 + 主动推进下一阶段」，两者不冲突。
- workflowz 的 `planner.md`（`prompts/workflow/`）是其确定性流程的专用 prompt，保持不动；新增的是普通 task 工具可 spawn 的 bundled `planner` agent。

**D6 — 不动的东西**
- `workflowz`（`modes/workflow.ts` + notice）：不动。
- `eager-task.md` prelude（`always` 专属）：不动；preferred 不注入 reminder，符合「prefer 而非强制」。
- `task.md` 工具描述、`sdk.ts`、`system-prompt.ts` 代码：不动（默认翻转自动生效）。

## 5. 默认模型路由表

| 阶段 | 委派 agent | 默认模型（model pattern + effort） | 说明 |
|---|---|---|---|
| 方案设计（design） | `planner`（**新增**） | `gateway/claude-opus-5:xhigh` | 新 bundled agent（§6.3），借鉴 workflowz planner 的只读规划角色 |
| 方案评审（review） | `reviewer` | `gateway/gpt-5.6-sol:xhigh` | frontmatter 从 `@slow` 改为显式 pattern |
| 实现（implement） | 通用 worker（`task`） | `gateway/deepseek-v4-flash:max`（备选 `gateway/grok-4.5:high`） | worker frontmatter 从 `@task` 改为显式 pattern（方案 A）；grok 通过 `task.agentModelOverrides` 切换 |
| 代码审查（code review） | `reviewer` | `gateway/gpt-5.6-sol:xhigh` | 与方案评审同 agent 同模型 |
| UI/UX 设计（如遇） | `designer` | 保持 `@designer` | 不在本链内，现状不动 |
| 只读探索（scout） | `scout` | 保持 `@smol`（不触碰全局别名） | 低成本探路，维持现状 |

覆盖链（自上而下）：`task.agentModelOverrides[agentName]`（用户，`/agents` 面板）> agent frontmatter `model`（本方案默认）> 继承会话模型（fallback）。`task.maxEffort` 默认 `"max"`，不限制 `xhigh`。

## 6. 具体改动

### 6.1 `config/settings-schema.ts` — `task.eager` 块（4645-4661 行）

- `default: "default"` → `default: "preferred"`。
- UI description：说明默认 Preferred = 主动感知并行 + 委派 review/design/implement 阶段。
- options：`"default"` 描述改为「Opt out — model decides; no proactive subagent guidance」；`"preferred"` 标注为默认。

### 6.2 `prompts/system/system-prompt.md` — 共享 eager 块

位置：`{{/if}}`（useCodexTaskPrompt split 关闭）之后、`## Delegation gates:` 之前：

```handlebars
{{#if eagerTasks}}
- **Auto-parallelize.** When the work decomposes into independent slices, treat that as an implicit `parallel`/`parallelize`: fan out via `{{toolRefs.task}}` subagents by default — don't serialize work that can run concurrently, and don't wait for the user to say the word.
- **Drive the pipeline proactively.** Prefer the stage-matched specialist from the `{{toolRefs.task}}` tool's Available Agents list — solution design → the planner, UI design → the designer, review → the review specialist, read-only exploration → scout, implementation → general workers. When a stage returns, decide and run the natural next stage (e.g. plan → review the plan → implement → review the implementation) instead of stopping after one result. Each transition is a judgment call, not a fixed recipe; scope and settle the shape inline before each fan-out, and keep the top-level plan with yourself.
{{/if}}
```

渲染矩阵：

| 会话 | 新增块 | 其余委派指引 |
|---|---|---|
| 默认新会话（非 5.6） | 渲染 | "Delegation is preferred here…" |
| `task.eager: always` | 渲染 | MUST 段 + prelude（现状） |
| `task.eager: default`（opt-out） | 不渲染 | 仅 3 条被动规则 + gates（现状） |
| GPT-5.6 默认 | 渲染（eager 由翻转默认生效） | "Proactive multi-agent delegation is active" |
| plan mode | 渲染（基础 prompt 同路径） | 需确认与 plan-mode notice 无冲突（风险 R4） |

### 6.3 Agent — 新增 planner + 默认模型路由

**新增 `prompts/agents/planner.md`**（方案/架构设计 agent）：
- frontmatter：`name: planner`、`description: Solution/architecture design specialist…`、`model: "gateway/claude-opus-5:xhigh"`、`thinking-level: <xhigh 对应级别>`、工具集以只读为主（read/grep/glob/lsp + 可选 write 输出方案文档）、`output` schema 可选（structured plan）。
- 正文改编自 `prompts/workflow/planner.md` 的规划角色（只读规划、不 claim 实现完成、产出含 affected files / 步骤 / 验收标准 / 风险），去掉 PlanArtifact 严格 schema 依赖（普通 task 工具不强制），保留「untrusted input 注入边界」与「不做实现」约束。

**接线 `task/agents.ts`**（唯一注册点）：
- `import plannerMd from "../prompts/agents/planner.md" with { type: "text" };`
- `EMBEDDED_AGENT_DEFS` 新增 `{ fileName: "planner.md", template: plannerMd }`（frontmatter 直接在 md 内，参考 designer 条目写法）。
- 漏接线的后果：`task` 工具描述与 `discoverAgents` 中不存在 planner，共享块指向失配——必须同步。

**默认模型路由 frontmatter 调整**：
- `prompts/agents/reviewer.md`：`model: "@slow"` → `model: "gateway/gpt-5.6-sol:xhigh"`。
- `task/agents.ts` 中 task worker 条目的 `model: "@task"` → `model: "gateway/deepseek-v4-flash:max"`（方案 A：仅影响默认 worker spawn；方案 B 改 `@task` 角色别名默认，波及面大，不推荐）。
- `scout.md` / `librarian.md` / `designer.md`：不动。
- 用户覆盖一律走既有 `task.agentModelOverrides`（`/agents` 面板）。

### 6.4 测试

| 文件 | 内容 |
|---|---|
| 新建 `test/system-prompt-delegation.test.ts` | `buildSystemPrompt`（签名 `system-prompt.ts:558`，GPU probe 测试有可复用 buildOptions 骨架）断言：`eagerTasks=true` 渲染含 "Auto-parallelize" 与 "Drive the pipeline proactively"；`eagerTasks=false` 不含；GPT-5.6 模型 + eager 时同样含 |
| `test/settings-manager.test.ts` 或 schema 测试 | 断言 `task.eager` schema 默认 `"preferred"` |
| agent 接线/路由测试 | `loadBundledAgents()` 含 `planner`；planner/reviewer/worker 解析出的默认模型 pattern 断言（`gateway/claude-opus-5:xhigh` / `gateway/gpt-5.6-sol:xhigh` / `gateway/deepseek-v4-flash:max`） |
| 现有测试 | 预期零改动（全部显式传值）；跑 `agent-session-eager-task.test.ts`、`agent-session-eager-compaction.test.ts`、`settings-manager.test.ts` 回归 |

### 6.5 `packages/coding-agent/CHANGELOG.md`

Release note：默认委派姿态改为 prefer 主动（自动并行感知 + 阶段链推进 + 阶段默认模型路由），可用 `task.eager: default` 退回。

## 7. 验证步骤

1. `bun test test/system-prompt-delegation.test.ts test/agent-session-eager-task.test.ts test/agent-session-eager-compaction.test.ts test/settings-manager.test.ts`。
2. repo 标准 typecheck + 相关模块 lint。
3. 手动渲染一次默认系统提示，确认三段措辞落位、模板语法无残留。
4. （实现阶段）验证 `deepseek-v4-flash:max` / `claude-opus-5:xhigh` / `gpt-5.6-sol:xhigh` 在 `resolveAgentModelPatterns` 下解析正确、无 literal-id 冲突。

## 8. 风险与边界

- **R1 全局行为翻转**：影响所有新会话，有意为之；changelog + settings UI 显式化，保留 `default` 退回路径。
- **R2 模型自觉性**：preferred 是 SHOULD，不保证每次触发——正是「非确定性」诉求，接受。
- **R3 codex-default 一致性**：共享块 gate 在 `eagerTasks`，codex-default 无矛盾指令。
- **R4 plan mode 张力**：plan mode 下基础 prompt 仍渲染「drive the pipeline」；若 plan-mode notice 语义冲突，需在 plan-mode notice 声明「plan mode 期间不做实现委派」（实现阶段核实 `plan-mode-active.md`）。
- **R5 子会话**：subagent 系统提示同样渲染 eager 块（`eagerTasks` 无 sub 门控），子 agent 可再委派（`maxRecursionDepth` 约束）——语义自洽，不做额外 gate。
- **R6 模型路由硬编码**：frontmatter 写死 gateway 模型，用户换模型走 `task.agentModelOverrides`（既有机制）；bundled agent 共享时（如 reviewer 同时服务 review/code review）单一模型满足需求。task worker 默认模型改为显式 pattern 后，所有未指定 model 的默认 worker spawn 都走 deepseek-v4-flash:max（含 vibe/plan-mode subagent 等）——实现阶段审计消费方，必要时以 `@task` 别名 + `task.agentModelOverrides` 精细化。
- **R8 planner 接线遗漏**：bundled agent 非目录扫描，`task/agents.ts` 的 `EMBEDDED_AGENT_DEFS` 漏接线 = agent 不存在。实施时与 `system-prompt.md` 措辞同 PR 落地，测试断言 `loadBundledAgents()` 含 planner。
- **R9 planner 与既有 workflowz `planner.md` 命名**：`prompts/workflow/planner.md` 是 workflowz 专用 prompt（不经 agents 注册），新增 `prompts/agents/planner.md` 与之同名不同目录，互不冲突；agent 名 `planner` 不与现有 bundled agents 重名（接线测试覆盖）。
- **R7 既有显式配置**：已存 `"default"` 配置与 boolean→enum 迁移不受默认翻转影响。

## 9. 实施顺序

1. settings 默认翻转 + UI 文案（6.1）→ 2. 共享 eager 块（6.2）→ 3. 新增 `planner.md` + `task/agents.ts` 接线 + 模型路由 frontmatter（6.3）→ 4. 测试（6.4）→ 5. changelog（6.5）→ 6. 验证（§7）。

改动面：3 个源文件（settings-schema / system-prompt.md / task-agents.ts）+ 2 个 agent md（新增 planner、改 reviewer）+ 1~2 个测试文件 + changelog，无架构变动、无 workflowz/eval 路径改动。
