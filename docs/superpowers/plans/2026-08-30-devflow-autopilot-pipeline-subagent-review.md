# Design Review Gate — DevFlow Autopilot Pipeline

## Header

- **Design**: `docs/superpowers/specs/2026-08-30-devflow-autopilot-pipeline-design.md`（SHA-256 `e6e3dc764204a741a2c74b8f88175aa81eacb34079a044909e6b4b46cd9b0d0a`）
- **reviewed_revision**: `9c4d08a834e3e62113fd189fc26f8d70e087c9f618bb0eba8bb61bcc04bb4670`
- **review_mode**: host-native
- **author**: GrokDesignAuthor / gateway/grok-4.6
- **reviewer**: flash-reviewer / gateway/deepseek-v4-flash:max（shadowReview: code）
- **review_fallback**: planned subagent-sol（gateway/gpt-5.6-sol）auth_unavailable（providers=codex）；claude-opus-5-thinking-high（gateway/claude-opus-5）→400 unknown provider；本评审由 flash-reviewer 执行
- **implementation_authorization**: design-only（不得授权编码）
- **Shadow evidence**: architecture-review completed_no_finding；correctness-review completed_no_finding；grounded-review timeout；completion-review timeout（fail-open，不计为通过）

## 总体结论

**NEEDS_REVISION**

方案架构方向正确（overlay 现有 `WorkflowEngine`、不造第二引擎、sidecar 不扩 `WorkflowStatus`/`WorkflowRole`、auditor fail-closed、agent 映射分叉不破坏 legacy），绝大部分 repo 事实引用经核对属实。但核心行为「`NEEDS_REDESIGN` / 规划不完整不计入 `maxPlanCycles`、不推进 review 回到 planning」与引擎现网机制矛盾：引擎的 plan 回环唯一路径是 review 决策 `changes_requested`，且 `planRejectionCount` 在该决策时自动递增（`engine.ts:1597-1598`），达 `maxPlanCycles`（默认 2）即 `setPlanReviewAwaitingHuman` → **终态 `blocked` 不可 resume**。设计声明的缓解「重置该轮 planRejectionCount」（设计文 §5.5 风险行）在文件变更清单中无任何落地机制；其自列测试「NEEDS_REDESIGN 不进 `blocked`」在设计描述的映射下无法通过。需修订后再过 Gate。

## Findings（按严重度）

### F1（HIGH）— NEEDS_REDESIGN 不计 plan cycles 无实现机制，且与引擎自动递增冲突

**证据**
- 设计 Gate↔引擎映射表：`NEEDS_REDESIGN` →「不直接当新 status；暂停后走现有 `changes_requested` 回 `planning`」（设计 §5.4 映射表，`Z8` 行）；风险缓解：「NEEDS_REDESIGN 被算进 `maxPlanCycles` 导致刚问清需求就被 block……重置该轮 `planRejectionCount`；只有 `NEEDS_REVISION` 计 cycle」（设计 §5.5，行 I246-247）。
- 引擎实测：`review.decision === "changes_requested"` 时 `nextRejectionCount = control.planRejectionCount + 1`（`packages/coding-agent/src/workflow/engine.ts:1597-1598`）；`maxCyclesHit = review.decision === "changes_requested" && nextRejectionCount >= this.#config.maxPlanCycles`（`engine.ts:1636-1637`）；命中即 `setPlanReviewAwaitingHuman`（`engine.ts:1643-1646`），该方法「transition top-level to **terminal blocked**」（`engine.ts:3592-3593`），而 `blocked ∈ TERMINAL`（`engine.ts:164`）、终态 resume 抛 `cannot_resume_terminal`（`engine.ts:800-801, 808-809`）。
- 设计文件变更清单（`types.ts` pipelineKind、`schemas.ts` CompletenessAuditorArtifact、`gate-adapter.ts` 纯函数、`runtime-adapter.ts` agent 名分叉、`default-config.ts` 配置块、`engine.ts` 仅 op=run/awaiting_grill/gate-adapter 调用、`sqlite-store.ts` sidecar）中**没有**任何 `planRejectionCount` 重置或「第四值决策」的机制。`gate-adapter` 被定义为纯函数（设计 §5.3「数据结构」行），`schemas.ts:124/237` review 决策闭集为 `approved | changes_requested | blocked`，不存在「不计数」的决策。
- 设计自列测试「NEEDS_REDESIGN 不进 `blocked`」（设计 §5.3 测试清单行、§6 单测行）在默认 `maxPlanCycles=2`（`default-config.ts:710`）下：第三次 NEEDS_REDESIGN 触发 `changes_requested` → `planRejectionCount=2` → `maxCyclesHit` → 终态 `blocked`。**测试与映射自相矛盾**。

