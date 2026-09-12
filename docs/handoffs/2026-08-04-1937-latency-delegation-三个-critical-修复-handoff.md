# Handoff：latency-delegation 三个 Critical 修复

创建时间：2026-08-04T19:37:46+08:00
项目根目录：`/Users/sheng/tencent/oh-my-pi`
分支：`workflow`
基线提交（已提交 HEAD）：`37e9b44d8f65225785e1c848282d02d7949b4d94`
前序 handoff（只读审查轮）：`docs/handoffs/2026-08-04-1923-latency-delegation-剩余实现的完整方案与-code-review-handoff.md`

## 中文短 Prompt

```text
从 docs/handoffs/2026-08-04-1937-latency-delegation-三个-critical-修复-handoff.md 继续。目标：修复上一轮只读审查判定的 3 个 Critical（C1 引擎自有 V2 字段被模型伪造并驱动仲裁状态机、C2 planRejectionCount 硬封顶 2 导致 maxPlanCycles>2 时 replan 上限失效、C3 awaiting_human 让工作流永久卡在非终态 plan_review），并为每个修复补真实覆盖的回归测试。第一步：`git rev-parse HEAD` 确认仍为 37e9b44d8 且 `git status -sb -- packages/coding-agent` 显示 21 modified + 2 untracked 未提交实现仍在，然后读本文档 §3 的三个 Critical 证据行号逐一复核。边界：可改 packages/coding-agent 源码与测试；先修 C1/C2/C3 与 F5，F4/F6/F7/F8 视情况；禁止 commit、push、改 git config；不得为让测试变绿而放宽断言或改设计文档去迁就实现；deferred 五项（QualityRouteSnapshotV2 全量、独立 plan-arbitration.ts、人工 receipt UI、五 arm A/B、D §10 SQLite migration）不在本轮范围，需要扩大范围先问用户。回传：每个 Critical 的修法与 diff 位置（文件:行）、新增/修改测试及其能捕获的原缺陷、复跑 §7 全部命令的新鲜 pass/fail、仍未闭合项与剩余风险、是否可 commit（需用户确认）。
```

## 1. 当前目标

- 用户原始请求：上一轮只读审查判定 NEEDS_REVISION 后，用户选择「提供短 prompt，我要在新会话中完成修复」。
- 期望结果：闭合 3 个 Critical（C1/C2/C3），每项配能真实捕获缺陷的回归测试；F5 建议同轮修（与 C3 同属仲裁状态机）。
- 完成标准：三个 Critical 均有代码修复 + 新测试（新测试在修复前应失败）；§7 全部验证命令复跑通过；未闭合项如实列出；不擅自 commit。

## 2. 当前状态

- 状态：只读审查已完成，结论 NEEDS_REVISION（Spec 轴 + Code 轴）。**本会话未改任何代码**，工作区未提交实现与 HEAD 差异保持原样（+1078/−172, 21 files）。
- 已完成：
  - 核对 git status/diff 与前序 handoff 清单一致
  - 双轴并行审查（Spec 轴对照设计 A/D/E；Standards 轴查缺陷）
  - 三项验证复跑通过（见 §7）
  - 三个 Critical 与五个 Important 已定位到行号并交叉验证
- 待完成：
  - 修复 C1、C2、C3（+ 建议 F5）
  - 补真实覆盖的回归测试（替换 F6/F7 的空洞测试）
  - 用户确认后再 commit
- 最重要的下一步：复核 §3 三个 Critical 的证据行号，然后从 C1 开始修。

## 3. 已确认事实（三个 Critical + 五个 Important）

