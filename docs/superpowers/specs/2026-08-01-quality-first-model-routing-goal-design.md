# Design: Quality-First Model Routing and Goal-Mode Delivery

- **Date:** 2026-08-01
- **Status:** Confirmed
- **Scope:** L
- **Design author:** GPT-5.6 Sol
- **Implementation owner:** 新会话 Goal Mode 主 Agent
- **Extends:** `docs/superpowers/specs/2026-07-30-quality-gated-multi-model-optimization-design.md`
- **Evidence:**
  - `docs/research/2026-07-25-per-model-optimization-evidence.md`
  - `docs/research/2026-07-25-per-model-optimization-user-feedback.md`
  - `docs/research/2026-07-31-gpt-5-6-luna-max-implementer-cost-effectiveness.md`
  - `progress.md`

本设计不替代 2026-07-30 的上游架构。上游文档继续定义 `ModelFactsV1 -> TaskRolePolicyV1 -> CompiledPolicyV1`、provider state、context ledger、quality gate 与渐进 rollout；本文固定当前机器的质量优先模型组合，补齐 workflow 的可配置分层路由、模型身份凭据与新会话 Goal Mode 交付边界。

## 1. 背景

### 1.1 已确认事实

1. 当前仓库已有完整 workflow 状态机：`planning -> plan_review -> implementing -> implementation_verify -> code_review -> repairing/final_verify`。`implementation_verify` 与 `final_verify` 是确定性 verifier，不应调用 LLM。
2. workflow 已有 `ModelProfile`、`ModelRouter`、availability preflight、routing audit、artifact/usage receipt、独立 code-review vendor 门禁与 bounded repair；不应另造第二套路由引擎。
3. `TaskRolePolicyV1` 已区分 `TaskClass`、`TaskRisk`、`ReasoningIntent`、tool/output/context/completion contract；新增路由必须接到这些 seam，而不是把模型名写进 engine 的 stage switch。
4. 当前用户配置 `~/.omp/agent/config.yml` 的多个 `workflow.profiles.*` 仍含已删除的 `runtime: { kind: embedded }`。`normalizeModelProfile()` 明确拒绝任意 legacy `profile.runtime`，因此现状会在 workflow 启动前以 `workflow_cli_runtime_removed` fail closed。
5. 当前 `task.agentModelOverrides` 为空，内置 `scout`、`designer`、`reviewer`、`task` 最终继承 `modelRoles.default = gateway/gpt-5.6-sol:xhigh`；本机尚未实现按原生 subagent 角色分流。
6. 当前 workflow router 只按 role、可用性与 review vendor 排序，没有“普通质量流 / 高风险质量流”的显式选择 seam。
7. 当前 plan/plan-review/code-review artifact 把 `profile.vendor` 当作 provider 记录，未像 implement/repair 一样完整回传并持久化 runtime 的 `resolvedProvider` / `resolvedModel`。因此“配置了某模型”不等于“已证明确实运行了该模型”。
8. 当前独立 review 主要比较配置声明的 `vendor`。经 gateway/aggregator 路由时，transport provider、模型 lineage、配置声明是三个不同概念；只比较可手写的字符串不足以证明认知独立。
9. 已有本机研究支持以下定位，但不支持把社区单点反馈直接当硬 SLA：
   - GPT-5.6 Sol：计划、复杂归纳、困难 repair；`medium` 适合作为常规计划起点，`xhigh` 留给阻断修复或高风险复核。
   - GPT-5.6 Luna：低价长工具循环实现者；当前证据更支持 `max`，不支持仅为省钱默认降到 `medium`。
   - DeepSeek V4 Flash 0731：低成本 read-only scout、批量上下文抽取；不进入写入、架构裁决或最终 review。
   - Claude Opus 5：最高质量设计/根因/架构 Gate；只放在高杠杆决策点。
   - Claude Fable 5：大仓库 code review、安全/对抗审查、长期实现；常规 review 用 `high`，高风险实现可用 `max`。
   - Grok 4.5：独立 vendor dissent、替代实现探索、异模型 repair；不作为唯一终局裁决者。
10. 当前 `workflow.maxBudgetUsd = 5`、`requireIndependentReview = true`、`degradedMode = false`。本设计不提高预算、不放宽独立评审。
- 这里的 `$5` 是本机用户配置的有效 hard limit；仓库 `getDefaultConfig()` 的通用默认值当前仍为 `$10`。本 goal 不修改通用默认预算，只冻结并验证本机 persisted policy 为 `$5`。

### 1.2 目标

按以下不可颠倒的顺序落地：

1. **质量与完成率**：计划、实现、review、repair 的模型职责与 effort 与已验证强项一致。
2. **独立性与可审计性**：author/reviewer 必须跨 model lineage；每次 stage 必须留下 configured、resolved、identity-match 与 effort-request receipt。
3. **成本**：高价模型只用于一次高杠杆决策或阻断复核；工具循环交给 Luna/Flash。
4. **Token**：在质量门禁之后利用缓存、结构化 handoff、有限上下文与确定性 verify 降低浪费。

### 1.3 非目标

- 不直接编辑生成文件 `packages/catalog/src/models.json`。
- 不重新设计 provider API、opaque reasoning state、context ledger 或整个 workflow 状态机。
- 不自动用一个 LLM 猜任务风险；调用方显式选择质量层级，未知或冲突时走更保守层级。
- 不把价格表、社区评分或 vendor 宣传写成永久硬编码排名。
- 不让 Flash/Luna 替代独立 code review，不让任何模型替代 tests/check/build/smoke。
- 不在本任务中 commit、push、发布、创建 GitHub issue 或发送 GitHub 评论。

