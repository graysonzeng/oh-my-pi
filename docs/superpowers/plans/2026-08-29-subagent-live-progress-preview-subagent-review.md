# Design Review: Subagent live progress preview

- Date: 2026-08-29
- review_mode: host-native
- Reviewed Design: `docs/superpowers/specs/2026-08-29-subagent-live-progress-preview-design.md`
- Facts Brief: `docs/superpowers/specs/2026-08-29-subagent-live-progress-preview-facts-brief.md`
- design_author: sol
- design_author_identity: SolDesignAuthor (native agent_id unknown to parent; design_author=sol)
- reviewer native agent_id: GrokGate
- reviewer model: gateway/grok-4.6 xhigh
- implementation_authorization: design-only on the design doc; parent session later received a goal to continue implement after Gate
- authorization_source: 用户本轮要求调研其他开源 CLI 后给出最佳实现方案；明确可基于社区 PR #3821；未授权写代码。Grok 原作者卡住被取消后由 sol 从 facts brief 整篇重写。当前用户消息指定 reviewer=grok-4.6-xhigh（覆盖设计文档 handoff 里的 claude-opus-5-thinking-high）。

Reviewed Inputs (independently recomputed from raw file bytes; lowercase SHA-256; sorted by normalized repo-relative POSIX path):

```text
docs/superpowers/specs/2026-08-29-subagent-live-progress-preview-design.md	458438ac8a0ef941b77120f0167cdbfc721d01ea34ba0ad86efd0a7f85b4bd81
docs/superpowers/specs/2026-08-29-subagent-live-progress-preview-facts-brief.md	b98f750e22ce7c34eb8cb8d44306cd5a1a3f58ba4828b5ea3b5f36844d74c3c0
```

reviewed_revision: `d4d79ea354898244a5271c98b78d4c6844521bd81c05cfa7dee3865c007666a1`

Hash check vs parent packet: match (do not substitute parent values; independently recomputed).

Verdict: NEEDS_REVISION

## 1. 整体结论
- verdict: NEEDS_REVISION
- 方案 A（HUD + hub wait 各一条 compact tool 子行）仍是满足成功标准的更浅落地，且没有引入第二套 engine / thinking_delta / 三行 feed / Agent Hub rewrite / #2512 / #2762 / 新设置；但把 `JobSnapshot` 丢字段当成 hub 路径唯一丢失缝，漏掉了 detached spawn 把 `AgentProgress` 拷进 `latestDetails.progress` 时已经丢掉 `currentToolArgs` / `currentToolStartMs` 的上游 seam。按现文实现，`hub wait` 子行会缺 elapsed，并在无 `lastIntent` 时缺关键参数，不满足 §1.2。

## 2. 根因评审结论
- 适用性：适用（截图空 gist 可能出自采集 / 传输 / 渲染；设计正确要求根因分层）
- 成立性：**部分成立**
- JobSnapshot live-field loss vs recommended scheme：`snapshotJobs()` 只拷 `resolvedModel`、running renderer 只从 settled `resultText`/`errorText` 取 preview，确实是空 gist 的直接原因，也确实需要把 compact activity 穿过 `JobSnapshot` 再渲染。但推荐方案把 `latestDetails.progress[]` 当成已经拥有 facts brief 所列 live fields 的完整 `AgentProgress`；仓库里 detached job 的该数组来自 spawn 副本，副本在流式更新时**不拷** `currentToolArgs` / `currentToolStartMs`。HUD 走 executor channel，不受此限制；primary `hub wait` surface 受此限制。因此推荐方案与已确认根因**不完全匹配**：修 `JobSnapshot` 必要但对 hub 路径不充分。

