# Review: 延迟优化与主动委派设计文档集体评审（round 1）

- Date: 2026-08-04
- Review mode: host-native read-only subagents（gpt-5.6-sol xhigh，`sol-xhigh-reviewer` agent），独立 lineage from authors（deepseek-v4-flash:max / claude-opus-5 xhigh）
- 评审批次: 5 个并行 `sol-xhigh-reviewer`（`gateway/gpt-5.6-sol` @ xhigh thinking，只读，未编辑任何文件），每份文档一个主评 subagent，其余四份作为交叉引用输入
- 评审对象: 2026-08-03/04 合并进 workflow 分支的五份设计/评审文档（见 Reviewed Inputs manifest）
- Gate type: full Design Review Gate（集体轮）
- Verdict: **5/5 全部 NEEDS_REVISION**；无 PASS、无 NEEDS_REDESIGN

## Verdict 矩阵

| 文档 | Verdict | 一句话结论 |
|---|---|---|
| A `2026-08-03-latency-optimization-plan-design.md` | NEEDS_REVISION | 历史数据复述准确，但既有 blocker 全未修订，且与 D/E 的 plan_review 形态新冲突 |
| B `2026-08-03-latency-defaults-gaps-design.md` | NEEDS_REVISION | 能力基线写反（"默认关闭"写成"不存在"），两方向落到重复/不存在的 owner |
| C `2026-08-03-latency-optimization-plan-review.md` | NEEDS_REVISION | 对 A 的核心结论成立，但自身 headline blocker 依赖未快照的可变配置，已漂移 |
| D `2026-08-04-plan-review-pipeline-design.md` | NEEDS_REVISION | 方案 A 高层选择对，但落地合同缺失：无仲裁 stage/字段、固定路由与现状相反 |
| E `2026-08-04-proactive-subagent-delegation-design.md` | NEEDS_REVISION | 手工 task 链与默认启用的 workflow canonical owner 冲突，A/B 与成本护栏缺失 |

核心方向全部可保留，均可在既有 canonical owner 上修订，无需重新设计。

## 跨文档硬冲突（五份作为集合不一致）

1. **plan_review 形态冲突**：A:190-201 要 N-reviewer + any-block 聚合；D:11,38-46,53-59 已按用户决策定为"单强评审 + 同评审复审 + 分歧仲裁"，并明确多模型并行投票风险（D:29）。E:194,207 又让 plan review 与 code review 都走共享 `prompts/agents/reviewer.md`，并声称"按 D 管线执行"。B:165 与 B:280 亦自相矛盾（N 并行 vs 已定 D 单评审）。
2. **reviewer 落点冲突**：D:41-46 明确 code_review 不在范围内、复用 workflow gate/finding/receipt，落点为 `prompts/workflow/plan-reviewer.md`；E:194,205 指定 `prompts/agents/reviewer.md`（该文件在源码中是 patch-only code reviewer，reviewer.md:3,63-76）。改共享 prompt 会越过用户范围。
3. **固定模型链与当前 quality route 相反**：D:68-70 固定 Opus-xhigh→Sol-xhigh→Opus 仲裁；当前 config.yml:571-597 的 balanced/critical route 是 sol/opus/fable/grok 候选池，且 Opus planner 只有 `high`（config :39-65）；model-router.ts:225-228 禁止 quality route degraded mode、:238-287 跳过同族候选并无候选时抛 `independent_reviewer_unavailable`——D:128 的"Sol 不可用降级 Opus 并标 degraded"与现有 lineage policy 直接冲突。

## 共性阻塞主题（五份交叉验证后成立）

