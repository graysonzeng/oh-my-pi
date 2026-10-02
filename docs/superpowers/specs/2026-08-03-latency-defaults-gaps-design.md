# Design: omp 当前延迟保障评估与下一步优化方向

- Date: 2026-08-03
- Status: 最终评审修复完成（round 2）
- Scope: M（文档与设计，无代码改动）
- design_author: deepseek-v4-flash:max（当前会话）
- design_author_identity: LatencyGapDesignAuthor
- planned_reviewer: gateway/deepseek-v4-flash（用户决定 C：round-2 新开干净 subagent，`.omp/agents/flash-reviewer.md`，无先前上下文）
- revision_round: 2
- implementation_authorization: design-only（用户最终指令：现在不实现；核心重点列为后续方案必做项）
- authorization_source:
  1. 用户指令「将上述设计记录到文档中，并使用 gpt-5.6-sol xhigh 进行方案 review。包括背景等信息」。
  2. 用户明确核心重点（后续方案中**一定实现**的内容）：「上下文体积的事前管理，普通会话也做 tool-output truncation，workflow 门禁链并行化，甚至编排层并行，workflow 中每一次都可以尽可能地让主 agent 控制并主动发起并发，主 agent 控制边界及合理编排。上述这些是一定要实现的核心重点，其他酌情考虑，合理即可实现」。
  3. 用户后续澄清：「不要实现」= 当前会话不写代码；核心重点在后续方案中标记为必须实现的内容。
  本设计不修改生产代码、运行配置、其他文档、发布物或提交记录。

## 1. 背景

### 1.1 数据来源与口径

本文的量化结论沿用 `docs/long-session-latency-analysis.md`（2026-08-03，全量会话分析）与 `docs/superpowers/specs/2026-08-03-long-session-performance-optimization-design.md`（round 4）已核对的证据，不重新诊断：

- 语料：886 个会话 JSONL 解析出 689 个真实会话，活跃耗时 306.6h。
- 池分解（活跃耗时占比）：

| 根因 | 耗时 | 占比 | 关键事实 |
|---|---|---|---|
| 模型生成 gen | 174.3h | 57% | Sol 17,205 轮，avg 29s/轮 |
| 首 token TTFT | 92.0h | 30% | Sol avg 16s/轮；全语料 <50k 上下文 8.1s → 200-300k 28-29s → ≥350k 51s |
| hub 同步等待 | 21.3h / 3,559 次 | 7% | 重点会话 avg 1.4m，常见 2-3m 满时长 wait |
| bash 长尾+失败重跑 | 6.2h / 5,534 次 | 2% | E2E 单次 3-5.5m，同命令重跑 ≥8 次 ≈30m |
| eval 异模型门禁 | 3.7h / 578 次 | 1.2% | 单次最长 13.9m；全语料 avg `(3.7×3600)/578=23.04s` |
| web_search | 3.7h / 285 次 | 1.2% | avg 47s/次 |

- 次要但关键的浪费：read 19,117 次，同一 design spec 被读 42 次、同一源文件 29 次（缓存命中 95.7% 是省钱不是省时）；compaction 触发点 316-371k tokens 过晚，会话长期运行在 200-300k。
- 量化标签仅使用五类：[历史事实]（含带日期的仓库/配置观测）、[算术上限]、[推导]、[未验证假设]、[拟议验收目标]。来源类型如「文献」只作引用说明，不替代量化标签。

### 1.2 当前默认延迟保障机制（effective-settings receipt，reviewed_at=2026-08-04）

**Receipt identity**：

- 配置：`/Users/sheng/.omp/agent/config.yml`
- SHA-256：`1eb09e44cb35d1a2ad0dda2162c0e711d044e039e9e4c18fba9b070c756bd5f1`
- 证据段：`:1-2`（workflow enabled）、`:571-608`（workflow quality routes）、`:609-644`（async/task/modelRoles/compaction）
- 边界：这是 configured/effective input，不是 provider 实际执行 attestation；A/B 仍须记录 local resolution 与 provider/gateway attestation。

**Explicit configured values**：

