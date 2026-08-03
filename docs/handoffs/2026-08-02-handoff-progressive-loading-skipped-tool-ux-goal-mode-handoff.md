# Handoff：Handoff / Progressive Loading / Skipped Tool UX Goal Mode

- Date: 2026-08-02
- Repository: `/Users/sheng/tencent/oh-my-pi`
- Implementation authorization: authorized
- Current-session action: documentation and handoff only; source implementation was intentionally deferred

## 中文短 Prompt

```text
/goal 从 docs/handoffs/2026-08-02-handoff-progressive-loading-skipped-tool-ux-goal-mode-handoff.md 继续。先完整读取该 handoff、docs/superpowers/specs/2026-08-02-handoff-progressive-loading-and-skipped-tool-ux-design.md 和 docs/superpowers/plans/2026-08-02-handoff-progressive-loading-and-skipped-tool-ux-subagent-review-round-1.md；当前设计 SHA-256=14d2d59b226ac76310f9d18583d62db82c3e3ce8a92f333ca95b98169ae56f10，首轮 NEEDS_REVISION 已由原 author 修订，但二次独立复审按用户要求中止，因此没有 PASS Gate。若继续源码实施，先按项目门禁对当前 revision 补齐异模型只读复审；PASS/PASS_WITH_NOTES 后按设计 Work Packages 依次实现 synthetic skip source、共享 presentation classifier、session-scoped lineage、self-contained handoff capsule、渐进 skills/rules prompt 和 read end-before-start exactly-once 修复。保留现有 dirty worktree，不 reset/checkout/clean/commit，不触碰无关 workflow 与 AI test 改动；exact rule-card/git-status 错配没有 red reproduction，禁止猜测修复。完成前运行设计验证矩阵中的聚焦测试、fresh-process handoff smoke、受影响包 bun check，并报告未复现边界。
```

## 1. 目标

优雅地修复四类问题，同时避免引入新的状态 owner：

1. queued user message 保持 `interruptMode=immediate`，但未执行的 sibling tool 显示为 skipped/not-executed，而不是执行失败。
2. Todo/Bash/Read 的 live、replay、terminal、ACP、collaboration/export/HTML 语义一致；真实执行错误继续显示失败。
3. handoff 文档在新进程中自包含；旧会话持久化工件通过有界、只读、session-scoped lineage 可选访问，不再依赖进程全局 registry。
4. skills/rules 继续使用 metadata index → body 的渐进结构，但先选择至多一个 primary routing/lifecycle skill，再按已知目标路径加载 domain rules；不批量预读、不在当前 transcript 内重复读取 immutable body。
5. 修复已确认的 read result end-before-start fallback；对 `rule://` 卡片显示 `git status` 的 exact swap 保持 evidence gate，没有 red reproduction 不改 mapping。

## 2. 稳定文档与 revision

### 当前设计

- Path: `docs/superpowers/specs/2026-08-02-handoff-progressive-loading-and-skipped-tool-ux-design.md`
- Author: `OptimizationDesignAuthor2`
- Author model: `gateway/gpt-5.6-luna`
- SHA-256: `14d2d59b226ac76310f9d18583d62db82c3e3ce8a92f333ca95b98169ae56f10`
- Reviewed-input manifest form:

```text
docs/superpowers/specs/2026-08-02-handoff-progressive-loading-and-skipped-tool-ux-design.md	14d2d59b226ac76310f9d18583d62db82c3e3ce8a92f333ca95b98169ae56f10
```

- Current manifest revision: `cc03efc6220a2a4ba9d4d76b50eeb5609a6992b79e5512f62ddd000ac8b56111`

### 首轮独立评审

- Path: `docs/superpowers/plans/2026-08-02-handoff-progressive-loading-and-skipped-tool-ux-subagent-review-round-1.md`
- Reviewer: `OptimizationDesignReviewer2`
- Reviewer model: `gateway/gpt-5.6-sol`
- Verdict: `NEEDS_REVISION`
- Covered old design SHA-256: `cc293ca0349518823c1e3660c258d310e6f5b8f869d72182a748d9be734ef6c2`
- Covered old revision: `c71787d3e2c06272d37527ba80bce4f489d9e9b108b0c63889913965d73327eb`

### 当前 Gate 状态

首轮 review 的四项阻塞点已由同一 author 修改到当前设计：

1. `SyntheticToolResultDetails.source` 成为唯一 causal discriminator；不再新增并列 `reason` owner。
2. 严格区分 never-invoked (`executed:false`) 与 started-then-aborted；后者不得显示 skipped。
3. lineage 改为 managed session-store canonical absolute path，并通过 `ToolSession`/`ResolveContext` 传递 session-scoped roots；移除 repository-relative session path。
4. 引入一个 typed presentation classifier，覆盖 TUI、ReadGroup、transcript/history replay、ACP、commit terminal、collaboration、export/share、HTML；验证矩阵增加 started-aborted、two-session isolation 和所有非 TUI surfaces。

