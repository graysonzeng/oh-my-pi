# Implementation: Per-Model Optimization P0/P1/P2

- Date: 2026-07-25
- Design Doc: `docs/superpowers/specs/2026-07-25-per-model-optimization-p0-p2-design.md`
- Review Doc: `docs/superpowers/specs/2026-07-25-per-model-optimization-p0-p2-design.md.design-gate.json`
- Status: Implemented (production wiring verified; no commit/push)

## 1. 评审意见处理摘要

- 结论：`PASS_WITH_NOTES`，设计 gate 已通过；reviewer 为 Claude Sonnet 5。
- 采纳：本文档是 base design 的增量实施规格；发生冲突时，本次 P0/P1/P2 seam 与验收以增量设计为准，产品总目标仍沿用 base design。
- 采纳：P0 实现前以现有调用链和合同测试再次确认 `read` 正文丢失、bash recovery footer 丢失风险，不只依赖研究结论。
- 采纳：cache receipt 增加 provider 可观测性标记；缺失 cache 事实保持 `null`，不推算为命中或零。
- 部分采纳：增加跨 turn 资源冲突测试，但不跨 turn 建 DAG；未知资源状态采用保守串行化或现有 exclusive 语义。
- 新增修订思考：Stage handoff 的确定性测试忽略动态 artifact ID，改为 canonical payload/fingerprint 确定，而不是要求整个持久化 envelope 字节相同。

## 2. 根因前提处理结论

- 适用性：适用。
- 处理策略：修订后实现。
- 结论：P0 依赖已确认的有损摘要调用链；P1/P2 作为增量优化，必须由合同测试与 paired benchmark 决定是否默认启用。

### 2.1 消费的根因评审结论

- `SUPPORTED`：`read` summarizer 的正文归零调用链可由代码直接复核。
- `WEAK_EVIDENCE`：bash footer 丢失和 cache 收益需合同测试/benchmark 验证，不作为默认开关依据。

### 2.2 本次修订的前提边界

- 已确认事实：`read` 正文会经过 workflow summarizer；usage/routing 基础 artifact 已存在；agent loop 已有并发 seam。
- 未确认假设：真实 provider 的 cache、TTFT、queue attribution 与各项优化的净收益。
- 对实现的影响：未知计量保留为 `null`；P2 默认 gated，不根据理论收益直接改生产默认值。

## 3. 采纳的设计修订

- Base design 与增量设计关系在本实现文档中明确，避免修改已绑定 SHA 的设计正文。
- P2 cache metrics 增加 `cacheObservable`/unknown 语义。
- 并发验收增加跨 turn 资源状态案例，采用保守安全行为。
- handoff 确定性以 canonical content fingerprint 验收。

## 4. 实现摘要

生产接线（关闭 peer-code-review blockers）：

| Area | Seam | Behavior |
|------|------|----------|
| P0 artifact recovery | `processToolOutputDetailed` + session `saveRaw` adapter | Lossy bash/read/grep without footer → persist raw, set `artifact://` recovery URI + reversible when save succeeds; save failure never invents URI |
| P0 UTF-8 maxBytes | `tool-output-manager` clampBytes | Clamp by `Buffer.byteLength` UTF-8 with multi-byte-safe cut (no incomplete sequences) |
| P1 schema repair | `RuntimeAdapter.#tryRepairStructured` | Schema-invalid + exit≠0 → deterministic repair (BOM/fence) before model retry; no field invention |
| P1 handoff/scope | engine + stages | Stage handoff + scope metrics persisted/injected on production path |
| P2 tool budget | agent-loop `remainingToolCalls` + ordered writeback | Cross-batch mutable budget; completion-ordered emit when opted in |
| P2 scheduling SDK | `sdk.ts` toolScheduling | Full policy: maxConcurrent + remaining + resourceConflictMode + orderedResultWriteback |
| P2 assembled prompt | prepare → RuntimeAdapter/default runner | `assembledPromptText` is runner-facing context; final body still respects `contextPolicy.maxArtifactBytes` |
| P2 transformTools | prepare + session + runner | Catalog presentation + aliases applied on production transform path |
| Benchmark gate | `evaluateBenchmarkQualityGate` | `scopeStatus=hard_fail` on optimized → quality gate fail |

## 5. 验证结果

Logs under `$SCRATCH/logs/` (session: `grok-goal-fbe60250c17e/implementer`). Re-verified after skeptic fixes (CLI restore + budget + real transformTools).

| Check | Result |
|-------|--------|
| `bun test packages/coding-agent/test/workflow/` | **278 pass / 0 fail / 43 files** |
| `bun test packages/agent/test/agent-loop.test.ts` | **65 pass / 0 fail** |
| p012-production-wiring contracts | **20 pass / 0 fail** |
| `packages/agent` `bun check` | **pass** (biome + tsgo) |
| `packages/coding-agent` `bun check` | **pass** (biome + tsgo) |
| `packages/coding-agent` `bun run build` | **pass** |
| workflow-bench (fake runtime, json) | **gate.passed=true** |
| `git diff --check -- packages/agent packages/coding-agent` | **clean** (no trailing WS in code packages) |

Skeptic fixes: (1) no maxToolCalls→remainingToolCalls; (2) multi-runtime CLI dispatcher restored; (3) applyWorkflowTransformTools on createTools; (4) honest suite counts.

Note: design markdown under `docs/superpowers/specs/` still has pre-existing trailing whitespace; out of production wiring scope / not cleaned.

## 6. 已知限制与后续建议

- P2 presentation default remains **direct / disabled** (gated); no production routing changes.
- Fake-runtime benchmark scorecard sets `liveQualityUnknown=true` — live provider quality not measured here.
- Final model-facing assembled body is clamped by `maxArtifactBytes` after assembly (preserves pre-P2 budget contract; may truncate stable prefix under extreme tiny budgets like unit tests).
- Peer code-review of this implementer pass still recommended before merge.

## 7. Handoff

### 7.1 同会话继续

`直接执行 $code-review 或 /code-review`

### 7.2 新会话恢复 prompt

```text
请阅读设计输入 docs/superpowers/specs/2026-07-25-per-model-optimization-p0-p2-design.md、
实现文档 docs/superpowers/plans/2026-07-25-per-model-optimization-p0-p2-implementation.md，
以及本次提交的代码变更，
重点核对根因前提（如有）、设计修订、实现结果与验证证据是否一致，
使用 $code-review（或 /code-review）进行方案重审及代码审查。
```
