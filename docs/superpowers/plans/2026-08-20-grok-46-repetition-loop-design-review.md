# Design Review: Grok 4.6 规划句复读防护

- Date: 2026-08-20
- Reviewed Design: docs/superpowers/specs/2026-08-20-grok-46-repetition-loop-design.md
- Review Scope: 根因是否成立 + D1–D6 是否可落地；对照 `thinking-loop.ts`、completions `supportsReasoningEffort`、catalog grok-4.6 `maxTokens`、64k 夹具
- Reviewer: project agent `grok46-reviewer`（`gateway/grok-4.6`，thinking-level medium）；主会话核对行号后落本文档
- 模板源: `~/.claude/skills/dev-flow-common/references/design-review-template.md`

## 1. 整体结论

- NEEDS_REVISION
- 一句话结论：根因方向对（Grok CoT 塌缩 + OMP guard 漏检 + 64k 放大），D1–D3/D5 可落地；D4 的 `supportsReasoningEffort` 布尔没写死，实现会漂成「非 Grok 也不发 effort」或「gateway 上非 allowlist Grok 仍发」。钉死该布尔后再实现。

## 2. 根因评审结论（按需）

- 适用性：适用（设计含根因分析，方案依赖该判断）
- 根因结论：部分成立
- 说明：OMP 漏检与放大器是代码事实；「Grok 4.6 规划句 mode collapse」是对附件形态的推断，该次会话的通道 / gateway baseUrl / thinking 覆盖值仍未知。厂商「不传则 high / reasoning 不能关 / penalty 400」来自 xAI 文档 URL，仓库无对应断言，不应升格为代码事实。

### 证据

- `[事实]` `isLoopGuardedModel` 只返回 Gemini / DeepSeek；`loopGuard.enabled: true` 也不会给 gpt-4o 打开。`packages/ai/src/utils/thinking-loop.ts:127-131`，`packages/ai/test/thinking-loop.test.ts:488-503`。
- `[事实]` `stream()` / `streamSimple` / custom API 均包在 `withGeminiThinkingLoopGuard` 里；classifier 外的模型是 pass-through。`packages/ai/src/stream.ts:761-764`（另 1130、1138）。
- `[事实]` 74 字句进不了现有 verbatim：`VERBATIM_MAX_UNIT=60`，`VERBATIM_TAIL_WINDOW=250`，`searchSpace.length < len*4` 直接 skip。`thinking-loop.ts:50-54,495-515`。74×4=296>250，只抬 MAX_UNIT 不够。
- `[事实]` CJK 被 `normalizeSegment` 的 `[^a-z0-9]` + `/[a-z]/` 删光，段长 < `SEGMENT_MIN_NORM_CHARS=60` 丢弃。`thinking-loop.ts:61,221-222,521-529`。
- `[事实]` catalog `xai/grok-4.6` 与 `xai-oauth/grok-4.6` 的 `maxTokens` 均为 500000。`packages/catalog/src/models.json:92522-92523,92847-92848`。Grok 不在 GLM-5.2 / Kimi K3 夹具例外里（`openai-shared.ts:1122-1132`），实际上限 `OPENAI_MAX_OUTPUT_TOKENS=64000`（`packages/ai/src/types.ts:73`）。
- `[事实]` completions 对 host `xai` 一刀切 `supportsReasoningEffort: !isGrok`（`openai.ts:338,480`；host 定义 `hosts.ts:50`）。responses 用 `isGrokReasoningEffortCapable`，`grok-4.6` 在名单上（`openai.ts:685`，`family.ts:96-112`）。`omitReasoningEffort` 在 `!supportsReasoningEffort` 时为 true（`openai.ts:620-621`）。
- `[事实]` `defaultThinkingLevel` 默认 `"high"`。`packages/coding-agent/src/config/settings-schema.ts:1080-1083`。
- `[推断]` 附件是规划句 mode collapse；省略 effort 是放大器，不是充分条件。gateway 即使发出 effort，默认档仍是 high，guard 仍关。
- `[未知]` 该次附件走 `thinking_delta` 还是 `text_delta`；gateway `baseUrl` 是否含 `api.x.ai`；会话是否覆盖 thinking 档。
- `[未知 / 文档声明]` xAI「不传则默认 high / Reasoning cannot be disabled / penalty+stop 400」仓库无代码证据；设计把它标成 `[事实]` 过强（见 LOW-1）。

未发现与代码矛盾的主因翻转。排除 TUI 重绘、cumulative `reasoning_content` 快照重放，与 `openai-completions.ts:941-963` 的去重一致。

## 3. 设计评审结论

- 设计结论：需修订
- 说明：复用现有 stream-layer detector、用 `isGrokModelId` 覆盖 gateway、verbatim 同时抬 unit/window、CJK 条件保留，方向正确。D4 必须写成全量布尔并补 gateway 非 allowlist 测试，否则验收条 4 不成立。

### 方案对照

| 决策 | 评审 |
|---|---|
| D1 把 Grok 加进 `isLoopGuardedModel`，用 `isGrokModelId` 而非 xai host | 通过。`family.ts:92-93` 匹配 `grok-*` / `x-ai/grok-*`，覆盖 `gateway/grok-4.6`。`checkAssistantContent` 默认开（`thinking-loop.ts:375`）覆盖未知通道。 |
| D2 `MAX_UNIT=96`，`WINDOW=max(250,96*4)=384` | 通过。74×4=296<384 且 74×4≥180，第 4 次可 trip。只抬 unit 仍被 window=250 拦住。 |
| D3 `normalizeSegment` 保留 Han；仅段内有汉字时走 CJK 分支 | 通过。英文 stall 校准可保住；近重复仍受 `SEGMENT_MIN_COUNT=8` 限制，第 4 次中止仍靠 D2。 |
| D4 completions effort 与 allowlist 对齐 | **需修订**。意图对，配方未给出全量布尔。见 HIGH-1。 |
| D5 不靠更小 maxTokens 防环 | 通过。abort 才是对的停法；500k catalog 值保持生成物不动。 |
| D6 prompt 不进 P0 | 通过。诱因不是主修复。 |

