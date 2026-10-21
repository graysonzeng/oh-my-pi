# Implementation: conversation-token-cost-optimization

- Date: 2026-07-28
- Design Input: `docs/research/2026-07-28-conversation-token-cost-optimization.md`
- Review Inputs: `agent://ReviewTokenReport`, `agent://TokenSpecReview`, `agent://FinalTokenReview`
- Status: Completed

## 1. 评审意见处理摘要

- 采纳：工具 token 估算明确为近似值，不作为精确账单。
- 采纳：cache-write 不可见时，使用 uncached-input spike 与 prefix divergence 观测。
- 采纳：history flush 不把 Anthropic 90 分钟取值泛化到所有 provider。
- 初轮规格审查的 pairing、provider elision receipts、prune rollback、checkpoint 机器校验与集成测试意见已采纳；receipt append 失败、既有 saveRaw 测试、默认 utilization 与越界 xdev finding 经证据核对后不采纳。修复后最终 reviewer 结论：无阻断问题。

## 2. 根因前提处理结论

- 适用性：适用。
- 处理策略：修订后实现。
- 结论：ordinary `ModelOptimizationProfile` 已声明工具输出与上下文策略，但未接入 ordinary 主会话；源码证据稳定。仓库已有 artifact、prune、compaction 与 context breakdown，优先复用。

### 2.1 消费的根因评审结论

- `SUPPORTED`：profile 执行缺口已由 `default-profiles.ts`、`runtime-policy.ts`、`sdk.ts`、`agent-session.ts` 交叉确认。

### 2.2 本次修订的前提边界

- 已确认事实：ordinary profile 默认关闭；workflow 已有 deterministic tool-output manager、recovery artifact 与 optimization receipt；现有 stale/age prune 可能连续 rewrite；compaction prompt 已结构化但缺少否决项、安全边界、验证与证据指针。
- 未确认假设：provider 不统一暴露 cache-write；无足够实测支持启用跨模型路由或 LLM summarizer。
- 对实现的影响：实现 P0/P1/P2；P3 保持关闭，只保留既有路由能力，不新增自动降级或隐藏摘要调用。

## 3. 采纳的设计修订

- P0 复用现有 context breakdown 和 provider usage；新增 durable tool optimization receipt，不再造第二套 telemetry 框架。
- P1 ordinary profile 默认只启用 deterministic truncation；完整原文必须通过 `artifact://` 可恢复。
- P2 合并 stale 与 age prune 为单次 history rewrite；失败时恢复内存 branch；checkpoint 使用必需 heading + runtime validator，不增加摘要模型调用。
- Provider-only history eviction 仅处理带真实 recovery URI、非错误、存在匹配 tool call 的旧 tool results；不可恢复内容保持原样，输入消息不原地修改。

## 4. 实现摘要

- Ordinary `afterToolCall` 接入 awaitable deterministic truncation；artifact 保存失败或 receipt 持久化失败均保留原始输出。
- 默认 ordinary profile 关闭 LLM summarizer；显式用户 profile 仍可选择启用。
- Provider-only adapter 在目标利用率以上只 elide 可恢复旧结果，返回去重 fingerprint 与 versioned receipt；SDK 将 receipt 持久化为 non-context custom entry。
- Stale supersede/useless 与 age prune 合并为一次 `rewriteEntries`；任一 prune/rewrite 异常恢复 branch 与 live messages。
- Compaction summary/update 要求完整 checkpoint headings；默认 local/remote summary 通过 runtime structure validator，custom prompt override 不强制默认 schema。
- 新增 artifact/receipt、pairing/immutability、afterToolCall、rollback、checkpoint validator 行为测试。
- 更新 `packages/agent/CHANGELOG.md` 与 `packages/coding-agent/CHANGELOG.md` 的 `[Unreleased]`。

## 5. 验证结果

- 测试：`bun test` 11 个相关文件，**99 pass / 0 fail / 408 assertions**。
- Targeted lint/format：本次修改文件已用 Biome 修复；剩余 package-wide diagnostics 位于并发用户的 `packages/agent/src/agent.ts` 与 `packages/coding-agent/src/model-policy/*`，非本实现路径。
- Typecheck：package-wide `bun run check` 被上述并发 WIP 的 unused import、parse/redeclare 错误阻断；本实现原先的 `provider-context-adapter.ts` TS2339 已修复，相关 99 tests 与 targeted builds 均编译通过。
- 构建：`bun run build`（`packages/coding-agent`）成功；三个核心入口 targeted `bun build` 成功。
- 功能验证：`packages/coding-agent/dist/omp --smoke-test` → `smoke-test: ok`；构建产物直接验证 artifact 原文恢复、错误信号保留、provider-only elision receipt、输入消息不变。
- Subagent review：初轮规格审查发现 7 项（5 项采纳修复、2 项证据否决，另 1 项越界忽略）；修复后 `FinalTokenReview` verdict 为 `correct`，无阻断缺陷。

## 6. 已知限制与后续建议

- P3 模型路由与 LLM summarizer 按设计保持关闭，等待真实 `$ / successful task` 与质量评估。
- Provider cache TTL/冷却状态仍由 provider 层语义决定；本次不新增错误的全局 TTL 抽象。
- Provider context token estimate 使用 UTF-8 bytes/4 近似；provider usage 仍是账单权威值。
- Package-wide `bun run check` 需等待并发 `model-policy` / `agent.ts` WIP 修复后重跑；本次不回滚或修改他人工作。

## 7. Handoff

### 7.1 同会话继续

`直接执行 $code-review 或 /code-review`

### 7.2 新会话恢复 prompt

```text
请阅读设计输入 docs/research/2026-07-28-conversation-token-cost-optimization.md、
实现文档 docs/superpowers/plans/2026-07-28-conversation-token-cost-optimization-implementation.md，
以及本次提交的代码变更，
重点核对根因前提（如有）、设计修订、实现结果与验证证据是否一致，
使用 $code-review（或 /code-review）进行方案重审及代码审查。
```
