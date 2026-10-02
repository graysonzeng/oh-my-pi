# Session Quality / Context / Latency Design Review — Gate 5

## Findings

### P1 / HIGH — N1 仍缺少 `RuntimeAdapter` 到 live benchmark producer 的权威桥接与聚合合同

- **Lens:** architecture / grounded / completion
- **Trigger:** 任一 workflow model-backed stage 的子代理以 `SingleResult.completionKind="budget_stop" | "timeout" | "hard_abort"` 结束；`runtime-default.ts` 将该字段投影到 `StructuredRunnerResult`，`RuntimeAdapter.#runOnce` 随后消费它；最终 live paired run 需要把该具体 kind 写入 `LiveBenchmarkAgentResult → BenchmarkRuntimeResponse → BenchmarkRunResult`。
- **Impact:** 修订稿已经补上 Gate4 指出的两个必要防线：`runtime-default.ts` 的显式字段投影，以及 `liveQualityUnknown===false` 时 missing kind fail-closed。因此原先“字段丢失后默认 completed 并误 PASS”的路径已被关闭。但是，设计仍没有说明 `RuntimeAdapter.#runOnce` 看见的 per-child kind 如何穿过 workflow engine/store/status projection 到达 `runProductionWorkflow`。按当前 owner，正常 live run 到 `runProductionWorkflow` 时只能拿到聚合 `terminalStatus` 与不含 kind 的 `WorkflowStatusReportV1`。实现者若不扩展中间 owner，所有 live run 都会缺 kind 而 fail-closed；若从 `terminalStatus` 猜 kind，则会丢失 `budget_stop` / `timeout` / `hard_abort` 的具体 provenance，违反“completionKind 全链”合同。P1 因此仍不可按文档端到端实现。
- **Evidence:**
  1. 设计已经明确要求 `StructuredRunnerResult.result` 增加字段、`productionRunner` 转发字段、`RuntimeAdapter.#runOnce` 消费字段（`docs/superpowers/specs/2026-08-26-session-quality-context-latency-design.md:311-316`）；随后直接要求 `runProductionWorkflow` 写入 child kind、`runLiveCase` 继续转发（同文档 `:317-319`）。这两段之间没有定义数据持久化、返回值或 workflow status seam。
  2. 当前 `productionRunner` 确实是显式投影：返回对象逐项复制 structured/raw output、patch/branch、usage、exit/error/aborted/abortReason、model/toolCalls，但没有 outcome 字段（`packages/coding-agent/src/workflow/runtime-default.ts:104-123`）。修订稿补这里是正确且必要的。
  3. `RuntimeAdapter.#runOnce` 当前得到 `StructuredRunnerResult.result`，只在 `body.aborted` 时根据错误文本抛 budget/timeout/cancel 类型错误（`packages/coding-agent/src/workflow/runtime-adapter.ts:379-438`）。即使按设计改为读取 typed kind，它返回给 engine 的 `WorkflowAgentResult` 当前仍没有 completion outcome 字段（`packages/coding-agent/src/workflow/types.ts:719-747`）。设计的将改路径也没有把 `WorkflowAgentResult` 列为桥接 owner。
  4. persisted/status projection 同样没有该字段：`WorkflowModelAttemptEvidenceV1` 只有 attempt/stage/role/status、routing 与 execution identity evidence（`packages/coding-agent/src/workflow/types.ts:480-497`）；`WorkflowStatusReportV1` 只有 workflow status、计数、budget totals、quality route 与 model attempts（同文件 `:499-511`）。因此当前 status 查询无法向 live producer提供 child kind。
  5. live benchmark 的真实边界证明该缺口可触发：`executeWorkflow` 只返回 `{ workflowId, terminalStatus, statusReport }`（`packages/coding-agent/src/workflow/benchmark/live-runtime.ts:433-456`）；`runProductionWorkflow` 又只从这些值及 outer-session stats 构造 `LiveBenchmarkAgentResult`（同文件 `:629-683`）。它不能直接访问先前的 `StructuredRunnerResult`。
  6. 修订稿新增的 missing-kind gate 是正确的安全兜底：live/review/Gate paired 缺 kind 必须非 PASS，只有 fake/history fixture 可缺省（design `:301-312,341-345,376-378`）。但 fail-closed 只能防止错误授权，不能凭空建立 producer；缺桥接会使真实完成的 live run同样无法形成可通过的 kind。