| 事实 | 证据 | 如何复核 |
| --- | --- | --- |
| HEAD 为 `37e9b44d8`，未提交实现仍在 | `git rev-parse HEAD`；`git status`：21 modified + 2 untracked（packages/coding-agent） | `git diff --stat HEAD -- packages/coding-agent` 应为 +1078/−172, 21 files |
| **C1** `triggerReason` 等 4 个「引擎自有」字段对模型开放且被采纳 | `json-schemas.ts:263-269` 把 `triggerReason`/`routeSelectionReceiptRef`/`cleanContextReceiptRef`/`specEvidenceReceiptRef` 列为可写 properties；`plan-review.ts:143-149` 用 `input.X ?? modelArtifact.X`；`engine.ts:1254-1272` 的 `executeReview` **从不传 `triggerReason`** | 读三处代码；对比 `schemas.ts:246` 已为 `authorityReceiptRef` 加 refine 拦截 |
| **C1** 被伪造的 `triggerReason` 直接驱动仲裁 | `engine.ts:1334` 读 `review.triggerReason` → `engine.ts:1374-1377` `triggerArbitration` | 读代码 |
| **C1** 引擎传 `null` 时模型值仍胜出 | `engine.ts:1271` 传 `control.routeSelectionReceiptRef`（初值 null），`??` 对 null 回落；结果被 `engine.ts:1343-1344` 写入 control state 持久化 | 读代码；注意 `??` 与 `!== undefined` 语义差异 |
| **C2** rejection 计数硬封顶 2，与可配置 `maxPlanCycles` 冲突 | `engine.ts:1331` `Math.min(2, ...)`；`schemas.ts:269` zod `0|1|2`；`engine.ts:1377` 与 `this.#config.maxPlanCycles` 比较 | 设 `workflow.maxPlanCycles: 3` 后 `2 >= 3` 恒假 |
| **C2** 是本轮引入的回归 | HEAD 版本为无夹取的 `this.#planCycles += 1` + `if (this.#planCycles >= this.#config.maxPlanCycles)` | `git show HEAD:packages/coding-agent/src/workflow/engine.ts \| sed -n '1230,1240p'` |
| **C2** `maxPlanCycles` 无上限校验 | `settings-schema.ts:4451` 仅 `type: "number"`, default 2；`session-config.ts:133-136` `asNumber` 只校验 `Number.isFinite`，无 clamp | 读两处 |
| **C2** 真实 `#planCycles` 被 control state 反向覆盖 | `engine.ts:767-769` 由 durable transitions 重建真实计数，随后 `engine.ts:783` 用 `planRejectionCount`（≤2）覆盖；`engine.ts:1464` 亦写回夹取值 | 读代码 |
| **C3** `#finishOpenAttempt` 完全不改 workflow status | `engine.ts:2747-2757` 只调 `store.completeAttempt`；对比 `#completeTo`（`engine.ts:3089+`）调 `completeAttemptAndTransition` | 读两个方法 |
| **C3** 三个 `awaiting_human` 出口都只走它并 return | `engine.ts:1217-1221`、`engine.ts:1367-1371`、`engine.ts:3083-3086`；异常路径 `engine.ts:926-942` 才有 `if (!TERMINAL.has(...))` → transition blocked | 读代码 |
| **C3** 触发面极大且本轮 diff 无恢复入口 | `engine.ts:1333` `hasMissingAuthority` 只需任意一条 finding `basis === "missing_authority"`；该枚举值对模型开放（`json-schemas.ts:181-183`）；无任何 API 能把 `substate` 从 `awaiting_human` 推回 | grep `awaiting_human` 全部赋值点均在 engine 内部 |
| **C3** V1/V2 行为分裂（回归） | V1 `blocked` 仍走 `getNextStage → blocked` 终态；V2 `blocked` 停在 `plan_review` | 对比 `engine.ts:1359-1372` 与 `engine.ts:1461-1462` |
| **F4** URL 读路径完全未挂 identity | `read.ts:2366-2398` 三个 URL 分支（含 `executeReadUrl`）均无 `attachReadIdentity` | 读代码；`buildReadViewKeyV1` 会 fail-open |
| **F5** 仲裁两段持久化有崩溃窗口 | `engine.ts:1385-1398` 先写 `substate=arbitration`（cycles 仍 0）再写 `cycles=1`；resume 早退在 `engine.ts:1223-1246` | 读代码；两次 `new Date().toISOString()` 可能同毫秒，hydration `updatedAt >=` 比较（`engine.ts:3314-3320`）结果依赖遍历顺序 |
| **F6** 仲裁测试名不副实，仲裁成功路径零覆盖 | `test/latency/plan-review-identity.test.ts:87-118` 名为 arbitrates，却断言 `planReviews).toBe(2)`，mock 第三分支（`planReviews > 2`）永不执行；实际断言「无仲裁员 → `completeTo(blocked)`」短路 | 读测试；`#runPlanArbitration` 在 `resolvePlanArbitrator` 失败时 `return null` |
| **F7** read identity 测试绕过真实消费方 | `test/latency/read-identity-production.test.ts:56-63` 自行调 `buildReadViewKeyV1` 且传 `normalizeReadSelector({})`；真实链路 `agent-session.ts:3200-3206` 传 `selector: ... : rawPath`（完整 path 串） | 读两处；tmpdir 非 git 仓库故 `git:` 分支未覆盖 |
| **F8** once-key 在 cancel-then-timeout 竞态下泄漏 | `task/index.ts:1157-1162` `clearTimeoutMetricsForJob` 在 `settleOnce` 内且有 `if (settled) return` 早退；先 settle 再 record 会跳过清理 | 读代码 |
| 设计 E §6 三 flag 已闭合 | `settings-schema.ts` 三键 default false；`system-prompt.md:178-189` 被 `eagerTasks` gate；模板 `{{#if}}/{{/if}}` 平衡 | `bun test test/system-prompt-delegation.test.ts` |
| MEDIUM bash timeout ledger 已闭合 | `bash.ts` create/poll 两处 `#recordBashAttempt` | `bun test test/latency/bash-attempt-ledger.test.ts` |

