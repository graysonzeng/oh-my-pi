# Grok 4.6 规划句复读：根因与防护设计

- 日期：2026-08-20
- 状态：round-2 PASS_WITH_NOTES（D4/LOW-1 已关；D3 切词钉死为单字 Han）
- 范围：`packages/ai/src/utils/thinking-loop.ts`、`packages/ai/src/providers/openai-shared.ts`、`packages/catalog/src/compat/openai.ts`、`packages/ai/test/thinking-loop.test.ts`
- 关联：Gemini/DeepSeek thinking-loop guard、xAI reasoning effort allowlist、OpenAI-compat 64k 输出夹具
- 非目标：不改 TUI 渲染、不引入 frequency/presence penalty、不把 catalog `maxTokens: 500000` 当实际上限、不新写第二套 loop 引擎

## 1. 背景与需求

用户在 `gateway/grok-4.6` 会话里看到大面积逐字复读。附件先把下一步计划写成完整句子，英文章节清单复读 2–3 次，随后锁死在同一句中文规划上，连续数百次：

```
本机没有 Xcode，GitHub 上也没有现成包。先量 Swift 体积、找本机 Xcode，并核对 CLI 能否在无 widget 时单独构建。
```

该句 **74 个汉字 / 144 UTF-8 字节**。这不是 UI 把同一段画了多次，而是自回归在自己刚生成的规划句上塌缩。

需求：

1. 把「模型 CoT 塌缩」和「OMP 为何放任刷到输出上限」分开写清。
2. 复用现有 `ThinkingLoopDetector` / `withGeminiThinkingLoopGuard`，不要第二套检测器。
3. 让 Grok 4.6 这类 verbatim 规划句环在 thinking **和** assistant text 上都能中止，并走现有 retryable stall 路径。
4. Completions 路径对 effort-capable Grok 不要再一刀切丢掉 `reasoning_effort`。

## 2. 根因分析

分层标签：`[事实]` 已读代码/文档；`[推断]` 由事实推出但未用该次会话的 raw SSE 复核；`[未知]` 本次未观测。

### 2.1 现象形态 `[事实]`

- 复读单元是完整规划句，不是单字符墙（`!!!!`）也不是 Gemini 的 `**Title**` 摘要头。
- 中文句无空格、长度 74，超过当前 verbatim 单元上限 60。
- 附件同时有英文短清单复读和中文长句复读；后者占「大面积」。

### 2.2 模型侧 `[事实]` + `[文档声明]` + `[推断]`

`[文档声明]` xAI 文档（https://docs.x.ai/developers/model-capabilities/text/reasoning），仓库无对应断言：

- `grok-4.6` / `grok-4.5` 支持 `reasoning_effort`。
- 不传则默认 `"high"`。
- **Reasoning cannot be disabled.**
- reasoning 模型不能带 `presencePenalty` / `frequencyPenalty` / `stop`，带了会 400。

这些声明支撑「不要用 penalty 打破环」「省略 effort 时上游可能落在 high」，**不**支撑改 OMP 默认 thinking 档。

`[事实]` OMP `defaultThinkingLevel` 默认 `"high"`（`packages/coding-agent/src/config/settings-schema.ts`）。

`[推断]` 长 CoT + agent「先写成完整下一步再 tool call」时，Grok 4.6 会把刚写出的规划句当成最高概率续写。这是模型退化，不是 harness 把同一 chunk 播了多次。

`[未知]` 该次附件落在 `thinking_delta` 还是可见 `text_delta`；gateway 的 `baseUrl` 是否含 `api.x.ai`；该会话是否覆盖了默认 thinking 档。

### 2.3 OMP 放任刷屏 `[事实]`

Loop guard 只覆盖 Gemini / DeepSeek：

```127:130:packages/ai/src/utils/thinking-loop.ts
export function isLoopGuardedModel(model: Model<Api>, options?: StreamOptions): boolean {
	if (options?.loopGuard?.enabled === false) return false;
	const isDeepseek = /deepseek/i.test(`${model.provider}/${model.id}`);
	return isGeminiThinkingModel(model) || isDeepseek;
```