```yaml
workflow.enabled: true
workflow.qualityRoutes:
  balanced.plan_reviewer: [opus_plan_reviewer_high, fable_plan_reviewer_high]
  critical.plan_reviewer: [grok_plan_reviewer_high, sol_plan_reviewer_xhigh]
async.enabled: true
task.eager: preferred
task.batch: true
task.agentModelOverrides:
  scout: gateway/deepseek-v4-flash:max
  designer: gateway/gpt-5.6-sol:high
  task: gateway/gpt-5.6-luna:max
  reviewer: gateway/gpt-5.6-sol:xhigh
modelRoles:
  plan: gateway/gpt-5.6-luna:max
  default: gateway/deepseek-v4-flash:max
compaction.thresholdPercent: 70
compaction.idleEnabled: true
```

**Default-derived effective values**（配置文件未显式写入）：

- `defaultThinkingLevel: "high"`（`packages/coding-agent/src/config/settings-schema.ts:1055-1072`）
- `compaction.idleThresholdTokens: 200000`（`packages/coding-agent/src/config/settings-schema.ts:2250-2270`）
- `modelOptimization.enabled: false`（`packages/coding-agent/src/config/settings-schema.ts:4495-4515`）

**三层模型路由必须分开解释**：

1. `modelRoles`：普通/plan 会话默认角色，显式为 plan=Luna、default=Flash。
2. `task.agentModelOverrides`：task 子代理 agent type 覆盖，显式为 scout/designer/task/reviewer 四项；`reviewer=Sol` 不能外推成 workflow plan reviewer 的当前 route。
3. `workflow.qualityRoutes`：workflow role/tier 的 ordered profile pools；当前 balanced plan reviewer 是 Opus/Fable，critical 是 Grok/Sol。它独立于前两层，并由 route snapshot/lineage 规则解析。Fable 的 canonical family 是 Anthropic，与 Opus 同族，不能当作 Opus 草稿的第三家族独立仲裁者（`packages/catalog/src/identity/classify.ts:14-15,108-119`）。

**[历史事实] 当前代码能力与激活条件**：

- Workflow ContextLedger exact-hash 优化位于 `packages/coding-agent/src/workflow/context-ledger.ts:135-220`；普通会话 read 的 summary cache 位于 `packages/coding-agent/src/tools/read.ts:130-155`，每次仍 fresh-read bytes，未实现「内容已在当前 provider-view 上下文」去重。
- hub `op="wait"` 已用 job/message/timeout/abort 的 `Promise.race`（`packages/coding-agent/src/tools/hub/index.ts:375-465`）；smart 阶梯为 `[5s,10s,30s,60s,300s]`（`packages/coding-agent/src/async/job-manager.ts:1-30`）。
- 普通会话已调用共享 `processToolOutputDetailedAsync`（`packages/coding-agent/src/session/agent-session.ts:3038-3090`）；canonical manager 和 fail-closed recovery 在 `packages/coding-agent/src/workflow/tool-output-manager.ts:350-410,479-545`，per-family 规则在 `packages/coding-agent/src/model-optimization/default-profiles.ts:9-27,53-111`。缺口是 `modelOptimization.enabled=false`，不是能力不存在。
- auto-thinking classifier 已存在，但 `autoThinkingActive` 仅在 `defaultThinkingLevel="auto"` 时为 true（`packages/coding-agent/src/modes/components/settings-defs.ts:118-135`）。当前 default-derived 值是 `high`，classifier 未激活。

### 1.3 上一轮设计（long-session-performance-optimization）要点

`docs/superpowers/specs/2026-08-03-long-session-performance-optimization-design.md`（round 4）推荐**方案 B**：窄 runtime guardrail 路径——观察 control → 配置 arm → 窄 guardrail → A/B 推广；5 个独立 feature 为 `promptPolicy`、`compaction.targetTokens=200k`、`asyncWait.smartMaxSeconds=60`、`bashFailureAdvisory`、`evalBudget`（600s/2 calls），全部默认关闭、可独立回滚。本设计不重复其方案对比，只评估当前默认覆盖度并识别下一步方向。

## 2. 现状评估：当前默认措施是否足够

**结论先行：[推导] 当前配置是有效的防御基线，但历史池不能直接当作当前 residual；gen、验证重跑、eval 门禁和重复 read 的新增可得收益均须由新会话 receipt/A/B 重建。**

