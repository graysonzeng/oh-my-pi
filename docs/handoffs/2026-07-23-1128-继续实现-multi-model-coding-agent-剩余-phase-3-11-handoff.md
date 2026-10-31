# Handoff：继续实现 multi-model coding agent 剩余 Phase 3-11

创建时间：2026-07-23T11:28:58+08:00  
项目根目录：`/Users/sheng/tencent/oh-my-pi`

## 中文短 Prompt

```text
从 docs/handoffs/2026-07-23-1128-继续实现-multi-model-coding-agent-剩余-phase-3-11-handoff.md 继续。目标：以 docs/superpowers/plans/2026-07-22-multi-model-coding-agent.md 为唯一产品蓝图，修完现有 foundation 的缺口并完成 Phase 3-11，最终交付可恢复、可验证、有界修复的 multi-model workflow MVP。第一步：完整读取 AGENTS.md、计划文档、本 handoff 和现有 workflow diff，检查 progress.md、git status、HEAD 与依赖状态，然后建立逐阶段 Goal 计划；不要把现有占位实现视为已完成。边界：主 Agent 负责架构、风险、最终验收和 progress.md；按项目规则将大于 50 行、3 文件以上、深探索及完整测试委派给 Grok worker，并执行独立 design/code review；保留用户已有改动，不提交、不 push、不发布、不调用付费 API、不创建或评论 GitHub 内容，除非用户明确授权。回传：按阶段列出已完成项、file:line 证据、worker/reviewer 结果、实际测试命令与输出、未验证项、剩余风险和下一 checkpoint；只有全部完成标准真实通过后才能声明 goal completed。
```

## 1. 当前目标

- 用户原始请求：在新会话中实现 `docs/superpowers/plans/2026-07-22-multi-model-coding-agent.md` 尚未完成的后续开发工作。
- 期望结果：补齐 foundation 中的占位和缺失行为，完成计划 Phase 3-11，并回头收口 Phase 1-2 已发现的契约与测试缺口，形成可实际运行的 MVP。
- 完成标准：
  - 计划第 34 节全部完成条件均有代码和测试证据。
  - `{bun test packages/coding-agent/test/workflow}` produces 全部通过且无加载错误。
  - `{bun check}` produces exit code 0。
  - `{git diff --check}` produces 无输出且 exit code 0。
  - workflow tool 的 `start/status/resume/cancel` 行为、审批等级和持久化契约有测试证明。
  - 不存在硬编码批准、虚构 patch/branch/command 或无条件验证成功路径。
  - 文档、settings、prompts、changelog 与实现行为一致。

## 2. 当前状态

- 状态：foundation 已提交，但整体功能约完成 25%-30%，尚不可作为 MVP 使用。
- 已完成：
  - 分支 `workflow` 上已有实现提交 `8af2ee9c6 feat(coding-agent): add multi-model workflow foundation`。
  - 已建立 `packages/coding-agent/src/workflow/` 基本目录、类型、schema、transition、SQLite、adapter、verifier、stage、engine 和 tool 文件。
  - 已有 11 个 workflow 测试文件以及 changelog 条目。
- 待完成：
  - 修复 Phase 1-2 的 schema、transition exhaustiveness、artifact hash、原子持久化及恢复契约缺口。
  - 完成 Phase 3-6 的路由、预算、finding、runtime adapter、deterministic verifier 真实行为和测试矩阵。
  - 将 Phase 7 的硬编码 stages 替换为通过 ports 调用 runtime/verifier 的真实实现。
  - 完成 Phase 8 的阶段驱动、repair loop、budget stop、cancel、restart recovery 和 optimistic runner lock。
  - 按计划实现 Phase 9 的 `start/status/resume/cancel` built-in tool，而不是当前 action 集合。
  - 完成 Phase 10 的 versioned role prompts、settings schema、渲染/设置测试。
  - 完成 Phase 11 用户文档、恢复说明、全套验证和最终只读审计。
- 最重要的下一步：先建立 `progress.md` 或恢复已有 goal，随后对 Phase 1-11 做一次基于现有代码的 gap matrix，冻结公共类型、状态机、ports 和 persistence contract 后再委派实现。

## 3. 已确认事实

