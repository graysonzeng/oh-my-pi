# Handoff：latency/delegation 剩余实现的完整方案与 code review

创建时间：2026-08-04T19:23:38+08:00
项目根目录：`/Users/sheng/tencent/oh-my-pi`
分支：`workflow`（ahead of `origin/workflow` 9 commits + 未提交实现）
基线提交（已提交 HEAD）：`37e9b44d8f65225785e1c848282d02d7949b4d94`

## 中文短 Prompt

```text
从 docs/handoffs/2026-08-04-1923-latency-delegation-剩余实现的完整方案与-code-review-handoff.md 继续。目标：对本轮未提交的 latency/delegation 剩余实现做完整「方案一致性 + code review」（只读）。第一步：核对 git status/diff 与 handoff 文件清单，确认相对 HEAD=37e9b44d8 的未提交改动仍在；再对照权威设计 A/D/E 与先前审查 HIGH/MEDIUM 清单复审。边界：只读审查，不改代码、不 commit、不 push；可用 subagent 并行做 Spec/Standards 两轴；证据不足标未验证。回传：结论（PASS/NEEDS_REVISION）、按严重度列 findings（文件:行）、方案符合/缺口、验证复跑结果、剩余风险与建议下一步。
```

## 1. 当前目标

- 用户原始请求：提供短 prompt，在新会话中做完整的方案及 code review。
- 期望结果：新会话 Agent 对已落地但未提交的实现做只读完整审查（设计合同对齐 + 代码缺陷优先）。
- 完成标准：产出带证据的审查结论；区分已闭合/未闭合/明确 deferred；不擅自改代码或提交。

## 2. 当前状态

- 状态：实现已落地（未提交）；本会话用户明确要求本轮不做 review，改在新会话做完整方案+code review。
- 已完成：
  - HIGH-2：read identity 生产方（`tools/read.ts`）+ 测试
  - HIGH-3：PlanReview V2 stage + control-state 状态机（引擎内存+artifact 持久化）+ 测试
  - E：`task.proactive.*` 三 flag + system prompt + 测试
  - MEDIUM：bash create/poll timeout 记 ledger；`timeoutMetricOnce` settle 清理
  - 聚焦验证已通过（见 §7）
- 待完成：
  - 新会话完整方案审查 + code review
  - 用户确认后再 commit（如需要）
- 最重要的下一步：新会话按短 prompt 做只读双轴审查。

## 3. 已确认事实

| 事实 | 证据 | 如何复核 |
| --- | --- | --- |
| HEAD 提交为 `37e9b44d8`（queued timeout first-cause 已修） | `git rev-parse HEAD` | 复跑 |
| 本轮实现均为工作区未提交改动 | `git status`：21 已改 + 2 未跟踪测试 | `git status -sb -- packages/coding-agent` |
| coding-agent 本轮 diff ≈ +1078/−172（21 files） | `git diff --stat HEAD -- packages/coding-agent` | 复跑 |
| 聚焦测试 133 pass / 0 fail | `bun test test/latency test/task/task-spawn.test.ts test/system-prompt-delegation.test.ts test/workflow/stages/plan-review.test.ts test/settings-manager.test.ts` | 新会话复跑 |
| 追加回归 121 pass / 0 fail | delegation/settings/engine-budget/resume/work-packages/bash-ledger | 新会话复跑 |
| `bun run check:types` 通过 | packages/coding-agent `tsgo -p tsconfig.json --noEmit` | 复跑 |
| 设计文档集体评审曾为 5/5 NEEDS_REVISION | `docs/superpowers/plans/2026-08-04-latency-delegation-docs-collective-subagent-review.md` | 读文件 |
| 先前 code review 将 HIGH-2/HIGH-3 标为后续风险，HIGH-1 已修 | `docs/superpowers/plans/2026-08-04-subagent-timeout-latency-code-review.md` §8 | 读文件 |

## 4. 假设与未知

| 条目 | 类型 | 为什么重要 | 如何解决 |
| --- | --- | --- | --- |
| PlanReview V2 对真实 LLM 输出是否稳定（非 scriptedRunner） | 未验证 | 合同可能只在测试 fixture 下成立 | 审查 JSON schema/prompt 完备性；必要时补 live/fixture |
| control-state 仅 artifact 持久化是否满足 D §7 SQLite/atomic resume 全合同 | 假设（实现刻意 pragmatic） | 可能被标为方案缺口而非代码 bug | 对照 D §7/§10 明确「闭合 vs deferred」 |
| URL read 身份 fail-open 是否可接受 | 假设 | HIGH-2 本地路径已闭合，URL 仍可能永不 dedupe | 审查是否需补 ETag 路径 |
| 工作区同时有大量 docs 设计修订（非本轮实现） | 事实边界 | 审查范围勿混入无关 docs diff | 审查范围限定 `packages/coding-agent` 未提交实现 + 权威设计对照 |

## 5. 相关文件与产物

| 路径或 URL | 用途 | 备注 |
| --- | --- | --- |
| `docs/superpowers/specs/2026-08-03-latency-optimization-plan-design.md` | 设计 A（latency） | 权威 |
| `docs/superpowers/specs/2026-08-04-plan-review-pipeline-design.md` | 设计 D（plan review） | 权威；§4/6/7/10 |
| `docs/superpowers/specs/2026-08-04-proactive-subagent-delegation-design.md` | 设计 E（proactive） | 权威；§6 |
| `docs/superpowers/plans/2026-08-04-latency-implementation-acceptance.md` | 前轮 acceptance（偏乐观） | 对照勿盲信 |
| `docs/superpowers/plans/2026-08-04-subagent-timeout-latency-code-review.md` | 前轮审查 + HIGH-1 修复记录 | 审查起点 |
| `docs/superpowers/plans/2026-08-04-latency-delegation-docs-collective-subagent-review.md` | 文档集体评审 5/5 NEEDS_REVISION | 方案轴输入 |
| `docs/design/subagent-lifecycle-observability-v2.md` | timeout P0 旁路权威（若存在） | 本地可能未跟踪 |

