# Facts Brief: omp harness 质量优先、无效 token 与异常执行

- Date: 2026-08-23
- Status: Evidence for design author (not a design)
- Scope: L
- Coordinator: Main (this session)
- Does not choose a solution. Author must treat listed items as facts vs inference vs unknown.

## 0. 用户目标（不可缩范围）

两份目标，质量优先于省 token：

1. 在不影响任务完整质量的前提下，优化/简化 omp 的 prompt、工具等 harness 模块，提升完成质量并降低无效 token。
2. 分析近期任务历史中的 bug 与异常：长时间停顿、无输出、以及 grok-4.6 thinking 思维链重复。结论先落文档方案，再优化并验证。

原始请求已授权：设计 → Design Review Gate → 实现 → 验证。

## 1. 已确认事实

### 1.1 近期会话（本机 `~/.omp/agent/sessions/`，2026-08-22–23）

抽样方法：解析 jsonl 的 `message.role=assistant` 的 `model` / `stopReason` / `ttft` / `duration` / `usage` / `content[]`。不是全量 21 天 284 个 jsonl 的完整时间账。

| 会话 | 体量 | 主模型 | 观察 |
|---|---|---|---|
| sr_report `2026-08-22T15-25-00-298Z` | 105MB / 11312 行 / 1694 asst | grok-4.6 869 + gpt-5.6-sol 825 | usage_in 11.4M / usage_out 1.27M；thinking 1521 块 / 415k 字；ttft≥60s 仅 2 次；max_ttft 84s；max_dur 237s；stop 以 toolUse 为主；无 `thinking-loop-redirect` / `tool-call-loop-redirect` 注入 |
| sr_report `2026-08-23T11-28-38-774Z` | 40MB / 2619 行 | gpt-5.6-sol 458 | promptTokens p50 155k / p90 216k / max 237k；ttft p50 6s / p90 16s / **max 384s**；duration max 399s；1 次 Codex websocket 1006 |
| starrocks-update-tools `2026-08-22T17-23-47-665Z` | 11.4MB / 2525 行 | grok-4.6 359 | provider=`gateway` api=`openai-completions`；thinkingSignature 全部为字段名 `"reasoning_content"`（215 次）；promptTokens p50 181k / max 351k |
| orca `2026-08-22T15-55-07-089Z` | 14.3MB | grok-4.6 286 + sol 156 | grok thinking 重复句在单块内出现 3–17 次（见 §1.3） |
| oh-my-pi `2026-08-23T12-03-46-720Z` | 1.76MB | grok-4.6 49 | thinking 48 块 / 25k 字；ttft max 90s |
| oh-my-pi `2026-08-22T15-18-49-719Z` | 2.78MB | grok-4.6 93 | 1 次 socket 意外关闭，duration 138s |

旧分析 `docs/long-session-latency-analysis.md`（2026-08-03，886 会话 / 活跃 306.6h）结论仍适用作背景：**耗时主因是模型 gen+TTFT，其次 hub 空等、失败重跑、eval 门禁、web_search**。本轮新证据补上 grok-4.6 作为当前主会话模型后的 thinking 重复与“无输出”合同缺口。

HistoryScout（独立只读，2026-08-05..08-23）补充、与本 brief 抽样不冲突的事实：

- sr_report 08-22T15:25：墙钟约 20h / 65 prompts；goal-budget 记录 606920/180000 tokens（超预算是记录事实，不证明 goal 工具本身泄漏）。
- 同一会话 06:51–07:15 约 24 分钟无 assistant 输出空窗；07:16:06–11 连续 3 次 curl exit 28（超时）。空窗成因未从 jsonl 单独证明（可能是模型长 thinking、hub 等待或用户侧空闲）。
- 抽样范围内 `stopReason` 为 `error`/`length` 的次数为 0（对比 08-03 文档 starrocks `error=108`）；abort 几乎全是 `Interrupted by user`、0 token。
- 约 15 个被检 jsonl **没有** `compaction` 事件；useless/superseded elision 标记存在。
- oh-my-pi 08-22T15:18 一条 grok 消息 `contextSnapshot`：total 22733 / nonMessageTokens 19447（约 85% 为 system/non-message）。这是**短会话早期轮**的固定税，不能外推到 200k+ 长会话。
- HistoryScout 用 20/30 字 back-reference 三重重复扫描若干 grok thinking **未**命中 verbatim 循环。这与 §1.3 句级 `Counter` 命中不矛盾：方法更严（要求连续回指同一短窗三次），漏掉同句在块内非相邻重复。两种扫描结果都保留。

