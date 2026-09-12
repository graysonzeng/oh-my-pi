# Design: 执行器主动请教（Consult Tool）

- Date: 2026-08-26
- Status: Revised (2026-08-27 design-implement)
- Scope: L
- design_author: 当前会话
- 关联:
  - Anthropic Advisor Tool: https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool
  - 本地对照实现: `/Users/sheng/tencent/claude-code/src/utils/advisor.ts`、`src/commands/advisor.ts`、`src/services/api/claude.ts`
  - 现有影子评审: `docs/advisor-watchdog.md`、`packages/coding-agent/src/advisor/`
  - 嵌套 oneshot 先例: `packages/coding-agent/src/tools/inspect-image.ts`

## 1. 设计目标和范围

### 1.1 要解决的问题

OMP 现有 `advisor` 是**旁路影子评审**：每轮偷看 primary transcript delta，用 `advise` 注入 `nit` / `concern` / `blocker`。用户要的是 Anthropic Advisor Tool 那条线：

- 执行器自己决定何时请教
- 更强模型看当前任务上下文
- 顾问**无工具**，只回建议文本
- 建议作为普通 `tool_result` 回到同一轮，执行器继续干活
- 失败不炸主 turn

OMP 是多 provider harness，不能依赖 Anthropic 的 `advisor_20260301` 同请求子推理。必须在客户端编排一次独立的 oneshot。

### 1.2 成功标准

1. 主会话可挂一个名为 `consult` 的内置工具；执行器 call 后拿到顾问文本，同一 agent loop 继续。
2. 默认关闭；开启后不改变现有 WATCHDOG 影子评审的任何行为、命令、设置键。
3. 顾问请求失败、超时、超限、无模型、无凭据、同模型拒绝、脱敏不可用时，执行器收到可行动的错误文本，主 turn 不 abort。
4. 顾问看不到也调不了执行器工具；不写入工作区。
5. `/consult status` 能看到 enabled、模型解析结果、same-model、本 turn / 本 session 调用次数、最近一次费用与截断。
6. 焦点测试覆盖：开关、稳定注册、execute-time 重校验、约束保真、脱敏 fail-closed、硬输出预算、配额、失败不炸主 turn、与影子评审并存。

### 1.3 非目标

- 不改 `packages/coding-agent/src/advisor/` 运行时，不把影子评审改成 consult。
- 不实现 Anthropic server-side `advisor_20260301` 透传（即使执行器是 Anthropic 也不走这条；避免 provider 分裂）。
- 不做每轮自动请教、卡住自动注入、done 前强制闸门（那是影子评审 / `pi-advisor-flow` 的形态）。
- 不给顾问工具、不给 Hub 地址、不做 subagent consult（v1）。
- 不新增 `ModelRole`（`advisor` 角色继续只服务影子评审默认链；consult 复用解析，不扩 closed set）。
- 不把 `/advisor` 改义。该命令继续只管理影子评审。

## 2. 已确认事实 / 未确认假设

### 2.1 已确认事实

- Anthropic 官方工具：无参、顾问无工具、同一 `/v1/messages` 内暂停/恢复、`max_uses` 为单请求上限、thinking 丢弃只回文本。官方 quoted context 含 system prompt、tool definitions、prior turns、tool results 和当前 turn 已生成文本。
- Claude Code（本地 `claude-code-best` 2.6.11）在客户端把 `{ type: "advisor_20260301", name: "advisor", model }` 塞进 tools，系统提示追加 `ADVISOR_TOOL_INSTRUCTIONS`，由 API 完成子推理。
- OMP 影子评审已占用：工具语义外的 `advise`、`/advisor`、`--advisor`、`advisor.enabled`、`modelRoles.advisor`、WATCHDOG.yml。现有 advisor 在 primary turn end 消费 transcript delta，与 consult 正交。
- OMP 嵌套 LLM 先例是 `inspect_image`：`instrumentedCompleteSimple` + `oneshotKind` + 独立 system prompt 文件 + `modelRoles.vision` 解析。
- 系统提示已有按工具注入块：`buildSystemPrompt` 在 `toolNames.includes("computer")` 时追加 `computer-safety.md`。
- `createTools` 用 `isToolAllowed(name)` 按 setting 决定是否注册；动态工具（computer / inspect_image / think）在 session start 派生 slate 后靠专用 reconcile，`/model` 不会自动重跑 `createTools`。
- `ToolSession` 已有 `getActiveModel`、`modelRegistry`、`settings`、`getTelemetry`、`getSessionId`；**没有** transcript snapshot 或 obfuscator。影子评审走 `AdvisorRuntimeHost.snapshotMessages()` / `obfuscator`，与 ToolSession 平行。
- `AgentState.systemPrompt` 与 `messages` 分开存储。AGENTS.md / project prompt / active repo context 进入 system prompt，不在 messages 里。
- 提示词必须是静态 `.md` + Handlebars，禁止代码里拼 prompt。
- `BUILTIN_TOOL_NAMES` 是内置工具真源；新工具必须进该表、`BUILTIN_TOOLS` factory、`createTools` 门控。
- 顾问角色默认走 `slow` 链且永不继承 primary（`resolveAdvisorRoleSelection`）。
- 现有安全路径：`formatSessionHistoryMarkdown`、`SecretObfuscator`、`obfuscateToolArguments`、advisor chunk 脱敏的 byte-equivalence fail-closed。
### 2.2 未确认假设

