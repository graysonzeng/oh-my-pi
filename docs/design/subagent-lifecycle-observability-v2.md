# Subagent 生命周期可观测性与恢复 v2

- **author**: DesignRevisionR5 (gateway/claude-opus-5)
- **date**: 2026-08-04
- **status**: DRAFT (under round-5 revision)
- **note**: revision author: gateway/claude-opus-5 (round-5 revision, addressing F1-F8 from round-4 review)

> ## Scope 决策记录（2026-08-04，用户批准）
>
> 5 轮 Design Review Gate 均确认设计方向正确，但全部 Blocking 为执行级缺口（文档内代码片段与真实 API 不符、章节缺失、空测试体），3 个 author 实例均未能完成代码精确性闭合。用户决定**拆分交付**：
>
> - **P0（转 design-implement）**：排队启动超时（§5.2.4 已补入）+ 运行墙钟超时（现有 executor path）+ settings 默认值（§5.1.3，标 [拟议验收目标]）。实施时以第五轮 F1/F6/F8 为约束，对照真实代码闭合（代码即真源）。
> - **P1（另开 epic）**：staleness 主动通知机制（§5.2.1/§5.2.4 lifecycle 部分、§5.3 wait 集成、§7 P1 测试）——即第五轮 F2/F3/F4/F5/F7。相关输入已归档至 `docs/design/_p1-epic-inputs/`（含 author 的 F2-F8 corrections spec 与分节草稿）。
>
> 全量文档的 Design Review Gate **未通过**（NEEDS_REVISION）；此记录不构成 PASS。P0 范围进入实现是用户的显式 scope 批准。

---

## 1. 目标与范围

### 1.1 核心目标

为 oh-my-pi coding-agent 实现 **machine-owned** 的 subagent 生命周期检测与通知，使 LLM 无需依赖定期轮询即可感知以下状态：

1. **P0-排队启动超时**：spawn 请求在 semaphore 后排队过久（默认 2min [拟议验收目标]），自动失败并释放 permit
2. **P0-运行超时**：subagent 推理超过 wall-clock 上限（默认 1h [拟议验收目标]），executor 中止并保存部分输出
3. **P1-staleness 主动通知**：running job 超过阈值（默认 10min [拟议验收目标]）未产生 progress 时，manager 向 owner sink 投递一次 **结构化 lifecycle diagnostic**，并作为可等待事件加入 `hub wait` race；owner 无 active wait 时自动注入 follow-up turn，有 wait 时原子性声明该 episode 使其不重复 auto-inject

### 1.2 Snapshot 字段扩展

扩展 `AsyncJob` / `JobSnapshot` / `TrackedJobLike` 以支持诊断与 TUI（[已核实] job-manager.ts:28-48, tools/hub/jobs.ts:130-145, tools/hub/types.ts:31-53）：

- `incarnationId: string` — UUID，register 时分配，用于所有 episode key
- `progressGeneration: number` — Progress episode 代际，reportProgress 递增
- `runningStartedAt?: number` — markRunning 时刻
- `lastProgressAt?: number` — 最近 reportProgress 时刻
- `stalenessPolicy?: { thresholdMs, mode }` — Per-job frozen policy（TaskTool spawn 时从 owner settings 读取）

**JobSnapshot wire shape** 扩展字段（F4）：
- `queuedForMs?: number` — 仅当 job.queued===true 时存在
- `startupDelayMs?: number` — 历史启动延迟：runningStartedAt - startTime
- `idleForMs?: number` — now - (lastProgressAt ?? runningStartedAt ?? startTime)
- `agentIdleForMs?: number` — 辅助：AgentRegistry cross-check（标注为 informational）

### 1.3 非目标（out of scope）

- **Parked-parent replay**（从 P0/P1 核心交付移出）：现有 5min job-row retention 后，自动通知已 dead-letter；artifact output (`agent://<id>`) 和 transcript (`history://<id>`) 仍可追溯 [已核实] task/executor.ts:2124-2127, internal-urls/agent-protocol.ts:37-44），但不设计 durable cross-session delivery ledger / artifact-dir scan / exactly-once replay
- **`/jobs` 斜杠命令扩展**：`/jobs` 使用独立 `AsyncJobSnapshotItem` schema（仅 id/type/status/label/startTime [已核实] session/agent-session-types.ts:50-56），本次不扩展其 wire shape 或 renderer；lifecycle 可见性仅限 `hub` tool + TUI
- **Advisor/watchdog 执行器**：`advisor/watchdog.ts` 是被动审阅配置/prompt 的加载器 [已核实]，不是 subagent 生命周期终止器；P0-P2 的检测/中止/salvage 均在 AsyncJobManager/TaskTool/executor 的 canonical path 实现

---

## 2. 背景与现状

### 2.1 Verified Facts（[已核实] 来自工作树 2026-08-04）

#### 进程内异步 job 架构

- Subagent 以 in-process `AsyncJobManager` 后台 job 运行（[已核实] async/job-manager.ts, task/index.ts:1050-1253）；batch spawn 受 per-session semaphore 门禁（`task.maxConcurrency` 默认 32 [已核实] settings-schema.ts:4730-4800）
- Job 以 `queued:true` 注册（[已核实] task/index.ts:1085-1118），拿到 permit 后调用 `markRunning()` 清除 queued 标记（[已核实] task/index.ts:1211-1213）
- `AsyncJobManager.register` signature: `(type, label, run, options?)` 返回 jobId；`run` 接收 `{ signal, reportProgress, markRunning }` [已核实] job-manager.ts:176-290
- `AsyncJobRegisterOptions` 包含 `id?`, `ownerId?`, `agentId?`, `queued?`, `onProgress?` [已核实] job-manager.ts:85-103；**无 settings 参数**，constructor 只接收 `{ onJobComplete?, maxRunningJobs?, retentionMs? }` [已核实] job-manager.ts:64-77

#### Hub wait 竞态与 poll

- `HubTool#executeWait` 先 `drainPendingInbox`（message 预优先 [已核实] tools/hub/index.ts:371-383），visibleJobs/no-running 分支返回 nothing-to-wait/immediate snapshot
- `Promise.race([...runningJobs.map(j=>j.promise), busLeg, timeoutPromise])`（[已核实] tools/hub/index.ts:390-456）；race 返回后按 **时间先后** settle，无 post-wake arbitration
- `async.pollWaitDuration` 默认 `"smart"` [已核实] settings-schema.ts:4150-4153；smart ladder `[5s,10s,30s,60s,300s]` [已核实] job-manager.ts:16，60s reset [已核实] job-manager.ts:21
- `timeoutMs=0` 不启动 poll timer；`windowMs>0` 才 setTimeout [已核实] tools/hub/index.ts:442-443
- `isWaitingPollDetails` 要求 `jobs` 非空数组且全 running、无 cancelled [已核实] tools/hub/jobs.ts:45-49；命中谓词的 result 可被 TUI displacement

#### Snapshot 与 delivery

- `snapshotJobs` 输出 `JobSnapshot[]`（id/type/status/label/durationMs/resolvedModel?/resultText?/errorText? [已核实] tools/hub/jobs.ts:145-168, tools/hub/types.ts:31-53）
- `buildJobResult` signature（6 参数 [已核实] tools/hub/jobs.ts:183-223）：`(session, manager, op, jobs, CancelOutcome[], agents=[])`；自动对 settled rows 调用 `manager.acknowledgeDeliveries` 防止重复 async-result
- Canonical owner delivery：`AsyncJobManager.registerDeliverySink(ownerId, sink)` [已核实] job-manager.ts:450-457；`sink: (jobId, text, job?) => void|Promise<void>`；AgentSession 注册后写入 YieldQueue，idle flush 作 follow-up turn 注入 [已核实] session/agent-session.ts:1211-1217, session/async-job-delivery.ts:1-72
- Retry/backoff: exp 500ms→30s while owner sink live；owner parked/disposed 时 dead-letter（warning + 丢弃）；job row 5min 后 evict [已核实] job-manager.ts:3-6, 11-13

#### 守卫与超时

- **Stream guards**（pi-ai first-event 100s / idle 120s [未在本仓库核实，来自 verified brief]）
- **Tool timeout**：`bash` 默认 300s、max 3600s [未直接核实，来自 brief]
- **Soft request budget**：`{scout:100, sonic:100, default:200}` [已核实] task/executor.ts:93-96；1.5× force-stop + 5 grace；budget-stop 可 resume，signal/terminate/wall-clock terminal
- **`task.maxRuntimeMs` 默认 0**（[已核实] settings-schema.ts:4737-4755）；非零时 executor 启动 wall-clock timer → `AgentProgress.status="aborted"` + `SingleResult.aborted=true` [已核实] task/types.ts:396-402, 410-440] + `AsyncJob.status="failed"` [已核实] job-manager.ts:28-33, 258-261] + TaskJobError [已核实] task/index.ts:1164-1190]
- **现有 abort+salvage**：runtime-limit reason "Subagent runtime limit exceeded (task.maxRuntimeMs=...)" [已核实] test/task/executor-wall-clock.test.ts:96-112]；部分 output 落盘 `<artifactsDir>/<id>.md` [已核实 task/executor.ts:2124-2127]

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

### 4.1 方案 A（推荐）：Detection + Typed Delivery + Atomic Claim

**检测**：AsyncJobManager 在 reportProgress/markRunning/register 时启动/重置 per-job staleness timer（stable job **incarnationId** + progress **generation**）；到点写入 manager-owned pending diagnostic record

**通知双路径**：
1. **Active wait leg**：HubTool#executeWait 新增 lifecycle event promise 作为 race leg；post-wake arbitration 按固定优先级（buffered message → settled job → valid stale episode → poll window → abort）；消费 episode 后原子性标记，不再 auto-inject
2. **Proactive follow-up**：owner 无 active wait 时，delivery sink 将 diagnostic 注入 YieldQueue（独立 nonterminal lifecycle message type，区别于 async-result）

