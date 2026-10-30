# Subagent 生命周期可观测性与恢复 v2

- **author**: DesignRewriteV2 (gateway/claude-opus-5)
- **date**: 2026-08-04
- **status**: DRAFT (addressing round 4 findings F1-F8)
- **note**: Replacement author, addressing Design Review Gate findings rounds 1-4

---

## 1. 目标与范围

### 1.1 核心目标

为 oh-my-pi coding-agent 实现 **machine-owned** 的 subagent 生命周期检测与通知，使 LLM 无需依赖定期轮询即可感知以下状态：

1. **P0-排队启动超时**：spawn 请求在 semaphore 后排队过久（默认 2min [拟议验收目标]），自动失败并释放 permit
2. **P0-运行超时**：subagent 推理超过 wall-clock 上限（默认 1h [拟议验收目标]），executor 中止并保存部分输出
3. **P1-staleness 主动通知**：running job 超过阈值（默认 10min [拟议验收目标]）未产生 progress 时，manager 向 owner sink 投递一次 **结构化 lifecycle diagnostic**，并作为可等待事件加入 `hub wait` race；owner 无 active wait 时自动注入 follow-up turn，有 wait 时原子性声明该 episode 使其不重复 auto-inject

### 1.2 Snapshot 字段扩展

扩展 `AsyncJob` / `JobSnapshot` / `TrackedJobLike` 以支持诊断与 TUI（[已核实] job-manager.ts:28-48, tools/hub/jobs.ts:130-145, tools/hub/types.ts:31-53）：

**AsyncJob 内部字段**：
- `incarnationId: string` — UUID，稳定 job 身份，不随 id 复用改变
- `progressGeneration: number` — progress episode 代际，每次 reportProgress 递增
- `runningStartedAt?: number` — markRunning 时刻，queued 与 running 区分基准
- `lastProgressAt?: number` — 最近一次 reportProgress 调用时刻，staleness 基线
- 保留现有 `queued?: boolean` 语义（[已核实] job-manager.ts:45；queued=true 时 job 未计入 maxRunningJobs）

**JobSnapshot wire 字段（新增 liveness）**：
- `queuedForMs?: number` — 当前排队时长（job.queued===true 时存在，等于 now - startTime）
- `startupDelayMs?: number` — 历史启动延迟（job 已 running 且曾排队，等于 runningStartedAt - startTime）
- `idleForMs?: number` — 当前 idle 时长（job running 时，等于 now - (lastProgressAt ?? runningStartedAt ?? startTime)）

诊断逻辑在 manager/HubTool 内部计算后，通过 `CoordinationDetails.diagnostic` 携带 per-job reason/phase/threshold 供 renderer 显示。

### 1.3 非目标（out of scope）

- **Parked-parent replay**（从 P0/P1 核心交付移出）：现有 5min job-row retention 后，自动通知已 dead-letter；artifact output (`agent://<id>`) 和 transcript (`history://<id>`) 仍可追溯 [已核实 task/executor.ts:2124-2127, internal-urls/agent-protocol.ts:37-44]，但不设计 durable cross-session delivery ledger / artifact-dir scan / exactly-once replay
- **`/jobs` 斜杠命令扩展**：`/jobs` 使用独立 `AsyncJobSnapshotItem` schema（仅 id/type/status/label/startTime [已核实 session/agent-session-types.ts:50-56]），本次不扩展其 wire shape 或 renderer；lifecycle 可见性仅限 `hub` tool + TUI
- **Advisor/watchdog 执行器**：`advisor/watchdog.ts` 是被动审阅配置/prompt 的加载器，不是 subagent 生命周期终止器；P0-P2 的检测/中止/salvage 均在 AsyncJobManager/TaskTool/executor 的 canonical path 实现

---

## 2. 背景与现状

### 2.1 Verified Facts（[已核实] 来自工作树 2026-08-04）

#### 进程内异步 job 架构

- Subagent 以 in-process `AsyncJobManager` 后台 job 运行（[已核实] async/job-manager.ts, task/index.ts:1050-1253）；batch spawn 受 per-session semaphore 门禁（`task.maxConcurrency` 默认 32 [已核实] settings-schema.ts:4699-4714）
- Job 以 `queued:true` 注册（[已核实] task/index.ts:1085-1118），拿到 permit 后调用 `markRunning()` 清除 queued 标记（[已核实] task/index.ts:1211-1213）
- `AsyncJobManager.register` signature: `(type, label, run, options?)` 返回 jobId；`run` 接收 `{ signal, reportProgress, markRunning }` [已核实 job-manager.ts:219-283]
- `AsyncJobRegisterOptions` 包含 `id?`, `ownerId?`, `agentId?`, `queued?`, `onProgress?` [已核实 job-manager.ts:85-103]；**无 settings 参数**，constructor 只接收 `{ onJobComplete?, maxRunningJobs?, retentionMs? }` [已核实 job-manager.ts:64-77]

#### Hub wait 竞态与 poll

- `HubTool#executeWait` 先 `drainPendingInbox`（message 预优先 [已核实 index.ts:371-383]），visibleJobs/no-running 分支返回 nothing-to-wait/immediate snapshot
- `Promise.race([...runningJobs.map(j=>j.promise), busLeg, timeoutPromise])` [已核实 index.ts:390-456]；race 返回后按 **时间先后** settle，无 post-wake arbitration
- `async.pollWaitDuration` 默认 `"smart"` [已核实 settings-schema.ts:4150-4153]；smart ladder `[5s,10s,30s,60s,300s]` [已核实 job-manager.ts:16]，60s reset [已核实 job-manager.ts:21]
- `timeoutMs=0` 不启动 poll timer；`windowMs>0` 才 setTimeout [已核实 index.ts:442-443]
- `isWaitingPollDetails` 要求 `jobs` 非空数组且全 running、无 cancelled [已核实 jobs.ts:45-49]；命中谓词的 result 可被 TUI displacement