Tagged evidence:
- **事实** `AgentProgress` 含 `lastIntent` / `currentTool` / `currentToolArgs` / `currentToolStartMs` / `recentTools` / `recentOutput`：`packages/coding-agent/src/task/types.ts:417-432`。
- **事实** executor 在 `tool_execution_start` 写入这些字段，`recentTools.unshift` 保留最近 5 条：`packages/coding-agent/src/task/executor.ts:1503-1542`。
- **事实** `thinking_delta` 等非 `text_delta` 被 drop：`packages/coding-agent/src/task/executor.ts:1652-1657`。
- **事实** progress ~150ms coalesce：`packages/coding-agent/src/task/executor.ts:1325`。
- **事实** HUD 读 `session.progress`（完整 executor snapshot via `TASK_SUBAGENT_PROGRESS_CHANNEL`），当前只画 id/role/description，上限 8：`packages/coding-agent/src/modes/interactive-mode.ts:506-566`；observer 赋值 `existing.progress = progress`：`packages/coding-agent/src/modes/session-observer-registry.ts:191-220`。
- **事实** `JobSnapshot` 无 live fields：`packages/coding-agent/src/tools/hub/types.ts:58-69`。
- **事实** `snapshotJobs()` 遍历 `latestDetails.progress[]` 但只拷 `resolvedModel`：`packages/coding-agent/src/tools/hub/jobs.ts:161-197`。
- **事实** `jobsRenderResult` running 主行 = icon/type/shimmer label/model/duration；preview 仅来自 `errorText`/`resultText`：`packages/coding-agent/src/tools/hub/jobs.ts:640-703`。
- **事实** `resultText`/`errorText` 仅在 job settle 时写入：`packages/coding-agent/src/async/job-manager.ts:257-263`。
- **事实** `hub wait` 500ms `onUpdate` 刷新 snapshot：`packages/coding-agent/src/tools/hub/index.ts:137`、`:465-473`。
- **事实** 同步 task renderer 已有 current-then-recent、`lastIntent ?? args`、>5s elapsed；`recentOutput` 仅 expanded：`packages/coding-agent/src/task/render.ts:966-990`、`:1106-1117`。`renderAgentProgress` 未 export：`:888`。
- **事实 / 设计漏检** detached spawn 把子 agent progress 拷进 job 副本时拷了 `currentTool`、`lastIntent`、`recentTools`，**没拷** `currentToolArgs`、`currentToolStartMs`：`packages/coding-agent/src/task/index.ts:1326-1334`。`buildAsyncDetails()` 再 `{ ...spawn.progress }` 写入 `latestDetails.progress`：`:993-1001`。
- **事实** 设计把根因结束在 snapshot/render：设计 `:56-58`、`:64-65`、`:100-102`。fail-closed 只写“若实现时发现缺字段再回订设计”：设计 `:142`，未把已存在的 spawn-copy seam 写进推荐方案。
- **推断** 按现文只改 `snapshotJobs`，`hub wait` 子行最多拿到 tool 名 + `lastIntent` + recent.args；current-tool 参数与 elapsed 仍缺失。
- **未矣** PR #3821 rebase 是否干净（设计已标未验证且不依赖 cherry-pick）。

## 3. 设计方案评审
- Reuse of `AgentProgress`、`renderSubagentHudLines`、`snapshotJobs`/`jobsRenderResult`、sanitizers：**成立**。canonical owner 仍是 `packages/coding-agent/`。HUD 扩 `renderSubagentHudLines`；hub 扩内部 `JobSnapshot` optional view-model + `jobsRenderResult` 子行。渲染要求 `replaceTabs` / `shortenPath` / `truncateToWidth` / `PREVIEW_LIMITS` / `TRUNCATE_LENGTHS`；这些 helper 存在于 `packages/coding-agent/src/tools/render-utils.ts:52-79,121-123,725-746` 与 `@oh-my-pi/pi-tui`。同步 `task` renderer 仅作 precedence 基准，不抽取 `renderAgentProgress`。`renderTreeList` 已支持 `string | string[]` 子行：`packages/coding-agent/src/tui/tree-list.ts:31-33,86-88`。
- Second-engine / progress bus / thinking_delta / 3-line feed / Agent Hub / #2512 / #2762 / new settings：**未错引入**。非目标在设计 `:32-38` 明确排除；仍用现有 ~150ms emit 与 500ms `hub wait` refresh；`AgentProgress` 不增 thinking storage；无新 channel / flag / 设置。
- Compact dual-surface 是否更浅充分落地：**是**。方案 A 每 agent 一行，直接填用户截图中的 `hub wait` 洞，密度对齐 Gemini collapsed 与 #3815 的 8–15 行约束；方案 B 的三行/`recentOutput` feed 没有被确认为必要。HUD-only 的 #3821 不能独立解决 primary wait surface（设计 `:64-65`，与 PR 三文件且不触 `tools/hub/` 的 facts 一致）。
- File-level detail only for recommended option：**成立**。§5 声明只展开方案 A；方案 B 仅短段对比。
- Tests：设计 `:159-175` 覆盖 snapshot-to-render、HUD current/recent/elapsed/no-activity、sanitization/width、settled compatibility、changelog `[Unreleased]`（`packages/coding-agent/CHANGELOG.md:3`）。**缺口**：未要求从真实 `#registerSpawnJob` / `forwardSyncProgress` 路径构造 `latestDetails`，若 test 直接塞满整 `AgentProgress` 会漏检上游丢字段。

