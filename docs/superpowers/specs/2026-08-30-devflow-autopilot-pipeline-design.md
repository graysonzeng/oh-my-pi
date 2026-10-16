# Design: DevFlow Autopilot Pipeline

- Date: 2026-08-30
- Status: Draft
- Scope: M
- design_author: grok
- design_author_identity: GrokDesignAuthor
- planned_reviewer: GPT-5.6-sol / subagent-sol
- review_fallback: 首轮 Gate 因 sol/opus 不可用由 flash-reviewer 给出 NEEDS_REVISION；随后 subagent-sol 连续给出 F1–F3、GateResult/answers/同行写、r5（原子 INSERT / expectedContext / CAS 清锁）、r6（runner 不窃锁、`/delivery` 注册、PASS* 阻断 finding）。本修订采纳全部已分类项。修订后仍须按 planned_reviewer 重跑 Gate；author 为 grok 时不可回退到 grok
- implementation_authorization: design-only
- authorization_source: 用户请求「对比自研 workflow、给出完整设计方案」+ parent-locked facts brief `local://delivery-pipeline-facts.md` + `local://revision-brief.md`（F1/F2/F3）+ `local://revision-brief-sol.md` + `local://revision-brief-sol-r5.md` + `local://revision-brief-sol-r6.md`（CAS `runner_owner IS NULL`、`builtin-modes.ts` 注册 `/delivery`、PASS* 不得带 open P0/P1/blocking）；明确 `implementation_authorization=design-only`，本设计不得授权编码

## 1. 设计目标和范围

### 1.1 要解决的问题

用户要的是一条**固定步骤、计划通过后无人再问**的交付管线：

`grill-me → plan → plan review until PASS / PASS_WITH_NOTES → implement → code review → fix-implement until PASS / PASS_WITH_NOTES`

并配合 goal 式续跑；DeepSeek-V4-Flash 只做「这一步有没有做完」的审核员；plan/code review 固定走 native `subagent-sol` / `subagent-grok`。

现网做不到这一点，是因为同时存在两套「workflow」心智、`workflow start` 建行却不跑、评审 agent 不是 sol/grok pair、没有 grilling、Flash 被当成实现者而不是完整性审计。

前几轮已锁定 overlay + `replanFromRedesign` + planning 内完整性闸门 + 32-step cap + `GateResultArtifact` + expectedContext + `grill.answers` + 同行 sidecar + 原子 INSERT + CAS 内 `SET runner_owner=NULL` 且 commit 后不 `releaseRunner`。Sol r6 指出三条仍会在实现时破坏合同的空洞：

1. `replanFromRedesign` 的 CAS `WHERE` 若不含 `runner_owner IS NULL`，可在 version 前进后清掉别人刚 `claimRunner` 的锁（现网 claim 保护是 `runner_owner IS NULL OR runner_owner = ?`，`sqlite-store.ts:463-485`）。
2. `/delivery` 只写了 `modes/delivery.ts`；内置 slash **不会**扫描 `modes/`，必须进 `builtin-modes.ts` → `builtin-registry.ts`。
3. Plan V2 拒绝 `approved` 带着 open P0/P1/blocking finding（`schemas.ts:286-299`），但 implementation `ReviewArtifactSchema` 没有对等不变量；`PASS*` + open P0 会 fail-open 批准实现。

### 1.2 成功标准

- 用户侧一条入口 `/delivery` 即可从当前对话拉起管线；计划未可执行时只通过 grill-me 问人；`PASS` / `PASS_WITH_NOTES` 之后 coordinator 自动续跑剩余阶段，不再向用户确认。
- `/delivery` 经 `lookupBuiltinSlashCommand("delivery")` 可解析；handler 调 `modes/delivery.ts`，再 `workflow op=run pipeline=devflow`。不复用 `workflowz`。
- 编码阶段的持久化 owner 仍是现有 `WorkflowEngine`：SQLite、hashed artifacts、isolation `prepared → applied`、budget、cancel、resume 不另起炉灶。
- `/delivery` / `op=run pipeline=devflow` 的 **第一次** `INSERT INTO workflows` 就带 `pipeline_kind='devflow'` 与含预阶段 `grill.answers` 的 `overlay_sidecar_json`。崩溃后 hydrate 仍是 devflow。
- Plan/code review 的四值走 `parseGateResultArtifact(raw, expectedContext)`；`subject` 必须匹配当前 stage；id/identity 缺省或匹配后由引擎盖章；`NEEDS_REVISION` 必须 `≥1` finding。
- `PASS` / `PASS_WITH_NOTES` 在 persist/转移前：若存在 `status==="open"` 且（`blocking===true` 或 `priority` ∈ `{P0,P1}`）的 finding → fail-closed（重试 1 次后暂停）。**禁止**自动降级为 `NEEDS_REVISION`。P2/P3 非阻塞 notes 允许留在 `PASS_WITH_NOTES`。plan 与 implementation 同一不变量。
- `approve` / `replan_counted` 由**引擎**派生现网 `PlanReviewArtifactV2`（plan）或 `ReviewArtifact`（implementation）；模型 JSON 只提供 verdict/findings/notes/explanation。`replan_exempt` 只持久化 `GateResultArtifact`，不物化 `changes_requested`。
- N 次 `NEEDS_REDESIGN` 不得仅因 redesign 进入终态 `blocked`，也不得递增 `planRejectionCount`。`NEEDS_REVISION` 仍消耗 `maxPlanCycles`，到顶仍可 `blocked`。
- 规划完整性失败不得进入 `plan_review`，不得消耗 `maxPlanCycles`。
- Grilling 的用户回答耐久写入同行 sidecar `grill.answers`，并进入下一次 planner 输入。
- `replanFromRedesign`：前置 `runner_owner IS NULL`；单次 CAS `WHERE` 含 `runner_owner IS NULL`；`SET` 含 `runner_owner=NULL`；成功后 **不** 调 `releaseRunner`；他锁 → `runner_lock_held`、零写入；成功态幂等零 UPDATE 且不碰 `runner_owner`。Coordinator 只在 awaiting_grill 已释放前一轮 runLoop 之后调用，不在持锁 `#runLoop` 内调用。
- 单次 `run`/`resume` 最多 32 个 stage step；未终态时返回当前 status，coordinator 再调现有 `resume`，不抬 cap。
- 普通 goal 的 `/goal complete` 用户确认语义不变；`workflowz` 仍是另一产品。
- 在飞的旧 workflow 行按旧 stage graph 恢复；新管线有显式 kind，无静默格式破坏。

