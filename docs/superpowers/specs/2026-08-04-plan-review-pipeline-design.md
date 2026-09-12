# Design: 方案评审管线（单强评审 + 同评审复审 + 分歧仲裁）

- Date: 2026-08-04
- Status: 最终评审闭合（round 2 + reviewer direct fixes）
- Scope: M（workflow `plan_review` 门禁合同；不新增第二套评审引擎）
- design_author: 当前会话（用户确认方案 A）
- revision_round: 2
- reviewer_fix_round: final
- reviewed_at: 2026-08-04
- effective_config_source: `/Users/sheng/.omp/agent/config.yml:571-644`
- effective_config_sha256: `1eb09e44cb35d1a2ad0dda2162c0e711d044e039e9e4c18fba9b070c756bd5f1`
- 用户决策: 范围=仅方案评审；优先级=质量优先；形态=单强评审 + 同评审复审 + 分歧仲裁
- 关联文档:
  - `docs/superpowers/specs/2026-08-03-latency-defaults-gaps-design.md` §8
  - `docs/superpowers/specs/2026-08-04-proactive-subagent-delegation-design.md` §10
  - `docs/superpowers/plans/2026-08-04-latency-delegation-docs-collective-subagent-review.md`

## 1. 背景、证据与范围

### 1.1 评审偏置只作为待验证问题

[历史事实] 可见的 Flash/Sol 三轮评审与 Opus/Sol 评审均为 `NEEDS_REVISION`（`docs/superpowers/plans/2026-08-03-long-session-performance-optimization-subagent-review.md:18-23`、`docs/superpowers/plans/2026-08-03-long-session-performance-optimization-subagent-review-round-2.md:31-35`、`docs/superpowers/plans/2026-08-03-long-session-performance-optimization-subagent-review-round-3.md:31-35`、`docs/superpowers/plans/2026-08-03-latency-optimization-plan-review.md:4-9`）。

[未验证假设] 存在“弱草稿比强草稿更早 PASS”的现象；攻击面大小、作者遵从度与模型家族偏置均只是候选解释，当前没有可复现的逐稿轮次账本或完整文献标识，不能当作实现事实。

[推导] 因此 PASS 只能证明当前 artifact 满足已声明门禁，不能证明方案全局最优。管线必须用规格覆盖、反锚定字段、独立 identity receipt 与必要时的仲裁约束 PASS，而不是依赖“没有找到足够的错”。

### 1.2 当前 effective 基线

[历史事实] `reviewed_at=2026-08-04` 的本机配置在 `/Users/sheng/.omp/agent/config.yml:571-597` 明确给出：

```yaml
workflow.qualityRoutes.balanced.planner:
  - sol_planner_medium
  - opus_planner_high
workflow.qualityRoutes.balanced.plan_reviewer:
  - opus_plan_reviewer_high
  - fable_plan_reviewer_high
workflow.qualityRoutes.critical.plan_reviewer:
  - grok_plan_reviewer_high
  - sol_plan_reviewer_xhigh
```

[历史事实] `fable_plan_reviewer_high` 实际解析为 `gateway/claude-fable-5:high`（config `:123-150`）。仓库 canonical `modelFamilyToken` 按供应商 lineage 折叠全部 Claude 变体为 `anthropic`（`packages/catalog/src/identity/family.ts:242-261`）；所以 Fable 与 Opus 作者同族，不能充当第三独立家族。

[历史事实] 同一配置的 `:609-644` 还显式包含 `async.enabled=true`、`task.eager=preferred`、`task.batch=true`、`task.agentModelOverrides`、`compaction.thresholdPercent=70`、`compaction.idleEnabled=true`。`idleThresholdTokens=200000`、`defaultThinkingLevel=high`、`modelOptimization.enabled=false` 为 schema default-derived 值，不与显式配置混写。

### 1.3 范围与 canonical owner

**唯一 policy/runtime owner 是现有 `WorkflowEngine`。** 本设计只扩展它已有的 workflow state、artifact、route snapshot、BudgetLedger、RuntimePort、ArtifactStore、SQLite store 与 workflow tool；不创建平行 plan-review engine。

范围内：

- `WorkflowEngine` 的 `plan_review` stage 与内部 substate；
- workflow 专用 prompt `packages/coding-agent/src/prompts/workflow/plan-reviewer.md`；
- `PlanReviewArtifactV2`、quality-route snapshot、identity/clean-context/spec-evidence receipt；
- 分歧检测、仲裁、人工 fail-closed、resume/cancel、预算与 transition；
- 五个独立 A/B feature arm。

范围外：

