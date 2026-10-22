# Implementation: Per-Model Optimization (Stabilize & Measure)

- Date: 2026-07-25
- Design Doc: `docs/superpowers/specs/2026-07-25-per-model-optimization-design.md`
- Review Doc: scout gap audit（会话内 [Scout](bccf01ed-e759-4f86-9872-e79ea7798989)；无独立 GPT peer-review，按用户要求跳过）
- Status: Completed（Phase A/B 主路径；A3 固定任务集 / Phase C 路由调参未做）

## 1. 评审意见处理摘要

| 意见来源 | 处理 |
|----------|------|
| Gap：`retryOnSchemaViolation` inert | **采纳** — `RuntimeAdapter.run` 接线重试 |
| Gap：`outputPrefixPrompt` inert | **采纳** — `prepareWorkflowInvocation` 追加 |
| Gap：`include*` 两侧均未驱动 ContextBuilder | **采纳** — `resolveArtifactInclusion` + builder 参数 |
| Gap：`instructionFormat` inert | **采纳** — `applyPromptStrategy` 注入 format hint |
| Gap：`toolHistory` inert | **采纳** — `withToolHistoryEviction` 收紧 `keepRecentN` |
| Gap：`fewShotPolicy` / `maxConcurrentTools` | **部分采纳** — 默认关闭 fewShot；类型标注 Reserved；不造假接线 |
| Phase A2 usage 基线 | **采纳** — attempt 级 `usage` artifact |
| bash RTK 风格摘要 | **采纳** — 剥离 progress/pass 噪音 |
| 完整 CWL / tree-sitter | **不采纳（本次）** — 设计方案 B，需测量触发 |
| GPT peer code-review | **不采纳** — 用户明确不启用 GPT；以测试 + `bun check` 验收 |

## 2. 根因前提处理结论

- 适用性：不适用（优化补缝，非故障根因）
- 处理策略：沿用 v2 设计「主干已落地 → 接线 + 测量」
- 结论：不依赖未证实的总会话 token 百分比承诺

## 3. 采纳的设计修订

- 实现阶段执行方案 A（Stabilize & Measure）的 A1/A2/B1/B2/B3
- fewShot 默认 `enabled: false`，避免配置撒谎
- 代码审查式重构：schema 重试抽 `#runOnce`；inclusion 独立模块

## 4. 实现摘要

- **新增** `artifact-inclusion.ts`：`resolveArtifactInclusion` / `withToolHistoryEviction`
- **RuntimeAdapter**：`retryOnSchemaViolation` 循环 + 错误回灌
- **runtime-invocation**：`outputPrefixPrompt`
- **prompt-strategy**：`instructionFormat`；fewShot 标注保留
- **context-builder + engine**：include 标志驱动上下文拼装
- **tool-optimization**：toolHistory → eviction
- **tool-output-manager**：bash 成功路径噪音剥离
- **engine `#recordUsageAndProfile`**：持久化 `usage` artifact（profile + strategies 快照）
- **测试**：`artifact-inclusion.test.ts`；runtime-adapter schema retry；summarizer / per-model 合同更新

## 5. 验证结果

- 测试：`bun test packages/coding-agent/test/workflow/` → **230 pass / 0 fail**
- 聚焦：`artifact-inclusion` / `runtime-adapter` / `tool-output-manager` / `per-model-optimization` → **53 pass**
- lint/typecheck：`bun check` → **通过**（顺手修了 `structured-subagent` import 排序与无关 format）
- 构建：未单独跑 release build
- 功能验证：合同级（fake runner）；真实模型任务集 **未跑**

## 6. 已知限制与后续建议

- `maxConcurrentTools` 仍 reserved（agent 并行上限未暴露）
- `fewShotPolicy` 无 example bank
- `includeFullTranscript` 仍无 transcript 源可挂
- Phase A3 固定 10 任务夹具 + Phase C 路由调参待做
- 未跑 GPT code-review gate

## 7. Handoff

### 7.1 同会话继续
`直接执行 $code-review 或 /code-review`

### 7.2 新会话恢复 prompt
```text
请阅读设计文档 docs/superpowers/specs/2026-07-25-per-model-optimization-design.md、
实现文档 docs/superpowers/plans/2026-07-25-per-model-optimization-implementation.md，
以及本次提交的代码变更。
重点核对根因前提（如有）、设计修订、实现结果与验证证据是否一致，
使用 $code-review（或 /code-review）进行方案重审及代码审查。
```