## 6. 本会话改动

| 路径 | 改动摘要 | 原因 |
| --- | --- | --- |
| `src/tools/read.ts` | 生产 read identity 字段 | HIGH-2 |
| `test/latency/read-identity-production.test.ts` | 新增（未跟踪） | HIGH-2 验证 |
| `src/workflow/stages/plan-review.ts` | 默认 V2 解析 | HIGH-3 |
| `src/workflow/json-schemas.ts` | `PlanReviewArtifactV2JsonSchema` | HIGH-3 |
| `src/workflow/engine.ts` | control state + 仲裁状态机 | HIGH-3 |
| `src/workflow/context-builder.ts` / `stage-handoff.ts` | V2/handoff 适配 | HIGH-3 |
| `src/prompts/workflow/plan-reviewer.md` | V2 规则简述 | HIGH-3 |
| `test/workflow/helpers.ts` 等 plan-review 相关测试 | V2 helpers/回归 | HIGH-3 |
| `src/config/settings-schema.ts` | `task.proactive.*` 三 boolean 默认 false | E |
| `src/sdk.ts` / `system-prompt.ts` / `prompts/system/system-prompt.md` | 贯通与删无条件 parallel | E |
| `test/system-prompt-delegation.test.ts` | 新增（未跟踪） | E 验证 |
| `src/tools/bash.ts` | create/poll timeout 记 ledger | MEDIUM |
| `src/task/index.ts` | settle 清理 timeoutMetricOnce | MEDIUM |
| 相关 bash/task-spawn 测试 | 回归覆盖 | MEDIUM |

**明确 deferred（实现时声明，审查应核验是否越界宣称）：** QualityRouteSnapshotV2 全量、独立 `plan-arbitration.ts`、人工 receipt UI、五 arm A/B rollout、D §10 完整 SQLite migration。

## 7. 命令与验证

| 命令 | 结果 | 证据摘要 |
| --- | --- | --- |
| `bun test test/latency test/task/task-spawn.test.ts test/system-prompt-delegation.test.ts test/workflow/stages/plan-review.test.ts test/settings-manager.test.ts` | 通过 | 133 pass / 0 fail |
| `bun test test/system-prompt-delegation.test.ts test/settings-manager.test.ts test/workflow/engine-budget-stop.test.ts test/workflow/engine-resume.test.ts test/workflow/engine-work-packages.test.ts test/latency/bash-attempt-ledger.test.ts` | 通过 | 121 pass / 0 fail |
| `bun run check:types`（packages/coding-agent） | 通过 | tsgo noEmit clean |
| 全量 coding-agent 测试 / CI | 未运行 | 新会话可按需扩大 |
| commit / push | 未运行 | 需用户确认 |

## 8. 决策与取舍

| 决策 | 考虑过的替代方案 | 原因 |
| --- | --- | --- |
| 用 4×`implementer` 并行落地，不用 grok_build_worker | worker / 单线程自改 | 用户明确要求 subagent 且不用 worker |
| PlanReview control-state 用 artifact 持久化，不做 SQLite migration | 完整 D §7 store migration | 闭合 HIGH-3 运行时缝；完整 epic 明确 deferred |
| 仲裁复用 PlanReviewStage + `reviewKind: arbitration` | 新建 plan-arbitration.ts | 设计允许同一 WorkflowEngine owner；减少新文件 |
| proactive 三 flag 默认 false | 直接改 `task.eager` 默认 | 遵循 E §6 实验默认 |

## 9. 风险与安全边界

- 允许：只读审查；`git diff`/`git show`；复跑测试；派只读 subagent；写审查产出文档到 `docs/superpowers/plans/`（若用户要落盘）
- 禁止：改业务代码、commit、push、force push、改 git config、部署
- 需要用户确认：任何修复实现、提交、扩大到无关 docs 大改的审查范围
- 敏感信息处理：不写入 secret/token/客户数据

## 10. 下一 Agent 指引

1. 第一步：`git rev-parse HEAD` + `git status -sb -- packages/coding-agent` + `git diff --stat HEAD -- packages/coding-agent`，确认未提交实现仍在且与本 handoff 清单一致。
2. 然后：
   - 对照设计 A/D/E 做 **Spec/方案轴**（缺什么、多做什么、实现错误）
   - 对未提交 diff 做 **Standards/缺陷轴**（正确性、竞态、合同漂移、测试空洞）
   - 重点核验：read identity 是否真能 eligible；PlanReview 二次 rejection→仲裁；V1 resume-only；proactive flags 默认 false 且 eager gate；bash timeout ledger；metric once-key 清理；deferred 是否被过度宣称
   - 复跑 §7 聚焦测试（未跑不报绿）
3. 遇到以下情况停止并询问用户：需要改代码才能闭合的 Critical；发现工作区实现已被覆盖/丢失；要把 deferred 全量 D §10 当作本轮必须交付。

## 11. 回传格式

- 结论：PASS / NEEDS_REVISION（可分 Spec 轴与 Code 轴）
- Findings：按 Critical / Important / Minor，含文件路径与行号、证据、建议
- 方案符合/缺口：相对 A/D/E 与明确 deferred 边界
- 验证：复跑命令与 pass/fail（新鲜输出）
- 剩余风险：
- 下一步：是否进入 fix-implement / 可否 commit（需用户确认）