- code review；其落点保持 `packages/coding-agent/src/prompts/agents/reviewer.md`，输出 `overall_correctness: correct|incorrect`，不复用 plan-review prompt；
- E 文档的轻量 task 委派。E 只处理已 scope 的独立切片与只读 scout/critique；需要完整 plan review 时必须调用 WorkflowEngine，不存在 task-agent plan-review adapter；
- autoplan。当前仅见 disabled skill owner，且形态是多评审顺序链；在 active owner 与 versioned adapter 出现前不纳入；
- N-reviewer any-block 并行投票。并行仅可用于确定性检查或独立证据收集，不改变单 reviewer 门禁。

## 2. 目标架构与不变量

```text
planning: Opus xhigh（treatment route）
  → plan_review / initial_review: Sol xhigh，单 reviewer
      → approved: implementing，除非 contradiction/suspicious_pass 触发仲裁
      → changes_requested #1: planning → 同一 reviewer 精确复审
      → blocked/missing_authority: awaiting_human
  → plan_review / rereview
      → approved: implementing，除非 contradiction/suspicious_pass 触发仲裁
      → changes_requested #2: 达 maxPlanCycles=2；max_cycles_author_reject 触发则 arbitration，否则 blocked
  → plan_review / arbitration: 真正第三 lineage（xai/Grok）或盲化人工
      → approved: implementing
      → blocked: workflow blocked
```

关键不变量：

1. `WorkflowEngine` 决定 stage/substate 与 transition；模型只产出严格 artifact。
2. 初评只有一个 reviewer；复审必须使用初评时冻结的同一 profile 与同一 runtime identity，不重新解析 route。
3. `workflow.maxPlanCycles=2` 统计 `changes_requested` 决策次数：第一次允许一次 replan；第二次不再 replan，而是仲裁或 block。它不表示允许两次完整 replan。
4. 新实验 cohort 的 control/treatment 使用同一严格 `PlanReviewArtifactV2` measurement envelope；已持久化 legacy workflow 继续按 V1 resume。不得用 V1 control 对比 V2 treatment。
5. 最终 rollout 中，PASS 的 applicable mandatory requirements 覆盖率必须为 100%；缺一项即 gate failure，不能用 90%/80% 掩盖。
6. 每个 finding 必须有五类 basis 之一；任一 `missing_authority` 立即进入 `blocked/awaiting_human`，不由模型或仲裁者猜测。
7. reviewer/arbitrator 的 runtime identity、route snapshot、clean-context receipt 或 spec-evidence receipt 任一缺失均 fail closed。
8. Fable 与 Opus 都是 `anthropic` lineage。Fable 只能作为显式 degraded 同族 fallback，不能标为第三家族。

## 3. Quality route snapshot 与 lineage policy

### 3.1 Treatment tier 与 profile 顺序

选择 `balanced` 作为实验 tier，因为它是当前 default control；实验不通过切换到 `critical` 偷换对照。拟议 treatment 顺序：

| 角色 | Profile | 模型 / effort | 当前状态 | Treatment 顺序与语义 |
|---|---|---|---|---|
| planner | `opus_planner_xhigh` | `gateway/claude-opus-5:xhigh` | 新 profile | `balanced.planner[0]`；强草稿假设需 A/B 验证 |
| planner fallback | `sol_planner_xhigh` | `gateway/gpt-5.6-sol:xhigh` | 已存在 | `balanced.planner[1]`；若选中，reviewer 必须避开 openai lineage |
| plan reviewer | `sol_plan_reviewer_xhigh` | `gateway/gpt-5.6-sol:xhigh` | 已存在于 critical | `balanced.plan_reviewer[0]` |
| reviewer degraded fallback | `opus_plan_reviewer_high` | `gateway/claude-opus-5:high` | 已存在 | `balanced.plan_reviewer[1]`；只有显式同族 fallback policy 才可选 |
| plan arbitrator | `grok_plan_arbitrator_high` | `gateway/grok-4.5:high` | 新 role-specific profile | `balanced.plan_arbitrator[0]`；xai lineage，须同时异于作者与 reviewer |
| arbitrator degraded fallback | `fable_plan_arbitrator_high` | `gateway/claude-fable-5:high` | 新 role-specific profile | `balanced.plan_arbitrator[1]`；anthropic，同 Opus 作者时标 degraded |
| human fallback | 盲化人工 | 无模型 | 新 workflow authority receipt | 无 eligible machine 或 receipt 不完整时 fail closed 等待人工 |

### 3.2 `QualityRouteSnapshotV2`

当前 `QualityRouteSnapshotV1` 固定五个 role 且 `degradedMode:false`（`workflow/types.ts:279-285`、`quality-route-snapshot.ts:13-29`），不能表达 `plan_arbitrator` 或 plan-review 专属同族 fallback。实现必须新增 V2，而不是修改已持久化 V1 的含义：