## 4. Findings
### [HIGH] grounded/correctness: hub 路径的 live fields 在 snapshotJobs 之前已丢
**位置**: `packages/coding-agent/src/task/index.ts:1326-1334`（spawn `forwardSyncProgress` 字段清单）；`packages/coding-agent/src/task/index.ts:993-1001`（`buildAsyncDetails().progress`）；`packages/coding-agent/src/tools/hub/jobs.ts:168-186`（`snapshotJobs` 读的正是该数组）；设计 `:45,56-58,64-65,100-102,117`
**问题**: 设计认定 executor 已采集 current/recent，唯一丢失点是 `snapshotJobs()` 只拷 `resolvedModel`。仓库里 HUD 确实看完整 `AgentProgress`；`hub wait` 看的 `latestDetails.progress` 是 spawn 副本。该副本更新 `currentTool` / `lastIntent` / `recentTools`，不更新 `currentToolArgs` / `currentToolStartMs`。
**影响**: 按现文只改 `hub/types.ts` + `jobs.ts`，`hub wait` 子行无法稳定满足成功标准中的“关键参数”与“current tool >5s elapsed”；HUD 与 hub 两个 surface 会语义分叉。设计 `:142` 的 fail-closed 把已经可在仓库证实的 seam 推到实现期再发现。
**建议**: 修订方案 A 的文件级清单，把 `packages/coding-agent/src/task/index.ts` `#registerSpawnJob` / `forwardSyncProgress` 列为 hub 路径必要 owner：在现有拷贝清单上补 `currentToolArgs` 与 `currentToolStartMs`（并明确 tool_end 时清空与 HUD 同步）。测试必须走该 copy 路径或等价 fixture，禁止用完整 `AgentProgress` 直接塞进 `latestDetails` 代替。不要用 thinking_delta / 新 bus 绕过。

### [NOTE] completion: snapshot-to-render 验收未锁定 spawn-copy seam
**位置**: 设计 `:166-170,175`；`packages/coding-agent/test/job-model-badge-renderer.test.ts:88-99` （现有 snapshot 测试用 `{ progress: [{ id, resolvedModel }] }`）
**问题**: 验证计划要求“构造具有 live AgentProgress 的 running task job”，未要求经 `forwardSyncProgress` 丢字段后仍能渲出 args/elapsed。
**影响**: 表面绿的 renderer contract 仍会漏掉 hub 空 gist 的真实 transport。
**建议**: 与上一 finding 一起修订测试契约；不单独阻挡若 HIGH 已修正。

### [NOTE] grounded: handoff reviewer 仍写 claude-opus-5-thinking-high
**位置**: 设计 `:8,188,201`
**问题**: 本次 Gate 由用户/父包覆盖为 grok-4.6-xhigh；设计 handoff 未更新。
**影响**: 不影响方案正确性；下一轮恢复 prompt 会派错 reviewer。
**建议**: 修订设计时把 planned_reviewer 改为实际 Gate reviewer，或注明已被本次会话覆盖。

## 5. Alternatives / conciseness
未错误展开方案 B；未把 Codex 三行 feed / thinking_delta / Agent Hub / #2512 / #2762 / 新设置写进推荐落地。未引入第二套 progress engine。选 A 而不选 B 有明确约束（用户接受 #3821 式一行、#3815 高度、现有 500ms refresh）。缺陷是推荐方案的传输 owner 不完整，不是选错更深方案。

## 6. Next step
revise design

Parent persists this body. Do not implement until a subsequent Gate on the revised Inputs is PASS / PASS_WITH_NOTES.

---

# Design Review Round 2: Subagent live progress preview

