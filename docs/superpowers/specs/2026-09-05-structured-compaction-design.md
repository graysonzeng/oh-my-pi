# Design: 结构保留压缩（methodOrder 新方法 + 可回读省略）

- Date: 2026-09-05
- Status: Draft
- Scope: M
- design_author: grok
- design_author_identity: StructuredCompactionAuthor
- planned_reviewer: GPT-5.6-sol / subagent-sol
- implementation_authorization: design-only
- authorization_source: 用户 2026-09-05 要求把完整背景与方案落到 ~/tencent/oh-my-pi 供重新 review；并判断结构保留压缩能否用便宜模型（如 deepseek-v4-flash）异步、不阻塞主 agent。本轮只设计不实现。

## 1. 设计目标和范围

### 1.1 要解决的问题

长会话里真正占窗口的是大段 tool 输出和旧助手轮，不是用户原话。现有自动维护能把窗口压下去，但两条常见路径都会丢掉“还能按条取回”的结构：

- `pruneToolOutputs` 把大结果改成 `[Output truncated - N tokens]`，磁盘 JSONL 里原文一并被盖掉，模型不能按 id 读回。
- `remote` / `handoff` / `soft` 把切点之前的历史收成一份摘要；`shake` 虽可恢复，但是整包写到 `artifact://`，不是按 JSONL 条目 id 取回。

用户对照了 Codex `experimental_mode`（空窗 + 云端 history/notes）和 Magic Compact（保留用户原文、旧助手轮短摘要、tool 骨架、省略 IO 可取回）。要判断的是：OMP 要不要做一层结构保留压缩，以及这层能不能用便宜模型（例如已配好的 `deepseek-v4-flash`）异步跑、不挡住主 agent。

### 1.2 成功标准

- 对含有大段 tool 输出的 fixture，跑过结构保留压缩后，主窗口 token 低于未 prune 的原历史。
- 模型能凭占位里的 id，从磁盘 JSONL 读回被省略的那条 tool 结果。
- 结构保留压缩失败时，会话分支回到压缩前快照，不留下半截改写。
- `compaction.asyncEnabled` 下的投机摘要不阻塞当前直播轮；首次 overflow / incomplete 且没有已武装结果时，仍走 compact-then-retry。
- 宿主 `compaction.enabled` 保持开启；不引入 historian / dreamer，不关原生 compaction。

### 1.3 本次范围

- 在现有 `compaction.methodOrder` 增加一个方法值 `structured`，由 `SessionMaintenance` 分发。
- 确定性省略：大段 tool 结果变成带 id 的占位，原文留在同一条 JSONL 记录上，可用新工具按 id 读回。
- 可选：对切点前的旧助手轮做短摘要；摘要模型走现有 `compactionModel` → 当前模型 → `MODEL_ROLE_IDS`（含 `smol` / `tiny`）候选链。
- 投机路径复用 `compaction.asyncEnabled` 与现有 lead 带，不新开压缩生命周期。
- 默认方法序把 `structured` 插在 `shake` 之后、`soft` 之前；用户已显式写过的 `methodOrder` 不改写。

### 1.4 非目标

- 不实现 Codex `new_context` 空窗，不做 `history.list_windows` / `notes.write_file` / `alpha/history|notes/v2` 云端回读。本轮不做 Codex 云 API。
- 不走 Magic Context：不默认关 `compaction.enabled`，不引入 Historian / Dreamer，不每轮注入 `<session-history>`。
- 不把 `deepseek-v4-flash` 写死进代码，不新增名为 `compaction` 的 model role。
- 不承诺 overflow / incomplete 在“从未投机、也没有武装结果”时完全不阻塞。
- 不替代 `/clear`（`reset_boundary`）或 memory backend（`local` / `hindsight` / `mnemopi`）。
- 不新增 `compaction.structuredEnabled` 一类开关；是否启用只看 `methodOrder`。
- 不新写第二套 compaction 引擎，不改 snapcompact 成像，不把 shake 的 `artifact://` 整包恢复拆掉。

## 2. 背景与约束

