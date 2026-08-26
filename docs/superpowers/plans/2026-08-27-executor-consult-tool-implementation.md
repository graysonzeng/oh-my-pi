# Implementation: 执行器主动请教（Consult Tool）

- Date: 2026-08-27
- Design Doc: docs/superpowers/specs/2026-08-26-executor-consult-tool-design.md
- Review Doc: docs/superpowers/plans/2026-08-27-executor-consult-tool-design-review.md
- Status: Completed

## 1. 评审意见处理摘要

- 采纳：HIGH-1 顾问输入改为 `snapshotConsultContext()`，固定保留 system/project constraints 与首/末用户任务，再 oldest-first 裁剪中段历史。
- 采纳：HIGH-2 注册只看 `consult.enabled` + 主会话；模型、凭据、same-model 在 execute 与 `/consult status` 时重校验。`/consult on|off`、`--consult`、settings UI 走 `setConsultToolEnabled` reconcile。
- 采纳：HIGH-3 投影复用 `formatSessionHistoryMarkdown`、`obfuscateToolArguments`、`SecretObfuscator`；`secrets.enabled` 且无 obfuscator，或跨 chunk 一致性失败，返回 `redaction_unavailable` 且不发请求。
- 采纳：HIGH-4 增加 `consult.maxTokens`（默认 2048）硬传给 `instrumentedCompleteSimple`；另保留 `consult.maxFocusChars`。
- 采纳：方案 B 与 `consult`/`advisor` 隔离；顾问不可被授予 `consult`。
- 额外修订（实现中发现）：默认 `tools.xdev=true` 会把 `loadMode: "discoverable"` 的 consult 挂到 `xd://`，系统提示却按顶层工具教模型调用。将 `consult` 加入 `XDEV_KEEP_TOP_LEVEL`。
- 未采纳：动态隐藏工具（随模型/凭据变化 unregister）。理由：与 D7 错误可达性冲突，且现有 slate 不会在 `/model` 后自动重跑 `createTools`。
- 未完整落地评审第 6/7 条的全部合同测试（abort/timeout、artifact 展开、status 集成）。主路径 HIGH 合同已有 focused tests；其余记入限制。

## 2. 根因前提处理结论（按需）

- 适用性：适用
- 处理策略：修订后实现
- 结论：主根因成立且稳定——现有影子 advisor 是 turn-end 旁路评审，不能提供执行器主动、同步、无工具的 consult。方案 B（客户端 oneshot 工具）可直接实现；D2/D6/D13 的支撑前提已按评审修订，不再沿用原设计字面。

### 2.1 消费的根因评审结论

- `SUPPORTED`：影子 advisor ≠ Anthropic Advisor Tool；`inspect_image` 的 `instrumentedCompleteSimple` 缝可用。
- `OVERREACHING`（已修订后实现）：
  - D6「transcript 已含 system/project constraints」——`AgentState.systemPrompt` 与 messages 分离。
  - §7.3「下次 createTools 会卸载 consult」——工具 slate 在 session start 派生，模型切换走显式 reconcile。
- `WEAK_EVIDENCE`：执行器调用频率、截断 transcript 是否足够。未阻塞实现；上线后靠配额与 `maxTokens` 限制成本。

### 2.2 本次修订的前提边界

- 已确认事实：
  - `systemPrompt` 与 `messages` 分开存储；项目约束进入 system prompt。
  - `createTools` 不随 `/model` 自动重跑；动态工具需要 reconcile。
  - `ToolSession` 原先没有 transcript snapshot / secret obfuscator；已补 capability。
  - `tools.xdev` 默认 true，会挂载 discoverable 工具。
- 未确认假设：截断后的 curated transcript 对顾问质量是否足够；执行器是否会按提示调用 consult。
- 对实现的影响：必须 snapshot systemPrompt；必须 execute-time 重校验；必须 fail-closed 脱敏；必须硬输出预算；consult 必须保持顶层可见。

## 3. 采纳的设计修订