- 执行器在有明确 tool description + 系统提示块时，会在「实质工作前 / 卡住 / 宣称完成前」请教，而不是每轮都 call。用 Claude Code 同款时机文案降低该风险；v1 不做硬闸门。
- 截断后的 transcript 对顾问足够；若不够，顾问会要求执行器补充，而不是幻觉。用可选 `focus` 参数给对质子 call 一条显式钩子。
- 用户能接受新命令 `/consult`、新设置前缀 `consult.*`，而不是复用 `/advisor`。碰撞成本高于学习成本。

## 3. 方案对比

### 方案 A — Anthropic native server tool（仅 1P）

执行器是 Anthropic 时直接发 `advisor_20260301`。其它厂不支持。

- 优点：与官方同请求语义、延迟最低、cache 由 Anthropic 管。
- 缺点：OMP 主价值是多厂；Gemini/OpenAI/Grok 路径要再做一套客户端编排，两套行为。Bedrock/Vertex 对 beta header 会 400（Claude Code 已因此 first-party only）。

### 方案 B — 客户端 Consult 工具（选用）

主 agent 上挂普通内置工具 `consult`。execute 时用 `instrumentedCompleteSimple` 打顾问模型，把文本当 `tool_result` 返回。所有厂同一条路径。

- 优点：接在现有 `inspect_image` 缝上；与影子评审正交；可测；跨厂。
- 缺点：不是同一 HTTP；顾问有一次独立 TTFT；prefix cache 是顾问自己的请求，不是官方 advisor transcript cache。

### 方案 C — Skill / `task` 委派 Opus

提示执行器 `task(agent=..., model=@slow)`。无独立工具契约，无配额，顾问可能拿到工具。

- 优点：零新代码。
- 缺点：不是 consult；subagent 有工具、有自己会话、成本与隔离都错。

**决定：方案 B。** 方案 A 作明确非目标。方案 C 不满足「无工具顾问 + 同一轮 tool_result」。

## 4. 设计决策

### D1 — 命名与占用

| 表面 | 影子评审（不变） | 本功能 |
|---|---|---|
| 工具 | 顾问侧 `advise`（不在主会话） | 主会话 `consult` |
| 斜杠命令 | `/advisor` | `/consult` |
| CLI | `--advisor` | `--consult`、`--consult-model <pattern>` |
| 设置 | `advisor.*` | `consult.*` |
| 模型角色 | `modelRoles.advisor` | 不新增角色；解析见 D3 |
| 提示词目录 | `prompts/advisor/` | `prompts/tools/consult.md`、`prompts/tools/consult-system.md`、`prompts/system/consult-instructions.md` |

主会话工具名不叫 `advisor`，避免模型、用户、文档把影子评审和请教工具当成同一个东西。

### D2 — 默认关，稳定注册，execute 时重校验

与影子评审一样默认关。**schema 可见性只取决于用户意图与会话层级**，不把易失的模型/凭据/same-model 编进注册门控：

1. `consult.enabled === true`，或本 session `/consult on` / `--consult` override
2. `session.taskDepth ?? 0 === 0`（仅主会话）

