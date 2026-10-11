# Design: 近期 omp subagent / reviewer / task 耗时优化（简化执行 + follow-up/IRC 预算）

- Date: 2026-09-06
- Status: Implemented
- Scope: M（在现有 `executor.ts` + `review-performance.ts` class 内改完成合同、session_init 字段与五处预算入口；不是新引擎；不是 L 级公开契约或不可逆改动）
- design_author: grok
- design_author_identity: GrokDesignAuthor
- planned_reviewer: GPT-6-astra / subagent-astra
- implementation_authorization: authorized
- authorization_source: 用户 2026-09-06 跟进明确要求「改完就开始实现。不需要再次复审」，覆盖原 design-only 边界。

## 1. 设计目标和范围

### 1.1 要解决的问题

- 用户第一轮：分析近期 omp 历史会话（尤其 subagent / reviewer / task）耗时，并在已落地的 8/30 class / scout / 75% advisory 之上设计完整方案。`[历史事实]`
- 用户同一会话跟进（2026-09-06）：通俗解释主要耗时点；解释为何少数「干活型」能跑到 1–2 小时；**参考 pi 与 Cursor 的 subagents，简化执行过程，大幅降低子代理任务耗时**。这不是「只补 follow-up/IRC 预算=0」。授权仍为 design-only。`[历史事实]`
- 第一次 Gate（`AstraDesignGate` / `gateway/gpt-6-astra`）对「只补预算=0」稿给出 `NEEDS_REVISION`：冷恢复 `wakeAgent` stub 只有 `ref.displayName`，frontmatter / spawn `"code"` 都会丢；不能一边写降级、一边要求四入口永远同 class。本修订吸收该条：把已解析 `performanceClass` 写入现有 `session_init`。`[历史事实]`

**通俗：时间主要花在哪**

1. **子代理自己在干活**（主头）。活跃墙钟来自子 jsonl 的 assistant 间隔，不是父 `task` 调用。父 task 匹配耗时 p50=0.00 min，几乎全是立刻返回的 spawn ack。`[历史事实]`
2. **干活型 worker 被合同拖住**。`LifecycleOwner`（`session_init.agent="task"`，`flash:max`）系统提示含 “MUST keep going until this ticket is closed”；`requireYieldTool: true`；276 条 assistant 里 **yield 只在会话末尾 13:20:15 出现一次**。活跃 167.177 min，中间只有 1 次 >10 min 间隔（25.9 min），间隔后仍连续 158.3 min。这是同一 jsonl 里一直在 read/grep/edit，不是 19 小时 park。`[历史事实]`
3. **父 IRC 插话会续跑，但不是新 assignment**。该样本 23 条 user 里 22 条是 `steering=true` 的父 IRC（`Current interruptible wait interrupted...`）。它们不是 `runSubagentFollowUpTurn`。`[历史事实]`
4. **跟进轮 / IRC monitor 把预算打成 0**，热 IRC 只传墙钟、冷 IRC 墙钟也不传，续跑可以不受 1h/200 约束。`[历史事实]`
5. **不是主头、本轮不当事故修**：父 hub p90=3.00 min（是否满超时轮询未拆 `hub.op`）；scout 窗口 p90 仍高于 8/30 拟议门槛；用户可见 review 仍有 4 条 ≥30 min。这些不得写成因果，也不靠改 scout.md / 按 flash 降档来「假装修好」。`[历史事实]` / `[未知]`

**为何干活型能跑过 1 小时甚至接近 3 小时文件跨度**

- worker 没有 review/explore 那种 30/10 min class 顶，省略 cap 时硬顶是 `task.maxRuntimeMs` 默认 1h，且 **没有 75% timer**。`[历史事实]`
- 提示要求工单不关就继续工具循环；运行时又强制 yield 才算完成 → 模型可以（也被要求）一直调用工具，直到最后才交卷。`LifecycleOwner` 就是这种形态。`[历史事实]`
- 若跟进轮 / IRC 预算为 0，单轮 1h 也拦不住跨入口续跑。167 min 是单轮逃逸、follow-up 重置还是 IRC 续跑仍 `[未知]`；但「keep-going + 晚 yield + 无 class 顶」已足够解释**同一 jsonl 内连续 167 min 干活**。`[历史事实]` / `[未知]`

**pi / Cursor 对照（简化什么、不克隆什么）**

- pi 官方示例子代理（`/Users/sheng/tencent/pi/packages/coding-agent/examples/extensions/subagent/`）：`getFinalOutput` 倒序取最后一条 assistant 的 text part；**没有 yield 工具**；worker.md 是 “Work autonomously to complete the assigned task”，输出 `## Completed`，**无** “until this ticket is closed”；进程是 `spawn` + `--mode json -p --no-session`。pi 示例墙钟 `[未知]`。`[历史事实]`
- Cursor 公开文档：子代理在独立上下文，**「returns a final message with its results」**；文档把收益写成隔离，不是速度基准。Explore 实测 p50/p90 `[未知]`。`[历史事实]`
- 用户要的是 **用现有 harness 简化完成合同**，不是再造一套 OS 子进程 / 第二 completion engine。pi 的速度证据是示例的完成画像，不是「必须 subprocess」。`[推导]`