Canonical owner 仍是 `SessionMaintenance` + `@oh-my-pi/pi-agent-core/compaction`。自动维护按 `compaction.methodOrder` 依次尝试，默认 `['remote', 'snapcompact', 'handoff', 'shake', 'soft']`（事实：`packages/coding-agent/src/session/compaction-methods.ts` L42–48；`docs/compaction.md` Settings and defaults；`packages/coding-agent/src/config/settings-schema.ts` `compaction.methodOrder` default）。

已有六条触发：手动 `/compact`、overflow recovery、incomplete-output recovery、成功轮后阈值、tool-loop 中途阈值、idle（事实：`docs/compaction.md` Triggers）。overflow / incomplete 在 retry 前必须拿到已提交的压缩；失败且未改写历史时，`TurnRecovery.#runRecoveryCompactionWithRollback` 把失败助手轮填回（事实：`packages/coding-agent/src/session/turn-recovery.ts` L950–971）。

阈值带投机：`compaction.asyncEnabled = true`（默认）。上下文进入 `[threshold − lead, threshold)` 时，对第一个 LLM 方法（现为 `remote` / `handoff` / `soft`）在 branch snapshot + side session id 上后台摘要；过阈值且武装结果仍有效则瞬时提交。lead = `clamp(threshold × 0.125, 8192, 32000)`（事实：`docs/compaction.md`；`packages/coding-agent/src/session/speculation-lead.ts`；`session-maintenance.ts` `maybeStartSpeculativeCompaction` / `deferThresholdCompactionToSpeculation`）。`snapcompact` / `shake` 视为本地瞬时，`resolveSpeculationMethod` 返回 `undefined`（事实：`compaction-methods.ts` L116–130）。prefix 因新 compaction、`reset_boundary`、`/tree` 变化则丢弃武装结果。

现有省略不可按 JSONL id 回读：`pruneToolOutputs` 把 `message.content` 换成占位并 `rewriteEntries()`（事实：`packages/agent/src/compaction/pruning.ts` L111–113、L406–419；`session-maintenance.ts` `#commitPrunedHistory`）。`shake` 把原文拼进一份 session artifact，占位写 `artifact://<id> (region N)`（事实：`session-maintenance.ts` L703–747）。`/clear` 只写 `reset_boundary`，磁盘 JSONL 仍在（事实：facts brief §2）。

便宜模型入口已存在，没有独立 `compaction` role：`resolveCompactionConfiguredTarget` 读每模型 `compactionModel`；`resolveCompactionModelCandidates` 顺序为 `compactionModel` → 当前模型 → 全部 `MODEL_ROLE_IDS`（`default` / `smol` / `slow` / `vision` / `plan` / `designer` / `commit` / `tiny` / `task` / `advisor`）→ 最大 `contextWindow` 兜底（事实：`packages/coding-agent/src/session/role-models.ts` L61–64；`session-maintenance.ts` `resolveCompactionModelCandidates`；`packages/coding-agent/src/config/model-roles.ts` `MODEL_ROLE_IDS`）。`docs/research-advisor-deepseek-v4-flash.md` 只约束 Advisor 不要默认 Flash，不能当成 summarizer 禁令（推断：facts brief §2）。Flash 做压缩摘要的质量未做 A/B（未知）。

约束（事实：facts brief §6）：不新建平行 compaction 生命周期；不默认关宿主 compaction；不实现无云端回读的 Codex 空窗；不把 Flash 写死；记忆继续走 memory backend。

## 3. 根因分析（按需）

### 3.1 是否需要根因分析

- 需要
- 理由：要不要做空窗、要不要旁路引擎、异步能不能“完全不阻塞”，都取决于现在缺的到底是“不会压窗口”还是“压完结构不可回读”。弄错成因会做成第二套引擎或不可恢复的空窗。

### 3.2 已确认事实