### 1.3 本次范围

- 会话侧 **pipeline overlay**（固定 6 步协调 + 完整性 oneshot + Gate 适配）。
- 仅为本 pipeline 改写 `plan_reviewer` / `code_reviewer` 的 **agent 映射**（仍用现有 `WorkflowRole`）。
- 工具增加一次跑完的 `run` 入口。
- 在 `packages/coding-agent/src/slash-commands/builtin-modes.ts` 注册 `/delivery`；编排在 `modes/delivery.ts`。
- grilling 作为 **coordinator 预阶段 / 暂停点**（**同行 JSON 列** sidecar），不新增 `WorkflowStatus` / `WorkflowRole`。
- `createWorkflow` 扩展 opts，devflow INSERT 原子写入 kind + sidecar。
- `GateResultArtifact` + `parseGateResultArtifact(raw, expected)` fail-closed + 引擎派生现网 review 记录 + PASS* 阻断 finding 不变量。
- 新引擎方法 `replanFromRedesign`：已有 `plan_review → planning` 边上 **豁免** `planRejectionCount`；同行一次 CAS（含清 runner 且要求锁空）；幂等。
- `pipelineKind=devflow` 时，规划完整性 oneshot 在进入 `plan_review` **之前** in-stage 重试。
- Planner 输入包含 `grill.answers`。
- 文档与针对 overlay 的单测。

### 1.4 非目标

- 第二套 workflow 引擎、第二套 SQLite store、第二套 patch merger、第二套 quality-route compiler。
- 删除或退役现有 `workflow` 工具、quality routes、work packages、arbitration、isolation/receipts。
- 改普通 goal 的 `evaluateGoalHostGate` / `/goal complete` 用户确认。
- 把 Flash 当成 Design Review Gate 或 completion authority。
- 复用 `workflowz` 关键字、notice 或 `eval`/`parallel`/`pipeline` fan-out 产品。
- 新增 `WorkflowRole` 或把 auditor / Gate 结果编进 `QualityRouteSnapshotV1.routes` / `AVAILABILITY_ROLE_ORDER`。
- 新增 `grilling` `WorkflowStatus`，或新增 `planning → planning` 边。
- 把四值写入模型侧 `PlanReviewArtifactV2.decision`，或从失败 parse 发明 `approved` / `changes_requested`。
- 要求模型 Gate JSON 含全部 V2 字段。那些由引擎从当前 control state 填充。
- 把 `PASS*` + open P0/P1/blocking 自动降级为 `NEEDS_REVISION`。
- Sidecar 旁路表、第二 sqlite 文件、status 与 sidecar 分两次 `UPDATE`、`replanFromRedesign` commit 后再 `releaseRunner`、CAS 窃取非空 `runner_owner`。
- 从 request 散文推断 `pipelineKind`。
- 新建 slash registry 文件（`/delivery` 进现有 `builtin-modes.ts`）。
- 把 `maxSteps` 从 32 调大，或在 `#runLoop` 外包第二套引擎循环。
- 用散文「重置 planRejectionCount」代替 API。
- 无现有 isolation 政策的 auto-merge 到 main。
- 重写 Trellis / Intent / grill-me-adapter 的 ownership。
- 本设计授权实现（`design-only`）。

## 2. 背景与约束

- **产品 A — `workflowz`**：`packages/coding-agent/src/modes/workflow.ts` + `packages/coding-agent/src/prompts/system/workflow-notice.md`。散文小写关键字。无 stage、无 artifact、无引擎。
- **产品 B — `workflow` 工具 + `WorkflowEngine`**：`packages/coding-agent/src/workflow/workflow-tool.ts`、`engine.ts`、`docs/workflow.md`。Ops 仅 `start | status | resume | cancel`（`workflow-tool.ts:13`）。`engine.start` 注释写明 *Does not execute stages*（`engine.ts:506-509`）。引擎已有内部 `run()`（`engine.ts:861-863`）但工具未暴露。
- Stage graph（`types.ts:28-41`，`transitions.ts:3-16`）：`created → planning → plan_review → implementing → implementation_verify → code_review → repairing → final_verify → completed | blocked | cancelled | failed`。`planning` 的非失败出边 **只有** `plan_review`（`transitions.ts:5`）。`blocked` 在 `TERMINAL`（`engine.ts:164`）；终态 `resume` 抛 `cannot_resume_terminal`（`engine.ts:808-809`）。
- 模型只回 versioned artifacts；引擎拥有转移、budget、cancel、resume。写阶段 isolation：`apply: false` 再 `prepared → applied`。
- Plan/code review artifact 决策只有 `approved | changes_requested | blocked`（`schemas.ts:237`）。
- `changes_requested` 时 `planRejectionCount + 1`（`engine.ts:1597-1598`）。到顶走 `#setPlanReviewAwaitingHuman` → 终态 `blocked`（`engine.ts:1636-1648`、`3592-3606`）。默认 `maxPlanCycles=2`、`maxRepairCycles=3`（`default-config.ts:709-710`）。
- `#runLoop`：`maxSteps = singleStep ? 1 : 32`（`engine.ts:880-887`）。
- `createWorkflow` 现网 INSERT 不含 kind/sidecar（`sqlite-store.ts:145-156`）。`#mapState` 不读这两列（`sqlite-store.ts:165-178`）。
- `claimRunner`：`WHERE id=? AND version=? AND (runner_owner IS NULL OR runner_owner = ?)`；他锁 → `runner_lock_held`（`sqlite-store.ts:463-485`）。
- `releaseRunner` 是另一次 `UPDATE workflows SET runner_owner=NULL, version=version+1`（`sqlite-store.ts:500-506`）。
- `#persistArtifact` 把 body 原样落盘，不改内部 identity（`engine.ts:3656-3682`）。
- Plan V2 `approved` 拒绝 open blocking/P0/P1 finding（`schemas.ts:286-299`）。Implementation `ReviewArtifactSchema` 只约束 `changes_requested`/`blocked`（`schemas.ts:121-145`），**没有**对等 approved 不变量。
- Finding 形状：`ReviewFindingSchema`（`id/priority/category/status/confidence/summary/explanation/suggestedOwner`，`blocking` 可选，`schemas.ts:99-122`）。
- 内置 slash **静态**注册：`BUILTIN_MODE_SLASH_COMMANDS` 来自 `builtin-modes.ts`，在 `builtin-registry.ts:38-50` 拼进 `BUILTIN_SLASH_COMMAND_REGISTRY`。`lookupBuiltinSlashCommand` 只查该表。`/goal` 已是 `builtin-modes.ts:277` 的 `SlashCommandSpec`。扫描 `modes/` **不会**注册命令。
- `WORKFLOW_ROLE_TO_AGENT`（`runtime-adapter.ts:126-134`）：planner→`designer`，review 角色→bundled `reviewer`，implementer/repair→`task`。
- `WorkflowRole` 闭集（`types.ts:384`）。`QualityRouteSnapshotV1.routes` 为 `Record<WorkflowRole, readonly string[]>`（`types.ts:423-426`）。`AVAILABILITY_ROLE_ORDER` 同闭集（`availability-candidates.ts:5-12`）。
- Flash 是默认 **implementer**（`default-config.ts:288-294`）。
- Dev Flow：brainstorm → Gate（`PASS` / `PASS_WITH_NOTES` / `NEEDS_REVISION` / `NEEDS_REDESIGN`）→ implement → code-review → fix-implement。
- Goal：`goal({op:"complete"})` 只提名；host-gate 过了仍要用户 `/goal complete`。
- Native：`subagent-sol` 默认 Gate reviewer；`subagent-grok` 默认 author，仅审非 grok 稿。评审 spawn `shadowReview: "code"`。禁止 grok 审 grok。
- `PASS_WITH_NODE` = `PASS_WITH_NOTES` 笔误。
- 实现授权：design-only。