```text
QualityRouteSnapshotV2:
  schemaVersion: 2
  qualityTier: balanced | critical
  routes:
    planner: ordered profile ids
    plan_reviewer: ordered profile ids
    plan_arbitrator: ordered profile ids | null
    implementer / code_reviewer / repair: ordered profile ids
  profiles: frozen full profile definitions + configured identities
  planReviewPolicy: frozen five-arm settings + lineage settings
  lineagePolicy:
    reviewerAvoidsAuthor: true
    arbitratorAvoids: [author, reviewer]
    allowSameFamilyCleanContextFallback: false by default
  promptHashes:
    planReviewer
    planArbitrator
  fingerprint: sha256(stable serialized payload)
```

V2 规则：

- workflow start 原子编译并持久化 snapshot；resume 只读、校验 fingerprint，不读取新 settings 覆盖旧 snapshot；
- 为兼容现有配置，`plan_arbitrator` 在 `arbitrationEnabled=false` 时允许为 null；开启仲裁的 tier 必须配置非空 route。Balanced/critical 如启用仲裁，都必须显式给出 route，不能从另一 tier 偷取；
- generic `degradedMode` 继续禁止。只有 snapshot 内 plan-review 专属的 `allowSameFamilyCleanContextFallback` 可放宽 lineage，且默认 false；
- `ModelRouter` 增加 `avoidModelFamilies: string[]`，使 arbitrator 同时避开 author 与 reviewer lineage；
- runtime selection receipt 必须记录候选顺序、skip reason、selected profile、configured identity、local resolution、provider/gateway attestation、`exactMatch` 与 snapshot fingerprint；
- 初评成功后持久化 `PlanReviewRouteSelectionV1`。复审精确复用其 profile 与 attested identity；若不可用或 identity 漂移，不静默换候选，进入 `awaiting_human`；
- 初评阶段若 Sol 不可用：默认 fail closed 转人工；只有本次 workflow snapshot 显式允许时，才可选 Opus clean-context fallback，并标 `degraded=true`；
- 仲裁阶段若 Grok 不可用：默认 fail closed 转盲化人工；只有显式允许时才可选 Fable clean-context fallback，并标 `degraded=true`。Fable 不得被记录为第三 lineage。

### 3.3 Clean-context 与盲化

同族 fallback 仍需新 runtime session，且输入只能来自声明的 artifact refs：plan、requirements snapshot、当前 review、author responses。Receipt：

```text
CleanContextReceiptV1:
  workflowId
  executionId
  runtimeSessionId
  declaredInputArtifactIds[]
  inputContextLedgerSha256
  priorConversationIncluded: false
  routeSnapshotFingerprint
  createdAt

HumanPlanReviewReceiptV1:
  schemaVersion: 1
  workflowId
  planArtifactSha256
  requirementsSnapshotSha256
  decision: approved | blocked
  rationale: non-empty
  evidenceRefs[]
  authorityIdentity
  authorityProvenance
  blindedToTreatment: true
  createdAt
  signatureRef
```

人工仲裁对 control/treatment 标签、route arm、作者模型与 reviewer 模型盲化；只看到冻结稿件、权威需求、findings、author responses 与必要 repo evidence。人工 receipt 的 plan/requirements hash 必须与等待中的 workflow state 一致。

## 4. `PlanReviewArtifactV2` 严格合同

### 4.1 为什么不能“给 V1 加可选字段”

当前 `ArtifactHeader.schemaVersion` 是 literal `1`，`ReviewArtifactV1` 是单 reviewer 结构（`workflow/types.ts:26-39,130-169`）；Zod 与 JSON schema 均 strict / `additionalProperties:false`（`workflow/schemas.ts:70-118`、`workflow/json-schemas.ts:133-158`）。因此新 cohort 必须使用独立、版本化、严格的 V2 union；不能把字段全部设为 optional 后声称 Blocking 已闭合。

### 4.2 类型与字段