**优势**：
- 检测 100% machine-owned；覆盖"调用 wait 时尚未 stale，race 期间跨阈值"
- 复用 canonical owner delivery + retry/backoff；exactly-once 通过 atomic claim/ack/generation 保证
- Queued/runtime timeout 同样复用 AsyncJob/TaskTool/executor canonical path

**增量阶段**：P0 queued+runtime（settings 默认非零），P1 staleness（默认 off，opt-in on），P2 activation（可选 default on）

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
- advisor 是被动 reviewer，不能终止 subagent [已核实]
- 依然需要 queued/runtime timeout 作兜底

**推荐方案 A**，理由：machine-owned 检测 + canonical delivery 复用 + incrementally shippable。

---

## 5. 详细设计

### 5.1 数据结构扩展

#### 5.1.1 AsyncJob 新增字段

```typescript
// packages/coding-agent/src/async/job-manager.ts
export interface AsyncJob {
  // ... 现有字段 (id, type, status, startTime, label, abortController, promise, ownerId, agentId, queued) ...
  
  // F1+F2: 新增字段
  incarnationId: string;         // UUID，register 时分配，用于所有 episode key
  progressGeneration: number;    // Progress episode 代际，reportProgress 递增
  runningStartedAt?: number;     // markRunning() 时刻
  lastProgressAt?: number;       // 最近 reportProgress 时刻
  
  // F2: Per-job frozen staleness policy（TaskTool spawn 时从 owner settings 读取并冻结）
  stalenessPolicy?: {
    thresholdMs: number;
    mode: 'off' | 'shadow' | 'on';
  };
}
```

**incarnationId** 用于 timer/event 去重，是稳定 job 身份标识（不随 id 复用改变）；**progressGeneration** 用于 staleness episode 标识。

**Episode key format**: `${ownerId ?? 'unowned'}:${incarnationId}:${generation}`

#### 5.1.2 类型扩展

##### DiagnosticEpisode（F1 内部状态）

```typescript
// packages/coding-agent/src/async/job-manager.ts (internal)
interface DiagnosticEpisode {
  episodeId: string;              // `${ownerId}:${incarnationId}:${generation}`
  jobId: string;
  incarnationId: string;
  generation: number;
  phase: 'queued' | 'running-no-progress' | 'running-idle';
  observedMs: number;             // 实际 idle 时长
  thresholdMs: number;            // 冻结的阈值
  ownerId: string | undefined;
  agentId?: string;
  state: 'pending' | 'wait-claimed' | 'owner-queued' | 'delivered' | 'acked';
  claimedBy?: string;
}
```

**状态机**（F1）：
```
PENDING → (atomic claim) → WAIT_CLAIMED | OWNER_QUEUED
  WAIT_CLAIMED → DELIVERED (post-wake ack)
  OWNER_QUEUED → IN_FLIGHT → DELIVERED → ACKED
```

##### CoordinationDetails.diagnostic（F1 wire contract）

```typescript
// packages/coding-agent/src/tools/hub/types.ts
export interface CoordinationDetails {
  op: HubOp;  // 保持完整 union，不收窄
  // ... 现有 from/to/receipts/waited/inbox/peers/jobs/cancelled/agents ...
  
  // F1: 新增 optional diagnostic
  diagnostic?: {
    staleIds: string[];        // 触发 staleness 的 job id 列表
    thresholdMs: number;       // 使用的阈值
    episodes: Array<{
      jobId: string;
      phase: 'queued' | 'running-no-progress' | 'running-idle';
      idleMs: number;          // 实际 idle 时长
      agentId?: string;        // 关联 AgentRef id（若有）
    }>;
  };
}
```

##### JobSnapshot 扩展字段（F4）

```typescript
// packages/coding-agent/src/tools/hub/types.ts
export interface JobSnapshot {
  // ... 现有 id/type/status/label/durationMs/resolvedModel/resultText/errorText ...
  
  // F4: Liveness fields
  queuedForMs?: number;       // 仅当 job.queued === true 时存在
  startupDelayMs?: number;    // 历史启动延迟：runningStartedAt - startTime（markRunning 后存在）
  idleForMs?: number;         // now - (lastProgressAt ?? runningStartedAt ?? startTime)
  agentIdleForMs?: number;    // 辅助：AgentRegistry cross-check（标注为 informational）
}
```

##### Episode→Diagnostic 转换（F3）

```typescript
// packages/coding-agent/src/tools/hub/jobs.ts (new helper)
function episodeToDiagnostic(episode: DiagnosticEpisode): CoordinationDetails["diagnostic"] {
  return {
    staleIds: [episode.jobId],
    thresholdMs: episode.thresholdMs,
    episodes: [{
      jobId: episode.jobId,
      phase: episode.phase,
      idleMs: episode.observedMs,
      agentId: episode.agentId
    }]
  };
}
```

#### 5.1.3 Settings schema（新增条目）

```typescript
// packages/coding-agent/src/config/settings-schema.ts

"task.queuedStartupTimeoutMs": {  // F8: 正确命名（不是 queuedTimeoutMs）
  type: "number",
  default: 120000,  // 2min [拟议验收目标]
  ui: {
    tab: "tasks",
    group: "Subagents",
    label: "Queued Startup Timeout",
    description: "Max time a spawn may wait for a semaphore permit (ms). 0 disables. Crossing the limit fails the spawn with a clear 'semaphore saturated' reason and releases the permit so later spawns can proceed.",
    options: [
      { value: "0", label: "Unlimited" },
      { value: "60000", label: "1 minute" },
      { value: "120000", label: "2 minutes" },
      { value: "300000", label: "5 minutes" },
    ],
  },
},

"task.maxRuntimeMs": {
  type: "number",
  default: 3600000,  // 1h [拟议验收目标] (changed from 0)
  ui: {
    tab: "tasks",
    group: "Subagents",
    label: "Task Runtime Limit",
    description: "Wall-clock limit for subagent execution (ms). 0 disables. Crossing the limit aborts the executor and salvages partial output.",
    options: [
      { value: "0", label: "Unlimited" },
      { value: "1800000", label: "30 minutes" },
      { value: "3600000", label: "1 hour" },
      { value: "7200000", label: "2 hours" },
    ],
  },
},

"async.stalenessThresholdMs": {
  type: "number",
  default: 600000,  // 10min [拟议验收目标]
  ui: {
    tab: "tasks",
    group: "Subagents",
    label: "Staleness Notification Threshold",
    description: "Idle time before AsyncJobManager proactively notifies the owner of a stale running job (ms). 0 disables staleness detection.",
    options: [
      { value: "0", label: "Disabled" },
      { value: "300000", label: "5 minutes" },
      { value: "600000", label: "10 minutes" },
      { value: "1200000", label: "20 minutes" },
    ],
  },
},

"async.stalenessMode": {
  type: "enum",
  values: ["off", "on"],  // F6: 删除 shadow，简化为 off|on
  default: "off",  // F6: 默认 off，显式 opt-in
  ui: {
    tab: "tasks",
    group: "Subagents",
    label: "Staleness Notification Mode",
    description: "off: disabled; on: deliver diagnostic to owner when threshold crossed.",
  },
},
```

**F6 Mode 决定**：删除 `shadow` 模式（需要复杂的"检测但不投递"语义），简化为 **off（默认）/ on（opt-in）**。

**Activation contract**：
- `task.queuedStartupTimeoutMs`：TaskTool#registerSpawnJob post-acquire 检查（§5.2.4）
- `task.maxRuntimeMs`：executor preflight（现有路径，[已核实] task/executor.ts）
- `async.stalenessThresholdMs` / `async.stalenessMode`：TaskTool spawn 时读取并冻结到 `AsyncJobRegisterOptions.stalenessPolicy`（§5.2.1）

### 5.2 AsyncJobManager 扩展

#### 5.2.1 Staleness Timer 与 Lifecycle Delivery（F1+F2 完整实现）

##### Typed Lifecycle Event（F1 Sink Contract）

```typescript
// packages/coding-agent/src/async/job-manager.ts

type AsyncJobLifecycleEvent = {
  type: 'staleness';
  episodeId: string;
  jobId: string;
  incarnationId: string;
  generation: number;
  phase: 'queued' | 'running-no-progress' | 'running-idle';
  observedMs: number;
  thresholdMs: number;
  agentId?: string;
};

type AsyncJobCompletionEvent = {
  type: 'completion';
  jobId: string;
  text: string;
  job?: AsyncJob;
};

type AsyncJobDeliveryEvent = AsyncJobLifecycleEvent | AsyncJobCompletionEvent;

// F1: Extend existing sink to accept typed event union
export type AsyncJobDeliverySink = (event: AsyncJobDeliveryEvent) => void | Promise<void>;

interface AsyncJobManagerOptions {
  onJobComplete?: AsyncJobDeliverySink;  // Unowned deliveries only
  maxRunningJobs?: number;
  retentionMs?: number;
}
```

##### Episode State Machine（F1）

```typescript
// Internal episode tracking
interface DiagnosticEpisode {
  episodeId: string;
  jobId: string;
  incarnationId: string;
  generation: number;
  phase: 'queued' | 'running-no-progress' | 'running-idle';
  observedMs: number;
  thresholdMs: number;
  ownerId: string | undefined;
  agentId?: string;
  state: 'pending' | 'wait-claimed' | 'owner-queued' | 'delivered' | 'acked';
  claimedBy?: string;
}

#stalenessTimers = new Map<string, NodeJS.Timeout>();  // key: incarnationId
#pendingDiagnostics = new Map<string, DiagnosticEpisode>();  // key: episodeId
```

##### Timer Lifecycle（F2: Per-Job Policy）