## 3. 根因分析（按需）

### 3.1 是否需要根因分析

- 需要。
- 理由：方案选择取决于「现网 workflow 为什么显得重」，以及多轮 Gate 指出的合同缺口。根因不是引擎能力不足（那会导向第二引擎，禁止），而是 **两套产品 + 入口不跑 + 评审映射错 + 无人问环节 + Flash 角色错配 + plan 回环绑在 `changes_requested` + 四值无 typed 产物 + 答案不进 planner + sidecar 双写 + 建行后再补 kind + Gate JSON 未绑定 + commit 后再 releaseRunner + CAS 可窃锁 + slash 未进 registry + implementation PASS* fail-open**。overlay + 已采纳机制 + r6 三条补丁是满足约束的最浅落地。

### 3.2 已确认事实

- 两套「workflow」产品并存。证据：`modes/workflow.ts`、`workflow-tool.ts`、`docs/workflow.md`。
- `start` 建行不跑。证据：`engine.ts:506-509`。
- 评审映射到 bundled `reviewer`。证据：`runtime-adapter.ts:126-134`。
- 引擎 decision 三值，无 grilling / 无 `PASS_WITH_NOTES`。证据：`schemas.ts:237`、`transitions.ts:38-42`。
- Flash 是 implementer。证据：`default-config.ts:288-294`。
- `blocked` 不可 resume。证据：`engine.ts:164`、`808-809`。
- Goal complete 与引擎终态分离。证据：`host-gate.ts:195-246`。
- Role 闭集。证据：`types.ts:384`、`availability-candidates.ts:5-12`。
- Plan 回环唯一质量路径是 `changes_requested` 且自动 +1 `planRejectionCount`，到顶终态 `blocked`。证据：`engine.ts:1597-1598`、`1636-1648`、`3592-3606`。
- `planning` 成功出边只有 `plan_review`。证据：`transitions.ts:5`。
- `#runLoop` 最多 32 step。证据：`engine.ts:880-887`。
- `createWorkflow` INSERT 不含 kind/sidecar。证据：`sqlite-store.ts:145-156`。
- `claimRunner` 保护他锁。证据：`sqlite-store.ts:463-485`。
- `releaseRunner` 是第二次 UPDATE + `version+1`。证据：`sqlite-store.ts:500-506`。
- Plan V2 approved 拒绝 open P0/P1/blocking。证据：`schemas.ts:286-299`。Implementation review schema 无对等规则。证据：`schemas.ts:121-145`。
- Slash 只从 `builtin-registry.ts` 静态表解析。证据：`builtin-registry.ts:38-50`、`lookupBuiltinSlashCommand`。`/goal` 在 `builtin-modes.ts:277`。

### 3.3 未确认假设

- 「对话出方案后执行」= 当前 session transcript 作为 `request`。
- ≤8 个一次性问题通常能问到可执行计划；超限展示 `missing[]`，不缩范围。
- Pipeline plan author 默认 grok 家族，默认 reviewer 必须是 sol。
- 在飞 legacy 行不自动升级 kind。
- 规划完整性 in-stage 重试 2 次足够补验收/文件列表。
- Native sol/grok 能产出最小 Gate JSON；V2 extras 由引擎填。

### 3.4 对设计的影响

- Overlay 现有引擎，不是 session-only Dev Flow。
- 不加 `WorkflowRole` / `grilling` status。
- `NEEDS_REDESIGN` 不得进 `changes_requested`。`replanFromRedesign` 必须在锁空时一次 CAS，且不得窃锁。
- 四值经 expectedContext parse → adapter → 引擎派生。`PASS*` 带 open P0/P1/blocking 在派生前 fail-closed，不降级。
- `/delivery` 必须作为 `SlashCommandSpec` 进 `builtin-modes.ts`。
- 预阶段答案必须出现在 **INSERT**。
- 规划完整性失败停在 `planning`。
- Flash 是 oneshot，不能 PASS Gate。
- 「立刻跑」受 32 step 限制，返回值写明。

## 4. 方案对比

### 4.1 方案 A — Pipeline overlay（推荐）

