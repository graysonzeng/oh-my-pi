# Code Review: 执行器主动请教（Consult Tool）

- Date: 2026-08-27
- Design Input: `docs/superpowers/specs/2026-08-26-executor-consult-tool-design.md`
- Design Review: `docs/superpowers/plans/2026-08-27-executor-consult-tool-design-review.md`
- Implementation: `docs/superpowers/plans/2026-08-27-executor-consult-tool-implementation.md`
- Reviewed Commit: `8d5a580299`

## 1. 审查范围

- 对照设计目标、前序根因/前提评审、采纳的设计修订与提交实现。
- 完整检查 Consult 核心执行、上下文投影、脱敏、模型解析、配额生命周期、运行时注册、CLI/设置、prompt、TUI、SDK 接线和焦点测试。
- 本阶段只读被审查对象；未运行测试、lint、typecheck、build 或真实 provider 调用。实现文档中的 `41 pass / 0 fail / 94 expect`、Biome 和 typecheck 结果仅视为实现阶段历史声明，不作为本次复跑证据。

## 2. 根因前提与设计修订一致性

| 前提 / 修订 | 代码结果 | 验证证据 | 判断 |
|---|---|---|---|
| 影子 advisor 不是同步 mid-turn consult | 独立 `ConsultTool` oneshot；advisor 明确丢弃 `consult` 工具 | `advisor/config.test.ts` 覆盖过滤 | 一致 |
| `systemPrompt` 与 messages 分离，项目约束必须 pinned | SDK snapshot 同时读取两者；projection 固定首/末 user 和 system prompt | 纯 projection 测试覆盖约束保留 | 基本一致 |
| 稳定注册；模型/凭据/same-model execute-time 重校验 | 初始门控正确；execute 调 resolver | 只覆盖纯 resolver，且运行时 subagent reconcile 可绕过门控 | 部分一致 |
| 跨模型脱敏必须复用安全路径并 fail closed | 复用 formatter、SecretObfuscator、tool args transform、byte-equivalence 检查 | 缺跨块不一致且 execute 零外发测试 | 部分一致 |
| `maxTokens` 是 provider 侧硬预算 | 传入 `instrumentedCompleteSimple` | 注入 stub 明确断言 | 一致 |
| 输入按最终序列化请求统一计数 | 预算发生在脱敏前，最终请求未复核 | 无合同测试 | 不一致 |
| session 配额归属当前逻辑 session | turn_start 清零 turn；逻辑 session 切换不清 session/last | 无生命周期测试 | 不一致 |
| artifact 展开可恢复全文 | capped 文本写 artifact footer | 展开视图可能裁掉 footer | 不一致 |

主根因成立，方案 B（客户端普通工具 + 独立 oneshot）仍正确，不需要回退重设计。问题集中在修订合同未完整落地和验证证据过度表述。

## 3. 主要发现

### [HIGH] 错误处理: 将凭据解析纳入 abort/timeout 与统一错误映射

**文件**: `packages/coding-agent/src/tools/consult.ts:100-104`、`packages/coding-agent/src/tools/consult-model.ts:71-73`

**问题**: `execute` 在创建 timeout signal 和进入 provider `try/catch` 前等待 `resolveConsultSelection()`；该函数的 `getApiKey()` 可执行 OAuth/auth-broker 刷新、阻塞或 reject，且没有接收 abort signal。

**影响**: 凭据刷新异常可直接 throw 并把主 turn 标成工具崩溃；刷新阻塞时 Esc 与 `consult.timeoutMs` 无法终止；失败不计入配额，违反 D7。

**建议**: 在解析前建立组合 signal，传入 `getApiKey`；解析与 provider 请求统一映射 `timeout` / `aborted` / `provider_error` 并记录一次 attempt。成功解析后复用已取得的 key，避免二次解析。

### [HIGH] 输入预算: 按脱敏后的最终请求重新拟合

**文件**: `packages/coding-agent/src/tools/consult-transcript.ts:204-276`

**问题**: oldest-first 拟合针对未脱敏 transcript；之后 secret 会被替换成通常更长的 keyed placeholder，最终 Handlebars user prompt 没有重新 token 化。