1. 顾问输入：`snapshotConsultContext(): { systemPrompt: string[]; messages: AgentMessage[] }`。user prompt 含 `<pinned-constraints>` + `<transcript>`。裁剪顺序：固定 system/project constraints、首用户任务、末用户任务；oldest-first 丢中段。
2. 生命周期：注册门控 = `consult.enabled && taskDepth === 0`。execute/status 解析 model → credentials → same-model。失败返回 D7 错误码，`isError: true`，本 turn 不自动重试。配额对成功和失败都计数，超限拒绝不再计数。
3. 脱敏：复用 history formatter 与 advisor secret 管线；缺 obfuscator 或一致性失败 → `redaction_unavailable`。历史 consult 正文 stub 成 `consult #N → (omitted, see prior turn)`，避免顾问读自己。
4. 预算：`consult.maxTokens` 传入 oneshot；`consult.maxFocusChars` 限制 focus；输入侧按顾问 context window 减去 system/framing/output 预留。
5. xdev：`consult` 加入 `XDEV_KEEP_TOP_LEVEL`，避免被挂到 `xd://` 后系统提示不可达。

## 4. 实现摘要

新增：

- `packages/coding-agent/src/tools/consult.ts` — 工具本体、execute、错误映射、`maxTokens` oneshot。
- `packages/coding-agent/src/tools/consult-transcript.ts` — snapshot 投影、pin、stub、fail-closed redaction。
- `packages/coding-agent/src/tools/consult-model.ts` — 模型解析与 execute-time 校验。
- `packages/coding-agent/src/tools/consult-state.ts` — 配额与 details。
- `packages/coding-agent/src/tools/consult-renderer.ts` — TUI call/result。
- `packages/coding-agent/src/slash-commands/builtin-consult.ts` — `/consult on|off|unset|status|<model>`。
- prompts：`consult.md`、`consult-system.md`、`consult-user.md`、`system/consult-instructions.md`。
- tests：`test/tools/consult.test.ts`、`test/cli-consult-flag.test.ts`；advisor config 丢弃 consult。

接线：

- `BUILTIN_TOOLS.consult`、`createTools` 门控、renderer 注册。
- SDK `ToolSession.snapshotConsultContext` / `getSecretObfuscator` / 共享 `consultUsage`。
- `AgentSession`：`consultUsage`、turn_start 重置 turn 计数、`setConsultToolEnabled`、`consultState`。
- `SessionTools.#setConsultToolActive` 运行时 reconcile。
- CLI `--consult` / `--consult-model`；settings schema `consult.*`；docs/changelog。

## 5. 验证结果

- 测试：`bun test packages/coding-agent/test/tools/consult.test.ts packages/coding-agent/test/cli-consult-flag.test.ts packages/coding-agent/test/advisor/config.test.ts` → 41 pass / 0 fail / 94 expect（含 xdev 顶层可见性、约束 pin、fail-closed redaction、`maxTokens` 透传、配额重置、same-model / no_credentials、advisor 丢弃 consult、CLI flags）。
- lint：`bunx biome check` 覆盖本次 consult 相关源文件 → No fixes applied。
- typecheck：`cd packages/coding-agent && bun run check:types`（`tsgo -p tsconfig.json --noEmit`）→ 通过。
- 构建：未跑完整 binary/smoke；本变更为 coding-agent 源码路径，focused tests + package typecheck 覆盖合同。
- 功能验证：无真实 provider 调用。合同由 stubbed `completeSimple` 与投影纯函数覆盖：enabled 注册、subagent 不注册、xdev 顶层保留、system/project/user pin、secret fail-closed、历史 consult stub、硬 `maxTokens`、失败 `isError` 不 throw。

## 6. 已知限制与后续建议

- abort/timeout、inline artifact 展开、`/consult status` 会话级集成测试尚未单独覆盖；错误映射代码已在 execute 中实现。
- 未验证真实跨 provider 请求的顾问质量；`WEAK_EVIDENCE` 的调用频率假设需上线观察。
- `consult` 默认关闭；开启后仍可能把脱敏后的 transcript 发往另一 provider——这是功能本身，不是漏洞，但用户需知情。
- renderer 使用 `PREVIEW_LIMITS` 折叠正文；完整正文依赖已有 tool expand，未新增独立 artifact 合同测试。

## 7. Handoff

### 7.1 同会话继续

`直接执行 $code-review 或 /code-review`

### 7.2 新会话恢复 prompt

```text
请阅读设计输入 docs/superpowers/specs/2026-08-26-executor-consult-tool-design.md、
实现文档 docs/superpowers/plans/2026-08-27-executor-consult-tool-implementation.md，
以及本次提交的代码变更，
重点核对根因前提（如有）、设计修订、实现结果与验证证据是否一致，
使用 $code-review（或 /code-review）进行方案重审及代码审查。
```