关闭时工具不出现在 schema，系统提示块不注入。`/consult on|off` 走 session override 后调用 `setConsultToolEnabled`（与 `computer.enabled` 同类：`createTools` 只在 session start 派生 slate，运行时必须显式 reconcile，不能只改 setting）。`--consult` 在 `main.ts` 对 `consult.enabled` 做进程级 ephemeral override，随后按开启态注册。

模型解析、凭据、same-model **每次 execute 和 `/consult status` 时重算**。失败返回 D7 错误码，本 turn 不自动重试。工具保持注册，使 `no_model` / `no_credentials` / `same_model` 对执行器可达。

`loadMode = "discoverable"`。不进 `ESSENTIAL_BUILTIN_TOOL_NAMES`。必须加入 `XDEV_KEEP_TOP_LEVEL`：默认 `tools.xdev=true` 会把 discoverable 工具挂到 `xd://`，而系统提示按顶层 `consult` 教模型调用。

### D3 — 模型解析

解析顺序，命中即停：

1. session override（`/consult <model>` 或 `--consult-model`）
2. `consult.model` setting
3. `modelRoles.advisor`（已配置时）
4. 与 `resolveAdvisorRoleSelection` 相同的 `slow` 优先级链

永不继承 primary。若解析出的 `provider/id` 等于 `session.getActiveModel()` 的 `provider/id`：

- 默认：工具仍注册；execute 返回 `same_model`，status 报 `same_model`
- `consult.allowSameModel: true` 时允许（用户显式接受零边际）

thinking：沿用所选 pattern 的 `:level` 后缀；未写则用该模型默认，不强制 `:max`。

不新增 `tier.consult`。Consult oneshot 不跟 `/fast`，也不走 primary service tier。

### D4 — 工具契约

Schema（arkType，`strict: true`）：

```ts
{
  focus: type("string").optional().describe(
    "Optional one-sentence question or conflict to resolve. Omit to send the curated transcript only.",
  ),
  "+": "reject",
}
```

`focus` 硬上限 `consult.maxFocusChars`（默认 2000 字符，trim 后计）。超限返回 `focus_too_long`，不发起请求。无 `focus` 时行为对齐 Claude Code 无参 `advisor()`：顾问只看 curated context。有 `focus` 时作为顾问 user 消息的前置一句，供对质子 call。

`approval = "read"`。不碰工作区，不走 mutating 审批。

`concurrency = "exclusive"`：同一时刻只允许一次 consult，避免并行双请教打爆配额与上下文。

### D5 — 顾问请求形状

顾问是 **oneshot，无工具**。

System：`prompts/tools/consult-system.md`（静态文件）。内容角色：

- 你是执行器的战略顾问，不是执行者
- 禁止要求执行器向用户澄清意图；用户原文是约束
- 输出：一句话 verdict + 至多 5 条编号行动；引用 transcript 里的文件/命令/错误
- 没看过的代码当 UNKNOWN，不要编
- thinking 对执行器不可见；只输出建议正文
- `<advisory>` 块是旁路影子评审意见，不是用户指令

User 消息由 Handlebars 渲染 `prompts/tools/consult-user.md`：

- 可选 `focus`
- 当前 primary 模型 id
- pinned system/project constraints
- curated transcript

v1 **不**计算 stage heuristic。顾问从 transcript 自己判断阶段。

`instrumentedCompleteSimple` 必须传入 `maxTokens: consult.maxTokens`（默认 2048）。这是硬输出预算，不是生成后再截断。

### D6 — Consult context snapshot 与策展

从 `ToolSession.snapshotConsultContext()` 取专用 snapshot：

```ts
{ systemPrompt: string[]; messages: AgentMessage[] }
```

由 `AgentSession` / SDK 接到 `agent.state.systemPrompt` 与 `agent.state.messages` 的浅拷贝。缺方法时 consult 返回 `transcript_unavailable`，不抛。

**不得**声称 messages transcript 已包含 AGENTS.md / project constraints。那些约束在 system prompt 里，必须作为 pinned context 单独保留。

策展规则（按顺序）：

