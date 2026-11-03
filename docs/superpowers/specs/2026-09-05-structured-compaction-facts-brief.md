# Facts Brief: 结构保留压缩（Codex / Magic Compact 对照）与便宜模型异步执行

- Date: 2026-09-05
- Status: Facts only
- 本 brief 只记录已核验事实。推断标 `[INFERENCE]`。未知标 `[未知]`。
- 本 brief 不是设计正文。方案结论由 design author 提出。

## 0. 用户请求（本轮）

1. 把完整背景与方案落到 `~/tencent/oh-my-pi` 文档，供用户重新 review。
2. 额外判断：结构保留压缩等操作是否可用更便宜模型（例：`deepseek-v4-flash`）**异步执行、完全不阻塞主 agent**。

实现授权：本轮只写设计，不实现。`implementation_authorization = design-only`。

## 1. 已确认的 Codex 行为

配置入口：

```toml
[features.context_management]
experimental_mode = true
```

- `Feature::ContextManagement`，`stage: UnderDevelopment`，默认关。`experimental_mode` 即该 feature 的 `enabled`。证据：`codex-rs/features/src/feature_configs.rs`、`codex-rs/features/src/lib.rs`（FeatureSpec `key: "context_management"`）。
- 线程启动 `token_budget::apply_experimental_context`：资格全过则强制 `Feature::TokenBudget`，并设 `use_history_notes_extension = true`。证据：`codex-rs/core/src/session/token_budget.rs`、`codex-rs/core/src/session/mod.rs`。
- 资格：Codex 后端 `/backend-api/codex`、ChatGPT 登录、套餐 Plus/Pro/ProLite。API key / env token / AWS / Free / Enterprise 拒绝。
- TokenBudget 打开后：注入窗口 ID（first/current/previous）；工具 `new_context`、`get_context_remaining`；满窗或 `new_context` 时 **跳过摘要，直接 `start_new_context_window()`**。证据：`compact_token_budget.rs`、`session/turn.rs`、`tools/handlers/new_context_window.rs`。
- 恢复面是 Codex 云端：`alpha/history/v2/*`、`alpha/notes/v2/*`、`alpha/notes/v2/thread_hint`。没有该后端，换窗等于失忆。

## 2. 已确认的 oh-my-pi 现状

Canonical owner：`SessionMaintenance` + `@oh-my-pi/pi-agent-core/compaction`。

- 方法序默认 `["remote", "snapcompact", "handoff", "shake", "soft"]`。证据：`packages/coding-agent/src/session/compaction-methods.ts`、`docs/compaction.md`。
- `/clear` 写 `reset_boundary`，模型上下文从边界后重建，磁盘 JSONL 保留。证据：`session-manager.ts` `appendResetBoundary`、`session-context.ts`、`agent-session.ts` `resetSessionContext`。
- 已有 prune：`pruneToolOutputs` 把大 tool 结果换成 `[Output truncated - N tokens]`；superseded read / useless 另有占位。**占位不可按 id 再读回。** 证据：`docs/compaction.md`、`packages/agent/src/compaction/pruning.ts`。
- 仓库内无 `new_context` / `history.list_windows` / `notes.write_file`。
- Memory backends（`local` / `hindsight` / `mnemopi`）是跨会话记忆，不是按 window_id 翻旧对话。

### 已有异步 / 旁路压缩

- `compaction.asyncEnabled = true`（默认）。上下文进入 `[threshold − lead, threshold)` 时，对第一个 LLM-backed 方法（`remote` / `handoff` / `soft`）在 **branch snapshot + side session id** 上后台摘要；真正过阈值时瞬时提交。prefix 变了（新 compaction、reset_boundary、`/tree`）丢弃 armed 结果。证据：`docs/compaction.md` L422、`speculation-lead.ts`（lead = `clamp(threshold × 0.125, 8192, 32000)`）。
- `snapcompact` / `shake` 视为本地瞬时，**不走 speculation**。证据：`resolveSpeculationMethod()`。
- Overflow / incomplete-output recovery 必须在 retry 前拿到已提交的 compaction。后台 armed 结果可被这条路径消费，但 **recovery 本身不能“完全不等待”**：没有可用结果时仍要同步 compact。`[INFERENCE]` 来自 `docs/compaction.md` overflow/incomplete 语义。