```typescript
constructor(options: AsyncJobManagerOptions) {
  // 现有逻辑 ...
  // F2: Manager 不持有 Settings getter；policy 由 TaskTool 在 register 时冻结
}

#startStalenessMonitor(job: AsyncJob): void {
  const policy = job.stalenessPolicy;
  if (!policy || policy.mode === 'off' || policy.thresholdMs <= 0) return;
  
  this.#stopStalenessMonitor(job.incarnationId);
  
  // Mode 决定在 timer 启动前（F2）
  const handle = setTimeout(() => {
    this.#onStalenessThreshold(job.incarnationId, job.progressGeneration, policy);
  }, policy.thresholdMs);
  
  handle.unref();  // F2: unref 避免阻止进程退出
  this.#stalenessTimers.set(job.incarnationId, handle);
}

#stopStalenessMonitor(incarnationId: string): void {
  const handle = this.#stalenessTimers.get(incarnationId);
  if (handle) {
    clearTimeout(handle);
    this.#stalenessTimers.delete(incarnationId);
  }
}

#onStalenessThreshold(incarnationId: string, generation: number, policy: NonNullable<AsyncJob['stalenessPolicy']>): void {
  const job = Array.from(this.#jobs.values()).find(j => j.incarnationId === incarnationId);
  if (!job || job.status !== "running" || job.progressGeneration !== generation) return;
  
  const now = Date.now();
  const idleMs = now - (job.lastProgressAt ?? job.runningStartedAt ?? job.startTime);
  const phase: DiagnosticEpisode['phase'] = job.queued ? 'queued' : 
    job.lastProgressAt ? 'running-idle' : 'running-no-progress';
  
  const episodeId = `${job.ownerId ?? 'unowned'}:${incarnationId}:${generation}`;
  if (this.#pendingDiagnostics.has(episodeId)) return;  // 已触发
  
  const episode: DiagnosticEpisode = {
    episodeId,
    jobId: job.id,
    incarnationId,
    generation,
    phase,
    observedMs: idleMs,
    thresholdMs: policy.thresholdMs,
    ownerId: job.ownerId,
    agentId: job.agentId,
    state: 'pending',
  };
  
  this.#pendingDiagnostics.set(episodeId, episode);
  
  // F1: 投递到 owner delivery queue（扩展现有 #enqueueDelivery 以支持 lifecycle event）
  this.#enqueueLifecycleDelivery(episode);
}
```

##### Generic Delivery Engine Extension（F1）

```typescript
// 扩展现有 AsyncJobDelivery 以支持 lifecycle event
interface AsyncJobDelivery {
  ownerId: string | undefined;
  event: AsyncJobDeliveryEvent;  // F1: Union type (completion | lifecycle)
  attempt: number;
  nextAttemptAt: number;
}

#enqueueLifecycleDelivery(episode: DiagnosticEpisode): void {
  if (!episode.ownerId) return;  // Unowned job 不投递 lifecycle event
  
  // F1: 原子 transition PENDING → OWNER_QUEUED
  if (episode.state !== 'pending') return;
  episode.state = 'owner-queued';
  
  const lifecycleEvent: AsyncJobLifecycleEvent = {
    type: 'staleness',
    episodeId: episode.episodeId,
    jobId: episode.jobId,
    incarnationId: episode.incarnationId,
    generation: episode.generation,
    phase: episode.phase,
    observedMs: episode.observedMs,
    thresholdMs: episode.thresholdMs,
    agentId: episode.agentId,
  };
  
  this.#deliveries.push({
    ownerId: episode.ownerId,
    event: lifecycleEvent,
    attempt: 0,
    nextAttemptAt: Date.now(),
  });
  
  this.#ensureDeliveryLoop();  // 复用现有 retry/backoff 引擎
}

// 扩展现有 #enqueueDelivery 以保持向后兼容
#enqueueDelivery(jobId: string, text: string): void {
  const job = this.#jobs.get(jobId);
  const completionEvent: AsyncJobCompletionEvent = {
    type: 'completion',
    jobId,
    text,
    job,
  };
  
  this.#deliveries.push({
    ownerId: job?.ownerId,
    event: completionEvent,
    attempt: 0,
    nextAttemptAt: Date.now(),
  });
  
  this.#ensureDeliveryLoop();
}

// F1: 修改现有 delivery loop 以支持 typed event
async #ensureDeliveryLoop(): Promise<void> {
  // ... 现有 loop structure ...
  
  for (const delivery of batch) {
    const sink = delivery.ownerId 
      ? this.#deliverySinks.get(delivery.ownerId)
      : this.#onJobComplete;
    
    if (!sink) {
      // Dead-letter: no sink
      if (delivery.event.type === 'lifecycle') {
        const ep = this.#pendingDiagnostics.get(delivery.event.episodeId);
        if (ep) ep.state = 'acked';  // Mark as delivered (no retry)
      }
      continue;
    }
    
    try {
      await sink(delivery.event);  // F1: Pass typed event
      
      if (delivery.event.type === 'lifecycle') {
        const ep = this.#pendingDiagnostics.get(delivery.event.episodeId);
        if (ep) ep.state = 'delivered';
      }
    } catch (error) {
      // Retry with exponential backoff (现有逻辑)
      delivery.attempt++;
      delivery.nextAttemptAt = Date.now() + Math.min(
        DELIVERY_RETRY_BASE_MS * Math.pow(2, delivery.attempt),
        DELIVERY_RETRY_MAX_MS
      );
      this.#deliveries.push(delivery);
    }
  }
}
```

##### Progress & Settlement Invalidation（F1）

```typescript
reportProgress(jobId: string, text: string, details?: Record<string, unknown>): void {
  const job = this.#jobs.get(jobId);
  if (!job) return;
  
  job.lastProgressAt = Date.now();
  job.progressGeneration += 1;  // F1: 递增代际
  job.latestDetails = details ?? job.latestDetails;
  
  // F1: Invalidate all pending/queued/in-flight episodes for this job
  this.#invalidateJobEpisodes(job.incarnationId);
  
  // F2: 重置 staleness timer
  this.#startStalenessMonitor(job);
  
  // 现有 onProgress callback ...
}

markRunning(jobId: string): void {
  const job = this.#jobs.get(jobId);
  if (!job) return;
  
  job.queued = false;
  job.runningStartedAt = Date.now();
  job.progressGeneration += 1;  // F1: 清除 queued phase
  
  // F1: Invalidate queued-phase episodes
  this.#invalidateJobEpisodes(job.incarnationId);
  
  // F2: 启动 running-phase staleness monitor
  this.#startStalenessMonitor(job);
}

#invalidateJobEpisodes(incarnationId: string): void {
  for (const [episodeId, episode] of this.#pendingDiagnostics.entries()) {
    if (episode.incarnationId === incarnationId) {
      episode.state = 'acked';  // Mark as invalidated
      this.#pendingDiagnostics.delete(episodeId);
    }
  }
  
  // Remove from delivery queue
  this.#deliveries = this.#deliveries.filter(d => {
    if (d.event.type === 'lifecycle' && d.event.incarnationId === incarnationId) {
      return false;
    }
    return true;
  });
}

#cleanupJob(job: AsyncJob): void {
  this.#stopStalenessMonitor(job.incarnationId);
  this.#invalidateJobEpisodes(job.incarnationId);
  this.#scheduleEviction(job.id);
}
```

#### 5.2.3 register 修改（F2: 先入表再启动 run）

```typescript
// packages/coding-agent/src/async/job-manager.ts

register(
  type: "bash" | "task",
  label: string,
  run: (ctx: {
    jobId: string;
    signal: AbortSignal;
    reportProgress: (text: string, details?: Record<string, unknown>) => Promise<void>;
    markRunning: () => void;
  }) => Promise<string>,
  options?: AsyncJobRegisterOptions,
): string {
  // F2: 保持现有 disposed/capacity guards
  if (this.#disposed) {
    throw new Error("Async job manager is disposed");
  }
  
  let activeCount = 0;
  for (const existing of this.#jobs.values()) {
    if (existing.status === "running" && !existing.queued) activeCount++;
  }
  if (activeCount >= this.#maxRunningJobs) {
    throw new Error(
      `Background job limit reached (${this.#maxRunningJobs}). Wait for running jobs to finish or cancel one.`,
    );
  }

  // F2: 保持 #resolveJobId 逻辑
  const id = this.#resolveJobId(options?.id);
  
  // F2: 清除 suppressed delivery（允许重新投递）
  this.#suppressedDeliveries.delete(id);
  
  const abortController = new AbortController();
  const startTime = Date.now();

  // F1+F2: 新增字段
  const job: AsyncJob = {
    id,
    type,
    status: "running",
    startTime,
    label,
    abortController,
    promise: undefined as any,  // 下面立即赋值
    ownerId: options?.ownerId,
    agentId: options?.agentId,
    queued: options?.queued === true,
    incarnationId: randomUUID(),  // F1: UUID
    progressGeneration: 0,        // F1: 初始代际
    stalenessPolicy: options?.stalenessPolicy,  // F2: 冻结的 policy
  };
  
  // F2: 先入表再启动 run（避免 reportProgress/markRunning 在 job 入表前被调用）
  this.#jobs.set(id, job);
  
  const reportProgress = async (text: string, details?: Record<string, unknown>): Promise<void> => {
    this.reportProgress(id, text, details);
  };
  
  const markRunning = (): void => {
    this.markRunning(id);
  };
  
  job.promise = (async () => {
    try {
      const text = await run({
        jobId: id,
        signal: abortController.signal,
        reportProgress,
        markRunning,
      });
      if (job.status === "cancelled") {
        job.resultText = text;
        this.#cleanupJob(job);
        return;
      }
      job.status = "completed";
      job.resultText = text;
      this.#enqueueDelivery(id, text);
      this.#cleanupJob(job);
    } catch (error) {
      if (job.status === "cancelled") {
        job.errorText = error instanceof Error ? error.message : String(error);
        this.#cleanupJob(job);
        return;
      }
      const errorText = error instanceof Error ? error.message : String(error);
      job.status = "failed";
      job.errorText = errorText;
      this.#enqueueDelivery(id, errorText);
      this.#cleanupJob(job);
    }
  })();

  return id;
}
```

**F2 关键变更**：
- `incarnationId = randomUUID()`（不是 Symbol）
- `stalenessPolicy` 由 TaskTool 在 spawn 时冻结并传入
- `this.#jobs.set(id, job)` 在 `job.promise = run(...)` 之前
- 保持 `#resolveJobId` / disposed / capacity / suppressed-delivery 逻辑
#### 5.2.4 TaskTool Queued-Startup Timeout（F1: P0 Implementation）

