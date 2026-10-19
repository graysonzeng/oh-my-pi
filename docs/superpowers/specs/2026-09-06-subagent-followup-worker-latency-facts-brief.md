# Facts Brief: 近期 omp 会话耗时（subagent / reviewer / task）与已落地优化缺口

- Date: 2026-09-06
- 本 brief 只记录已解析事实。推断标 `[INFERENCE]`。未知标 `[未知]`。
- 协调者不得在本文件写方案、取舍或推荐。
- 禁止把未观测的「45–90 秒」「35%/36% 改善」写入任何事实或目标。

## 0. 用户请求与范围边界

用户原话（第一轮）：分析近期 omp 历史会话记录，总结分析执行耗时，特别是 subagent、reviewer、task 等执行耗时，以降低任务整体耗时为目标，在原来的已有优化基础上，设计完整的合理优化方案。

用户原话（同一会话跟进，2026-09-06）：通俗解释分析得到的主要耗时点在哪些步骤；为什么少数特别长的「干活型」子代理能跑到 1 小时甚至 2 小时以上；然后参考 pi 以及 Cursor 的 subagents 功能，简化子代理的执行过程，大幅降低子代理任务耗时。

授权：仍为 `design-only`。跟进要求改变了推荐方案必须覆盖的执行合同（完成协议 / keep-going / 画像），但未授权改产品代码、改本机 `~/.omp` 或发布。

2026-09-06 第一次 Design Review Gate（`AstraDesignGate` / `gateway/gpt-6-astra`）对「只补 follow-up/IRC 预算=0」稿给出 `NEEDS_REVISION`：冷恢复 `wakeAgent` stub 只有 `ref.displayName`，frontmatter `shadowReview: code` 与 spawn `"code"` 都会丢失，不能只把降级写成 spawn-only review，又要求三类四入口同合同。证据：`docs/superpowers/plans/2026-09-06-subagent-followup-worker-latency-subagent-review.md`。该 Gate 不否决「每轮共享解析」方向，也不要求升累计账本。

相邻设计（本轮不得重做其已覆盖且已落地杠杆，除非新语料证明它们未闭合）：

| 文档 | 已覆盖 | 与本轮关系 |
|---|---|---|
| `docs/long-session-latency-analysis.md` | 2026-08-03 全量语料：模型 gen/TTFT、hub 等待、bash 重跑 | 历史底座，不是本轮复算窗口 |
| `docs/superpowers/specs/2026-08-03-latency-optimization-plan-design.md` | 长会话模型/TTFT/工具池 A/B | ordinary session，不是本轮 follow-up/worker 缺口 |
| `docs/superpowers/specs/2026-08-26-session-quality-context-latency-design.md` | skill stub、adaptive-delivery misroute、单元素 task + hub wait、review 预算 | 已部分落地；本轮不重做 skill stub |
| `docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md` | performance class、explore 10 min/40 req、review 30 min/80 req、75% advisory、scout 降档 | CHANGELOG Unreleased 已写落地；本轮不得重做 class/scout/75% advisory 机制 |
| `docs/superpowers/plans/2026-08-31-subagent-latency-remediation-plan.md` | 跟进轮预算=0、IRC 无 monitor、75% 曾是强停 | 75% advisory 已落地；跟进轮/IRC 预算=0 仍在源码 |
| `docs/superpowers/plans/2026-09-06-subagent-followup-worker-latency-subagent-review.md` | 冷恢复 class 丢失不限于 spawn-only；验收与 stub 输入矛盾 | 本轮必须把 `performanceClass` 持久化进现有 `session_init` 并让 revive 走同一 resolver |

## 1. 复算口径（本轮唯一数字来源）