#### Snapshot 与 delivery

- `snapshotJobs` 输出 `JobSnapshot[]`（id/type/status/label/durationMs/resolvedModel?/resultText?/errorText? [已核实 jobs.ts:145-168, types.ts:31-53]）
- `buildJobResult` signature（6 参数 [已核实 jobs.ts:170-223]）：`(session, manager, op, jobs, CancelOutcome[], agents=[])`；自动对 settled rows 调用 `manager.acknowledgeDeliveries` 防止重复 async-result
- Canonical owner delivery：`AsyncJobManager.registerDeliverySink(ownerId, sink)` [已核实 job-manager.ts:450-457]；`sink: (jobId, text, job?) => void|Promise<void>`；AgentSession 注册后写入 YieldQueue，idle flush 作 follow-up turn 注入 [已核实 session/agent-session.ts:1211-1217, session/async-job-delivery.ts:1-72]
- Retry/backoff: exp 500ms→30s while owner sink live；owner parked/disposed 时 dead-letter（warning + 丢弃）；job row 5min 后 evict [已核实 job-manager.ts:3-6, 11-13]

#### 守卫与超时

- Soft request budget: `{scout:100, sonic:100, default:200}` [已核实 task/executor.ts:93-96]；1.5× force-stop + 5 grace；budget-stop 可 resume，signal/terminate/wall-clock terminal
- **`task.maxRuntimeMs` 默认 0** [已核实 settings-schema.ts:4737-4755]；非零时 executor 启动 wall-clock timer → `AgentProgress.status="aborted"` + `SingleResult.aborted=true` [已核实 types.ts:396-402, 410-440] + `AsyncJob.status="failed"` [已核实 job-manager.ts:28-33, 258-261] + TaskJobError [已核实 task/index.ts:1164-1190]
- **现有 abort+salvage**：runtime-limit reason "Subagent runtime limit exceeded (task.maxRuntimeMs=...)" [已核实 executor-wall-clock.test.ts:96-112]；部分 output 落盘 `<artifactsDir>/<id>.md` [已核实 task/executor.ts:2124-2127]

#### 已知缺口

- Queued job 无 timeout → semaphore 饱和时永久排队
- Running job 无首个 progress → staleness 无基线
- Staleness 检测依赖 LLM 再次 poll
- `lastProgressAt`/`runningStartedAt` 不存在 → 无 idle/queued 诊断基线

---

## 3. 失败模式与用户方案评估

### 3.1 典型故障场景

1. **Semaphore 饱和 + stuck job**：maxConcurrency=4，前 4 个 spawn 中 1 个 hung provider；第 5 个请求永久排队，用户无感知
2. **推理卡死**：provider stream hang 逃逸 watchdog；无 maxRuntimeMs 时 `session.waitForIdle()` 永久等待
3. **Long-running 合法任务无 feedback**：10min+ codebase 分析，中途无 progress；父代理无从区分"仍在推理"与"已挂起"

### 3.2 LLM 周期性探测（periodic probing）的局限

- **LLM 无时钟纪律**：对话树分支、长推理、plan mode 均可延迟/跳过探测
- **父代理自身可能阻塞**：tool 超时、自身 stuck → 探测窗口失效
- **Polling 噪音**：频繁 "still running" snapshot 占用 turn/context

**结论**（诚实评价）：periodic probing 只能作为决策兜底（用户主动 `hub wait` 或 advisor 建议），不能成为检测主机制；machine-owned 的检测/通知路径必须独立于 LLM 行为。

---

## 4. 方案对比

### 4.1 方案 A（推荐）：Detection + Push in Wait Loop + Canonical Delivery

**检测**：AsyncJobManager 在 reportProgress/markRunning/register 时启动/重置 per-job staleness timer（stable job `incarnationId` UUID + progress `generation`）；到点写入 manager-owned pending diagnostic record

**通知双路径**：
1. **Active wait leg**：HubTool#executeWait 新增 lifecycle event promise 作为 race leg；post-wake arbitration 按固定优先级（buffered message → settled job → valid stale episode → poll window → abort）；消费 episode 后原子性标记，不再 auto-inject
2. **Proactive follow-up**：owner 无 active wait 时，delivery sink 将 diagnostic 注入 YieldQueue（独立 nonterminal lifecycle message type，区别于 async-result）

**优势**：
- 检测 100% machine-owned；覆盖"调用 wait 时尚未 stale，race 期间跨阈值"
- 复用 canonical owner delivery + retry/backoff；exactly-once 通过 episode 状态机保证
- Queued/runtime timeout 同样复用 AsyncJob/TaskTool/executor canonical path

**增量阶段**：P0 queued+runtime（settings 默认非零），P1 staleness（默认 shadow），P2 activation（默认 on + sequential canary），P3/P4 optional enhancements

### 4.2 方案 B：周期性后台线程探测

Manager 启动 setInterval 线程，每 30s 扫描全部 running jobs；超过阈值的投递 diagnostic。

**劣势**：
- 定时器粒度固定（30s 与 10min 阈值不匹配）
- 检测延迟：worst-case 阈值+29s
- 无法利用 reportProgress 已有时间戳

### 4.3 方案 C：仅靠 LLM 轮询 + advisor 建议

保持现状；advisor/watchdog 在 transcript review 时建议 `hub wait` 或 cancel。

**劣势**：
- 违反"检测不依赖 LLM poll"要求
- advisor 是被动 reviewer，不能终止 subagent
- 依然需要 queued/runtime timeout 作兜底

**推荐方案 A**，理由：machine-owned 检测 + canonical delivery 复用 + incrementally shippable。