- Date: 2026-08-29
- review_mode: host-native
- revision_round: 2
- Reviewed Design: `docs/superpowers/specs/2026-08-29-subagent-live-progress-preview-design.md`
- Facts Brief: `docs/superpowers/specs/2026-08-29-subagent-live-progress-preview-facts-brief.md`
- Round-1 artifact (read-only): `docs/superpowers/plans/2026-08-29-subagent-live-progress-preview-subagent-review.md`
- design_author: sol
- design_author_identity: SolDesignAuthor
- reviewer native agent_id: GrokGateR2
- reviewer model: gateway/grok-4.6 xhigh
- implementation_authorization: original_request=design-only; current_session_goal authorizes implement only after THIS Gate is PASS / PASS_WITH_NOTES
- authorization_source: 原始用户请求要求调研其他开源 CLI 后给出最佳实现方案；明确可基于社区 PR #3821；未授权写代码。当前会话目标仅授权在修订后的 Design Review Gate 判定 PASS / PASS_WITH_NOTES 后进入实现。Grok 原作者卡住被取消后由 sol 从 facts brief 整篇重写；round-1 Gate NEEDS_REVISION 后 sol 原位修订 spawn-copy seam。
- shadow-review: fail-open；architecture completed_no_finding；grounded/correctness/completion timeout。未等待；未把超时镜头当作 finding。

Reviewed Inputs (从文件原始 bytes 独立重算；lowercase SHA-256；按 normalized repo-relative POSIX path 排序；UTF-8 `<path>` + TAB + `<sha256>` + newline)：

```text
docs/superpowers/specs/2026-08-29-subagent-live-progress-preview-design.md	569b798c51c99be40a4c31b340594d4aa9d38d2b6044335ffca49db7b28f79b0
docs/superpowers/specs/2026-08-29-subagent-live-progress-preview-facts-brief.md	a0cf9a5f815543ac4de99bf08e38e004d0adfd4fc1f2ccadb2feb2b08c755693
```

reviewed_revision: `1496dee8019ce6292b6fbe3b2a4460288b4f2ab22b0db1e598e144fa6ef5aa1c`

Hash check vs parent packet: **match** (本身独立重算；与 parent `1496dee8019ce6292b6fbe3b2a4460288b4f2ab22b0db1e598e144fa6ef5aa1c` 一致)。
Round-1 reviewed_revision (`d4d79ea354898244a5271c98b78d4c6844521bd81c05cfa7dee3865c007666a1`) 已被本轮 Inputs 替代，仅作历史对照。

Verdict: **PASS_WITH_NOTES**

## 1. 整体结论

- verdict: **PASS_WITH_NOTES**
- 一句话：修订后的方案 A 把 round-1 HIGH 要求的 spawn-copy seam 写进了推荐落地：hub 路径的两次丢失都是必要 owner；HUD 仍读完整 executor snapshot；测试锁定 spawn-copy-to-render。仍是满足成功标准的更浅双-surface compact 子行；未引入 progress bus / thinking_delta / 三行 feed / Agent Hub rewrite / #2512 / #2762 / 新设置。不再阻挡实现。
- Round-1 HIGH：**CLOSED**。
- Round-1 NOTE（tests 未锁 spawn-copy）：**CLOSED**（设计 §6 `:171-181`）。
- Round-1 NOTE（handoff reviewer 仍写 claude-opus-5-thinking-high）：**CLOSED**（设计 `:8,:207` planned_reviewer=grok-4.6-xhigh）。

## 2. 根因评审结论

- 适用性：适用（截图空 gist 可出自采集 / 传输 / 渲染；设计正确要求根因分层）
- 成立性：**成立**（相对 round-1 的「部分成立」已修复）
- JobSnapshot live-field loss vs recommended scheme：修订稿把 hub 路径定为**两次**已确认丢失，而不是单一 snapshot/render seam。HUD 仍走完整 executor snapshot，不受第一次丢失影响。

Tagged evidence（仓库对证）：