8/30 已闭合、本轮不得重做：performance class 判定矩阵、explore 10 min/40 req、review 30 min/80 req、75% advisory 机制、bundled scout.md medium+summarize、vibe 首轮 class wiring、`computeActiveWallMs`。`[历史事实]`

### 1.2 成功标准

同时满足。分位数只作观测，**不得**写成 treatment 因果，也不得仅凭 p50 移动宣称「大幅降低」。

**行为合同** `[拟议验收目标]`

1. **worker / explore 结束规则**：去掉无条件 “MUST keep going until this ticket is closed” 与 “While work remains, you MUST continue with another tool call”。模型在**一轮无工具调用的 assistant 最终文本**之后即完成（对齐 pi `getFinalOutput` / Cursor final message）。不是「出现任何文本就退出」，也不是「每调用一次工具就退出」。模型若仍调用 `yield`，该次 yield 仍是合法终态。
2. **review / Gate**：保持 `requireYieldTool: true` 与 structured schema；独立 Design Gate 仍在；不把双轴并进父进程。
3. **不自动续跑**：自然结束后不自动再开一轮 follow-up；只有显式新 assignment 或父 IRC / 用户消息才启动下一 run。
4. **预算（五处入口）**：首轮 / follow-up / IRC 热 / IRC 冷 走同一 `resolveRunMonitorBudgets`。配置值本身为 0 表示显式关闭，除外时得到非 0 预算。worker 省略 cap 的硬顶仍是 `task.maxRuntimeMs` 默认 1h，不另造短于 1h 的 worker ceiling。
5. **冷恢复 class**：新写入的 `session_init.performanceClass` 存在时，冷恢复用该值决定预算与 `requireYieldTool`（review=true，worker/explore=false）。**不得**声称「缺字段的旧文件四入口永远与首轮同 class」。旧文件确定性回退见 §5.2。
6. **75%**：review/explore 仍 advisory（steer，不置 `budgetStopRequested`）。worker 仍 `resolveClassSoftRuntimeMs=0`，不挂 75% timer。硬超时 / 1.5× 请求强停 / salvage 不丢合法 payload。
7. `timeout` / `budget_stop` / 缺口不得计 PASS；不得靠砍任务假加速。

**测量合同** `[拟议验收目标]`

- 实现后新的父目录日期窗口；脚本仍 `/tmp/omp_recent_latency.py`；活跃墙钟仍 `computeActiveWallMs`。无插补。
- 报告 n / p50 / p90 / p95 / max / ≥30 / ≥60，按文件名类 **以及** 观测 model/thinking。父活跃并列，不与子活跃、文件墙钟混用。
- 必须单列：worker 名（文件名类 `other` / `session_init.agent=task`）长尾；若仍出现 `LifecycleOwner` 同类（flash max、keep-going 残留、晚 yield）单独报告。
- 字段存在时，另报 assistant 请求数，以及**第一次自然停止之后**额外的 steer / follow-up 轮数。
- 拟议观测门槛（**不是**已证明会达到，禁止当因果）：相对 2026-08-31–09-06 窗口文件名类 `other` n=88、p90=46.87、≥60m=4，新窗口同口径 `other` 的 p90 与 ≥60m 计数应下降。未降不得宣称成功，降了也不得写成「已有优化造成 X%」。

**质量合同** `[拟议验收目标]`

- 与 8/30 相同：live required review cases 每次 `firstPassed===true`；`timeout` 不是 PASS。本轮不改判定器。worker/explore 改完成合同后的 Gate first-pass / 漏修率变化是 `[未知]`，用现有质量门观测，不预先放宽。

### 1.3 本次范围

- 在**同一个**现有 runtime 内：改 worker/explore 完成合同（提示 + `requireYieldTool`）；review 仍 yield。
- 将已解析 `performanceClass` 写入现有 `session_init`；`peekSessionInit` 拷贝；冷恢复用它。
- 闭合上一稿的五处预算=0 调用面；每轮重置；累计仍不受限。
- 写清 default vs 显式 override，以及旧文件缺 `performanceClass` 的确定性回退。
- 文件级细节只覆盖推荐方案将改路径。

### 1.4 非目标

- 不新建 scheduler、第二套 completion engine、生命周期累计账本（`cumulativeRequests` / `cumulativeActiveMs`）。
- 不克隆 pi 的 OS subprocess / `--no-session` 进程模型，不追求 Cursor 内部 runtime 复刻。
- 不新增 feature flag、遥测管道。
- 不把改本机 `~/.omp` 当产品修复。
- 不重做 8/30 class 判定矩阵、scout.md 合同、75% advisory 机制。
- 不把 75% 改回强停，也不做 90% forced-stop 重写。
- 不按模型名全局降档（含 `deepseek-v4-flash`）；不把 worker 默认 thinking 当已证明速度杠杆。
- 不取消独立 Gate，不把双轴并进父进程。
- 不把父 task spawn ack 当子墙钟；不把活跃墙钟写成端到端用户等待。
- 不为「以后可能」提前上累计账本。

## 2. 背景与约束