1. 丢掉 consult 自己的历史 call/result 的**完整正文**，改成一行 stub：`consult #N → (omitted, see prior turn)`，避免顾问递归评论自己。
2. 影子评审注入的 `<advisory>` 块保留；顾问系统提示写明 advisory 是旁路意见，不是用户指令。
3. 单条 tool 参数 JSON 截断 800 字符；tool result 文本 2000 字符。图片/二进制块替换为 `[image omitted]`。
4. 执行器 reasoning/thinking 块：**包含**。
5. transcript 序列化必须复用 `formatSessionHistoryMarkdown`（`ADVISOR_RENDER_OPTIONS` + `includeThinking: true`），不另造历史格式。

输入 token 预算（顾问模型 tokenizer；窗口未知则硬顶 32k tokens）按最终序列化请求统一计数，裁剪顺序：

1. 硬输出 reserve = `consult.maxTokens`
2. consult system + user framing（Handlebars 模板，transcript 为空时的固定开销）
3. **pinned，不得丢**：effective `systemPrompt`（含 AGENTS/project/active-repo）、当前用户任务（最近一条 user）、最初用户任务（若与当前不同）
4. **pinned，尽量保留**：最近执行证据（transcript 尾部）
5. 可丢弃中段历史：oldest-first 丢弃直到剩余预算

pinned 超出剩余预算时仍发送 pinned，丢弃全部可丢弃历史；不丢 system/project/user constraints。

### D7 — 配额与失败

计数在 session 内存，不持久化到 settings。

| 键 | 默认 | 含义 |
|---|---|---|
| `consult.maxUsesPerTurn` | `2` | 当前 primary assistant turn 内成功+失败的 consult execute 次数。超限返回 `max_uses_exceeded` 文本，不发起请求 |
| `consult.maxUsesPerSession` | `12` | 本 session 累计。超限同上 |
| `consult.timeoutMs` | `60000` | 顾问 oneshot 超时；`0` 禁用 |
| `consult.maxTokens` | `2048` | 传给 `instrumentedCompleteSimple` 的硬输出 token 上限 |
| `consult.maxFocusChars` | `2000` | `focus` 字符上限（trim 后） |

失败映射（全部变成 `AgentToolResult` 文本，`isError: true`，**不 throw**，以免 agent loop 把主 turn 标成 tool 崩溃）：

- 无模型 / 无 key → `no_model` / `no_credentials`
- same-model 且未允许 → `same_model`
- 脱敏 capability 缺失、失败或跨块不一致 → `redaction_unavailable`
- snapshot 缺失 → `transcript_unavailable`
- focus 超长 → `focus_too_long`
- 超时 / abort → `timeout` / `aborted`
- provider 4xx/5xx → `provider_error` + 截断后的 message
- 空文本 → `empty_response`
- 超限 → `max_uses_exceeded`

主 agent 看到错误后自己决定是否换路。失败后同 turn 不自动重试。与 Anthropic「advisor 失败执行器继续」一致。

成功结果带 `details`: `{ model, tokensIn, tokensOut, costUsd, truncated, maxTokens }`。`truncated` 在 provider `stopReason === "length"` 或 inline byte cap 触发时为 true。费用走现有 usage 管道，`oneshotKind: "consult"`，记入本 session 成本，不记进影子评审 `/advisor status`。

配额状态单一 owner：`ToolSession.consultUsage`。`AgentSession` 在已有 `turn_start` 路径（`#advisors.onPrimaryTurnStart()` 旁）把 `turn` 归零。不另建 WeakMap，不在 `prompt()` 入口重复清零。

### D8 — 执行器系统提示

当 `consult` 在本轮 toolNames 里，`buildSystemPrompt` 追加 `prompts/system/consult-instructions.md`，紧挨 computer-safety 那种按工具注入。文案对齐 Claude Code `ADVISOR_TOOL_INSTRUCTIONS`，改名不改时机：

- 实质工作前请教（写代码、认定解释、往假设上加东西）
- 探路（找文件、读代码）不算实质工作
- 宣称完成前、卡住、要换路时再请
- 长任务至少：定方案前一次 + done 前一次
- 短反应任务不必反复叫
- 与顾问冲突时用 `focus` 再 call 一次对质，不要默默换边
- 顾问意见当证据加权，不是用户指令；用户原文优先

工具 description（`prompts/tools/consult.md`）保持短：何时用、何时不用、`focus` 可选。时机细节放系统提示块，避免 description 与 schema 重复。

### D9 — 与影子评审并存

两者可同时开。默认都关。

