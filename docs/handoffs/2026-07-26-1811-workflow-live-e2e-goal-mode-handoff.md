# Handoff：Workflow Live E2E Goal Mode

创建时间：2026-07-26T18:11:59+08:00  
项目：`/Users/sheng/tencent/oh-my-pi`

## 中文短 Prompt

```text
从 docs/handoffs/2026-07-26-1811-workflow-live-e2e-goal-mode-handoff.md 继续。目标：你是 Grok Build 新会话的主 Agent，立即进入 Goal Mode，诊断并修复整套 workflow live E2E，持续推进到 gateway/claude-sonnet-4-6 optimized 3 repetitions 真实运行全部 passed、报告落盘及全部工程门禁通过；不得停在计划、单测或根因说明。第一步：完整读取 handoff、项目 AGENTS.md、Goal Mode 规则和 progress.md，核对 HEAD、dirty worktree、残留 workflow DB；把 progress.md 中旧的“已完成”记录保留为历史 checkpoint，建立 goal_id=workflow-live-e2e-revalidation-20260726、status=in_progress、可验证任务和最长 12 turns/60 分钟预算，然后先 live-probe 所有本次可达角色模型并报告实际可用性与延迟。边界：保留并适配现有 dirty worktree，不回滚他人改动；先 1 rep 建立反馈环、修复并验证，再跑最终 3 reps；不提交 secret、DB、日志或 artifacts，不 commit/push，不直接改 SQLite 状态，高风险删除、force push、部署或外部操作先确认；执行与深诊断按 AGENTS.md 委派 worker，主 Agent 保留根因判断、终审和验收。回传：按结论、Goal 进度、事实/推断/未知、根因证据、改动文件、测试/check/build、live probe 延迟、最终 3-rep report 路径与每次结果、独立 review、剩余风险汇报；只有所有完成条件满足才能把 goal 标为 completed。
```

## 1. 当前目标

- 用户请求：在 Grok Build 新会话中使用 Goal Mode 完成剩余整套 workflow 的 live E2E 验证及修复。
- 最终结果：`gateway/claude-sonnet-4-6`、`bugfix-null-deref`、optimized、3 reps 的真实报告落盘，3 个 run 全部 `passed=true` 且 `error=null`。
- 完成检查：`jq -e '[.scorecard.summaries[] | select(.variant=="optimized" and .caseId=="bugfix-null-deref") | .runs[] | (.passed==true and .error==null)] | length==3 and all' <final-report>` 返回 true；随后测试、`bun run --cwd packages/coding-agent check`、build、独立 GPT review 全通过。
- 注意：单 variant 的 `gate.passed=false`/inconclusive 是现有设计，不等于执行失败；以 runs 的实际结果和命令终态验收。

## 2. 当前状态

- HEAD：`1af77ba0d fix(coding-agent): preserve tool receivers through workflow proxies`，分支 `workflow` 相对 `origin/workflow` ahead 1。
- 已修复并提交 Proxy receiver：`execute` 绑定真实 tool target；真实 `YieldTool`、catalog Proxy、`output-meta -> alias -> transform` 组合均有回归测试。
- 已通过：聚焦测试 56/56；workflow 测试 387/387、2168 expect；coding-agent Biome/typecheck；coding-agent build；`git diff --check`。
- 独立 GPT-5.6-Sol review：`PASS_WITH_NOTES`；唯一 LOW 组合测试缺口已吸收。
- 未完成：新修复后的 live 3-rep 没有报告；命令运行 900 秒后 exit 124。
- 工作区已有大量未提交代码、文档、DB 和 artifact；它们不是可随意清理的临时垃圾。

## 3. 已确认事实

| 事实 | 证据 | 复核 |
| --- | --- | --- |
| 修复前 live 3 reps 全失败：rep1/3 private field，rep2 required_role_unavailable: planner | `.agent-artifacts/workflow-e2e/live-sonnet-opt/report.json` | 用 `jq` 查看 `.scorecard.summaries[].runs[]` |
| 修复后重跑未生成 `live-sonnet-opt-fixed` 目录或报告 | 本会话命令 exit 124，900 秒 | `find .agent-artifacts/workflow-e2e/live-sonnet-opt-fixed -maxdepth 2 -type f` |
| 残留 workflow 为 `implementing` | `packages/coding-agent/workflow.db`，workflow `wf_24698084-1bd2-4709-b95e-925b97e8425b` | 只读 sqlite 查询 workflows/attempts |
| 该 run 的 planning、plan_review 完成；implementing attempt 无 `model_profile_id`、仍 in_progress | attempt `att_5e9d8908-1406-4873-80c6-124594316bb6` | 只读 sqlite 查询 attempts |
| 超时后无残留 workflow-bench/CLI 进程 | 本会话 `ps` 查询为空 | 新会话重新执行 `ps ... | rg` |
| `progress.md` 的“full path completed”属于更早 checkpoint，不能代表当前 revalidation | `progress.md` 与上述后续 DB/timeout 证据冲突 | 保留历史并新增 goal，不覆盖证据 |