- 脚本：`/tmp/omp_recent_latency.py`
- 输出：`/tmp/omp_latency_2026-09-06/summary.md`、`children.csv`、`parents.csv`
- 生成时间：`2026-09-06T09:29:27.393066+00:00`
- 根目录：`/Users/sheng/.omp/agent/sessions`
- **无插补**：缺 `duration`/`ttft` 跳过该字段统计；未配对工具不计入工具耗时；`thinkingLevel` 只取 `thinking_level_change.thinkingLevel` 观测值，空则记「无观测」，不默认 medium。
- 活跃墙钟：子 jsonl 中带 `timestamp` 的 assistant 事件排序，相邻间隔 ≤10 min 计入；>10 min 视为 park。`<2` 条 assistant timestamp 的会话不进活跃分位数。与 `packages/coding-agent/src/latency/active-wall.ts` 同算法。
- 文件墙钟：文件内全部带 timestamp 事件的首末差。与活跃墙钟不可混用。
- 分位数：nearest-rank，`rank = ceil(p/100 * n)`，1-indexed。
- 子会话分类：按**文件名**正则，不是 agent 身份。`scout|sonic|audit` → scout；`review|gate|specaxis|standardsaxis|solspec` → review/gate；`author|designer|design` → design/author；`implement|repair|fiximplement` → implement；其余 → other。
- 排除：项目目录名匹配 `-tmp-*` / `-.claude*` / `fixture`；子文件 `__advisor.jsonl`。
- 扫描：项目目录 39，排除 268；父 jsonl 625，子 jsonl 1602；parent/child parse_errors=0；skipped_non_jsonl=121672（子目录内非 jsonl 日志等）。
- 活跃墙钟是既定算法下的观测量，**不等于**用户端到端任务总耗时。两个日期窗口**不是**受控实验，窗口间差值不得写成因果收益。

## 2. 窗口对比（原始可观测集）

### 2.1 全量非 tmp

| 集合 | n | 说明 |
|---|---:|---|
| 父 jsonl | 625 | 含无活跃样本 |
| 父活跃样本 | 545 | ≥2 assistant ts |
| 子 jsonl | 1602 | |
| 子活跃样本 | 1568 | 排除 <2 assistant = 34 |

子活跃：n=1568 mean=15.19 p50=10.66 p90=32.56 p95=45.02 max=185.33 ≥20m=358 ≥30m=184 ≥60m=32 min。

按文件名类（活跃样本）：

| 类 | n | mean | p50 | p90 | p95 | max | ≥30m |
|---|---:|---:|---:|---:|---:|---:|---:|
| review/gate | 570 | 15.62 | 11.34 | 32.63 | 42.73 | 94.16 | 66 |
| scout | 247 | 9.44 | 7.98 | 17.16 | 20.51 | 38.93 | 3 |
| design/author | 123 | 20.27 | 13.95 | 42.69 | 58.90 | 185.33 | 25 |
| implement | 70 | 25.35 | 17.87 | 50.55 | 66.45 | 102.28 | 26 |
| other | 558 | 14.90 | 10.12 | 31.67 | 45.90 | 167.18 | 64 |

缺字段（全量子会话 assistant）：duration present=68194 missing=279；ttft present=62662 missing=5811；tool_unmatched=891；starts_left_open=892；无 thinkingLevel 观测=61/1602；无 model_change=4/1602。这些行未插补。

父 task：counted=979 matched=979；**batch_events=0**（`tool_execution_start.args.tasks` 在本语料未解析到数组；**不得**用本脚本宣称 size=1 占比）。task 匹配耗时 p50=0.00 min（几乎全是立即返回的 spawn ack，不是子代理墙钟）。父 hub：counted=8948 matched=8931 unmatched=17；hub duration p50=0.02 p90=3.00 max=32.39 min。

### 2.2 对照窗口 2026-08-27–2026-08-30

与 8/30 facts brief 日期对齐，但**本轮口径是活跃墙钟 + 文件名分类 + 无插补**，不能与 8/30 brief 的文件首末墙钟数字直接相减。

- 父 48 / 父活跃 44；子 154 / 子活跃 150；排除 <2 assistant=4
- 子活跃：n=150 mean=13.22 p50=11.13 p90=23.22 p95=32.94 max=55.45 ≥20m=25 ≥30m=11 ≥60m=0
- review/gate 活跃 n=77 p50=8.47 p90=23.14 p95=29.28 max=36.06 ≥30m=3
- scout 活跃 n=12 p50=10.73 p90=16.99 p95=18.68 max=18.68 ≥30m=0
- 该窗口 thinkingLevel/model 全有观测（0/154 空）
- duration present=5382 missing=46；ttft present=5124 missing=304；unmatched tools=0