```text
FindingBasis =
  spec_requirement |
  user_requirement |
  repo_evidence |
  safety_invariant |
  missing_authority

RequirementCoverageV1:
  requirementId: stable id
  source: spec_requirement | user_requirement
  mandatory: boolean
  status: satisfied | violated | not_applicable | missing_authority
  evidenceRefs: non-empty artifact/path/line references, except missing_authority
  rationale: non-empty

PlanReviewFindingV2 extends ReviewFindingV1:
  basis: FindingBasis
  requirementId: string | null
  sourceRefs: string[]
  missingAuthority: string | null

AuthorResponseV1:
  findingId
  disposition: accepted | rejected | clarified
  explanation
  evidenceRefs[]

PlanReviewArtifactV2:
  schemaVersion: 2
  workflowId
  attemptId
  stage: plan_review
  createdAt
  modelProfileId: string | null
  provider: string | null
  model: string | null
  promptVersion: string
  kind: review
  subject: plan
  reviewKind: initial | rereview | arbitration | human
  decision: approved | changes_requested | blocked
  findings: PlanReviewFindingV2[]
  explanation: non-empty
  confidence: 0..1
  requirementsSnapshotRef
  requirementsSnapshotSha256
  coverage: RequirementCoverageV1[]
  uncoveredDimensions: string[]
  antiAnchoringRationale: non-empty
  reviewRound: 1 | 2
  authorResponses: AuthorResponseV1[]
  triggerReason: contradiction | suspicious_pass | max_cycles_author_reject | null
  routeSelectionReceiptRef: string | null
  cleanContextReceiptRef
  specEvidenceReceiptRef
  authorityReceiptRef: string | null
```

`PlanReviewArtifactSchema` 是 `ReviewArtifactV1 | PlanReviewArtifactV2` 的 discriminated union。已持久化 legacy workflows 可继续解析 V1；新实验 cohort 的 control/treatment 都必须输出 V2，并使用同一 schema/prompt-output envelope，禁止 V1/V2 跨版本配对。Code review 始终使用 V1。Human artifact 的 model/profile/route selection 字段为 null，`authorityReceiptRef` 必须非空；模型 artifact 的 authority ref 为 null。Human 路径的 blinding、clean-context 与 spec-evidence receipts 仍为 mandatory。

### 4.3 决策不变量

- 最终 rollout 的 `approved`：所有 applicable mandatory requirements 都出现在 `coverage`，覆盖率 100%；状态只能是 `satisfied|not_applicable`，且每项有 evidence/rationale；没有 open blocking finding；没有 `missing_authority`。
- `changes_requested`：至少一个 actionable finding；每个 finding 都有 basis/source refs；只允许 initial/rereview 使用。
- `blocked`：严重违反、缺权威来源或无法完成可信 receipt。任一 `missing_authority` 必须是 `blocked`，由 engine 映射到 `awaiting_human`。
- 每个 finding 的 basis 必须是五类之一。`spec_requirement|user_requirement` 必须关联 requirement ID；`repo_evidence|safety_invariant` 必须有 source refs；`missing_authority` 必须说明缺失的 authority，且不得由模型补造。
- `uncoveredDimensions` 字段必须存在。没有发现遗漏维度时允许空数组，但 `antiAnchoringRationale` 必须说明检查过的维度；不得以“必须非空”激励伪造 finding。
- arbitration/human artifact 的 decision 只能是 `approved|blocked`；`changes_requested` schema 校验失败。

## 5. Prompt 规则与 finding basis

唯一 plan-review prompt 落点是 `packages/coding-agent/src/prompts/workflow/plan-reviewer.md`。五项 mandatory：

1. **反锚定**：先列草稿未覆盖的约束、风险与备选方向；即使无遗漏也写检查范围与理由。
2. **权威 basis**：每个 finding 标注 `spec_requirement | user_requirement | repo_evidence | safety_invariant | missing_authority`；不得把 repo/safety finding 因为不在原草稿规格里而丢弃。
3. **PASS gate**：逐条核对 100% applicable mandatory requirements；PASS 不是“没找到错”。
4. **收敛**：最多接受两次 `changes_requested`；第二次进入仲裁判定或 block，不继续 replan。
5. **客观检查分离**：lint/test/spec check 由确定性 verifier 提供，LLM 只判断开放维度，不伪造命令结果。

`missing_authority` 是 authority 缺口，不是低置信度 finding：任一出现即 `blocked → awaiting_human`。不存在“多数 missing_authority 才转人工”的阈值。

## 6. 仲裁触发与确定性判定

WorkflowEngine 只根据结构化字段触发仲裁：

1. **`contradiction`**：同一 `requirementId` 同时被标为 satisfied 与 violated，或 open blocking finding 与 coverage 的 satisfied 状态冲突；按稳定 requirement/finding fingerprint 判断，不用自然语言长度猜测。
2. **`suspicious_pass`**：artifact 通过 100% mandatory hard gate，但预注册的非强制维度 coverage 或 evidence-density 低于 treatment 阈值，或反锚定 rationale 为空泛；只有 `suspiciousPassEscalation` arm 开启时触发，否则只记录诊断。
3. **`max_cycles_author_reject`**：第二次 `changes_requested`，且 author response 对 P0/P1 finding 为 `rejected`，并提供了可供仲裁的 evidence refs。