| 事实 | 证据 | 如何复核 |
| --- | --- | --- |
| 当前 HEAD 是计划文档提交 | `f9b96294d13abdc3fa30dc61a87c2b30a3b46c1a` | `git rev-parse HEAD` |
| 当前实现主体来自 foundation 提交 | `8af2ee9c6`，39 files changed，1986 insertions | `git show --stat 8af2ee9c6` |
| `FindingTracker.hasRepeated()` 固定返回 false | `packages/coding-agent/src/workflow/finding-tracker.ts:23-26` | 重开文件并运行重复 finding 测试 |
| ModelRouter 没有 fallback、degraded audit 或 diversity enforcement | `packages/coding-agent/src/workflow/model-router.ts:14-25` | 对照计划 Phase 3 |
| plan/code review 与 final verify 存在硬编码成功结果 | `stages/plan-review.ts:5-21`、`stages/code-review.ts:5-21`、`stages/final-verify.ts:5-18` | 重开文件 |
| implement stage 返回虚构 changedFiles、命令、patch 和 branch | `stages/implement.ts:14-37` | 重开文件 |
| workflow tool 仅实现 start，且 action schema 与计划不一致 | `workflow/workflow-tool.ts:3-24` | 对照计划 Phase 9 |
| resume 当前只读取 state，没有执行点恢复 | `workflow/sqlite-store.ts:211-213` | 对照 Phase 8 restart tests |
| workflow prompt 目前只有标题 | `src/prompts/workflow/plan.md:1` | `sed -n '1,80p' ...` |
| `.env` 不存在 | 本会话检查结果 | `[ -f .env ]` |
| 工作区在生成本 handoff 前是 clean | 本会话 `git status --short` 无输出 | 新会话重新检查，handoff 文件会成为新增改动 |

## 4. 假设与未知

| 条目 | 类型 | 为什么重要 | 如何解决 |
| --- | --- | --- | --- |
| 当前依赖是否只需执行 frozen install | 未知 | 测试加载失败于 workspace package 和 zod 解析 | 检查 `node_modules`，必要时执行 `bun install --frozen-lockfile`，确认 lockfile 不变 |
| foundation 是否经过独立 design/code review | 未知 | 项目规则要求独立 review gate | 检查 `.design-gate.json`、worker artifacts 和提交历史；缺失则补 review |
| 计划中的 exact API 是否因 HEAD 漂移 | 未知 | runtime adapter 依赖 task internals | 重读 `structured-subagent.ts`、`types.ts`、`executor.ts`、`isolation-runner.ts` |
| 默认模型 ID 和 provider 可用性 | 未知 | 不能硬编码或假定公开模型 ID | 使用现有 model registry/provider resolution，通过 faux provider 测试 |
| 是否存在其他活跃 goal | 未知 | Goal Mode 禁止同一分支写域冲突 | 首先检查 `progress.md` 和活动 worker/run artifacts |

## 5. 相关文件与产物

| 路径 | 用途 | 备注 |
| --- | --- | --- |
| `docs/superpowers/plans/2026-07-22-multi-model-coding-agent.md` | 产品蓝图、Phase 0-11、验收矩阵 | 唯一主计划，先完整读取 |
| `packages/coding-agent/src/workflow/` | 当前 foundation 实现 | 不能按文件存在判完成 |
| `packages/coding-agent/test/workflow/` | 当前测试证据 | 缺多个计划要求的测试文件 |
| `packages/coding-agent/src/task/structured-subagent.ts` | 唯一 runtime adapter 目标 | adapter 之外禁止依赖 task execution internals |
| `packages/coding-agent/src/task/isolation-runner.ts` | 写阶段隔离能力 | implementation/repair 必须复用 |
| `packages/coding-agent/src/tools/index.ts` | built-in tool factory/注册模式 | 不能只做 barrel export |
| `packages/coding-agent/src/config/settings-schema.ts` | workflow settings | 当前未见本功能配置 |
| `packages/coding-agent/CHANGELOG.md` | Unreleased 记录 | 已有 foundation 条目，最终需与真实行为对齐 |
| `.agent-artifacts/` | worker/review 过程证据 | 不提交无关产物 |
| `progress.md` | Goal Mode 状态 | 新会话先检查，主 Agent 独占写权限 |

## 6. 本会话改动

| 路径 | 改动摘要 | 原因 |
| --- | --- | --- |
| `docs/handoffs/2026-07-23-1128-继续实现-multi-model-coding-agent-剩余-phase-3-11-handoff.md` | 新增完整中文 handoff | 支持新会话准确继续 |

未修改任何 workflow 实现代码，未提交。

## 7. 命令与验证

| 命令 | 结果 | 证据摘要 |
| --- | --- | --- |
| `git status --short` | 通过 | 生成 handoff 前无输出 |
| `git log -12 --oneline --decorate` | 通过 | HEAD 为计划提交，前一提交为 foundation |
| `bun test packages/coding-agent/test/workflow` | 失败 | 19 pass、3 个测试文件加载失败；无法解析 `@oh-my-pi/pi-utils` 和 `zod` |
| `bun check` | 失败 | `biome: command not found`，未进入实际代码检查；Rust check 被中断 |
| `rg`/`sed`/`nl` 对计划和 workflow 文件核查 | 通过 | 确认阶段缺口和硬编码成功路径 |

注意：测试失败首先证明依赖环境未就绪，不能把它全部归因于实现；依赖恢复后必须重新运行。