## 2. 核心约束与不变量

### 2.1 质量层级

只新增两个 workflow 质量层级：

- `balanced`：默认 M 级多文件任务；质量门禁完整，成本由 Luna 工具循环摊薄。
- `critical`：L/P0、高风险、公共 API、安全、权限、数据迁移、不可逆写入或难以由 deterministic verifier 覆盖的任务。

低风险、局部、可完全确定性验证的任务不进入 workflow；使用原生 subagent 分工。若调用方无法确认 `balanced` 是否足够，必须选 `critical`，不得静默降级。

### 2.2 独立评审

- `plan_reviewer` 的模型 lineage 必须不同于 `planner`。
- `code_reviewer` 的模型 lineage 必须不同于 `implementer`。
- 比较对象是 `modelFamilyToken(modelId)` 这类 catalog 中央分类结果，不是 transport provider，也不能只信配置里的自由文本 `vendor`。
- 已知模型的配置 lineage 与中央分类不一致时，配置无效。
- 找不到跨 lineage reviewer 时 fail closed。只要本次 workflow 使用已配置的 quality route，`workflow.start(degradedMode: true)` 就是非法组合并必须拒绝；persisted policy 固定 `degradedMode: false`，resume 也不能覆盖。本设计不把 same-vendor fallback 当成功。未配置 `qualityRoutes` 的 legacy workflow 继续保持既有 degraded-mode 语义。

### 2.3 模型身份、执行证明与 effort

- 质量路由中的 profile 使用单一精确 `modelPattern`；不使用宽 family pattern 或无序数组。
- “本地选择了哪个模型”与“provider/gateway 实际执行了哪个模型”是两类证据。必须给 identity receipt 标注 provenance：`configured`、`local_resolution`、`provider_echo` 或 `gateway_attestation`；前两者不能冒充后两者。
- strict identity profile 只有在 provider response 或可信 gateway attestation 回传匹配的 model/checkpoint 时才能通过。缺少执行方证明时状态为 `unknown`，该 strict profile unavailable；不能拿 session 当前模型或 catalog lookup 自证实际执行。
- receipt 必须区分：
  - configured model pattern；
  - locally resolved model；
  - configured/requested thinking level；
  - provider/gateway-attested transport provider 与 model/checkpoint（若可得）；
  - identity evidence provenance；
  - catalog-derived model lineage；
  - exact identity match；
  - effort 是否由 catalog 声明支持。
- strict workflow attempt 禁止 structured-subagent 内部 auth/default-retry/prewalk 把请求换到另一个模型。允许的 fallback 只发生在外层 `ModelRouter`，并留下 audit。
- implement/repair 必须在隔离 worktree 中运行且 `apply: false`。engine 先验证 provider-attested identity、artifact 与 scope，再通过现有 isolation merge seam 应用 patch；mismatch/unknown 必须丢弃隔离改动，主 worktree 保持不变。
- provider 若不回传“实际使用 effort”，只能声称“已请求且 provider 接受”；不得伪造 observed effort。

### 2.4 验证与完成

- `implementation_verify`、`final_verify` 始终无 LLM。
- routing 成功、模型返回文本或 exit code 0 都不是完成证据。
- 完成必须同时满足：route receipt、artifact schema、scope、focused test、`bun check`、package build、真实 changed path smoke。
- repeated/blocking finding 只能进入 bounded repair；同一 fingerprint 重复、patch mismatch、scope violation 或 verifier 失败必须保留 unresolved state，不能被总结掉。

## 3. 目标路由

### 3.1 原生 subagent：低风险/局部任务

| 角色 | 模型 | Effort | 权限与用途 |
| --- | --- | --- | --- |
| `scout` | `gateway/deepseek-v4-flash-0731` | `max` | 只读检索与批量上下文抽取；不可写文件，不作架构裁决 |
| `designer` | `gateway/claude-opus-5` | `high` | 设计/根因/架构 Review Gate；作者应为 GPT 或其他 lineage |
| `task` | `gateway/gpt-5.6-luna` | `max` | 默认实现者、长工具循环、小中型修复 |
| `reviewer` | `gateway/claude-fable-5` | `high` | 独立 code review、安全/对抗审查；只读 |

`sonic` 当前复用具备 edit/write/bash 的通用 task 权限，不能仅靠 model override 变成只读，因此保留现状且不路由到 Flash。`librarian` 保留现状，按外部资料任务单独选择；复杂 repair 不依赖 native `task` 默认模型，升级到 workflow 的 `balanced` / `critical` 路由。

### 3.2 Workflow `balanced`：默认 M 级任务

| Stage role | Primary | Effort | 有序 fallback | 决策依据 |
| --- | --- | --- | --- | --- |
| `planner` | GPT-5.6 Sol | `medium` | Opus 5 `high` | Sol 负责需求归纳、方案起草；只在不可用时升级，不为省钱降级 |
| `plan_reviewer` | Claude Opus 5 | `high` | Fable 5 `high` | 一次高杠杆设计/根因 Gate；与 Sol 跨 lineage |
| `implementer` | GPT-5.6 Luna | `max` | Grok 4.5 `high`, Sol `medium` | 默认低价长工具循环；fallback 优先异模型实现者 |
| `code_reviewer` | Claude Fable 5 | `high` | Opus 5 `high` | 大仓库、长期一致性、安全与反例审查；与 Luna/Grok/Sol 跨 lineage |
| `repair` | GPT-5.6 Sol | `xhigh` | Grok 4.5 `high`, Luna `max` | blocking/repeated finding 用 Sol；机械单点 repair 才可落到 Luna |
| `implementation_verify` / `final_verify` | 无 LLM | N/A | 无 | tests/check/build/smoke 与 workflow hard completion gate |