1. **配置基线漂移**：A/C 声称 `task.agentModelOverrides`、`task.eager=preferred`、`compaction.thresholdPercent=70`、`idleEnabled=true` 不存在——当前 `/Users/sheng/.omp/agent/config.yml:609-644` 已显式存在。所有"当前配置"断言必须改为带 `reviewed_at` + hash + explicit/default-derived 区分的 effective-settings receipt；旧值只标 `[历史事实-当时配置]`。
2. **"能力不存在" vs "默认关闭"**：ordinary session 已在 `packages/coding-agent/src/session/agent-session.ts:3046-3085` 调用共享 `processToolOutputDetailedAsync`（`workflow/tool-output-manager.ts:364-401`；per-family rules 在 `model-optimization/default-profiles.ts:9-27,53-111`），仅被 `modelOptimization.enabled` 默认 false 门控（`settings-schema.ts:4505-4508`）。auto-thinking classifier 仅 thinking=`auto` 时激活（`modes/components/settings-defs.ts:126-129`），默认是 `high`（`settings-schema.ts:1065-1069`）。A/B 均误写为"不存在/默认启用"。
3. **虚构 owner**：`task-batch.ts` 不存在（batch owner 在 `task/index.ts`、并发原语 `task/parallel.ts:100-141`）；read 的 `fresh` 参数不存在（`tools/read.ts:720-724`，schema 只有 `path`）；B:161-168 依赖的 `work-packages.ts` 对非空 `dependsOn` 直接返回 null（`:83`）。workflow review 每次仅一次 `RuntimePort.run`（`stages/plan-review.ts:59`、`code-review.ts:61`），ReviewArtifactV1 是单 reviewer 结构（`workflow/types.ts:154-160`）。
4. **算术错误/标签**：A:93 `75.7×0.35≈26h` 是迁移量不是节省；按 16s→4s 正确节省 `75.7×0.35×(1-4/16)=19.87h`，40-60h 无公式支撑（+136.9×15%=20.535h 才约 40.4h）。40-60h/10-18h/7-10h/3-6h/2-3h 一律是 `[未验证假设]`/scenario estimate，非算术上限。4s 对应 flash/grok，Luna 是 16-17s（`docs/long-session-latency-analysis.md:73`），Terra 无实测；B:116 已定目标 flash，A 仍写 luna/terra。
5. **A/B 纪律缺位**：无同任务配对 control/treatment、non-overlap interval ledger、独立 feature arm、质量停止条件。对照 `2026-08-03-long-session-performance-optimization-design.md:37-45`（pilot ≥30、正式 ≥100 或预注册 CI、相同模型可用性）。"N reviewers 与当前单 reviewer 串行等价"不成立——N 会改变 workload、any-block 概率与 artifact schema。
6. **"PASS 早"证据不足**：D:17/B:261/E:188 的"Flash draft + Sol review 更早 PASS"被标为仓库事实，但可见 artifacts 中 Flash/Sol 三轮全为 NEEDS_REVISION（`2026-08-03-long-session-performance-optimization-subagent-review.md:18-23`、`-round-2.md:31-35`、`-round-3.md:31-35`），Opus/Sol 也是 NEEDS_REVISION（C:4-9）。只能标 `[未验证假设]`，需给样本/轮次账本。D:29 的 "precision <17%, SWaB" 在引用的 B/E §8.1 中不存在，不可复现。
7. **cross-check 失效**：A/B 继承的错误源头是 `.omp/agents/opus5-designer.md:18`（把 task-batch 列为 canonical owner）与 author prompt；修订必须连同上游源头一起改，不能只改下游文档。

## 逐文档评审

### A — `docs/superpowers/specs/2026-08-03-latency-optimization-plan-design.md`（613 行）

**Verdict: NEEDS_REVISION**（ReviewPlanDesign）

摘要：历史池分解基本准确；当前配置已显式出现 A 声称的键，故 C 的"这些键不存在"部分已随配置漂移过时。但 A 本身 SHA-256 与 C 评审时完全一致（`f04123…`），全部阻塞项未修订；且 D/E 已把 plan_review 定为单强评审+分歧仲裁，与 A 的 N-reviewer 直接冲突。

Blocking findings：