**复算口径（本轮唯一数字来源）** `[历史事实]`

- 脚本 `/tmp/omp_recent_latency.py`；输出 `/tmp/omp_latency_2026-09-06/summary.md`；生成 `2026-09-06T09:29:27.393066+00:00`。
- 根目录 `/Users/sheng/.omp/agent/sessions`。无插补；活跃墙钟与 `packages/coding-agent/src/latency/active-wall.ts` 同算法；文件墙钟 ≠ 活跃墙钟。
- 子会话按**文件名**分类。扫描：项目 39，排除 268；父 jsonl 625，子 jsonl 1602；parse_errors=0。

**窗口观测（不得当因果）** `[历史事实]`

| 窗口 | 子活跃 n | p50 | p90 | p95 | max | ≥30m | ≥60m |
|---|---:|---:|---:|---:|---:|---:|---:|
| 全量非 tmp | 1568 | 10.66 | 32.56 | 45.02 | 185.33 | 184 | 32 |
| 2026-08-27–08-30 | 150 | 11.13 | 23.22 | 32.94 | 55.45 | 11 | 0 |
| 2026-08-31–09-06 | 234 | 7.44 | 31.25 | 45.73 | 167.18 | 24 | 4 |

新鲜窗口补充：子文件墙钟 n=238 p50=13.97 p90=43.80 max=217.39；父活跃 n=109 p50=21.68 p90=114.93 max=390.67。活跃墙钟 ≠ 端到端等待。按文件名类：review/gate n=75 p50=7.28 p90=23.95 ≥30m=4；scout n=34 p50=3.70 p90=13.94；other n=88 p50=8.82 p90=46.87 ≥30m=18 ≥60m=4。oh-my-pi 子集 n=107 p50=8.50 p90=45.90，other n=56 ≥60m=4。父 task counted=156 duration p50=0.00 max=0.01；`batch_events=0`。父 hub n=1140 p50=0.00 p90=3.00。`[历史事实]`

**干活型样本（facts brief §5）** `[历史事实]`

- `LifecycleOwner.jsonl`：`agent="task"`，`resolvedModel=gateway/deepseek-v4-flash:max`，tools 含 read/bash/edit/eval/grep/task/hub/yield，`spawns="*"`，`readOnly=false`。
- 系统提示含 keep-going（`sys_len=30809`）。assistant 276；首末跨度 193.1 min；活跃 167.177 min。
- yield：1 call + 1 result，均在 `13:20:15`。工具：read 110、grep 80、edit 74、eval 20、hub 17、glob 10、write 2。
- 同日 `AdmissionOwner` 166.559 / `StorageOwner` 108.550，同为 flash max。`MaintenanceTests` / `RecallAdmissionTests` 活跃 ≈59.9、文件墙钟 60.001；是否 timeout `[未知]`。

**产品合同** `[历史事实]`

- class：explore 名 `scout`/`sonic` 优先；floor 名 `reviewer`/`subagent-sol`/`sol-xhigh-reviewer`/`security-reviewer`；frontmatter 或 spawn `"code"` → review；否则 worker。review 30 min/80；explore 10 min/40；worker ceiling=Infinity、75%=0、请求预算默认 200。
- `runSubprocess` / 冷恢复均 `requireYieldTool: true`（`executor.ts` 约 3504；`persisted-revive.ts` 约 135）。
- `subagent-system-prompt.md`：explore/review 已分支；**仅 worker** 保留 keep-going 两句。
- `runSubagentFollowUpTurn`：`softRequestBudget: 0`，`maxRuntimeMs: options.maxRuntimeMs ?? 0`（约 2883–2886）。
- `attachIrcWakeTurnMonitor`：内部预算 0，`maxRuntimeMs ?? 0`（约 2597、2623–2626）。
- `installIrcWakeTurnMonitor`（约 3109–3124）传墙钟、不传请求预算 / class。
- `persisted-revive.ts` 约 183–191：不传 `maxRuntimeMs`；`wakeAgent` 只有 `name: ref.displayName`。
- vibe 跟进轮（`vibe/runtime.ts` 约 1536–1545）不传 `maxRuntimeMs` / `performanceClass`。
- `SessionInitEntry`（`session-entries.ts`）无 `performanceClass`；`peekSessionInit` 不拷贝该字段；`appendSessionInit`（`executor.ts` 约 3657–3673）也不写。
- 仓库无 `cumulativeRequests` / `cumulativeActiveMs`。

**约束**

- 复用 canonical owner：class 在 `review-performance.ts`（**不改矩阵**），运行 / 完成 / monitor 在 `executor.ts`，冷恢复在 `persisted-revive.ts`，session 字段在现有 `session_init`。禁止第二 runtime。
- 数字只来自 facts brief / summary.md。禁止 45–90s、35%、36% 或因果改善百分比。
- 8/30 曾把「explore `requireYieldTool: false`」列为更深 B 并拒绝；用户本轮跟进把「参考 pi/Cursor 简化执行」写成目标，该约束已变。本轮把 **worker+explore** 的 final-text 完成放进更浅 A，review 仍 yield。`[历史事实]`
- design-only：Gate PASS 后停止。