该窗口 review/gate 观测 thinking：xhigh 为主（`StandardsAxis`/`GrokStandardsAxis` 等）。scout n=12 不足以宣称产品 scout 目标已达标。

### 2.3 新鲜窗口 2026-08-31–2026-09-06

- 父 125 / 父活跃 109；子 238 / 子活跃 234；排除 <2 assistant=4
- 子活跃：n=234 mean=13.11 p50=7.44 p90=31.25 p95=45.73 max=167.18 ≥20m=39 ≥30m=24 ≥60m=4
- 子文件墙钟：n=238 p50=13.97 p90=43.80 p95=64.13 max=217.39 ≥30m=45 ≥60m=14
- 父活跃：n=109 p50=21.68 p90=114.93 p95=153.04 max=390.67 ≥30m=45 ≥60m=24
- 该窗口 thinkingLevel/model 全有观测（0/238 空）
- duration present=6631 missing=62；ttft present=6172 missing=521；unmatched tools=0；starts_left_open=1

按文件名类（活跃样本）：

| 类 | n | mean | p50 | p90 | p95 | max | ≥20m | ≥30m | ≥60m |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| review/gate | 75 | 10.14 | 7.28 | 23.95 | 33.07 | 47.40 | 8 | 4 | 0 |
| scout | 34 | 5.59 | 3.70 | 13.94 | 17.66 | 20.18 | 1 | 0 | 0 |
| design/author | 28 | 11.85 | 8.24 | 29.75 | 29.90 | 33.24 | 5 | 1 | 0 |
| implement | 9 | 13.78 | 9.67 | 36.05 | 36.05 | 36.05 | 3 | 1 | 0 |
| other | 88 | 18.88 | 8.82 | 46.87 | 59.94 | 167.18 | 22 | 18 | 4 |

oh-my-pi 子集（同窗口，活跃）：n=107 p50=8.50 p90=45.90 p95=59.92 max=167.18；review/gate n=25 p50=7.47 p90=42.31；scout n=12 p50=3.74 p90=17.66；other n=56 p50=9.87 p90=59.92，≥30m=17，≥60m=4。

### 2.4 新鲜窗口切片（仍无插补）

review/gate n=75：thinking `xhigh=47 high=21 medium=7`；model `gpt-5.6-sol=44 grok-4.6=14 gpt-6-astra=13 claude-opus-5=4`。≥30m 仅 4 个：`StorageCompletionReview` 47.401 / astra xhigh；`SpecAxis` 42.351 / sol xhigh；`CompactionGate` 42.312 / astra medium；`StandardsAxis` 33.068 / sol high。

scout n=34：thinking `max=30 low=2 xhigh=2`；model `deepseek-v4-flash=32 grok-4.6=1 gpt-5.6-sol=1`。p90=13.94；唯一 ≥20m：`SmokeScout` 20.175 flash max。仓库 bundled `scout.md` 现为 `thinking-level: medium` / `read-summarize: true` / fallback `grok-4.6:high`。本窗口 30/34 scout 仍观测到 `max`。`[未知]` 这 30 个是用户覆盖、旧二进制、还是 spawn 未吃 bundled frontmatter。

other n=88：model `deepseek-v4-flash=50 grok-4.6=21 claude-opus-5=8 gpt-6-astra=5 gpt-5.6-sol=3 gpt-5.6-terra=1`；thinking `max=43 xhigh=15 high=13 medium=9 low=7 minimal=1`。≥30m=18，其中 flash=13 且 think=max，grok=5 且 think=xhigh。≥60m 四个全是 2026-09-05 flash max：`LifecycleOwner` 167.177、`AdmissionOwner` 166.559、`StorageOwner` 108.550、`PureTransform` 60.016。另有 `MaintenanceTests` 59.940 / file_wall 60.001、`RecallAdmissionTests` 59.917 / file_wall 60.001。`[INFERENCE]` 59.9–60.0 与默认 `task.maxRuntimeMs=1h` 贴边，但是否被硬 cap 截断需对照 completionKind，本脚本未解析该字段。`[未知]` 167 min 是单次 run 逃逸、follow-up 重置、还是 IRC 续跑。