Mandatory coverage、basis、schema 或 receipt 缺失不是“可疑 PASS”，而是 artifact/gate failure，直接 fail closed；仲裁不能把无效 artifact 洗成 approved。

仲裁输入为冻结 plan + requirements snapshot + latest review + author responses + 必要 repo evidence。它使用新 session，但“clean context”不表示隐藏显式输入的 review/response artifact；receipt 必须精确列出输入。

## 7. 持久化 substate、resume、cancel、预算与 transition

### 7.1 `PlanReviewControlStateV1`

顶层 `WorkflowStatus` 仍为 `plan_review`；内部 substate 持久化在 `WorkflowState.planReviewState` 与 SQLite `plan_review_state_json`，避免虚构第二 stage engine：

```text
PlanReviewControlStateV1:
  schemaVersion: 1
  substate: initial_review | awaiting_replan | rereview | arbitration | awaiting_human
  reviewRound: 1 | 2
  planRejectionCount: 0 | 1 | 2
  arbitrationCycles: 0 | 1
  arbitrationTrigger: TriggerReason | null
  latestPlanArtifactRef
  latestReviewArtifactRef
  authorResponsesArtifactRef
  routeSelectionReceiptRef
  humanRequestReason: string | null
  updatedAt
```

ArtifactStore body 必须先 durable write 并计算 hash；随后 stage-state、attempt completion、artifact metadata、budget snapshot 与 top-level transition 使用 optimistic version 在同一 SQLite transaction 提交。不得只写内存字段后声称可恢复。

### 7.2 Transition 表

| 当前 top-level / substate | 输入 | 原子结果 |
|---|---|---|
| `plan_review/initial_review` 或 `rereview` | valid artifact + contradiction | arbitration arm on → substate=`arbitration`；off → `awaiting_human` |
| `plan_review/initial_review` 或 `rereview` | approved + suspicious_pass triggered | arbitration arm on → substate=`arbitration`；off → `awaiting_human` |
| `plan_review/initial_review` | approved，无 trigger | `implementing` |
| `plan_review/initial_review` | 第 1 次 changes_requested | `planRejectionCount=1`，top-level `planning`，substate=`awaiting_replan` |
| `planning` 完成新 plan | prior state=`awaiting_replan` | top-level `plan_review`，substate=`rereview`，复用冻结 reviewer identity |
| `plan_review/rereview` | approved，无 trigger | `implementing` |
| `plan_review/rereview` | 第 2 次 changes_requested + max_cycles_author_reject | arbitration arm on → substate=`arbitration`；off → `awaiting_human` |
| `plan_review/rereview` | 第 2 次 changes_requested + no trigger | `blocked`, reason=`max_plan_cycles_exceeded` |
| 任一 review | blocked 或任一 missing_authority | top-level 保持 `plan_review`，substate=`awaiting_human` |
| `plan_review/arbitration` | approved | `implementing` |
| `plan_review/arbitration` | blocked | `blocked`, reason=`arbitration_blocked` |
| `plan_review/arbitration` | no eligible model / receipt incomplete | substate=`awaiting_human` |
| `plan_review/awaiting_human` | valid human approved receipt | `implementing` |
| `plan_review/awaiting_human` | valid human blocked receipt | `blocked`, reason=`human_plan_review_blocked` |

`transitions.ts` 继续拥有 top-level legal transitions；新增纯函数拥有 plan-review substate transition。SQLite store 增加原子“完成 attempt + 更新 substate/预算 + 可选 top-level transition”操作，不使用不受审计的 self-transition。

### 7.3 Resume

- `resume` 从 `policyJson` 恢复并验证 QualityRouteSnapshotV2，从 `plan_review_state_json` 恢复 substate，从 artifacts 恢复 V2/author responses/receipts，从 BudgetLedger snapshot 恢复计数；
- `rereview` 必须加载初评的 `PlanReviewRouteSelectionV1`，不重新调用候选路由；
- arbitration runtime 结果已持久化但 transition 未完成时，resume 校验 hash 后幂等完成 transition；
- arbitration attempt 已开始但无可信 artifact 时，不自动重复付费调用；因默认 `maxArbitrationCycles=1`，转 `awaiting_human`；
- `awaiting_human` 的普通 resume 不调用模型，返回同一 substate 与 human request reason；workflow tool 的 `resume` 增加可选 `authorityReceiptRef`，只在该 substate 接受并校验 `HumanPlanReviewReceiptV1`；
- snapshot/schema/hash 不可验证时 fail closed，不把计数重置为 0。

### 7.4 Cancel