### 3.3 Workflow `critical`：L/P0/高风险任务

| Stage role | Primary | Effort | 有序 fallback | 决策依据 |
| --- | --- | --- | --- | --- |
| `planner` | Claude Opus 5 | `high` | GPT-5.6 Sol `xhigh` | 根因、权限/状态/数据边界与不可逆风险主设计 |
| `plan_reviewer` | Grok 4.5 | `high` | GPT-5.6 Sol `xhigh` | 异 vendor dissent，专门挑战前提、失败模式和遗漏 |
| `implementer` | Claude Fable 5 | `max` | GPT-5.6 Sol `xhigh` | 长周期大仓库实现；fallback 仍保持 frontier reasoning |
| `code_reviewer` | GPT-5.6 Sol | `xhigh` | Opus 5 `high`, Grok 4.5 `high` | 与 Fable 跨 lineage；若 implementer fallback 到 Sol，router 必须动态跳过 Sol reviewer |
| `repair` | GPT-5.6 Sol | `xhigh` | Opus 5 `high`, Grok 4.5 `high` | 按 finding fingerprint 做 bounded repair；reviewer independence 不因 repair 改写 |
| `implementation_verify` / `final_verify` | 无 LLM | N/A | 无 | 同上 |

### 3.4 禁止的隐式降级

- Flash 不得从 scout fallback 为 planner/implementer/reviewer/repair。
- Luna 不得成为 `critical` 的独立 reviewer。
- reviewer fallback 必须先重新计算实际 implementer/planner lineage，不能只按静态表取下一项。
- exact identity mismatch、effort unsupported、availability probe 失败都必须进入明确 fallback 或阻断；不得换成“名字相近”的模型。
- 任一 fallback 都要进入 routing audit，包含跳过原因与最终选择。

## 4. 详细方案

### 4.1 配置接口

在现有 workflow settings seam 上增加：

```yaml
workflow:
  defaultQualityTier: balanced
  qualityRoutes:
    balanced:
      planner: [sol_planner_medium, opus_planner_high]
      plan_reviewer: [opus_plan_reviewer_high, fable_plan_reviewer_high]
      implementer: [luna_implementer_max, grok_implementer_high, sol_implementer_medium]
      code_reviewer: [fable_code_reviewer_high, opus_code_reviewer_high]
      repair: [sol_repair_xhigh, grok_repair_high, luna_repair_max]
    critical:
      planner: [opus_planner_high, sol_planner_xhigh]
      plan_reviewer: [grok_plan_reviewer_high, sol_plan_reviewer_xhigh]
      implementer: [fable_implementer_max, sol_implementer_xhigh]
      code_reviewer: [sol_code_reviewer_xhigh, opus_code_reviewer_high, grok_code_reviewer_high]
      repair: [sol_repair_xhigh, opus_repair_high, grok_repair_high]
```

约束：

- `qualityRoutes` 是配置数据，engine 不硬编码上述模型名。
- 每个值是有序 profile ID 列表；空列表、未知 profile、profile role 不匹配、已知 lineage 声明不匹配都在加载时失败。
- `qualityRoutes` 为空时完全保留现有 role-based router 行为，避免影响未配置用户。
- 用户配置启用上述精确 routes；仓库默认不把 2026-08-01 的供应商价格/排名固化为所有用户的永久默认。
- 删除所有 `workflow.profiles.*.runtime`。不保留 alias、compat shim 或 deprecated path。

原生 subagent 使用现有 `task.agentModelOverrides`：

```yaml
task:
  agentModelOverrides:
    scout: gateway/deepseek-v4-flash-0731:max
    designer: gateway/claude-opus-5:high
    task: gateway/gpt-5.6-luna:max
    reviewer: gateway/claude-fable-5:high
```

实际模型字符串必须通过本机 registry/catalog 解析与 live probe 后再写入；上例是目标，不是未验证的事实。

### 4.2 Workflow 工具合同

`workflow.start` 新增可选参数：

```ts
qualityTier?: "balanced" | "critical";
```

语义：

- 未传时使用 `workflow.defaultQualityTier`；默认 `balanced`。
- 高风险调用方必须显式传 `critical`。
- start 时把 tier、有序候选、规范化 profile 非秘密字段、identity policy、thinking level 与 derived lineage 编译成不可变 `QualityRouteSnapshotV1`，计算 fingerprint，并写入 persisted policy/artifact。resume 只消费该 snapshot；当前 settings 只提供凭据与运行环境，不能改变候选、模型、effort 或 lineage。
- snapshot 必须内嵌每个候选的规范化、非秘密 profile 副本，而不只是 ID；凭据、fetch、registry 等运行资源不进入 snapshot。canonical persistence 放在现有 `policyJson.qualityRouteSnapshot`，并另写可读 artifact，不为同一事实新增数据库列。resume 必须重新计算 snapshot fingerprint 并与 persisted fingerprint 比较后，使用 snapshot 构造本次 router/preflight 视图；当前 settings 中同名 profile 的模型、effort、lineage 或候选顺序不得覆盖它。
- 使用已配置 quality route 时，`degradedMode: true` 必须在 start 被拒绝；snapshot 固定 `degradedMode: false`，resume 无覆盖入口。
- `status` 和最终报告显示 tier、snapshot fingerprint、每个 stage 的 configured profile、fallback reason、local resolution 与 provider-attested identity。
- tool prompt 只解释何时选 `critical`；具体模型组合仍来自 settings。

