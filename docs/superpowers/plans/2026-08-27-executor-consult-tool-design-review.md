# Design Review: 执行器主动请教（Consult Tool）

- Date: 2026-08-27
- Reviewed Design: `docs/superpowers/specs/2026-08-26-executor-consult-tool-design.md`
- Review Scope: 根因与事实前提、上下文与安全边界、工具生命周期、模型解析、配额、TUI、测试与实现可行性

## 1. 整体结论

- `NEEDS_REVISION`
- 一句话结论：客户端 Consult Tool 是正确方向，但当前设计会遗漏主会话系统/项目约束，工具注册状态会随模型与凭据变化失真，跨模型 transcript 脱敏没有可执行的 fail-closed 合同，且单次请求缺少硬输出预算；修订这些 HIGH 项后再实现。

## 2. 根因评审结论（按需）

- 适用性：适用。文档虽不是故障 RCA，但方案建立在“现有影子 advisor 与用户要求的主动、同步 consult 语义不同”这一根因/前提判断上。
- 结论：`SUPPORTED`（主根因成立；D2、D6、D13 的部分支撑前提推断过度）。
- 理由：当前 advisor 确实在 primary turn 结束时消费 transcript delta，并通过 advisory 注入回主会话；Anthropic Advisor Tool 则由执行器在同一生成过程中主动调用、无工具运行并返回结果。两者不是同一能力。现有 `instrumentedCompleteSimple` 与 `inspect_image` 也证明客户端 oneshot 路径可行。

### 2.1 证据检查

- `packages/coding-agent/src/session/session-advisors.ts:336-354` 在 primary turn end 把消息交给 advisor runtime，`packages/coding-agent/src/advisor/runtime.ts:37-43,370-371` 通过独立 host snapshot 消费主 transcript；“现有 advisor 是旁路影子评审”有代码证据。
- Anthropic 官方文档的 How it works 明确说明 advisor 接收的 quoted context 包含 system prompt、tool definitions、prior turns、tool results 和当前 turn 已生成文本，并在同一 `/v1/messages` 请求中返回结果：<https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool>。
- `packages/coding-agent/src/tools/inspect-image.ts:269-304` 已使用 `instrumentedCompleteSimple(..., { oneshotKind: "inspect_image" })` 完成无额外 agent loop 的模型调用；方案 B 的核心执行缝成立。
- `packages/coding-agent/src/tools/index.ts:169-462` 证实 `ToolSession` 已有 settings、model registry、active model、telemetry 和 session id，但没有 transcript/system-prompt snapshot。

### 2.2 事实 / 假设边界检查

- 成立：命名冲突、默认关闭、与影子 advisor 正交、静态 prompt 资产、内置工具注册真源、客户端跨 provider 编排的必要性。
- 推断过度：D6 称 transcript 已包含足够约束，因此无需再给顾问 system/project context。`AgentState` 明确把 `systemPrompt` 与 `messages` 分开存储（`packages/agent/src/types.ts:713-719`）；`buildSystemPrompt` 又把 context files、project prompt 和 active repo context 放入 system prompt（`packages/coding-agent/src/system-prompt.ts:962-1040`）。仅 snapshot messages 不会得到这些约束。
- 推断过度：§7.3 假定 `/model` 后“下次 createTools”会卸载 consult。当前工具 slate 在 session start 派生，模型切换路径为动态工具逐个显式 reconcile（`packages/coding-agent/src/session/agent-session.ts:8449-8493`）；没有通用的自动重跑 `createTools`。
- 未验证假设（执行器调用频率、截断 transcript 是否足够）已被文档正确标成假设，但上线判据只有调用次数，不足以判断建议质量与约束保真度。

### 2.3 对方案的影响检查

- 主根因足以支持“方案 B：客户端普通工具 + 独立 oneshot”，无需回退重设计，也不应引入 Anthropic/非 Anthropic 双路径。
- 当前 D2/D6/D13 不能直接实现：它们分别破坏可用性状态机、官方语义中的上下文完整性和跨模型数据安全。修订后仍可保持同一总体架构。