- OMP 已经能压主窗口：methodOrder、prune、shake、`/clear`、投机、`compactionModel` 候选链都在（证据：§2 所列文件）。
- 当前 prune 盖掉 JSONL 原文；shake 的恢复面是 artifact 文件，不是 session 条目 id（证据：`pruning.ts` L406–419；`session-maintenance.ts` L703–747）。
- Codex `experimental_mode` 满窗走 `start_new_context_window()`，恢复依赖 ChatGPT 套餐下的 `alpha/history/v2` 与 `alpha/notes/v2`；无该后端等于失忆（证据：facts brief §1）。仓库内无 `new_context` / `history.list_windows` / `notes.write_file`。
- Magic Context 会关宿主 compaction，后台 Historian/Dreamer 持续烧 token；Magic Compact 是 OpenCode 圈一次性结构保留，不是 OMP 插件（证据：facts brief §3）。
- 投机只覆盖阈值带；overflow / incomplete 在没有武装结果时仍要同步 compact（证据：`docs/compaction.md` overflow/incomplete；`session-maintenance.ts` `runAutoCompaction` 对 overflow/incomplete 强制 inline）。

### 3.3 未确认假设

- `deepseek-v4-flash` 做旧助手轮短摘要的质量未知；本机只确认它做过 scout，未做压缩 A/B（未知：facts brief §5.3）。
- 社区称 Magic Compact 比 Magic Context 更省，OMP 仓库没有账单对照（未知）。
- “完全不阻塞且保证 overflow 可恢复”在首次越过阈值且从未投机时不能同时成立（推断：facts brief §5.5）。

### 3.4 对设计的影响

- 缺的是结构保留 + JSONL 可寻址省略，不是第二套生命周期，也不是 Codex 云端 history/notes。
- 空窗在没有云端回读时不可选。
- 旁路引擎（关宿主 compaction + historian）能压窗口，但直接打非目标，且更烧。
- 异步只能复用已有投机带；overflow 无武装结果时必须允许阻塞 compact-then-retry。便宜模型只作为 `compactionModel` / role 链上的可配 summarizer。

## 4. 方案对比

### 4.1 方案 A

- 核心思路：在现有 `methodOrder` 增加 `structured`。一次原子 pass：先按现有 prune 窗口做带 id 的确定性省略（原文写在同一 JSONL 条目上），必要时对旧助手轮用现有 summarizer 做短摘要。投机复用 `asyncEnabled`；摘要模型复用 `compactionModel` / `smol` / `tiny` 链，允许用户把 Flash 配成 summarizer。失败则整枝回滚，再交给 methodOrder 下一个方法。宿主 compaction 保持开启。
- 优点：复用 `SessionMaintenance`、投机、候选链、prune 窗口、失败回滚；用户原文和 tool 骨架还在窗口里；省略可按 id 从 JSONL 读回；默认用户能吃到，已自定义 `methodOrder` 的不受影响。
- 缺点：旧助手轮短摘要质量随 summarizer 变化；Flash 效果未验证。确定性省略立刻降 token，LLM 段失败会连同已算好的省略一起回滚后改试下一个方法。
- 适用前提：接受“阈值带可不阻塞，overflow 无武装结果时仍可能等一次 compact”。

### 4.2 方案 B

- 核心思路：Magic Context 式旁路。关掉宿主 `compaction.enabled`，另起后台 Historian/Dreamer 持续压缩并往每轮塞记忆块。
- 优点：主 agent 表面上很少被压缩打断；跨轮记忆 denser。
- 缺点：第二套生命周期，和 `SessionMaintenance` 并行；默认关宿主 compaction（facts brief 禁止）；社区口径更烧 token；已知幽灵用户消息、记忆晋升重复；本仓库没有该插件的同构实现，要新做一整层。
- 适用前提：只有在已确认“必须关原生 compaction 才能达标”时才成立。本任务验收明确要求宿主 compaction 保持开启，这条前提不成立。

Codex 空窗不是对等方案：没有 `alpha/history|notes/v2` 就是失忆，列入非目标，不展开实现。

### 4.3 选型结论

- 选择：方案 A
- 理由：A 和 B 都能把主窗口压下去，但 B 关宿主 compaction、另做 historian，验收与约束都不允许。两方案都能达标时选更浅落地：一个新 `methodOrder` 值，仍由 `SessionMaintenance` 拥有。

便宜模型与异步拍板（本项必须在对比里定，不留到以后）：