**要求**：修订必须给出可落地机制之一：
1. `engine.ts` 增加显式 reset/鉴定路径（如 overlay 专用 `changes_requested` 计数豁免或 redesign 专用决策），并列入变更清单与测试；或
2. 明示 NEEDS_REDESIGN 计入 `maxPlanCycles`（放弃「不计入」承诺，改写成功标准与测试）；
禁止以「重置该轮 planRejectionCount」这类无载体声明带过。

### F2（MEDIUM）— 「规划不完整 → 不推进 review」在引擎无回环缝隙

**证据**
- 设计 §5.2 步骤 4：planning 完成后 Flash oneshot 检查，不完整则「记 missing，不推进 review（算一次规划缺陷，走现有 plan 循环而不是再发明计数器）」；§5.4 同类：auditor 判 incomplete 时不标 complete。
- 引擎 stage 图：`planning → plan_review` 是唯一出边（`packages/coding-agent/src/workflow/transitions.ts:5`）；回到 planning 的唯一路径是 `plan_review` 侧 `changes_requested`（`transitions.ts:6`，`engine.ts:1597-1598` 递增 rejection）。没有「planning 内自我回环」或「拒绝 plan artifact 不经 review 回到 planning」的过渡。
- 因此「不推进 review」要么做不到（引擎必然进入 plan_review 并产出 review artifact），要么需要一条未在变更清单列出的新引擎回环缝隙。现有 `awaiting_grill` 只是暂停点（释放 runner 后等人），不提供阶段回退。

**要求**：明确 planning 不完整时引擎如何回到 planning（过渡、决策载体、计数归属），或承认需经 review 决策（与 F1 合并处理），并将对应引擎改动列入文件清单与单测。

### F3（LOW）— `op=run`「直到终态」忽略 runLoop 32 步上限

**证据**
- 设计 §5.2 步骤 3 / §5.3：`op=run` 立即 `run`/`resume` 直到「终态、policy block、或 overlay 暂停条件 `awaiting_grill`」。
- 引擎 `#runLoop`：`const maxSteps = singleStep ? 1 : 32`，`while (steps < maxSteps)`（`engine.ts:880-887`）；步数耗尽时**不报错**、以非终态 `finalState` 返回（`engine.ts:1056, 1065-1075`）。默认 cycles（`default-config.ts:709-710`）下 devflow 最坏约 15-20 步，通常够用，但设计未声明该上限；一旦未来放宽 cycles 或叠加 grilling 回环，`op=run` 会在无人知晓处中途停住。设计自述「resume 无 singleStep 时循环到终态或 block」（设计 §2 背景）与引擎实际（32 步上限）不符。

**要求**：`op=run` 语义应写明 32 步/次上限并给出（a）到达上限后的行为（报告非终态 + 提示 resume，或工具层循环 `resume` 直至终态），或（b）在上限内完成保证的论证，并补一条对应单测。

## 核对通过的关键事实（grounded）