- **Required revision:**
  1. 在现有 workflow 链中选定并写清唯一 authoritative bridge。一个最直接的方案是：`WorkflowAgentResult` 携带 typed `completionKind`；engine 将其写入既有 attempt/status evidence；`WorkflowStatusReportV1` 暴露安全的 typed terminal outcome；`executeWorkflow` / `runProductionWorkflow` 从该 projection 聚合后写入 `LiveBenchmarkAgentResult`。也可采用另一条既有 typed seam，但不得靠错误文本或 `terminalStatus` 猜测，也不得新建平行 outcome engine。
  2. 定义 workflow 多 stage / retry 时的聚合规则。至少要说明：哪个 attempt 是 scorecard 的 authoritative attempt、任一 required review/Gate stage 的非 `completed` 是否支配 run outcome，以及 `timeout` / `hard_abort` / `budget_stop` 的优先级。当前“child completionKind”是单数，而真实 workflow 可有多个 model attempts。
  3. 把新增的中间 owner加入 §4.3 将改路径与实现测试。测试必须走真实 `productionRunner → RuntimeAdapter → workflow status/tool result → runProductionWorkflow → runLiveCase → runBenchmarkSuite` 链，证明成功 forced-yield 最终形成 `BenchmarkRunResult.completionKind="budget_stop"` 且非 PASS；同时保留 live missing-kind fail-closed 测试。

## Gate4 N1 逐项关闭判定

| N1 子项 | 判定 | 证据 |
|---|---|---|
| `SingleResult` / terminal lifecycle producer | **关闭** | 四值与 timeout / hard-abort / budget-stop / completed 优先级已定义；terminal lifecycle 必填、started 不填（design `:281-296,320-320,332-335`）。当前 finalizer确有 monitor flags与单一 terminal lifecycle emit owner（`packages/coding-agent/src/task/executor.ts:2276-2345`）。 |
| 父模型 task summary | **关闭** | `task-summary.md` 与 `#buildResultPayload` 均被点名；非 completed kind 不得继续显示成普通 completed，并有 model-facing 测试（design `:298-303,336-340,356-359,440-441`）。当前模板没有 kind（`packages/coding-agent/src/prompts/tools/task-summary.md:1-20`），builder 当前仅按 aborted/exitCode/error 算 status（`packages/coding-agent/src/task/index.ts:1649-1706`），owner 判断正确。 |
| `SingleResult → StructuredRunnerResult` 投影 | **关闭** | 修订稿新增 `StructuredRunnerResult.result.completionKind`，并明确 `productionRunner` 必须转发（design `:313-315,342-343`）；这正是当前会丢字段的投影（`runtime-default.ts:104-123`）。 |
| `RuntimeAdapter.#runOnce` 消费 | **名义关闭** | 设计明确要求成功 budget-stop 即使 `aborted=false` 也不得作为普通 structured success（design `:316`）。 |
| live missing-kind presence gate | **关闭** | 无条件 `?? "completed"` 被禁止；`liveQualityUnknown===false` 缺 kind 非 PASS，仅 fake/history fixture 可缺省（design `:301-312,344`）。 |
| workflow adapter → live producer | **未关闭** | `WorkflowAgentResult`、attempt/status evidence、`WorkflowStatusReportV1` 与 `executeWorkflow` 都没有承载 kind 的合同；design `:317` 只写“来自上面投影”，没有可执行桥接。 |
| N1 总体 | **仍未关闭** | false-PASS safety 已补齐，但具体 completion provenance 尚不能到达真实 live producer；P1 “completionKind 全链”不可实现。 |

## P0 / P1 可实现性

| 优先级 | 杠杆 | 判定 | 证据 |
|---|---|---|---|
| P0 | skill stub | **可实现** | `read.ts` 的 internal result 当前 details 仅含 resolvedPath/contentType，skill 单独 `ignoreResultLimits=true`（`packages/coding-agent/src/tools/read.ts:2465-2490`）；既有 dedupe 会在缺 branch/provider identity 时 fail-open，并在 eligible+同 hash 时返回 context-ref（`packages/coding-agent/src/session/agent-session.ts:3748-3848`）；compaction 与 `auto_compaction_end` 已 clear map（同文件 `:1723-1725,2263-2265`）。设计复用这些 owner，没有第二 memo。 |
| P0 | misroute | **可实现** | unknown skill 当前 fail-closed 且只列 skills（`packages/coding-agent/src/internal-urls/skill-protocol.ts:51-64`）；`getActiveRules()` 已由 canonical rule protocol 使用。精确提示而不 alias 是窄改动。 |
| P0 | wait hint | **可实现** | `HubTool.#executeWait` 已能区分 settled、无可等待对象与 wait window expiry（`packages/coding-agent/src/tools/hub/index.ts:360-520`），`nothingToWaitForResult` 是现有可见 owner（`packages/coding-agent/src/tools/hub/jobs.ts:315-328`）。追加 advisory 文案不需要第二 scheduler。 |
| P1 | review/Gate 20 min cap | **可实现** | `#resolveSpawnPreflight` 与 `#runSpawn` 当前都传全局 `task.maxRuntimeMs`（`packages/coding-agent/src/task/index.ts:741-756,1565-1603`）；既有 `structured-subagent` / executor 接受该值。设计未新造 setting 或 per-agent request-budget engine。 |
| P1 | completionKind 全链 | **阻断** | 见 HIGH finding。 |

