# Design Review Gate — DevFlow Autopilot Pipeline (Round 2)

## Header

- **Design**: `docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md`（SHA-256 `c12991e95272c5134ee9deb8ff38b59ca7b8e088a4442d9d456d97e2ed5fd386` — 实测 `shasum -a 256` 一致）
- **reviewed_revision**: `c713622a060f4122956e13b701a41a395f8713c35f1cb9cebd2db30e62e896e5`（来自 brief）
- **review_mode**: host-native
- **author**: GrokDesignAuthor / gateway/grok-4.6
- **reviewer**: flash-reviewer / gateway/deepseek-v4-flash:max（shadowReview: code）
- **review_fallback**: flash-reviewer —— planned subagent-sol（gateway/gpt-5.6-sol）auth_unavailable、claude-opus-5-thinking-high（gateway/claude-opus-5）unknown provider（与 round-1 相同回退；author 为 grok，禁止 grok 审 grok）
- **implementation_authorization**: design-only（设计头部 L8-11 自述；实现必须等 Gate PASS/PASS_WITH_NOTES 且授权改为 authorized，L334）
- **Shadow evidence**: architecture-review / grounded-review / correctness-review / completion-review 全部 timeout（fail-open，不计为通过；grounded/completion 由本评审自行全量覆盖）
- 本评审只读，未修改任何文件。

## 总体结论

**PASS_WITH_NOTES**

Round-1 的 F1/F2/F3 已作为**可落地机制**落在文件变更清单与单测上，不再是散文承诺：F1 有显式引擎方法 `replanFromRedesign`（§5.3，engine.ts L204-210 + §6 L305-306）；F2 有引擎 planning 成功路径上的完整性闸门与 in-stage retry 及 `maxPlanningCompletenessRetries`（§5.2 L172-176、§5.3 L211、§6 L307-308）；F3 有 `op=run` 的 32 步/次语义、`maxStepsReached` 返回、coordinator 再 `resume`、明确不抬 cap 不套第二内循环（§5.2 L171、§5.3 L197-202、§5.4 L269、§6 L311）。全部 repo 事实引用经逐一对照源码属实；「不造第二引擎 / 不加 Role/Status / Flash 不是 Gate / 普通 goal 不变 / /delivery 与 workflowz 分离 / auditor fail-closed / grok 不审 grok / design-only」全部成立。

## F1 — NEEDS_REDESIGN 经 replanFromRedesign 豁免 planRejectionCount（已落地）

**机制（§5.3 L204-210）**：engine.ts 新增 public `replanFromRedesign(workflowId)`，前置断言 `pipelineKind==="devflow"`、当前 status 为非终态 `plan_review`、sidecar `phase==="grilling"` 且 `reason==="needs_redesign"`；否则 `WorkflowPolicyError` 且状态不变（L205）。显式禁令：不调 `getNextStage("plan_review","changes_requested")`、不走 review handler 递增分支、不调 `#setPlanReviewAwaitingHuman`（L206）；用已有转移原语 `#completeTo` 走合法边 `plan_review → planning`、reason `plan_review:needs_redesign`（L207）；`planRejectionCount` 与 `#planCycles` 读-写同一值（L208）；清 sidecar、释放 runner 锁（L209）；不执行 planner（L210）。

**源码核对**：
- `transitions.ts:6`：`plan_review: ["implementing", "planning", "blocked", "failed", "cancelled"]` —— 目标边合法存在 ✓
- `engine.ts:1597-1598`：`review.decision === "changes_requested" ? control.planRejectionCount + 1 : control.planRejectionCount` —— 计数只在 `changes_requested` 递增；绕过该分支即不递增 ✓
- `engine.ts:1636-1647`：`maxCyclesHit` → `#setPlanReviewAwaitingHuman` → `return`；`engine.ts:3591-3606`：该方法把顶层写成终态 `blocked`（`#completeTo(..., "blocked", ...)`）✓
- `engine.ts:1399/3606`：`#completeTo` 是真实私有转移原语，replanFromRedesign 可复用 ✓
- `#planCycles` 私有字段存在（`engine.ts:1644` 赋值）✓
- `pipelineKind` / `replanFromRedesign` 现网 grep **无匹配** → 确为新方法，无撞名 ✓