现有 `workflow op:"cancel"` 适用于所有 plan-review substate：中止 in-flight runtime、结束 open attempt、原子持久化 `cancelled` 与 budget；`awaiting_human` 也可取消。取消后是 terminal，不能 resume。外部 runner ownership 冲突继续沿用现有 `cancel_pending_foreign_runner` 语义。

### 7.5 Budget

扩展现有 `BudgetLedger`，不建立第二账本：

- `reviewerCycles` 继续计初评与复审；
- 新增 `arbitrationCycles` 并随 snapshot 持久化/恢复；
- `workflow.maxArbitrationCycles` 默认 1，仲裁外部调用前做 hard gate；
- 仲裁 request/tokens/USD/toolCalls/stageTime 计入 workflow 总预算和 `plan_review` stage budget；
- 无 provider cost 时不得补造 USD，仍用 requests、cycles、stage-time 上限 fail closed；
- `maxPlanCycles=2` 由 `planRejectionCount` 与 durable transitions/state 双重核对，第二次 rejection 不再进入 planning。

## 8. 错误处理

| 情况 | 行为 |
|---|---|
| V2 mandatory coverage <100% 却 decision=approved | schema/engine gate failure；不进入 implementing |
| finding 无 basis/source refs | schema failure；fail closed |
| 任一 basis=`missing_authority` | decision 必须 blocked；substate=`awaiting_human` |
| Sol 初评不可用 | 默认 awaiting_human；显式同族 fallback policy 才可用 Opus degraded |
| Grok 仲裁不可用 | 默认 awaiting_human；显式同族 fallback policy 才可用 Fable degraded |
| Fable 被标“第三家族” | route-policy validation failure；canonical family 为 anthropic |
| 复审 identity 与初评冻结 identity 不同 | fail closed 到 awaiting_human，不静默换 reviewer |
| arbitration receipt 缺 identity/clean-context/spec-evidence 任一项 | awaiting_human，reason=`arbitration_receipt_incomplete` |
| arbitration 输出 changes_requested | strict schema failure；不重试循环 |
| requirements snapshot 缺失或 hash 不匹配 | blocked/awaiting_human；模型不得改用猜测的“需求文档” |
| maxArbitrationCycles 达限 | awaiting_human；若人工不可用则显式 blocked，不再次调用模型 |
| cancel during review/arbitration | abort runtime，结束 attempt，持久化 cancelled |

## 9. A/B 实验与质量护栏

### 9.1 Common measurement envelope 与五个独立 feature arm

V2 schema/receipt plumbing 先作为共同 measurement envelope 落地，并建立一轮新 control baseline；它不是第六个 behavior arm。正式比较时 control/treatment 都用同一 V2 schema、同一 requirements snapshot、同一 receipt fields，只有被测 feature flag 不同。Legacy V1 只用于历史兼容，不进入配对样本。

| Arm | 独立开关 | Treatment | 独立 rollback owner |
|---|---|---|---|
| `route_sol_xhigh` | `workflow.planReviewPolicy.routeSolXhighEnabled` | 在同一冻结稿上只改变 plan reviewer route 为 Sol xhigh；不在本 arm 重生成 planner draft | QualityRouteSnapshotV2 version/fingerprint |
| `anti_anchoring` | `workflow.planReviewPolicy.antiAnchoringEnabled` | 在共同 V2 output schema 上启用反锚定 prompt 规则 | plan-reviewer prompt hash |
| `spec_evidence` | `workflow.planReviewPolicy.specEvidenceRequired` | 启用 100% mandatory coverage + finding basis decision hard gate；字段在两组都采集 | PlanReviewArtifactV2 policy version |
| `suspicious_pass_escalation` | `workflow.planReviewPolicy.suspiciousPassEscalation` | 结构化可疑 PASS 触发；arbitration arm 关闭时 fail closed 转人工，不 no-op | substate policy version |
| `arbitration` | `workflow.planReviewPolicy.arbitrationEnabled` | arbitration substate、第三 lineage route、human receipt | state schema + transition policy version |

所有 behavior 开关默认 false。每个 attempt 冻结 config fingerprint、prompt hash、schema version、route snapshot 与代码 revision；每个 arm 可单独关闭。`opus_planner_xhigh` 是整体 treatment chain 的拟议 planner profile，但其草稿质量影响需另做独立 draft-generation 实验，不混入上述五个 plan-review arm。

### 9.2 配对、样本量与双账本