- **事实** `AgentProgress` 含 `lastIntent` / `currentTool` / `currentToolArgs` / `currentToolStartMs` / `recentTools` / `recentOutput` / retry / inflight：`packages/coding-agent/src/task/types.ts:420-491`。
- **事实** executor 在 `tool_execution_start` 写入 `currentToolArgs` / `currentToolStartMs`，在 `tool_execution_end` 与 `currentTool` 一起清空：`packages/coding-agent/src/task/executor.ts:1507-1542`。`extractToolArgsPreview` 只按 key 优先截 60 字符、不调 `shortenPath()`：同文件 `:809-821`。
- **事实** thinking **不**入库：`message_update` 只保留 `text_delta`；其它 `assistantMessageEvent.type`（含 `thinking_delta`）直接 break：`packages/coding-agent/src/task/executor.ts:1644-1657`。
- **事实 / round-1 HIGH 仍可复现于仓库** detached spawn `forwardSyncProgress` 拷 `currentTool` / `lastIntent` / `recentTools` / `recentOutput` / retry，**不拷** `currentToolArgs` / `currentToolStartMs`：`packages/coding-agent/src/task/index.ts:1312-1334`。`buildAsyncDetails()` 再 `{ ...spawn.progress }` 写入 `latestDetails.progress[]`：`:993-1001`；`#registerSpawnJob` 传入同一 `spawn.progress` 对象：`:1013-1021`。
- **事实** HUD 不走该 copy：`TASK_SUBAGENT_PROGRESS_CHANNEL` 把完整 executor snapshot 赋给 `session.progress`：`packages/coding-agent/src/modes/session-observer-registry.ts`（`existing.progress = progress`）。`renderSubagentHudLines` 当前只画 id/role/description，上限 8：`packages/coding-agent/src/modes/interactive-mode.ts:520-566`。
- **事实** `JobSnapshot` 无 live fields：`packages/coding-agent/src/tools/hub/types.ts:58-69`。
- **事实** `snapshotJobs()` 遍历 `latestDetails.progress[]` 但只拷 `resolvedModel`：`packages/coding-agent/src/tools/hub/jobs.ts:161-197`。
- **事实** `jobsRenderResult` running 主行 = icon/type/shimmer label/model/duration；preview 仅来自 `errorText`/`resultText`：`packages/coding-agent/src/tools/hub/jobs.ts:633-705`。
- **事实** `hub wait` 500ms `onUpdate` 刷新 snapshot：`packages/coding-agent/src/tools/hub/index.ts:137`、`:465-473`。Pending call `jobsRenderCall` 是静态 status line；活动内容在 result frame：`packages/coding-agent/src/tools/hub/jobs.ts:540-543`。
- **事实** 同步 task renderer 已有 current-then-recent、`lastIntent ?? args`、>5s elapsed；`recentOutput` 仅 expanded：`packages/coding-agent/src/task/render.ts:966-990`、`:1106-1117`。`renderAgentProgress` 未 export：`:888`。
- **事实** 修订设计把两次丢失写进问题、范围、根因、推荐 owner、数据流和 fail-closed：设计 `:15,:28-29,:46,:55-60,:67,:92-94,:106-107,:122,:147,:171-181,:185`。
- **推断** 按现文实现后，hub wait 子行可稳定拿到 current-tool 参数与 >5s elapsed；HUD 与 hub 共享 selection invariant，不再因 spawn-copy 缺字段而分叉。
- **未验证** PR #3821 rebase 是否干净（设计 `:62-63` 已标且不依赖 cherry-pick）。

### Round-1 HIGH 关闭核对

Round-1 HIGH 要求：把 `task/index.ts` `#registerSpawnJob` / `forwardSyncProgress` 列为 hub 必要 owner；补 `currentToolArgs` / `currentToolStartMs`；明确 tool_end 清空；测试走 copy 路径，禁止把完整 `AgentProgress` 塞进 `latestDetails`。

| Round-1 要求 | 修订稿 | 状态 |
|---|---|---|
| spawn-copy 为必要 owner | 设计 `:28,:92-94,:122,:185` | 已落地 |
| 拷 args/start | `:93-94,:147` 直接赋值，禁止旧值 fallback | 已落地 |
| tool_end 清空 | `:28,:94,:147,:173` | 已落地 |
| `snapshotJobs` 仍保 liveActivity | `:29,:102-107,:122` | 已保留 |
| HUD 仍读完整 executor snapshot | `:46,:58,:67,:121` | 已明确 |
| 测试 spawn-copy-to-render | `:30,:113,:171-181` | 已锁定 |
| 不用 thinking_delta / 新 bus 绕过 | `:21,:34-38,:147,:188` | 已排除 |

旧文 fail-closed「若实现时发现缺字段再回订设计」已删除；现 `:147` 把缺 args/start 或 tool_end 未清空定义为**本方案实现失败**。