- 可以：把便宜模型（包括用户配置的 `deepseek-v4-flash`）当作 summarizer，走现有 `compactionModel` → 当前模型 → `MODEL_ROLE_IDS` 链；阈值带复用 `asyncEnabled` 投机，不挡直播轮。
- 不可以：把 Flash 写死；也不可以宣称“完全不阻塞主 agent”。overflow / incomplete 在没有有效武装结果时仍 compact-then-retry，recovery 会等这次压缩结束。
- 首次冲过阈值且从未投机时，“完全不阻塞”和“overflow 一定可恢复”不能同时成立（推断）。阈值带内的 grace（`deferThresholdCompactionToSpeculation`）只推迟阈值维护，不取消 overflow 路径。

## 5. 详细方案

### 5.1 核心思路

`structured` 是 methodOrder 里的一个方法，不是新引擎。行为分成两段，一次提交：

1. **确定性省略（必做）**：在现有 protect / minimum-savings / 保护工具窗口内，把大段 tool 结果的 LLM 可见内容换成带 session 条目 id 的占位；原文保存在同一 JSONL 条目上。用户原文、tool call 骨架、近期 protect 窗口不动。
2. **旧助手轮短摘要（overflow 不做；其它 reason 在省略后仍高于恢复带时做）**：用现有 `compact` / `completeSimple` summarizer 和 `SUMMARIZATION_SYSTEM_PROMPT` 家族，把切点前的旧助手轮收成短摘要，写回那些助手消息；不把整段历史藏进 `CompactionEntry` 切点之后（那样会失去结构）。摘要模型只走 `resolveCompactionModelCandidates`，不写死 Flash。

提交形态与 `shake` 同类：原地改写 branch + `rewriteEntries()`，不强制追加 `CompactionEntry`。需要切点摘要时仍可走后续 `soft` / `remote`。失败则 `restoreState(pre-pass snapshot)`，再 `methodIndex + 1`。

投机：`structured` 的 LLM 段与 `soft` 一样可武装。确定性段在 snapshot 上算好，和短摘要一起作为补丁武装；apply 时校验 snapshot leaf，后到的轮次原样接在后面。本地瞬时的纯省略若不足以需要 LLM，才值得投机；若 methodOrder 里 `structured` 排在第一个 LLM 方法，`resolveSpeculationMethod` 返回 `structured`。

### 5.2 关键数据流 / 控制流

1. `runAutoCompaction` 按 `resolveCompactionMethodOrder` 取下一个可用方法。`structured` 对 overflow 也可用（不像 `handoff`）；不要求 vision（不像 `snapcompact`）。
2. 若该方法是 `structured` 且已有有效武装结果：校验 `#armedSpeculationValid`（snapshot leaf 仍在路径上，其后无 `compaction` / `reset_boundary`），把补丁写进 live branch，`rewriteEntries()`，重建 LLM 上下文。
3. 若无武装结果：`#capturePruneRollbackSnapshot()`（已有深拷贝）→ `#runAutoStructured`：
   - 用与 `#pruneToolOutputs` 相同的 protect / `keepBoundaryId` / cache-warm 规则收集受害者；已 `prunedAt` 的跳过，避免和 shake/prune 打架。
   - 对每条受害者：`omittedOriginal = content`，`content = 占位(id=entry.id, tokens)`，`prunedAt = now`。
   - `reason !== 'overflow'` 且省略后仍高于恢复带：对 `prepareCompaction` 切点之前的旧助手轮调用现有 summarizer（候选链、`#compactWithFallbackModel` 的认证/重试语义复用）；overflow 跳过 LLM，以免用溢出输入再打一轮。
   - 估算 token 仍不够：回滚，返回 `fallback`，`runAutoCompaction(..., methodIndex + 1)`，与 shake 相同。
   - 足够：`rewriteEntries()`；失败则 `restoreState`，方法失败。
4. 阈值路径：进入 lead 带时 `maybeStartSpeculativeCompaction`；`resolveSpeculationMethod` 若得到 `structured`，`#startSpeculationRun` 在 snapshot 上跑同一套 transform，**不写盘**，结果放进 `SpeculationRun.armed`。直播轮继续。过阈值且武装有效则步骤 2 瞬时提交。
5. 单轮跳过阈值但未武装：`deferThresholdCompactionToSpeculation` 仍可把阈值维护推迟到 grace 带；overflow 不走这条 defer，没有武装就同步 compact。
6. 模型看到占位后调用 `read_omitted_content`；工具用当前 session 的 JSONL / in-memory entries 按 `entry.id` 读 `omittedOriginal`，失败闭（找不到、无原文、非本 session 就报错，不编造）。该工具结果列入 prune/shake 保护，避免再省略一次。
7. 手动 `/compact` 的 method 选择必须能落到 `structured`（与自动 walk 对齐），不能只认 `remote` / `snapcompact` / `soft`。