1. **§1.2 control baseline 不可审计**：四个显式键虽已存在，但 A 的 2026-08-03 历史断言与 C 当时观测冲突；auto-thinking-active 与 workflow-only truncation 仍错误。→ 用 Phase-0 现场 dated receipt 完全替换静态清单（configured value / default-derived effective / local resolution / provider attestation / session-frozen fingerprint）。
2. **方向 1.c 第二 truncation owner + 1.a "已在上下文"判定无 provider-view 正确性**：ordinary truncation 应只激活/扩展现有 `modelOptimization` profile + `workflow/tool-output-manager.ts` seam；read 去重 key 须含 normalized path+selector/range+display mode+immutable content hash+branch/provider-view，compaction/rewind/model switch 时 reset/reconcile，不确定时 fail open，不要虚构 `fresh`。
3. **方向 4 声明载体与执行路径不匹配**：无 `task-batch.ts`，task batch 无 dependency/rendezvous schema，workflow review 走单次 `RuntimePort.run`，hub `await:true` 仅属 send。→ 先定义 versioned declaration 的 canonical owner（Workflow request / PlanArtifact / stage policy），映射到真实 `RuntimePort` 或 `task/index.ts`+`task/parallel.ts`。
4. **N-reviewer plan_review 违反当前 artifact/semantics 并与 D/E 冲突**：plan_review 保持 D 的单强评审；并行只用于确定性检查/证据收集或按触发仲裁。code_review 若另立实验需 multi-review envelope（identity/provenance、finding fingerprint、quorum、cancel/resume）。
5. **§2.1 收益区间冒充 `[算术上限]` 并据此排序**：删除 40-60h > 10-18h > … 排序，改标 `[未验证假设]`；只保留可复现恒等式（每 1,000 受影响 Sol 桶轮 3.75h、hub `21.3h×实测 r`）；Phase-0 后再排名。

Major：历史 baseline 双账本（legacy sum 复现 306.6h vs canonical interval-union）未分离且缺样本量/CI；lineage stop condition 已被 B:115 与 D 的干净上下文仲裁合同取代（model family ≠ 上下文独立性，须拆开）；方向 2 owner/证据/分类时序不完整（Luna 非 4s、finding severity 不能循环决定 reviewer）；Phase 2a 酌情项先于必做项 + 4.b 无真实开关 + bash 双 tracker；方向 5 "blocked interval eliminated" 自相矛盾；review manifest 遗漏 A 本身并固定旧 B hash（`cc8fbc…`，当前 `1f00bb…`）。

Minor：`:24` Sol 桶 15.6s/29.1s 与全语料 51.0s 串成同序列；方向 1 一次性绝对路径 + 错误 `src/context/context-ledger.ts`；方向 4/5 验收无阈值与判定算法。

### B — `docs/superpowers/specs/2026-08-03-latency-defaults-gaps-design.md`（280 行）

**Verdict: NEEDS_REVISION**（ReviewDefaultsGaps）

摘要：历史语料数字复述准确（689 会话/306.6h/池分解、Sol 17,205 轮、read 19,117 次、compaction 316-371k、Aegis eval 22 次 avg 6.8m 等，均与 `docs/long-session-latency-analysis.md` 一致），design-only 授权边界清楚；但当前能力基线写反、核心方向落到重复/不存在的 owner、收益排序含明确算术错误。

Blocking findings：

1. **当前 control 基线错误且混淆三层**：B:38-52 的"八个 modelRoles"不可由当前 config 复现——config.yml:621-628 实为 task overrides（designer/reviewer=Sol、task=Luna），显式 `modelRoles` 只有 plan=Luna、default=Flash；balanced workflow route 的 plan reviewer 是 Opus/Fable。task-agent override、model role、workflow quality route 被合并成"Sol 角色"。auto-thinking 被写成默认启用（实际默认 `high`，classifier 仅 `auto` 时激活）。
2. **普通会话 truncation 重复 canonical seam**：B:125-131 称 ordinary 无 truncation 并计划提取 `processToolOutputDetailed`；实际 `agent-session.ts:226,3047-3064` 已调用共享 `processToolOutputDetailedAsync`，缺口只是 `modelOptimization.enabled=false`。且 B:127-131 同时要求 token 预算与字节等价——canonical manager 合同是 `maxBytes/maxLines`（`tool-output-manager.ts:17-45`），无 token 估算器设计。
3. **收益区间误标 + 明确算术错误**：B:198 `75.7×0.35≈26h` 把目标 TTFT 当零，正确 `19.87h`；B:202 `3.7h/578` 的 avg 写 6.4s，实际 `(3.7×3600)/578=23.04s`；B:116 定 Flash 后文仍写 Luna/Terra≈4s。40-60h 等标 `[未验证假设]`。
4. **主-agent 并发与 parallel-review 不可实现且与 D 冲突**：落到不存在的 `task-batch.ts`，`await:true` 当 wait 合同（实际仅属 send，hub/index.ts:72-83）；plan_review N reviewer 与已定 D 单评审互斥。