## 3. 设计方案评审

### 3.1 强制核查

- **两次 hub 丢失都在推荐方案里？** 是。(1) `forwardSyncProgress` 必须直接拷 `currentToolArgs` / `currentToolStartMs`，含 tool_end 清空：设计 `:28,:92-94,:147`。(2) `snapshotJobs` 仍要构造 compact `liveActivity`：`:102-107`。HUD 仍用完整 executor snapshot：`:121`。
- **复用 canonical owners？** 是。`AgentProgress`（不增 thinking 字段）、现有 ~150ms channel/registry、`renderSubagentHudLines`、`snapshotJobs` / `jobsRenderResult`、现有 sanitizer（`replaceTabs` / `shortenPath` / `truncateToWidth` / `PREVIEW_LIMITS` / `TRUNCATE_LENGTHS`）。仓库对应：`packages/coding-agent/src/tools/render-utils.ts:69-89,121-123,725-728`。
- **错误引入 progress bus / thinking_delta / 三行 output feed / Agent Hub rewrite / #2512 / #2762 / 新设置？** 否。非目标 `:33-40` 明确排除；方案 B 不入选；`:127-128` 无新配置/旗标。
- **compact dual-surface 仍是更浅落地？** 是。方案 A vs B：`:71-85`。A 每 agent 一行，填用户截图 `hub wait` 洞，密度对齐 Gemini collapsed 与 #3815 的 8–15 行约束。B 需要 `recentOutput` history 契约，当前请求没有该约束。HUD-only 的 #3821 不触 `tools/hub/`，不能独立解 primary wait surface。
- **文件级细节只展开方案 A？** 是。`:89` 「本节只展开方案 A」。B 仅一段对比，无文件清单。
- **测试覆盖 spawn-copy-to-render / HUD / sanitization / width / settled compatibility？** 是。HUD：`:165-170`。Hub：`:171-176,:181` 禁止把完整 `AgentProgress` 直接塞入 `latestDetails.progress[]`；fixture 必须从不含 args/start 的 job-owned progress 起步并执行等价 copy。Settled 互斥：`:175,:180`。

### 3.2 架构 / reuse

- canonical owner 仍是 `packages/coding-agent/`。
- HUD：扩 `renderSubagentHudLines`（`interactive-mode.ts:520-566`）。
- Hub transport：扩既有 `forwardSyncProgress` 字段清单（`task/index.ts:1312-1334`），不新增 channel。
- Hub view-model：`JobSnapshot` optional `liveActivity { tool, detail?, elapsedMs? }`（设计 `:102-104,:129-138`），不搬完整 `AgentProgress` / `recentTools` / `recentOutput`。
- Hub render：`jobsRenderResult` running 追加一条子行；settled 忽略 liveActivity，保留 `errorText`/`resultText` preview（设计 `:107,:124,:146`）。
- 不抽取 `renderAgentProgress`（未 export，`:888`）；两组 contract tests 锁同一 precedence。这是更浅选择，不是第二套 engine。

### 3.3 正确性 / fail-closed

- 缺 progress / 非-task / 无 tool：省略 `liveActivity`，不抛错、不伪造 thinking：设计 `:109,:142`。
- 缺 start timestamp 或负时差：仍显示 tool/detail，省略 elapsed：`:143`。
- tool_end 必须把 `undefined` 传进 job-owned progress，禁止 `?? oldValue`：`:94,:147`。与 executor `:1540-1542` 清空语义对齐。
- running live row 与 settled preview 互斥：`:107,:139,:175`。
- 滚动回退：撤 optional field + 两处子行；无 schema migration：`:148`。

### 3.4 完成度

- Tests：已有 `packages/coding-agent/test/subagent-hud-render.test.ts`、`job-renderer-preview.test.ts`；设计扩展而不新建测试堆。
- Changelog：`packages/coding-agent/CHANGELOG.md` `[Unreleased]`：设计 `:114-115`。
- Kill-switch：显式不新增 flag（非目标 `:38`）；回滚 = 撤 optional field。
- 模型可见 schema 不变：设计 `:49,:127`。`buildJobResult` running 文本仅 `- \`id\` [type] — label`，不含 live gist：`packages/coding-agent/src/tools/hub/jobs.ts:250-256`。Partial `onUpdate` content 为空字符串：`hub/index.ts:467-469`。与 #2762 非目标一致。