**测试（§6 L305-306）**：replanFromRedesign 单测断言 从 `plan_review` 转 `planning`、reason 固定、两计数不变、不调 `#setPlanReviewAwaitingHuman`、**N=3 次（>默认 `maxPlanCycles=2`）后仍非终态且可 `resume`**；前置失败（legacy kind / 错 status / 错 sidecar reason）抛 policy error 且不转移。`NEEDS_REVISION` 连续 `replan_counted` 消耗 `maxPlanCycles`，到顶 `blocked`、`resume` 抛 `cannot_resume_terminal`（对照 `engine.ts:800-801/808-809` 实测属实）。「REDESIGN 到顶不 block、REVISION 到顶 block」双路径测试齐备（L263）。

## F2 — 规划完整性 oneshot 在 planning→plan_review 之前（已落地）

**机制（§5.2 L172-176 + §5.3 L211）**：仅 `pipelineKind==="devflow"`，合法 PlanArtifact **之后、`getNextStage("planning", …)` 之前**插入 Flash completeness oneshot；`complete=false` → status **保持 `planning`**，不转移、不 `getNextStage`、不写成 `changes_requested`（不递增 `planRejectionCount`）；overlay `planningCompletenessRetries += 1`，上限 `maxPlanningCompletenessRetries=2`（default-config.ts 新配置块，L220-225）；未到上限同一 status 再跑 planner（允许新 attemptId，**不新增 `planning → planning` 边，因为根本不转移** —— 与 `transitions.ts:5` 实测一致：`planning: ["plan_review","blocked","failed","cancelled"]`）；到上限 → sidecar `phase=grilling`、`reason=incomplete_plan`（`awaiting_grill`，**非 `blocked`**）。`complete=true` → 现网 `planning → plan_review`。legacy 行跳过（L176、L270）。

**源码核对**：
- `engine.ts:1398-1399`：`const next = getNextStage("planning", "approved"); await this.#completeTo(..., "plan ready", ...)` —— 设计中「合法 PlanArtifact 后、getNextStage 前」的插入点精确存在 ✓
- `transitions.ts:5`（planning 无自环）+ `engine.ts:1597-1598`（review 决策才会递增）→ 「不进 review 就不耗 maxPlanCycles」成立 ✓
- `schemas.ts` 新增 `CompletenessAuditorArtifact`（L232，字段 complete/missing/next/stage/schemaVersion；解析失败 fail-closed）—— 现网无此 schema，为新产物 ✓

**测试（§6 L307-308）**：devflow + 合法 PlanArtifact + auditor `complete=false` → status 仍 `planning`、transitions 中无 `planning → plan_review`、`planningCompletenessRetries` 递增、到 cap `awaitingGrill` 且非 `blocked`；`complete=true` 才出现 `plan_review`；legacy 不跑该闸门；非法 JSON/缺字段 fail-closed；`complete:true` 不能写成引擎 `approved`。

## F3 — 单次 run/resume ≤32 stage steps（已落地）

**机制（§5.2 L171、§5.3 L197-202、§5.4 L269）**：`op=run` = `start` + 立即 `#runLoop`；循环在 终态 / `awaiting_grill` / policy block / `steps===32` 任一条件结束（L198，且明令文档不得写成无界「直到终态」）；返回 `status` + `workflowId` + `stepsExecuted` + `maxStepsReached` + `awaitingGrill` + sidecar reason（L202）；`maxStepsReached=true` 且非终态 → **coordinator 自动再调现有 `resume`，不问用户**，不抬 cap、不在引擎内开第二轮循环（L171、L212、L227）。

