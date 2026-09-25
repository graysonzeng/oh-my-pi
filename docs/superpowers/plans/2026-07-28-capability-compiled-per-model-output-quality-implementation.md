# Implementation: Capability-Compiled Per-Model Output Quality

- Date: 2026-07-28
- Design Doc: `docs/superpowers/specs/2026-07-28-capability-compiled-per-model-output-quality-design.md`
- Review Gate: `.design-gate.json` (`PASS_WITH_NOTES`)
- Status: In Progress

## 1. 评审意见处理摘要

- 采纳：普通会话工具输出与上下文必须落在已有 live seam；Gemini descriptor policy 必须同时动态更新 system inventory 与 provider schema。
- 采纳：ordinary completion 只对显式 Todo/Goal/required-yield/extension obligation 生效，并复用现有有界 continuation。
- 采纳：所有 ModelFacts 字段必须有 compiled consumer；unknown capability 必须确定性降级。
- 不采纳项：无。

## 2. 根因前提处理结论

- 适用性：不适用。
- 处理策略：沿用已通过设计。
- 结论：这是增量能力控制面实现，不依赖未确认故障根因。

### 2.1 消费的根因评审结论

- `NOT_APPLICABLE`。

### 2.2 本次修订的前提边界

- 已确认事实：ordinary 与 workflow 优化链分离；部分 ordinary profile 字段当前无 consumer；Gemini descriptor auto 决策固定于 session start；P0-P2 执行 seam 已存在。
- 未确认假设：各模型 overlay 的质量收益；必须通过 live paired ablation 才能启用。
- 对实现的影响：先实现确定性能力编译、接线、receipts 与安全回退；不硬编码未经验证的收益或模型排名。

## 3. 采纳的设计修订

- 实现中持续记录。

## 4. 实现摘要

- 实现中持续记录。

## 5. 验证结果

- 测试：待执行。
- lint/typecheck：待执行。
- 构建：待执行。
- 功能验证：待执行。

## 6. 已知限制与后续建议

- Live provider ablation 依赖本机已有凭据；未执行的 provider 必须标记为 unknown，不得推断质量收益。

## 7. Handoff

### 7.1 同会话继续

`直接执行 $code-review 或 /code-review`

### 7.2 新会话恢复 prompt

```text
请阅读设计输入 docs/superpowers/specs/2026-07-28-capability-compiled-per-model-output-quality-design.md、
实现文档 docs/superpowers/plans/2026-07-28-capability-compiled-per-model-output-quality-implementation.md，
以及本次提交的代码变更，
重点核对根因前提（如有）、设计修订、实现结果与验证证据是否一致，
使用 $code-review（或 /code-review）进行方案重审及代码审查。
```