- 核心思路：会话 coordinator + 现有 `WorkflowEngine`。固定 6 步；grilling / Flash auditor / `GateResultArtifact` 放 overlay；devflow 行 INSERT 即带 kind+sidecar；`/delivery` 走 builtin slash；`NEEDS_REDESIGN` 走 `replanFromRedesign`（锁空 CAS）；规划完整性在 `planning` 内重试；编码阶段走现网 isolation/verify/repair。
- 优点：耐久 unattended；复用 canonical owner；legacy 不破坏；Gate pair 对齐 Dev Flow。
- 缺点：比现网 qualityRoutes / workPackages / degraded / singleStep / workflowz 更不灵活；kind 分叉与 sidecar 要维护；单次 run 32 step 上限。
- 适用前提：parent 锁定 overlay + 不扩 Role/Status + 同行 sidecar + 原子建行 + 不窃锁。已确认。

### 4.2 方案 B — 仅会话 Dev Flow 自动驾驶（不用引擎）

- 核心思路：主 agent + goal continuation + native subagents，不调用 `WorkflowEngine`。
- 优点：几乎不改引擎 schema；字面复用 Dev Flow skills。
- 缺点：失去 isolation / receipts / resume / budget fail-closed；prompt 里第二套非正式引擎；`/goal complete` 仍要人。不满足耐久 unattended。
- 适用前提：接受不耐久。已被 parent 否决。

### 4.3 选型结论

- 选择：方案 A。
- 理由：只有 A 满足「耐久 unattended + canonical owner = WorkflowEngine」。B 只在放弃耐久时更浅。相对上一稿，本修订只补：CAS 不窃锁、slash 进 `builtin-modes.ts`、PASS* 阻断 finding — 不是第二引擎。

**对「更简洁 / 更灵活 / 实现更简单」的诚实回答：**

- **对用户更简洁：是。** 固定 6 步 + 计划通过后无人干涉，比 `start` 不跑、`resume` 手接、quality route、work packages、arbitration、`workflowz` 另一套编排，心智更小。
- **对用户更灵活：否。** 固定步骤比现网 qualityRoutes / workPackages / degraded / singleStep / workflowz 更不灵活。唯一灵活点是「计划未完善才问人，完善后全自动」。
- **对实现更简洁：仅当 overlay，不重写引擎。** 重写会丢掉 isolation、receipt、resume、fail-closed。第二套引擎是缺陷。r6 三条是合同闭合，不是新引擎。
- **和 Dev Flow 比：** 自动续跑 + SQLite 比 prompt handoff 更强；Gate 四值与 sol/grok pair 对齐 Dev Flow，不发明第三套 verdict。

## 5. 详细方案

> 只展开方案 A。方案 B 不写文件级细节。

### 5.1 核心思路

在现有 `WorkflowEngine` 上加一层 **DevFlow pipeline overlay**：

1. 用户 `/delivery`（`builtin-modes.ts` 注册）→ `modes/delivery.ts` → `workflow op=run pipeline=devflow`。
2. Coordinator 摄入 transcript（untrusted），Flash oneshot 做完整性判断；不完整则 grill-me；完整则 `engine.start` **一次 INSERT** 写入 `pipeline_kind` + 含预阶段 `grill.answers` 的 sidecar，然后立刻 `#runLoop`。
3. `planning` 用现有 planner；prompt 含 `grill.answers`；进 `plan_review` 前跑完整性 oneshot；失败留在 `planning`。
4. Review spawn `subagent-sol`（默认）或 `subagent-grok`（author 非 grok），`shadowReview: "code"`。产出最小 Gate JSON。`parseGateResultArtifact(raw, expected)` 绑定 stage/id/identity；PASS* 阻断 finding 在盖章后、persist 前检查。
5. `gate-adapter(verdict, subject)` → intent。现网 durable review **由引擎派生**（模型不填 V2 extras）。
6. `replan_exempt` 停在非终态 `plan_review`。用户回答 append `grill.answers` 后，**仅当 runner 已释放**，调用 `replanFromRedesign`（CAS 要求 `runner_owner IS NULL`，SET 把它保持 NULL）。
7. `PASS*` 后不问用户；32 step 内连续 `resume`。
8. Flash 不是 Role / Gate。Grilling 不是 `WorkflowStatus`。Sidecar 不是旁路表。NULL kind = legacy。

### 5.2 关键数据流 / 控制流