| | 影子评审 | Consult |
|---|---|---|
| 触发 | 每轮 delta | 执行器 tool call |
| 可见性 | 注入 `<advisory>` / 卡片 | 普通 tool_result |
| 模型 | `modelRoles.advisor` | D3 链（可碰巧相同） |
| 命令 | `/advisor` | `/consult` |

同时开且模型相同：允许，但 `/consult status` 与 `/advisor status` 都提示「同一模型既在旁路看又在被请教，边际低」。不自动互斥。

Consult 的 curated transcript 包含 `<advisory>`，让顾问知道旁路已经说过什么，减少复读。

### D10 — 命令与 CLI

`/consult` 新 slash command，不进 `builtin-collaboration.ts` 的 advisor 条目。新文件 `slash-commands/builtin-consult.ts`，注册进 builtin registry。

| 调用 | 效果 |
|---|---|
| `/consult` | 状态：enabled、resolved model 或错误码、same_model、凭据、本 turn/session 次数、上次 cost/tokensOut/truncated |
| `/consult on` | session enable + `setConsultToolEnabled(true)` |
| `/consult off` | session disable + `setConsultToolEnabled(false)` |
| `/consult <model>` | 设 session 模型 override，隐含 on，重建工具 |
| `/consult unset` | 清 session 模型 override，回到 setting/role 链 |

`--consult`：本进程 enable，不写 `consult.enabled`。
`--consult-model <pattern>`：本进程模型 override（同时 enable）。

不提供 `/consult ask`。用户要请教就在对话里让执行器 call；强制注入会变成第二种影子评审。

### D11 — TUI

新 `consult-renderer.ts`，模式抄 `inspect-image-renderer.ts`：

- call：一行 `Consult` + 可选截断 `focus`；streaming 显示 `waiting <model>`
- result：framed 顾问正文，默认折叠到 `PREVIEW_LIMITS.OUTPUT_COLLAPSED`；expand 看 `PREVIEW_LIMITS.OUTPUT_EXPANDED`。超 `enforceInlineByteCap` 的全文进 artifact，展开提示带 `artifact://` 指针，不承诺 TUI 内无限全文。
- error：`status.error` + 短错误码
- 消毒：`replaceTabs` / `truncateToWidth` / `shortenPath`

### D12 — Subagent / plan / print

- v1：仅 `taskDepth === 0` 的主会话注册。`createTools` 门控 `session.taskDepth ?? 0 === 0`。
- plan mode：主会话仍注册（架构请教更有用）。
- print / ACP / SDK：setting 或 `--consult` 开启即注册；无 TUI 时 renderer 走文本 details。
- 影子评审的 subagent advisor（`task.agentAdvisor`）与 consult 无关，保持原样。

### D13 — 安全

顾问输入必须经专用 projection/redaction，fail closed：

1. `ToolSession.getSecretObfuscator?: () => SecretObfuscator | undefined`。SDK 把 session obfuscator 接到该 capability。
2. system prompt、user/developer 文本、assistant/thinking、tool call 参数、tool result 全部脱敏。复用 `formatSessionHistoryMarkdown`、`SecretObfuscator.obfuscate`、`obfuscateToolArguments`。regex secret 值跨块共享；整段 obfuscate 必须与分块拼接 byte-equivalent，否则返回 `redaction_unavailable`。
3. `secrets.enabled === true` 但 obfuscator 缺失、`hasSecrets()` 与加载失败、或一致性检查失败 → **禁止发请求**，返回 `redaction_unavailable`。
4. `secrets.enabled === false`：仍跑 formatter + tool-arg 截断，不要求 obfuscator。
5. 顾问输出当不可信文本展示，不解析成工具调用。
6. 不授予顾问任何 builtin。`consult` 不进 WATCHDOG.yml 可授工具表：`filterAdvisorTools` 明确丢弃 `consult`。
## 5. 架构与数据流

```
用户 /consult on  或  consult.enabled / --consult
        │
        ▼
createTools 仅按 enabled + top-level 注册 ConsultTool
buildSystemPrompt 追加 consult-instructions.md
        │
        ▼
执行器 tool_use name=consult { focus? }
        │
        ▼
ConsultTool.execute
  配额检查 → snapshotConsultContext → 脱敏 + pinned 策展
  resolve consult model / credentials / same-model（每次）
  instrumentedCompleteSimple({ oneshotKind: "consult", maxTokens })
        │
        ▼
tool_result 文本（verdict + actions 或 error code）
        │
        ▼
执行器同一轮继续（read/edit/bash…）
```