```typescript
// packages/coding-agent/src/task/index.ts (#registerSpawnJob surgical diff)

// F1: Unique timeout token for first-cause detection
const QUEUED_TIMEOUT_TOKEN = Symbol('queued-startup-timeout');

#registerSpawnJob(options: {
  manager: AsyncJobManager;
  toolCallId: string;
  spawnParams: TaskParams;
  agentId: string;
  progress: AgentProgress;
  ircEnabled: boolean;
  buildDetails: () => TaskToolDetails;
  onUpdate?: AgentToolUpdateCallback<TaskToolDetails>;
  onSettled?: (failed: boolean) => void;
}): string {
  const { manager, toolCallId, spawnParams, agentId, progress, ircEnabled, buildDetails, onUpdate, onSettled } = options;
  
  // F2: Read owner settings once and freeze policy
  const queuedTimeoutMs = this.session.settings.get("task.queuedStartupTimeoutMs");
  const stalenessThresholdMs = this.session.settings.get("async.stalenessThresholdMs");
  const stalenessMode = this.session.settings.get("async.stalenessMode");
  const stalenessPolicy = (stalenessMode === 'on' && stalenessThresholdMs > 0) 
    ? { thresholdMs: stalenessThresholdMs, mode: stalenessMode as 'on' }
    : undefined;
  
  const buildFollowUpHint = async (aborted: boolean): Promise<string> => {
    if (aborted) {
      const ref = AgentRegistry.global().get(agentId);
      const transcript = (await hasResolvableTranscript(agentId))
        ? `transcript at history://${agentId}`
        : "transcript unavailable";
      if (ref?.status === "idle" || ref?.status === "parked") {
        const followUp = ircEnabled ? "message it via `hub` to resume; " : "";
        return `\n\n${agentId} was stopped but is still resumable — ${followUp}${transcript}`;
      }
      return `\n\n${agentId} was aborted — ${transcript}`;
    }
    const followUp = ircEnabled ? "message it via `hub` to follow up; " : "";
    return `\n\n${agentId} is now idle — ${followUp}transcript at history://${agentId}`;
  };
  
  return manager.register(
    "task",
    agentId,
    async ({ signal: runSignal, reportProgress, markRunning }) => {
      const startedAt = Date.now();
      const semaphore = this.#getSpawnSemaphore();
      let semaphoreHeld = false;
      
      // F1: Combined signal with queued timeout
      const queuedAbortController = new AbortController();
      const queuedTimeoutHandle = queuedTimeoutMs > 0
        ? setTimeout(() => {
            queuedAbortController.abort({ reason: QUEUED_TIMEOUT_TOKEN, timeoutMs: queuedTimeoutMs });
          }, queuedTimeoutMs)
        : undefined;
      
      const combinedSignal = AbortSignal.any([runSignal, queuedAbortController.signal]);
      
      // F1: Unified permit release
      const releasePermit = () => {
        if (!semaphoreHeld) return;
        semaphoreHeld = false;
        this.#releaseSpawnSemaphore();
      };
      
      try {
        // F1: Acquire in isolated try/catch
        try {
          await semaphore.acquire(combinedSignal);
          semaphoreHeld = true;
        } catch (acquireError) {
          // F1: Post-acquire first-cause check (even if permit acquired)
          if (semaphoreHeld) {
            releasePermit();  // Release if somehow got permit before abort
          }
          
          // Determine first cause via unique token
          if (combinedSignal.reason?.reason === QUEUED_TIMEOUT_TOKEN) {
            // Queued timeout
            progress.status = "failed";
            onSettled?.(true);
            const timeoutMs = combinedSignal.reason.timeoutMs;
            throw new TaskJobError(
              `Spawn request timed out after ${timeoutMs}ms waiting for semaphore permit (task.queuedStartupTimeoutMs=${timeoutMs}). ` +
              `This usually means maxConcurrency is saturated by stuck jobs. Consider cancelling hung jobs or increasing task.maxConcurrency.`
            );
          } else {
            // Other abort (cancel/signal)
            progress.status = "aborted";
            onSettled?.(true);
            throw new Error("Aborted before execution");
          }
        } finally {
          if (queuedTimeoutHandle) clearTimeout(queuedTimeoutHandle);
        }
        
        const acquiredAt = Date.now();
        
        // F1: Post-acquire double-check (race: timeout fired but permit acquired)
        if (combinedSignal.aborted) {
          releasePermit();
          if (combinedSignal.reason?.reason === QUEUED_TIMEOUT_TOKEN) {
            progress.status = "failed";
            onSettled?.(true);
            const timeoutMs = combinedSignal.reason.timeoutMs;
            throw new TaskJobError(
              `Spawn request timed out after ${timeoutMs}ms waiting for semaphore permit (task.queuedStartupTimeoutMs=${timeoutMs}).`
            );
          } else {
            progress.status = "aborted";
            onSettled?.(true);
            throw new Error("Aborted before execution");
          }
        }
        
        // Mark running and report
        markRunning();
        progress.status = "running";
        await reportProgress(
          `Running background task ${agentId}...`,
          buildDetails() as unknown as Record<string, unknown>,
        );
        
        // Forward sync progress
        const forwardSyncProgress: AgentToolUpdateCallback<TaskToolDetails> = async update => {
          const nextProgress = update.details?.progress?.[0];
          if (nextProgress) {
            progress.resolvedModel = nextProgress.resolvedModel;
            progress.resolvedModelIsFallback = nextProgress.resolvedModelIsFallback;
            progress.tokens = nextProgress.tokens;
            progress.requests = nextProgress.requests;
            progress.contextTokens = nextProgress.contextTokens;
            progress.contextWindow = nextProgress.contextWindow;
            progress.cost = nextProgress.cost;
            progress.toolCount = nextProgress.toolCount;
            progress.currentTool = nextProgress.currentTool;
            progress.lastIntent = nextProgress.lastIntent;
            progress.recentTools = nextProgress.recentTools.slice();
            progress.recentOutput = nextProgress.recentOutput.slice();
            progress.retryState = nextProgress.retryState;
            progress.retryFailure = nextProgress.retryFailure;
          }
          const updateText = update.content.find(part => part.type === "text")?.text ?? `Running background task ${agentId}...`;
          await reportProgress(updateText, buildDetails() as unknown as Record<string, unknown>);
        };
        
        // Execute sync
        const result = await this.#executeSync(
          toolCallId,
          spawnParams,
          runSignal,
          forwardSyncProgress,
          agentId,
          progress.index,
          true,
          { invokedAt: startedAt, acquiredAt },
        );
        
        const finalText = result.content.find(part => part.type === "text")?.text ?? "(no output)";
        const singleResult = result.details?.results[0];
        const resultFailed = !singleResult || (singleResult.aborted ?? false) || singleResult.exitCode !== 0;
        
        progress.status = singleResult?.aborted ? "aborted" : resultFailed ? "failed" : "completed";
        progress.durationMs = singleResult?.durationMs ?? Math.max(0, Date.now() - startedAt);
        progress.tokens = singleResult?.tokens ?? 0;
        progress.requests = singleResult?.requests ?? 0;
        progress.contextTokens = singleResult?.contextTokens;
        progress.contextWindow = singleResult?.contextWindow;
        progress.cost = singleResult?.usage?.cost.total ?? 0;
        progress.extractedToolData = singleResult?.extractedToolData;
        progress.retryFailure = singleResult?.retryFailure;
        progress.retryState = undefined;
        
        if (singleResult?.resolvedModel) {
          progress.resolvedModel = singleResult.resolvedModel;
          progress.resolvedModelIsFallback = singleResult.resolvedModelIsFallback;
        } else {
          delete progress.resolvedModel;
          delete progress.resolvedModelIsFallback;
        }
        
        onSettled?.(resultFailed);
        
        const statusText = resultFailed
          ? `Background task ${agentId} failed.`
          : `Background task ${agentId} complete.`;
        await reportProgress(statusText, buildDetails() as unknown as Record<string, unknown>);
        
        const deliveryText = `${finalText}${await buildFollowUpHint(singleResult?.aborted === true)}`;
        
        if (resultFailed) {
          throw new TaskJobError(deliveryText);
        }
        return deliveryText;
      } catch (error) {
        if (error instanceof TaskJobError) {
          throw error;
        }
        progress.status = "failed";
        progress.durationMs = Math.max(0, Date.now() - startedAt);
        onSettled?.(true);
        const statusText = `Background task ${agentId} failed.`;
        await reportProgress(statusText, buildDetails() as unknown as Record<string, unknown>);
        const message = error instanceof Error ? error.message : String(error);
        const hint = AgentRegistry.global().get(agentId) ? await buildFollowUpHint(false) : "";
        throw new TaskJobError(`${message}${hint}`);
      } finally {
        releasePermit();
      }
    },
    {
      id: agentId,
      agentId,
      queued: true,
      ownerId: this.session.getAgentId?.() ?? undefined,
      onProgress: text => {
        onUpdate?.({ content: [{ type: "text", text }], details: buildDetails() });
      },
      stalenessPolicy,  // F2: Pass frozen policy
    },
  );
}
```

**F1 关键点**：
- `QUEUED_TIMEOUT_TOKEN` unique symbol for first-cause detection
- `AbortSignal.any([runSignal, queuedAbortController.signal])`
- Acquire in isolated try/catch, post-acquire double-check
- `semaphoreHeld` flag set immediately after `acquire()` returns
- All exit paths use `releasePermit() → #releaseSpawnSemaphore()`
- Timer cleanup in acquire finally block
- `onSettled` exactly once (single guard via `semaphoreHeld` + try/catch structure)
- `queuedTimeoutMs=0` → no timer created
- TaskJobError with clear "semaphore saturated" text
- F2: Read settings once, pass `stalenessPolicy` to register

### 5.3 HubTool Integration

#### 5.3.1 HubTool#executeWait 集成（F3: Typed API + Tagged Winner）

##### Lifecycle Subscription API（F3）