1. **入口。** 用户输入 `/delivery` 或 `/delivery <补丁>`。`lookupBuiltinSlashCommand("delivery")` 命中 `builtin-modes.ts` 的 spec。`handle` 调 `modes/delivery.ts` 的 coordinator，把当前 transcript + args 收成 `request`，调用 `workflow` 工具 `op=run pipeline=devflow`。不触发 `workflowz`。Power user 仍可用 `workflow` 工具。
2. **预阶段 grilling（尚无行）。** Flash oneshot `{ complete, missing[], next }`。`complete=false` → 只问 `next`。满 8 问：停止自动提问，展示 `missing[]`（不是引擎终态）。
3. **建行（一次 INSERT）。** `complete=true` 后 `createWorkflow(request, policy, { pipelineKind: "devflow", overlaySidecar })`。INSERT 含 `pipeline_kind='devflow'` 与 sidecar（`phase: "running"`，预阶段 `grill.answers` copy-on-create）。禁止 INSERT 后再补 kind/answers。无 opts → 两列 NULL = legacy。`#mapState` hydrate 这两列。不从散文推断 kind。
4. **跑。** INSERT 后立刻 `#runLoop`。一次最多 32 step。满 32 且非终态非 `awaiting_grill` → 返回 `maxStepsReached=true`；coordinator 不问用户再 `resume`。
5. **planning + 完整性闸门。** 仅 devflow：planner context 含 `grill.answers`（untrusted，现网 injection boundary）。合法 PlanArtifact 之后、`getNextStage("planning")` 之前：Flash oneshot。`complete=false`：保持 `planning`；不进 `plan_review`；不计 `planRejectionCount`。retry < 2：同 status 再跑 planner（新 attemptId）。到上限：sidecar `phase=grilling` `reason=incomplete_plan`（status 不变的 CAS；若持锁则该 CAS 可 `runner_owner=NULL` 且不随后 `releaseRunner`，或先 `#runLoop` 按现网 finally `releaseRunner` 再返回 — **awaiting_grill 返回时 runner 必须已空**）。永不因此 `blocked`。用户答：先 append answers，再 `resume`。`complete=true`：`planning → plan_review`。legacy 跳过闸门与 answers。
6. **Review 产物。** 仅 devflow：spawn sol/grok，`shadowReview: "code"`。最小 JSON：`verdict`、`subject`、`findings`、`notes`、`explanation`；id/identity 可选。`expected.subject`：`plan_review`→`plan`，`code_review`→`implementation`。`parseGateResultArtifact(raw, expected)` fail-closed 除非 JSON 合法、四值、`subject===expected.subject`、id 缺省或相等、identity 缺省或 `modelFamily` 相等。引擎盖章 ids/timestamps/完整 identity。`NEEDS_REVISION` 要求 `findings.length>=1`（`ReviewFindingSchema` 必填子集）。`PASS`/`PASS_WITH_NOTES` 允许空 findings，但 **不得** 含 open P0/P1/blocking（下一步）。失败：重试 1 次，再暂停；不发明 `approved`/`changes_requested`。成功：persist `gate-result`，`intent = gateAdapter(verdict, subject)`。
7. **PASS* 阻断不变量（persist/转移前，plan 与 implementation 相同）。** 若 `verdict` ∈ `{PASS, PASS_WITH_NOTES}` 且任一 finding `status==="open"` 且（`blocking===true` 或 `priority` ∈ `{P0,P1}`）→ 视为 parse/derive fail-closed（计入上述 1 次重试，再暂停）。**禁止**改写成 `NEEDS_REVISION` / `replan_counted`（那会发明一次计入 `maxPlanCycles`/`maxRepairCycles` 的回环）。P2/P3 或 `blocking!==true` 的 notes 允许留在 `PASS_WITH_NOTES`。此检查在 pipeline 派生 helper 内执行；**不**改 legacy 非 pipeline `ReviewArtifactSchema`（implementation helper 仅 pipeline 调用）。Plan 派生仍须通过现网 V2 `approved cannot leave open blocking findings`。
8. **按 intent 派生。**
   - `approve` → 引擎派生 V2/`ReviewArtifact` `decision: approved`（confidence 缺省 0.5；plan 填 snapshot/coverage/reviewRound/reviewKind/receipts；`antiAnchoringRationale` 固定模板字符串，不是第二次模型调用）。然后 `getNextStage(..., "approved")`。不问用户。
   - `replan_counted` → 派生 `changes_requested`（≥1 finding）→ 现网计数器。到顶 → `#setPlanReviewAwaitingHuman` → 终态 `blocked`。
   - `replan_exempt`（plan `NEEDS_REDESIGN`）→ **只** persist GateResult。不停产 `changes_requested`。保持 `plan_review`。Sidecar grilling `needs_redesign`。**awaiting_grill 返回前 runner 必须已空**（暂停 CAS 可在同一条 UPDATE 里 `runner_owner=NULL` 且不 `releaseRunner`，或 runLoop finally 先 release 再返回；不得在持锁时调 `replanFromRedesign`）。
   - `block`（缺权威 / code_review `NEEDS_REDESIGN`）→ 派生 `blocked`。终态。code_review redesign 不走 `replanFromRedesign`。
9. **离开 `needs_redesign`。** Coordinator：确认 `runner_owner IS NULL`（status 报告 / hydrate）→ append `grill.answers` → `replanFromRedesign(workflowId)` → `resume`。禁止在持锁 `#runLoop` 内调用。
10. **`replanFromRedesign`。** 见 5.3。成功：`planning`、sidecar `phase=idle`（保留 answers）、计数不变、`runner_owner` 仍 NULL。随后 resume 跑 planner。
11. **implementing。** `apply: false`，`prepared → applied`。Flash 可继续做 implementer profile，本步完整性 oneshot 不能替代 code review。
12. **implementation_verify。** 无 LLM。失败 → `repairing`。
13. **code_review。** 同 Gate 路径，`expected.subject="implementation"`。`approve` → `final_verify`。`replan_counted` → `repairing`（`maxRepairCycles=3`）。`NEEDS_REDESIGN` → `block`。
14. **repairing → implementation_verify。** 现有 repair role。Flash 只审计是否响应 finding IDs。
15. **final_verify。** 无 LLM。通过 → `completed`。不要求 `/goal complete`。
16. **Goal。** grilling 不创建 goal。Autopilot = 引擎循环 + 32-step 边界再 `resume`。普通 goal complete 零改动。

### 5.3 接口 / 配置 / 数据结构变更

只列推荐方案将改/新建的路径。

**接口**

- `packages/coding-agent/src/slash-commands/builtin-modes.ts`
  - 在 `BUILTIN_MODE_SLASH_COMMANDS` 增加一条 `SlashCommandSpec`：`name: "delivery"`，description 表明 DevFlow 固定管线（grill → plan → review → implement → code review → fix），`allowArgs: true`（可选补丁文本）。`handle` 调用 `modes/delivery.ts` 导出的 coordinator（例如 `runDeliveryPipeline(runtime, command.args)`），由其发 `workflow op=run pipeline=devflow`。不新增 registry 文件。`builtin-registry.ts` 已 spread `BUILTIN_MODE_SLASH_COMMANDS`，不必改（除非测试要直接 import spec）。
- `packages/coding-agent/src/modes/delivery.ts`（新建）：会话 coordinator（transcript ingest、预阶段 grilling、把 answers 折进 request、调 workflow 工具、32-step 后再 resume、grilling 恢复）。**不是** slash 发现入口。
- `packages/coding-agent/src/workflow/workflow-tool.ts`
  - `op` 增加 `"run"`。结束：终态、`awaiting_grill`、policy block、`steps===32`。
  - `pipeline?: "devflow"`。缺省 legacy。
  - `pipeline=devflow` 的 `start`/`run` 必须把 kind+初始 sidecar 传入 `createWorkflow` 第三参。
  - 返回：`status`、`workflowId`、`stepsExecuted`、`maxStepsReached`、`awaitingGrill`、sidecar `reason`。