Major：read dedupe "历史读过"≠"当前上下文仍有"（未覆盖 selector/display mode、compaction/eviction、branch/rewind，`fresh` 非现有参数，不确定时应 fail open）；A/B 对照不可比 + 双账本与统计门槛缺失；用户决定 A/B/C 未传播到正文（:115 允许同族干净上下文 vs :146 仍要求异 lineage；:116 Flash vs 后文 Luna/Terra；:117 Flash review vs :234,247 Sol）；"所有方向独立开关/回滚"无合同（方向 4 只有 `parallelReview.enabled`，2/3/5 无 snapshot/leaf/rollback owner）。

Minor：配置值未区分 explicit/default-derived（`idleThresholdTokens=200k` 是 schema 默认，settings-schema.ts:2259-2262）；Plan B `≤10%` 过度精确（hub+bash+eval 即 10.176%）；评审质量新增指标未继承 D 的验收门槛（≥90%/≥80% 等）。

### C — `docs/superpowers/plans/2026-08-03-latency-optimization-plan-review.md`（113 行，评审 artifact 复核）

**Verdict: NEEDS_REVISION**（ReviewPlanReview）

摘要：C 对 A 的核心结论总体成立且尺度相称——方向 1 重复 seam、方向 4 合同不匹配、§2.1 误标算术上限均单独足以支撑 A 的 NEEDS_REVISION。但 C 自身一条 headline blocker 依赖未快照的可变配置，按当前配置已不成立；且漏掉 A 对 durable event ledger 与独立回滚合同的重大退化。方法不需重做，artifact 需修订或补 Gate Continuity Note。

四条 blocker 复核：

1. **配置基线漂移**：部分成立但历史证据不可复现。C:15,25,34,49-52 的"键不存在"与当前 config.yml:609-644 直接相反；C:102-109 manifest 未纳入外部 config snapshot/hash，review-time 内容属 `[未验证历史事实]`。→ 加 reviewed_at + repo revision + effective-settings receipt，旧结论标历史，按现配置重建 control；其余三个 blocker 不得因此撤销。
2. **方向 1 重复 seam**：成立可复现。`agent-session.ts:3046-3085` + `tool-output-manager.ts:378-386` + `default-profiles.ts:9-27,53-111` 佐证 C:35,54-57 判断正确。
3. **方向 4 编排合同不匹配**：成立可复现。无 `task-batch.ts`（owner 在 task/index.ts:697-718、task/parallel.ts:1-126）；`await` 是 send 参数（hub/index.ts:75-83）；plan-review.ts:48-59 / code-review.ts:50-61 各一次 `RuntimePort.run`；ReviewArtifactV1 单 reviewer（types.ts:154-169、schemas.ts:96-115）。
4. **§2.1 小时数非算术上限**：成立可复现。A:93-97 的 40-60h 等按 A 自己假设应为 `75.7×0.35×(1-4/16)=19.87h`；方向 1 公式 `92×0.3×13.5/29.1` 把 "30% turns" 替换成 "30% TTFT hours"。

量化审计：689 会话/306.6h/池分解一致；17,205 轮/136.9h/75.7h/15.6s/29.1s 一致但 51.0s 是全语料桶、15.6/29.1 是 Sol 桶，作用域不可混；6,176 chars/9,981 bytes 新鲜复核一致；`modelRoles.default=deepseek-v4-flash:max` 一致；hashes 大体可复现——`git show f580305e:B` 可恢复 C pin 的旧 B hash `cc8fbc…`（当前 `1f00bb…`），证明 C 审的是旧 B revision。