测试钉死非 Gemini/DeepSeek 即使 `loopGuard.enabled: true` 也不开（`packages/ai/test/thinking-loop.test.ts` `isLoopGuardedModel`）。

现有检测器对**这段**中文环也会漏，即便强行打开：

| 检测器 | 门槛 | 这段附件 |
|---|---|---|
| verbatim 尾部重复 | `VERBATIM_MAX_UNIT = 60`，窗口 250，至少 4 次且 `len * count >= 180` | 复读句 74 字；`len=74` 直接不探。窗口 250 也装不下 `74 * 4 = 296` |
| near-duplicate / lexicon stall | `normalizeSegment` 用 `[^a-z0-9]+` 剥词，再要求 `[a-z]` | 中文被删光，段长 < `SEGMENT_MIN_NORM_CHARS`（60），丢弃 |

`detectVerbatimRepetition` 还有硬约束 `searchSpace.length < len * 4` 则 skip。要抓住 74 字 × 4，窗口必须 **≥ 296**，只把 `MAX_UNIT` 提到 80 **不够**。

### 2.4 输出上限把「环」变成「大面积」 `[事实]`

- catalog `xai/grok-4.6` 与 `xai-oauth/grok-4.6` 的 `maxTokens` 都是 **500000**，与 context 相同（`packages/catalog/src/models.json`）。
- 请求路径 `resolveOpenAIOutputTokenParam` 再夹到 `OPENAI_MAX_OUTPUT_TOKENS = 64000`（`packages/ai/src/types.ts`，`openai-shared.ts`）。Grok completions **不是** GLM-5.2 / Kimi K3 那种抬到 `model.maxTokens` 的例外。
- 因此实际可刷上限是 **64k output tokens**，不是 500k。用户看到的「大面积」来自 64k 夹具仍然太大，加上 guard 未触发。

### 2.5 Completions 丢掉 `reasoning_effort` `[事实]` + `[推断]`

Chat Completions：

```338:338:packages/catalog/src/compat/openai.ts
const isGrok = modelMatchesHost(hostModel, "xai");
```

```480:480:packages/catalog/src/compat/openai.ts
supportsReasoningEffort: !isGrok && !isXiaomiMimo && (!(isZai || isZhipu) || supportsZaiReasoningEffort),
```

`KNOWN_HOSTS.xai` 只认 provider `xai` 或 URL 含 `api.x.ai`（`packages/catalog/src/hosts.ts`）。`omitReasoningEffort` 在 `!supportsReasoningEffort` 时为 true（`packages/ai/src/providers/openai-shared.ts`），default dialect 于是不发 `reasoning_effort`。

Responses / `xai-oauth` 相反：用 `isGrokReasoningEffortCapable` allowlist，**`grok-4.6` 在名单上**（`grok-3-mini` / `grok-4.20-multi-agent` / `grok-4.3` / `grok-4.5` / `grok-4.6`）。

路径后果：

| 路由 | effort 是否发出 | 说明 |
|---|---|---|
| `xai/grok-4.6` completions | 否 | `isGrok` true → 省略；上游默认 high |
| `xai-oauth/grok-4.6` responses | 是 | allowlist |
| `gateway/grok-4.6` completions | **取决于** `baseUrl` 是否含 `api.x.ai` | provider 不是 `xai`；无该 URL marker 时 effort **会**发出 |

`[推断]` 省略 effort 是放大器（把会话钉在 high），不是复读的充分条件。gateway 会话即使发出 effort，默认档仍是 high，guard 仍关。

`[未知]` 该次 gateway 的实际 `baseUrl`。

### 2.6 Prompt 形状 `[推断]`

`explicit-grok` 要求 numbered steps；harness 强调先计划再动手。这会诱发出「完整下一步句子」，但本身不会制造逐字环。Gemini header-runaway 只认 `##` / `**Title**`，Grok 的中文散文计划不沾边。Prompt 改动是可选减诱因，不是主修复。