### 1.2 Thinking-loop guard 不覆盖 Grok

- Owner：`packages/ai/src/utils/thinking-loop.ts`。
- `isLoopGuardedModel` 只对 Gemini（含 OpenAI-compat 的 `enableGeminiThinkingLoopGuard`）和 id/provider 含 `deepseek` 的模型返回 true。`loopGuard.enabled=true` **不能**把其它模型加进去（测试明确：`other` + `enabled:true` 仍为 false）。
- 检测器本身不绑定家族：verbatim tail（250 字窗口）、near-dup segment（trigram Jaccard≥0.8，warm-up 8 段、cluster≥4）、progress-lexicon stall（novelty≤0.2 连续 8 段）。命中后发空 content + `AIError.Flag.ThinkingLoop` + `"stream stall"` 文案，session `TurnRecovery` 丢弃该轮并注入 `thinking-loop-redirect.md`。
- 接线：`packages/ai/src/stream.ts` `withGeminiThinkingLoopGuard` 包所有 dispatch。Grok 在此是透明 pass-through。
- Settings：`model.loopGuard.enabled` 默认 true，`checkAssistantContent` 默认 true。对 Grok 无效果，因为模型门没开。
- 校准语料注释写明 novelty 阈值来自 536k **非 Gemini** reasoning 块；检测器不是 Gemini 专用启发式。

### 1.3 Grok thinking 重复：两类，只修了一类

**A. 传输层累计快照（已修）**

- `packages/catalog/src/compat/openai.ts`：`reasoningDeltasMayBeCumulative` 在 `provider==="gateway"` 且 id 匹配 `^grok-4\.6(?:$|[-_.])` 时为 true。
- `packages/ai/src/providers/openai-completions.ts`：`source==="cumulative"` 时只 emit 相对上一快照的 suffix。
- 测试：`packages/ai/test/gateway-grok-reasoning.test.ts`（`["The user wants", "The user wants me to fix", ...]` → 只留下最终快照）。
- Responses API 路径 **没有** `reasoningDeltasMayBeCumulative` 消费（`openai-responses.ts` 无匹配）。当前抽样 grok 会话 api 均为 `openai-completions`。

**B. 语义/句级重复（未修，本轮会话可见）**

对已落盘 thinking 文本做句级 `Counter`（不是累计快照）：orca 大会话出现同一句在单块内重复 3–17 次。例子（截断）：

- 17× `Ensure the test passes with the new logic.`（think_len 5450，dur 107s）
- 5× `Replace UPDATE/DELETE with INSERT upserts...`
- 4× `Force a reload of the lua module...`

这类重复发生在 **已经 suffix-dedup 之后** 的最终 thinking 字符串里，因此不是 A 的回归。现有 `ThinkingLoopDetector` 能打 verbatim/near-dup，但 Grok 未入 guard 名单，session 中也 **零** `thinking-loop-redirect` 事件。

落盘 thinking 偏短（多数会话 p50 约 200–400 字，max 通常 2–5k）。流式阶段若曾更长，jsonl 只保留最终块，无法从历史直接证明“停顿期间一直在重复吐 thinking”。

### 1.4 “无输出 / 停顿”合同

**空完成重试（provider 层）**

- `packages/ai/src/utils/empty-completion-retry.ts`：`hasVisibleAssistantContent` 要求 image / toolCall / 非空 text。thinking-only 算空。
- 但 `isMeaningfulCompletionEvent` 把 `thinking_delta` 当 meaningful，**一旦开始吐 thinking 就 commit，不再重试**。thinking 后静默停住不会走这条。

**空停重试（session 层）**

- `TurnRecovery.#isEmptyAssistantStop`：`stopReason==="stop"` 时，若存在 `thinking` 且 `thinkingSignature` 非空白，则 **不算空停、不重试**。
- 测试合同（`agent-session-empty-stop-guard.test.ts`）：
  - unsigned thinking-only → 重试；
  - signed thinking-only（`thinkingSignature: "nonempty"`）→ **接受为终态，不再请求**。