| 历史池 | 占比 | 当前 configured/effective 手段 | 可确认覆盖 | 仍需验证 |
|---|---:|---|---|---|
| gen 174.3h | 57% | auto-thinking 能力存在但当前未激活；task overrides 与 workflow route | 路由 seam 存在 | 当前 residual、低价值 Sol 轮次比例、实际 attested model |
| TTFT 92h | 30% | `modelRoles.default=flash`；compaction 70% + idle | configured default 是 Flash；历史跨模型观测为 Sol/Luna 16-17s、Flash/Grok 4s | 不能把历史 16→4s 直接当当前实得；70%/idle 是否避开 200-300k 桶未验证 |
| hub 21.3h | 7% | async/task batch + 事件驱动 wait | 完成事件可立即唤醒 | 真实 child runtime 不可消；依赖门禁仍需有序，只有独立切片可并行 |
| bash 6.2h | 2% | 无 runtime 去重；Plan B 仅拟议 advisory | 原始错误可诊断 | 同失败重跑比例与可减少量 |
| eval 3.7h | 1.2% | 无 native gate migration | bridge 行为存在 | 可重叠独立工作比例与语义等价 |
| web_search 3.7h | 1.2% | 无查询级合并/缓存 | provider timeout 已有 | freshness/命中率 |
| 重复 read | — | 普通 read 无 provider-view content dedupe | workflow 有 exact-hash seam | session/branch/compaction 后「仍在上下文」判定 |

关键判断：

1. **[推导]** Flash 默认、70% compaction 与 async 能防一部分最坏情况，但其历史节省量未由当前会话 attestation/interval ledger 证明。
2. **[推导]** gen 历史池最大；auto-thinking 当前不运行，task/workflow 中仍有高质量模型角色，但 residual 不能从 174.3h 直接外推。
3. **[推导]** 重复 read 与大工具输出是上下文膨胀的燃料。普通会话 truncation seam 已存在但 default-off；事前控制应先复用该 seam，再评价是否需要 read dedupe。
4. **[推导]** 方案 B 偏 guardrail：它不改变 gen，也不从源头消除重复 read；compaction 对 TTFT 的作用只能按实际受影响轮次的桶迁移测量。

## 3. 方案 B 深入（供 review 对照）

- 5 个 feature 全部默认关闭；`performance.longSession` 只是 namespace，每个 leaf 由既有 owner 消费。
- compaction target 受 context window-reserve 约束；不匹配回 control，不做 sidecar compactor。
- asyncWait 不改变 `Promise.race` 与 auto-delivery，只 cap 无完成事件时的 smart 空等顶值；pending 不得当成功。
- bashFailureAdvisory 保留执行、`isError`、exitCode 与 artifact，绝不硬阻断。
- evalBudget 以外层 `EvalTool.execute` 为单位；started 事件须先经 awaited durable barrier，active-branch resume 无法证明完整则 fail closed。
- promptPolicy 只注入一次 gated system block；静态 tool prompt 资产 off 时字节等价。
- 任何 feature 造成完成率/独立 review/确定性 verifier 下降 >2pp、重复 read/repair 上升 >10%，立即关闭对应 feature。

**[算术上限] 直接非 TTFT 历史池的范围比例**：`hub 21.3h + bash 6.2h + eval 3.7h = 31.2h`，`31.2/306.6≈10.176%`，可写「约 10.2%」。这只是三个完整历史池的 scope ratio，不是可消除比例、预期节省或组合收益；compaction 对 TTFT 的间接作用另按受影响轮次测量。

## 4. 更值得做的优化方向

### 4.0 用户指定的核心范围（后续方案必做项，2026-08-03）

1. 上下文体积的事前管理——普通会话也做 tool-output truncation；
2. workflow 门禁链与编排层在依赖允许时并行；
3. 主 agent 显式控制并发边界、数量、隔离与汇合，不由引擎猜测。

其余方向（角色静态细分、验证闭环、eval 迁移）由实现者酌情考虑。当前会话维持 design-only。

### 4.0.1 用户后续设计决定（round 2 前）

- **决定 A**：独立性针对 agent 自审；新开、无作者/先前评审上下文的干净 subagent review 即为独立，不强制异模型族。
- **决定 B**：机械/格式类工作目标改为 `gateway/deepseek-v4-flash:max`；历史 TTFT 参考 Flash≈4s、Luna≈16-17s。
- **决定 C**：round-2 复审用 `gateway/deepseek-v4-flash` 的干净 subagent，不再重复 round-1 Sol reviewer。

### 4.1 方向一：上下文体积事前管理【必做】