**源码核对**：
- `engine.ts:880-881`：`const maxSteps = singleStep ? 1 : 32;` ✓；`engine.ts:887`：`while (steps < maxSteps)` ✓
- `engine.ts:1056-1076`：步数耗尽/单步时以**非终态** `finalState` 返回（不报错）✓；`engine.ts:1049-1052`：`finally { if (claimed) releaseRunner(...) }` —— 与设计「awaiting_grill 释放 runner_owner 返回」的模式一致 ✓
- `engine.ts:859-862`：内部 `run()` 存在但工具未暴露（`workflow-tool.ts:13` op 闭集 `start|status|resume|cancel`）✓

**测试（§6 L311）**：fake 把 step 打满 32 → `maxStepsReached=true`、非终态、**未**在引擎内自动开第二轮 `#runLoop`。

## 复核清单（brief 要求的 re-check）

| 项 | 结论 | 证据 |
|---|---|---|
| 无第二引擎 | ✓ 明令禁止 | §1.4 L50、§4.3 L146、§7 L320；B 方案因不耐久/仍要人点 complete 被拒（L134-135） |
| 不加 WorkflowRole/Status | ✓ | §1.4 L55-56、§5.3 L214-216/231；`types.ts:384`/`availability-candidates.ts:5-12`/`types.ts:423-427` 闭集实测 ✓；单测断言 AVAILABILITY_ROLE_ORDER 长度成员不变（L309） |
| Flash 不是 Gate | ✓ | L31、§1.4 L53、§5.5 L291、§7 L325；Flash 只做 `pipeline_auditor` oneshot（仿 `evaluator.ts:287` `oneshotKind: "goal_evaluator"`，实测 ✓） |
| 普通 `/goal complete` 不变 | ✓ | L35、L52、L188-189、L251、L295；`host-gate.ts:195-219`、`evaluateGoalHostGate` 通过后仍要求用户确认（L210 实测）✓ |
| `/delivery` vs `workflowz` | ✓ | L213（`delivery.ts` 独立模块，禁止写 `magic-keywords.ts`/`workflow.ts`）、L296-297；全仓 grep `delivery` 无 slash 命令占用（仅注释里的英文单词）；`modes/workflow.ts`+`workflow-notice.md` 存在（product A）✓ |
| auditor fail-closed | ✓ | L232、L258-259（解析失败重试 1 次→暂停给人看 raw/error，不标 complete、不 skip sol/grok review；规划阶段按 `incomplete_plan` 暂停不进 plan_review） |
| grok 不审 grok | ✓ | L160、L177、L216、L247、L262、L310、L326；`~/.omp/agent/agents/subagent-sol.md`（gpt-5.6-sol, xhigh）与 `subagent-grok.md`（grok-4.6, xhigh）实测存在 |
| design-only | ✓ | L10、§1.4 L61、§7 L334 |
| PASS_WITH_NODE 笔误 | ✓ | L78、L246 |
| gate-adapter 纯函数不伪造 decision | ✓ | L177、L234-246（四值×subject 映射表；`NEEDS_REDESIGN`+plan→`replan_exempt`，+implementation→`block`）；`schemas.ts:237` decision 闭集实测 ✓ |

## Notes（不阻塞）

- **N1（行号漂移 ±2）**：设计 cite `engine.ts:861-863`（run() 实际 L859-862）、`506-509`（start 注释实际 L505-508）、`types.ts:28-41`（status 实到 L40）、`transitions.ts:3-16`（实际到 L16 前）——均内容属实、行号微漂，不构成缺陷；建议实现时以函数名为准。
- **N2（F2 重跑 attempt 记账细节）**：设计允许「同一 status 新 attemptId 再跑 planner」，但未写明被打断的 PlanArtifact 是否落库/如何被后续 attempt 覆盖。引擎 planning case 在 `getNextStage` 前被打断即不转移，`#finishOpenAttempt` 不会被调用，行为自洽；建议实现时把 rejected artifact 标记 `superseded` 或仅存 sidecar，避免审计歧义。
- **N3（sidecar 存储双选项）**：L233 「同一行 JSON 列或同库旁路表」二选一未定；建议优先同一行 JSON 列（与 workflow 行原子同写），旁路表作 fallback，并在实现里程碑固定其一。
- **N4（auditor 不可用路径）**：L259 记 `auditor_unavailable` 后继续质量路径是**记录式降级**（质量权威仍是 sol/grok），不构成 fail-open 覆盖；与 round-1 N1 一致，建议把该标志暴露在终态报告/artifact 元数据保证可审计。
- **N5（32 步边界的 UX 佐证）**：L289 缓解与 L311 测试已覆盖 `maxStepsReached`；round-1 残余风险「超长 pipeline 静默停住」已被返回值字段 + coordinator 自动再 resume 关闭。