```typescript
// packages/coding-agent/src/async/job-manager.ts

interface LifecycleSubscription {
  ownerId: string;
  watchedIds: string[];  // Empty = watch all owner jobs
  resolve: (event: AsyncJobLifecycleEvent) => void;
}

#lifecycleSubscribers: LifecycleSubscription[] = [];

subscribeLifecycleEvents(
  ownerId: string,
  watchedIds: string[]
): { promise: Promise<AsyncJobLifecycleEvent>; unsubscribe: () => void } {
  const { promise, resolve } = Promise.withResolvers<AsyncJobLifecycleEvent>();
  const subscriber: LifecycleSubscription = { ownerId, watchedIds, resolve };
  this.#lifecycleSubscribers.push(subscriber);
  
  return {
    promise,
    unsubscribe: () => {
      const idx = this.#lifecycleSubscribers.indexOf(subscriber);
      if (idx >= 0) this.#lifecycleSubscribers.splice(idx, 1);
    }
  };
}

claimPendingDiagnostic(episodeId: string, claimant: string): DiagnosticEpisode | undefined {
  const episode = this.#pendingDiagnostics.get(episodeId);
  if (!episode || episode.state !== 'pending') return undefined;
  
  // F1: 原子 transition PENDING → WAIT_CLAIMED
  episode.state = 'wait-claimed';
  episode.claimedBy = claimant;
  return episode;
}

// 在 #enqueueLifecycleDelivery 中通知 active subscribers（F3）
#enqueueLifecycleDelivery(episode: DiagnosticEpisode): void {
  if (!episode.ownerId) return;
  
  // 通知 active waiters（F1: atomic claim 机制）
  const matchingSubscribers = this.#lifecycleSubscribers.filter(sub => 
    sub.ownerId === episode.ownerId &&
    (sub.watchedIds.length === 0 || sub.watchedIds.includes(episode.jobId))
  );
  
  if (matchingSubscribers.length > 0) {
    // F1: Active waiter 存在 → 标记为 WAIT_CLAIMED，立即 resolve
    episode.state = 'wait-claimed';
    const lifecycleEvent: AsyncJobLifecycleEvent = {
      type: 'staleness',
      episodeId: episode.episodeId,
      jobId: episode.jobId,
      incarnationId: episode.incarnationId,
      generation: episode.generation,
      phase: episode.phase,
      observedMs: episode.observedMs,
      thresholdMs: episode.thresholdMs,
      agentId: episode.agentId,
    };
    
    // Resolve first subscriber (one-shot)
    const first = matchingSubscribers[0]!;
    first.resolve(lifecycleEvent);
    const idx = this.#lifecycleSubscribers.indexOf(first);
    if (idx >= 0) this.#lifecycleSubscribers.splice(idx, 1);
    
    return;  // 不进入 owner delivery queue
  }
  
  // F1: 无 active waiter → PENDING → OWNER_QUEUED，进入 canonical delivery
  episode.state = 'owner-queued';
  const lifecycleEvent: AsyncJobLifecycleEvent = { /* same as above */ };
  this.#deliveries.push({
    ownerId: episode.ownerId,
    event: lifecycleEvent,
    attempt: 0,
    nextAttemptAt: Date.now(),
  });
  this.#ensureDeliveryLoop();
}
```

##### executeWait Integration（F3: Tagged Winner）

```typescript
// packages/coding-agent/src/tools/hub/index.ts

type RaceWinner = 
  | { kind: 'message'; message: IrcMessage }
  | { kind: 'job'; job: AsyncJob }
  | { kind: 'lifecycle'; event: AsyncJobLifecycleEvent }
  | { kind: 'poll'; }
  | { kind: 'abort'; };

async #executeWait(
  params: WaitParams,
  signal?: AbortSignal,
  onUpdate?: AgentToolUpdateCallback<HubDetails>,
): Promise<AgentToolResult<HubDetails>> {
  const manager = this.session.asyncJobManager;
  const ownerId = this.session.getAgentId?.() ?? undefined;
  const messaging = this.#messaging();
  
  // F3: 保持现有 drainPendingInbox pre-check
  if (messaging) {
    const pending = drainPendingInbox(messaging.registry, messaging.senderId, params.from);
    if (pending) return messageResult(messaging.senderId, pending);
  }
  
  // F3: 保持现有 visibleJobs / no-running 分支
  const ids = params.ids;
  const jobsToWatch = manager
    ? ids?.length
      ? visibleJobs(manager, ids, ownerId)
      : manager.getRunningJobs(ownerId ? { ownerId } : undefined)
    : [];
  if (manager && ids?.length && jobsToWatch.length === 0) {
    return noMatchingJobsResult(this.session, ids);
  }
  const runningJobs = jobsToWatch.filter(j => j.status === "running");
  if (manager && jobsToWatch.length > 0 && runningJobs.length === 0) {
    return buildJobResult(this.session, manager, "wait", jobsToWatch, []);
  }
  
  // F3: 保持现有 no-manager / message-only wait
  if (!manager || runningJobs.length === 0) {
    if (!messaging) return nothingToWaitForResult(this.session);
    if (!params.from) {
      const hasRunningPeer = messaging.registry
        .listVisibleTo(messaging.senderId)
        .some(ref => ref.status === "running");
      if (!hasRunningPeer) return nothingToWaitForResult(this.session);
    }
    return executeMessageWait(messaging, { from: params.from, timeoutMs: params.timeoutMs }, signal);
  }
  
  // F3: 保持现有 poll window
  const window = resolvePollWindow(this.session, manager, ownerId);
  const windowMs = params.timeoutMs !== undefined ? normalizeIrcTimeoutMs(params.timeoutMs) : window.waitMs;
  const usedSmartWindow = window.smart && params.timeoutMs === undefined;
  
  // F3: Race legs with tagged winners
  const racePromises: Promise<RaceWinner>[] = runningJobs.map(j => 
    j.promise.then(() => ({ kind: 'job' as const, job: j }))
  );
  
  // F3: Lifecycle event leg (NEW)
  const watchedJobIds = runningJobs.map(j => j.id);
  let lifecycleSubscription: ReturnType<typeof manager.subscribeLifecycleEvents> | undefined;
  if (ownerId) {
    lifecycleSubscription = manager.subscribeLifecycleEvents(ownerId, watchedJobIds);
    racePromises.push(
      lifecycleSubscription.promise.then(event => ({ kind: 'lifecycle' as const, event }))
    );
  }
  
  // F3: 保持现有 busAbort/busLeg
  const busAbort = messaging ? new AbortController() : undefined;
  const busCancelled = new Error("hub wait settled");
  let removeBusAbortListener: (() => void) | undefined;
  const busLeg = messaging && busAbort
    ? IrcBus.global()
        .wait(messaging.senderId, { from: params.from }, 0, busAbort.signal)
        .then(
          message => ({ kind: 'message' as const, message }),
          error => {
            if (error === busCancelled) return { kind: 'abort' as const };
            throw error;
          }
        )
    : undefined;
  if (busLeg) racePromises.push(busLeg);
  if (busAbort && signal) {
    if (signal.aborted) {
      busAbort.abort(signal.reason instanceof Error ? signal.reason : new Error("hub wait aborted"));
    } else {
      const onAbort = (): void => {
        busAbort.abort(signal.reason instanceof Error ? signal.reason : new Error("hub wait aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      removeBusAbortListener = () => signal.removeEventListener("abort", onAbort);
    }
  }
  
  // F3: Poll timer leg
  const { promise: timeoutPromise, resolve: timeoutResolve } = Promise.withResolvers<RaceWinner>();
  const timeoutHandle = windowMs > 0 ? setTimeout(() => timeoutResolve({ kind: 'poll' }), windowMs) : undefined;
  if (timeoutHandle) racePromises.push(timeoutPromise);
  
  // F3: Abort leg
  if (signal) {
    const { promise: abortPromise, resolve: abortResolve } = Promise.withResolvers<RaceWinner>();
    const onAbort = () => abortResolve({ kind: 'abort' });
    signal.addEventListener("abort", onAbort, { once: true });
    racePromises.push(abortPromise);
  }
  
  manager.watchJobs(watchedJobIds);
  
  const emitProgress = () => {
    if (!onUpdate) return;
    onUpdate({
      content: [{ type: "text", text: "" }],
      details: { op: "wait", jobs: snapshotJobs(this.session, jobsToWatch) },
    });
  };
  const progressTimer = onUpdate ? setInterval(emitProgress, PROGRESS_INTERVAL_MS) : undefined;
  emitProgress();
  
  let winner: RaceWinner;
  try {
    winner = await Promise.race(racePromises);
  } finally {
    manager.unwatchJobs(watchedJobIds);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (progressTimer) clearInterval(progressTimer);
    busAbort?.abort(busCancelled);
    removeBusAbortListener?.();
    lifecycleSubscription?.unsubscribe();  // F3: Clean up subscription
    if (usedSmartWindow) {
      manager.recordPollWaitEnd(ownerId);
    }
  }
  
  // F3: Post-wake arbitration with priority
  // Priority: message > settled job > lifecycle > poll > abort
  
  if (winner.kind === 'message') {
    return messageResult(messaging!.senderId, winner.message);
  }
  
  if (winner.kind === 'job') {
    return buildJobResult(this.session, manager, "wait", jobsToWatch, []);
  }
  
  if (winner.kind === 'lifecycle') {
    // F3: Non-blocking claim attempt
    const diagnostic = manager.claimPendingDiagnostic(winner.event.episodeId, ownerId ?? 'unowned');
    if (diagnostic) {
      const diagnosticPayload = episodeToDiagnostic(diagnostic);
      return buildJobResult(
        this.session,
        manager,
        "wait",
        jobsToWatch,
        [],
        [],
        { diagnostic: diagnosticPayload }  // F5: 7th param
      );
    }
    // Episode already claimed/invalidated, fall through to poll
  }
  
  if (winner.kind === 'poll') {
    return buildJobResult(this.session, manager, "wait", jobsToWatch, [], []);
  }
  
  // winner.kind === 'abort'
  throw new Error("Hub wait aborted");
}
```