- **依据**：[历史事实] 全语料 TTFT 随上下文膨胀（<50k 8.1s → 200-300k 28-29s → ≥350k 51s）；同一 spec read 42 次；普通会话 truncation seam 已存在但 default-off。
- **子项**：
  1. read 去重：普通会话只在能证明相同 provider-view 仍保留内容时返回引用；不确定时 fail open 到全文。
  2. 结论传递：使用 memory-bank 或 `local://` artifact 传递已确认结论/契约，避免整文件重读；不得写入某次会话的绝对 session-local 路径。
  3. 普通会话 tool-output truncation：treatment 激活现有 `modelOptimization` profile 与共享 `processToolOutputDetailedAsync`；control 保持 default-off。【必做】
- **canonical owner 与字节合同**：
  - 复用 `packages/coding-agent/src/session/agent-session.ts` → `packages/coding-agent/src/workflow/tool-output-manager.ts` → `packages/coding-agent/src/model-optimization/default-profiles.ts`；不新增 truncator。
  - enforcement 统一使用当前 `maxBytes/maxLines`（UTF-8 bytes + lines）。保留现有 omission marker、`[raw output: artifact://…]` recovery footer 与 optimization receipt；无 recovery URI 时普通会话返回原文。
  - token 只作观测指标：如报告注入 token delta，receipt 必须记录 tokenizer/estimator version；不得把 token 估算与 UTF-8 byte 上限互换，也不在本方向引入第二预算 owner。
- **read dedupe key/失效**：`normalized_path + selector/range + display_mode + immutable_content_hash + branch/provider_view_id`；compaction、eviction、model/provider switch、branch、rewind 后 reset/reconcile；不虚构 `fresh` 参数，若需要 force/full read 必须先定义真实 schema。
- **独立 arms/rollback**：
  - `ordinary_truncation`：`modelOptimization.enabled` + profile snapshot，default-off；rollback owner=现有 modelOptimization settings/profile。
  - `read_content_dedupe`：read tool owner 下独立 default-off leaf + session/branch-frozen fingerprint snapshot；rollback=关闭该 leaf，恢复全文注入。
- **验收**：[拟议验收目标] 同任务 control/treatment：平均可见 UTF-8 bytes/注入 tokens、ctx≥200k 轮次、重复 read、TTFT P50/P95；受影响轮次 TTFT 下降 ≥10%，返工/遗漏不上升 >10%。

### 4.2 方向二：高价值角色静态细分（酌情）

- **依据**：[历史事实] Sol 17,205 轮 gen 136.9h、TTFT 75.7h；当前三层 route 已有 role/tier seam；用户决定机械/格式类工作目标为 Flash≈4s。
- **边界**：本方向**不改变 plan_review**。Plan review 始终遵循 D 的「单强评审 + 冻结 identity 的同 reviewer 复审 + 条件仲裁」，评审 prompt 落点为 `prompts/workflow/plan-reviewer.md`。Flash 分流只适用于预先明确的机械 repair/格式检查/独立 deterministic evidence，或另行批准的 code_review 实验。
- **分类合同**：初次 review 不得用该 review 尚未产生的 finding severity 反向选择 reviewer。只能使用 caller-declared task class、确定性规则，或已接受 ReviewArtifact 中的既有 finding severity 来分流后续 repair；无法证明分类时走强模型保守路径。
- **canonical owner**：workflow 只扩展 `model-router.ts` / `session-config.ts` / `quality-route-snapshot.ts` 的现有 role/tier profile；FindingTracker 仅消费既有 finding 来选择 repair owner，不建立第二 router。
- **独立 arm/rollback**：route profile 顺序和 classification schema 写入 session-frozen quality-route snapshot；`role_static_split` 独立启用，rollback=恢复 control route snapshot。
- **质量门槛（继承 D metric 语义）**：
  - PASS 硬门：所有适用的 mandatory 规格、用户需求、安全/正确性不变量必须 100% 覆盖；缺失即 gate failure。
  - [拟议验收目标] 非强制探索维度覆盖/反锚定遵守率 ≥90%，证据密度 ≥80%；二者是 rollout diagnostics，不替代 mandatory PASS gate。
  - [拟议验收目标] 质量下降 >2pp、返工上升 >10% 或任一 P0/P1 escape，立即关闭该 arm。

### 4.3 方向三：验证闭环机制化（酌情）

- **依据**：[历史事实] bash 池 6.2h；E2E 同命令重跑 ≥8 次，约 30m。
- **手段**：在 Plan B 的同一 bash failure ledger/owner 内增加独立 `context_injection` treatment mode：下一次同 fingerprint 调用前附加经裁剪、去 secret 的失败摘要；仍允许执行，不硬阻断。摘要使用 UTF-8 byte cap；如观测 token delta，记录 estimator version。
- **独立 arm/rollback**：`bash_failure_context_injection` 与既有 advisory 分开冻结；rollback 到 advisory-only 或 control，不新建第二 fingerprint tracker。
- **验收**：同 fingerprint 重跑次数/失败总时长下降，合法重跑零误抑制，上下文增量在预算内。