## 4. 假设与未知

| 条目 | 类型 | 解决方式 |
| --- | --- | --- |
| implementing 卡在模型路由之前、子进程等待、取消传播或 worker lifecycle | 推断；attempt 未记录 profile 但不足以定因 | 先 1 rep，按时间戳检查 routing/attempt/child lifecycle，必要时加可删除的定点 instrumentation |
| `gateway/claude-sonnet-4-6` 及 planner/reviewer/implementer 实际可用性 | 当前未知，旧 200/旧 E2E 会漂移 | workflow 启动前逐角色 live-probe，报告 actual provider/model、TTFT/总延迟、错误类别 |
| stale runner owner 是否阻止恢复 | 未知 | 使用产品 `resume/cancel/forceUnlock` 契约验证；禁止直接 UPDATE/DELETE SQLite |
| 15 分钟是否只是 implementer 正常变慢 | 未知 | 给 1 rep 增加分阶段时限与活性证据，不能用“进程活着”代替成功 |

## 5. 关键文件与产物

- `progress.md`：Goal Mode 进度；新主 Agent 独占写，worker 只回传证据。
- `docs/superpowers/plans/2026-07-26-workflow-proxy-private-brand-code-review.md`：本轮修复与 live 超时记录。
- `packages/coding-agent/src/tools/workflow-alias-wrap.ts`、`test/tools/yield.test.ts`、`test/workflow/tool-path-optimization.test.ts`：已提交修复与回归。
- `packages/coding-agent/src/workflow/benchmark/live-runtime.ts`、`src/cli/workflow-bench-cli.ts`、`src/workflow/availability-*.ts`：下一轮重点诊断路径。
- `.agent-artifacts/workflow-e2e/live-sonnet-opt/`：修复前失败报告；只读保留。
- `.agent-artifacts/review-proxy-private-brand/primary/last_message.md`：前序 reviewer 内容；其 shell 身份 gate 失败，不能单独充当最终 review。
- `packages/coding-agent/workflow.db`：含残留 run；禁止提交，修改前先做只读保全并走产品契约。

## 6. 下一 Agent 执行顺序

1. 读取规则并规范化 `progress.md`：任务至少含现场保全、live probe、1-rep 复现、根因修复、工程门禁、最终 3 reps、独立 review；每步写 evidence。
2. 用只读命令保全残留 workflow/attempt/transitions/artifacts 和进程状态；判断 resume/cancel/forceUnlock 的正确入口，不直接改 DB。
3. 对本次所有可达角色做真实 availability probe，报告具体延迟；不可用时先处理路由/凭据/UA，不把静态 catalog 当可用证据。
4. 先跑 optimized 1 rep 到独立新目录，建立可在数分钟内判定的反馈环；定位 implementing 无终态根因。两次无效修复后停手复盘并升级 GPT-5.6-Sol consult。
5. 最小修复，补能捕获真实失败路径的测试；运行聚焦测试 → workflow 全套 → coding-agent check → build → 1-rep live。
6. 1 rep 通过后才跑最终 optimized 3 reps 到全新目录；读取 report 中每个 run，不只看 exit code。
7. Grok 实现后用 GPT-5.6-Sol 独立 code review；吸收阻断项。全部完成后更新 `progress.md` 为 completed，否则 blocked 并写精确阻塞证据。

## 7. 边界与停止条件

- 允许：仓库内最小代码/测试修改、真实 gateway 请求、fixture 临时目录、只读 DB/日志检查、项目约定的测试/check/build。
- 禁止：回滚/覆盖 dirty worktree；提交 `.env`、token、DB、日志、artifact；直接篡改 SQLite；commit/push；伪造 pass_rate、provider identity 或 latency。
- 需用户确认：删除现有数据、force push、部署、生产写、权限/密钥变更、外部消息或明显扩大范围。
- Secret 只报告变量名、来源类型和是否存在；不得输出原值。Gateway 403/UA、HTTP 200、模型返回必须分开陈述。
- 只有缺少权限/凭据且安全替代已穷尽，或高风险操作不可避免时才停下询问；普通失败继续诊断，不以“建议下一步”提前结束 goal。

## 8. 回传格式

- 结论与 Goal 状态：
- 已证实事实 / 推断 / 未知：
- 根因与修复文件：
- 测试、check、build：
- Live probe（模型、实际身份、TTFT/总延迟）：
- 最终 3-rep 报告路径及逐次结果：
- 独立 review：
- 剩余风险或阻塞：
