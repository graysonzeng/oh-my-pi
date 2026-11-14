# Design Review: Grok 4.6 规划句复读防护（round 2）

- Date: 2026-08-20
- Reviewed Design: docs/superpowers/specs/2026-08-20-grok-46-repetition-loop-design.md
- Prior Review: docs/superpowers/plans/2026-08-20-grok-46-repetition-loop-design-review.md
- Review Scope: HIGH-1 D4 布尔是否钉死；LOW-1 厂商文档是否改标；D1–D3 合同是否仍成立
- Reviewer: project agent `grok46-reviewer`（`gateway/grok-4.6`，thinking-level medium）
- 模板源: `~/.claude/skills/dev-flow-common/references/design-review-template.md`

## 1. 整体结论

- PASS_WITH_NOTES
- 一句话结论：HIGH-1 / LOW-1 已关闭；D1–D4 可实现。剩余是实现 nits（D3 切词已在 round-2 修订钉成单字 Han；effort 测试落点定为 `packages/catalog/test/build.test.ts`）。

## 2. 根因评审结论（按需）

- 适用性：适用
- 根因结论：部分成立（与 round 1 相同，未翻转）
- 说明：OMP 漏检与 64k / effort 省略是代码事实；规划句 mode collapse 仍是推断。厂商 xAI 条款已改标 `[文档声明]`。

## 3. 设计评审结论

- 设计结论：合理
- D1 `isGrokModelId(model.id)` 覆盖 gateway；D2 `MAX_UNIT=96` / `WINDOW=384` 覆盖 74×4；D3 Han 门控；D4 全量布尔与禁止误读已写进正文。

## 4. Findings

### [LOW] 设计: D3 切词策略曾双路（round-2 设计已钉死）

**位置**: 设计 §4 D3（修订后：单字 Han）

**问题**: round-2 评审时正文仍允许「单字 token」或「连续 `\p{L}+`」。

**影响**: 不挫 P0（第 4 次靠 verbatim）。近重复路径需实现时锁死。

**建议**: 已采纳：CJK 分支仅在段内有 Han 时启用；Han 按单字 token，拉丁 `[a-z0-9]+` 保持。

### [LOW] 测试: completions effort 用例未指文件（round-2 设计已点名）

**位置**: 设计 §6.4

**问题**: 真值表完整但未命名测试文件。

**影响**: 合同完整；实现可能放错包。

**建议**: 已采纳：`packages/catalog/test/build.test.ts` 的 `buildOpenAICompat`。

## 5. 未覆盖风险

- 该次用户附件的 SSE 通道仍未知；D1 默认检查 thinking + text。
- 近重复对纯中文要 8 段；P0 靠 verbatim 第 4 次。

## 6. 评审结论

PASS_WITH_NOTES

## 7. 下一步

路由：`design-implement`

**同会话继续**

直接执行 $design-implement 或 /design-implement

**新会话恢复 prompt**

```text
请阅读设计文档 docs/superpowers/specs/2026-08-20-grok-46-repetition-loop-design.md、
评审文档 docs/superpowers/plans/2026-08-20-grok-46-repetition-loop-design-review.md
与 docs/superpowers/plans/2026-08-20-grok-46-repetition-loop-design-review-round-2.md，
使用 $design-implement（或 /design-implement）按 D1–D4 实现。
D4 布尔必须是 `(!isGrokModelId(spec.id) || isGrokReasoningEffortCapable(spec.id)) && !isXiaomiMimo && (!(isZai || isZhipu) || supportsZaiReasoningEffort)`。
D3 CJK 分支：段内有 Han 时单字 Han token + 拉丁词；拉丁段走旧剥词。
测试：thinking-loop 74 字符 ×4 abort；catalog/test/build.test.ts 覆盖 xai/grok-4.6 发出、xai 与 gateway 的 grok-code-fast-1 省略、非 Grok 不变。
不要第二套 detector、penalty、或降低 64k / 默认 thinking。
```