**影响**: 原始文本刚好适配时，脱敏后的请求仍可能越过模型 context window并得到 provider 400，尽管还有可丢弃历史。

**建议**: 对候选消息完成 tool-arg 脱敏、全文 fail-closed 脱敏和最终模板渲染后再检查统一预算；超限继续 oldest-first 丢中段。pinned-only 超限仍按 D6 原样发送。

### [HIGH] 生命周期: 新逻辑 session 必须清零 Consult 配额

**文件**: `packages/coding-agent/src/session/agent-session.ts:5635-5646`、`packages/coding-agent/src/tools/consult-state.ts:20-35`

**问题**: `/new`、fork、session switch 共用的 `#clearSessionScopedToolState()` 没有清理 `consultUsage.session`、`turn` 和 `last`；只有 `turn_start` 清 `turn`。

**影响**: 旧会话达到 `maxUsesPerSession` 后，新会话仍立即 `max_uses_exceeded`，status 还显示上一会话费用/截断，违反设计 §7“新 session 归零”。

**建议**: 增加保持共享对象身份的 session reset helper，并在逻辑 session 成功切换后的统一清理点调用；失败回滚路径不得提前清零。

### [HIGH] 门控: 运行时不得在 Subagent 激活 Consult

**文件**: `packages/coding-agent/src/session/session-tools.ts:1528-1565`

**问题**: 初始 `createTools` 正确检查 `taskDepth === 0`，但 runtime reconcile 只检查 enabled，并可经 SDK factory 在 subagent 中创建、注册和激活 `consult`。

**影响**: subagent/SDK 调用 `setConsultToolEnabled(true)` 或设置模型 override 可绕过 D2/D12，增加 schema、系统提示和顾问请求。

**建议**: runtime enable 在 mutation owner 内重校验主会话身份；模型 override 必须复用同一门控。

### [HIGH] 验证: execute-time same-model/no-credentials 合同未被测试

**文件**: `packages/coding-agent/test/tools/consult.test.ts:156-178`

**问题**: 测试只直接调用 resolver，没有证明 `ConsultTool.execute` 返回对应 `isError`、零 provider 调用、记录一次失败且工具保持可继续。

**影响**: execute 忽略 resolver 结果并向 provider 发请求时测试仍会通过，无法支撑实现文档的“execute-time 重校验已覆盖”。

**建议**: 从 execute 边界分别覆盖 same-model 与 no-credentials，断言错误码、零 complete 调用和 usage。

### [HIGH] 验证: provider 真抛错与脱敏 fail-closed 零外发未覆盖

**文件**: `packages/coding-agent/test/tools/consult.test.ts:208-235,339-351`

**问题**: provider 用例返回 `stopReason: "error"` 而非抛异常；脱敏测试只覆盖缺 capability 和普通正向替换，没有制造跨块 byte-equivalence 不一致，也没有从 execute 断言零外发。

**影响**: catch 失效或 projection error 被忽略时测试仍绿；D7/D13 的关键失败合同没有回归保护。

**建议**: 增加 throwing complete stub、同 session 后续成功调用，以及受控不一致 obfuscator 的 execute 边界零调用测试。

### [MEDIUM] 错误文本: provider message 未按 D7 截断

**文件**: `packages/coding-agent/src/tools/consult.ts:170-188`

**问题**: throw 的 `error.message` 与 `response.errorMessage` 原样进入 tool result。

**影响**: 超长/带请求诊断的 provider error 会膨胀主 transcript，并绕过成功输出的 inline cap。

**建议**: 复用现有文本截断工具和 Consult tool-result 上限，在交给 `consultError` 前裁剪。

### [MEDIUM] Prompt: 同一 turn 重试规则自相矛盾

**文件**: `packages/coding-agent/src/prompts/system/consult-instructions.md:15`

**问题**: 系统指令允许“clearly transient”错误在同 turn 重试；工具描述和 D7 都要求失败后本 turn 不重试。

**影响**: 高优先级系统提示会诱导重复付费调用并消耗剩余配额。