## 4. Findings

### Round-1 HIGH — CLOSED

**原 finding**: grounded/correctness: hub 路径的 live fields 在 snapshotJobs 之前已丢（`task/index.ts:1326-1334` / `:993-1001` / `hub/jobs.ts:168-186`）。

**本轮核对**: 仓库 seam 仍存在（见 §2），但推荐方案已把该 seam 列为必要 owner，并用 spawn-copy-to-render 测试 + fail-closed 锁死。不再阻挡。

### [NOTE] architecture: `liveActivity` 与 `resolvedModel` 同袋进入 `CoordinationDetails.jobs`

**位置**: `packages/coding-agent/src/tools/hub/types.ts:58-69`（`JobSnapshot`）；`packages/coding-agent/src/tools/hub/jobs.ts:275-277`（`buildJobResult` 把 `snapshotJobs()` 放进 `details`）；设计 `:102-104,:127-138`

**问题**: `JobSnapshot` 既是 TUI view-model，也是 `AgentToolResult<CoordinationDetails>` 的 `details.jobs` 元素。设计称其为内部 optional view-model、不改模型可见 schema。这与现有 `resolvedModel` 模式一致：TUI 用 details，模型看 `content` 文本。Running 的 model-facing 文本不包含 activity（`jobs.ts:250-256`）。

**影响**: 不破坏成功标准。若实现时把 `liveActivity` 拼进 `buildJobResult` 的 markdown `content`，会变成 model-facing progress，碰 #2762 非目标。

**建议**: 实现保持与 `resolvedModel` 同模式——只进 `JobSnapshot` / `jobsRenderResult`；不写入 `content` 行。渲染前 sanitizer 仍必须跑，因为 `extractToolArgsPreview` 不调 `shortenPath()`（`executor.ts:809-821`）。

P3。不阻挡。

### [NOTE] completion: 现有 `snapshotJobs` badge fixture 不能当 live-activity 正路

**位置**: `packages/coding-agent/test/job-model-badge-renderer.test.ts`（约 `:88-99`，`reportProgress(..., { progress: [{ id, resolvedModel }] })`）；设计 `:171-173,:181`

**问题**: 现有测试已经把缩水 progress 直接塞进 `latestDetails`。设计 §6 已禁止用完整 `AgentProgress` 覆盖第一次丢失；实现时不要把该 badge fixture 拷贝成 live gist 用例。

**影响**: 不修订设计也能落地；只是实现脚踏点。Round-1 同题 NOTE 已被设计正文关闭，本条仅作实现提醒。

P3。不阻挡。

## 5. Alternatives / conciseness

未错误展开方案 B。未把 Codex 三行 feed / thinking_delta / Agent Hub / #2512 / #2762 / 新设置写进推荐落地。未引入第二套 progress engine。选 A 而不选 B 有明确约束（用户接受 #3821 式一行、#3815 高度、现有 500ms refresh）。Round-1 的传输 owner 缺口已补全；本轮不再是选错更深方案。

HUD elapsed 可从完整 snapshot 的 `currentToolStartMs` 在每帧计算；hub `liveActivity.elapsedMs` 在 500ms snapshot 时结算。这是既有 refresh 周期的必然结果，不要求额外 timer，不升级为缺陷。

## 6. Next step

**implement** — Gate 连续性：当前 Inputs manifest 等于本轮 reviewed manifest。原始请求是 design-only；当前会话目标的条件式实现授权在本 Gate **PASS_WITH_NOTES** 且 continuity 成立后生效。

实现约束（不扩范围）：

1. `packages/coding-agent/src/task/index.ts` `forwardSyncProgress` 直接赋值 `currentToolArgs` / `currentToolStartMs`（含 `undefined` 清空）。
2. `snapshotJobs` 构造 optional `liveActivity`；`jobsRenderResult` running 子行 + settled 互斥。
3. `renderSubagentHudLines` compact 子行；tool label 进宽度预算；args 先 `shortenPath` 再截断。
4. Hub 测试必须经 spawn-copy-to-render；不要用 `job-model-badge-renderer.test.ts` 的缩水 progress fixture 冒充 live path。
5. `liveActivity` 只留在 TUI details / renderer，不写入 model-facing `content`。
6. Changelog `[Unreleased]`。