### 4.3 Router 与 preflight

扩展现有 `ModelRouter.resolve(role, options)`，不另建 router：

1. start 根据 tier 与 settings 编译并验证 `QualityRouteSnapshotV1`；engine 根据 snapshot 中冻结的 role profile IDs 传入 `preferredProfileIds`。resume 不重新从 settings 编译。
2. router 依次过滤：不存在、role 不匹配、preflight unavailable、provider-attested exact identity mismatch/unknown、effort unsupported、excluded profile、author lineage 冲突。
3. reviewer 选择基于 catalog 中央派生 model lineage；profile 的自由文本 `vendor` 只能用于 catalog 无法分类的 opaque ID，并且 strict route 对 opaque lineage fail closed。
4. 选择结果增加 `qualityTier`、snapshot fingerprint、`candidateProfileIds`、`skipped[]`、`modelFamily` 与 identity evidence provenance，持久化到 routing-audit。
5. availability preflight 必须使用冻结 snapshot 探测本次 tier 的必需候选，并取得 provider/gateway 执行方身份凭据；仅有 local catalog resolution 不足以通过 strict identity。start/resume 共享同一规则。
6. `critical` 的 planner、plan reviewer、implementer、code reviewer 无合格候选时 fail closed；不能进入 degraded same-vendor review。

### 4.4 Runtime identity receipt 与写入提交边界

统一所有 model-backed stages：plan、plan-review、implement、code-review、repair 都从 provider response/gateway attestation 到 `RuntimePort.run()` 透传：

- locally resolved provider/model；
- provider/gateway-attested provider/model/checkpoint；
- identity evidence provenance；
- `toolCalls`；
- configured profile ID/model pattern/thinking level；
- catalog-derived model lineage；
- exact identity match。

当前 structured-subagent 的 `resolvedModel` 若只是本地 session 选择结果，必须改名/标记为 `local_resolution`，不能作为 provider 执行证明。artifact header 与 usage receipt 保留 configured、local、attested 三层；没有 attestation 时保留 `unknown`，不能用配置值或 catalog 值补齐。

profile 增加 strict identity 配置（命名由实现阶段遵循现有类型风格决定）；本机质量 routes 全部启用。strict run 关闭内层模型替换。read-only stage 在 attestation mismatch/unknown 后丢弃输出；write stage 始终先在隔离 worktree `apply: false` 运行，只有 attestation、artifact/schema 与 scope 全部通过后才由 engine 应用 patch。失败不得污染主 worktree。
- 现有 structured-subagent 内部 merge 必须拆到可复用的 engine-owned commit seam：strict write invocation 强制 `apply: false`，返回保留的 patch/branch 与身份凭据；engine 先验证 identity、artifact schema 和基于 patch 的 scope，再显式调用该 seam。不得在 merge 已发生后才做身份检查，也不得仅把 `changesApplied` 改成 `false` 掩盖已污染的主 worktree。

### 4.5 与 model-policy compiler 的连接

- `buildWorkflowTaskPolicy()` 继续由 role 决定 task class、write-role risk floor 与 tool policy。
- quality tier 只负责“哪个 profile 先尝试”，不覆盖 `TaskRolePolicyV1` 的安全、tool、output、context 或 completion contract。
- `thinkingLevel` 仍从 profile 进入 RuntimeAdapter；compiler 对 provider facts 做 effort clamp/兼容检查。若 requested effort 不受支持，严格 route 必须 fail closed，而不是静默 clamp 后仍声称使用了目标 effort。
- model identity 只选择 facts，不得暗示 provider protocol；继续由 catalog/model facts 决定 adapter/API 行为。

### 4.6 配置切换与回滚

1. 修改用户配置前创建 timestamped backup；不读取或输出 secret 值。
2. 先删除 legacy `runtime` 并通过配置加载，再新增 profile/routes；不要一次混合多个未知故障。
3. route feature 在 package 中向后兼容：未配置 `qualityRoutes` 时保持旧 router。
4. 本机先启用 `balanced`；`critical` 只由显式调用触发。
5. 若 live identity/effort/independence 任一门禁失败，恢复配置 backup 或禁用 `qualityRoutes`，代码功能保留但不声称本机路由已生效。

## 5. 文件与模块边界

预期修改面；实现前必须用 LSP/grep 重新确认引用与实际类型：