跳出框架：不新写 agent-loop detector、不加 penalty、不降默认 thinking、不砍 64k 夹具。这四条否决成立。正确路径仍是 D1–D4，不是重设计。

## 4. Findings

### [HIGH] 设计: D4 `supportsReasoningEffort` 布尔未钉死

**位置**: 设计 §4 D4；`packages/catalog/src/compat/openai.ts:338,480,620-621,685`；`packages/catalog/src/identity/family.ts:92-112`

**问题**: 设计写「改成与 `isGrokReasoningEffortCapable(spec.id)` 一致」，没有给出替换后的全量表达式。两种自然读法都错：

1. 整个右值换成 `isGrokReasoningEffortCapable(spec.id)` → 非 Grok 全部 `supportsReasoningEffort=false`，GPT 等模型不再发 effort。
2. 只把 `!isGrok` 改成 `!isGrok || isGrokReasoningEffortCapable(id)`，而 `isGrok` 仍是 **host** 匹配（`modelMatchesHost(..., "xai")`）→ `gateway/grok-code-fast-1`（provider 不是 `xai`、URL 通常不含 `api.x.ai`、id 不在 allowlist）仍会发 effort，违反设计 §8 验收条 4。

allowlist 前缀是 `grok-3-mini` / `grok-4.20-multi-agent` / `grok-4.3` / `grok-4.5` / `grok-4.6`。`grok-code-fast-1` 与 `grok-build` 均不在内。

**影响**: 误实现会拦掉全仓库 completions effort，或给非 allowlist Grok 发参数导致 400。这是进入实现前必须钉死的合同，不是风格问题。

**建议**: 设计 D4 与实现均写死为：

```ts
supportsReasoningEffort:
  (!isGrokModelId(spec.id) || isGrokReasoningEffortCapable(spec.id)) &&
  !isXiaomiMimo &&
  (!(isZai || isZhipu) || supportsZaiReasoningEffort);
```

测试至少覆盖：

- `xai/grok-4.6` 发出 `reasoning_effort`
- `xai/grok-code-fast-1` 省略
- `gateway/grok-code-fast-1` 省略
- `openai/gpt-4o`（或现有非 Grok 正例）行为不变

`whenThinking` 变体里 `omitReasoningEffort` 仍由 `!supportsReasoningEffort` 推导（`openai.ts:633-634`），改 completions 旗即可，不必另写一套。

### [LOW] RCA: 厂商文档声明标成 [事实]

**位置**: 设计 §2.2 / §2.7

**问题**: 「不传则默认 high」「Reasoning cannot be disabled」「reasoning 模型带 penalty/stop 会 400」来自 xAI 文档 URL，仓库无对应代码或测试。

**影响**: 不改主修复；实现者可能把未核实的厂商行为当成硬约束，或反过来用它论证「必须改默认 thinking 档」（D4/D6 已正确拒绝）。

**建议**: 改标 `[推断]` 或「厂商文档声明」，保留 URL；不要因此改 `defaultThinkingLevel`。

## 5. 未覆盖风险

- `[未知]` 该次用户附件的真实 SSE 通道未复盘；D1 默认检查 thinking + text，覆盖面够，但没有 live 复现收据。
- `[未知]` gateway 实际 `baseUrl` 未读本机配置；D1 用 id 匹配，不依赖该值，D4 钉死后也不依赖。
- 近重复路径对纯中文仍要 8 段才 fire；P0 验收靠 verbatim 第 4 次，不要把 trigram 当主停机条件。
- 74 字 × 4 的 mock 必须按 **字符** 计（JS string length / 汉字），不要用 UTF-8 字节 144 去对 `VERBATIM_MAX_UNIT`。

## 6. 评审结论

NEEDS_REVISION

根因部分成立，足以支撑「扩展现有 guard + 对齐 effort allowlist」，不足以支撑改默认 thinking、加 penalty、或砍 maxTokens。实现前必须把 D4 布尔和 gateway 非 allowlist 测试写进设计正文。

## 7. 下一步

路由：`design-implement`（先修订设计 D4，再按 D1–D3 实现 guard）。

**同会话继续**

直接执行 $design-implement 或 /design-implement

**新会话恢复 prompt**

```text
请阅读设计文档 docs/superpowers/specs/2026-08-20-grok-46-repetition-loop-design.md
和评审文档 docs/superpowers/plans/2026-08-20-grok-46-repetition-loop-design-review.md，
根据评审意见修订设计后，使用 $design-implement（或 /design-implement）进行方案修订及实现。
重点修复 HIGH-1：把 completions `supportsReasoningEffort` 写死为
`(!isGrokModelId(spec.id) || isGrokReasoningEffortCapable(spec.id)) && !isXiaomiMimo && (!(isZai || isZhipu) || supportsZaiReasoningEffort)`，
并补 `xai/grok-4.6` 发出、`xai/grok-code-fast-1` 与 `gateway/grok-code-fast-1` 省略、非 Grok 行为不变的测试。
同时落地 D1–D3：`isLoopGuardedModel` 加 `isGrokModelId`；verbatim `MAX_UNIT=96` 且 `WINDOW>=384`；`normalizeSegment` 在段内有汉字时保留 Han。
不要加第二套 detector、不要发 frequency/presence penalty、不要降低 64k 输出夹具或默认 thinking 档。
```