## 3. 根因分析（按需）

### 3.1 是否需要根因分析

- 需要（服务 A/B 选型与通俗解释）。
- 理由：用户明确问「时间花在哪 / 为何 1–2h」；跟进把完成协议纳入范围；Gate 指出冷恢复输入缺口。这些会改变推荐方案，而不是只补数字 0。

### 3.2 已确认事实

- 新鲜窗口 ≥60 min 的 4/4 在文件名类 `other`，全是 2026-09-05 `flash:max`。`LifecycleOwner` 是 bundled worker 名 `task`，keep-going 提示 + 末尾才 yield + 同一 jsonl 连续干活 167 min。`[历史事实]`
- 全体子代理 `requireYieldTool: true`；worker 提示强制继续工具循环直到关单。pi 示例与 Cursor 公开合同都是最终文本 / final message，无该 keep-going。`[历史事实]`
- 五处预算入口仍把省略收成 0（follow-up、IRC attach 内部、热 install 缺请求预算、冷 attach 缺墙钟、vibe 跟进轮不传）。`[历史事实]`
- `session_init` 无 `performanceClass`；冷 `wakeAgent` 无 `shadowReview`；resolver 的 frontmatter / spawn `"code"` 在冷路径上不可得。`[历史事实]`
- 167 min 的单轮 vs 多轮归属仍 `[未知]`；间隔 25.9 min 是 park / IRC 等待 / 空闲亦 `[未知]`。间隔后仍有 158 min 活跃。`[历史事实]` / `[未知]`

### 3.3 未确认假设

- 改完成合同后，worker 活跃 p90 / ≥60m 会降多少。`[未知]`
- 贴 60.000 文件墙钟是否 `completionKind=timeout`。`[未知]`
- 30/34 scout 仍观测 `max` 的原因。`[未知]`
- Cursor / pi 示例实测 p50/p90。`[未知]`
- 父 TTFT 占用户端到端多少。`[未知]`
- worker 改为最终文本后 Gate first-pass / 漏修率。`[未知]`
- flash:max 是否为 167 min 的原因。共现不是因果。`[未知]`

### 3.4 对设计的影响

- **主杠杆是完成合同，不是再短一截 cap。** 只补预算=0 不会拿掉 “keep going until this ticket is closed”，也不能让无工具最终文本结束 run。用户跟进已把简化执行写成目标。`[推导]`
- **review 必须继续 yield。** 独立 Gate + structured verdict 是质量绝对合同；把 review 改成 final message 会碰到 schema / 双轴。A 只放宽 worker/explore。`[历史事实]`
- **不克隆 pi 进程。** 用户要求参考完成画像，现有 in-process executor 已能设 `requireYieldTool: false`（shadow / advisor 已用）。subprocess 是更深 B。`[历史事实]`
- **冷恢复必须持久化 class。** Gate P2：仅用 `ref.displayName` 会把 frontmatter `"code"` 与 spawn `"code"` 的非 floor 名打成 worker。成功标准不能写「四入口永远同 class」，除非新文件把 class 写进 `session_init`。旧文件回退必须写清。`[历史事实]`
- **累计账本仍无已确认必要。** 167 min 归属未知；A 的每轮预算 + 完成合同已对准用户目标。`[未知]` / `[推导]`

## 4. 方案对比

### 4.1 方案 A — 现有 runtime 内简化 worker/explore 结束规则 + 持久化 class + 闭合预算=0（更浅，推荐）

- 核心思路：仍用 `executor.ts` + `review-performance.ts` class。worker/explore：去掉无条件 keep-going；工具循环结束后的最终 assistant 文本即结果；`requireYieldTool: false`；显式 yield 仍合法。review：继续 `requireYieldTool: true`。已解析 `performanceClass` 写入现有 `session_init`，冷恢复读取。五处预算入口走同一 resolver；每轮重置。不新造 scheduler、不克隆 pi 进程、不上累计账本。
- 优点：对准用户「简化执行」与 Gate「冷恢复要有 class」；改动落在已有 prompt / session_init / monitor 入口；review 质量合同不动；pi/Cursor 的完成语义被吸收，进程模型不被吸收。
- 缺点：每轮重置仍不能限制多次 follow-up 的累计墙钟；旧 jsonl 无 class 字段时 spawn/frontmatter `"code"` 仍降级；完成合同变更后的质量幅度 `[未知]`。
- 适用前提：成功标准是「干活型不再被 keep-going + 强制 yield 拖住，且新会话冷恢复能找回 class」，而不是「生命周期累计 ≤1h」或「必须 OS 隔离」。该前提被用户跟进与 Gate 同时支持。`[历史事实]`

### 4.2 方案 B — 第二 completion engine / pi 进程克隆 / 生命周期累计账本（更深，默认不选）