### 2.7 已排除

- TUI 重复渲染：同一句连续出现几百次，且中英两段各自成环，不符合重绘。
- Completions cumulative `reasoning_content` 快照重放：已有 `lastCumulativeReasoningBySignature` 去重（`openai-completions.ts`），且附件是完整句循环而非「整段 thinking 一次次从头贴」。
- 用 `frequency_penalty` 打破环：按 xAI 文档声明，reasoning 模型会 400；仓库无该 400 的回归测试。即使文档有误，环的正确停法仍是 guard abort，不是 penalty。

### 2.8 根因判定

**主因 `[推断]`：** Grok 4.6 在 high reasoning 下对规划句 mode collapse。

**OMP 缺陷 `[事实]`：** guard 不含 Grok；verbatim 单元/窗口抓不住 ≥60 字句；CJK 被 `normalizeSegment` 删光；64k 输出夹具让环跑满。

**放大器 `[事实]`：** completions 对命中 xAI host 的 Grok 省略 `reasoning_effort`，与 responses allowlist 不一致。

## 3. 目标与非目标

目标：

1. `gateway/grok-4.6`、`xai/grok-4.6`、`xai-oauth/grok-4.6` 上，附件这类 74 字中文规划句 × ≥4 必须在 guard 下 abort，走现有 `ThinkingLoop` retryable stall，而不是刷到 64k。
2. 同一检测器继续服务 Gemini/DeepSeek；不改它们已校准的 near-duplicate / lexicon 阈值，除非测试证明 CJK tokenize 破坏英文负例。
3. Completions 对 `isGrokReasoningEffortCapable` 的模型发出 `reasoning_effort`，与 responses 对齐。
4. 回归测试覆盖：Grok 纳入 guard、74 字 CJK verbatim、纯中文段不再被 normalize 成空、短英文负例仍不误报。

非目标：

- 不把 Grok 输出夹具降到「防环」水平（伤合法长答；abort 才是对的停法）。
- 不给 reasoning Grok 发 penalty / stop。
- 不把 `explicit-grok` 大改当 P0。
- 不在 agent loop 再写一套 Gemini 时代的 `detectRepetition`。

## 4. 设计决策

### D1 — 复用现有 stream-layer guard，把 Grok 加进 `isLoopGuardedModel`

Canonical owner 仍是 `packages/ai/src/utils/thinking-loop.ts`。

```ts
const isGrok = isGrokModelId(model.id);
return isGeminiThinkingModel(model) || isDeepseek || isGrok;
```

用 `isGrokModelId`（id 形如 `grok-*` / `x-ai/grok-*`），不要用 `modelMatchesHost(..., "xai")`。否则 `gateway/grok-4.6` 在 baseUrl 不含 `api.x.ai` 时仍漏网。

`loopGuard.enabled: false` 与 `PI_NO_THINKING_LOOP_GUARD=1` 保持总开关。测试里「force enabled for other models 仍 false」要改成：Grok **默认 true**；gpt-4o 一类仍 false。

Grok 走已有 `checkAssistantContent`（默认开）：thinking 环和可见散文环都停。这覆盖「未知通道」。

### D2 — verbatim：同时抬 unit 与 window

只抬 `VERBATIM_MAX_UNIT` 不够。要满足 `searchSpace.length >= len * 4` 且 `count >= 4`。

建议常量（实现时可微调用同一不等式锁住）：

- `VERBATIM_MAX_UNIT = 96`（覆盖 74 字句 + 余量；不要无上限，避免 O(window×unit) 扫超长段）
- `VERBATIM_TAIL_WINDOW = max(当前 250, VERBATIM_MAX_UNIT * 4)` → **384**
- 保持 `VERBATIM_MIN_REPEATED_CHARS = 180`、`count >= 4`、必须含 `\p{L}` / 扩展绘文字

74×4 = 296 < 384，能触发。短单元（emoji、词）行为不变。