- `packages/coding-agent/src/workflow/sqlite-store.ts`
  - 迁移：`pipeline_kind TEXT NULL`、`overlay_sidecar_json TEXT NULL`。不建旁路表。
  - `createWorkflow(request, policy, opts?)`：有 `pipelineKind` 时同一条 INSERT 写两列；无 opts 显式 NULL。
  - `#mapState` hydrate。NULL kind = legacy。
  - `completeExemptReplan`（或等价）：一个 transaction：attempt 收尾 + `INSERT transitions` + **恰好一条** `UPDATE workflows SET status='planning', current_stage='planning', overlay_sidecar_json=?, runner_owner=NULL, updated_at=?, version=version+1 WHERE id=? AND status='plan_review' AND version=? AND runner_owner IS NULL`。`changes!==1`：若 `runner_owner` 非空且不是「本应成功的空锁」→ `runner_lock_held`；否则 `optimistic_version_conflict`。事务回滚。
- `packages/coding-agent/src/workflow/engine.ts`
  - `start`：devflow 把 kind+sidecar 交给 `createWorkflow`。
  - `replanFromRedesign(workflowId)`：
    1. 读行。成功态（`status==="planning"` 且最后 transition reason `plan_review:needs_redesign` 且 sidecar `phase==="idle"`）→ **return，零 UPDATE，不碰 `runner_owner`**（即使当前有 runner 也不清）。
    2. 否则断言 `pipelineKind==="devflow"`、非终态 `plan_review`、sidecar grilling `needs_redesign`、**`runner_owner IS NULL`**。任何人持锁 → `WorkflowPolicyError("runner_lock_held")`，零写入。
    3. 调用上款 CAS。计数不写新值。sidecar `phase=idle`，answers 保留。
    4. 不 `getNextStage(..., "changes_requested")`，不走 `engine.ts:1597-1598`，不 `#setPlanReviewAwaitingHuman`。
    5. commit 后 **不** `releaseRunner` / `clearRunnerOwner`。
    6. 不跑 planner；caller 再 `resume`。
  - 禁止从持锁 `#runLoop` 调 `replanFromRedesign`。Coordinator 契约：awaiting_grill 返回后锁已空。
  - Review 路径：parse(expected) → PASS* 阻断检查 → persist gate-result → adapter → 派生或不派生。
  - Planning 闸门 + answers 注入。`maxSteps=32` 不改。
- `packages/coding-agent/src/workflow/runtime-adapter.ts`：pipeline agent 名分叉；expected identity 来自 spawn；禁止 grok 审 grok。
- `packages/coding-agent/src/workflow/gate-adapter.ts`（新建）：纯函数 `(verdict, subject) → intent`。
- `packages/coding-agent/src/workflow/schemas.ts`：`GateResultArtifact` + `parseGateResultArtifact(raw, expected)` + pipeline-only `assertPassHasNoOpenBlockers(findings)` + `derivePlanReviewArtifactV2` / `deriveReviewArtifact`（后者含同一 PASS* 检查；不修改 legacy schema）。
- 不新增 `WorkflowRole`。devflow review agent：`subagent-sol`（author 非 grok 时允许 `subagent-grok`）；legacy `reviewer`。

**配置**

- `packages/coding-agent/src/workflow/default-config.ts` overlay 块（不是新 role profile）：`kindDefault: "off"`；`auditorModel: "deepseek-v4-flash"`；`maxGrillQuestions: 8`；`maxPlanningCompletenessRetries: 2`。
- 仅 `pipelineKind=devflow` 时 review 路由 sol 优先。legacy 第一优先不变。
- `maxPlanCycles=2`、`maxRepairCycles=3` 沿用。

**数据结构**

- `types.ts`：`pipelineKind?: "devflow"`。不扩 Status/Role。intent：`approve | replan_counted | replan_exempt | block | pause_grill`。
- 模型最小 Gate JSON：`verdict`、`subject`、`findings`、`notes`、`explanation`；可选 id/identity。
- 持久化 `GateResultArtifact`（kind `gate-result`）：上列 + 引擎盖章的 workflowId/attemptId/createdAt/reviewerIdentity。
- Finding：`ReviewFindingSchema`。V2 plan 派生时引擎为缺 `basis` 的项填合法 basis/`sourceRefs`；无法填则 fail-closed，不得丢 finding 后 `approved`。
- Sidecar JSON：`phase`；`grill: { round, maxQuestions, lastQuestion, missing[], reason?, answers[] }`；`planningCompletenessRetries`；`gateResultArtifactId?`。answers append-only。
- Adapter 映射：

| 输入 | subject | intent | 随后 |
|---|---|---|---|
| `PASS` | 任一 | `approve` | 无 open P0/P1/blocking 才派生 `approved` |
| `PASS_WITH_NOTES` | 任一 | `approve` | 同上；P2/P3 notes 允许 |
| `NEEDS_REVISION` | `plan` | `replan_counted` | V2 `changes_requested`；计 `maxPlanCycles` |
| `NEEDS_REVISION` | `implementation` | `replan_counted` | `ReviewArtifact` `changes_requested`；计 `maxRepairCycles` |
| `NEEDS_REDESIGN` | `plan` | `replan_exempt` | 只 persist GateResult；之后 `replanFromRedesign` |
| `NEEDS_REDESIGN` | `implementation` | `block` | 派生 `blocked` |
| 缺权威 | 任一 | `block` | 现网 `blocked` |

`PASS_WITH_NODE` 按 `PASS_WITH_NOTES`。
- `transitions.ts`：**不改** `VALID_TRANSITIONS`。
- Prompts：`prompts/workflow/completeness-auditor.md`、`gate-review-adapter.md`（最小字段 + 禁止 V2 extras + 禁止 PASS* 带 open P0/P1/blocking）；改 `context-plan.hbs.md` 注入 answers。Oneshot kind：`pipeline_auditor`。
- `packages/coding-agent/src/goals/`：**不改** host-gate / ordinary complete。
- `docs/workflow.md`、`packages/coding-agent/CHANGELOG.md`：overlay、`/delivery` slash、原子 INSERT、expectedContext、PASS* 阻断、`replanFromRedesign` 锁空 CAS、32-step、`workflowz` 边界。
- 测试：`packages/coding-agent/test/workflow/` 与 slash lookup 测试（见 §6）。