关键模块（均在 `packages/coding-agent/`）：

| 文件 | 职责 |
|---|---|
| `src/tools/consult.ts` | `ConsultTool` 类：execute-time 解析与 oneshot |
| `src/tools/consult-model.ts` | D3 模型/凭据/same-model 解析，纯函数 |
| `src/tools/consult-transcript.ts` | pinned 策展、预算、脱敏投影 |
| `src/tools/consult-renderer.ts` | TUI |
| `src/tools/consult-state.ts` | `consultUsage` 配额 helper |
| `src/prompts/tools/consult.md` | 工具 description |
| `src/prompts/tools/consult-system.md` | 顾问 system |
| `src/prompts/tools/consult-user.md` | 顾问 user 模板 |
| `src/prompts/system/consult-instructions.md` | 执行器时机块 |
| `src/slash-commands/builtin-consult.ts` | `/consult` |
| `src/cli/args.ts` + `flag-tables.ts` + `src/main.ts` | `--consult` / `--consult-model` |
| `src/config/settings-schema.ts` | `consult.*` |
| `src/system-prompt.ts` | 按 toolNames 注入 |
| `src/tools/builtin-names.ts` + `index.ts` | 注册与门控 |
| `src/tools/index.ts` `ToolSession` | `snapshotConsultContext`、`getSecretObfuscator`、`consultUsage` |
| `src/session/session-tools.ts` / `sdk.ts` / `agent-session.ts` | snapshot 接线、`setConsultToolEnabled`、turn_start 清零 |
| `test/consult*.test.ts` | 合同测试 |

不新增 worker、不改 `packages/agent` 循环。Consult 对 agent-core 只是又一个 `AgentTool`。

## 6. 设置与配置

```yaml
consult:
  enabled: false
  model: openai-codex/gpt-5.5          # 可选；省略走 D3
  allowSameModel: false
  maxUsesPerTurn: 2
  maxUsesPerSession: 12
  timeoutMs: 60000
  maxTokens: 2048
  maxFocusChars: 2000
```

UI：`consult.enabled` 为顶层开关；其余 `condition: "consultEnabled"`。
`omp config list` 自动从 schema 暴露。
`docs/settings.md` 在现有 Advisor 节**之后**加 Consult 节，并写一句「与影子评审无关」。
`docs/cli-reference.md` 增加 `--consult` / `--consult-model`。
不改 `docs/advisor-watchdog.md` 的行为描述；只在文首加「另见 Consult Tool」链接，避免两套文档互相吞义。

Changelog（`packages/coding-agent/CHANGELOG.md` `[Unreleased] ### Added`）：

- Added `consult` tool so the main agent can ask a stronger model for strategic guidance mid-turn, independently of the existing turn-by-turn advisor.

## 7. 错误处理与边界

1. 工具未注册：执行器根本看不到 `consult`。不要在关闭时用 prompt 说「你可以 consult」。
2. 打开后模型消失（logout）：工具仍在 schema；下次 execute 返回 `no_credentials`；status 显示 `no_model`。不自动关设置。
3. `/model` 把 primary 切成与顾问相同：工具仍注册；execute 返回 `same_model`（除非 `allowSameModel`）；status `same_model`。不依赖 `createTools` 自动重跑。
4. Compact / fork / `/new`：配额 session 计数随 session 对象走；新 session 归零。策展读 compact 后的 live systemPrompt + messages。
5. 执行器在 consult 进行中被 Esc：abort signal 传到 oneshot，返回 `aborted`。
6. 顾问输出超长：provider 侧被 `maxTokens` 截住（`stopReason: length` → `truncated: true`）。tool_result 再按 `enforceInlineByteCap` 写入；超 cap 全文进 artifact，TUI expand 看折叠窗口 + artifact 指针。
7. 并发：exclusive 串行化。第二次 call 等第一次结束，仍计入配额。
8. Print mode 多 prompt：`maxUsesPerSession` 跨 prompt 累计，直到进程丢 session。

## 8. 测试

全部合同测试，禁止 source-grep。