### 4.4 方向四：workflow 门禁链与编排层并行【必做】

- **依据**：[历史事实] hub 21.3h/3,559 次，重点会话 103 次 avg 1.4m；当前 hub 已事件驱动，task batch 支持独立 items 并发，workflow review stage 当前每次仅一次 `RuntimePort.run`。
- **Plan_review 形态**：固定为「单强评审 + 冻结 identity 的同 reviewer 复审 + 分歧仲裁」。不是 N-reviewer any-block 投票；仲裁是条件触发的后继状态，不与初评并行。依赖门禁保持有序，并行只作用于确定性检查、证据收集和无依赖 work packages。
- **当前合同边界**：
  - task batch schema 只有 `context + tasks[]`，没有 `dependsOn`/rendezvous；不得假定已有 dependency graph。
  - workflow `PlanArtifact`/work-package schema虽有 `dependsOn`，当前 automatic parallel path 对非空依赖返回 control；dependency-aware orchestration 必须先补版本化合同与恢复语义。
- **版本化声明与 canonical owner**：
  - workflow 路径：`WorkflowConcurrencyDeclarationV1` 由 WorkflowRequest/PlanArtifact/stage policy 承载，WorkflowEngine 持久化；字段至少含 independent group、maxConcurrent、isolation scope、dependency ids、rendezvous/quorum、failure policy。
  - ordinary task 路径：独立 ready set 映射到 `packages/coding-agent/src/task/index.ts` 与 `task/parallel.ts:90-150`；workflow stage execution 映射到现有 `RuntimePort`。没有 `task-batch.ts`。
  - 生命周期：`declared → ready → running → converged → committed | failed | cancelled`；定义 validation、backpressure、cancel、resume、partial failure 和 receipt，主 agent 只声明边界，引擎不猜依赖。
- **hub 语义**：job/message 等待用 `hub op="wait"` 的事件 race；`await:true` 只属于 `op="send"` 的收件人回复等待，不能写成 job-wait 参数。
- **code_review 边界**：若另立并行 code-review 实验，必须使用 `prompts/agents/reviewer.md` 并定义 multi-review envelope（identity/provenance、finding fingerprint、decision conflict、failure quorum、聚合 artifact）；不得改变 plan_review 形态。
- **独立 arm/rollback**：workflow/task 各有独立 default-off policy leaf、session-frozen declaration/snapshot 与 rollback owner；关闭后恢复当前单次 RuntimePort/独立 task batch 行为。
- **质量门槛**：mandatory 维度 100% PASS gate；[拟议验收目标] 非强制探索维度覆盖/反锚定遵守率 ≥90%、证据密度 ≥80%；[拟议验收目标] 质量下降 >2pp、返工 >10% 或 P0/P1 escape 即停。
- **验收**：只计算父 blocked interval 与 critical-path union 的缩短；不把 child actual runtime 当作已消除，也不把同一 interval 在 legacy sum 中重复计入 canonical ledger。

### 4.5 方向五：eval 门禁迁出 bridge（酌情）

- **依据**：[历史事实] eval 3.7h/578 次，全语料 avg 23.04s；Aegis 2.51h/22 次 avg 6.8m，最长 13.9m。
- **手段**：异模型门禁改走 native workflow/task artifact + identity receipt；只有存在可重叠独立工作时，父 critical path 才可能缩短。不得宣称后台化自动消除整个 eval interval。
- **风险**：native workflow 与 bridge 的 decision/inline/isolation 语义不等价；先做 parity receipt，缺失则保持 bridge control。
- **独立 arm/rollback**：`eval_gate_migration` default-off、route/session snapshot 独立；rollback owner=eval/workflow adapter，关闭后恢复现有 bridge，不改变 `agent()` inline/isolation 语义。

### 4.6 优先级与取舍

| 方向 | 作用池 | 杠杆 | 可行性 | 用户优先级 |
|---|---|---|---|---|
| 一：现有 truncation + read dedupe | TTFT/context | 高 | 高（复用 seam） | **必做** |
| 四：门禁/编排并行 | hub/父 blocked interval | 中 | 中（需版本化声明） | **必做** |
| 二：角色静态细分 | gen + Sol TTFT | 条件性高 | 中 | 酌情 |
| 三：失败上下文注入 | bash 重跑 | 中 | 高 | 酌情 |
| 五：eval migration | eval 可重叠部分 | 中 | 中 | 酌情 |