### 5.4 错误处理与回退策略

- **Slash：** 未知 `/delivery` 不得静默当普通聊天；注册后 lookup 必须命中。Handler 失败走现网 slash 错误展示。
- **建行：** preflight 失败不 INSERT。崩溃后只存在 INSERT 成功的行。
- **Gate parse / expectedContext / PASS* 阻断 / V2 派生失败：** fail-closed；重试 1 次；再暂停给人看 raw/error。不发明 `approved`/`changes_requested`，不转移，不递增计数，**不**把 PASS* 降级为 `NEEDS_REVISION`。
- **`replanFromRedesign`：** 他锁 → `runner_lock_held`，零写入，锁不变。前置失败（kind/status/sidecar）→ policy error，零写入。成功态 → no-op，不碰锁。CAS 冲突（version）→ `optimistic_version_conflict`。commit 后禁止 `releaseRunner`。
- **Auditor 解析失败：** fail-closed；规划阶段按 `incomplete_plan` 暂停。供应商/超时不得 auto-approve；规划阶段不可用不得假装 complete 进 `plan_review`。
- **Flash vs sol：** 以盖章 GateResult + adapter 为准。已 `PASS*` 不被 Flash incomplete 打回。
- **grok 审 grok：** fail-closed 改 sol；sol 不可用且非 degradedMode → block，记录 `review_fallback`。
- **`NEEDS_REVISION` 打满 `maxPlanCycles`：** 现网终态 `blocked`。REDESIGN 打满不得因此 `blocked`。
- **budget / forbidden paths / isolation `changesApplied===false`：** 现网 fail-closed。禁止静默缩目标。
- **grilling 满 8 问 / 规划完整性 2 次：** `awaiting_grill`，不是完成态，不是 `blocked`。
- **恢复：** 先读同行 sidecar。`needs_redesign` 须 answers append + 锁空 + `replanFromRedesign`，不得直接 resume 重跑 `plan_review`。
- **32 step：** 非终态返回；coordinator 再 `resume`。
- **legacy：** NULL kind → 旧图。overlay API 对 legacy fail-closed。
- **cancel：** 现网 `cancelled`。
- **注入：** transcript 与 `grill.answers` untrusted。

### 5.5 风险与缓解

- 风险：CAS 清掉别人的 `claimRunner`。缓解：WHERE `runner_owner IS NULL`；他锁测试。
- 风险：`/delivery` 写了 coordinator 但用户敲命令无注册。缓解：`builtin-modes.ts` spec；lookup 测试。
- 风险：implementation `PASS_WITH_NOTES` + open P0 批准上线。缓解：subject-independent 检查；禁止降级；plan/implementation 双测。
- 风险：建行后再写 kind。缓解：INSERT 一次写齐。
- 风险：模型填满 V2 / 四值塞进 `decision`。缓解：引擎派生；模型最小 JSON。
- 风险：commit 后再 `releaseRunner`。缓解：CAS 已 NULL；禁止 post-commit release。
- 风险：答案不进 planner。缓解：`grill.answers` + INSERT copy-on-create。
- 风险：grilling 做成 `blocked`。缓解：sidecar 非终态。
- 风险：32 step 被当成失败。缓解：`maxStepsReached` + 自动再 resume。
- 风险：`/delivery` 与 `workflowz` 混淆。缓解：不同入口；禁止共享 keyword。
- 风险：与 `/goal complete` 抢语义。缓解：不改 host-gate。

## 6. 验证计划

本阶段 design-only，不跑全仓格式化/lint/测试。实现阶段的最小充分验证：

- **Slash：** `lookupBuiltinSlashCommand("delivery")` 有 spec；handler 以 `pipeline=devflow` 调 run（mock workflow 工具）。无 `workflowz` 关键字耦合。`builtin-registry` 不必新增文件。
- **P1-create：** INSERT 后立刻 SELECT `pipeline_kind='devflow'` 且 JSON 含预阶段 answers。丢内存 hydrate 仍 devflow。无 opts → NULL/legacy。
- **parse + expectedContext：** wrong subject / stale id / family mismatch / `NEEDS_REVISION` 空 findings → fail-closed。缺 id 由引擎盖章仍成功。
- **PASS* 阻断：** implementation `PASS_WITH_NOTES` + open P0 → fail-closed，无 `approved`，无 `code_review → final_verify`。Plan 同样。`PASS_WITH_NOTES` + open P3 非阻塞 → `approve` 允许。禁止断言被降级为 `NEEDS_REVISION`。
- **派生：** `NEEDS_REVISION`+plan → V2 `changes_requested` ≥1 finding + 计数 +1；模型 JSON 无 V2 extras 也能过 schema。`NEEDS_REDESIGN`+plan → 只有 gate-result，无 `changes_requested`。
- **`replanFromRedesign`：** 先 `claimRunner` 另一 owner，status `plan_review` + grilling `needs_redesign` → `runner_lock_held`，无 transition，`runner_owner` 不变。成功路径：恰好一次 `UPDATE workflows`（status+sidecar+`runner_owner=NULL`），无随后 `releaseRunner`，version +1。成功后再调：零 UPDATE，不碰锁。N≥3 次 redesign 非终态。Legacy 调用 fail-closed。
- **F2-answers / 完整性闸门 / 32-step / role 闭集 / agent map / legacy graph：** 保持上一轮用例。
- **`NEEDS_REVISION` 耗尽 `maxPlanCycles`：** 终态 `blocked`，`cannot_resume_terminal`。
- **确定性 verify：** `implementation_verify` / `final_verify` 无 LLM。
- **手工冒烟（实现授权后）：** 输入 `/delivery` 能启动；不完整只问一问；`PASS*` 进 implementing；`workflowz` 无交叉；普通 `/goal complete` 仍要人；三次 `NEEDS_REDESIGN` 不 `blocked`；杀进程 hydrate 仍为 devflow。
- **根因前提核对：** slash 注册覆盖「写了 coordinator 没入口」；锁空 CAS 覆盖窃锁；PASS* 阻断覆盖 implementation fail-open；原子 INSERT 覆盖丢 kind；其余仍覆盖 start-without-run、bundled reviewer、32-step。