## 4. 假设与未知

| 条目 | 类型 | 为什么重要 | 如何解决 |
| --- | --- | --- | --- |
| C3 的正确产品语义：`awaiting_human` 应转终态 `blocked`，还是补可推进的 human handoff API | 未知（需产品决策） | 决定 C3 修法方向；设计 D §7.2 要求 `awaiting_human`，但当前无恢复入口 | 若无法从设计 D §7/§8 判定，**停下问用户**；临时可选「转终态 blocked 且保留 control state 供后续 API」 |
| 无仲裁员时 `completeTo(blocked)`（`engine.ts:1415-1422`）与 C3 的 `awaiting_human` 自相矛盾 | 事实（方向冲突） | 两条路径语义必须统一，否则修完 C3 仍不一致 | 与 C3 一并决策；设计 D §7.2 要求此处也是 `awaiting_human` |
| PlanReview V2 在真实 LLM（非 scriptedRunner）下是否稳定 | 未验证 | 合同可能只在测试 fixture 下成立 | 本轮可不解；如需，做一次真实 provider 冒烟 |
| `readBranchOrWorktreeScope` 每次 read 同步读 `.git` 且优先用 commit SHA 作 scope | 事实，意图未知 | 每次 commit 后 dedupe 全量失效，与延迟优化目标相反 | 确认是否有意；`utils/git.ts:2335` 为纯 fs 同步读、无 subprocess |
| 设计 D 全文逐条条款映射 | 部分未复核 | 上一轮我未读设计 D/A/E 全文，Spec 轴缺口清单来自 subagent | 修 C1/C3 前读 `2026-08-04-plan-review-pipeline-design.md` §6/§7.2/§8 原文 |

## 5. 相关文件与产物