合法文本几乎不会把 74 字句子连贴 4 次；误报面窄。

### D3 — `normalizeSegment` 保留 CJK，不改英文校准语料的剥词意图

当前拉丁剥词：

```ts
.replace(/[^a-z0-9]+/g, " ")
.filter(token => /[a-z]/.test(token))
```

改为：段内存在 `\p{Script=Han}` 时走 CJK 分支；否则保持现有拉丁剥词。

CJK 分支 token：`[a-z0-9]+`（仍须含 `[a-z]`，纯数字丢弃）**或**单个 `\p{Script=Han}`。不按连续 `\p{L}+` 切词。74 字规划句会得到 74 个汉字 unigram 加上其中的拉丁词（`Xcode` / `GitHub` / `CLI` / `Swift` / `widget`），trigram Jaccard 对「同句再贴」会很高；P0 第 4 次中止仍靠 D2 verbatim。

必须回归：

- 现有英文 `distinctReasoning` / `perFileTemplates` / `progressLexiconLoop` 结果不变
- 纯中文 74 字段 `normalizeSegment` 后长度 ≥ 60
- 中英混合段（附件那种「GitHub」「Xcode」「CLI」夹汉字）两边都留词

Lexicon stall 的 `CONCRETE_ANCHOR` 已能匹配 `Xcode` / `GitHub` / `CLI` 这类拉丁锚。纯中文无路径句主要靠 verbatim + trigram，不依赖 stall。

### D4 — Completions effort 与 responses allowlist 对齐

`packages/catalog/src/compat/openai.ts` 的 `buildOpenAICompat` 必须把 completions 旗写成下面这句，不得改写成「整个右值 = allowlist」或「只改 host 旗 `!isGrok`」：

```ts
supportsReasoningEffort:
	(!isGrokModelId(spec.id) || isGrokReasoningEffortCapable(spec.id)) &&
	!isXiaomiMimo &&
	(!(isZai || isZhipu) || supportsZaiReasoningEffort);
```

实现时在 `identity/family` 的既有 import 中加上 `isGrokModelId`（文件已 import `isGrokReasoningEffortCapable`）。

真值表（在现有 Xiaomi / Z.AI 条件之外）：

| spec.id | host `isGrok`（`modelMatchesHost(..., "xai")`） | 结果 |
|---|---|---|
| `gpt-4o` 等非 Grok | false | **true**（保持非 Grok 现状；Z.AI/Xiaomi 另计） |
| `grok-4.6`（xai / gateway / 任意 host） | true 或 false | **true**（allowlist） |
| `grok-code-fast-1` / `grok-build`（xai） | true | **false** |
| `grok-code-fast-1`（gateway，host 通常 false） | false | **false**（id 是 Grok 但不在 allowlist） |

禁止的两种误读：

1. `supportsReasoningEffort: isGrokReasoningEffortCapable(spec.id) && …` — 非 Grok 全部变 false。
2. `supportsReasoningEffort: (!isGrok || isGrokReasoningEffortCapable(id)) && …` 且 `isGrok` 仍是 host 匹配 — `gateway/grok-code-fast-1` 仍会发 effort。

`omitReasoningEffort` 继续由 `!supportsReasoningEffort` 推导（含 `whenThinking` 变体，`openai.ts` applyCompatOverrides 之后那两处）。不要对所有 Grok 发 effort：`grok-build` / `grok-4.20-0309-reasoning` / `grok-code-fast-1` 会 400，allowlist 就是为这个存在的。

此修复让 `xai` + `api.x.ai` 的 completions 发出 `grok-4.6` 的 effort；gateway 上 allowlist id 本来就会发。非 allowlist Grok 在任意 provider 上都省略。

不在本设计里改默认 `defaultThinkingLevel`。用户可把 Grok 会话降到 medium/low 作为运维缓解；产品默认仍是 high。

### D5 — 不靠更小 maxTokens 防环

64k 夹具保留。环的正确停法是 guard abort + retry，不是把合法长答砍短。不把 Grok 抬到 catalog 500k（那会让漏检时更糟）。