- 同一冻结 PlanArtifact + requirements snapshot 在 control 与单一 treatment arm 各运行一个隔离 workflow attempt；不重新生成草稿。
- 随机化的是 control/treatment 的执行顺序，不是把一对样本按 attempt ID 奇偶拆成两个非配对组。
- 为避免计时互相污染，同一 pair 默认不重叠执行；若 CI 并行，必须隔离 provider quota/host resources 并记录 availability，availability 不可比的 pair 排除而不插值。
- Pilot 每 arm ≥30 对；正式 ≥100 对，或使用预注册 CI 固定测试集与置信区间。
- Canonical ledger：每个 attempt 内 plan review、replan、rereview、arbitration 的活跃 interval 取 union，每个时间区间只计一次；control/treatment 分账。
- Legacy ledger：各 request duration 求和，仅用于复算历史口径；不得与 canonical union 相加。
- 组合只报告 `S_combined`；单 arm marginal delta 只来自该 arm 对 control 的配对差。

### 9.3 Mandatory gate 与探索指标分层

**最终 rollout hard gate，不是统计目标：**

- PASS applicable mandatory requirement coverage = 100%；
- finding basis completeness = 100%；
- artifact/route/identity/clean-context/spec-evidence receipt completeness = 100%；
- 任一缺失均为本次 gate failure。

**[拟议验收目标]，只衡量非强制探索质量：**

- 预注册 non-mandatory dimensions 的逐条核对率 ≥90%；
- non-mandatory evidence density ≥80%；
- 反锚定字段遵守率 100%，其中 `uncoveredDimensions=[]` 可在有实质 rationale 时合法；
- 仲裁推翻率 5-25% 仅作诊断，不单独证明质量；
- PASS 前平均 replan rounds ≤1，与 `maxPlanCycles=2` 的一次 replan 语义一致。

### 9.4 质量停止条件

任一触发立即关闭对应 feature arm：

- blinded-human false-PASS rate 相对 control **上升 >2pp**；
- blinded-human false-FAIL rate 相对 control **上升 >2pp**；
- treatment 与盲化人工一致率下降 >2pp；
- approved 后 implementation/code-review repair/rework rate 相对 control 上升 >10%；
- invalid blocking rate（blocked 但人工判定合格）>10%；
- 任一归因于 plan 质量的 P0/P1 escape；
- author context 被 reviewer/arbitrator 复用、冻结 identity 漂移、receipt 缺失或 unknown lineage 任一合同违反。

### 9.5 成本停止条件

- arbitration trigger rate >30%：暂停并关闭 arbitration/suspicious-pass arm，先检查 reviewer/author 冲突与阈值；
- reviewer cycles P95 > control 2x；
- 每个 approved plan 的 requests/tokens/USD：P50 > control 1.5x 或 P95 > control 2x；
- 单 workflow 超 `maxBudgetUsd`、`maxRequests`、`maxStageTimeMs` 或 `maxArbitrationCycles` hard cap；
- cost unknown 时报告 unknown，不能用 0 代替。

## 10. 实施落点（实现阶段）

| # | 合同 | Canonical 文件 |
|---|---|---|
| 1 | `PlanReviewArtifactV2`、finding/coverage schema union | `packages/coding-agent/src/workflow/types.ts`, `schemas.ts`, `json-schemas.ts`, `parse-artifact.ts` |
| 2 | V2 plan-review runtime parsing | `packages/coding-agent/src/workflow/stages/plan-review.ts` |
| 3 | workflow plan-review prompt 五项规则 | `packages/coding-agent/src/prompts/workflow/plan-reviewer.md` |
| 4 | plan-arbitrator prompt/stage（同一 WorkflowEngine） | `packages/coding-agent/src/prompts/workflow/plan-arbitrator.md`, `workflow/stages/plan-arbitration.ts` |
| 5 | `plan_arbitrator` role、profiles、conditional availability mapping | `workflow/types.ts`, `default-config.ts`, `session-config.ts`, `availability-candidates.ts`, `model-profile-registry.ts` |
| 6 | `QualityRouteSnapshotV2` + exact selection receipt | `workflow/quality-route-snapshot.ts`, `model-router.ts`, `engine.ts` |
| 7 | durable plan-review substate + atomic store migration | `workflow/types.ts`, `sqlite-store.ts`, `engine.ts` |
| 8 | top-level/substate transition pure functions | `workflow/transitions.ts`, `engine.ts` |
| 9 | resume/cancel/human authority receipt ingestion | `workflow/workflow-tool.ts`, `engine.ts`, `abort-registry.ts`, `artifact-store.ts` |
| 10 | arbitration budget hard cap and restore | `workflow/budget-ledger.ts`, `default-config.ts`, `config/settings-schema.ts` |
| 11 | status/substate/routing/clean-context/spec-evidence receipts | `workflow/types.ts`, `engine.ts`, `runtime-invocation.ts`, `context-ledger.ts` |
| 12 | focused tests | `packages/coding-agent/test/workflow/` |