- 核心思路：为子代理另起 OS subprocess（克隆 pi `--no-session`），或另写一套 completion engine 对齐 Cursor 隔离 runtime；和/或在 registry 上累计 `cumulativeRequests` / `cumulativeActiveMs`。
- 优点：若日后证实必须进程隔离才能稳，或 167 min 被证实是多轮重置且 A 的每轮 cap 不够，B 才有必要。
- 缺点：第二引擎、新序列化、与现有 keep-alive / IRC / vibe / salvage 全面分叉。用户明确要求用现有 harness 简化，不是克隆 pi 进程。pi 速度证据是完成+画像，不是 subprocess。累计账本对未知的 167 min 归属仍是过度设计。
- 适用前提：必须先有「A 的完成合同 + 每轮预算无法满足已确认约束」的证据。当前没有。`[未知]`

### 4.3 选型结论

- 选择：方案 A。
- 理由：A 覆盖用户跟进（简化执行）与 Gate（持久化 class）以及上一稿已确认的预算=0。B 没有已确认的必要约束。两方案都能谈「降耗时」时必须选更浅落地。禁止用「以后更像 Cursor / 必须 subprocess」升级。A 写明：累计墙钟仍不受限；旧文件缺字段仍有 class 降级。

## 5. 详细方案

> 只展开方案 A。

### 5.1 核心思路

- **一个 runtime**：不新增模块。class 仍只在 `review-performance.ts` 判定；本轮不改矩阵。
- **完成合同按 class 分支**：worker/explore 最终文本即可结束；review 仍强制 yield。
- **一个预算 seam**：`resolveRunMonitorBudgets`（`executor.ts`），首轮 / follow-up / IRC 热 / IRC 冷共用。
- **一个持久化字段**：现有 `session_init.performanceClass`（字符串联合，不从 session-entries import class 模块，避免环依赖）。不是累计账本。
- **每轮重置**：每个 follow-up / 每次 IRC wake 新 monitor。累计不受限。
- **75% / 1h worker 硬顶不变**。

### 5.2 关键数据流 / 控制流

1. **提示（worker/explore 结束规则）**

   改 `packages/coding-agent/src/prompts/system/subagent-system-prompt.md`：
   - 删除 worker 分支的 “While work remains, you MUST continue with another tool call…” 与文件末尾 “You MUST keep going until this ticket is closed. This matters.”
   - review 分支保持：verdict 就绪或 wrap-up steer 则 terminal-yield。
   - worker **与** explore 共用：工具用完后，写最终 assistant 文本并停止调用工具；该文本即结果；**可以**再 `yield`，但不要求。更宽的工单仍开着不是继续搜的理由。
   - 不是「任何文本都退出」：含 tool_call 的 assistant 回合继续跑工具循环。
   - 不改 `scout.md`（8/30 已落地）。

2. **运行时 `requireYieldTool`**

   `runSubprocess` 的 `buildSubagentSessionOptions`（约 3504）改为：
   `requireYieldTool: (options.performanceClass ?? "worker") === "review"`。
   冷恢复 `persisted-revive.ts` 约 135 同样按**持久化或回退得到的 class** 设，不得再写死 `true`。
   worker/explore 自然结束条件（落在现有 `driveSessionToYield` / session 结束路径上，不新写 engine）：
   - assistant 回合结束，且该回合**没有** tool_call，且没有未完成的 yield pending → 以最后一条 assistant 文本为结果（pi `getFinalOutput`）；`completionKind` 走现有 `completed`（非 timeout/budget）。
   - 若模型调用了 terminal yield → 仍按现有 yield 装配，合法。
   - 有工具则继续。硬 cap / 1.5× 预算路径不变。
   - 自然结束后 **不** 自动 `runSubagentFollowUpTurn`。下一 run 仅来自显式 assignment 或父 IRC/用户消息（现有 attach observer / vibe 跟进轮）。

3. **预算解析（与上一稿相同，五处必须改）**

   `resolveRunMonitorBudgets({ performanceClass, settings, maxRuntimeMs?, softRequestBudget? })`：

   | 字段 | 显式 override | 否则 |
   |---|---|---|
   | `maxRuntimeMs` | 传入含 `0` 权威，不套 class ceiling | `configured = settings.task.maxRuntimeMs`（默认 1h）；`configured===0` 无限；否则 `min(configured, resolveClassMaxRuntimeMs(class))`。worker ceiling=Infinity |
   | `softRequestBudget` | 传入含 `0` 权威 | `resolveSoftRequestBudget(class, settings.task.softRequestBudget ?? 200)` |
   | `softRequestBudgetNotice` | 无新字段 | 现有 settings |
   | `performanceClass` | 入口传入或 `session_init` 持久化值 | 见第 5 步回退；不得在 executor 另写一套名单 |

   省略 ≠ 显式 0。禁止再写 `?? 0` 把省略收成关闭。

   必须改的调用面：
   1. `runSubagentFollowUpTurn`（约 2883–2886）删除 `softRequestBudget: 0` 与 `maxRuntimeMs ?? 0`。
   2. `attachIrcWakeTurnMonitor`（约 2597、2623–2626）删除内部 0；省略走 resolver。
   3. `installIrcWakeTurnMonitor`（约 3109–3124）传入 class、请求预算、settings，不得只传墙钟。
   4. `persisted-revive.ts` 约 183–191 传入解析结果（含墙钟）。
   5. `vibe/runtime.ts` 约 1536–1545 传入 `performanceClass` 与 `settings: session.settings`（与 `#buildSpawnOptions` 同一 resolver 输入）。