## 3. 设计方案评审

### 3.1 需求与方向

- 解决的是正确问题：主执行器自主决定时机，顾问无工具，只返回普通 tool result，失败不终止主 turn。
- 方案 B 优于方案 A/C：一条客户端合同覆盖所有 provider，且不把 consult 偷换成带工具 subagent。继续保持 Anthropic native server tool 为非目标。

### 3.2 方案合理性

- 合理部分：`consult` 与 `advisor` 命名隔离；默认关闭；top-level only；配额按 turn/session 分层；错误结果不 throw；系统提示仅在工具可见时注入；使用静态 prompt；复用 `enforceInlineByteCap`、TUI 消毒和 telemetry。
- 必须修订：顾问输入应是“受预算约束、脱敏后的主会话上下文”，不是仅 messages 的 oldest-first 尾部；工具可见性不应依赖易失的凭据/模型解析结果；执行时必须再次校验 model、credentials 和 same-model；单次输出必须有硬 token 上限。
- 跳出原框架后的更简方案：工具只按用户意图（enabled + top-level）稳定注册；模型、凭据、same-model 在每次 execute/status 时解析并返回明确错误。这样 D7 的 `no_model`/`no_credentials` 合同真实可达，也不需要为 catalog/login/model switch 维护一组易漏的 schema reconcile 事件。若坚持同模型时从 schema 隐藏，则必须新增并列全 model/catalog/credential 变化触发点，复杂度更高，不推荐。

### 3.3 实现可行性

- 可行，但应先固定四个接口：`snapshotConsultContext` 的 system/messages 边界、共享 transcript projection/obfuscation、稳定注册与 execute-time resolution、输入/输出 token 预算。
- `consult-transcript.ts` 不应另造历史格式化约定。复用或抽取 `session/session-history-format.ts`、advisor 的 secret obfuscation/tool-argument redaction；新模块只负责 consult 特有的 pinning、预算和历史 consult stub。
- 配额状态应有单一 owner，并在现有 `turn_start` 事件清零 turn counter；不要同时保留 WeakMap、ToolSession 字段、`prompt()` 入口三种候选实现。

### 3.4 文档质量

- 文档总体完整，目标、非目标、数据流、错误码、风险和测试均可追踪。
- 仍有合同不一致：D2 隐藏无模型/凭据工具，而成功标准/D7 要求工具返回相应错误；D3 声明 `tier.consult`，§6 配置清单未列；D11 声称 expand 看全文，§7.6 又允许正文只留 artifact；关键文件表未列 `src/main.ts` 的 CLI override 和 `agent-session.ts` 的模型变化接线。

## 4. 主要发现

### CRITICAL

- 无。

### HIGH

#### [HIGH] 上下文完整性: `snapshotMessages()` 丢失系统与项目约束

**位置**: D5、D6，尤其 §4 第 183-194 行。

**问题**: 设计只从 `agent.state.messages` 生成顾问输入，并断言 transcript 已包含 AGENTS/project constraints。实际 `AgentState.systemPrompt` 与 messages 分离，项目 context files 进入 system prompt；oldest-first 丢弃还可能移除最初用户任务。该输入也不再等价于官方 Advisor Tool 的“system prompt + tool definitions + full transcript”。

**影响**: 顾问可能基于缺失的用户约束、项目规则或工具能力给出错误建议；执行器又被提示“认真加权”这些建议，错误会被放大。

**建议**: 把接口改为 `snapshotConsultContext(): { systemPrompt: string[]; messages: AgentMessage[] }` 或等价的最小专用 capability；预算时固定保留当前用户任务、有效 system/project constraints 和最近执行证据，再裁剪中段。文档必须删除“transcript 已经够”的事实表述，并增加约束保真合同测试。

#### [HIGH] 生命周期: 注册门控依赖易失状态且与错误合同冲突

**位置**: D2、D3、D10、§7 第 1-3 项。