### D6 — Prompt 不进 P0

`explicit-grok` 可另开低优先级：禁止把同一句下一步完整复述。不作为本修复验收条件。

## 5. 替代方向（已否决）

| 方向 | 否决理由 |
|---|---|
| Agent-loop 再写一套 repetition detector | changelog 已把 Gemini 检测下沉到 pi-ai stream；不要第二套 |
| frequency_penalty / stop | xAI reasoning 400 |
| 默认 thinking 改为 low | 伤所有模型的推理质量；Grok 环应用 guard 收 |
| 不用 Grok 做 agent | 运维建议，不是代码修复 |
| 只改 prompt | 不阻止已经塌缩的 token 流 |

## 6. 实现落点

1. `packages/ai/src/utils/thinking-loop.ts`
   - `isLoopGuardedModel` 加 `isGrokModelId`
   - 文件头注释从「Gemini/DeepSeek」改为含 Grok
   - verbatim 常量按 D2
   - `normalizeSegment` 按 D3
2. `packages/catalog/src/compat/openai.ts` completions `supportsReasoningEffort` 按 D4 全量布尔；import `isGrokModelId`
3. `packages/ai/test/thinking-loop.test.ts`
   - `isLoopGuardedModel({ provider: "gateway", id: "grok-4.6" }) === true`
   - `isLoopGuardedModel({ provider: "openai", id: "gpt-4o" }) === false` 即使 `loopGuard.enabled: true`
   - 74 **字符**（JS string length，不是 UTF-8 字节）中文句 × 4+ 触发 verbatim
   - 现有 Gemini/DeepSeek 正负例保持
   - 中文段 normalize 非空
4. Completions effort 测试写在 `packages/catalog/test/build.test.ts`（`buildOpenAICompat` + `completionsSpec`，不绑 `models.json`）：
   - `xai/grok-4.6` 发出：`supportsReasoningEffort === true` 且 `omitReasoningEffort === false`
   - `xai/grok-code-fast-1` 省略
   - `gateway/grok-code-fast-1` 省略
   - `openai/gpt-4o`（或等价非 Grok completions spec）`supportsReasoningEffort` 仍为 true
5. Changelog：`packages/ai` + `packages/catalog` 各一条 Fixed

不改 `models.json` 的 500k `maxTokens`（生成物）。

## 7. 失败与回滚

- Guard 误杀合法长思考：走现有 `PI_NO_THINKING_LOOP_GUARD=1` / `loopGuard.enabled: false`；阈值回滚只动常量。
- Completions 对某 Grok SKU 发 effort 导致 400：把它移出 `GROK_EFFORT_CAPABLE_PREFIXES`，不要恢复 `!isGrok` 一刀切。
- CJK tokenize 打坏英文 stall 校准：CJK 分支只在段内存在 Han 时启用，拉丁段仍走旧剥词。

## 8. 验收

`[拟议验收目标]`

1. 附件 74 **字符**中文句在 mock `gateway/grok-4.6` thinking 流上，于第 4 次重复后产生 `THINKING_LOOP_ERROR_MARKER`，请求 abort，**不会**跑到 64k。
2. 同一句走 `text_delta` 同样 abort（`checkAssistantContent` 默认开）。
3. `xai/grok-4.6` completions 请求体含 `reasoning_effort`（会话 thinking=high 时为 high）。
4. `xai/grok-code-fast-1` **与** `gateway/grok-code-fast-1` 均不含 `reasoning_effort`。
5. 现有 `thinking-loop.test.ts` Gemini/DeepSeek 用例全绿。
6. 不引入 penalty 字段。
7. 非 Grok completions 的 `supportsReasoningEffort` 不因 D4 变 false。

## 9. 运维缓解（代码落地前）

- 一复读就打断，不要等 64k。
- 该会话 thinking 降到 `medium` / `low`。
- 长任务先换非 Grok。
- 不要设 frequency penalty。