- 本机 grok 会话 thinkingSignature **全部是字段名** `"reasoning_content"`（openai-completions 把 reasoning 字段名当作 signature）。这会被 `hasNonWhitespace` 判为 signed。
- 因此：Grok 若只输出 thinking、不打 tool、不打可见 text，session 会当作完成并 yield。用户看到长时间 thinking 后“没有输出”。抽样里 thinking-only 终态不多（starrocks-update-tools 359 轮里 2 次，且部分是 aborted/error），但合同缺口是确定的。

**流空闲超时**

- `idle-iterator.ts`：idle / first-event 默认 300s。Settings `providers.streamFirstEventTimeoutSeconds` 默认 `-1` → 走 provider 300s。
- Catalog 对 GLM/DeepSeek/Kimi/Xiaomi 有更长 idle；**没有 gateway-grok 专用 idle adapter**。
- 用户感知的“停顿”多数是合法长 TTFT（sol max 384s；grok 常见 10–90s），不是死锁。300s 超时救不了“thinking 在重复但流仍有 delta”的情况。

**其它已有 guard（与本问题正交或已覆盖别的形状）**

- tool-call loop guard：连续相同 tool+args，默认阈值 5，`hub` 豁免。
- hashline noop loop：连续 3 次 byte-identical noop → ToolError。
- unexpected-stop：另需 `features.unexpectedStopDetection`，且要求有可见 text。
- TUI `loop-watchdog.ts`：事件循环卡死，不是模型流。
- Advisor emission-guard：advisor 重复 advise，不是主模型 thinking。

### 1.5 Prompt / tool 常驻体积

| 模块 | 体积 | 注入方式 |
|---|---|---|
| `prompts/system/system-prompt.md` | 21.2KB | 每轮 system block 0，always-on |
| `prompts/system/plan-mode-active.md` | 11.2KB | 仅 plan mode |
| `prompts/system/workflow-notice.md` | 9.2KB | 仅 workflow |
| `prompts/tools/*.md`（47 文件） | 56.9KB | **每轮**作为 tool schema description（非 Gemini 的 `toolListMode` 下列名；Gemini inline 全量 inventory） |
| 最大 tool prompts | task 5.8KB, hub 3.8KB, eval 3.5KB, apply-patch 2.8, patch 2.7, todo 2.5 | schema 已有同名字段时，prompt 仍复述参数 |
| `explicit-grok.md` | 393B | `modelOptimization` grok profile overlay，很小 |
| 用户 `~/.omp/agent/RULES.md` | 5.5KB | `alwaysApply: true`，每轮 `<generic-rules>` |
| 用户 `~/.omp/agent/AGENTS.md` | 1.4KB | context file |
| 仓库 `AGENTS.md` | 283B | context file |

其它事实：

- Skills/domain rules **正文**按需 `skill://` / `rule://`；但 skill **目录描述**与 always-apply 全文每轮都在。
- `task.md` 对 `effort` / `outputSchema` / `schemaMode` / `isolated` 在 Inputs 与后文重复两遍。
- Grok profile（`default-profiles.ts`）：`promptStrategy.kind="verbose"`，`thinkingPrompt.style="step-by-step"`，`systemPromptTemplate="explicit-grok"`。另在 workflow `prompt-strategy.ts` 注入 `"Think step-by-step before acting."`。
- `modelOptimization.enabled` 已默认 on（CHANGELOG）。
- Tool prompt 裁剪必须 `git blame`：scar tissue 不能当 schema 可推断就删（`skill://tool-prompt-optimization`）。

### 1.6 既有设计，避免重做

- `docs/superpowers/specs/2026-08-03-long-session-performance-optimization-design.md`：普通会话 latency arms（read dedupe、bash ledger、eval budget、compaction 阈值）。多数 arm 仍 default-off。
- `docs/superpowers/specs/2026-08-20-grok-fast-mode-design.md`：xAI Priority Processing / `/fast`。**不是** thinking 重复或 prompt 裁剪。
- `docs/superpowers/specs/2026-07-25-per-model-optimization-design.md`：family profile / tool truncate。Grok profile 已存在。
- 本设计不得再开第二套 Fast-mode、不得重做 latency A/B 全套、不得把 compaction 改成真正并行 sidecar。