**推荐顺序**：[推导] 用户必做项一、四先进入 Phase 0/独立 arm；方向二、三、五不得因历史池更大而插队。各方向沿用同任务 control/treatment、non-overlap interval ledger、独立 rollback；组合只报 `S_combined`。

### 4.7 条件恒等式与收益证据

以下均不是承诺，Phase 0 前不做跨方向收益排序：

| 方向 | 可复现量 | 标签与边界 |
|---|---|---|
| 一 | 每 1,000 个实际受影响 Sol 轮从 29.1s 桶迁至 15.6s 桶：`(29.1-15.6)×1000/3600=3.75h` | [算术上限]；受影响轮次数未知，不外推 92h |
| 二 | 若 35% 历史 Sol TTFT 轮从 16s 路由到 Flash 4s：`75.7×0.35×(1-4/16)=19.87h` | [未验证假设]；35% 未测，gen 部分不量化，目标模型是 Flash，不是 Luna/Terra |
| 四 | 历史 hub pool 的条件量为 `21.3h×r` | [算术上限]；`r` 必须来自父 blocked interval，排除 child runtime |
| 三 | bash pool 的条件量为 `6.2h×r_repeat` | [算术上限]；`r_repeat` 未测，合法重跑不可扣除 |
| 五 | 仅存在独立可重叠工作时报告 critical-path marginal delta | [未验证假设]；不把 3.7h 全池当收益 |

## 5. 验证计划

- **双 baseline/双账本**：
  1. legacy-reproduction ledger 复算历史 689 会话/306.6h，只用于连续性；
  2. current control 用 reviewed_at=2026-08-04 effective settings 的新会话 receipt 建立；
  3. canonical ledger 对 gen/TTFT/tool/parent wait interval 做 union，legacy sum 单独报告，两者 delta 不混写。
- **Focused contract verification**：
  - 方向一：read hit/miss/invalidation（branch/provider-view/compaction/model switch）、artifact recovery、UTF-8 bytes/lines receipt、无第二 truncator。
  - 方向二：预分类来源、route identity/effort/clean-context receipt；plan_review 不被分流。
  - 方向三：单一 fingerprint ledger、摘要去 secret、合法重跑不被抑制、byte cap。
  - 方向四：声明 schema、依赖 validation、ready-set 并发、quorum/rendezvous、cancel/resume/partial failure；plan_review 单评审合同。
  - 方向五：native gate 与 bridge decision/identity/inline/isolation parity。
- **独立 feature-arm ledger**：每个 arm 必须记录 `armId`、enabled、schema/policy version、session-frozen snapshot、rollback owner；方向一的 truncation 与 read dedupe分开，方向四的 workflow declaration 与可选 code-review 实验分开。
- **A/B 指标**：P50/P95 active critical path per session/per 100 turns、normalized active hours per 100 sessions；TTFT/gen 按 configured/local/attested model + context bucket 分层；requests/tokens/USD/agent count 单列。
- **A/B 纪律（[拟议验收目标]）**：
  - 同任务配对，随机化分配或预注册 CI；
  - Pilot ≥30 sessions，正式 ≥100 sessions 或预注册 CI；
  - 相同 model availability（attested family/checkpoint 分层）；
  - non-overlap interval ledger；单 feature marginal delta，组合只报 `S_combined`；
  - mandatory 规格/用户需求/安全正确性不变量 100% PASS gate；非强制探索维度覆盖/反锚定遵守率 ≥90%，证据密度 ≥80%；
  - 完成率/独立 review/确定性 verifier 下降 >2pp、返工/重复 read 上升 >10%、任一 P0/P1 escape，或预注册 cost/agent-count 阈值触发，立即关闭对应 arm。
- **不双算**：compaction×方向一、方向二×auto-thinking 用分层/factorial arm 报 interaction；门禁节省不含 child runtime；eval bridge 时长不与内部模型时长重复相加。

## 6. 关键决策摘要