| 路径或 URL | 用途 | 备注 |
| --- | --- | --- |
| `docs/superpowers/specs/2026-08-04-plan-review-pipeline-design.md` | 设计 D（权威） | 重点 §6 仲裁触发、§7.2 状态转移表、§8 fail-closed |
| `docs/superpowers/specs/2026-08-03-latency-optimization-plan-design.md` | 设计 A（权威） | §4.1.4 ReadViewKey（F4 相关） |
| `docs/superpowers/specs/2026-08-04-proactive-subagent-delegation-design.md` | 设计 E（权威） | §6，本轮已闭合，勿回退 |
| `packages/coding-agent/src/workflow/engine.ts` | C1/C2/C3/F5 主战场 | 未提交改动 +379 行 |
| `packages/coding-agent/src/workflow/stages/plan-review.ts` | C1 字段合并逻辑 | `input.X ?? modelArtifact.X` |
| `packages/coding-agent/src/workflow/json-schemas.ts` | C1 模型可写字段来源 | `PlanReviewArtifactV2JsonSchema` |
| `packages/coding-agent/src/workflow/schemas.ts` | C2 zod `0|1|2`；C1 已有 refine 范例（:246） | |
| `packages/coding-agent/src/tools/read.ts` | F4/F7 | `attachReadIdentity` 在 :776-810 |
| `packages/coding-agent/test/latency/plan-review-identity.test.ts` | F6 待重写 | |
| `packages/coding-agent/test/latency/read-identity-production.test.ts` | F7 待改走真实链路 | untracked |
| 前序审查轮 handoff | 上下文来源 | `docs/handoffs/2026-08-04-1923-...-code-review-handoff.md` |

## 6. 本会话改动

| 路径 | 改动摘要 | 原因 |
| --- | --- | --- |
| `docs/handoffs/2026-08-04-1937-latency-delegation-三个-critical-修复-handoff.md` | 新增本文档 | 交接修复任务 |

**本会话为只读审查，未修改任何源码或测试。** 工作区的 21 modified + 2 untracked 均为上一轮实现所留。

## 7. 命令与验证

| 命令 | 结果 | 证据摘要 |
| --- | --- | --- |
| `git rev-parse HEAD` | 通过 | `37e9b44d8f65225785e1c848282d02d7949b4d94` |
| `git diff --stat HEAD -- packages/coding-agent` | 通过 | +1078/−172, 21 files（与前序 handoff 一致） |
| `bun test test/latency test/task/task-spawn.test.ts test/system-prompt-delegation.test.ts test/workflow/stages/plan-review.test.ts test/settings-manager.test.ts` | 通过 | 133 pass / 0 fail（本会话复跑） |
| `bun test test/system-prompt-delegation.test.ts test/settings-manager.test.ts test/workflow/engine-budget-stop.test.ts test/workflow/engine-resume.test.ts test/workflow/engine-work-packages.test.ts test/latency/bash-attempt-ledger.test.ts` | 通过 | 121 pass / 0 fail（本会话复跑） |
| `bun run check:types`（packages/coding-agent） | 通过 | tsgo noEmit clean |
| 全量 coding-agent 测试 / CI | 未运行 | 修复后建议扩大 |
| commit / push | 未运行 | 需用户确认 |

**关键提醒**：上述绿灯覆盖不到三个 Critical——C2 只在 `maxPlanCycles > 2` 时暴露（测试用 default 2），C1 需要构造模型自报 `triggerReason` 的 fixture，C3 需要断言 workflow status 而非 attempt status。修复前应先写出**能失败**的测试。

## 8. 决策与取舍

| 决策 | 考虑过的替代方案 | 原因 |
| --- | --- | --- |
| 上一轮只做只读审查，不改代码 | 边审边修 | 用户明确要求只读；三个 Critical 需产品决策 |
| C3 升级为 Critical（Standards 轴原定 Important） | 保留 Important | 触发面是「任意一条 missing_authority finding」，且无恢复入口、非终态、与 V1 行为分裂 |
| 驳回 Spec 轴关于 prompt 模板的误报 | 采纳 | 核对 HEAD 原文：那两行 bullets 在 HEAD 就已在 `eagerTasks` 之外，本轮未改其条件 |
| 修正 Spec 轴对全零 hash 的定级 | 采纳其 Critical | `#planRequirementsSnapshot` 总返回非空 sha，全零仅在直接调 stage（测试）时生效，属测试污染 |