二次 reviewer `OptimizationDesignReviewer3` 已启动，但用户明确要求“停止review，输出 handoff”，因此被取消；没有生成最终 review artifact，也没有 `PASS` / `PASS_WITH_NOTES`。

### 2026-08-03 实施会话 Gate 更新

- Round-2 gate（`…-subagent-review-round-2.md`，reviewer `DesignReviewGate`，`gateway/gpt-5.6-sol`）：对 revision 1（SHA `14d2d59b…`）返回 `NEEDS_REVISION`，三项 blocker：F1 started-abort 不得进入 never-invoked recovery 路径；F2 lineage 必须保留 live nullable accessor seam；F3 structured parent wire form 会被 session-listing 字符串解析器丢弃。
- 上述三项已在 design revision 2（SHA `61f599ac…`）修订并验证。
- Round-3 gate（`…-subagent-review-round-3.md`，reviewer `DesignReviewGate2`，`gateway/gpt-5.6-sol`）：对 revision 2 返回 `PASS_WITH_NOTES`（四条非阻塞 note：aborted 措辞、ACP 编码、pre-start source 映射、review artifact 例外）；notes 在 revision 3（SHA `221afa2f…`）落实，仅文档。
- **当前 Gate：`PASS_WITH_NOTES`**，已按 design revision 3 完成全部 Work Packages 与验证（见下）。

## 3. 已确认根因

### 3.1 queued tool batch

- `packages/agent/src/agent-loop.ts` 在 queued steering 到达后保留已完成结果，并为未开始 sibling 生成 skipped pairing result。
- 默认 `interruptMode=immediate` 是预期行为，不应改成静默等待。
- `createSkippedToolResult` 当前使用 `details:{}`，导致 downstream 只能看到 `isError=true` 和英文文本。
- 已运行聚焦契约测试：

```text
bun test packages/agent/test/agent-loop.test.ts --test-name-pattern "should skip remaining tool calls when steering is queued"

1 pass
106 filtered out
0 fail
```

### 3.2 false failure presentation

- 现有 `SyntheticToolResultDetails` 已有 `__synthetic:true`、`executed:false`、`source`。
- queued skip 没有复用该结构。
- `EventController` 对 Todo 的 `event.isError` 无条件显示 `Todo update failed`。
- `ToolExecutionComponent`、`ReadToolGroupComponent`、ACP mapper、commit terminal、HTML/share 等多处直接把 `isError` 映射为 failed/error。
- 正确 owner 是 agent-loop structured execution truth + coding-agent shared presentation classifier；禁止通过英文字符串识别。

### 3.3 handoff lineage

- handoff/branch 把 previous session file path 写入 `parentSession`；`fork()`/`forkFrom()` 写 session ID，字段语义混合。
- `agent://` 与 `history://` 的 disk fallback 根目录来自 process-global registry；新进程只有当前 Main，因此看不到旧 session artifacts。
- session files 通常位于 configured session root、repo 外；不能把 session lineage 编码为 repository-relative path。
- 正确 seam 是 session-scoped `ToolSession`/`ResolveContext`，当前 session roots 优先，global registry 仅作非-lineage fallback。

### 3.4 loading behavior

- 自动进入模型上下文：context files、always-apply rules 全文；普通 skills/rules 仅 metadata index。
- 大量完整 skill/rule/spec 内容来自模型主动 `read`，不是启动自动全文注入。
- 当前 `Read matching ... before proceeding` 过宽，容易触发批量预读。
- read ledger 会引入新 persistence/replay owner，并破坏 provider prompt-cache locality；设计明确拒绝。

### 3.5 tool card mapping

- exact `rule://oh-my-pi-catalog` 卡片显示 `git status` 没有重现，未找到 Bash output 进入 rule card 的代码路径。
- 已确认一个独立 defect：read end event 先于 component start 时，fallback 未重新执行 `readArgsCollapseIntoGroup`，可能把 `rule://` 结果送到未知 ReadGroup id，丢结果并留下空/未结算卡片。
- 只修这个可测 exactly-once defect；不把它冒充 exact swap 根因。

## 4. Goal Mode 实施顺序

1. **Agent-loop contract**
   - 扩充现有 `SyntheticToolResultDetails.source` closed union。
   - 仅 never-invoked pre-start path 写 `executed:false`。
   - started-aborted 保持 executed/aborted 语义。
   - provider tool call/result pairing 和必要 `isError=true` envelope 不变。