4. **把 class 写入现有 `session_init`（吸收 Gate）**

   首轮 `appendSessionInit`（`executor.ts` 约 3657）增加 `performanceClass`：已解析值（`options.performanceClass ?? resolveSubagentPerformanceClass({ agentName: agent.name, agentShadowReview: agent.shadowReview, spawnShadowReview: options.shadowReview })`）。
   `SessionInitEntry` 与 `appendSessionInit` 参数、`peekSessionInit` 的 copy 列表都增加可选字段 `performanceClass?: "review" | "explore" | "worker"`。session-entries **不** import `review-performance.ts`。

5. **冷恢复如何用 class（成功标准必须与 stub 一致）**

   `peekSessionInit` 读到字段后交给 revive：
   - **有 `init.performanceClass`**（新文件）：该值权威。`requireYieldTool = class==="review"`。预算 = `resolveRunMonitorBudgets({ class, settings: ctx.settings })`。**此时**冷 IRC 与首轮 class 相同。
   - **无该字段**（旧文件）：`class = resolveSubagentPerformanceClass({ agentName: init.agent ?? ref.displayName })`。**只有名字**。确定性降级（测试必须用真实 stub，禁止手工注入 `shadowReview` 来假绿）：

   | 旧文件真实输入 | 回退 class | 相对首轮 |
   |---|---|---|
   | 名字 ∈ floor 四名 | review | 同 |
   | 名字 ∈ scout/sonic | explore | 同（explore 优先本就不会被 `"code"` 升格） |
   | 非 floor 名，首轮靠 frontmatter `"code"` | worker | 降级：30 min/80 → 1h/200，75% 不挂，`requireYieldTool` 变 false |
   | 非 floor 名，首轮靠 spawn `"code"` | worker | 同上 |
   | 非 floor 名 worker（如 `task` / `subagent-grok` 无旗标） | worker | 同 |
   | 首轮显式 `maxRuntimeMs=0` / 请求预算 0 | 按当前 `ctx.settings` 重解析 | **不恢复** caller override；class 若持久化则只恢复 class |

   成功标准因此写成：新文件四入口 class 与首轮相同；旧文件按上表回退，**不**声称永远相同。

6. **75% / hard cap / 1.5×**

   不改语义。worker 无 75% timer。force-stop 仍 salvage。worker/explore 在 `requireYieldTool: false` 时，预算强停若模型不 yield，用最后 assistant 文本 salvage（现有 `captureSalvage`），不得丢合法文本。

7. **长尾验收样本**

   新窗口单列：`flash`+`max` 贴 1h 行；活跃 ≥60 min 的 `other`；`session_init.agent=task` 的 keep-going / 晚 yield 是否还在。不宣称必须消失。

### 5.3 接口 / 配置 / 数据结构变更

只列将改路径。

- `packages/coding-agent/src/prompts/system/subagent-system-prompt.md`  
  worker/explore 完成文案；删除 keep-going 两句；review 分支保留 yield。
- `packages/coding-agent/src/task/executor.ts`  
  `resolveRunMonitorBudgets`；`requireYieldTool` 按 class；工具循环结束后无 tool_call 则完成；follow-up / attach / install 五处预算；`appendSessionInit` 写 `performanceClass`；修正 “Disabled by default” 注释。
- `packages/coding-agent/src/task/persisted-revive.ts`  
  读 `init.performanceClass` 或名字回退；`requireYieldTool` 按 class；attach 传入预算 / class / settings。wakeAgent 仍是 stub，**测试也必须用 stub**。
- `packages/coding-agent/src/session/session-entries.ts`  
  `SessionInitEntry.performanceClass?`。
- `packages/coding-agent/src/session/session-manager.ts`  
  `appendSessionInit` 参数与 `peekSessionInit` 拷贝该字段。
- `packages/coding-agent/src/vibe/runtime.ts`  
  跟进轮传入 `performanceClass` 与 `settings`。不改 `#buildSpawnOptions` 的 class 算法。
- 测试：
  - 扩展 `packages/coding-agent/test/task/executor-wall-clock.test.ts`、`executor-soft-budget.test.ts`：五入口非 0；省略 ≠ 0；review 75% 只 steer。
  - 新建 `packages/coding-agent/test/task/executor-followup-irc-budget.test.ts`：首轮/follow-up/IRC 热/冷 × worker/review/explore。
  - 新建或扩展 `packages/coding-agent/test/task/executor-final-text-completion.test.ts`：worker/explore 无工具最终文本 → `completed` 且不要求 yield；含 tool_call 不结束；显式 yield 仍合法；review 无 yield 不完成。
  - 扩展 `packages/coding-agent/test/task/persisted-revive` 现有测试（或同目录新文件）：**真实 stub** + `peekSessionInit` 有/无 `performanceClass`；覆盖 §5.2 表：floor 名、scout 名、非 floor + 无字段 → worker（即使测试注释标明「若首轮曾是 frontmatter code」）。禁止给 stub 手工塞 `shadowReview: "code"` 来证明冷路径仍是 review。
  - 扩展 `packages/coding-agent/test/session` 中 `peekSessionInit` / `appendSessionInit` 断言拷贝 `performanceClass`。
  - 扩展 vibe 跟进轮捕获：options 含 class/settings。