## Reviewed Inputs / 完整性

| 字段 | 值 |
|---|---|
| Design SHA-256 | `5bbbb6761d1dd21e91d9bc1046491154834c209fceea737c780c46cca1d0adae` — 已重新计算，与 manifest 一致 |
| Facts brief SHA-256 | `39b5bf8e27a9510b1f8c70118101c9c79c8002e586833d488d24f7e19fdf0019` — 已重新计算，与 manifest 一致 |
| `reviewed_revision` | `c1ae47dd5e56118aa0c843e8639af26a0782c33d8f62c296f2d4e822f0439993` — 按排序后的 `path<TAB>sha256\n` 重新计算一致 |
| Prior Gate | Gate4 已完整读取；其 N1 要求是“existing workflow seam 中建立 authoritative bridge，并让 live missing kind 非 PASS”（`docs/superpowers/plans/2026-08-26-session-quality-context-latency-subagent-review.md:1-20`） |
| Review mode | 只读；未修改仓库；按要求未运行测试、formatter、linter 或 build |
| Author separation | design author 为 Grok；本轮为独立 GPT-5.6-sol Gate，无作者自审 |
| Shadow evidence | architecture `completed_no_finding`；grounded/correctness/completion timeout，按 fail-open；本 finding 由本轮 owner 追踪独立得出 |

## Quantitative / grounded 抽查

- facts brief 的父会话 97、子 jsonl 247、父 task 160（items 257）、compaction 44 次/23 会话（`docs/superpowers/specs/2026-08-26-session-quality-context-latency-facts-brief.md:14-32`）与设计 `:50-54` 一致。
- skill URI 698 次/78 会话、文件系统 SKILL 514 次/40 会话、同会话同 skill 重读 169 对、`skill://adaptive-delivery` 32 次/31 会话（facts `:41-80`）与设计 `:62-75` 一致。
- 单元素 task batch 91（59%）、连续 ≥3 次 wait 74 段/最长 12、review/Gate 137 个且常见 32–63 min、125–192 轮（facts `:103-121`）与设计的基线与 cap 动机一致。20 min 是设计选择，不是伪装成 facts 阈值。
- workflow reviewer profile 当前为 300,000 ms，代码注释与 changelog均说明 3 min 曾中途终止 plan/code review（`packages/coding-agent/src/workflow/default-config.ts:252-253`; `packages/coding-agent/CHANGELOG.md:87`）。设计把 task reviewer cap 设为 20 min 是独立设计取舍，没有把 300s 误报成 task 现状。

## 最小充分性检查

| 检查 | 结论 | 证据 |
|---|---|---|
| 第二引擎 | **PASS** | 方案 A 复用 read dedupe、skill/rule protocol、hub wait、task executor、task summary 与现有 benchmark gate；没有新建 memo、scheduler、scorecard 或 outcome engine（design `:101-140,361-400,443-460`）。 |
| 投机范围 | **PASS** | runtime-adapter / runtime-default / live missing-kind 扩展是 Gate4 N1 的直接必要修订，不是顺手能力；P3、relevance packing、rule 完整交付与长历史 compaction继续列为非目标（design `:443-460`）。 |
| 双份详细设计 | **PASS** | 落败方案 B 仅保留对比与拒绝理由，没有文件级第二实现（design `:101-140`）。 |
| canonical owner | **FAIL（限 N1 bridge）** | 上游与下游 owner均正确，但两者之间的 workflow result/status owner未纳入 handoff；“来自上面投影”不是可执行 seam（design `:311-319`; code evidence 见 HIGH finding）。 |

## Verdict

**NEEDS_REVISION**

P0 三项与 P1 review cap 均已达到最小充分、可实现的设计粒度；Gate4 的 live missing-kind false-PASS 漏洞也已明确改成 fail-closed。但是，`completionKind` 仍无法从 `RuntimeAdapter` 穿过 workflow result/status 边界到达 `runProductionWorkflow`，且多 stage/retry 聚合未定义。该缺口是方案 A 内的窄幅 HIGH completion/architecture 问题，不需要重新选型；补齐 authoritative bridge、聚合规则与真实 producer-chain 测试后再跑 Gate。当前不得授权整体 P0+P1 实现。