#### 5.3.2 AgentSession Delivery Sink Registration（F1: Typed Event Handler）

```typescript
// packages/coding-agent/src/session/agent-session.ts

#registerAsyncDeliverySink(): void {
  if (!this.#asyncJobManager || !this.#agentId) return;
  
  // F1: Typed event handler
  const sink: AsyncJobDeliverySink = (event: AsyncJobDeliveryEvent) => {
    if (event.type === 'completion') {
      // 现有 completion delivery → YieldQueue
      this.#yieldQueue.enqueue({
        epoch: this.#asyncDeliveryEpoch,
        jobId: event.jobId,
        result: event.text,
        job: event.job,
        durationMs: event.job ? Date.now() - event.job.startTime : undefined,
        isStale: (currentEpoch: number) => currentEpoch !== this.#asyncDeliveryEpoch,
      });
    } else if (event.type === 'staleness') {
      // F1: Lifecycle diagnostic → YieldQueue (nonterminal custom message)
      this.#yieldQueue.enqueue({
        epoch: this.#asyncDeliveryEpoch,
        customType: 'lifecycle-diagnostic',  // NEW message type
        jobId: event.jobId,
        episodeId: event.episodeId,
        phase: event.phase,
        idleMs: event.observedMs,
        thresholdMs: event.thresholdMs,
        agentId: event.agentId,
        isStale: (currentEpoch: number) => currentEpoch !== this.#asyncDeliveryEpoch,
      });
    }
  };
  
  this.#unregisterAsyncDeliverySink = this.#asyncJobManager.registerDeliverySink(
    this.#agentId,
    sink
  );
}
```

**F1 YieldQueue Epoch/Stale Semantics**:
- 每个 queued item 携带 `epoch` at enqueue time
- Session transitions (`/new`, handoff) increment `#asyncDeliveryEpoch`
- Flush 时调用 `isStale(currentEpoch)` 过滤 stale entries
- 即使 job-id reuse，epoch 不匹配的 delivery 被丢弃

**Nonterminal Lifecycle Message Template**:
```typescript
// packages/coding-agent/src/prompts/tools/lifecycle-diagnostic.md (NEW)
{{#if multiple}}
## Lifecycle Diagnostics ({{count}})
{{#each episodes}}
- `{{jobId}}`: {{phase}}, idle {{idleMs}}ms (threshold {{thresholdMs}}ms){{#if agentId}} — agent `{{agentId}}`{{/if}}
{{/each}}
{{else}}
## Lifecycle Diagnostic
Job `{{jobId}}` is {{phase}}, idle {{idleMs}}ms (threshold {{thresholdMs}}ms).
{{#if agentId}}Agent: `{{agentId}}`{{/if}}
{{/if}}

Consider: inspect with `agent://{{jobId}}` or `history://{{agentId}}`, adjust threshold, or cancel if hung.
```

#### 5.3.3 buildJobResult 与 TUI Integration（F5: Surgical Diff）

##### buildJobResult Signature（F5: 7th Param）

```typescript
// packages/coding-agent/src/tools/hub/jobs.ts

export function buildJobResult(
  session: ToolSession,
  manager: AsyncJobManager,
  op: "wait" | "cancel" | "jobs",
  jobs: TrackedJobLike[],
  cancelOutcomes: CancelOutcome[],
  agents: AgentActivitySnapshot[] = [],
  options?: { diagnostic?: CoordinationDetails["diagnostic"] }  // F5: NEW 7th param
): AgentToolResult<CoordinationDetails> {
  // F5: 保持现有 dedupe
  const seen = new Set<string>();
  const uniqueJobs = jobs.filter(j => {
    if (seen.has(j.id)) return false;
    seen.add(j.id);
    return true;
  });
  const jobResults = snapshotJobs(session, uniqueJobs);

  // F5: 保持自动 ack
  manager.acknowledgeDeliveries(jobResults.filter(j => j.status !== "running").map(j => j.id));

  const completed = jobResults.filter(j => j.status !== "running");
  const running = jobResults.filter(j => j.status === "running");

  // F5: 保持 conditional spreads
  const details: CoordinationDetails = {
    op,
    jobs: jobResults,
    ...(cancelOutcomes.length > 0 ? { cancelled: cancelOutcomes } : {}),
    ...(agents.length > 0 ? { agents } : {}),
    ...(options?.diagnostic ? { diagnostic: options.diagnostic } : {}),  // F5: NEW
  };

  // F5: 保持 empty fallback
  if (jobResults.length === 0 && agents.length === 0) {
    return { content: [{ type: "text", text: "No background jobs." }], details };
  }

  const lines: string[] = [];

  // F5: 保持 CancelOutcome.message
  if (cancelOutcomes.length > 0) {
    lines.push(`## Cancelled (${cancelOutcomes.length})\n`);
    for (const o of cancelOutcomes) lines.push(`- ${o.message}`);
    lines.push("");
  }

  if (completed.length > 0) {
    lines.push(`## Completed (${completed.length})\n`);
    for (const j of completed) {
      lines.push(`### ${j.id} [${j.type}] — ${j.status}`);
      lines.push(`Label: ${j.label}`);
      if (j.resultText) {
        lines.push("```", j.resultText, "```");
      }
      if (j.errorText) {
        lines.push(`Error: ${j.errorText}`);
      }
      lines.push("");
    }
  }

  if (running.length > 0) {
    lines.push(`## Still Running (${running.length})\n`);
    for (const j of running) {
      lines.push(`- \`${j.id}\` [${j.type}] — ${j.label}`);
    }
  }

  if (agents.length > 0) {
    lines.push("", ...describeAgents(agents));
  }

  // F5: 保持 ordinary useless
  const allRunning = jobResults.length > 0 && jobResults.every(j => j.status === "running");
  if (allRunning && cancelOutcomes.length === 0 && !options?.diagnostic) {
    details.useless = true;
  }

  return { content: [{ type: "text", text: lines.join("\n") }], details };
}
```

##### isWaitingPollDetails 扩展（F5）

```typescript
// packages/coding-agent/src/tools/hub/jobs.ts

export function isWaitingPollDetails(details: unknown): boolean {
  if (!isRecord(details)) return false;
  const jobs = details.jobs;
  if (!Array.isArray(jobs) || jobs.length === 0) return false;
  
  // F5: Diagnostic 存在时永不 displaceable
  if (details.diagnostic) return false;
  
  const allRunning = jobs.every(j => isRecord(j) && j.status === "running");
  const noCancelled = !details.cancelled || !Array.isArray(details.cancelled) || details.cancelled.length === 0;
  return allRunning && noCancelled;
}
```

##### jobsRenderResult Seam（F5: TUI Integration）

```typescript
// packages/coding-agent/src/tools/hub/jobs.ts

export function jobsRenderResult(
  result: { content: Array<{ type: string; text?: string }>; details?: CoordinationDetails; isError?: boolean },
  options: RenderResultOptions,
  uiTheme: Theme,
  hubArgs?: HubRenderArgs,
): Component {
  const details = result.details;
  if (!details) return /* existing fallback */;
  
  // F5: Sealed poll filtering
  if (isWaitingPollDetails(details) && !details.diagnostic) {
    // 现有 sealed poll logic: 全 running 且无 diagnostic → displacement
    if (options.sealed) {
      return null;  // TUI displaces
    }
    // Filter out running rows in sealed poll
    const filteredJobs = details.jobs?.filter(j => j.status !== "running") ?? [];
    if (filteredJobs.length === 0 && !details.agents?.length) {
      return null;  // Nothing to show
    }
  }
  
  // F5: renderItem with liveness/diagnostic info
  const renderItem = (job: JobSnapshot, diagnostic?: CoordinationDetails["diagnostic"]) => {
    const statusIcon = formatStatusIcon(job.status);
    const isDiagnosticJob = diagnostic?.staleIds.includes(job.id);
    const color = isDiagnosticJob ? uiTheme.fg.yellow : statusToColor(job.status);
    
    const parts: string[] = [
      `${statusIcon} ${job.id} [${job.type}]`,
      ` — ${job.label}`,
    ];
    
    // F4: Append liveness info
    if (job.queuedForMs !== undefined) {
      parts.push(` (queued ${formatDuration(job.queuedForMs)})`);
    } else if (job.idleForMs !== undefined) {
      parts.push(` (idle ${formatDuration(job.idleForMs)})`);
    }
    
    // F5: Append diagnostic stale marker
    if (isDiagnosticJob) {
      const episode = diagnostic!.episodes.find(e => e.jobId === job.id);
      if (episode) {
        parts.push(` [STALE: ${episode.phase}, ${formatDuration(episode.idleMs)}/${formatDuration(diagnostic!.thresholdMs)}]`);
      }
    }
    
    return uiTheme.text(parts.join(""), color);
  };
  
  // F5: 保持 existing renderTreeList/shimmer/cache/truncate/preview pipeline
  const jobRows = (details.jobs ?? []).map(j => renderItem(j, details.diagnostic));
  
  return renderTreeList(jobRows, { shimmer: options.shimmer, /* ... */ });
}
```

##### snapshotJobs 扩展（F4: Liveness Computation）

```typescript
// packages/coding-agent/src/tools/hub/jobs.ts