### 已有便宜模型入口

- 每模型可配 `compactionModel`。`resolveCompactionConfiguredTarget` 优先于当前模型。证据：`role-models.ts`、`session-maintenance.ts` `resolveCompactionModelCandidates`。
- 候选链：`compactionModel` → 当前模型 → 全部 `MODEL_ROLE_IDS`（含 `smol` / `tiny` / `task`）→ 最大 contextWindow 兜底。证据：`session-maintenance.ts` L2120–2158。
- **没有**名为 `compaction` 的独立 role。Flash 若要当压缩模型，需配 `compactionModel` 或某个 role（常见 `smol`/`tiny`）。
- 既有调研：`docs/research-advisor-deepseek-v4-flash.md` 结论是 **Advisor 不要默认 Flash**（弱模型评审强主模型）。该结论针对侧边评审，**不能直接当作 summarizer 禁令**。压缩摘要与评审是不同任务。`[INFERENCE]`

## 3. 社区对照（非 OMP 源码）

- **Magic Context**（`@cortexkit/pi-magic-context`）：装上会关掉宿主 compaction；Historian/Dreamer 后台 LLM；每轮注入 `<session-history>`。Reddit 对比帖口径：比一次性 compact **更烧 token**，换可召回记忆。无账单对照。GitHub 有幽灵用户消息（#415）、记忆晋升按措辞重复（#335）。
- **Magic Compact**（`aerovato/magic-compact`，OpenCode 圈）：一次 `/magic-compact [N]`；用户原文保留；旧助手轮短摘要；tool 骨架留、肥输出裁掉并可 `read_omitted_content` 取回；压前备份、失败回滚。社区称比 Magic Context **更省**。不是 OMP 插件。
- OMP 仓库 / 官方市场 **没有** Codex 换窗或 Magic Compact 的同构实现。

## 4. 与本设计相关的缺口

OMP 已能压主窗口。缺的是 Magic Compact 那一类 **结构保留 + 可回读省略**，不是第二套 compaction 引擎，也不是 Codex 云端 history/notes。

确定性 prune 已存在，但省略不可寻址。助手轮短摘要仍要 LLM（或远程 compact）。`[INFERENCE]`

## 5. 便宜模型异步：事实边界

可确认：

1. 阈值路径已经能异步（speculation），主 turn 不需要等摘要完成。
2. 摘要模型已经可以不是主模型（`compactionModel` / role fallback）。
3. `deepseek-v4-flash` 在本机 omp 配置里当过 scout，未对本任务做过压缩质量 A/B。`[未知]`
4. Overflow/incomplete 在没有 armed 结果时仍会阻塞 recovery。
5. 完全不阻塞 **且** 保证 overflow 可恢复，两者不能同时在“首次越过阈值且从未投机”时成立。`[INFERENCE]`

## 6. 约束（给 author）

- 不新建平行 compaction 生命周期。Canonical owner 仍是 `SessionMaintenance`。
- 不默认关 `compaction.enabled`（那是 Magic Context 路线）。
- 不实现 Codex `new_context` 空窗，除非同时交付可回读历史（本轮不做云 API）。
- 不把 Flash 写死进代码；用现有 `compactionModel` / role。
- 记忆继续走 memory backend，不在本方案做 historian/dreamer。
- 方案最小充分：两方案都能达标时选更浅。只对推荐方案写文件级细节。
- 用户要的异步便宜模型必须在方案对比里拍板，不能只写“以后再看”。

## 7. 建议对比轴（author 可改表述，不可丢掉）

至少两个方案：

- **A（浅）**：在现有 `methodOrder` 增加结构保留压缩（确定性 prune+可回读 id + 可选助手轮短摘要）；投机路径复用 `asyncEnabled`；摘要模型走 `compactionModel`/`smol`，允许配 Flash。
- **B（深）**：Magic Context 式旁路引擎，关掉原生 compaction，后台持续压缩+记忆。

Codex 空窗不是对等方案，可写在非目标或作为明确不选。