| 文件/模块 | 变更 |
| --- | --- |
| `packages/coding-agent/src/config/settings-schema.ts` | 新增 `workflow.defaultQualityTier`、`workflow.qualityRoutes`；保持 `workflow.profiles` 现有 seam |
| `packages/coding-agent/src/workflow/types.ts` | 定义 quality tier、不可变 route snapshot/fingerprint、strict identity、identity provenance 与 runtime receipt 类型；扩展 `WorkflowRequest`/audit evidence |
| `packages/coding-agent/src/workflow/default-config.ts` | 解析/验证新 settings；空 routes 保留旧行为，不硬编码本文模型矩阵 |
| `packages/coding-agent/src/workflow/model-profile-registry.ts` | exact identity、effort support、known lineage validation；继续拒绝 legacy `runtime` |
| `packages/coding-agent/src/workflow/model-router.ts` | 消费有序 profile IDs；基于 lineage 做 author/reviewer independence；输出 skipped reasons |
| `packages/coding-agent/src/workflow/availability*.ts` | tier/snapshot-aware preflight；采集 provider/gateway attestation，local-only 或 mismatch 对 strict profile unavailable |
| `packages/coding-agent/src/workflow/workflow-tool.ts` | `qualityTier` start 参数、compiled snapshot 持久化；quality route 拒绝 degraded mode |
| `packages/coding-agent/src/prompts/tools/workflow.md` | 静态说明 balanced/critical 选择语义，不内嵌模型表 |
| `packages/coding-agent/src/workflow/engine.ts` | 编译/恢复 route snapshot；每个 stage 传 frozen routes；持久化 audit/identity receipt；identity 验证后才合并 write patch；deterministic verify 不变 |
| `packages/coding-agent/src/workflow/runtime-adapter.ts`、structured-subagent seam 与 `stages/*` | 禁止 strict attempt 内层模型替换；区分 local resolution 与 provider attestation；所有 LLM stage 透传身份、tool 与 effort evidence |
| `packages/coding-agent/test/workflow/*.test.ts` | 新增路由、独立性、resume、identity、preflight 与 receipt contract 测试 |
| `docs/workflow.md` | 配置、quality tier、fail-closed 与 receipt 说明 |
| `packages/coding-agent/CHANGELOG.md` | `[Unreleased]` 记录可配置质量分层路由与可审计 identity 修复 |
| `~/.omp/agent/config.yml` | 删除 legacy runtime；写入已 live-validated profiles/routes 与原生 agent overrides |
| `progress.md` | 保留历史 checkpoint；追加本 goal 的 active/completed evidence，不覆盖旧记录 |

不新增独立 router、provider adapter 或 prompt-in-code。

## 6. 失败模式与处理

| 失败 | 处理 |
| --- | --- |
| 配置仍含 `profile.runtime` | 配置加载失败；删除字段后重试，不加兼容层 |
| 目标 model ID 不存在或 gateway 不可达 | profile unavailable；按显式有序 fallback；critical 无合格候选则阻断 |
| provider/gateway attested model 与 exact model 不符，或只有 local resolution | strict profile unavailable并记录 provenance；read output 丢弃，write patch 不得应用；不得把 session/catalog 自报值当执行方证明 |
| requested effort 不受支持 | strict route fail closed；修正 profile，不静默降 effort |
| planner/reviewer 或 implementer/reviewer 同 lineage | router 跳过；无跨 lineage 候选则 `independent_reviewer_unavailable` |
| transport provider 都显示 `gateway` | independence 使用 model lineage，不使用 transport provider |
| start 后 settings/profile/routes 被修改 | resume 使用 persisted `QualityRouteSnapshotV1` 与 fingerprint；候选、identity policy、effort、lineage 不漂移；只重新取得当前凭据/运行环境 |
| quality route 请求 `degradedMode: true` | start 拒绝非法组合；persisted policy 保持 false |
| Fable refusal/classifier 误拒绝 | 记录真实 provider error；对 benign 任务只走显式跨 lineage fallback，不伪造成功 |
| Flash tool/schema 边界异常 | Flash 限制为只读 scout；异常输出不进入 author/reviewer artifact |
| repeated finding / repair loop | 现有 fingerprint + bounded cycles；达到上限 blocked，不扩大循环 |
| deterministic verification 失败 | repair 或 blocked；LLM 不得覆盖 verifier 结论 |
| live cost接近 `maxBudgetUsd` | workflow hard stop；不提高当前 `$5` 配置绕过门禁 |

## 7. 验收标准

### 7.1 配置与静态合同

- [ ] `~/.omp/agent/config.yml` 所有 workflow profile 无 `runtime` 字段，settings 可加载。
- [ ] 原生 `scout/designer/task/reviewer` 分别解析到目标模型与 effort；不再全部继承 Sol xhigh；`sonic` 不被误标只读或路由到 Flash。
- [ ] `workflow.start` 接受 `balanced|critical`，非法 tier fail closed；quality route 拒绝 degraded mode；resume 使用创建时冻结的 route/profile snapshot 与 fingerprint。
- [ ] `qualityRoutes` 按有序 profile ID 选择；未知 ID、role mismatch、空关键角色、known lineage mismatch 均有确定错误。
- [ ] 未配置 `qualityRoutes` 的既有用户行为不变。
- [ ] planner/plan-reviewer 与 implementer/code-reviewer 的 independence 基于 model lineage；transport provider 同为 gateway 不造成误判。
- [ ] strict identity 只接受 provider/gateway attestation；local resolution 缺失 attestation、identity mismatch 与 unsupported effort 都不会被静默接受。
- [ ] 所有 model-backed stage 的 usage/routing artifacts 都区分 configured、local resolution、provider/gateway-attested identity 与 provenance；未知值保留 unknown/null。
- [ ] strict implement/repair mismatch 或无 attestation 时，隔离 patch 不会应用到主 worktree。
- [ ] deterministic verify stages 没有模型调用。

### 7.2 Focused verification

至少覆盖以下 observable contracts：