Blocking：C 第一条 headline blocker 不满足"可复现证据"要求（未快照 mutable config）。
Major：未追溯错误源头（B:125,161,166-167 与 `opus5-designer.md:18` 同源，C:95 反而称 manifest"包含"该 agent contract 是多余并删掉了它）；漏掉 A:415-417 对 prior Plan B durable `performanceEvent` 合同的降级（eventId/invocationId/phase/startedAt/endedAt/outcome/durable barrier/active-branch rehydrate/1:1 reconcile/fail-closed 全部丢失，A:453 只留 write test）；独立回滚检查不完整（direction 2/5 无独立 enabled leaf）；跨文档连续性需 continuity note（B:115 已取代旧 strict-lineage 口径）。
Minor：`RuntimePort.run` 证据定位应指 stages/plan-review.ts:59（C:45,66 引的 engine.ts 行是 stage 构造处）；feature-ordering 严重度偏高（4.a/4.b 仍在 Phase 2b，纯排序偏好应降级）；manifest 缺 repo revision/config receipt/整体 reviewed_revision；若按 D/E 新 schema 复用，C 输出格式需升级（非原始缺陷）。
Nit：量化标签统一词汇（当前 config 拆 `[当前事实]`/`[未验证历史事实]`）。

比例评估：C 的 NEEDS_REVISION（而非 NEEDS_REDESIGN）与证据相称；过度挑剔集中在 feature ordering 严重度与把 author prompt 视为无关输入，不足以推翻总体 verdict。

### D — `docs/superpowers/specs/2026-08-04-plan-review-pipeline-design.md`（153 行）

**Verdict: NEEDS_REVISION**（ReviewPipeline）

摘要：D 对 B §8 / E §10 的评审偏置背景复述准确，"仅方案评审/质量优先/单强评审+分歧升级"与用户决策一致。问题在落地合同：现有 workflow 无仲裁 stage/role/结构化分歧字段/作者反驳字段，当前模型路由也不等于 D 的固定 Opus→Sol→Opus；A/B、独立回滚、误 PASS 与升级风暴控制不足。

证据要点（13 条，节选关键）：

- §8/§10 背景引用成立（D:17-23 ↔ B:261-263 ↔ E:188-190）；五项反锚定清单引用成立（D:81-85 ↔ B:268-273 ↔ E:196-200）。
- **D 新增不可复现量化**：D:29 "precision <17%, SWaB" 在其引用的 B:258-260/E:185-187 中不存在。
- **固定模型链与当前 effective route 相反**：D:68-70 vs config.yml:571-597（balanced/critical 候选池），当前 Opus planner 只有 `high`。
- **无仲裁路径**：engine.ts:1092-1154 单次 PlanReviewStage 按 `approved|changes_requested|blocked` 转移，`maxPlanCycles` 达限直接 `blocked: max_plan_cycles_exceeded`；transitions.ts:6,38-43 无仲裁转移；types.ts:26-39,240 无 arbitration status/role。
- **"两轮 refine"与当前 cap 语义不同**：`workflow.maxPlanCycles=2` 是"第 2 次 changes_requested 即 block"（engine-policy-bounds.test.ts:336-359），通常只完成 1 次 replan。
- **触发器/测量字段在严格 schema 中不存在**：schemas.ts:71-104、json-schemas.ts:133-158（`additionalProperties:false`）、context-builder.ts:44-53 无 coverage/uncoveredDimensions/authorResponse。
- **"复用 finding dedupe"不适用 plan review**：只有 code review 走 FindingTracker（engine.ts:1331-1338），plan review 直接按 decision 转移（engine.ts:1130-1144）。
- **prompt 落点覆盖不完整且跨文档冲突**：D 列 workflow prompt/`sol-xhigh-reviewer.md`/autoplan，遗漏 E 指定的 `prompts/agents/reviewer.md`；D:45 排除 code_review 而 E 共用同一 reviewer。
- **同族降级与 lineage policy 冲突**：model-router.ts:225-228 禁止 degraded mode，:238-287 跳过同族候选、无候选抛 `independent_reviewer_unavailable`。
- **升级成本无上限**：budget-ledger.ts:154-155 的 `reviewerCycles` 只递增不参与硬限制。