export function snapshotJobs(session: ToolSession, jobs: TrackedJobLike[]): JobSnapshot[] {
  const now = Date.now();
  return jobs.map(j => {
    const latest = 'latestDetails' in j ? j : j;
    
    const snapshot: JobSnapshot = {
      id: latest.id,
      type: latest.type,
      status: latest.status as JobSnapshot["status"],
      label: latest.label,
      durationMs: Math.max(0, now - latest.startTime),
    };
    
    // F4: Liveness fields
    if (latest.queued) {
      snapshot.queuedForMs = now - latest.startTime;
    } else if (latest.runningStartedAt) {
      snapshot.startupDelayMs = latest.runningStartedAt - latest.startTime;
      snapshot.idleForMs = now - (latest.lastProgressAt ?? latest.runningStartedAt);
    } else {
      // No markRunning yet, fallback to startTime
      snapshot.idleForMs = now - (latest.lastProgressAt ?? latest.startTime);
    }
    
    // F4: agentIdleForMs (informational cross-check)
    if (latest.agentId) {
      const ref = AgentRegistry.global().get(latest.agentId);
      if (ref?.lastActivity) {
        snapshot.agentIdleForMs = now - ref.lastActivity;
      }
    }
    
    // Existing resolvedModel/resultText/errorText logic
    if (latest.type === "task") {
      const taskDetails = latest.latestDetails as TaskToolDetails | undefined;
      if (taskDetails?.progress?.[0]?.resolvedModel) {
        snapshot.resolvedModel = taskDetails.progress[0].resolvedModel;
      }
    }
    
    if (latest.resultText) snapshot.resultText = latest.resultText;
    if (latest.errorText) snapshot.errorText = latest.errorText;
    
    return snapshot;
  });
}
```

##### TrackedJobLike 扩展（F5: Type Fix）

```typescript
// packages/coding-agent/src/tools/hub/jobs.ts (local interface)

interface TrackedJobLike {
  id: string;
  type: "bash" | "task";
  status: "running" | "completed" | "failed" | "cancelled";
  label: string;
  startTime: number;
  resultText?: string;
  errorText?: string;
  latestDetails?: Record<string, unknown>;
  
  // F2+F4: New fields
  queued?: boolean;
  runningStartedAt?: number;
  lastProgressAt?: number;
  agentId?: string;
}
```

## 6. 风险与缓解

### 6.1 设置默认值变更（Intentional Behavior Change）

**变更**：
- `task.maxRuntimeMs`: 0 → 3600000（1h）[拟议验收目标]
- `task.queuedStartupTimeoutMs`: 新增，默认 120000（2min）[拟议验收目标]
- `async.stalenessThresholdMs`: 新增，默认 600000（10min）[拟议验收目标]
- `async.stalenessMode`: 新增，默认 "off"（显式 opt-in）

**风险**：老 session 未显式配置时，subagent 将自动 timeout/fail（1h runtime, 2min queued）

**缓解**：
1. **Schema migration 无需数据转换**：additive schema，老 session 继续使用已保存配置
2. **[未验证假设]**："1h 覆盖 99% 正常任务"——需要 baseline 运行时分布验证
3. **[未验证假设]**："2min 排队意味着前方有 stuck jobs"——需要 maxConcurrency=4/8/32 下的健康排队时长数据
4. **Rollback**：用户可显式设为 0 禁用（per-setting 独立开关）

### 6.2 False-Positive Mitigation

**Queued timeout false-positive**：
- **Proxy**：permit-leak rate（timeout 后 permit 未释放）应为 0
- **Verification**：§7 Test 4 覆盖 post-acquire first-cause + releasePermit exactly-once

**Runtime timeout false-positive**：
- **Proxy**：salvage-success rate（timeout 后 artifact 落盘成功）[拟议验收目标] >80%
- **Verification**：现有 executor-wall-clock.test.ts 覆盖 abort+salvage contract

**Staleness false-positive**：
- **Proxy**：diagnostic-actionable rate（owner 在通知后 inspect/cancel/adjust）[拟议验收目标]
- **Non-goal**：不以"diagnostic 后 cancel rate"作质量指标（正确干预包括 inspect、wait、调整阈值、自然完成）

### 6.3 Queued Timeout Races（F4: Closed）

**场景**：`acquire()` 与 `queuedAbortController` 同 tick abort

**缓解**：
- Post-acquire 检查 `combinedSignal.reason`（unique timeout token）保持 first-cause
- `semaphoreHeld` flag 在 acquire 返回后立即设为 true
- 所有 exit 路径统一走 `releasePermit() → #releaseSpawnSemaphore()`
- Single settlement guard 保证 `onSettled` exactly once

**验证**：§7 Test 4 四种 interleaving（permit-before-timeout, timeout-before-permit, cancel-before-timeout, same-tick）

### 6.4 Staleness Fallback（F4: Closed）

**场景**：Job 启动后从未调用 `reportProgress`

**行为**：`idleForMs = now - (lastProgressAt ?? runningStartedAt ?? startTime)`

**验证**：§7 Test 3 覆盖 no-first-progress case

### 6.5 AgentRegistry Cross-Check（Informational）

**字段**：`JobSnapshot.agentIdleForMs`（F4: 标注为 informational）

**用途**：辅助 warning（job idle 与 agent idle 不一致时提示可能的 progress 未上报）

**非不变量**：job.lastProgressAt 与 AgentRef.lastActivity 来自不同事件路径，不保证"最终一致"

### 6.6 Parked-Parent Replay（Out of Scope）

**现状**：5min job-row retention 后，自动通知 dead-letter

**可追溯性保持**：
- Artifact output: `agent://<id>` [已核实] agent-protocol.ts:37-44（无 .md 后缀）
- Transcript: `history://<id>` [已核实] internal-urls/history-protocol.ts

**非本次设计**：durable cross-session delivery ledger / artifact-dir scan / exactly-once replay

## 7. 验证计划（F7: Real Test Owners）

### 7.1 单元测试矩阵

#### AsyncJobManager (test/async-job-manager.test.ts)

```typescript
describe("Staleness detection", () => {
  it("should start timer on markRunning with frozen policy", async () => {
    const manager = new AsyncJobManager({ onJobComplete: () => {} });
    let progressCalled = false;
    
    const jobId = manager.register("bash", "test-job", async ({ markRunning, reportProgress }) => {
      markRunning();
      await reportProgress("started");
      progressCalled = true;
      await Bun.sleep(2000);  // Wait for timer
      return "done";
    }, { 
      ownerId: "test-owner",
      stalenessPolicy: { thresholdMs: 1000, mode: "on" }
    });
    
    // Timer 应触发 lifecycle event
    await manager.getJob(jobId)!.promise;
    expect(progressCalled).toBe(true);
  });
  
  it("should invalidate pending episodes on progress", () => {
    // Test: reportProgress 递增 generation，旧 episode 被标记 acked
  });
  
  it("should cleanup timers/episodes on job settlement", () => {
    // Test: #cleanupJob 删除 timer + pending diagnostics
  });
  
  it("should isolate two-owner staleness policies", () => {
    // Test: ownerA threshold=5s, ownerB threshold=10s, 互不干扰
  });
});
```

#### HubTool (test/tools/hub-wait.test.ts)

```typescript
describe("Hub wait lifecycle integration", () => {
  it("should resolve lifecycle event before poll window", async () => {
    // Test: Tagged winner, lifecycle leg wins over 5s poll
  });
  
  it("should prioritize message over lifecycle event", async () => {
    // Test: Message/lifecycle 同 tick，message 优先
  });
  
  it("should not hang on poll/abort winner", async () => {
    // F3: poll/abort 获胜时必须 unsubscribe lifecycle，不 await loser
  });
  
  it("should claim diagnostic exactly once", async () => {
    // Test: 两个 wait 竞争同一 episode，只有一个 claim 成功
  });
});
```

#### Queued Timeout (test/task/task-spawn.test.ts)

```typescript
describe("Queued startup timeout", () => {
  it("should timeout after queuedStartupTimeoutMs", async () => {
    const session = await createTestSession();
    session.settings.set("task.maxConcurrency", 1);
    session.settings.set("task.queuedStartupTimeoutMs", 500);
    
    const task = await TaskTool.create(session);
    
    // Blocker
    const blocker = await task.execute("call_1", { 
      agent: "scout", 
      task: "sleep 10s" 
    });
    
    // Queued job should timeout
    const queued = await task.execute("call_2", { 
      agent: "scout", 
      task: "quick task" 
    });
    
    const job = session.asyncJobManager!.getJob(queued.details.results[0].jobId);
    await job!.promise.catch(() => {});  // Expect failure
    
    expect(job!.status).toBe("failed");
    expect(job!.errorText).toContain("semaphore saturated");
    
    // Permit 应已释放，第三个 spawn 可获取
    const third = await task.execute("call_3", { agent: "scout", task: "test" });
    expect(third.details.results[0].status).toBe("running");
  });
  
  it("should handle four timeout races", () => {
    // permit-before-timeout, timeout-before-permit, cancel-before-timeout, same-tick
  });
});
```

#### Delivery & YieldQueue (test/agent-session-async-delivery.test.ts)

```typescript
describe("Async delivery exactly-once", () => {
  it("should not inject stale lifecycle event after session transition", async () => {
    // Test: session /new increments epoch, old delivery 被 isStale 过滤
  });
  
  it("should retry lifecycle delivery on transient sink failure", () => {
    // Test: sink 抛异常，exponential backoff retry
  });
  
  it("should not double-inject when active wait claims episode", () => {
    // Test: wait claims → owner-queue 路径不再投递
  });
});
```

#### TUI & Displacement (test/job-poll-displacement.test.ts, test/job-renderer-preview.test.ts)

```typescript
describe("Diagnostic rendering", () => {
  it("should not displace diagnostic result", () => {
    // Test: isWaitingPollDetails 在 diagnostic 存在时返回 false
  });
  
  it("should show liveness fields in hub jobs output", () => {
    // Test: queuedForMs/idleForMs 出现在 model-facing text
  });
  
  it("should highlight stale jobs in TUI", () => {
    // Test: diagnostic.staleIds 的 job 用 yellow color
  });
});
```

#### Settings Defaults (test/settings-manager.test.ts)

```typescript
describe("Settings schema defaults", () => {
  it("should load new default values", () => {
    const defaults = Settings.isolated();
    expect(defaults.get("task.maxRuntimeMs")).toBe(3600000);
    expect(defaults.get("task.queuedStartupTimeoutMs")).toBe(120000);
    expect(defaults.get("async.stalenessThresholdMs")).toBe(600000);
    expect(defaults.get("async.stalenessMode")).toBe("off");
  });
});
```

### 7.2 集成测试场景

#### Scenario 1: Runtime Timeout