## 8. 决策与取舍

| 决策 | 考虑过的替代方案 | 原因 |
| --- | --- | --- |
| 不把 foundation 文件数量当作完成度 | 直接按 Phase 文件是否存在计为完成 | 多个文件仍是硬编码或空壳 |
| 从 Phase 1-2 缺口开始收口，再推进 Phase 3-11 | 直接从 Phase 3 开始 | 持久化和 schema 是后续 engine 的共享契约 |
| 继续复用 `runStructuredSubagent()` 与 isolation runtime | 自建 Claude/Codex/Grok loops | 这是原计划明确架构边界 |
| 测试使用 faux provider | 调用真实付费模型 | 计划明确禁止 paid-provider tests，且需要确定性 |
| 主 Agent 保留架构和最终验收 | 将整个 goal 无边界交给单一 worker | 项目 AGENTS.md 要求主 Agent 为 Advisor/Orchestrator |

## 9. 风险与安全边界

- 允许：读取仓库；修改计划要求范围内的 coding-agent workflow、tests、prompts、settings、用户文档和 changelog；运行依赖安装、focused tests、`bun check`、build/smoke 等本地验证；按 AGENTS.md 委派本地 worker 和 review。
- 禁止：回滚用户改动；顺手重构无关模块；直接编辑生成的 `packages/catalog/src/models.json`；使用裸 `python/python3/pip`；使用 `tsc/npx tsc`；使用 `mock.module()`；在 prompt 代码中内联 prompt；伪造测试/worker/review 结果。
- 未经用户确认禁止：git commit、push、发布、部署、删除、force push、生产写、外部消息、创建或评论 GitHub issue/PR、直接调用付费模型 API。
- 安装边界：如只是恢复 lockfile 已声明依赖，可运行 `bun install --frozen-lockfile`；如果需要新增依赖或修改 lockfile，先证明必要性并按项目正常实现流程处理，不能为绕过错误随意加包。
- 敏感信息处理：若后续出现 `.env`，只读取必要 key 并脱敏；不得把 secret/token/cookie/private key 写入 prompt、artifact、日志或测试快照。
- 最大 Goal 预算：30 个 goal turns；超过预算仍未达到完成标准时标记 blocked，更新 `progress.md` 并报告剩余问题，不得伪完成。

## 10. 下一 Agent 指引

1. 完整读取根 `AGENTS.md`、更近的项目规则、计划文档和本 handoff；检查 `progress.md`、`git status --short`、HEAD、`.env` 和依赖状态。
2. 按项目要求执行 skillhub；代码修改启用 engineering-flow，并根据任务使用 Grok build worker、独立 design/code review 和最终 code-audit。
3. 建立 Phase 1-11 gap matrix 和 Goal 子任务。建议 checkpoint：
   - T1：恢复依赖和 baseline 验证，补 Phase 1-2 契约缺口。
   - T2：完成 Phase 3-4 routing/budget/finding。
   - T3：完成 Phase 5-6 runtime adapter/verifier。
   - T4：完成 Phase 7 stages。
   - T5：完成 Phase 8 engine/recovery/repair loop。
   - T6：完成 Phase 9 tool 与真实 factory 注册。
   - T7：完成 Phase 10 prompts/settings。
   - T8：完成 Phase 11 docs/changelog、全套验证与独立审计。
4. 在共享契约稳定前不要并行改 `types.ts`、`schemas.ts`、`transitions.ts`、`engine.ts` 和 `sqlite-store.ts`；如委派并行 worker，必须明确互斥 ownership，主 Agent 集成。
5. 每个 checkpoint 完成后更新 `progress.md`：状态、worker、file:line、命令结果、决策记录和下一步。
6. 最终重新逐项核对计划第 23、24、34 节；只有证据全部满足才将 Goal 标为 completed。
7. 遇到以下情况停止并询问用户：计划与现有 API 发生重大冲突需要重设计；必须新增 materially different scope；需要付费 API、外部写、commit/push/publish；存在无法绕开的用户脏改冲突；同一问题连续两次修复无效。

## 11. 回传格式

- 结论：Goal 状态（in_progress/blocked/completed）及是否达到 MVP 完成定义。
- 命中技能：本轮实际使用的技能及其对实现/门禁的影响。
- 委派：worker/reviewer 角色、原因、ownership、验收标准和验收结果。
- 阶段进度：Phase 1-11 对账，状态只能为已完成/部分完成/未完成/证据不足。
- 改动文件：按模块列出 file:line 和行为变化。
- 验证：逐条列实际运行命令、exit code、pass/fail/skip 数量；未运行必须说明原因。
- 风险与未知：阻断、非阻断、未验证分开。
- Git 状态：`git status --short`、是否提交；未经明确授权不得提交。
- 下一 checkpoint：若未完成，给出恢复所需最小上下文和第一条命令。