- 三层路由分离：`modelRoles`、`task.agentModelOverrides`、`workflow.qualityRoutes` 各有独立 owner/语义；当前 receipt 不能把 task reviewer=Sol 外推成 workflow plan reviewer route。
- auto-thinking 能力存在但当前 default-derived `high` 不激活；ordinary truncation seam 已存在但 `modelOptimization.enabled=false`。
- 方案 B 的 `31.2/306.6≈10.2%` 是 hub+bash+eval 三个完整历史池的 scope ratio，不是节省承诺。
- 必做方向一只激活/扩展现有 `modelOptimization` + read owner，enforcement 用 UTF-8 bytes/lines；不新增第二 truncator 或虚构 `fresh`。
- 必做方向四由 WorkflowEngine/WorkflowRequest/PlanArtifact 与 `task/index.ts`+`task/parallel.ts`/RuntimePort 承载版本化并发声明；plan_review 始终是单强评审+冻结 identity 的同评审复审+条件仲裁。
- 收益恒等式为 19.87h（条件性 35% Sol TTFT→Flash）、23.04s eval avg、约 10.2% scope ratio；Phase 0 前不跨方向排序。
- 用户决定 A/B/C 已传播：干净上下文独立；机械目标 Flash≈4s；round-2 reviewer 为干净 Flash subagent。
- plan review prompt=`prompts/workflow/plan-reviewer.md`；code review prompt=`prompts/agents/reviewer.md`，不得混用。
- mandatory review dimensions 100% PASS gate；≥90% 非强制探索覆盖/反锚定与 ≥80% 证据密度仅为 [拟议验收目标] diagnostics。
- 当前 design-only；无论 review verdict 如何，本会话不实现。

## 7. Handoff

### 7.1 评审约定

- 评审输入：本设计 + `docs/long-session-latency-analysis.md` + `docs/superpowers/specs/2026-08-03-long-session-performance-optimization-design.md` + `docs/superpowers/plans/2026-08-04-latency-delegation-docs-collective-subagent-review.md` 的 B/共性阻塞段；交叉核对 A、C、D 的同一批次当前版。
- round-2 评审模型：`gateway/deepseek-v4-flash`（用户决定 C，干净 subagent）；author 与 reviewer 同模型族但上下文独立，符合用户决定 A。
- 必查：effective-settings receipt 三层、auto-thinking/truncation activation、19.87h/23.04s/约10.2%、Flash/Luna 区分、方向一 canonical seam、方向四声明/状态/真实 owner、plan_review 单强形态、A/B 双账本/独立 rollback/停止条件。
- Verdict 只能是 PASS / PASS_WITH_NOTES / NEEDS_REVISION / NEEDS_REDESIGN，附可复查证据。
- Review artifact 目标：`docs/superpowers/plans/2026-08-03-latency-defaults-gaps-review-round2.md`。

### 7.2 Round-1 Blocking 闭合清单

| Round-1 Blocking | 最终闭合证据 | 状态 |
|---|---|---|
| 1. 当前基线混淆 modelRoles/task overrides/workflow routes，auto-thinking 误作默认启用 | §1.2 dated receipt + config hash；三层分开；`high`/`auto` 激活条件和 200k schema default 明示 | **已闭合** |
| 2. ordinary truncation 重复 canonical seam，token/byte 合同缺失 | §4.1 复用 `modelOptimization`→`processToolOutputDetailedAsync`；UTF-8 bytes/lines enforcement、artifact recovery、token estimator version 分离；无第二 owner | **已闭合** |
| 3. 19.87h/23.04s/Flash/10.2% 算术与标签错误 | §1.1、§3、§4.7；19.87h 条件式、23.04s、Flash 4s/Luna 16-17s、10.2% 仅 scope ratio；无跨方向排序 | **已闭合** |
| 4. 并发落到虚构 `task-batch.ts`/错误 `await:true`，plan_review 与 D 冲突 | §4.4 使用 WorkflowEngine/RuntimePort 与 `task/index.ts`+`task/parallel.ts`；声明/状态/cancel-resume 齐全；`await:true` send-only；plan_review 单强评审 | **已闭合** |

| Round-1 Major | 最终闭合证据 | 状态 |
|---|---|---|
| 用户决定 A/B/C 未传播 | §4.0.1、§6、§7.1 | **已闭合** |
| read dedupe provider-view/invalidation 不足 | §4.1 完整 key、compaction/eviction/model switch/branch/rewind reset/reconcile、fail open | **已闭合** |
| 独立开关/回滚与 A/B 不完整 | §4.1-4.5 arm 边界 + §5 frozen snapshot/rollback owner、30/100、双账本、non-overlap、停止条件 | **已闭合** |
| D 质量 metric 未准确继承 | §4.2、§4.4、§5、§6：mandatory 100% gate；≥90%/≥80% 仅 [拟议验收目标] diagnostics | **已闭合** |