1. `model-profile-registry.test.ts`：legacy runtime rejection、exact identity/effort/lineage config validation。
2. `model-router.test.ts`：balanced/critical order、fallback skip reason、实际 lineage independence、implementer fallback 后 reviewer 重算。
3. `workflow-tool` tests：tier schema、quality-route degraded-mode rejection、compiled snapshot persist、settings mutation 后 resume stability。
4. availability tests：按冻结 tier snapshot preflight；local-only、attestation missing 与 identity mismatch fail closed。
5. runtime/stage tests：plan/review/implement/repair 全部区分 configured/local/attested identity；不以 session/catalog 值冒充 provider 证明；strict attempt 禁用内层模型替换。
6. engine tests：routing-audit/usage artifact 可恢复，verify 无 LLM，same-lineage critical route blocked；write-stage identity failure 后主 worktree hash/patch 保持不变。

随后运行：

- focused workflow tests；
- `bun check`；
- `bun --cwd packages/coding-agent run build`；
- 直接运行 changed path 的 source-level smoke，而不是只运行测试文件。

### 7.3 Live evidence

在不输出 secret、且不提高当前 workflow `$5` hard limit 的前提下：

1. 对目标 exact tuples 做最小 live probe：
   - Sol `medium` 与 `xhigh`
   - Luna `max`
   - Flash 0731 `max`
   - Opus 5 `high`
   - Fable 5 `high` 与 `max`
   - Grok 4.5 `high`
2. 每个 probe 记录：requested pattern/effort、local resolution、provider/gateway-attested provider/model/checkpoint 与 provenance、TTFT/总延迟（可观测时）、成功/错误分类；不记录凭据值。只有 local resolution 的 strict tuple 记为 unavailable，不记为通过。
3. 运行一个固定、安全、临时 fixture 的 `balanced` 完整 E2E，确认每个 stage 的 profile/lineage/receipt、deterministic verification 与 terminal completion。
4. 运行一个固定、安全、临时 fixture 的 `critical` 完整 E2E，确认 Opus -> Grok -> Fable -> Sol 主路径，或明确审计到允许的 fallback；author/reviewer 均跨 lineage。
5. 两个 E2E 都必须读取最终 report/artifacts 逐 stage 验证，不能只看 exit code。
6. Live 只证明路由与端到端可用，不声称统计质量提升。质量/成本推广仍按上游文档的 baseline、shadow、5%/25% canary 与 rollback 规则执行。

## 8. 实施顺序

### Phase 0 — 恢复可运行基线

1. 读取当前 dirty worktree、配置 schema、profile registry、router、engine、runtime adapter 与相关 tests；保留他人改动。
2. 备份用户配置；只删除 workflow legacy `runtime`。
3. 运行配置加载/最小 workflow preflight，确认不再触发 `workflow_cli_runtime_removed`。
4. 以 Claude Opus 5 `high` 对本文做独立 Design Review Gate；GPT 作者与 Claude reviewer 跨 lineage。`REVISE` 则更新本文并重审，`PASS/PASS_WITH_NOTES` 才进入 package 实现。
   Gate 评审对象是本文合同的充分性、可实现性与安全性。Phase 1/2 明列且有 owner、失败语义和 observable acceptance 的“当前实现尚缺该能力”是实施基线，不单独构成设计 `REVISE`；若合同遗漏 canonical seam、无法取得所需证据、fallback 分支不闭合或写入边界不可安全实现，则必须 `REVISE`。

### Phase 1 — 路由与身份合同

1. 在现有 types/settings/default-config seam 增加 quality tier 与有序 routes。
2. 扩展 profile normalization：exact identity、effort support、known lineage validation；定义 identity evidence provenance。
3. start 编译 immutable route snapshot/fingerprint；扩展 router/preflight：冻结 candidates、skip reasons、provider-attested identity、actual lineage independence；quality route 拒绝 degraded mode。
4. 在 workflow tool/persisted state 接入 `qualityTier` 与 snapshot，确保 settings 在 start/resume 之间变化也不导致 route 漂移。
5. 用 focused contract tests 固定新 observable behavior。

### Phase 2 — 全 stage 凭据闭环

1. 让 plan、plan-review、code-review 与 implement/repair 一样透传 configured/local/provider-attested identity、provenance 与 tool evidence。
2. strict attempt 禁用内层模型替换；implement/repair 在隔离 worktree `apply: false`，attestation/artifact/scope 通过后才合并。
3. usage/routing artifacts 完整记录三层 identity；mismatch/unknown/unsupported effort fail closed；验证 identity failure 不污染主 worktree，deterministic stages 无模型调用。

### Phase 3 — 本机模型矩阵

1. live probe exact model strings 与 effort；只把通过的 tuple 写入配置。
2. 配置 balanced/critical profiles、qualityRoutes 与 native agent overrides；Flash 只覆盖 `scout`，不覆盖具备写权限的 `sonic`。
3. 验证 native subagent model resolution、workflow preflight 与跨 lineage review。
4. 任一目标 tuple 不可用时，使用本文明确允许且通过 live probe 的 fallback；不自行发明新模型组合。

### Phase 4 — 工程与 live 验收

1. focused tests -> `bun check` -> coding-agent build -> source smoke。
2. 运行 balanced 与 critical 各一个完整 live fixture；读取每个 stage artifact。
3. 用 Claude Fable 5 对实现 patch 做独立 code review；修复全部 blocking finding 后重新验证。
4. 最后更新 `docs/workflow.md`、`packages/coding-agent/CHANGELOG.md` 与 `progress.md`；文档不得领先于已验证行为。

## 9. Rollout 与质量成本门禁