### 5.3 接口 / 配置 / 数据结构变更

只列推荐方案会改到的路径。

**`packages/coding-agent/src/session/compaction-methods.ts`**

- `COMPACTION_METHOD_CHOICES` 增加：
  - `value: "structured"`
  - label：Structured compaction
  - description：Keep user text and tool-call skeletons; omit large tool IO with recoverable JSONL ids; optionally short-summarize old assistant turns
- `DEFAULT_COMPACTION_METHOD_ORDER` 拟议为 `['remote', 'snapcompact', 'handoff', 'shake', 'structured', 'soft']`。已写在用户配置里的 `methodOrder` 不迁移改写。
- `STRATEGY_BY_COMPACTION_METHOD['structured']` 使用 `'context-full'` 且 `remoteEnabled: false`，仅当 LLM 段调用现有 `compact()` / summarizer 时复用引擎；确定性段不经过 snapcompact/shake 引擎分支。
- `resolveSpeculationMethod` 返回值并入 `'structured'`：第一个可用方法若是 `structured` / `remote` / `handoff` / `soft` 则返回它，`snapcompact` / `shake` 仍跳过。

**`packages/coding-agent/src/session/session-maintenance.ts`**

- `runAutoCompaction` 在 shake 特判旁增加 `structured` 特判：`#runAutoStructured`，失败 fallback 下一个 method。
- `#startSpeculationRun` / `#runSpeculation` 的 method 联合类型并入 `'structured'`。武装载荷是“条目补丁”（省略 + 可选助手短摘要），不是必须写 `CompactionEntry`。
- `#claimArmedSpeculation`：`snapcompact` 仍忽略武装 LLM 结果；`structured` 消费武装补丁。
- 复用 `#capturePruneRollbackSnapshot` / `restoreState`；不新做一套 snapshot 类型。
- `#getCompactionModelCandidates` 原样给 LLM 段用。不出现 `deepseek-v4-flash` 字面量。

**`packages/agent/src/compaction/pruning.ts`**

- 扩展现有 prune，不新写第二套收集器。增加 addressable 模式：命中后写入 `omittedOriginal`，占位含 `entry.id`，保留 `prunedAt`。
- 保护 `read_omitted_content`（及对该工具结果的再省略），与 `skill` / `isArtifactRecoveryToolResult` 同类，避免省略恢复结果再生成省略。
- 默认 `protectTokens` / `minimumSavings` / `MIN_PRUNE_TOKENS` 不变。superseded / useless 仍用现有 notice，不假装可回读（它们本来就无信息或已被更新读取替代）。

**`packages/ai/src/types.ts`**

- `ToolResultMessage` 增加可选 `omittedOriginal?: (TextContent | ImageContent)[]`。JSONL 经现有 `rewriteEntries()` 写出。LLM 路径继续读 `content`（占位）；恢复路径读 `omittedOriginal`。

**新模块（一个）：`packages/coding-agent/src/session/omitted-content.ts`**

- 占位文案的唯一格式（拟议）：`[Omitted ~<n> tokens — id=<entry.id> — use read_omitted_content]`。
- 按 id 查找：当前 branch 上 `type === 'message'` 且 `id` 匹配的 toolResult，返回 `omittedOriginal`。
- `ReadOmittedContentTool`（`AgentTool`）：参数 `{ id: string }`，approval `read`。找不到或没有 `omittedOriginal` 则 `isError`。
- 在 `packages/coding-agent/src/tools/builtin-names.ts` 与 `packages/coding-agent/src/tools/index.ts` 的 `BUILTIN_TOOLS` 注册 `read_omitted_content`。不新开工具框架。

**`packages/coding-agent/src/config/settings-schema.ts`**