### 7.3 新会话恢复 prompt

```text
读取以下完整输入并使用 repo-relative POSIX path：
- docs/superpowers/specs/2026-08-03-latency-defaults-gaps-design.md
- docs/long-session-latency-analysis.md
- docs/superpowers/specs/2026-08-03-long-session-performance-optimization-design.md
- docs/superpowers/plans/2026-08-04-latency-delegation-docs-collective-subagent-review.md

按 path + TAB + lowercase SHA-256 + LF 序列化 Reviewed Inputs manifest，再计算 manifest 的 SHA-256；禁止伪造未计算的 hash。

按 §7.1 使用 gateway/deepseek-v4-flash 的干净 subagent 做只读 Design Review。逐条核验 §7.2 Blocking/Major、effective-settings 三层、auto-thinking/truncation activation、19.87h/23.04s/约10.2% 的量纲与标签、Flash/Luna 区分、canonical owner、plan_review 单强评审形态、A/B 双账本/独立 rollback/质量停止条件。Verdict 只能是 PASS / PASS_WITH_NOTES / NEEDS_REVISION / NEEDS_REDESIGN，artifact 写入 docs/superpowers/plans/2026-08-03-latency-defaults-gaps-review-round2.md。

implementation_authorization=design-only；评审后停止，不进入实现。
```

## 8. 评审质量背景与反锚定清单需求

### 8.1 背景思路

以下文献标签只说明来源类型；未在本仓库 A/B 验证的行为结论仍标 [未验证假设]：

1. 多模型投票不是普遍成立。MoA（arXiv 2406.04692）与 Self-Consistency 的增益集中在可验证答案任务；Self-MoA（arXiv 2502.00674）显示混合弱模型可能拉低均值。
2. 弱草稿+强评审受草案覆盖度封顶；无外部反馈的纯内部评审可能降质。
3. **[推导]** 文献支持强模型 draft→critique→refine 的潜在增益，但 D 的 1-2 轮收敛上限是 [拟议验收目标]，不是已证实的仓库事实或通用文献定律。
4. **[未验证假设]** Flash 出稿+Sol 评审会比 Opus 出稿+Sol 评审更早 PASS。**[历史事实]** 当前可见仓库 artifacts 只证明相关评审均曾 NEEDS_REVISION，不能把「PASS 早」写成历史事实。

**[推导] PASS 早是内部一致性信号，不是最优性信号。**

### 8.2 反锚定与 PASS gate

适用对象：plan review、另行批准的 code-review 实验及其他 LLM review arm。

1. **反锚定**：输出 `uncoveredDimensions`，列草案未覆盖的约束/风险/备选；若确无缺口，给显式 no-gap evidence。
2. **Finding basis**：每个 FAIL/NEEDS_REVISION finding 标注 `spec_requirement | user_requirement | repo_evidence | safety_invariant | missing_authority`；`missing_authority` 进入 blocked/human，不由模型猜。
3. **PASS 硬门**：所有适用 mandatory 规格、用户需求、安全/正确性不变量 100% 覆盖；缺失即 gate failure。
4. **Rollout diagnostics**：[拟议验收目标] 非强制探索维度覆盖/反锚定遵守率 ≥90%，证据密度 ≥80%；不得用平均值掩盖 mandatory 漏项。
5. **收敛**：单强评审初评 → 冻结 identity 的同一 reviewer 复审；达到条件时进入 D 的仲裁 substate，不改成 N-reviewer 投票或「强模型重写」。
6. **客观维度**：测试/lint/规格 check 走 deterministic verification；LLM 只负责开放维度。

### 8.3 与 D 的最终契约

- Plan review 唯一形态：强草稿 → 单强 reviewer → 冻结 identity 的同 reviewer 复审 → 条件仲裁。
- Plan review prompt：`prompts/workflow/plan-reviewer.md`；code review prompt：`prompts/agents/reviewer.md`。
- 仲裁首选独立的 xAI/Grok；不可用时 fail-closed 转盲化人工。Fable 的 canonical family 是 Anthropic，与 Opus 同族，只能作为显式 degraded clean-context fallback，并须完整 lineage/identity/spec-evidence receipt。
- 方向二的 Flash 分流不适用于 plan_review；方向四的并行不改变 plan_review artifact/decision 语义。