### 1.7 Canonical owners

| 问题 | Owner |
|---|---|
| 是否对某模型跑 thinking-loop | `packages/ai/src/utils/thinking-loop.ts` `isLoopGuardedModel` + `packages/ai/test/thinking-loop.test.ts` |
| 累计 reasoning 快照 | catalog `reasoningDeltasMayBeCumulative` + `openai-completions.ts` appendThinkingDelta |
| 空停是否终态 | `packages/coding-agent/src/session/turn-recovery.ts` `#isEmptyAssistantStop` + empty-stop-guard tests |
| 常驻 system 指令 | `packages/coding-agent/src/prompts/system/system-prompt.md` + `system-prompt.ts` |
| Tool 何时/如何用 | `packages/coding-agent/src/prompts/tools/*.md`（schema 在各 tool 实现） |
| Grok 会话风格 overlay | `packages/coding-agent/src/model-optimization/default-profiles.ts` + `prompts/model-optimization/explicit-grok.md` |
| 流 idle/first-event | `packages/ai/src/utils/idle-iterator.ts` + settings `providers.stream*TimeoutSeconds` |

## 2. 推断（非事实）

- [INFERENCE] 用户说的“grok-4.6 thinking 重复”同时包含：(1) 已修的累计快照（若仍偶发则是 catalog 漏网，例如非 gateway provider 或非 grok-4.6 id）；(2) 未修的语义句级循环。本机 08-22/23 gateway/grok-4.6 证据支持 (2)。
- [INFERENCE] “长时间停顿无输出”对 grok 主要是长 thinking + 偶发 thinking-only 终态；对 sol 主要是高 promptTokens 下的长 TTFT。不是 TUI 事件循环卡死。
- [INFERENCE] 常驻 21KB system-prompt + 57KB tool descriptions + RULES.md 是每轮固定税； grok 会话 promptTokens 7–35 万主要来自 transcript/tool 结果，不是这 80KB 单独造成。裁 prompt 能降固定税、改善指令遵循，但对 200k+ 会话不是主杠杆。质量优先意味着：先修会让任务失败/空转的 guard，再剪确定的 prompt 重复，不先砍 delivery/safety 条款。
- [INFERENCE] Grok `verbose` + `step-by-step` overlay 可能拉长 thinking，但 393B 模板本身不是重复源。

## 3. 未知 / 未验证

- 全量 21 天 284 jsonl 的 gen/ttft/tool 时间账未重跑（08-03 文档是旧全量）。
- 流式过程中被 UI 截断、未写入最终 thinking 块的重复程度。
- 非 `gateway` provider 的 grok（xai-oauth、openrouter `x-ai/grok-*`）是否仍发累计快照。
- 把 Grok 纳入 `isLoopGuardedModel` 后，对正常逐步推理的误杀率（现有阈值按 536k 非 Gemini 块校准，但未用 grok-4.6 语料再标定）。
- Gemini header-runaway（连续 planning 标题）是否也该用于 Grok；当前只接在 `stream-guards.ts` 的 Gemini 路径。
- 本机 `RULES.md` 是用户配置，不是产品默认；产品方案不应以改用户文件当修复。

## 4. 约束（给作者）

- 质量 > 省 token。任何 prompt 删减若可能降低完成率、漏工具、漏安全/校验，标为不可接受。
- 复用现有 owner；两方案都能达标时选更浅落地。
- 至少 2 个方案。只对推荐方案写文件级细节。
- 未请求能力进非目标：不要做 Fast-mode、不要做 latency A/B 全开、不要新 compaction 引擎、不要关 thinking、不要改 Gemini/DeepSeek 阈值除非有误杀证据。
- 无 TBD。根因章节必填（方案选择依赖成因）。
- 实现授权：authorized。来源：用户目标“得出结论后先落地文档文件方案，再进行优化及验证”。
- 模板：`~/.claude/skills/dev-flow-common/references/design-doc-template.md`。
- 落盘路径：`docs/superpowers/specs/2026-08-23-harness-quality-token-optimization-design.md`。
- Reviewer：`subagent-sol` / GPT-5.6-sol。禁止 grok 自审。
