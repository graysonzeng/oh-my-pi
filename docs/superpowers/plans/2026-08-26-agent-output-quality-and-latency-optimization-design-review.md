# Design Review: Agent 输出质量与任务耗时优化

- Date: 2026-08-26
- Design Doc: `docs/research/2026-08-26-agent-output-quality-and-latency-optimization.md`
- Verdict: **Revise, then implement**
- Revised Source of Truth: design doc §13

## 1. Review 范围与证据

对照当前工作树复核 Prompt assembly/receipt、ordinary optimization receipt、ContextLedger/read dedupe、latency arms/quality gate、routing/availability/auto-thinking、tool loading/errors、compaction/Memory 与 issues #9523、#9717、#9748、#9747、#9638。五个 read-only scout 分别审计 receipt、failure、prompt/tool、context 与 routing；独立 reviewer verdict 为 `NEEDS_REVISION`。

## 2. 根因前提结论

结论：**部分成立，需修订后实现**。

### 已证实

1. #9523：`TurnRecovery.#handleEmptyAssistantStop` 在 capped empty stop 后终止，未进入已有 model fallback chain。
2. #9717：replace/hashline 已有 uniqueness/fail-closed；残余风险是 sloppy closest-block recovery 可能在非唯一证明下落盘。
3. outcome join 缺失：ordinary/prompt/context/tool/route receipt 与 final verifier outcome 没有共同 join contract。
4. provider rolling health/circuit breaker 缺失；现有 usage health 和一次性 availability probe 不能替代。
5. prompt linter、section 级 metadata、最小 compaction fidelity validator 缺失。

### 已有能力，不得重复建设

1. workflow stable prefix/dynamic tail、cache receipt。
2. ContextLedger、artifact/hash dedupe、普通会话 read-view dedupe。
3. essential/discoverable、xdev transport、MCP lazy connection。
4. latency arms、`combinedArmId`、离线 3% quality gate。
5. role/profile/capability/identity routing、fallback、auto-thinking。

### 证据不足或属于 policy

1. #9748 已有 completed rewind lifecycle/marker；必须先 replay 证明仍重复，不能先改 runtime。
2. #9747 普通 task 没有机器可执行 path claim；本轮只明确 prompt ownership contract。
3. #9638 没有 rejected payload/minimal repro；不得先归因为 context size/compaction。
4. relevance packing、memory policy、P3 learned router 缺少本地 outcome/ground-truth 数据。

## 3. Severity Findings 与处理

- **CRITICAL-1** P0 混合确定性 bug、policy 与不可复现 RCA。处理：设计 §13.2 拆为 P0-runtime、P0-policy、P0-RCA。
- **CRITICAL-2** 笼统 edit fail-closed 会误改已安全的 replace/hashline。处理：只针对 `edit/sloppy.ts` closest-block 自动恢复。
- **HIGH-1** 缺 owner/扩展点/verifier/非目标。处理：设计 §13.2–§13.4 增加执行合同。
- **HIGH-2** 抽象实验矩阵与 `LatencyArmId` 不一致。处理：设计 §13.6 复用真实 arms/`combinedArmId`。
- **HIGH-3** receipt→outcome 缺最小 join。处理：复用 ordinary latency cohort observation 与 workflow attempt evidence，不增加 receipt kind。
- **HIGH-4** P2 lazy discovery 已实现。处理：改为 verifier-only；provider-native `tool_search` 留在实验。

## 4. 修订后的实施边界

- P0：#9523、sloppy fail-closed、最小 outcome join/ordinary metrics；#9748/#9747/#9638 受 verifier/data gate 约束。
- P1：确定性 prompt lint/section metadata、渐进 structured error metadata、最小 compaction fidelity、现有 stable/dedupe verifier。
- P2：provider health TTL breaker、复用 lazy discovery、扩展现有 auto-thinking 输入；relevance/memory 门未满足则保持关闭。
- P3：当前可发现 route/strategy→outcome 标注记录为 0，全部不运行 shadow。

## 5. Verdict

修订后的设计可进入实现。每项变化先以 package-local contract test 或明确 benchmark fixture 建立 oracle；已有 verifier 通过的能力记录为“已实现/无需代码”。最终按 focused tests → `bun check` → build/functional smoke → independent code review → critical/high repair → reverify 执行。