2. **Shared presentation classifier**
   - 建立 typed `running | succeeded | failed | aborted | skipped` classifier。
   - 先检查 structured synthetic details，再检查 `isError`。
   - 更新 EventController/Todo、ToolExecution、ReadGroup、transcript/history replay、ACP、commit terminal、collaboration、export/share、HTML。
   - adapter 在移除 details 前先 materialize safe presentation status。

3. **Session-scoped lineage**
   - 新写入使用 managed-session-root 校验后的 canonical session-file reference。
   - legacy path/ID 只读兼容；有界查找。
   - `ToolSession`/`ResolveContext` 携带 current session file 与 ordered lineage roots。
   - 深度、bytes、unsafe root、cycle、collision、missing/deleted 都 fail bounded；inline capsule 始终可用。
   - 两个同时存在的 top-level sessions 不得串读 lineage。

4. **Self-contained capsule**
   - 更新 `packages/agent/src/compaction/prompts/handoff-document.md`。
   - load-bearing findings 必须 inline。
   - `agent://`、`history://`、`artifact://`、`local://` 等 session-scoped URI 只能作为非必要 provenance；稳定 repo source 使用 repo-relative path，session artifact 使用 canonical session-store reference。

5. **Progressive loading prompt**
   - 同步修改默认与 custom system prompt。
   - 先至多一个 primary routing/lifecycle skill；domain rules 仅在目标路径已知后加载；当前 transcript 已有 immutable body 不重读；禁止 bulk-read index。
   - 不新增 runtime read ledger，不在每次 read 后重建 system prompt。

6. **Read end-before-start fallback**
   - 在 EventController 的 read lifecycle seam 重新执行 grouping policy。
   - 正确创建/持有 full 或 grouped component。
   - grouped/full result exactly once；未知 id 不得静默丢弃。

## 5. 验证与完成门禁

必须使用当前设计 §9 的完整矩阵，至少覆盖：

- queued steering、immediate mode、never-invoked pairing；
- started-aborted 与 real error 不被标成 skipped；
- Todo/Bash/Read live；
- TUI replay、ReadGroup；
- ACP、commit terminal、collaboration/export/share、HTML；
- provider pairing；
- fresh-process handoff；
- canonical lineage、legacy path/ID、unsafe root、cycle、collision、missing/deleted；
- two-session isolation；
- 两套 system prompt；
- read end-before-start grouped/full exactly once；
- exact card swap 的 reproduced/unreproduced 状态；
- 受影响包 `bun check`，禁止 `tsc`。

完成声明必须附 fresh output；单个 narrow test 不足以覆盖跨包 contract。

## 6. 工作树保护

本会话开始时已有用户工作：

- `packages/ai/test/openai-codex-stream.test.ts`
- `packages/coding-agent/src/workflow/identity-receipt.ts`
- `packages/coding-agent/src/workflow/runtime-invocation.ts`
- `packages/coding-agent/src/workflow/work-packages.ts`
- `packages/coding-agent/test/workflow/engine-quality-routes.test.ts`
- `packages/coding-agent/test/workflow/engine-work-packages.test.ts`
- `packages/coding-agent/test/workflow/identity-receipt.test.ts`
- `packages/coding-agent/test/workflow/runtime-invocation.test.ts`
- `packages/coding-agent/test/workflow/work-packages.test.ts`
- `docs/research-async-compaction.md`

本会话新增的稳定文档：

- `docs/superpowers/specs/2026-08-02-handoff-progressive-loading-and-skipped-tool-ux-design.md`
- `docs/superpowers/plans/2026-08-02-handoff-progressive-loading-and-skipped-tool-ux-subagent-review-round-1.md`
- `docs/handoffs/2026-08-02-handoff-progressive-loading-skipped-tool-ux-goal-mode-handoff.md`

下一会话不得 reset、checkout、clean、覆盖、删除或提交这些既有改动；未得到明确授权不得 commit/push。

## 7. 非目标与停止条件

- 不削弱 immediate steering。
- 不移除 provider pairing。
- 不新增顶层重复 `skipped` discriminator。
- 不使用英文文本匹配。
- 不新增 read ledger 或 per-read system prompt rebuild。
- 不使用 process-global lineage roots 代替 session-scoped context。
- 不把 session file 编码为 repo-relative path。
- exact card swap 没有 red-capable reproduction 时停止 mapping 修改。
- lineage 遇 unsafe root、depth/byte cap、cycle、collision、malformed、missing 时停止并返回 typed diagnostic。
- 当前没有 PASS Gate；不得把首轮 NEEDS_REVISION 或被取消的二次 review 描述成批准。
