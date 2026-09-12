# Design: omp harness 质量优先与无效 token / 异常执行治理

- Date: 2026-08-23
- Status: Draft
- Scope: L
- design_author: grok
- design_author_identity: GrokDesigner
- planned_reviewer: GPT-5.6-sol / subagent-sol
- implementation_authorization: authorized
- authorization_source: 用户目标「得出结论后先落地文档文件方案，再进行优化及验证」

当前正文作者仅 `design_author_identity` 对应的单一 grok author。推荐方案仍是方案 A。Round-1 Design Review Gate = NEEDS_REVISION（artifact `docs/superpowers/plans/2026-08-23-harness-quality-token-optimization-subagent-review.md`，reviewed_revision `65e2184d34108b9b89678af670d9fbf336f1ff3d18c48a048ed9f7da4256fd21`）。本修订关闭主协调者已采纳的 MEDIUM-1/2 与 LOW-1/2：真实 orca 17× 形状进入 §6.1 放行门（命不中=本方案放量失败，不改 Gemini/DeepSeek 阈值）；行为承诺收窄为已证实的 `gateway` + `openai-completions` + grok-4.6，其它 `isGrokModelId` 匹配只测门真值、不承诺 session 闭环；Grok 命中断言含 `THINKING_LOOP_ERROR_MARKER`；字段名列表保持 turn-recovery 本地常量 + 注释对齐 completions，empty-stop 测试用同一三字段 table。实现由独立 implementer 在新一轮 Gate 通过后执行；作者不实现、不自审。

证据标签：[历史事实]=源码或 facts brief 直接观察；[推导]=由已确认事实推出；[未验证假设]=尚未验证；[拟议但已确定]=本设计拍板；[拟议验收目标]=实现后必须达到的运营/质量门槛。

事实输入：`docs/superpowers/specs/2026-08-23-harness-quality-token-optimization-facts-brief.md`。本文方案结论由作者提出；不得把 coordinator 未给出的方案写进「已确认事实」。

## 1. 设计目标和范围

### 1.1 要解决的问题

用户双目标，质量优先于省 token，不可缩范围。[历史事实]

1. 在不影响任务完整质量的前提下，优化/简化 omp 的 prompt、工具描述与 harness 模块，提高任务完成质量，并减少无效 token。
2. 诊断近期历史里的长时间停顿、无输出、以及 `gateway/grok-4.6` thinking 思维链重复；先落文档方案，再实现并验证。

本机 2026-08-22–23 抽样与代码合同对得上的机制缺口是两条独立合同，外加一条小的常驻复述，而不是「缺 Fast-mode / 缺 compaction sidecar / TUI 卡死」：[历史事实]

- Thinking-loop guard 的检测器本身不绑家族，但 `isLoopGuardedModel` 只放行 Gemini（含 OpenAI-compat 的 `enableGeminiThinkingLoopGuard`）和 id/provider 含 `deepseek` 的模型。`model.loopGuard.enabled=true` **不能**把其它模型加进去。Grok 在 `withGeminiThinkingLoopGuard` 上是透明 pass-through。因此 orca 会话里同一句在单块 thinking 内重复 3–17 次（已过 suffix-dedup）时，session 中 **零** `thinking-loop-redirect`。[历史事实]
- Session 空停合同把「非空白 `thinkingSignature`」当作 provider 认证内容，thinking-only + `stopReason==="stop"` 即终态、不重试。openai-completions 把 reasoning **字段名**（本机 grok 会话全部是 `"reasoning_content"`）写入 `thinkingSignature`。字段名能通过 `hasNonWhitespace`，于是 Grok 若只吐 thinking、不打 tool、不打可见 text，用户看到长时间 thinking 后「没有输出」。[历史事实]
- 传输层累计快照重复（`reasoningDeltasMayBeCumulative` + suffix emit）已经修在 `openai-completions`；本轮可见的句级重复发生在 suffix-dedup **之后**，不是那次修复的回归。[历史事实]
- 常驻 system/tool 文本是每轮固定税，但对 grok 会话 7–35 万 `promptTokens` 不是主杠杆；主杠杆是 transcript / tool 结果。质量优先意味着：先修会让任务空转或失败的 guard，再剪确定的 prompt 复述，不先砍 delivery/safety。[推导]

### 1.2 成功标准

把用户可观察标准落成验收条款，质量门槛先于 token 数字。[拟议验收目标]