Blocking findings：

1. **缺少可执行、可恢复的 workflow 状态与 artifact 合同**：三个仲裁触发器无法由当前严格 artifact 判定；PASS/FAIL 与 workflow 三态、项目 reviewer 四值、普通 reviewer `correct|incorrect` 三套 schema 不一致。→ 保留 WorkflowEngine 为 canonical owner，定义版本化 `PlanReviewArtifactV2`（coverage/uncoveredDimensions/basis/specRef/reviewRound/authorResponse/triggerReason）+ 仲裁 substate/持久化/resume/cancel/预算/transition。
2. **固定路由与降级策略不符合当前 route snapshot / lineage gate**：→ 明确 quality tier、列出要新增/调整的严格 profile 与 route 顺序，identity 写入不可变 snapshot；Sol 不可用质量优先应 fail closed 或转人工；若确需同族 clean-context fallback 必须显式修订 lineage policy。
3. **"规格锚定 FAIL"与反锚定目标逻辑冲突**：D:81 找未覆盖约束，D:82,125 又规定无规格引用的 FAIL 无效——规格漏项时真正重要的反锚定 finding 恰好被丢弃。→ finding basis 扩展为 `spec_requirement | user_requirement | repo_evidence | safety_invariant | missing_authority`；缺权威时进 `blocked/human` 而非让仲裁模型猜。
4. **三条调用路径无统一 canonical owner**：workflow / 项目级 `sol-xhigh-reviewer` / 主动委派 reviewer / autoplan 输出合同与生命周期不同；autoplan 实际 active 文件位于 `/Users/sheng/.codex/skills.disabled/flowdeck-budget-20260511/autoplan/SKILL.md`（CEO/Design/Eng/DX 多评审、顺序强制、双 voice，非单强）。→ 先声明唯一 policy owner 与 versioned contract，agent/skill 只作 adapter；无 active owner 的路径先移出设计。

Major：A/B 至少拆 `route/antiAnchoring/specEvidence/suspiciousPassEscalation/arbitration` 五个独立 arm + 同稿配对 + pilot ≥30/正式 ≥100 或预注册 CI + interval union 计一次；风险覆盖缺 blinded-human false-PASS/false-FAIL、P0/P1 escape、无效阻断率、arbitration trigger rate、成本 P50/P95，任一 P0/P1 逃逸或人工一致率下降 >2pp/返工上升 >10% 即关闭 feature；仲裁者与作者同家族（Opus）且不可申诉，与 D 自己的 family-preference 机制矛盾（优先第三家族或盲化人工，缺 identity/clean-context/spec-evidence receipt 任一项 fail closed）；SWaB/“Opus 第二强”/“家族偏置最小”/“5-25% 健康区间”均无可复现来源，90%/80%/≤2 未标 `[拟议验收目标]`，D:69 用非本文标签体系的 `[INFERENCE]`。

Minor：验收内部不一致（:83 逐条核对 vs :134 平均 80%；:77-85 必含 vs :133 容许 10% 不遵守）；"同作者 refine/同 reviewer 复审"无 identity pinning（route 解析可换模型，降级须产生新 route receipt）；质量守卫引用笼统（long-session §6.4 的 fail-closed identity/scope/逐 feature 关闭动作未复制，D:153 只摘 2pp/10%）。
Nit：D:110 `opu-5` 应为 `opus-5`；统一既定中文证据标签。

### E — `docs/superpowers/specs/2026-08-04-proactive-subagent-delegation-design.md`（207 行）

**Verdict: NEEDS_REVISION**（ReviewDelegation）

摘要：核心目标（普通会话更主动、独立切片自动 fan-out）可保留，但不能进入实现。§2 多处过期或过度概括；手工 planner→reviewer→worker→reviewer 链与默认启用的 workflow canonical owner、generic reviewer 契约及 D 的 plan-review 范围不一致；全局默认翻转与模型路由变更缺 A/B、独立回滚、成本/质量停止条件与可用性 fallback 证明。