- 实现阶段：`packages/coding-agent/CHANGELOG.md` Unreleased。design-only 阶段不改。

**不改**：`review-performance.ts` 判定矩阵与 worker 75%=0 / ceiling=Infinity；`scout.md`；`active-wall.ts` 算法。

### 5.4 错误处理与回退策略

- 非法数字预算：与首轮相同 `Math.max(0, Math.trunc)`；NaN 不得挂 timer。
- 显式 0：关闭该护栏，不回落到 1h/200。
- `performanceClass` 缺失（运行中 options）：按 worker，与现 `runSubprocess` 一致。
- 旧 `session_init` 缺字段：名字回退；spawn/frontmatter `"code"` **不恢复**。这是合同，不是 bug。
- 旧文件系统提示仍含 keep-going 原文：冷恢复 `systemPrompt: () => [init.systemPrompt]` 会原样重放。新 run 用新模板；旧会话提示降级与 class 降级一并文档化，不在冷路径重写历史 prompt。
- follow-up `ensureLive` 失败：现有错误路径，不重试成无限。
- worker/explore 无最终文本也无 yield：走现有空输出 / salvage / timeout，不编造成功。
- 自然结束后 IRC 再来：现有 wake monitor 开**新的一轮**（有预算），不是自动 keep-going。
- 累计多 follow-up 仍可超过 1h：记观测；只有 run 边界证明重置是长尾来源才升 B。

### 5.5 风险与缓解

- 风险：worker 过早在「中间叙述、无工具」的回合停掉。  
  - 缓解：合同是 **该 assistant 回合零 tool_call 的最终文本**；有工具继续。提示写明工具用完再写最终答案。测试覆盖「先 tool 再最终文本」与「首回合纯文本」。
- 风险：review 被误设 `requireYieldTool: false`。  
  - 缓解：唯一分支 `class==="review"`；冷路径有持久化 class 的新文件保持 true；测试锁 review 无 yield 不完成。
- 风险：完成合同变更降低实现质量。  
  - 缓解：质量门不放宽；幅度标 `[未知]`；timeout/budget_stop 仍非 PASS。
- 风险：只改提示不改 `requireYieldTool`，模型仍被 idle-reminder 催 yield。  
  - 缓解：提示与 runtime 同一 PR；测试断言 worker 无 yield 可 `completed`。
- 风险：冷路径测试用手工 review class 假绿（Gate 已指出）。  
  - 缓解：测试夹具必须是 `wakeAgent = { name: displayName, ...stub }`；class 只来自 `init.performanceClass` 或名字回退。
- 风险：把 flash 降档或克隆 pi 进程塞进同一实现。  
  - 缓解：非目标写死；实现评审对照 §4.3。
- 风险：A 之后 167 min 级长尾仍在被当成失败。  
  - 缓解：成功标准绑行为 + 分层报告；拟议 p90/≥60m 门槛标 `[拟议验收目标]`。

## 6. 验证计划

本轮 design-only，不跑产品测试。实现授权后：

**行为**

- worker/explore：无工具最终文本 → `completed`；回合含 tool_call → 继续；显式 yield → 合法完成。review：无 yield 不完成。
- 提示单测或 snapshot：worker/explore 渲染结果 **不含** “keep going until this ticket is closed” / “While work remains, you MUST continue with another tool call”；review 仍含 yield 收工句。
- 不自动 follow-up：自然结束后无新 run，除非测试显式调用 follow-up 或 IRC observer。
- 预算表驱动：三类 × 省略 / 显式 0 / 小于 ceiling / 大于 ceiling；五入口非 0；省略 ≠ 0。
- 冷恢复：**真实 stub**。有 `performanceClass:"review"` 的 init → review 预算与 `requireYieldTool===true`。无字段 + `agent:"task"` → worker 1h/200 且 `requireYieldTool===false`。无字段 + floor 名 → review。无字段 + `scout` → explore。
- `peekSessionInit` 往返拷贝 `performanceClass`。
- vibe 跟进轮 options 含 class/settings。
- 回归 75% advisory、1.5× `budget_stop`、hard `timeout`、quality gate 非 PASS。

**测量**

- 同脚本 + `computeActiveWallMs`；新窗口；无插补。
- 分文件名类与 model/thinking 报 n/p50/p90/p95/max/≥30/≥60。
- 单列 worker 名 / `other` 长尾与 `LifecycleOwner` 同类。
- 有字段则报请求数与自然停止后的额外 steer/follow-up。
- 不得用 p50 或百分比宣称「大幅降低」。拟议对照：`other` n=88 p90=46.87 ≥60m=4。

**质量**

- 不改 `evaluateBenchmarkQualityGate`。live required cases 每 run `firstPassed===true`。

**根因复核**

- 若新窗口在完成合同 + 非 0 每轮预算下，单 jsonl 活跃仍 ≫ 单轮 cap，且对齐多次 follow-up/IRC 边界，再开 B（累计或第二引擎）的设计 reentry。此前禁止实现 B。