## 9. 风险与安全边界

- 允许：改 `packages/coding-agent` 源码与测试；跑 `bun test`、`bun run check:types`；读设计文档；`git diff`/`git show`；派只读 subagent
- 禁止：commit、push、force push、改 git config、部署；为让测试变绿而放宽断言；改设计文档去迁就实现
- 需要用户确认：C3 的产品语义选择（终态 blocked vs human handoff API）；把 deferred 五项纳入本轮；扩大到 `packages/coding-agent` 之外；任何 commit
- 敏感信息处理：不写入 secret/token/客户数据；注意 `#persistArtifact` 已有 `redactSecretsInText`，修复时勿绕过

## 10. 下一 Agent 指引

1. 第一步：`git rev-parse HEAD`（应为 `37e9b44d8`）+ `git status -sb -- packages/coding-agent` + `git diff --stat HEAD -- packages/coding-agent`（应为 +1078/−172, 21 files），确认未提交实现仍在；然后按 §3 表格逐一复核三个 Critical 的证据行号（行号可能因你的编辑而漂移，先读再改）。
2. 然后按此顺序修：
   - **C1**：让引擎字段真正 engine-owned。建议：`plan-review.ts` 改为**无条件覆盖**（不用 `??` 回落到 `modelArtifact`），或从 `PlanReviewArtifactV2JsonSchema` 移除这 4 个字段使模型无法产出；并按 `schemas.ts:246` 的范例为 `triggerReason`/`cleanContextReceiptRef`/`specEvidenceReceiptRef` 加 zod refine 拦截。注意 `engine.ts` 的 initial/rereview 路径必须显式传 `triggerReason`（当前完全不传）。
   - **C2**：让 `planRejectionCount` 与 `maxPlanCycles` 同域（去掉 `Math.min(2, ...)`、放宽 `schemas.ts:269` 的 zod），或把 settings 的 `maxPlanCycles` 钳到 2 并在 schema description 写死。同时**移除或修正 `engine.ts:783` 对 `#planCycles` 的覆盖**，勿破坏 767-769 由 durable transitions 重建的真实计数。
   - **C3**：先定语义（见 §4，必要时问用户）。若选终态：`awaiting_human` 出口改走 `#completeTo(..., "blocked", ...)` 或补 `transitionWorkflow`，并与 `engine.ts:1415-1422` 的无仲裁员路径统一。若选 human handoff：需新增能推进 `substate` 的入口，并保证 resume 不空转。
   - **F5**：把仲裁标记改为单次原子写入 `{substate:"arbitration", arbitrationCycles:0, trigger}`；resume 在 `arbitration && cycles<1`（或无 arbitration artifact）时**重入** `#runPlanArbitration`，成功后再置 `cycles=1`。
   - 视情况：F4（URL 路径挂 identity）、F6（重写仲裁测试，注入带 `plan_arbitrator` 的 router 并断言第三次调用 `reviewKind==="arbitration"`）、F7（改走 `#dedupeOrdinaryReadResult` 真实链路 + 覆盖 git 仓库场景）、F8（把 clear 移出 `settled` 早退之后）。
3. 每个修复都要有**修复前会失败**的测试；跑完 §7 全部命令并如实报告；未跑不报绿。
4. 遇到以下情况停止并询问用户：C3 语义无法从设计 D 判定；发现工作区实现被覆盖/丢失；修复需要触及 deferred 五项或 `packages/coding-agent` 之外；需要 commit。

## 11. 回传格式

- 结论：三个 Critical 各自 已闭合 / 部分闭合 / 未闭合（附原因）
- 改动文件：路径 + 关键行号 + 修法一句话
- 新增/修改测试：每条说明它能捕获的原缺陷，以及修复前是否确认失败过
- 验证：§7 全部命令的新鲜 pass/fail 输出摘要
- 剩余风险：仍未闭合的 Important（F4/F6/F7/F8）与未验证项
- 下一步：是否可 commit（需用户确认）