父 hub（新鲜窗口）：counted=1140 matched=1140；duration p50=0.00 p90=3.00 max=32.39；≥20m=2 ≥30m=1。p90 正好 3.00 min 与历史「满超时轮询」同型，但是否仍为 wait 超时本脚本未拆 `hub.op`。

## 3. 已落地产品合同（工作区源码，2026-09-06 读取）

以下为直接读源码的事实，不是语料因果。

- `packages/coding-agent/src/task/review-performance.ts`：`SubagentPerformanceClass = review|explore|worker`。explore 名 `scout`/`sonic` 优先；floor 名 `reviewer`/`subagent-sol`/`sol-xhigh-reviewer`/`security-reviewer`；`agentShadowReview==="code"` 或 `spawnShadowReview==="code"` → review；否则 worker。review ceiling 1_800_000 ms；explore 600_000 ms；worker ceiling = Infinity。explore soft budget 40；reviewer-name 80。75% = `REVIEWER_SOFT_RUNTIME_RATIO`，`resolveClassSoftRuntimeMs` 对 worker 返回 0。
- CHANGELOG Unreleased：structured subagents 在 fresh discovery 后分类；review 30 min/80 req；scout/sonic 10 min/40 req；75% 为 advisory 而非 `budget_stop`；bundled scout 默认 medium summarized reads。
- `packages/coding-agent/src/prompts/agents/scout.md`：tools 含 `code_intel`；model flash:max → grok-4.6:high；`thinking-level: medium`；`max-effort: medium`；`read-summarize: true`。
- `packages/coding-agent/src/prompts/agents/reviewer.md`：`thinking-level: medium`；`max-effort: xhigh`；`shadow-review: code`。
- `packages/coding-agent/src/prompts/system/subagent-system-prompt.md`：explore/review/worker 分支 keep-going；仅 worker 保留 “MUST keep going until this ticket is closed”。
- `packages/coding-agent/src/task/executor.ts`：`buildSoftRuntimeNotice` 渲染静态 prompt；75% timer 只 `sendWrapUpNotice` / steer，不 `requestBudgetStop`。hard cap 仍 `requestAbort("timeout")`。注释仍写 “Disabled by default; set task.maxRuntimeMs > 0”（与 settings 默认 1h 不一致）。
- `runSubagentFollowUpTurn`：`softRequestBudget: 0`，`maxRuntimeMs: options.maxRuntimeMs ?? 0`。
- `attachIrcWakeTurnMonitor`：`softRequestBudget: 0`，`maxRuntimeMs = options.maxRuntimeMs ?? 0`。
- 仓库无 `cumulativeRequests` / `cumulativeActiveMs` 符号。
- Vibe 首轮 `#buildSpawnOptions` 已传 `performanceClass: resolveSubagentPerformanceClass(...)`。
- `packages/coding-agent/src/latency/active-wall.ts` 已存在 pure helper。
- latency arms：`modelOptimization.enabled` 与 `readDedupe` 默认 on；其余行为改变 arm 默认 off。本轮不把 arm 矩阵当未落地主缺口，除非设计需要。

本机用户 agent（非产品默认，不得当产品唯一修复）：

- `~/.omp/agent/agents/subagent-grok.md`：`thinking-level: high`；`max-effort: high`；`readSummarize: false`；`output-truncation: false`。
- `~/.omp/agent/agents/subagent-astra.md`：`thinking-level: medium`；`max-effort: medium`；`readSummarize: false`。
- 二者均不在 `REVIEWER_SOFT_REQUEST_BUDGET` 名字表。评审 spawn 若带 `shadowReview: "code"` 会进 review class（30 min/80）；设计 author spawn 省略该旗标则保持 worker。

## 4. 8/30 拟议验收 vs 本轮观测