以下设计引用经逐一对照源码属实：
- `workflow-tool.ts:13` op 闭集 `start | status | resume | cancel`；approval tier 仅 `status` 为 read（`workflow-tool.ts:39-41`），`run` 落 write 与设计一致。
- `engine.ts:506-507` start 注释「Does not execute stages」；`engine.run()` 存在于 `engine.ts:860-862` 但工具未暴露。
- stage 图 `types.ts:28-40`、`transitions.ts:3-23`：`plan_review → planning`（changes_requested）、`implementation_verify → repairing`、`code_review → repairing/final_verify` 均成立，支撑设计六步流向。
- `engine.ts:164` TERMINAL、`engine.ts:800-809` cannot_resume_terminal → 支撑「grilling 不能做成 blocked」。
- `engine.ts:2482` 写隔离 `isolation: { merge: "patch", apply: false }` → 支撑「写阶段 isolation 保留」。
- review 决策闭集 `schemas.ts:124`（PlanReview）、`schemas.ts:237`（V2）；`WorkflowRole` 闭集 `types.ts:384`；`QualityRouteSnapshotV1.routes` 为 `Record<WorkflowRole, readonly string[]>`（`types.ts:423-427`）；`AVAILABILITY_ROLE_ORDER`（`availability-candidates.ts:5-12`）→ 支撑「不为 auditor 加 role」。
- `WORKFLOW_ROLE_TO_AGENT`：planner→designer、plan_reviewer/code_reviewer/plan_arbitrator→reviewer、implementer/repair→task（`runtime-adapter.ts:126-133`），且 `prompts/agents/reviewer.md` 是 bundled agent（`task/agents.ts` 嵌入）→ 支撑「legacy 保持 bundled reviewer」。
- `default-config.ts:289-293` `deepseek_implementer`（Flash 默认 implementer）；`default-config.ts:709-710` maxRepairCycles=3 / maxPlanCycles=2。
- `host-gate.ts:195-219` `evaluateGoalHostGate`，通过后仍要求「Ask the user to confirm with /goal complete」（`host-gate.ts:210`）；`settings-schema.ts:4913-4914` goal complete 仅提名 → 支撑「普通 goal 语义不变」。
- `interactive-mode.ts:1628-1629, 1679` 两个 800ms goal-continuation 定时器 → 支撑「800ms hidden goal-continuation」。
- 原生 agent 定义存在：`~/.omp/agent/agents/subagent-sol.md`（gateway/gpt-5.6-sol, xhigh）、`subagent-grok.md`（gateway/grok-4.6, xhigh）、`claude-opus-5-thinking-high.md` → 支撑「映射到 subagent-sol/grok、grok 不可审 grok」。
- Dev Flow 参考文件 `~/.claude/skills/dev-flow-common/references/dev-flow-overview.md` 存在，Gate 四值/PASS* 待用户确认/禁止 grok 审 grok 条款一致。
- `workflowz` 两文件（`modes/workflow.ts`、`prompts/system/workflow-notice.md`）与 `docs/workflow.md` 均存在；全仓 grep 无已占用 `/delivery` slash 命令 → 入口无碰撞。

## Notes

- **N1（auditor 供应商/超时路径，无反转）**：auditor 解析失败 fail-closed（重试 1 次 → 暂停给人看 raw/error，不得标 complete、不得跳过 sol/grok review）符合 facts 约束；厂商/超时降级为「记 `auditor_unavailable` 后继续质量路径」是 completeness 维度的记录式降级，质量权威仍是 sol/grok，不构成 fail-open 覆盖。建议实现时把 `auditor_unavailable` 暴露在终态报告/artifact 元数据，保证可审计。
- **N2（PASS_WITH_NODE）**：按 `PASS_WITH_NOTES` 笔误处理，与 facts 一致。
- **N3（grok 审 grok / review_fallback）**：设计（RuntimeAdapter fail-closed → sol；sol 不可用 → 现网独立评审不可用路径，非 degradedMode 则 block，并记录 `review_fallback`）与 Dev Flow 约束一致；本项目评审的 real fallback 亦如此记录于 header。
- **N4（并发/abort）**：`awaiting_grill` 释放 `runner_owner` 后返回非终态，与引擎现有 break 后 `releaseRunner` 模式（`engine.ts:1049-1053`）一致；sidecar 按 sessionId（可空 workflowId）恢复、先查 sidecar 再引擎 resume 的设计正确规避了「grilling 中 resume 重跑 plan_review」。
- **N5（设计简洁性）**：§5 只展开方案 A、方案 B 无文件级细节；非目标明确排除第二引擎/role/status/auto-merge 等未请求能力；推荐方案为满足约束的最浅 overlay。符合简洁性要求。

## 残余风险

- F1/F2 修订后需重跑 Gate（正文变更即重审）；修订必须落在文件变更清单与单测，不能只改文字声明。
- 32 步上限（F3）若不处理，超长 pipeline（自定义 cycles + 多次 redesign 回环）会静默中途停住；至少在文档与 `op=run` 返回信息中明示。
- subagent-sol/grok 为 user-level agent（`~/.omp/agent/agents/`），其可用性依赖宿主环境；不可用路径已按 N3 fail-closed，但需验证「非 degradedMode 下 block」的现网错误码/回退路径确有实现（本评审未深挖 agent-spawn 失败分支）。
- grilling 上限 `maxGrillQuestions=8` 到达后「展示 missing[] 等人补或 cancel」是兜底而非自动完成，需在 UX 文案明确这不是结束态。
- Shadow review 的 grounded/completion 两维超时（fail-open），本评审已按完整文件级核对自行覆盖 grounded 维度（全部量化引用逐一对照源码）；completion 维度（测试/文档/changelog/kill-switch）设计已列，但 F1/F2 所涉测试在当前设计下不可达，属 completion 阻塞项。

*本评审只读，未修改任何文件。*