## 7. 关键决策摘要

- Canonical owner = 现有 `WorkflowEngine`。禁止第二引擎。
- 推荐方案 A。方案 B 因不耐久、仍要 `/goal complete` 而拒绝。
- 用户更简洁：是。用户更灵活：否。实现更简单：仅 overlay。
- 用户入口 `/delivery`：**`SlashCommandSpec` 注册在 `builtin-modes.ts`**；编排在 `modes/delivery.ts`；内部 `workflow op=run pipeline=devflow`。保留 `workflow` 工具。不复用 `workflowz`。
- Grilling = coordinator 暂停 + 同行 `overlay_sidecar_json`。不新增 Status。`blocked` 不作 grilling。
- Flash = `pipeline_auditor` oneshot，不是 Role、不是 Gate。
- 建行一次 INSERT 写 `pipeline_kind` + 初始 sidecar。NULL kind = legacy。
- 四值：`parseGateResultArtifact(raw, expected)` → 盖章 persist → adapter → 引擎派生。`replan_exempt` 不物化 `changes_requested`。`NEEDS_REVISION` ≥1 finding。`PASS*` 不得带 open P0/P1/blocking；不自动降级。
- Review：`subagent-sol` 默认；author 非 grok 可用 grok；`shadowReview: "code"`；禁止 grok 审 grok。
- `replanFromRedesign`：现网边 `plan_review → planning`；不递增 `planRejectionCount`；CAS `WHERE` **含** `runner_owner IS NULL`；`SET` 含 `runner_owner=NULL`；他锁 `runner_lock_held` 零写入；commit 后不 `releaseRunner`；成功态幂等且不碰锁；只在 runLoop 已释放后由 coordinator 调用。
- `grill.answers` append-only，进 planner；预阶段答案在 INSERT copy-on-create。
- 规划完整性：仅 devflow；失败留在 `planning`；retry=2 再 `awaiting_grill`。
- 循环：plan/repair 现网 2/3；grilling 8；规划完整性 2。
- 单次 `run`/`resume` ≤32 steps。不抬 cap。
- Grill-me 是唯一必要人工环。`PASS*` 后自动跑完。普通 goal complete 不变。
- 本修订采纳 F1–F3、GateResult/answers/同行写、r5 原子 INSERT/expectedContext/CAS 清锁、r6 不窃锁 / slash 注册 / PASS* 阻断。
- `implementation_authorization=design-only`。实现必须等 Gate `PASS`/`PASS_WITH_NOTES` 且授权改为 `authorized`。

## 8. Handoff

### 8.1 同会话继续

宿主原生路径：`按 subagent-delegation 触发只读 GPT-5.6-sol / subagent-sol（优先与 grok 异模型；author 为 grok 时不可回退到 grok；reviewer 不可用则 claude-opus-5-thinking-high，再主 agent 同模型，并记录 review_fallback）。`

### 8.2 新会话恢复 prompt

```text
请读取完整设计输入集合（默认仅 docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md；若任务以多个结构化文档为设计输入，必须列全路径），生成按 normalized path 排序的 path + SHA-256 `Reviewed Inputs` manifest，并计算 `reviewed_revision`；pre-review handoff 不伪造 digest。设计元数据：design_author=grok；implementation_authorization=design-only；authorization_source=用户请求完整设计方案 + parent-locked facts brief local://delivery-pipeline-facts.md + local://revision-brief.md + local://revision-brief-sol.md + local://revision-brief-sol-r5.md + local://revision-brief-sol-r6.md（CAS runner_owner IS NULL、builtin-modes.ts 注册 /delivery、PASS* 不得带 open P0/P1/blocking）。
使用起草前选定的只读 GPT-5.6-sol / subagent-sol 执行独立 Design Review（默认 GPT-5.6-sol / subagent-sol；优先与全部内容作者异模型；author 为 grok 时不可回退到 grok；reviewer 不可用则 claude-opus-5-thinking-high，再主 agent 同模型，并记录 review_fallback）；将完整 review artifact 持久化到 docs/superpowers/plans/2026-08-30-devflow-autopilot-pipeline-subagent-review.md。按宿主记录 review_mode=host-native、author/reviewer native agent_id、model、verdict、授权来源与证据。
若文档包含根因分析，请一并核对根因判断、证据与设计方案是否一致。重点核对：/delivery 是否作为 SlashCommandSpec 注册在 builtin-modes.ts 且 handle 走到 modes/delivery.ts → op=run pipeline=devflow；createWorkflow INSERT 是否同时写入 pipeline_kind 与含预阶段 grill.answers 的 overlay_sidecar_json；parseGateResultArtifact(raw, expected) 是否绑定 subject/id/identity；PASS/PASS_WITH_NOTES 在 persist 前是否因 open P0/P1/blocking fail-closed 且不降级为 NEEDS_REVISION（plan 与 implementation 皆然）；replanFromRedesign 前置与 CAS WHERE 是否要求 runner_owner IS NULL、他锁 runner_lock_held 零写入、成功路径恰好一次 UPDATE 含 runner_owner=NULL 且 commit 后不 releaseRunner、成功态幂等不碰锁；规划完整性失败是否留在 planning；grill.answers 是否进入下一次 planner 输入；op=run 是否写明单次 ≤32 stage steps。
评审结论必须为 PASS / PASS_WITH_NOTES / NEEDS_REVISION / NEEDS_REDESIGN 四选一，并附可复查证据；禁止作者自审。
NEEDS_REVISION 时回到当前设计文档修订；NEEDS_REDESIGN 时回到 design-brainstorm 重做方案；正文变更后均须重新执行 Gate，且在通过前不得实现。
PASS/PASS_WITH_NOTES 后，current Inputs manifest 等于 reviewed manifest 或存在覆盖全部输入的有效 Gate Continuity Note，且 implementation_authorization=authorized，才继续 design-implement；design-only 必须停止。
Review 后输入变化由未参与 author/reviewer/正文修改/implementation 的主协调者按 handoff 规则分类；非实质变化持久化覆盖完整 manifest 的 Gate Continuity Note，实质、不确定、遗漏输入或角色未分离时重跑 Gate。
```