- package 功能默认兼容旧 router；新 quality routes 由配置 opt-in。
- 本机先用 `balanced` 作为 workflow 默认；`critical` 只显式触发。
- 任何“更便宜”组合要进入默认前，必须与固定 baseline 同任务、同 harness、同 judge 比较。
- 硬门禁：任务通过率不得低于 baseline；质量评分不得低于 baseline 超过 0.3/10；scope、security、verification、unresolved-state 任一 hard failure 立即 rollback。
- 成本按总 workflow 计算：模型 token + 重试 + repair + reviewer + 人工返工；不以单次 token 单价替代总成本。
- 未完成 judge calibration 或样本不足时，只能报告 route correctness、latency 与观察到的 cost，不声称质量优势。

## 10. 关键决策

### 决策 1：高价模型放 Gate，不铺满工具循环

Opus 5 在 balanced 只做一次 plan review；Fable 5 只做独立 code review。Luna 承担默认实现工具循环。这样保留最高质量模型的高杠杆判断，同时避免把昂贵输出单价乘到每次 read/edit/test 循环。

### 决策 2：critical 使用 Opus 设计、Grok dissent、Fable 实现、Sol review

四个阶段分别使用 Anthropic、xAI、Anthropic、OpenAI lineage；关键 author/reviewer 对均跨 lineage。Grok 的职责是挑战高风险方案，不是替代终局 deterministic verifier。

### 决策 3：Flash 只读

Flash 的价格优势适合大量扫描，但现有对抗性测试暴露 JSON Patch、并发 map 与边界输入风险。只路由到工具权限本来就是只读的 `scout`，才能把错误隔离在不会写入仓库的阶段；仅改模型不能把 `sonic` 的通用 task 工具面变成只读。

### 决策 4：配置化模型表，engine 只理解质量层级

模型价格、可用性与版本会变化。engine 只消费 `balanced|critical` 与 role-profile order；具体模型在用户配置中，经过 live probe 后可替换，不污染状态机。

### 决策 5：配置值不是运行事实

所有质量与独立性声明以 runtime resolved identity + catalog lineage + receipt 为准。无法观测的 effort 保留为“requested/accepted”，不升级成“实际执行”。

## 11. 风险与未知

- **需 live 验证：** `deepseek-v4-flash-0731` 是否是 OpenCode Zen 0731 checkpoint，当前 OpenCode 目录未公开后缀；不得用名称相似推断。
- **需 live 验证：** gateway 是否对全部模型返回稳定、可解析的 resolved model ID；若不返回，strict identity 路由必须决定可接受的 provider-specific evidence，不得默认为匹配。
- **需实现确认：** exact model matching 应复用现有 model resolver/catalog identity helper，不能新增字符串 contains 规则。
- **需 benchmark：** Luna max 相对 Sol medium、Fable/Opus review 的真实任务完成率与总成本；当前研究只支持候选路线，不支持统计结论。
- **供应商行为风险：** Fable safety classifier、Grok endpoint alias、Flash preview checkpoint 都可能漂移；每次升级模型目录后重新跑 conformance probe。

## 12. 新会话 Goal Mode Handoff

### 12.1 启动条件

新会话主模型应选择 `gateway/claude-opus-5:high`，用于对 GPT 作者的设计做跨 lineage Gate，并保留主 Agent 的根因判断、终审和验收。若实际模型不是 Claude Opus 5，先切换模型或明确记录 Design Review Gate 未满足；不得把同 lineage 自审标为独立 PASS。

### 12.2 可直接粘贴的新会话 Prompt