```typescript
// test/task/executor-wall-clock.test.ts (existing test updated)
it("should abort at runtime limit and salvage output", async () => {
  const session = await createTestSession();
  session.settings.set("task.maxRuntimeMs", 100);  // 100ms
  
  const task = await TaskTool.create(session);
  const result = await task.execute("call_1", {
    agent: "scout",
    task: "long-running analysis"
  });
  
  const job = session.asyncJobManager!.getJob(result.details.results[0].jobId);
  await job!.promise.catch(() => {});
  
  // F8: AsyncJob.status="failed", AgentProgress.status="aborted", SingleResult.aborted=true
  expect(job!.status).toBe("failed");
  expect(job!.errorText).toContain("runtime limit exceeded");
  expect(job!.errorText).toContain("task.maxRuntimeMs=100");
  
  // F8: Artifact 应存在
  const artifactPath = path.join(session.artifactsDir, `${result.details.results[0].agentId}.md`);
  expect(await fs.exists(artifactPath)).toBe(true);
});
```

#### Scenario 2: Queued Timeout with Permit Release

**见 §7.1 task-spawn.test.ts**

#### Scenario 3: Staleness with Active Wait

```typescript
// test/tools/hub-wait.test.ts
it("should return diagnostic when job crosses staleness threshold during wait", async () => {
  const session = await createTestSession();
  session.settings.set("async.stalenessThresholdMs", 500);
  session.settings.set("async.stalenessMode", "on");
  
  const manager = session.asyncJobManager!;
  const jobId = manager.register("bash", "stuck-job", async ({ markRunning }) => {
    markRunning();
    await Bun.sleep(10000);  // Stuck
    return "never";
  }, {
    ownerId: session.getAgentId(),
    stalenessPolicy: { thresholdMs: 500, mode: "on" }
  });
  
  const hub = await HubTool.create(session);
  const waitPromise = hub.execute("call_1", { 
    op: "wait", 
    ids: [jobId], 
    timeoutMs: 2000 
  });
  
  const result = await waitPromise;
  
  // F3: 应在 ~500ms 返回 diagnostic，不是 2s poll
  expect(result.details.diagnostic).toBeDefined();
  expect(result.details.diagnostic!.staleIds).toContain(jobId);
  expect(result.details.diagnostic!.episodes[0].phase).toBe("running-no-progress");
});
```

### 7.3 回归测试

**执行命令**：
```bash
bun test test/async-job-manager.test.ts
bun test test/tools/hub-wait.test.ts
bun test test/job-poll-displacement.test.ts
bun test test/job-renderer-preview.test.ts
bun test test/task/task-spawn.test.ts
bun test test/task/executor-wall-clock.test.ts
bun test test/agent-session-async-delivery.test.ts
bun test test/settings-manager.test.ts
```

**高风险路径**：
- Register invariants (disposed/capacity/#resolveJobId) 不回归
- Two-owner policy isolation
- Delivery state transitions (pending→wait-claimed→delivered→acked)
- Poll/abort winners 不 hang
- Exactly-once (BOTH sides: wait-result count + custom-message count + episode state)

## 8. 实现阶段（F6: Opt-In Rollout）

### Phase 0: Schema Defaults + Off Mode

**时间**：Week 1  
**交付**：
- Settings schema 添加四个新字段（§5.1.3）
- `task.maxRuntimeMs` 默认改为 3600000（1h）
- `task.queuedStartupTimeoutMs` 默认 120000（2min）
- `async.stalenessThresholdMs` 默认 600000（10min）
- `async.stalenessMode` 默认 **"off"**（F6: 删除 shadow，简化为显式 opt-in）

**行为**：
- Runtime/queued timeout **自动生效**（默认非零）
- Staleness detection **不生效**（mode="off"）

**验证**：
- [拟议验收目标] N=10 本地测试 session，1 week
- Metrics: permit-leak rate=0, settlement-failure rate=0
- Min sample: 50 queued spawns, 20 runtime timeout

**Stop Condition**：
- Permit-leak rate > 0 → 回滚 queued timeout 到 0
- Settlement-failure rate > 5% → 修复 onSettled exactly-once

### Phase 1: Staleness Opt-In Canary

**时间**：Week 2-3  
**Activation**：显式设置 `async.stalenessMode="on"` 或 `async.stalenessThresholdMs>0`（任一即启用）

**交付**：
- AsyncJobManager lifecycle delivery 完整实现（§5.2.1）
- HubTool subscription API（§5.3.1）
- AgentSession typed event handler（§5.3.2）
- TUI diagnostic rendering（§5.3.3）

**验证**：
- [拟议验收目标] N=20 opt-in sessions，2 weeks，non-overlap interval
- Metrics (per-episode dedupe):
  - Staleness episode count
  - Diagnostic-actionable rate（owner 在通知后有干预行为）
  - False-positive proxy: salvage-success rate >80%
- Min sample: 50 staleness episodes

**Stop Condition**：
- Delivery exactly-once violated（同一 episode 重复注入）→ 修复 F1 claim 机制
- Episode state leak（pending 不清理）→ 修复 invalidation logic
- Diagnostic actionable rate <20% → 调整默认阈值或 fallback 到 off

**Rollback**：设置改回 `mode="off"`

### Phase 2: Default Mode="On"（Optional）

**前提**：Phase 1 通过所有 stop conditions

**时间**：Week 4-5  
**交付**：Settings schema default 改为 `async.stalenessMode="on"`

**验证**：
- [拟议验收目标] 全量观察 2 weeks
- Metrics 同 Phase 1，扩大分母

**Rollback**：Settings default 改回 "off"

### Phase 3: Queued Phase Timer（Optional）

**决定**：保留 queued phase（§5.2.1 queued-phase timer 启动逻辑）

**验证**：queued job 的 staleness episode.phase="queued" 可观测

### Phase 4: Watchdog/Advisor Integration（Optional, Out of P0-P2 Scope）

**注意**：现有 advisor/watchdog.ts 是被动审阅配置/prompt 加载器 [已核实]，不是 subagent 生命周期终止器。若未来实现主动干预，owner 必须仍在 async/task lifecycle，通过 AsyncJobManager cancel/abort+salvage canonical path 执行。

## 9. 可观测性与监控

### 9.1 Metrics Owner

**Owner**：AsyncJobManager + TaskTool  
**Storage**：结构化日志（job-manager.ts, task/index.ts）  
**Privacy**：jobId/ownerId/agentId only；无 user content

### 9.2 事件记录

```typescript
// 每个 lifecycle event 记录
{
  eventType: 'staleness' | 'queued-timeout' | 'runtime-timeout',
  episodeId: string,  // Deduplication key
  jobId: string,
  incarnationId: string,
  generation: number,
  ownerId?: string,
  agentId?: string,
  phase: 'queued' | 'running-no-progress' | 'running-idle',
  observedMs: number,
  thresholdMs: number,
  settingSnapshot: {
    maxRuntimeMs: number,
    queuedStartupTimeoutMs: number,
    stalenessThresholdMs: number,
    stalenessMode: string,
  },
  outcome: 'timeout' | 'cancel' | 'complete' | 'salvage',
  interval: { start: string, end: string },  // UTC timestamps
}
```

### 9.3 质量指标（F6: Ledger）

#### Permit-Leak Rate（queued timeout）

**定义**：queued timeout 后 permit 未释放的比率  
**分母**：所有 queued timeout events  
**Stop condition**：rate > 0

#### Settlement-Failure Rate

**定义**：onSettled 未调用或调用多次的比率  
**分母**：所有 job settlements  
**Stop condition**：rate > 5%

#### Salvage-Success Rate（runtime timeout）

**定义**：runtime timeout 后 artifact 成功落盘的比率  
**分母**：所有 runtime timeout events  
**Target**：[拟议验收目标] >80%

#### Diagnostic-Actionable Rate（staleness）

**定义**：staleness diagnostic 后 owner 有干预行为（inspect/cancel/adjust/wait）的比率  
**分母**：所有 staleness episodes  
**Target**：[拟议验收目标] >20%

**非目标**：不以"diagnostic 后 cancel rate"作质量指标（正确干预包括 inspect、history、调整阈值、自然完成）

### 9.4 Rollout Ledger（F6）

```typescript
interface RolloutRecord {
  featureVersion: string;         // Schema hash
  episodeId: string;              // Dedupe key
  jobId: string;
  ownerId?: string;
  settingSnapshot: { /* ... */ };
  outcome: string;
  interval: { start: string; end: string };
  cohort?: string;                // Optional: 若实现远程 cohort assignment
}
```

**Non-overlap interval**：同一 episode 仅计一次（按 episodeId 去重）

**Privacy**：本地 CLI 无远程 cohort 分配；ledger 仅本地 structured logs

---

## 附录：F1-F8 Findings 关闭报告

- **F1（高）Canonical Lifecycle Delivery Seam**：§5.1.2（DiagnosticEpisode + typed event union），§5.2.1（状态机 + generic delivery engine extension），§5.3.2（AgentSession typed handler + YieldQueue epoch/stale）
- **F2（高）Staleness Policy Ownership**：§5.1.1（stalenessPolicy field），§5.1.3（per-job frozen policy），§5.2.1（timer uses job.stalenessPolicy），§5.2.3（register assigns incarnationId=UUID）
- **F3（高）Hub Wait Typed API**：§5.2.1（subscribeLifecycleEvents + claimPendingDiagnostic），§5.3.1（tagged winner + post-wake arbitration + 7th param）
- **F4（高）JobSnapshot Liveness Fields**：§5.1.2（queuedForMs/startupDelayMs/idleForMs/agentIdleForMs），§5.3.3（snapshotJobs computation + hub display）
- **F5（高）buildJobResult Surgical Diff**：§5.3.3（7th options param + conditional spreads + automatic ack + jobsRenderResult seam）
- **F6（高）Final Mode/Default/Rollout**：§5.1.3（mode=off|on，删除 shadow），§8（opt-in canary + metrics/privacy/ledger）
- **F7（高）Verification Plan**：§7（real test owners + observable contracts + Settings.isolated() conventions）
- **F8（中）Factual Anchors**：§1.3（agent://<id> 无 .md），§2.1（SOFT_REQUEST_BUDGET owner=task/executor.ts:93-96），全文锚点已校正