## 残余风险

- subagent-sol/grok 为 user-level agent（`~/.omp/agent/agents/`），可靠性依赖宿主；不可用路径按 N3/N4 fail-closed，但「非 degradedMode 下 block」的现网 agent-spawn 失败分支未在本评审深挖（与 round-1 相同，非阻塞）。
- `replanFromRedesign` 与并发 runner 的锁约定（L209「与 resume 一致」）需实现时对照 `engine.ts:897-905` claimRunner 时序验证，避免双 runner。
- 本评审 four shadow lenses 全部 timeout（fail-open）；grounded 维度已由本评审逐条对照源码覆盖（上方全部引用为实测），completion 维度（测试/文档/changelog/kill-switch）设计已列全（L252、§6）。

*评审结论：PASS_WITH_NOTES。F1/F2/F3 均已从散文承诺落为带文件与测试的机制；无 NEEDS_REVISION 项。实现需等 authorized 授权。*

## Gate Continuity Notes

- Coordinator: Main（未担任本设计 author / reviewer / 正文修改者 / implementer；仅机械落盘评审与本 Note）
- Model: 本会话协调者（不改变 verdict / 授权）
- Verdict unchanged: PASS_WITH_NOTES
- implementation_authorization unchanged: design-only
- Reviewed Inputs manifest (round-2 Gate):
  - `docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md` SHA-256 `c12991e95272c5134ee9deb8ff38b59ca7b8e088a4442d9d456d97e2ed5fd386`
- Current Inputs manifest (this Note): **identical** to reviewed manifest. Design body bytes were not edited after round-2 Gate.
- `reviewed_revision`: `c713622a060f4122956e13b701a41a395f8713c35f1cb9cebd2db30e62e896e5`
- Classification of round-2 notes (non-material; no design-body rewrite):
  - N1 行号 ±2：实现以函数名为准。
  - N2 planning 被拒 PlanArtifact：实现时标记 `superseded` 或只进 sidecar，不改目标/范围/验收。
  - N3 sidecar：实现优先同一 SQLite 行 JSON 列，与 workflow 行原子同写；不新增第二 store。
  - N4 `auditor_unavailable`：实现暴露在终态报告/artifact 元数据。
  - N5 32 步 UX：已在设计中，无需改文。
- Unchanged: overlay owner = WorkflowEngine；无新 WorkflowStatus/Role；Flash 非 Gate；`replanFromRedesign` 豁免计数；规划完整性留在 `planning`；单次 run ≤32 steps；普通 `/goal complete`；design-only。
- This Note covers the full Inputs set (single design file). It does not modify verdict or authorize implementation.
- Later user request to re-run Gate via `subagent-sol`, then invoked `subagent-grok`: **no new four-value verdict**. `subagent-grok` rejected (author is grok). `subagent-sol` (`SolDesignGate-2`, `SolDesignGateR3`) `auth_unavailable` (providers=codex, model=gpt-5.6-sol). `claude-opus-5-thinking-high` (`OpusDesignGateR2`) `400 unknown provider for model claude-opus-5`. Attempt record: `docs/superpowers/plans/2026-08-30-devflow-autopilot-pipeline-sol-rereview-attempt.md`. Design bytes unchanged; verdict still PASS_WITH_NOTES; design-only unchanged.