## 7. 关键决策摘要

- 规模 M。根因：干活型长尾由 keep-going + 强制 yield + worker 无 class 顶（及预算=0 续跑）叠加；167 min 单轮/多轮仍未知。
- 推荐 A：现有 runtime 内简化 worker/explore 结束规则；review 仍 yield；`performanceClass` 写入 `session_init`；五处预算闭合。B（进程克隆 / 第二 engine / 累计账本）无已确认必要约束。
- 最终文本 = 无 tool_call 的 assistant 回合结束，不是任意文本、不是每工具一停。
- 不自动续跑。
- 新文件冷恢复用持久化 class，与首轮相同；旧文件按名字回退，frontmatter/spawn `"code"` 与 caller 显式 0 **不恢复**。成功标准不声称旧文件四入口同 class。
- worker 硬顶仍 1h、请求预算默认 200、无 75% timer。
- 不按 flash 降档；不改 scout.md；不改 class 矩阵；不改 `~/.omp`。
- `LifecycleOwner` 167.177 是验收样本与通俗解释证据，不是已证明的模型因果。
- implementation_authorization=design-only。PASS 后停止。

## 8. Handoff

### 8.1 同会话继续

宿主原生路径：`按 subagent-delegation 触发只读 GPT-6-astra / subagent-astra（默认 GPT-6-astra / subagent-astra；优先与 grok 异模型；author 为 grok 时不可回退到 grok；reviewer 不可用则 claude-opus-5-thinking-high，再主 agent 同模型）。`

当前 `implementation_authorization=design-only`：Review 达到 `PASS` / `PASS_WITH_NOTES` 后必须停止，不得继续 design-implement，也不得改产品代码、改 `~/.omp` 或发布。

### 8.2 新会话恢复 prompt

```text
请读取完整设计输入集合：
1. docs/superpowers/specs/2026-09-06-subagent-followup-worker-latency-design.md
2. docs/superpowers/specs/2026-09-06-subagent-followup-worker-latency-facts-brief.md
生成按 normalized path 排序的 path + SHA-256 `Reviewed Inputs` manifest，并计算 `reviewed_revision`；pre-review handoff 不伪造 digest。设计元数据：design_author=grok；design_author_identity=GrokDesignAuthor；implementation_authorization=design-only；authorization_source=用户当前请求（含跟进）是分析耗时、通俗解释，并参考 pi/Cursor 简化子代理执行以降低耗时；未授权改产品代码、改 ~/.omp 或发布。
使用起草前选定的只读 GPT-6-astra / subagent-astra 执行独立 Design Review（默认 GPT-6-astra / subagent-astra；优先与全部内容作者异模型；author 为 grok 时不可回退到 grok；reviewer 不可用则 claude-opus-5-thinking-high，再主 agent 同模型，并记录 review_fallback）；将完整 review artifact 持久化到 docs/superpowers/plans/2026-09-06-subagent-followup-worker-latency-subagent-review.md。按宿主记录 review_mode=host-native、author/reviewer native agent_id、model、verdict、授权来源与证据。
若文档包含根因分析，请一并核对根因判断、证据与设计方案是否一致。
必须核对：推荐方案是更浅的 A——在现有 executor + class 内简化 worker/explore 结束规则（去掉无条件 keep-going；无工具最终文本即结果；requireYieldTool 对 worker/explore 为 false；review 仍 yield）；把 performanceClass 写入现有 session_init 供冷恢复；并闭合五处预算=0。B（第二 completion engine / pi 进程克隆 / 累计账本）仅在 A 无法满足已确认约束时才可当选。吸收 AstraDesignGate NEEDS_REVISION：冷恢复不得仅用 displayName 声称与首轮同 class；旧文件名字回退的降级必须写进成功标准；测试必须用真实 wakeAgent stub + 持久化字段，禁止手工注入 shadowReview。不得重做 8/30 class 矩阵 / scout.md / 75% advisory 机制。数字只来自 facts brief / summary.md，无插补、无因果百分比。独立 Gate 仍在且 timeout 不得 PASS。design-only 在 PASS 后必须停止。
评审结论必须为 PASS / PASS_WITH_NOTES / NEEDS_REVISION / NEEDS_REDESIGN 四选一，并附可复查证据；禁止作者自审。
NEEDS_REVISION 时第一次由原 author 修订当前设计；同一路径连续第二次 NEEDS_REVISION 按 subagent-delegation 僵局翻转（评审模型改写，原作者改审，只一次）。NEEDS_REDESIGN 时回到 design-brainstorm 重做方案。正文变更后均须重新执行 Gate，且在通过前不得实现。
PASS/PASS_WITH_NOTES 后，current Inputs manifest 等于 reviewed manifest 或存在覆盖全部输入的有效 Gate Continuity Note，且 implementation_authorization=authorized，才继续 design-implement；design-only 必须停止。
Review 后输入变化由未参与 author/reviewer/正文修改/implementation 的主协调者按 handoff 规则分类；非实质变化持久化覆盖完整 manifest 的 Gate Continuity Note，实质、不确定、遗漏输入或角色未分离时重跑 Gate。
```