- 不新增 setting key。`compaction.methodOrder` 的 `options` 已引用 `COMPACTION_METHOD_CHOICES`，UI 随 choices 出现 `structured`。`default` 随 `DEFAULT_COMPACTION_METHOD_ORDER` 变化。不增加 `structuredEnabled`、不增加独立 compaction role。

配置语义：

- 启用：把 `structured` 放进 `compaction.methodOrder`（默认序已包含）。
- 异步：`compaction.asyncEnabled`（默认 true）。
- 便宜 summarizer：给主模型配 `compactionModel`，或把 `modelRoles.smol` / `tiny` 指到该模型。Flash 只是合法候选，不是内置默认。

### 5.4 错误处理与回退策略

- 磁盘 `rewriteEntries` 失败：`restoreState` 预 pass 快照，live messages 重建，方法记失败，methodOrder 前进。与 `#commitPrunedHistory` 相同 fail-closed。
- LLM 短摘要失败、空摘要、认证失败：整次 `structured` 回滚（含已算的省略），再试下一个方法。不留下“省略成功但摘要半截”。
- 投机失败：现有 `logger.debug` + 清 `#speculation`；直播轮不受影响。后续 overflow 若仍无武装结果，同步 compact-then-retry。
- `read_omitted_content`：id 未知、条目不是 toolResult、无 `omittedOriginal`（含旧式 destructive prune）→ 错误返回，不回退会话。
- 未持久化 session（无 JSONL 文件）：省略仍可在内存条目上进行；恢复工具读内存 branch。若进程退出则与现有未持久化会话一样不保证磁盘回读。
- `session_before_compact` 扩展仍禁止投机（现有语义），以免旁路 veto。

### 5.5 风险与缓解

- 风险：Flash / 弱 summarizer 把旧助手轮摘要写错。
  - 缓解：不写死 Flash；空/失败摘要触发整次回滚并 fallback 到 `soft`/`remote`。确定性省略本身不依赖 LLM，overflow 路径只走确定性段。
- 风险：JSONL 同时存占位和 `omittedOriginal`，文件变大。
  - 缓解：只对实际省略的 tool 结果写副本；不把全文再抄到 artifact。这是“能从 JSONL 读回”的直接代价。
- 风险：与 shake/prune 重复省略。
  - 缓解：跳过已 `prunedAt`；恢复工具受保护；默认序 `shake` 在前，`structured` 只处理剩下的大结果。
- 风险：有人以为异步等于 overflow 也不等。
  - 缓解：文档与实现都保持 overflow/incomplete inline；无武装结果就同步 compact。
- 风险：手动 `/compact` 走老选择器漏掉 `structured`。
  - 缓解：手动与自动共用 method 可用性判断；`structured` 与 shake 一样特判。

## 6. 验证计划

不在本轮实现。实现后最小充分验证如下，全部对准 §1.2。

- **主窗口 token**：fixture 含若干超过 `MIN_PRUNE_TOKENS` 的 tool 结果；`methodOrder: ['structured']`；比较省略前后 `estimateStoredContextTokens` / tokenizer 合计，必须下降。
- **JSONL 回读**：省略后打开 session JSONL，对应 `type: 'message'` 行同时有占位 `content` 与 `omittedOriginal`；对 agent 调 `read_omitted_content` 传入该 `id`，返回原文。人为删掉 `omittedOriginal` 的行必须报错。
- **失败回滚**：在 `rewriteEntries` 或 summarizer 注入失败，断言 branch 条目与 live messages 等于 pass 前 snapshot（沿用 `#capturePruneRollbackSnapshot` 测法）。
- **投机不挡直播轮**：`asyncEnabled: true`，把上下文推入 lead 带；断言直播 `prompt` 在 `speculationState === 'running'` 时仍能结束；武装后下一次阈值维护走 `#claimArmedSpeculation`，不再打 summarizer。
- **overflow 无武装结果**：清空 `#speculation`，注入 overflow；断言走 `runRecoveryCompactionWithRollback` 且在 retry 前完成一次 compact（允许阻塞）。有有效武装补丁时 overflow 可消费它。
- **宿主 compaction 仍开**：默认 `compaction.enabled === true`；过程中不出现 historian/dreamer，不注入 `<session-history>`。
- **候选链**：给模型配 `compactionModel` 为 registry 中的便宜模型，断言 LLM 段请求打到该模型；代码与默认配置都不出现 `deepseek-v4-flash` 字面量。
- **回归**：`resolveSpeculationMethod` 在 `shake`/`snapcompact` 打头时仍为 `undefined`；显式旧 `methodOrder` 不含 `structured` 时行为与现在一致。