1. **Grok thinking 循环可打断（放行形状含真实 orca 语料）。** 门真值：`isGrokModelId(model.id)` 为 true 且 `model.loopGuard.enabled` 未关、`PI_NO_THINKING_LOOP_GUARD` 未设时，`isLoopGuardedModel` 为 true（覆盖 `gateway/grok-4.6` 与 `x-ai/grok-4.6` 等 id 匹配）。**流式打断与 session 闭环的行为承诺只覆盖已证实路径** `provider=gateway` + `api=openai-completions` + id 匹配 grok-4.6；其它 `isGrokModelId` 匹配保持门为 true，但不承诺 delta 语义、累计快照或 TurnRecovery 闭环（facts brief 非 gateway 累计快照仍为未知）。用现有 `ThinkingLoopDetector` 阈值（verbatim 250 字窗 / near-dup Jaccard≥0.8、warm-up 8、cluster≥4 / novelty≤0.2 连续 8 段）必须在该已证实路径上打断三类夹具，全部列入 §6.1 必须全绿：(a) 与现有 Gemini/DeepSeek 测试同构的 near-dup 循环；(b) 同一短句 back-to-back 重复到超过 `VERBATIM_MIN_REPEATED_CHARS`；(c) facts brief 记录的脱敏真实形状：单块内 17× `Ensure the test passes with the new logic.`，夹具须保留非相邻重复与分 chunk 喂入（不是只拼成一条连续字符串再一次性 `push`）。命中后：空 content、`AIError.Flag.ThinkingLoop`、`errorMessage` **同时**含 `"stream stall"` 与导出常量 `THINKING_LOOP_ERROR_MARKER`；已证实路径上 session `TurnRecovery` 丢弃该轮并注入 `thinking-loop-redirect.md`。**(c) 命不中 = 本方案放量失败**：撤回 Grok 门，不改 Gemini/DeepSeek 阈值、不接 header-runaway、不把「先开门、漏检另开」写成完成。Gemini / DeepSeek 的门、阈值、header-runaway 路径行为不回归。
2. **字段名签名不能把 thinking-only 变成终态。** `stopReason==="stop"` 且 content 只有 thinking、签名为 `"reasoning_content"` / `"reasoning"` / `"reasoning_text"` 时，`#isEmptyAssistantStop` 为 true，走现有空停重试（上限 3，注入 `empty-stop-retry.md`）。**Claude 类**非字段名、非空白 `thinkingSignature`（测试夹具 `"nonempty"` 与真实 provider 认证签名）的 thinking-only stop 仍是终态、不重试——[#5881](https://github.com/can1357/oh-my-pi/issues/5881) 合同保持。有 toolCall 或非空 text 的 stop 仍不是空停。
3. **正常逐步推理不被新门误杀。** 下列负例必须进入 §6.1 必须全绿，不能只写 `distinctReasoning()`：(a) 现有 `distinctReasoning()` 类夹具；(b) 「有具体路径/标识符锚点的分段推理」——至少八段，每段引入**新的**代码路径或标识符（满足 `CONCRETE_ANCHOR`），允许复用少量连接词，但不得构成 near-dup cluster。两条在 Grok mock（已证实路径模型对象）上均不 abort。实现阶段若另用历史 grok thinking 块做回放，不得把「有进展的逐步推理」判成 stall；那是补充证据，不能替代 (a)(b)。误杀的回滚见 §4.4，不得靠改 Gemini/DeepSeek 阈值来「顺便」给 Grok 让路。
4. **Prompt 只剪已证明复述，完成率条款不降。** Grok overlay 不再出现与 `prompt-strategy.ts` 注入句重复的第二句 step-by-step。`task.md` 只允许删「JSON schema 已向模型暴露的 enum/类型字面量复述」；when/how、batch/flat 互斥分支、Communication / Format Contracts / Available Agents、以及 `system-prompt.md` 的 delivery/safety 条款保持。禁止出现工具漏用、安全/校验条款消失。
5. **Token 是第二证据，不是第一门槛。** 先有 §6 的质量夹具全绿，再报告：(a) 合成 thinking-loop 夹具上被 abort 的 runaway 不再把整段循环 thinking 写入 transcript；(b) 短会话 system/non-message 固定税因 overlay 去重产生的差值（预期很小，允许个位数到几十 token）。不得用「200k+ 长会话 promptTokens 下降」作为本方案验收，因为那不是本轮主杠杆。[推导]
6. **非目标子系统零回归。** Fast-mode / `tier.xai`、latency A/B arms、compaction 引擎、Gemini header-runaway（`LoopGuards.#geminiHeaderGuardActive` 仍只认 `isGeminiThinkingModel`）、`empty-completion-retry` 的「thinking_delta 即 commit」行为、流 idle 300s 默认值，均不因本方案改变。

### 1.3 本次范围

- 复用现有 canonical owner，不换引擎：
  - thinking-loop 门：`packages/ai/src/utils/thinking-loop.ts` `isLoopGuardedModel`（接线 `packages/ai/src/stream.ts` `withGeminiThinkingLoopGuard` 已包所有 dispatch，Grok 今日是 pass-through）。门真值覆盖全部 `isGrokModelId`；**流式打断 / TurnRecovery 闭环只承诺** `gateway` + `openai-completions` + grok-4.6。
  - 空停终态：`packages/coding-agent/src/session/turn-recovery.ts` `#isEmptyAssistantStop`（字段名签名解释与传输无关，不按 provider 收窄）。
  - Grok 风格 overlay：`packages/coding-agent/src/prompts/model-optimization/explicit-grok.md`（去重）；`packages/coding-agent/src/workflow/prompt-strategy.ts` 的 step-by-step 注入句保留为单一来源。
  - 工具描述：仅 `packages/coding-agent/src/prompts/tools/task.md` 的类型字面量复述，且受 blame 约束。
- 测试与 Unreleased changelog：`packages/ai/test/thinking-loop.test.ts`（含真实 orca 17× 形状与锚点负例）、`packages/coding-agent/test/agent-session-empty-stop-guard.test.ts`（三字段名 table）、`packages/coding-agent/test/agent-session-thinking-loop-retry.test.ts`（仅 gateway/grok-4.6 session 闭环）、`packages/ai/CHANGELOG.md`、`packages/coding-agent/CHANGELOG.md`。
- 本阶段交付是设计文档。产品代码在 **本轮修订后的** Gate `PASS` / `PASS_WITH_NOTES` 且 `implementation_authorization=authorized` 之后由独立 implementer 执行。

### 1.4 非目标

- 重建或扩展 Fast-mode / xAI Priority Processing / `tier.xai`（已有 `docs/superpowers/specs/2026-08-20-grok-fast-mode-design.md`）。
- 打开或重做 `docs/superpowers/specs/2026-08-03-long-session-performance-optimization-design.md` 的 latency A/B 全套（read dedupe、bash ledger、eval budget 等多数 arm 仍 default-off）。
- 新 compaction 引擎、并行 sidecar compaction、或把无 compaction 事件的抽样会话「补上 compaction」。
- 关闭 thinking / 把 Grok profile 从 `verbose` + `step-by-step` 改成 concise（393B 模板不是重复源；是否拉长 thinking 未验证）。
- 改 Gemini / DeepSeek 的 detector 阈值、warm-up、cluster、novelty 或 `GEMINI_HEADER_RUNAWAY_THRESHOLD`（24），除非出现 **本方案引入的** 误杀证据——当前没有 grok 语料标定要求改这些数字。[未验证假设]
- 把 `GeminiHeaderRunDetector` / `model.loopGuard.toolCallReminder` 接到 Grok（Gemini planning-header 病理；Grok 是否同形未知）。
- 为 gateway-grok 做专用 idle / first-event adapter，或下调 300s 默认（合法长 TTFT：sol max 384s，grok 常见 10–90s；thinking 仍有 delta 时 idle 救不了循环）。
- 改 `empty-completion-retry.ts`：`thinking_delta` 视为 meaningful 并 commit 的行为保持。直播 thinking 不得被 provider 层推迟或重放。无输出合同的正确 owner 是 session 空停。
- 改 `openai-completions.ts` 把字段名写入 `thinkingSignature` 的传输约定，或改 DeepSeek/Kimi/llama.cpp 的 reasoning 回放。空停层把字段名当「非认证」即可；回放仍需要字段名。
- 重写 `prompts/system/system-prompt.md`（21.2KB）、用户 `~/.omp/agent/RULES.md`、仓库 `AGENTS.md`。产品方案不以改用户文件当修复。
- 关掉 tool-call loop guard、hashline noop loop、unexpected-stop、TUI `loop-watchdog`、advisor emission-guard（与本问题正交）。
- 全量 21 天 284 jsonl 时间账重跑、流式 UI 截断未落盘 thinking 的定量。非 gateway grok（xai-oauth、openrouter `x-ai/grok-*`、Responses API）的累计快照 / 流式闭环：本方案 **明确不承诺**（门真值仍可测）；那是 catalog 漏网或未验证传输，走已有 A 类修复或另开设计，不在本方案新开引擎或补 stream fixture。
- 新 settings 键、新 feature flag、新家族检测器、第二套 loop-guard 实现。

### 1.5 背景与约束

- 现有 loop guard 已接在 `stream()` / `streamSimple()` / custom / pi-native dispatch 外层；`complete()` / `completeSimple()` 对 `ThinkingLoop` 最多 `THINKING_LOOP_MAX_ABORTS=3` 次再采样，然后 `loopGuard.enabled=false` 做一次 cook pass。[历史事实]
- Session 对 `AIError.Flag.ThinkingLoop` 丢轮并注入通用 `thinking-loop-redirect.md`（禁止把 detector detail 插进更高优先级 developer 消息）。[历史事实]
- 空停重试上限 `EMPTY_STOP_MAX_RETRIES=3`；超限丢持久化空轮，避免 usage 锚到失败请求尺寸。[历史事实]
- 检测器阈值注释写明 novelty 来自 536k **非 Gemini** reasoning 块，因此「Grok 用同一套阈值」不是跨家族硬套 Gemini 启发式，而是复用已对非 Gemini 校准的检测器。Grok-4.6 专用误杀率仍是未知数。[历史事实]+[未验证假设]
- 质量 > 省 token。任何 prompt 删减若可能降低完成率、漏工具、漏安全/校验，标为不可接受。[历史事实]
- 复用现有 owner；两方案都能达标时选更浅落地。未请求能力进非目标。[历史事实]
- Catalog 身份：`isGrokModelId` 为 `/(^|[/.])grok[-.]/i`，覆盖 `grok-4.6`、`x-ai/grok-*`、`gateway` + id `grok-4.6`。本方案用它做**门真值**，不为此新增 compat flag。流式/session 行为承诺见 §1.2/§4.1，不随 helper 匹配面自动扩大。[历史事实]+[拟议但已确定]
- openai-completions 识别的 reasoning 字段名固定为 `reasoning_content` / `reasoning` / `reasoning_text`，并作为 `thinkingSignature` 在回放时选 wire field。[历史事实]

## 2. 根因分析

### 2.1 是否需要根因分析

需要。方案选择依赖成因：用户同时要「完成质量 / 少浪费」和「停顿、无输出、thinking 重复」。若主因是 compaction 缺失、Fast-mode 未接入、或 system-prompt 太大，推荐方案会完全不同。下面只保留会影响选项的证据。

### 2.2 已确认事实

抽样方法与数字以 facts brief §1 为准，此处不重抄全表。与选项有关的合同事实：

1. **Guard 门不包括 Grok。** `isLoopGuardedModel`（`packages/ai/src/utils/thinking-loop.ts` 127–131 行）在 `loopGuard.enabled===false` 时直接 false；否则 `isGeminiThinkingModel(model) || /deepseek/i.test(provider/id)`。测试写明：`other` + `enabled:true` 仍为 false。[历史事实]
2. **检测器与接线已在。** `ThinkingLoopDetector` 不绑家族。`withGeminiThinkingLoopGuard` 已包 dispatch；Grok 因门未开而 pass-through。`model.loopGuard.enabled` 默认 true 对 Grok 无效果。[历史事实]
3. **两类 thinking 重复只修了一类。** A 类累计快照已修（gateway + `^grok-4\.6(?:$|[-_.])`）。B 类句级 `Counter`：orca 单块 3–17 次同一句，发生在 suffix-dedup 之后；session 零 `thinking-loop-redirect`。HistoryScout 的 20/30 字连续回指三重扫描未命中 verbatim 循环，与句级 Counter 不矛盾（方法更严，漏掉块内非相邻重复）。[历史事实]
4. **无输出合同。** `hasVisibleAssistantContent` 视 thinking-only 为空，但 `isMeaningfulCompletionEvent` 把 `thinking_delta` 当 meaningful，一开始吐 thinking 就不再走 provider 空完成重试。Session `#isEmptyAssistantStop` 在 `stop` 时把非空白 `thinkingSignature` 当认证终态。本机 grok 签名全部是 `"reasoning_content"`（starrocks-update-tools 215 次）。thinking-only 终态抽样不多（359 轮里 2 次，且部分 aborted/error），合同缺口确定。[历史事实]
5. **停顿多数不是死锁。** idle/first-event 默认 300s；没有 gateway-grok 专用 idle。sol max ttft 384s，grok 常见 10–90s。300s 救不了「thinking 在重复但流仍有 delta」。TUI loop-watchdog、tool-call loop、hashline noop、unexpected-stop（还要可见 text）、advisor emission-guard 覆盖的是别的形状。sr_report 约 24 分钟无 assistant 输出空窗的成因未从 jsonl 单独证明。[历史事实]
6. **常驻体积。** `system-prompt.md` 21.2KB always-on；`prompts/tools/*.md` 47 文件 56.9KB 每轮进 tool schema description（非 Gemini 下列名）。`task.md` 在 `# Inputs` 下用 `{{#if batchEnabled}}` / `{{else}}` 两套互斥分支各写一遍 `effort` / `outputSchema` / `schemaMode` / `isolated`；运行时只渲染一套。这些行的 blame 是功能引入（`d944879f2` structured subagent、`0388946e8` effort 门、`72c12ff9c` batch、`c2fde74ef` isolation apply），不是事故疤。Arktype schema 有字段类型/enum，没有 when/how 句子。Grok overlay `explicit-grok.md` 393B，含「Think step-by-step for non-trivial tasks.」；`prompt-strategy.ts` 在 `thinkingPrompt.style==="step-by-step"` 时再注入 `"Think step-by-step before acting."`。`modelOptimization.enabled` 默认 on。[历史事实]
7. **既有设计。** Fast-mode、长会话 latency arms、per-model profile 已有独立设计；本问题不是那些缺口的再包装。[历史事实]

### 2.3 未确认假设

- 把 Grok 纳入现有阈值后，对正常逐步推理的误杀率（536k 非 Gemini 标定，未用 grok-4.6 再标定）。[未验证假设]
- 流式过程中被 UI 截断、未写入最终 thinking 块的重复程度；jsonl 只留最终块，不能证明「停顿期间一直在重复吐 thinking」。[未验证假设]
- 非 gateway grok（xai-oauth、openrouter `x-ai/grok-*`）是否仍发累计快照。[未验证假设]
- Gemini header-runaway 是否也该用于 Grok。[未验证假设]
- Grok `verbose` + `step-by-step` 是否显著拉长 thinking；393B 模板本身不是重复源。[推导已在 brief；定量未验证]
- 24 分钟空窗是模型长 thinking、hub 等待，还是用户侧空闲。[未验证假设]
- 全量 21 天时间账未重跑。[未验证假设]

### 2.4 根因判断

**主根因（驱动选项）：** 异常执行与无效 thinking token 来自 **已有检测器未对 Grok 开门**，加上 **把传输层字段名误当成 provider 认证签名** 的空停合同漏洞。两者独立，必须都修，少一个就覆盖不了双目标。[拟议但已确定]

- 「thinking 重复」对当前主会话模型 grok-4.6：B 类句级循环未修，且 loop guard 对 Grok 是空操作。A 类累计快照已修，不是本方案主因。现有 verbatim/near-dup/lexicon 形状覆盖「短句 back-to-back」和「近重复段落」。orca 17× `Ensure the test passes with the new logic.` 是否被现有阈值命中 **不是推导结论，是 §6.1 放行实验**：夹具必须按非相邻 + 分 chunk 喂入。命中 → 方案 A 完成主修复（开门即够，不改阈值）。命不中 → **本方案放量失败**，撤回 Grok 门；禁止改 Gemini/DeepSeek 阈值，禁止把漏检留到「另开设计」却声称 A 已完成。第一刀仍是开门而不是新检测器，但开门的完成定义包含该真实形状。[拟议但已确定]
- 「无输出」对 Grok：不是 TUI 卡死，也主要不是 idle 超时；是 thinking-only + 字段名签名被当成终态。抽样终态少，但用户可观察合同是确定的。修在 `#isEmptyAssistantStop`，不修在 provider 空完成重试（thinking 一旦开始就被 commit）。[推导]
- 「长时间停顿」：多数是合法长 TTFT / 长 thinking；循环 thinking 有 delta 时 idle 无效。24 分钟空窗未证明，本方案不把 hub 空等当主因来做新引擎。[推导]

**次根因（质量/固定税，非 200k 主杠杆）：** Grok 路径上 step-by-step 被写了两遍（overlay 正文 + `prompt-strategy` 注入）。`task.md` 源码里两套 Inputs 是互斥分支，不是运行时双倍；真正可剪的是「schema 已暴露的类型字面量」，when/how 不是重复。21KB system-prompt 与 57KB tool 描述是固定税，但 brief 已说明 grok 7–35 万 promptTokens 主要来自 transcript；砍 delivery/safety 会伤完成率，不作为本轮主因。[推导]

**明确排除的成因：** compaction 未触发、Fast-mode 未对 Grok 打开、goal 工具超预算、`stopReason` error/length（抽样为 0）、用户 `RULES.md`。这些或已有独立设计，或不能从本轮证据推出「修它才能完成双目标」。[历史事实]

### 2.5 对设计的影响

- 两方案都能覆盖主根因时，必须选更浅：给 `isLoopGuardedModel` 加 Grok、在空停谓词排除字段名签名、只剪已证明复述。禁止为未知误杀率先做 Grok 专用阈值，禁止为固定税重写 system-prompt。真实 orca 17× 形状进入 §6.1；命不中时的选择是 **撤回开门**（仍浅），不是方案 B。[拟议但已确定]
- 不改 Gemini/DeepSeek 阈值：没有 grok 语料证明现有阈值对它们过严或过松；改它们是给 Grok「让路」的投机。[拟议但已确定]
- 不把 header-runaway 接到 Grok：未知是否同形；那是 Gemini 路径，接上会扩大误杀面。[拟议但已确定]
- 不改 completions 传输层签名赋值：字段名仍是回放坐标；只在 session 空停解释层区分「认证签名」与「字段名」。[拟议但已确定]
- Prompt 工作必须 blame-aware：`task.md` 那些参数行是功能引入，不是疤；可删类型复述，不可删 when/how。[拟议但已确定]

## 3. 方案对比

主协调者提示推荐方案「很可能」组合 (a)(b)(c)(d)。作者核对 facts brief 后 **同意 (a)(b)(d)，并收窄 (c)**：不把 `task.md` 互斥分支当运行时重复来删；只剪 overlay 双写的 step-by-step 与 schema 已暴露的类型字面量。理由见 §2.4–2.5，不是另起炉灶。

下面两个都是可落地真实路径，共用同一组 owner。差别在 **检测器/prompt 是否加深**。

### 方案 A — 现有 owner 上开门 + 空停解释修正 + 已证明复述（推荐）

**核心思路：** 不新建 guard、不改阈值、不改传输层。

1. `isLoopGuardedModel` 增加 `isGrokModelId(model.id)`。Gemini/DeepSeek 谓词与阈值不动。`enabled:false` / `PI_NO_THINKING_LOOP_GUARD=1` 仍全关。`other`（如 gpt-4o）即使 `enabled:true` 仍 false。门真值对所有匹配 id 生效；**流式打断与 session 闭环只对** `gateway` + `openai-completions` + grok-4.6 **做放行承诺**。§6.1 必须用真实 orca 17× 夹具证明现有 detector 打得中；打不中则撤回本步，不改阈值。
2. `#isEmptyAssistantStop` 的 thinking 分支改为：只有 **provider 认证签名** 才能把 thinking-only stop 当终态。认证签名 = 非空白 **且不是** `reasoning_content` / `reasoning` / `reasoning_text`。字段名签名视同 unsigned。Claude `#5881` 夹具不受影响。
3. Prompt：删除 `explicit-grok.md` 中与 `prompt-strategy.ts` 注入重复的 step-by-step 句，保留「Stay within the user request; do not add unrequested features.」。`task.md` 仅当 JSON schema 已向模型暴露同一 enum/类型时删除描述里的字面量复述；保留 when/how 与互斥分支。
4. 明确不做 Fast-mode、latency A/B、compaction、关 thinking、Gemini 阈值、header-runaway-for-grok、idle adapter。

**优点：** 改动面小；复用已校准检测器与已有 TurnRecovery / cook pass；空停修正与 loop 开门正交，可独立回滚；prompt 只动已证明双写。  
**缺点：** Grok 误杀率未用本家族语料标定；字段名列表在 turn-recovery 与 completions 各有一份（注释对齐，不抽新模块）。  
**适用前提：** 现有阈值能打中 §6.1 的真实 orca 17× 形状以及 generic verbatim/near-dup（这是放行实验，不是事先假定）；空停层解释签名足以修无输出合同；固定税不是 200k 主杠杆。前提在实现时被证伪 → 撤回 Grok 门，方案 A 未完成，不滑向方案 B。

### 方案 B — Grok 专用检测器 + header/idle + 大面积 prompt/profile 治理

**核心思路：** 为 Grok 新开更敏感阈值或第二套 detector；把 `GeminiHeaderRunDetector` 接到 Grok；加 gateway-grok idle；把 Grok profile 改 concise / 关 thinkingPrompt；重写 `system-prompt.md` 与多份 tool prompt；顺手打开 latency arms 或动 compaction。

**优点：** 若 Grok 循环形态与 Gemini/DeepSeek 差很多，专用阈值可能更准；大面积裁 prompt 对短会话固定税更明显。  
**缺点：** 违反「两方案都能达标时选更浅」；把未验证误杀率、未验证 header 同形、未验证 idle 有用，升级成实现前提；重写 system-prompt 直接撞上质量优先约束；Fast-mode / latency / compaction 是已有独立设计的第二引擎。  
**适用前提：** 必须先有 grok 语料证明现有阈值漏检或误杀，或证明 header/idle 是主因。当前 facts brief **没有** 这些证据。

### 对比

| 维度 | 方案 A | 方案 B |
|---|---|---|
| 质量风险 | 低：Claude 签名合同保留；Gemini/DeepSeek 阈值不动；prompt 不砍 delivery/safety | 高：新阈值/header/改 profile/砍 system-prompt 都可能伤完成率 |
| 无效 token | 拦住 runaway thinking（主浪费）；固定税只剪已证明双写（小） | 固定税可能更小，但 200k 会话仍不是主杠杆；误杀重试会 **增加** token |
| 落地深度 | 浅：门 + 谓词 + 一两处 prompt | 深：新启发式、idle、profile、多 prompt、可能动 latency/compaction |
| 回滚 | `loopGuard.enabled` / env；空停函数可单独还原；overlay 一句可还原 | 多子系统耦合，回滚面大 |
| 误杀/漏检 | 未知 Grok FP，用现有非 Gemini 标定 + cook pass + 全局开关缓解 | 专用阈值无标定则更可能误杀；header 接 Grok 无证据 |

### 推荐

选择 **方案 A**。两方案都能覆盖已确认的主根因（Grok 未入 loop 门 + 字段名签名当终态）；方案 A 是更浅落地。方案 B 所依赖的「现有阈值不够 / header 同形 / idle 能救循环 / 砍 system-prompt 不伤完成率」均为未验证假设，facts brief 禁止用它们驱动加深。

对协调者提示的 (a–d)：

- **(a) 同意，并收窄完成定义。** 扩展 thinking-loop 门到 Grok，不放松 Gemini/DeepSeek 阈值。完成 = 门开 **且** §6.1 真实 orca 17× 夹具命中。命不中不是「另开设计后仍算 A 完成」，而是本方案失败并撤回门。Grok-only 阈值只有在那次失败之后才需要新设计，本文件不授权。[拟议但已确定]
- **(b) 同意。** 字段名 `thinkingSignature` 不是 provider 认证签名，不能把空停终端化。[拟议但已确定]
- **(c) 同意原则、收窄例子。** 只剪已证明复述，不砍 delivery/safety。`task.md` 的 batch/flat 是互斥渲染，不是双倍注入；blame 是功能引入。可剪 overlay 双写 step-by-step，以及 schema 已暴露的类型字面量。不把 21KB system-prompt 当本轮主刀。[拟议但已确定]
- **(d) 同意。** 不重建 Fast-mode、latency A/B、compaction 引擎。[拟议但已确定]

## 4. 详细设计（仅推荐方案）

### 4.1 模块 / 接口 / 数据流

```text
stream()/streamSimple()/custom/pi-native
  └─ withGeminiThinkingLoopGuard
        ├─ isLoopGuardedModel?  --false--> 原 dispatch（今日 Grok 走这里）
        └─ true: guardThinkingLoopStream(ThinkingLoopDetector)
              命中 -> 空 content + Flag.ThinkingLoop + "stream stall"
                    -> complete() 最多 3 次再采样，然后 cook(unguarded)
                    -> AgentSession TurnRecovery 丢轮 + thinking-loop-redirect.md

openai-completions appendThinking(..., signature=字段名)
  └─ thinkingSignature === "reasoning_content"|"reasoning"|"reasoning_text"
        ├─ 回放：仍用字段名选 wire field（本方案不改）
        └─ 空停：#isEmptyAssistantStop 视作 unsigned
              thinking-only + stop -> empty-stop-retry.md，上限 3
              Claude 非字段名签名 thinking-only + stop -> 终态（#5881）
```

Grok 身份复用 catalog：`isLoopGuardedModel` 用 `isGrokModelId(model.id)`，不在 thinking-loop 里再写一套 `/grok/i`，不新增 compat flag。id 完全不含 grok 则 fail-open（不守卫），与今日「未知家族不守卫」一致。

**承诺分层（MEDIUM-2）：**

| 层 | 覆盖 | 验证 |
|---|---|---|
| 门真值 | 所有 `isGrokModelId(model.id)`，含 `gateway` + `grok-4.6`、`x-ai/grok-4.6` | `thinking-loop.test.ts` 的 `isLoopGuardedModel` 断言 |
| 流式打断 + TurnRecovery 闭环 | **仅**已证实路径：`provider=gateway`、`api=openai-completions`、id 匹配 grok-4.6 | detector 夹具（含真实 orca 17×）+ `agent-session-thinking-loop-retry.test.ts` |
| 未承诺 | openrouter `x-ai/grok-*`、`xai-oauth`、Responses API、其它代理的 delta 语义 / 累计快照 / session 闭环 | 不写 stream fixture；changelog 写明未承诺 |

门为 true 不等于已证实路径的闭环已测。实现不得把未承诺路径写成「已支持」。[拟议但已确定]

空停认证谓词（仅 session 层）：

```text
isProviderAuthenticatedThinkingSignature(sig):
  非空白 且 不是 {reasoning_content, reasoning, reasoning_text}
```

`#isEmptyAssistantStop` 在 `stopReason==="stop"` 时：toolCall 或非空 text → 非空停；thinking 且 `isProviderAuthenticatedThinkingSignature` → 非空停；否则空停。`toolUse` 分支不因 thinking 签名放行（既有 Anthropic 历史约束），本方案不改。[拟议但已确定]

字段名集合与 `openai-completions.ts` 的 `reasoningFields`（`["reasoning_content", "reasoning", "reasoning_text"]`，约 1122 行）对齐，写在 `turn-recovery.ts` **本地常量**，**不**抽 package-shared 模块（浅落地；三个字面量不值得新 owner）。常量上方注释必须点名 completions 的 `reasoningFields`，并写明：新增 alias 时必须同时改 session 常量与 empty-stop table，否则字段名签名会再次被当成认证终态。empty-stop 测试用 **同一三个字段名的 table**，禁止只测 `reasoning_content` 一条。[拟议但已确定]

Prompt 去重数据流：Grok profile `thinkingPrompt.style="step-by-step"` → `buildStablePromptSections` 注入 `"Think step-by-step before acting."`（单一来源，保留）。`explicit-grok.md` 删除首句 step-by-step，保留其余风格约束。`task.md` 的 `# Inputs` 仍按 `batchEnabled` 渲染一套；描述里与 schema 重复的 `"lo"|"med"|"hi"`、`"permissive"|"strict"` 字面量可删，保留「Scale w/ complexity…」「Overrides the selected agent…」这类 when/how。[拟议但已确定]

### 4.2 文件级改动

只列将被改动或新建的路径。不改 `stream.ts` 接线（已包全 dispatch）、不改 `empty-completion-retry.ts`、不改 `stream-guards.ts`、不改 `openai-completions.ts` 签名赋值。

| 路径 | 改动 |
|---|---|
| `packages/ai/src/utils/thinking-loop.ts` | `isLoopGuardedModel`：在现有 Gemini/DeepSeek 之外 `\|\| isGrokModelId(model.id)`。从 `@oh-my-pi/pi-catalog/identity/family` 导入。更新文件头/函数注释：守卫家族含 Grok；阈值与 header detector 仍不因 Grok 而改。`isGeminiThinkingModel` / `GeminiHeaderRunDetector` 不动。 |
| `packages/ai/test/thinking-loop.test.ts` | **门真值：** `createMockModel({ provider: "gateway", id: "grok-4.6" })` 与 `{ provider: "openrouter", id: "x-ai/grok-4.6" }` 为 true；`enabled:false` 时二者为 false；`gpt-4o` + `enabled:true` 仍 false；Gemini/DeepSeek 不变。**命中（必须全绿，放行门）：** (1) 现有 near-dup 循环文本喂给 gateway/grok-4.6 mock；(2) back-to-back 短句超过 `VERBATIM_MIN_REPEATED_CHARS`；(3) 脱敏真实 orca 形状：把 `Ensure the test passes with the new logic.` 在同一 thinking 块内重复 17 次，**非相邻**（重复句之间插入互不相同、且不构成 near-dup cluster 的短过渡句），并 **按 chunk 边界分多次 `thinking_delta` 喂入**（至少把该句的出现切到不同 delta，禁止单次 `push` 整块）。(1)(2)(3) abort 后断言：`errorId` 为 ThinkingLoop、`content` 为空、`errorMessage` 含 `"stream stall"` **且** 含导出的 `THINKING_LOOP_ERROR_MARKER`。**(3) 不 abort = 实现失败，撤回 Grok 门。负例（必须全绿）：** `distinctReasoning()` 不 abort；另造「有具体路径/标识符锚点的分段推理」≥8 段、每段新 `CONCRETE_ANCHOR`（例如不同 `packages/...` 路径或 camelCase 标识符），不 abort。 |
| `packages/coding-agent/src/session/turn-recovery.ts` | 本地常量，字面量必须与 completions `reasoningFields` 三元素同一顺序；注释指向 `packages/ai/src/providers/openai-completions.ts` 的该数组。`#isEmptyAssistantStop` 的 thinking 分支改走 `isProviderAuthenticatedThinkingSignature`。`toolUse` 分支不动。不抽共享模块。 |
| `packages/coding-agent/test/agent-session-empty-stop-guard.test.ts` | **table** 覆盖同一三个字段名 `reasoning_content` / `reasoning` / `reasoning_text`：thinking-only `stop` **均重试**。现有 `signedThinkingOnlyStop()`（`"nonempty"`）**仍不重试**。现有 unsigned thinking-only 仍重试。禁止只覆盖其中一个字段名。 |
| `packages/coding-agent/test/agent-session-thinking-loop-retry.test.ts` | 现有 Gemini 夹具保留。增加 **仅** `provider: "gateway", id: "grok-4.6"`：chunked thinking-loop 被丢弃、注入 `thinking-loop-redirect`、再采样。不在本文件承诺 openrouter / xai-oauth / Responses session 闭环。 |
| `packages/coding-agent/src/prompts/model-optimization/explicit-grok.md` | 删除与 overlay 重复的 step-by-step 句；保留「Stay within the user request; do not add unrequested features.」及其余 numbered 风格约束。 |
| `packages/coding-agent/src/prompts/tools/task.md` | 仅删除与 `packages/coding-agent/src/task/types.ts` `createTaskSchema` 已向模型暴露的 enum/类型字面量复述（`effort` 的 `"lo"\|"med"\|"hi"`、`schemaMode` 的 `"permissive"\|"strict"`）。保留 when/how、`{{#if batchEnabled}}`/`{{else}}` 互斥结构、Communication / Format Contracts / Available Agents。禁止把 Inputs 整段删掉。 |
| `packages/ai/CHANGELOG.md` | Unreleased Fixed：Grok 纳入 thinking-loop 门（阈值不变）。写明流式闭环验证范围是 gateway/openai-completions/grok-4.6。 |
| `packages/coding-agent/CHANGELOG.md` | Unreleased Fixed：字段名 `thinkingSignature` 不再把 thinking-only 空停当终态。Unreleased Changed：Grok overlay 去掉与 profile 注入重复的 step-by-step 句；`task.md` 去掉 schema 已暴露的类型字面量。 |

实现时不新建文件。不改 `default-profiles.ts` 的 `verbose` / `step-by-step`（那是风格选择，不是复述）。不改 `prompt-strategy.ts` 注入句（单一来源）。

### 4.3 不变量

1. `isGeminiThinkingModel` 与 DeepSeek 字符串门的真值表不变；其 detector 阈值常量数值不变。[拟议但已确定]
2. `isLoopGuardedModel(other, { loopGuard: { enabled: true } })` 对非 Gemini/DeepSeek/Grok 仍为 false。[拟议但已确定]
2a. 流式打断与 TurnRecovery 闭环的**放行承诺**仅针对 `gateway` + `openai-completions` + grok-4.6。其它 `isGrokModelId` 匹配可以门为 true，但不在本方案验收。[拟议但已确定]
2b. §6.1 真实 orca 17× 夹具（非相邻 + 分 chunk）必须 abort；不 abort 则不得把 Grok 门合入主干。[拟议但已确定]
3. `loopGuard.enabled===false` 或 `PI_NO_THINKING_LOOP_GUARD=1` 对 **所有** 家族（含 Grok）仍为 pass-through。[拟议但已确定]
4. Claude/Anthropic 非字段名 thinking 签名仍使 thinking-only `stop` 成为终态（#5881）。[拟议但已确定]
5. openai-completions 仍用 `thinkingSignature` 字段名回放 `reasoning_content` / `reasoning` / `reasoning_text`。本方案不改 wire。[拟议但已确定]
6. `empty-completion-retry` 仍在首个 `thinking_delta` commit，不重放直播 thinking。[拟议但已确定]
7. `LoopGuards.#geminiHeaderGuardActive` 仍只在 `isGeminiThinkingModel` 时为 true。[拟议但已确定]
8. Thinking 功能保持开启；Grok profile 保持 verbose + step-by-step（只去双写句）。[拟议但已确定]
9. 空停上限 3、ThinkingLoop cook 前最多 3 次 abort，数值不变。[拟议但已确定]
10. `thinking-loop-redirect.md` 仍是通用纠正文案，不内插 detector 原始模型文本。[拟议但已确定]

### 4.4 失败路径

| 情况 | 行为 |
|---|---|
| Grok thinking 命中 detector（已证实路径） | 空错误轮 + ThinkingLoop；session 丢轮 + redirect；`complete()` 再采样；3 次后 cook（guard 关）。用户可见 warning log「Thinking loop detected; aborting stream for retry.」 |
| §6.1 真实 orca 17× 夹具不 abort | **本方案放量失败。** 从 `isLoopGuardedModel` 撤回 Grok；不改 Gemini/DeepSeek 阈值；不接 header-runaway；不把开门本身当完成。若仍要修该形状，另开设计（可能是方案 B 的检测器，本文件不授权）。 |
| Grok thinking-only + 字段名签名 + `stop` | 空停重试 + `empty-stop-retry.md`；3 次后丢持久化空轮，提示换模型或 `/shake images`（既有文案） |
| Grok 正常逐步推理被误杀 | 同 ThinkingLoop 失败路径（最多 3 次 + cook）。运营回滚：该会话 `model.loopGuard.enabled=false` 或环境变量 `PI_NO_THINKING_LOOP_GUARD=1`（注意：全局开关，会同时关掉 Gemini/DeepSeek 守卫；这是现有耦合，本方案不新做 Grok-only kill switch，以免第二套配置）。若 §6.1 锚点负例或 `distinctReasoning()` 误杀被证实，**停止放量并撤回 Grok 门**，而不是改 Gemini 数字。 |
| id 不含 grok 的代理模型 | fail-open：不守卫。与今日「未知家族不守卫」相同。 |
| `isGrokModelId` 为 true 但非 gateway/openai-completions | 门可 true；流式闭环未承诺。不因这些路径缺 fixture 而阻塞已证实路径放行，也不得在 changelog 写成已支持。 |
| 真实认证签名恰好等于 `"reasoning_content"` | 会按 unsigned 重试。openai-completions 把该字符串保留给字段名；Claude 签名不是这个字面量。接受「宁可重试、不把字段名当终态」。 |
| 空停重试仍 thinking-only | 打到上限后丢轮，不把空完成当成功。 |
| Prompt 去重后某模型漏用 `task` 参数 | 验证失败则还原 `task.md` 该行；when/how 本就不在删除集。 |
| 用户中断 / abort | 既有 abort 路径优先于 loop/空停重试（`complete()` 在 backoff 前 `throwIfAborted`）。 |

### 4.5 兼容与退役

- **无退役。** 不删除旧 API、不改 settings schema 键、不迁移会话文件。
- **正向兼容：** 以前 Grok 上 `loopGuard.enabled=true` 是空操作。本方案后门真值对所有 `isGrokModelId` 生效；**已证实路径** `gateway` + `openai-completions` + grok-4.6 上还会真正打断循环。其它匹配 id 的流式闭环未承诺，不得写成「全部 Grok 传输已验证」。默认值本来就是 true。
- **签名兼容：** 历史 jsonl 里 grok 消息带 `thinkingSignature: "reasoning_content"`；重放/恢复时空停谓词按新规则解释，不会把旧 transcript 改写。只影响 **新的** thinking-only stop 是否再请求。
- **文档：** 不新增用户文档页。changelog 足够。不改 `docs/settings.md` 除非现有文案写死「仅 Gemini/DeepSeek」（实现时若发现再改那一处；当前 settings 描述是「model reasoning and prose」，未写死家族）。
- 与 Fast-mode / latency / compaction 无配置交叉。

## 5. 风险与权衡

1. **Grok 误杀率未知。** 缓解：沿用 536k 非 Gemini 标定；验证用 `distinctReasoning()` + 带锚点分段；cook pass 避免永久卡死；全局 kill switch。不在本轮加 Grok-only 阈值或新 settings。[未验证假设]+[拟议但已确定]
2. **开门后短会话固定税几乎不变。** 用户目标含「降无效 token」。本方案的 token 收益主要来自 **打断 runaway thinking**，不是砍 80KB 常驻。若把主收益说成「promptTokens 大降」会验收失败。缓解：验收顺序质量先、token 后；明确 200k 会话不是本刀杠杆。[推导]
3. **空停重试增加请求次数。** 抽样 thinking-only 终态少（2/359）。最坏是每轮多几次空请求；比「静默当完成」更符合质量优先。上限 3 防止打爆。[历史事实]
4. **字段名列表双份。** 缓解：turn-recovery 本地常量注释对齐 `openai-completions.ts` `reasoningFields`；empty-stop 测试用同一三字段 table 锁住同步。不抽共享模块。
5. **全局 loopGuard 开关耦合家族。** 缓解：写入失败路径与 changelog，不假装有 Grok-only kill switch。
6. **`task.md` 删 enum 后模型乱填 effort/schemaMode。** 缓解：schema 仍校验；只删字面量复述、保留 when/how；验证失败则只还原这两行。
7. **不处理 24 分钟空窗 / hub 空等 / 合法长 TTFT。** 这是证据不足，不是遗漏实现。写进非目标，避免实现阶段「顺便」改 idle。

## 6. 验证计划

质量优先：先证明异常路径被拦住且正常任务不被误杀，再报 token 影响。实现阶段跑下列夹具，不跑项目全量套件以外的无关包。Gate 通过前不写产品代码。

### 6.1 质量（必须全绿才进入 6.2）

下列全部是放行门。**§6.1 项 2.3（真实 orca 17×）不 abort，或项 3 负例误杀 = 本方案未完成**，撤回 Grok 门，不得进入 6.2、不得合入。

1. **门真值。** `packages/ai/test/thinking-loop.test.ts`：`createMockModel({ provider: "gateway", id: "grok-4.6" })` 与 `{ provider: "openrouter", id: "x-ai/grok-4.6" }` 守卫为 true；Gemini/DeepSeek 仍 true；`gpt-4o` + `enabled:true` 仍 false；上述 Grok id + `enabled:false` 为 false。`x-ai/grok-4.6` **只测门真值**，不测 stream/session 闭环。
2. **命中（已证实路径 gateway/grok-4.6 mock）。** 同一测试文件，下列均 abort，且断言 `errorId` 为 ThinkingLoop、`content` 为空、`errorMessage` 含 `"stream stall"` **并且**含导出常量 `THINKING_LOOP_ERROR_MARKER`：
   1. 现有 Gemini/DeepSeek 同构 near-dup 循环文本；
   2. 同一短句 back-to-back 重复到超过 `VERBATIM_MIN_REPEATED_CHARS`；
   3. **真实 orca 形状（放行门）：** 脱敏句 `Ensure the test passes with the new logic.` 在同一 thinking 块内出现 17 次；重复句 **非相邻**（之间插入互不相同、且不构成 near-dup cluster 的短过渡句）；按 **chunk 边界**分多次 `thinking_delta` 喂入（至少把该句的若干次出现切到不同 delta）。禁止把 17 次拼成一条字符串一次 `push`。此条不 abort → 撤回 `isLoopGuardedModel` 的 Grok 分支，方案 A 失败。
3. **负例（必须全绿，不只 `distinctReasoning()`）。** 同一 Grok mock：
   1. 现有 `distinctReasoning()` 不 abort；
   2. 「有具体路径/标识符锚点的分段推理」：至少 8 段，每段引入 **新的** `CONCRETE_ANCHOR`（不同 `packages/...` 路径或 camelCase/snake 标识符），允许少量连接词，不得构成 near-dup cluster，不 abort。
4. **空停。** `packages/coding-agent/test/agent-session-empty-stop-guard.test.ts`：用 **同一 table** 覆盖 `reasoning_content` / `reasoning` / `reasoning_text` 三个字段名，thinking-only `stop` 均触发重试（mock.calls≥2，出现 reminder）；`"nonempty"` 签名仍 1 次调用、无 reminder；有 text/toolCall 不重试；超限仍丢空轮。禁止只测其中一个字段名。
5. **Session 闭环（仅已证实路径）。** `packages/coding-agent/test/agent-session-thinking-loop-retry.test.ts`：`provider: "gateway", id: "grok-4.6"` 上 chunked loop → 丢轮 + `customType==="thinking-loop-redirect"` + 再采样成功。既有 Gemini 用例不回归。不在本文件增加 openrouter / xai-oauth / Responses 的 session fixture。
6. **Prompt 契约。** `explicit-grok.md` 不再含与 `"Think step-by-step before acting."` 同义的第二句；仍含 stay-within-request。`task.md` 仍含 effort/schemaMode 的 when/how，仍有 batch/flat 互斥分支；若删了 enum 字面量，schema 测试（既有 task schema 测试，实现时只跑相关文件）仍拒绝非法 `effort`/`schemaMode`。
7. **明确不测。** Fast-mode 开关、compaction 事件、idle 300s、Gemini header 24、`empty-completion-retry` 在 thinking_delta 后不重试、非 gateway Grok 的累计快照与 session 闭环。

### 6.2 Token（仅在 6.1 通过后）

1. 合成 Grok thinking-loop 夹具：abort 前 vs 无门时写入 transcript 的 thinking 长度。期望：有门时循环轮不把 runaway 段落提交进 transcript（空 content 错误轮）。这是无效 token 的主证据。
2. 短会话一轮：对比 overlay 去重前后 system/non-message 或 Grok style block 字符数。期望：减少约一句英文的量级。不把 08-22 `contextSnapshot` 85% non-message（短会话早期固定税）外推成长会话收益。
3. 禁止用「sr_report 11.4M usage_in 下降」这类长会话总量当本 PR 验收。

### 6.3 根因前提核对

- 真实 orca 17× 夹具是 **§6.1 放行门**，不是实现后再观察的附录。命不中：撤回 Grok 门，本方案失败；停止扩大范围去改 Gemini/DeepSeek 阈值或接 header-runaway。漏检形态可记录，另开设计才允许新检测器——那不是方案 A 的完成态。[拟议但已确定]
- 若 §6.1 负例（`distinctReasoning()` 或锚点分段）误杀：撤回 Grok 门并回滚，而不是调低 `SEGMENT_MIN_CLUSTER` / `LEX_STALL_NOVELTY_FLOOR`。
- 非 gateway / 非 openai-completions 的 Grok 路径不在本方案闭环承诺内；其累计快照是否仍漏网保持未知，不阻塞已证实路径，也不写成已支持。

## 7. 实施顺序

关键决策摘要（实现必须遵守）：

1. 推荐方案 A；不实现方案 B。
2. 质量夹具先于 token 数字；token 不是放行门槛。§6.1 真实 orca 17× 与锚点负例均为放行门。
3. 不改 Gemini/DeepSeek 阈值；不接 header-runaway 到 Grok；不改 completions 签名赋值；不改 empty-completion-retry commit 规则。
4. 不新建 kill switch / settings 键；不抽 reasoning-field 共享模块。
5. Prompt 只动 `explicit-grok.md` 与 `task.md` 类型字面量；不动 `system-prompt.md`。
6. 流式/session 闭环只承诺 gateway + openai-completions + grok-4.6。

顺序（**本轮修订后的** Gate PASS* 之后，独立 implementer）：

1. 空停谓词 + empty-stop-guard **三字段 table**（无输出合同，最小 diff）。
2. `isLoopGuardedModel` + thinking-loop 单测（门真值含 `x-ai/grok-4.6`；命中含真实 orca 17× 分 chunk；负例含锚点分段；断言含 `THINKING_LOOP_ERROR_MARKER`）。orca 夹具不 abort 则停止，撤回 Grok 门，不进入后续。
3. session thinking-loop-retry 仅 gateway/grok-4.6。
4. `explicit-grok.md` 去重；`task.md` 类型字面量（可与 1 并行，因无共享契约）。
5. 两包 Unreleased changelog（写明闭环验证范围）。
6. 跑 §6.1 所列测试文件；全绿后做 §6.2 的合成对比，把数字写进 PR 描述而非本设计的验收门槛。

## 8. Handoff

### 8.1 同会话继续

宿主原生路径：`按 subagent-delegation 触发只读 GPT-5.6-sol / subagent-sol（优先与 grok 异模型；author 为 grok 时不可回退到 grok；reviewer 不可用则 claude-opus-5-thinking-high，再主 agent 同模型）。`

本工作 `implementation_authorization=authorized`，授权来源为用户目标「得出结论后先落地文档文件方案，再进行优化及验证」。Round-1 Gate = `NEEDS_REVISION`（artifact `docs/superpowers/plans/2026-08-23-harness-quality-token-optimization-subagent-review.md`）。本修订关闭该 artifact 中 coordinator 已采纳的 MEDIUM-1/2 与 LOW-1/2 后必须 **重跑** 独立 Design Review Gate；`PASS` / `PASS_WITH_NOTES` 且 current Inputs manifest 等于 reviewed manifest（或存在覆盖全部输入的有效 Gate Continuity Note）之后，才由 **未参与 author/reviewer** 的独立 implementer 做 design-implement。作者不得自审，reviewer 不得改产品代码。通过前不得实现。

### 8.2 新会话恢复 prompt
```text
请读取完整设计输入集合（docs/superpowers/specs/2026-08-23-harness-quality-token-optimization-design.md 与 docs/superpowers/specs/2026-08-23-harness-quality-token-optimization-facts-brief.md；facts brief 是结构化设计输入，必须列入 Reviewed Inputs），生成按 normalized path 排序的 path + SHA-256 `Reviewed Inputs` manifest，并计算 `reviewed_revision`；pre-review handoff 不伪造 digest。设计元数据：design_author=grok；design_author_identity=GrokDesigner；implementation_authorization=authorized；authorization_source=用户目标「得出结论后先落地文档文件方案，再进行优化及验证」。Round-1 Gate artifact=docs/superpowers/plans/2026-08-23-harness-quality-token-optimization-subagent-review.md，verdict=NEEDS_REVISION，reviewed_revision=65e2184d34108b9b89678af670d9fbf336f1ff3d18c48a048ed9f7da4256fd21；本修订保留方案 A 并关闭该 artifact 中 coordinator 已采纳的 MEDIUM-1/2 与 LOW-1/2。
使用起草前选定的只读 GPT-5.6-sol / subagent-sol 执行独立 Design Review（优先与全部内容作者异模型；author 为 grok 时不可回退到 grok；reviewer 不可用则 claude-opus-5-thinking-high，再主 agent 同模型，并记录 review_fallback）；将完整 review artifact 持久化到 docs/superpowers/plans/2026-08-23-harness-quality-token-optimization-subagent-review.md。按宿主记录 review_mode=host-native、author/reviewer native agent_id、model、verdict、授权来源与证据。
若文档包含根因分析，请一并核对根因判断、证据与设计方案是否一致。
评审结论必须为 PASS / PASS_WITH_NOTES / NEEDS_REVISION / NEEDS_REDESIGN 四选一，并附可复查证据；禁止作者自审。
NEEDS_REVISION 时回到当前设计文档修订；NEEDS_REDESIGN 时回到 design-brainstorm 重做方案；正文变更后均须重新执行 Gate，且在通过前不得实现。
PASS/PASS_WITH_NOTES 后，current Inputs manifest 等于 reviewed manifest 或存在覆盖全部输入的有效 Gate Continuity Note，且 implementation_authorization=authorized，才继续 design-implement；design-only 必须停止。
Review 后输入变化由未参与 author/reviewer/正文修改/implementation 的主协调者按 handoff 规则分类；非实质变化持久化覆盖完整 manifest 的 Gate Continuity Note，实质、不确定、遗漏输入或角色未分离时重跑 Gate。
```