8/30 设计拟议目标（**不是**已测达标声明）：产品 scout 活跃 p50≤5.0 / p90≤8.0；产品 reviewer p50≤12.0 / p90≤20.0；用户可见 review/gate p50≤16.0 / p90≤24.0，≥30 min ≤3/同口径 n；用户 scout p50≤5.0 / p90≤8.0。

本轮 8/31–9/06 **用户可见文件名类**（不是隔离产品 fixture）：

- scout n=34：p50=3.70 低于 5.0；p90=13.94 **高于** 8.0；max=20.18
- review/gate n=75：p50=7.28 低于 16.0；p90=23.95 **略低于** 24.0；≥30m=4 **高于** 3
- other 把 ≥60m 长尾几乎独占（4/4）

不得把 p50 下降写成「已有优化造成 X%」。对照窗口 review p50=8.47 vs 新鲜 7.28 是观测差，混有 workload / 模型 / 覆盖 / 样本量变化。

## 5. 1–2 小时干活型样本（2026-09-06 对 JSONL 的只读复算）

文件：`~/.omp/agent/sessions/-tencent-oh-my-pi/2026-09-05T10-00-47-846Z_01a07103-77e6-7000-b7e0-13f627124f4b/LifecycleOwner.jsonl`。

- `session_init.agent = "task"`（bundled worker 名，不是 scout/reviewer）。`resolvedModel = gateway/deepseek-v4-flash:max`。tools 含 `read,bash,edit,eval,glob,grep,task,hub,web_search,write,yield,...`。`spawns = "*"`。`readOnly = false`。`[历史事实]`
- 系统提示含 `You MUST keep going until this ticket is closed. This matters.`（`sys_len=30809`）。`[历史事实]`
- assistant 276 条；首条 `2026-09-05T10:07:09.082Z`，末条 `2026-09-05T13:20:15.077Z`；首末跨度 193.1 min。相邻间隔 >10 min 仅 1 次（25.9 min，asst idx 37）。活跃墙钟 167.177 min（CSV）。`[历史事实]`
- 间隔前 38 条 assistant 活跃 8.9 min；间隔后 238 条活跃 158.3 min。因此长尾是**同一 jsonl 内连续干活**，不是 19 小时 park 口径。`[历史事实]`
- `yield` 工具：1 次 call + 1 次 result，时间戳均为 `13:20:15`（会话末尾）。CSV `yield_n=2` 即这对。中间没有提前收工。`[历史事实]`
- 工具（toolResult 名）：read 110、grep 80、edit 74、eval 20、hub 17、glob 10、write 2。这是实现切片，不是只读 scout。`[历史事实]`
- user 消息 23 条：第 1 条是 assignment；其余 22 条 `attribution=agent` 且 `steering=true`，正文为 `Current interruptible wait interrupted: IRC message from parent agent Main.` 后接父 IRC 协调（兄弟 owner API、验收提醒）。这些是父→子 IRC steer，不是新的 `runSubagentFollowUpTurn` assignment。`[历史事实]`
- 同父会话同日还有 `AdmissionOwner` 活跃 166.559 / 文件 217.391（asst 351，yield 2）、`StorageOwner` 108.550 / 160.961（yield 10）。三者同模型 `flash:max`。`[历史事实]`
- `MaintenanceTests` / `RecallAdmissionTests` 活跃 59.94 / 59.92，文件墙钟 60.001。贴默认 1h。本脚本仍未解析 `completionKind`，不能证明 hard cap。`[未知]`

同窗口 `other` ≥30 min：18/88，其中 flash+max=13、grok+xhigh=5。≥60 min 的 4/4 全是 2026-09-05 flash max worker 名文件。`[历史事实]`

## 6. pi 官方示例子代理（本机源码，不是 omp 产品）

路径：`/Users/sheng/tencent/pi/packages/coding-agent/examples/extensions/subagent/`。README 写明 Pi 核心 harness **没有内置 sub-agents**；该目录是可安装扩展。