```text
你是 /Users/sheng/tencent/oh-my-pi 的新会话主 Agent。立即进入 Goal Mode，完整实现并验证 docs/superpowers/specs/2026-08-01-quality-first-model-routing-goal-design.md；不得停在计划、局部单测、配置草稿或“建议下一步”。

第一步：完整读取该设计、它扩展的 docs/superpowers/specs/2026-07-30-quality-gated-multi-model-optimization-design.md、三份 Evidence 文档、progress.md，以及当前 workflow/profile/router/runtime/settings/tests。核对当前模型确为 gateway/claude-opus-5:high。然后调用 goal({op:"create", objective:"实现质量优先 balanced/critical workflow 路由：恢复本机 workflow 配置可加载；实现可配置有序 role routes、exact identity/effort/lineage 门禁、tier-aware preflight、全 LLM stage runtime receipts 与 resume 稳定性；配置并 live 验证 Sol medium/xhigh、Luna max、Flash 0731 max、Opus high、Fable high/max、Grok high 及 native agent overrides；保持跨 lineage plan/code review、deterministic verify、$5 hard budget与旧配置兼容；通过 focused tests、bun check、coding-agent build、source smoke、balanced/critical 各一条完整 live E2E、独立 Fable code review；最后更新 workflow 文档、coding-agent Unreleased changelog、progress.md，且不 commit/push/发布/发送 GitHub 内容。"})。

执行顺序严格遵循设计 Phase 0-4。Phase 0 先备份 ~/.omp/agent/config.yml，只删除 legacy workflow profile runtime 字段并验证配置加载；不输出任何 secret。随后以当前 Claude Opus 5 对设计做独立 Review Gate：作者是 GPT-5.6 Sol。若 verdict=REVISE，先更新设计并重审；PASS/PASS_WITH_NOTES 后才实施 package 行为。

实现约束：
- 激活并遵守 engineering-flow；涉及路由 seam/接口边界时读取 codebase-design；诊断 hard failure 时读取 diagnosing-bugs；不要用 shell/模型 CLI 启动模型。
- 保留 dirty worktree 和他人改动；不要 reset/checkout/clean，不 commit/push。
- 复用 ModelProfile、ModelRouter、availability preflight、RuntimeAdapter、TaskRolePolicyV1、catalog modelFamilyToken 与现有 artifact/receipt；不另造 router，不硬编码模型表进 engine，不构造 prompt 字符串。
- 修改 exported symbol 前用 LSP references；外部 API 类型从 node_modules/现有源码确认；无 any、ReturnType、inline import。
- qualityRoutes 为空必须保持旧行为；本机目标 profiles 全部 strict identity；same-lineage reviewer、provider attestation 缺失/identity mismatch、unsupported effort 与无 critical 候选均 fail closed。
- start 必须持久化 immutable route/profile snapshot 与 fingerprint，resume 不重新消费已变化的 routes/profile；quality route 拒绝 degradedMode:true。
- 每个 model-backed stage 都区分 configured、local resolution 与 provider/gateway-attested identity/provenance；不可观测 effort 只能标 requested/accepted，不能伪造 observed。
- strict attempt 禁止内层模型替换；implement/repair 使用隔离 `apply:false`，identity/artifact/scope 验证后才合并，失败不得改动主 worktree。
- Flash 永远只路由到本来只读的 scout；verification 永远无 LLM；不提高 workflow.maxBudgetUsd=5。
- 先让 changed path 真正工作并 smoke，再做 docs/changelog/progress cleanup。

验证要求：
1. focused workflow tests 覆盖 tier order/fallback、lineage independence、quality-route degraded-mode rejection、immutable snapshot/resume、provider attestation provenance、local-only/mismatch fail closed、effort support、全 stage receipt、write mismatch 不污染主 worktree、verify 无 LLM；
2. bun check；
3. bun --cwd packages/coding-agent run build；
4. source-level changed-path smoke；
5. 对设计列出的 exact tuples 做最小 live probe，分别记录 requested、local resolution、provider/gateway-attested identity/provenance、effort request、TTFT/总延迟和错误分类，不记录凭据值；
6. balanced 与 critical 各跑一个安全临时 fixture 的完整 workflow，逐 stage 读取 route/usage/artifact，不只看 exit code；
7. 使用 Claude Fable 5 对实现 patch 做跨 lineage code review，修复全部 blocking finding 后重跑相关门禁。

只有全部验收项有当前证据时才 goal({op:"complete"})。普通 provider/config/test 失败继续诊断；只有缺少权限/凭据且安全替代已穷尽，或必须执行删除、部署、生产写、提权、提高预算等高风险动作时才阻塞并说明精确证据。

最终回传格式：
- 结论与 Goal 状态
- Design Review Gate
- 根因与关键决策
- 改动文件（repo 与用户配置分开）
- focused tests / check / build / smoke
- exact-model live probes（requested 与 resolved 分开）
- balanced E2E 逐 stage route/lineage/结果
- critical E2E 逐 stage route/lineage/结果
- Fable code review 与修复
- 成本/延迟证据及不能声称的未知
- 剩余风险或精确阻塞
```

### 12.3 Review Gate 验收

新会话的 Design Review 必须回答：

1. `qualityRoutes` 是否真正接入现有 router/compiler seam，而不是形成平行架构。
2. exact identity 与 lineage 证据是否可由当前 runtime/catalog 提供；未知是否 fail closed。
3. balanced/critical 的 author/reviewer 是否在所有 fallback 分支仍跨 lineage。
4. 全 stage receipt 是否足以证明配置与实际执行没有漂移。
5. live E2E、预算、秘密与 dirty worktree 边界是否安全。
6. 是否存在遗漏的 exported callsite、resume/preflight 路径或 transcript/rebuild 路径。
7. provider-attested identity 是否与 local resolution 明确分层，strict route 缺失 attestation 是否 fail closed。
8. write stage 是否在 identity 验证前保持隔离且不应用 patch；identity failure 是否可证明主 worktree 未变化。
9. compiled route/profile snapshot 是否冻结，settings 在 start/resume 间变化是否不会漂移。
10. quality route 是否彻底拒绝 degraded mode；Flash 是否只进入本来只读的 agent。

`PASS_WITH_NOTES` 可继续并吸收非阻断项；`REVISE` 必须修订本文并再次独立 review；不得以时间、成本或上下文压力替代 Gate。

## 13. 修订记录

- 2026-08-01：根据首次 Claude Opus 5 `high` Gate 的 `REVISE` 澄清三点：`$5` 是本机有效配置而非仓库通用 `$10` 默认；route snapshot 在现有 `policyJson` 中冻结完整非秘密 profile 并在 resume 校验 fingerprint；strict write 必须把现有 isolation merge 拆成 engine 验证后的显式 commit seam。另明确 Gate 评审设计合同，不把本文已列出的预实现 gap 重复当成设计遗漏。
- 2026-08-01：吸收补充 reviewer 的五个阻断发现：执行身份必须来自 provider/gateway attestation 而非 local session/catalog 自证；strict write stage 在身份验证前保持隔离且不应用 patch；quality route 拒绝 degraded mode；start 持久化不可变 route/profile snapshot 防止 resume 配置漂移；移除具备写权限的 `sonic` -> Flash 路由。正式跨 lineage Design Review Gate 仍由新会话 Claude Opus 5 执行。