**建议**: 删除例外，统一为错误后继续主任务且本 turn 不重试。

### [MEDIUM] TUI: 展开视图可能丢失 artifact URI

**文件**: `packages/coding-agent/src/tools/consult-renderer.ts:92-100`

**问题**: artifact footer 在 capped 文本末行；renderer 即使 expanded 也只显示前 `OUTPUT_EXPANDED` 行，且 expanded 时没有额外 recovery hint。

**影响**: 大量短行输出可让用户在 TUI 中看不到全文，也拿不到 `artifact://` 指针，违反 D11。

**建议**: 切片前用现有 footer parser 提取 recovery footer，在 expanded 结果中独立追加。

### [MEDIUM] 状态: 凭据状态在 no-model/same-model 路径不准确

**文件**: `packages/coding-agent/src/tools/consult-model.ts:65-73`、`packages/coding-agent/src/session/agent-session.ts:5337-5340`

**问题**: resolver 在 same-model 前尚未检查凭据，status 又把除 `no_credentials` 外的全部错误显示为 `credentials: ok`；`no_model` 也会显示 ok。实现文档声称的解析顺序是 model → credentials → same-model。

**影响**: `/consult status` 可报告未经检查的凭据为可用，误导用户排障。

**建议**: 按文档顺序先检查凭据再判 same-model；no-model/status 异常不得显示 ok。

### [MEDIUM] 验证文档: “覆盖合同”表述超出已有证据

**文件**: `docs/superpowers/plans/2026-08-27-executor-consult-tool-implementation.md:72-78`

**问题**: focused tests 实际未覆盖 runtime subagent reconcile、session reset、execute 层拒绝、真抛错、timeout/abort、跨块不一致、条件 system prompt、slash reconcile、影子共存、artifact 恢复和 CLI 运行时非持久化。

**影响**: 评审者会把部分单元证据误当完整合同验证。

**建议**: 修复后改为逐项“已覆盖/未覆盖/未执行”；只保留真实运行过的命令和结果。

### [MEDIUM] CLI 验证: 只覆盖解析，未覆盖运行时应用与非持久化

**文件**: `packages/coding-agent/test/cli-consult-flag.test.ts:4-21`

**问题**: 测试只检查 `parseArgs`，没有经过启动边界证明 settings override 生效且不写回配置。

**影响**: flag 解析正确但未应用、模型应用错误或意外持久化时仍全绿。

**建议**: 增加隔离配置的启动边界测试，或在实现文档明确该合同尚未做自动验证并用可复现 smoke 补证据。

## 4. 改进顺序

1. 先关闭主 turn 崩溃/卡死和跨模型预算风险：凭据 signal + 统一错误映射、最终请求预算。
2. 修正 session/subagent 生命周期边界。
3. 收紧错误文本、prompt 与 TUI artifact 展示。
4. 用合同测试覆盖 execute-time 拒绝、真抛错、fail-closed 零外发、session reset、subagent runtime 门控、最终预算和 renderer recovery。
5. 重跑 focused tests、package check、Biome、build/smoke 与真实 CLI 功能场景，再更新实现/审查文档。

## 5. 最终结论

`NEEDS_FIX`

总体架构与主根因一致，但 4 个 HIGH 级实现问题会造成工具崩溃/不可取消、context 超限、跨 session 配额污染和 subagent 门控绕过；关键失败路径的验证证据也不足。修复并完成回归前不可合并。

## 6. 下一步

### 同会话继续

直接执行 $fix-implement 或 /fix-implement

### 新会话恢复 prompt

```text
请阅读实现文档 docs/superpowers/plans/2026-08-27-executor-consult-tool-implementation.md、
审查文档 docs/superpowers/plans/2026-08-27-executor-consult-tool-code-review.md，
以及本次代码变更，
使用 $fix-implement（或 /fix-implement）进行方案修复及代码实现。
重点修复 HIGH-1：将模型凭据解析纳入 consult timeout/abort 和统一错误映射，避免异常逃逸或主 turn 卡死。
```

## 7. 修复记录

### 7.1 修复状态