- 完成协议：`index.ts` `getFinalOutput` 从消息列表**倒序找最后一条 assistant 的 text part**。没有 `yield` 工具。`[历史事实]`
- 进程：`runSingleAgent` `spawn` 新的 `pi` 进程，args 含 `--mode json -p --no-session`（独立进程、不写父 session）。`[历史事实]`
- 并行：`MAX_PARALLEL_TASKS=8`，`MAX_CONCURRENCY=4`，每任务模型可见输出 50 KB。`[历史事实]`
- scout.md：`model: claude-haiku-4-5`；tools `read, grep, find, ls, bash`；任务是「快速调查并返回压缩发现」，无 keep-going。`[历史事实]`
- worker.md：`model: claude-sonnet-4-5`；「Work autonomously to complete the assigned task」；结束输出 `## Completed` / `## Files Changed`。无「until this ticket is closed」。`[历史事实]`
- reviewer.md：sonnet + 只读 bash（git diff/log/show）；输出 Critical/Warnings/Suggestions。无 shadow 四维。`[历史事实]`
- 默认 thinking：pi `packages/coding-agent/src/core/defaults.ts` `DEFAULT_THINKING_LEVEL = "medium"`。`[历史事实]`
- UI：collapsed 显示状态图标 + 最近 5–10 项 tool/text + 用量；并行 live ⏳/✓/✗。这是可见性，不是墙钟证明。`[历史事实]`
- 本机无 pi 会话 JSONL 对照 p50。pi 示例墙钟 `[未知]`。

## 7. Cursor 公开子代理合同（官方文档，不是内部源码）

来源：<https://cursor.com/docs/context/subagents>（2026-09-06 读取）。

- 子代理在**独立上下文**中运行；父必须把所需信息放进 prompt；中间输出不进父窗口。文档把收益写成隔离，不是速度基准。`[历史事实]`
- 「It returns a final message with its results to the parent agent。」公开完成协议是 **final message**，不是 yield 工具。`[历史事实]`
- 前台阻塞直到结束；后台立即返回，可并行。完成后可用 agent ID resume，保留上下文。`[历史事实]`
- Explore 等内置类型存在于文档/产品描述；Cursor Explore 实测 p50/p90 仍 `[未知]`。内部 runtime / keep-going 是否存在 `[未知]`。

## 8. 与 omp 执行合同的对照（源码事实）

- omp `runSubprocess` / 冷恢复均 `requireYieldTool: true`（`executor.ts` 约 3491；`persisted-revive.ts` 约 135）。`[历史事实]`
- worker 系统提示：`While work remains, you MUST continue with another tool call` + `You MUST keep going until this ticket is closed.` explore/review 已分支，**仅 worker** 保留该句。`[历史事实]`
- `session_init`（`session-entries.ts`）已有 `agent` / `tools` / `outputSchema` / `spawns` 等，**没有** `performanceClass`。`peekSessionInit` 也不拷贝该字段。冷恢复 `wakeAgent` 只有 `name: ref.displayName`。`[历史事实]`
- 8/30 设计曾把「explore 改 final message（`requireYieldTool: false`），review/worker 仍 yield」列为更深方案 B 并拒绝，理由是当时没有「A 达不到分钟级」的已确认约束。用户本轮跟进把「参考 pi/Cursor 简化执行、大幅降低」写成目标，该约束已变。`[历史事实]`

## 9. 未确认 / 未知

- `LifecycleOwner` 间隔 25.9 min 是 park、IRC 等待、还是进程空闲。间隔后仍连续 158 min 活跃。`[未知]`
- 贴 60.000 文件墙钟是否 `completionKind=timeout`。`[未知]`
- 30/34 scout 观测 `thinking=max` 而 bundled scout 已是 medium 的原因。`[未知]`
- 父 `task` spawn ack ≈0；子活跃才是 subagent 耗时。`[历史事实]`
- 父 task `args.tasks` 未出现 → 不能复算 8/26 的 size=1=59%。`[未知]`
- Cursor / pi 示例的实测 p50/p90。`[未知]`
- 用户端到端等待里父模型 TTFT 占比。`[未知]`
- 质量非回退本轮未跑 fixture。`[未知]`
- 把 worker 改为「工具循环结束 + 最终文本即返回」后，Gate first-pass 与漏修率如何变化。`[未知]`