Blocking findings：

1. **阶段链未复用 canonical workflow owner**：E:15,43,108,177,194,207 让主模型用 task 自组织完整链；`prompts/tools/workflow.md:1-9` 已拥有同一链且 D:41-46 要求主动委派的 plan→review 复用 workflow gates/receipts；E 改动清单无 WorkflowArtifact/持久状态/deterministic verifier/repair/receipt/resume。→ 明确唯一边界：task 主动委派只做已 scope 独立切片与只读 scout/critique；完整 design→review→implement→code-review 门禁走既有 `workflow`；非确定性轻链不得声称执行 D。
2. **同一 generic `reviewer` 无法兑现 plan review 与 code review**：reviewer.md:3,63-76 是 patch-only code reviewer；D:45 排除 code_review、D:79-84 指定 `prompts/workflow/plan-reviewer.md`。→ 拆开 plan_reviewer 与 code_reviewer，plan review 复用 PlanArtifact/ReviewArtifact + 反锚定字段/规格引用/证据密度/1-2 轮 refine/仲裁。
3. **Auto-parallel 与 delegation gates/opt-out 冲突未解决**：`system-prompt.md:162` 的 codex-default "Do not spawn…" 与 `:175-177` 无条件 "Default to parallel for complex changes" 自相矛盾，E:164 却判"无矛盾"；E:108 典型路径是单 planner→单 reviewer 串行链，违反 `:181-185` 的 scope-first/spawn-one-then-wait 禁止。→ 先修现有 prompt 矛盾；新规则限定"scope 后存在 ≥2 个独立可运行切片才默认 batch"。
4. **默认模型路由落点错误、基线过期、扩大 blast radius**：E:134 的 `@slow` 已过期（reviewer.md:6-9 已是 Sol→Opus→@task 三候选）；E:136 把 generic task 改 literal Flash 会影响所有未显式指定 agent/model 的调用，绕开既有 stage profile/fallback owner（default-config.ts:287-311 已有 Flash+Grok/Luna fallback）。→ 保留 `@task` 与现有 fallback；model policy 放入现有 workflow role/profile/router，或新增真正 stage-specific implementer/plan-reviewer agent。
5. **全局行为翻转无 A/B/独立 rollback/非重叠账本/质量成本 stop**：`task.eager: default` 只能回退 prompt 不能回退 model frontmatter；E:144-158 仅静态/单元验证。→ 至少拆 eager 默认翻转/auto-parallel 文案/pipeline guidance/stage model routing 四个独立 arm；配对 A/B；延迟按 parent+child critical-path interval union；成本按总 requests/tokens/USD；质量下降 >2pp、返工上升 >10% 及明确 cost/agent-count 阈值即停止。

Major：§2 现状表不可依赖（task 非"每会话常驻"——tools/index.ts:481-487,639-640 有受限工具集与递归深度限制；reviewer 模型过期；漏掉现有主动 `Default to parallel`；本机 config 已是 preferred）；新 planner 必要性未证明（workflow planner 已拥有 planning，designer 仅 UI/UX，generic task 足够；E 留 `thinking-level: <xhigh 对应级别>` 占位符，且"只读为主+可选 write"）；硬编码 agent 名与 spawn policy 不兼容（reviewer `spawns: scout`，其子会话只能 spawn scout；task/discovery.ts:63-67,121-137 项目/user agent 优先，同名 planner 可覆盖内置）；plan mode 冲突已知（plan-mode-active.md:2-4 严禁变更）却推迟到实现阶段；模型可用性 fallback 与 D 的 family-aware 规则未落地（D:73-75 generator=Sol 时 reviewer 改 Opus）。

