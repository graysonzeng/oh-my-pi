# Implementation: Agent 输出质量与任务耗时优化

- Date: 2026-08-26
- Design Doc: `docs/research/2026-08-26-agent-output-quality-and-latency-optimization.md` §13
- Review Doc: `docs/superpowers/plans/2026-08-26-agent-output-quality-and-latency-optimization-design-review.md`
- Status: Completed

## 1. 评审意见处理摘要

- 采纳 reuse-first、P0/P1/P2 串行、P3 outcome gate、单变量 verifier 与 quality-first 要求。
- 将 P0 拆为 runtime/policy/RCA；将 edit fail-closed 收窄到 sloppy closest-block recovery。
- 复用 latency cohort/workflow attempt evidence 做 outcome join，不增加 receipt kind。
- lazy discovery 改为 verifier-only；relevance/memory/P3 数据门不满足时保持关闭。
- 不采纳一次性建设八类完整错误平台、第二套 arm taxonomy、第二套 prompt/context/router 基础设施。

## 2. 根因前提处理结论

- 适用性：适用
- 处理策略：修订后实现
- 结论：#9523、sloppy closest-block、outcome join、provider health 等代码前提已核实；#9748/#9747/#9638 与 relevance/memory/P3 受 verifier/data gate 约束。

### 2.1 消费的根因评审结论

独立 review 为 `NEEDS_REVISION`；证实 capped empty stop 未进入 fallback、replace/hashline 与 sloppy 安全合同不同、现有 receipt/arm/benchmark 基础存在但缺 final outcome join、P3 可发现已标注 join records 为 0。

### 2.2 对设计的影响

以设计文档 §13 取代原 §6–§8 的冲突内容；每项实施以 owner/extension point/verifier/non-goal 表为准。

## 3. 设计修订摘要

- 设计文档 §13 给出能力矩阵、P0/P1/P2 执行合同、P3 数据门与实验映射。
- P3 本轮门槛不满足，不运行 shadow：本地 cohort 共 46 条、仅 33 条 completed，46 条 verifier 均为 `unknown`，46 条 task class 均缺失，其中 18 条为 mock。
- unavailable verifier/data 记录为 gate，不伪装成完成。

## 4. 实现计划

### 4.1 P0

- #9523 fallback verifier + `TurnRecovery` 根因修复。
- sloppy near-match bytes-unchanged verifier + closest-block fail-closed。
- latency cohort/workflow attempt evidence 最小 receipt/outcome 外键与 ordinary observable metrics。
- #9748/#9747/#9638 按设计 §13.2 gate 处理。

### 4.2 P1

- 扩展 prompt assembly receipt section metadata并增加确定性 linter。
- 在现有 `ToolError.context`/validation boundary 增加最小 structured metadata。
- 增加最小 deterministic compaction evidence fidelity validator。
- 验证现有 stable/dynamic、cache counter 与 read-view dedupe 合同。

### 4.3 P2

- 在现有 availability/model router 路径增加默认关闭、arm-gated rolling provider health TTL breaker。
- 验证 essential/discoverable+xdev/MCP lazy。
- 只扩展现有 auto-thinking 输入/receipt，不增加 classifier 调用。
- relevance packing 与 memory policy 因数据门不满足保持关闭。

### 4.4 P3

当前 outcome join 标注数为 0；learned router、cross-turn DAG、automatic policy learning 全部不运行 shadow。

## 5. 实现结果

- P0：完成 receipt/outcome join、五个 issue replay verifier、edit fail-closed、empty-stop fallback、ownership/rewind provenance 和 ordinary-session work metrics。
- P1：完成 Prompt section metadata/lint、structured ToolError/ValidationError metadata、schema preflight、compaction evidence fidelity 和稳定 Prompt/context hash 去重。
- P2：完成默认关闭的 provider-health TTL breaker 和 adaptive-thinking operational signals；复用现有 lazy-presentation verifier；relevance/memory 保持关闭。
- P3：未实施；本地数据门槛不满足。

## 6. 验证结果

- Focused contracts：470/470 通过；empty-stop fallback issue replay 1/1 通过。
- Typecheck：`packages/agent`、`packages/ai`、`packages/coding-agent` 全部通过。
- `bun check`：已执行；被基线中 14 个既有 Biome error 与 5 个 warning 阻断，本轮变更文件的新增诊断已修复。
- Build/smoke：coding-agent binary build 通过；source CLI 与 compiled binary `--smoke-test` 均通过。
- Independent review：`IndependentQualityReviewer` 返回 `PASS_WITH_NOTES`；无 CRITICAL/HIGH，也无达到可证明影响门槛的 MEDIUM/LOW correctness finding。

## 7. 独立审查处理

- 审查覆盖设计文档、实现文档以及最终代码/测试变更；reviewer 只读且未运行验证命令。
- P0/P1/P2 与修订设计一致；P3/relevance/memory 正确保持未实施，默认关闭的 arms 未产生生产行为推广。
- 无 CRITICAL/HIGH 需要修复；最终验证证据以上述命令结果为准。