Focused tests 必须覆盖：legacy V1 resume、新 cohort V2 common envelope、100% mandatory PASS gate、五类 basis、任一 missing_authority 转人工、初评 identity pin、resume across new Engine、cancel every substate、第二次 rejection 不 replan、仲裁 at-most-one、Grok 第三 lineage、Fable degraded 标记、receipt 缺失 fail closed、五 arm 独立关闭。

## 11. 跨文档契约

1. **D 与 E**：完整 plan review 只走 WorkflowEngine；E 的 task 主动委派没有 plan-review adapter。Plan review prompt=`prompts/workflow/plan-reviewer.md`，code review prompt=`prompts/agents/reviewer.md`。
2. **D 与 B §8**：mandatory requirement coverage 100% 是 hard gate；B 的 ≥90% 逐条核对率与 ≥80% evidence density 只适用于预注册 non-mandatory exploration，并标 `[拟议验收目标]`。
3. **模型与 lineage**：目标 reviewer 是 Sol；独立自动仲裁优先 xai/Grok。`claude-fable-5` 与 Opus 同为 anthropic，只能 degraded fallback。
4. **配置**：current control 使用 2026-08-04 effective config snapshot；explicit 与 default-derived 分开，历史配置断言标 `[历史事实-当时配置]`。
5. **canonical owner**：无 `task-batch.ts`、无第二 route/review engine；所有改动落在现有 workflow owner。
6. **证据标签**：量化/事实断言只用 `[历史事实]`、`[算术上限]`、`[推导]`、`[未验证假设]`、`[拟议验收目标]`；无完整来源的文献说法不作为事实。

## 12. Round 1 findings 闭合记录

### Blocking

1. **PlanReviewArtifactV2 + 仲裁状态合同 — 闭合。** §4 定义严格 V2、100% mandatory gate、author responses/trigger/receipts；§7 定义 WorkflowEngine-owned durable substate、atomic persistence、resume/cancel/human receipt、budget 与 transition；`maxPlanCycles=2` 明确为第二次 rejection 即仲裁/block。
2. **Quality route snapshot / lineage — 闭合。** §3 基于 current balanced control 列 profile 顺序与 V2 immutable snapshot，冻结复审 identity；Sol unavailable 默认 fail closed/人工，同族 fallback 需显式 policy。经源码核验，Fable 不是第三 lineage，已改为 Grok，Fable 仅 degraded。
3. **Finding basis — 闭合。** §4-5 定义五类 basis 与严格 source refs；任一 `missing_authority` 必须 blocked/awaiting_human，不存在多数阈值。
4. **Canonical owner — 闭合。** §1.3/§11 只保留 WorkflowEngine；删除 task-agent plan-review adapter；autoplan 无 active owner，移出范围。

### Major

- **五 arm / 配对 A/B / 双账本 — 闭合。** §9 规定 V2 common envelope 后再做五开关配对，随机执行顺序、pilot ≥30、正式 ≥100 或预注册 CI、interval union 只计一次。
- **质量与成本 stop — 闭合。** §9.4-9.5 包含 false-PASS/false-FAIL、P0/P1 escape、invalid block、P50/P95 cost、>2pp 与 >10% 关闭条件。
- **独立仲裁与 receipt — 闭合。** §3/§7 优先 Grok 或盲化人工；Fable/Opus 同族 fallback 显式 degraded；identity/clean-context/spec-evidence 缺一即 fail closed。
- **量化标签 — 闭合。** 不可复现的 precision 断言已删除；PASS 早保留为 `[未验证假设]`；非强制 90%/80%、仲裁推翻率等标 `[拟议验收目标]`。
- **验收一致性 — 闭合。** §4.3/§9.3 将 mandatory 100% hard gate 与 non-mandatory 90%/80% 探索指标明确分层。
- **命名与事实 — 闭合。** 模型命名已规范；错误的 Fable 模型身份与第三家族断言已修正。

## 13. 最终验收

实现进入 rollout 前必须同时证明：

- 单强评审 + 同 identity 复审 + 有界仲裁端到端可运行；
- V2 common measurement envelope、100% mandatory PASS gate 与五类 basis 生效；
- resume/cancel/人工 authority/预算/transition 在 crash boundary 后可恢复；
- route snapshot 与 runtime identity 不漂移，Grok/Fable lineage 处理正确；
- 五个 arm 可独立关闭并恢复 control；
- 配对 A/B、interval-union、质量/成本停止条件有真实 receipt。

任何一项无证据均不能以 prompt 文本存在、单个测试通过或模型自报 PASS 代替。