Minor：评审质量要求无对应 output schema/测试（E:194-200 要求未覆盖维度/规格引用/证据密度，D:133-137 有可测指标）；`task.maxEffort` 表述掩盖 hardcoded suffix 成本语义（executor.ts:2696-2718 的 ceiling 仅在显式 `effort` 时应用，frontmatter xhigh 不受 clamp）；测试现状枚举不完整（E:37 声称只命中四文件，实际 agent-session-plan-reference-compaction.test.ts:151-154 等也含 `task.eager`）；外部研究数字（MoA 65.1% vs 57.5%、GSM8K +17.9%、Self-Refine 约 +20%）与 arXiv 摘要一致，但"1-2 轮封顶"非文献定量结论，默认选择与轮数上限应分别标 `[未验证假设]`/`[拟议验收目标]`。
Nit：风险编号顺序 R6/R8/R9/R7；`task-agents.ts` 应为 `task/agents.ts`；prompt-policy.ts:4 是声明行，判定在 `:7`。

## Reviewed Inputs manifest（sha256，单行 `路径\thash`）

```
docs/superpowers/plans/2026-08-03-latency-optimization-plan-review.md	db057745e20a46035965a52c1a68b84c466d0029bf0c4b063cdd8bc5022aa412
docs/superpowers/specs/2026-08-03-latency-defaults-gaps-design.md	1f00bb283ce580bc54eaa01c3708402a703be0c2efa71db9a62b7f5417fb9f91
docs/superpowers/specs/2026-08-03-latency-optimization-plan-design.md	f04123c429f338da8f969accb6635b47d9b3209b3416f1ffc74f315ca759c71b
docs/superpowers/specs/2026-08-04-plan-review-pipeline-design.md	6ee909d2b737213782e86f11d011f93d2467bd82703f0fb75ecca8b6511a7ef3
docs/superpowers/specs/2026-08-04-proactive-subagent-delegation-design.md	d51136243d137e327a09432c81db56cc1a10bd8c69374c2620d3d1adf0e242ba
```

证据源（评审中对照）：
```
docs/long-session-latency-analysis.md	0fd71c4dc5ad665b65118f0d80381ee5800360c31b72ca0800715218e3048089
docs/superpowers/specs/2026-08-03-long-session-performance-optimization-design.md	42f8e15a22ae2c22f62be233200b2b2dcafd373b67f348303c60e56f39c269b9
```

注：C 原 pin 的 B 旧 hash 为 `cc8fbc97e9423224ced820b2b8fb9397f39ec890587dffda2ac70990c2242bb0`（`git show f580305e:B` 可恢复），证明 C 审的是修订前 B。被评审输入可变（未冻结 git revision），后续修订轮应同时快照 repo commit。

## Next step

5/5 NEEDS_REVISION → 进入 round 2 修订。修订顺序建议：

1. **先定跨文档契约**：plan_review 形态统一为 D 的单强评审+分歧仲裁（A/B/E 同步收敛）；评审落点统一为 `prompts/workflow/plan-reviewer.md`（plan）与 `prompts/agents/reviewer.md`（code）分离。
2. **冻结配置基线**：五份文档全部改为带 `reviewed_at`/hash/explicit-vs-default-derived 的 effective-settings receipt；删除"能力不存在"表述，改为"能力已存在、effective control 未启用"。
3. **修正算术与标签**：`75.7×0.35≈26h`→`19.87h`（16s→4s 假设下）、eval avg 6.4s→23.04s、Luna/Terra≈4s→flash/grok；收益区间全部标 `[未验证假设]`，仅保留可复现恒等式。
4. **对齐 canonical owner**：不新建 `task-batch.ts`/`tool-output-processor.ts`/`performance.contextVolume.truncation.*`；并发合同映射到 `task/index.ts`+`task/parallel.ts` 或 workflow `RuntimePort`；truncation 激活现有 `modelOptimization` seam。
5. **补 A/B 与护栏**：每方向独立 arm/开关/冻结 snapshot/回滚；配对 A/B + pilot ≥30/正式 ≥100 或预注册 CI；non-overlap interval ledger 与 legacy 复算双账本；质量（2pp/10%/P0/P1 escape）与成本（requests/tokens/USD、reviewerCycles 硬上限）停止条件。
6. **同步修订上游源头**：`.omp/agents/opus5-designer.md:18`（task-batch 误列）、author prompt、B 的用户决定 A/B/C 传播到 A/C/E。

通过前不得实现（`implementation_authorization` 维持 design-only）。