| 审查发现 | 处理结果 | 回归证据 |
|---|---|---|
| HIGH 凭据解析不受 abort/timeout 约束 | 已关闭：组合 signal 在 resolver 前建立，传入 `getApiKey`；解析与 provider 共用错误映射和 attempt 计数；成功复用已解析 key | execute 边界覆盖 caller abort、真实 `consult.timeoutMs` 超时、credential reject、零 complete 调用 |
| HIGH 最终请求预算发生在脱敏前 | 已关闭：对脱敏并完成 Handlebars 渲染后的 system+user 请求按真实 `max(0, contextWindow-maxTokens)` 拟合，继续 oldest-first 丢可裁历史；pinned-only 超额保留 | 低于 1024 token 的真实余量测试；临时恢复旧 1024 下限时红、恢复修复后绿 |
| HIGH 新逻辑 session 未清配额 | 已关闭：`resetConsultSession` 原位清 turn/session/last；统一 session 清理和成功 fork 调用，失败/cancel 不提前清 | SDK 覆盖成功 `/new` 原位清零、取消 `/new` 保留旧状态 |
| HIGH subagent runtime gate 可绕过 | 已关闭：runtime enable 与模型 override 在 mutation owner 内重校验 `agentKind() === "main"` | SDK subagent 覆盖 registry/slate 不含 consult，enable/override 都返回 false |
| HIGH execute-time 拒绝与关键失败证据不足 | 已关闭：补 same-model/no_credentials、provider 真抛错后继续、脱敏不一致零外发等 execute 合同测试 | 焦点套件 60 pass / 0 fail |
| MEDIUM provider 错误文本未截断 | 已关闭：throw 和 response error 都使用 `truncate(..., CONSULT_TOOL_RESULT_CHARS)` | 长错误文本精确上限测试 |
| MEDIUM prompt 同 turn 重试矛盾 | 已关闭：系统指令统一为错误后继续主任务且本 turn 不重试 | 静态 prompt 与 D7/工具描述一致；未增加 source-grep 测试 |
| MEDIUM TUI artifact URI 可被 expanded 行上限裁掉 | 已关闭：切片前提取既有 raw-output footer，expanded 独立显示消毒后的 recovery URI | renderer 测试覆盖 expanded/collapsed 与正文行上限 |
| MEDIUM status credentials 不准确 | 已关闭：解析顺序改为 credentials → same-model；status 对异常返回 `provider_error`/credentials false | SDK 覆盖 same_model、no_credentials、credential reject |
| MEDIUM 实现文档验证表述过度 | 已关闭：实现文档改为逐项列出已覆盖、未执行与基线失败 | 见 implementation §5-6 |
| MEDIUM CLI 只覆盖 parser | 保留为验证边界：实现文档不再声称 CLI 启动边界已自动覆盖；parser、main ephemeral override 代码、用户文档已核对 | 未新增需要抽象生产代码的专用启动测试；compiled binary build/smoke 通过 |

### 7.2 最终验证

- 焦点合同测试：60 pass / 0 fail / 198 expect。
- `bun run check:types`：通过。
- 本次变更文件 `bunx biome check ...`：No fixes applied。
- `bun run build`：通过。
- 编译产物：`dist/omp --smoke-test` → `smoke-test: ok`；`--version` → `omp/18.0.5`。
- 完整 coding-agent 套件：944 pass / 1 fail；唯一失败 `test/discovery/codex-mcp-cwd.test.ts:82` 在父提交 `d6e93ae06e` 的隔离 worktree 中同样复现（4 pass / 1 fail），不由 Consult 变更引入。
- 未执行真实跨 provider 请求；回答质量、延迟和主动调用频率仍是上线观测项。

### 7.3 最终复审

最终 reviewer 对真实低余量预算和凭据解析 timeout 修复复核为 `PASS`，未发现新问题。

**修复后结论**: `PASS`

Consult 变更已达到可合并状态；无需额外 handoff。仓库完整套件仍有上述父提交可复现的 discovery 基线失败，应独立处理，不阻塞本次 Consult 修复判断。