**问题**: D2 要求 model 可解析、有凭据、且不同于 primary 才注册；D7 又承诺 execute 返回 `no_model`/`no_credentials`。首次无模型/凭据时 execute 根本不可达。模型切换也不会自动重跑 `createTools`，现有代码对动态工具使用专用 reconcile 路径。

**影响**: `/consult on` 可能显示开启却没有工具；登录/登出、catalog discovery、fallback 或 `/model` 后 schema 可能长期过期；最坏情况下 primary 已切成顾问模型但旧工具仍可调用。

**建议**: 推荐仅以 enabled + top-level 决定稳定注册，并在每次 execute/status 时解析 model/credentials、拒绝 same-model；失败返回 D7 错误且本 turn 不重试。若仍要求动态隐藏，必须设计 `reconcileConsultTool` 并列出 model change、role/settings change、catalog discovery、credential change、new/switch session 的全部触发点，同时 execute 再校验一次。

#### [HIGH] 数据安全: transcript 脱敏合同不完整且未 fail closed

**位置**: D13，§4 第 280-285 行。

**问题**: `ToolSession` 当前没有 secret obfuscator。设计提出“拿不到则至少跑 tool-result 红处理”，但用户消息、assistant reasoning、tool arguments、system/project context 都可能含 secret；只处理 tool result 不能覆盖跨 provider 发送面。现有 advisor 已有结构化消息格式化、tool argument redaction、SecretObfuscator 和跨 chunk 一致性检查，设计未明确复用。

**影响**: 用户启用跨模型 consult 后，凭据或私有上下文可能被发往另一个 provider；默认关闭只能降低暴露概率，不能修复已启用路径。

**建议**: 定义一个专用、强类型的 redaction/projection capability，复用 `formatSessionHistoryMarkdown`、`SecretObfuscator` 与现有 tool-argument transform；对 system、user、assistant/thinking、tool call/result 全面处理。obfuscator 缺失、失败或一致性检查不通过时返回 `redaction_unavailable`，禁止发请求。增加各消息角色和跨 chunk secret 的回归测试。

#### [HIGH] 成本边界: 只有调用次数配额，没有单次硬输出预算

**位置**: D5、D7、§6、§7 第 6 项。

**问题**: `maxUsesPerTurn`/`maxUsesPerSession` 只限制次数；“至多 5 条行动”只是 prompt 约束。`SimpleStreamOptions.maxTokens` 可选，未传时 provider 可使用模型级大输出上限。生成后再按 inline cap 截断不会减少已发生的延迟和费用。

**影响**: 一次失控顾问响应即可消耗远超预期的 token/cost，并长时间阻塞主 tool use；调用次数硬顶无法控制单次尾部风险。

**建议**: 增加并校验 `consult.maxTokens`（或写死一个保守上限），传给 `instrumentedCompleteSimple`；status/details 暴露实际输出与截断。测试必须证明请求收到该 hard cap。输入侧另按完整 system + focus + transcript + output reserve 计算预算。

### MEDIUM

#### [MEDIUM] 输入预算: `focus` 与固定上下文未纳入统一预算

**位置**: D4-D6。

**问题**: `focus` 只有自然语言“一句话”约束，没有长度上限；D6 的 50% 预算只描述 curated transcript，没有说明 system prompt、focus、Handlebars framing 和输出 reserve 如何共同计入。

**影响**: 超长 focus 或新增固定上下文可突破目标窗口，造成 provider 400、再次裁剪重要上下文或不稳定成本。

**建议**: 给 focus 设字符/token 上限；用最终序列化请求统一计数，预算顺序明确为 hard output reserve → system/framing → pinned constraints/evidence → 可丢弃历史，并测试临界窗口。

#### [MEDIUM] 验证范围: 测试矩阵未覆盖多个命名成功标准

**位置**: §1.2 第 5-6 项、§8。

