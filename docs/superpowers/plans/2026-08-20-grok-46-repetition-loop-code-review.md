# Code Review: Grok 4.6 规划句复读防护

- Date: 2026-08-20
- Design Doc: docs/superpowers/specs/2026-08-20-grok-46-repetition-loop-design.md
- Implementation Doc: docs/superpowers/plans/2026-08-20-grok-46-repetition-loop-implementation.md
- Reviewer: project agent `grok46-reviewer`（`gateway/grok-4.6`，thinking-level medium）；主会话核对后落本文档
- 模板源: findings-format.md（code-review 变体）

## 1. 整体结论

- PASS_WITH_NOTES
- 一句话结论：D1–D4 落在现有 `thinking-loop.ts` 与 completions effort 布尔上，合同成立。审查时 D3 缺少直接指纹断言；已补「带漂移的 CJK 段走 near-duplicate」行为测试，未导出 `normalizeSegment`。

## 2. 设计一致性

| 决策 | 实现 | 结果 |
|---|---|---|
| D1 `isGrokModelId(model.id)` | `packages/ai/src/utils/thinking-loop.ts:134-137`；测试 `thinking-loop.test.ts:550-566` | 一致。`gateway/grok-4.6` true；`gpt-4o` 即使 `loopGuard.enabled: true` 仍 false。 |
| D2 unit 96 / window 384 | `thinking-loop.ts:54-58`；74×4=296 可 trip | 一致。74 字符 ×4 测 `back-to-back`；thinking 与 `text_delta` abort。 |
| D3 Han 门控单字 | `thinking-loop.ts:531-551` | 一致。拉丁段走旧剥词。 |
| D4 全量布尔 | `openai.ts:18,481-484`；`build.test.ts:268-319` | 一致。`xai/grok-4.6` emit；xai/gateway `grok-code-fast-1` omit；`gpt-4o` 仍 true。 |

未新增第二套 detector。未改 `models.json` maxTokens。未改 `defaultThinkingLevel`。未发 penalty。

## 3. Findings

### [LOW] 测试: D3 曾无直接指纹断言（审查后已补行为测试）

**文件**: `packages/ai/test/thinking-loop.test.ts:307-318`；`packages/ai/src/utils/thinking-loop.ts:531-551`

**问题**: 初版只覆盖 1×/3× 不 trip、4× verbatim abort。`normalizeSegment` 未导出，拉丁剥词或 Han 切词被改回时，英文 stall 与 74×4 abort 仍可能绿。

**影响**: 不挫 P0（第 4 次 verbatim 仍停）。近重复路径对 CJK 无回归锁。

**建议**: 已落地：8 段带标题、略漂移的中英混合规划句必须 `near-identical segments`。同句 ×8 会先被 verbatim 咬跨段尾巴，故不用原文 74 字连贴。不导出 `normalizeSegment`。

## 4. 验证证据

- `bun test packages/ai/test/thinking-loop.test.ts packages/catalog/test/build.test.ts` → **88 pass, 0 fail**（补 D3 行为测试后）
- `bun --cwd=packages/ai check` → passed
- `bun --cwd=packages/catalog check` → passed

## 5. 评审结论

PASS_WITH_NOTES

无 CRITICAL/HIGH。D3 测试缺口已在同会话补上并复跑绿。

## 6. Handoff

**同会话继续**

确认无需修复，进行最终验证。

**新会话恢复 prompt**

```text
请阅读设计文档 docs/superpowers/specs/2026-08-20-grok-46-repetition-loop-design.md、
评审文档 docs/superpowers/plans/2026-08-20-grok-46-repetition-loop-design-review.md
与 docs/superpowers/plans/2026-08-20-grok-46-repetition-loop-design-review-round-2.md、
实现文档 docs/superpowers/plans/2026-08-20-grok-46-repetition-loop-implementation.md、
代码审查文档 docs/superpowers/plans/2026-08-20-grok-46-repetition-loop-code-review.md，
以及本次代码变更。
确认无需修复，进行最终验证。
D1–D4 已落地：isLoopGuardedModel 含 isGrokModelId；verbatim 96/384；normalizeSegment Han 门控单字；completions supportsReasoningEffort 为 (!isGrokModelId(spec.id) || isGrokReasoningEffortCapable(spec.id)) && !isXiaomiMimo && (!(isZai || isZhipu) || supportsZaiReasoningEffort)。
聚焦测试：bun test packages/ai/test/thinking-loop.test.ts packages/catalog/test/build.test.ts
```
