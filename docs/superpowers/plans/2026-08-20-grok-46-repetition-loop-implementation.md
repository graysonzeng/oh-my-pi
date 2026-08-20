# Implementation: Grok 4.6 规划句复读防护

- Date: 2026-08-20
- Design Doc: docs/superpowers/specs/2026-08-20-grok-46-repetition-loop-design.md
- Review Doc: docs/superpowers/plans/2026-08-20-grok-46-repetition-loop-design-review.md
- Round-2 Review: docs/superpowers/plans/2026-08-20-grok-46-repetition-loop-design-review-round-2.md
- Status: Completed
- 模板源: `~/.claude/skills/dev-flow-common/references/implementation-template.md`

## 1. 评审意见处理摘要

- 采纳 HIGH-1：completions `supportsReasoningEffort` 写死为 `(!isGrokModelId(spec.id) || isGrokReasoningEffortCapable(spec.id)) && !isXiaomiMimo && (!(isZai || isZhipu) || supportsZaiReasoningEffort)`。
- 采纳 LOW-1：xAI 厂商条款在设计里改标 `[文档声明]`。
- 采纳 round-2 LOW D3：CJK 分支仅在段内有 Han 时启用；Han 按单字 token，不按连续 `\p{L}+`。
- 采纳 round-2 LOW 测试落点：effort 真值表写在 `packages/catalog/test/build.test.ts`。
- 未采纳：降低 64k 夹具、改默认 thinking、加 penalty、第二套 detector。

## 2. 根因前提处理结论（按需）

- 适用性：适用
- 处理策略：修订后实现
- 结论：实现依赖「OMP 漏检 + 64k 放大」这组代码事实，不依赖未观测的 SSE 通道。mode collapse 仍标推断；防护按 D1 同时覆盖 thinking 与 assistant text。

### 2.1 消费的根因评审结论

- SUPPORTED：guard 不含 Grok；verbatim unit/window 抓不住 74 字句；CJK 被剥光；completions 对 xAI host 省略 effort；实际输出夹具 64k。
- WEAK_EVIDENCE：该次附件的 thinking vs text 通道、gateway baseUrl、会话 thinking 覆盖值。
- OVERREACHING：把 xAI 文档当仓库事实（已改标，未据此改默认 thinking）。

### 2.2 本次修订的前提边界

- 已确认事实：见设计 §2.3–2.5 与 round-2 评审。
- 未确认假设：用户附件的 SSE 通道。
- 对实现的影响：`checkAssistantContent` 保持默认开；Grok 用 `isGrokModelId` 而不是 xAI host。

## 3. 采纳的设计修订

- D4 全量布尔 + 禁止两种误读。
- D3 单字 Han，Han 门控。
- Effort 测试落点 `build.test.ts`。
- 74 字按 JS string length，不是 UTF-8 字节。

## 4. 实现摘要

- `packages/ai/src/utils/thinking-loop.ts`
  - `isLoopGuardedModel` 增加 `isGrokModelId(model.id)`
  - `VERBATIM_MAX_UNIT = 96`，`VERBATIM_TAIL_WINDOW = 96 * 4`（384）
  - `normalizeSegment`：段内有 Han 时保留单字 Han + `[a-z0-9]+`（须含字母）；拉丁段走旧剥词
- `packages/catalog/src/compat/openai.ts`
  - import `isGrokModelId`
  - completions `supportsReasoningEffort` 按 D4 布尔
- 测试：`bun test packages/ai/test/thinking-loop.test.ts packages/catalog/test/build.test.ts` → **88 pass, 0 fail**（含 D3 CJK near-duplicate 行为测试）
- lint/typecheck：`bun --cwd=packages/ai check` → passed；`bun --cwd=packages/catalog check` → passed
- 构建：未跑全量 production build；本改动是 stream-layer + catalog compat，聚焦测试 + `bun check` 覆盖合同
- 功能验证：mock `gateway/grok-4.6` 上 74 字符中文句 ×4 在 thinking 流与 `text_delta` 均 abort 为 `THINKING_LOOP_ERROR_MARKER`；带标题的漂移 CJK 段走 `near-identical segments`；`xai/grok-4.6` `supportsReasoningEffort === true`；`xai/grok-code-fast-1` 与 `gateway/grok-code-fast-1` 均为 false 且 `omitReasoningEffort === true`；`openai/gpt-4o` 仍为 true

## 5. 验证结果

- 测试：`bun test packages/ai/test/thinking-loop.test.ts packages/catalog/test/build.test.ts` → **88 pass, 0 fail**（314 expect）
- lint/typecheck：`bun --cwd=packages/ai check` → passed；`bun --cwd=packages/catalog check` → passed
- 构建：未跑全量 production build；本改动是 stream-layer + catalog compat，聚焦测试 + `bun check` 覆盖合同
- 功能验证：mock `gateway/grok-4.6` 上 74 字符中文句 ×4 在 thinking 流与 `text_delta` 均 abort 为 `THINKING_LOOP_ERROR_MARKER`；带标题的漂移 CJK 段走 `near-identical segments`；`xai/grok-4.6` `supportsReasoningEffort === true`；`xai/grok-code-fast-1` 与 `gateway/grok-code-fast-1` 均为 false 且 `omitReasoningEffort === true`；`openai/gpt-4o` 仍为 true

## 6. 已知限制与后续建议

- 近重复路径对纯中文仍要 8 段才 fire；P0 停机靠 verbatim 第 4 次。
- 该次用户附件没有 live SSE 收据；上线后若仍刷屏，先确认是否 `PI_NO_THINKING_LOOP_GUARD=1` 或 `loopGuard.enabled: false`。
- Completions 对某新 Grok SKU 发 effort 导致 400：把它移出 `GROK_EFFORT_CAPABLE_PREFIXES`，不要恢复 host `!isGrok` 一刀切。

## 7. Handoff

### 7.1 同会话继续

直接执行 $code-review 或 /code-review

### 7.2 新会话恢复 prompt

```text
请阅读设计文档 docs/superpowers/specs/2026-08-20-grok-46-repetition-loop-design.md、
评审文档 docs/superpowers/plans/2026-08-20-grok-46-repetition-loop-design-review.md
与 docs/superpowers/plans/2026-08-20-grok-46-repetition-loop-design-review-round-2.md、
实现文档 docs/superpowers/plans/2026-08-20-grok-46-repetition-loop-implementation.md，
以及本次代码变更。
重点核对根因前提、设计修订、实现结果与验证证据是否一致，
使用 grok-4.6 子 agent（`.omp/agents/grok46-reviewer.md`）对实现做只读 code review。
对照 D1–D4：isLoopGuardedModel 含 isGrokModelId；verbatim MAX_UNIT=96 且 WINDOW=384；normalizeSegment Han 门控单字；completions supportsReasoningEffort 为 (!isGrokModelId(spec.id) || isGrokReasoningEffortCapable(spec.id)) && !isXiaomiMimo && (!(isZai || isZhipu) || supportsZaiReasoningEffort)。
不要加第二套 detector、penalty、或降低 64k / 默认 thinking。
```