**问题**: 表格未覆盖与影子 advisor 并存、top-level/subagent 隔离、timeout/abort 映射、secret redaction、system/project constraint 保留、model/credential 变化、status 计数/费用、CLI flags 和 artifact 全文路径。

**影响**: 方案最容易回归的跨模块接线没有可观察合同保护，聚焦测试通过仍不能证明成功标准成立。

**建议**: 按上述用户可见失败各补一项合同测试；避免 source-grep。模型切换测试必须通过真实 session API 观察 tool set，失败测试必须证明主 agent loop 仍继续。

#### [MEDIUM] 变更清单: 配置、CLI 与模型变化接线不完整

**位置**: D3、D10、§5 关键模块表、§6。

**问题**: `tier.consult` 未出现在 YAML/UI 清单；CLI flags 还需 `src/main.ts` 应用 ephemeral override；模型变化若采用隐藏策略还需 `agent-session.ts`/SessionTools reconcile；D11 与 §7.6 对“expand 全文”还是 artifact 指针表述不一致。

**影响**: 实现者可能完成 tool class 却漏掉启动、运行时切换或文档配置，产生“开关是摆设”类半成品。

**建议**: 把每个配置键、owner、CLI→setting/session override 数据流、动态事件和 TUI/artifact 行为补进文件表与测试表；若不需要 `tier.consult`，从 D3 删除。

### LOW

#### [LOW] 复杂度: 阶段启发式没有稳定可观察语义

**位置**: D5 第 171-179 行。

**问题**: “成功 bash”不能证明发生突变，“尾部出现验证命令”也不能可靠证明 final-check。该 stage 只作提示，却新增纯函数、状态规则、details 字段和测试负担。

**影响**: 顾问得到错误阶段标签，telemetry 产生看似精确但不可解释的数据；维护者还需持续追赶新工具类型。

**建议**: v1 删除 stage heuristic，让顾问从 transcript 判断；只有存在明确的 session lifecycle signal 和消费方时再加入。

## 5. 修订建议

1. 保留方案 B 与 `consult`/`advisor` 隔离，不增加 provider 分叉。
2. 将顾问输入合同改为包含 system/project constraints 的专用 snapshot，并定义 pinned-context 裁剪顺序。
3. 采用稳定注册 + execute-time model/credential/same-model 校验，统一 D2、D7、D10 和 §7；失败后同 turn 不自动重试。
4. 让 transcript projection/redaction 复用现有 history formatter 与 advisor secret 管线；缺安全 capability 时 fail closed。
5. 增加 `consult.maxTokens`、focus 上限与完整请求 token budget；配置 schema、status、details、docs、测试同步。
6. 补齐动态生命周期、安全、上下文保真、共存、CLI/status、abort/timeout 和 artifact 合同测试。
7. 删除无明确消费合同的 stage heuristic；明确 renderer 的 inline 截断与 artifact 展开行为。

## 6. 下一步建议

- 进入 `design-implement`，先修订设计文档，再按修订后的合同实现与验证。
- 理由：总体方向与核心技术缝成立，不需要推翻重设计；四个 HIGH 项必须在编码前写成确定接口和状态机，`design-implement` 可在同一步完成修订与实现。

## 7. Handoff

### 7.1 同会话继续

`直接执行 $design-implement 或 /design-implement`

### 7.2 新会话恢复 prompt

```text
请阅读设计输入 docs/superpowers/specs/2026-08-26-executor-consult-tool-design.md
以及评审文档 docs/superpowers/plans/2026-08-27-executor-consult-tool-design-review.md，
重点核对根因分析（如有）、事实/假设边界、以及方案修订点，
使用 $design-implement（或 /design-implement）进行方案修订及实现。
重点关注：HIGH-1 顾问上下文必须包含并固定保留 system/project/user constraints；HIGH-2 consult 生命周期须在模型、凭据和开关变化下保持一致并在 execute 时重校验；HIGH-3 跨模型 transcript 脱敏必须复用现有安全路径并 fail closed；HIGH-4 为每次 consult 增加硬输出 token 预算。
```