| 测试 | 失败时用户看见什么 |
|---|---|
| `consult.enabled=false` 时 `createTools` 不含 `consult` | 关着还能请教 |
| enable + top-level 含 `consult`，即使无模型/无凭据 | 开了没工具，错误码不可达 |
| subagent `taskDepth>0` 不含 `consult` | 子代理也能请教 |
| primary 与顾问同 id 且 `allowSameModel=false` 时工具仍在、execute 返回 `same_model` 且不调用 complete | 自己请教自己，或工具消失后无法报错 |
| 登录后无凭据 execute 返回 `no_credentials`，主 loop 继续 | 登出后卡死或炸 turn |
| execute 成功返回顾问文本、details.model 正确、请求带 `maxTokens` | oneshot 没打到所选模型或无硬预算 |
| 第 3 次同 turn 返回 `max_uses_exceeded` 且不调用 complete | 配额没挡住 |
| complete 抛错时 result `isError` 且 session 仍可继续 | 顾问失败炸主 turn |
| timeout/abort 映射 `timeout`/`aborted` | Esc 或超时表现为崩溃 |
| pinned system/project/user constraints 在 oldest-first 裁剪后仍在顾问输入 | 顾问丢掉 AGENTS/任务 |
| 策展把 >800 字符的 tool args 截断 | 超大 bash 输出撑爆顾问 |
| 策展把历史 consult 正文换成 stub | 顾问开始评论自己 |
| `secrets.enabled` 且缺 obfuscator → `redaction_unavailable`，不发请求 | 跨模型泄密 |
| 跨 chunk secret 脱敏不一致 → `redaction_unavailable` | 半脱敏发出去 |
| `buildSystemPrompt` 在 toolNames 含 consult 时包含时机块，不含时没有 | 关着仍被提示去 consult |
| `/consult off` 后重建工具，schema 消失 | 命令是摆设 |
| CLI `--consult` / `--consult-model` 解析且不持久化 | flag 是摆设 |
| 与影子 advisor 同时开时 consult transcript 含 `<advisory>` | 顾问复读旁路意见 |
| artifact 路径：超 inline cap 的正文可经 artifact 恢复 | expand 看不到全文也没有指针 |

测试注入 `completeImpl`（与 `InspectImageTool` 构造器相同手法），不打真网。

## 9. 风险与回滚

- **执行器不请教**：只有提示、没有硬闸门。若上线后 telemetry `oneshotKind=consult` 接近 0，下一轮再考虑 Claude Code 那种「非平凡任务至少一次」的 prompt 加强，仍然不做自动注入。
- **执行器狂请教**：`maxUsesPerTurn=2` / `maxUsesPerSession=12` 次数硬顶，加上 `maxTokens` 单次硬顶。
- **与影子评审双烧**：文档 + status 提示；默认双关。
- **延迟**：顾问 TTFT 挡在 tool_use 上。exclusive + 60s timeout。用户 Esc 可中断。
- **回滚**：`consult.enabled` 默认 false；feature 整块由该开关与工具注册门控。删工具名即可从 schema 消失，影子评审不受影响。

跳出原思路的一条：**不要在 v1 做「官方 Anthropic 路径走 server tool、其它厂走客户端」**。那会让 `/consult status`、配额、失败码、transcript 策展全部按 provider 分叉。OMP 的优势是一条工具契约打所有厂；官方同请求语义等 Anthropic 在非 1P 上也稳定后再说。

## 10. 实现顺序

1. settings schema + prompt 资产 + 纯函数（model resolve、transcript/budget/redaction）+ 测试。
2. `consult-state` 配额 + `ConsultTool` + renderer + `BUILTIN_TOOLS` 稳定门控。
3. `ToolSession` snapshot/obfuscator 接线、`setConsultToolEnabled`、turn_start 清零。
4. `buildSystemPrompt` 注入。
5. `/consult` + CLI flags。
6. 文档 + changelog。
7. 包内 `bun test` 聚焦 consult；`bun check`。

## 11. Handoff

### 11.1 同会话继续

直接执行 $design-review 或 /design-review

### 11.2 新会话恢复 prompt

```text
请阅读设计文档 docs/superpowers/specs/2026-08-26-executor-consult-tool-design.md，
使用 $design-review（或 /design-review）对该方案进行评审；若文档包含根因分析，
请一并分析根因判断、证据与设计方案是否正确、合理，以及两者是否一致。
```