Flash 摘要质量不做本轮验收（未知）；用户若要 Flash，只通过配置接入。

## 7. 关键决策摘要

- 做结构保留压缩，做成 `methodOrder` 的 `structured`，owner 仍是 `SessionMaintenance`。
- 不做 Codex 空窗，不做 Magic Context 旁路引擎。
- 省略原文留在 JSONL 同一条目的 `omittedOriginal`，用 `read_omitted_content` 按 `entry.id` 读回；不把这条恢复面接到 shake 的整包 `artifact://`。
- 默认序：`remote → snapcompact → handoff → shake → structured → soft`。用户自定义序不改写。
- 便宜模型：复用 `compactionModel` / `smol` / `tiny` 链，允许把 Flash 配成 summarizer，禁止写死。
- 异步：复用 `compaction.asyncEnabled` 投机。直播阈值带可不阻塞；overflow / incomplete 没有武装结果时仍 compact-then-retry。“完全不阻塞”为假。
- 失败整次回滚到 pre-compact 分支，再交给下一个 method。
- 不新增 feature flag、compaction role、historian/dreamer。

## 8. Handoff

### 8.1 同会话继续
宿主原生路径：`按 subagent-delegation 触发只读 GPT-5.6-sol / subagent-sol（优先与 grok 异模型；author 为 grok 时不可回退到 grok；reviewer 不可用则 claude-opus-5-thinking-high，再主 agent 同模型）。`

### 8.2 新会话恢复 prompt
```text
请读取完整设计输入集合（docs/superpowers/specs/2026-09-05-structured-compaction-design.md；docs/superpowers/specs/2026-09-05-structured-compaction-facts-brief.md），生成按 normalized path 排序的 path + SHA-256 `Reviewed Inputs` manifest，并计算 `reviewed_revision`；pre-review handoff 不伪造 digest。设计元数据：design_author=grok；implementation_authorization=design-only；authorization_source=用户 2026-09-05 要求把完整背景与方案落到 ~/tencent/oh-my-pi 供重新 review；并判断结构保留压缩能否用便宜模型（如 deepseek-v4-flash）异步、不阻塞主 agent。本轮只设计不实现。。
使用起草前选定的只读 GPT-5.6-sol / subagent-sol 执行独立 Design Review（默认 GPT-5.6-sol / subagent-sol；优先与全部内容作者异模型；author 为 grok 时不可回退到 grok；reviewer 不可用则 claude-opus-5-thinking-high，再主 agent 同模型，并记录 review_fallback）；将完整 review artifact 持久化到 docs/superpowers/plans/2026-09-05-structured-compaction-subagent-review.md。按宿主记录 review_mode=host-native、author/reviewer native agent_id、model、verdict、授权来源与证据。
若文档包含根因分析，请一并核对根因判断、证据与设计方案是否一致。
评审结论必须为 PASS / PASS_WITH_NOTES / NEEDS_REVISION / NEEDS_REDESIGN 四选一，并附可复查证据；禁止作者自审。
NEEDS_REVISION 时第一次由原 author 修订当前设计；同一路径连续第二次 NEEDS_REVISION 按 subagent-delegation 僵局翻转（评审模型改写，原作者改审，只一次）。NEEDS_REDESIGN 时回到 design-brainstorm 重做方案。正文变更后均须重新执行 Gate，且在通过前不得实现。
PASS/PASS_WITH_NOTES 后，current Inputs manifest 等于 reviewed manifest 或存在覆盖全部输入的有效 Gate Continuity Note，且 implementation_authorization=authorized，才继续 design-implement；design-only 必须停止。
Review 后输入变化由未参与 author/reviewer/正文修改/implementation 的主协调者按 handoff 规则分类；非实质变化持久化覆盖完整 manifest 的 Gate Continuity Note，实质、不确定、遗漏输入或角色未分离时重跑 Gate。
```
