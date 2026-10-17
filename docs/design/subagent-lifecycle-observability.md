## 1. 目标与范围

### 1.1 核心目标

使 oh-my-pi coding-agent 中的 subagent 生命周期失败（卡住、未启动、父代理无感知）变得**可观测**且**可恢复**：

1. **检测**：机器自主、确定性地检测卡住（stuck mid-run）和队列饥饿（never started）
2. **可见性**：`hub jobs`/`wait` 快照暴露活性指标，让 LLM 和人类都能理解状态
3. **干预**：父代理和用户可以通过现有工具（`hub cancel`、调高并发、resume）介入
4. **追溯**：已完成任务的 output/transcript 可通过 `agent://`/`history://` 追溯（parked 父代理复活后仍可访问已落盘内容）

---

### 1.2 必须实现（P0/P1）

- P0: 默认启用的 `task.maxRuntimeMs` 非零值（wall-clock 兜底）[拟议验收目标]
- P0: 队列启动超时（queued >阈值 → 自动 fail，避免无限等待）[拟议验收目标]
- P1: 活性字段注入快照（`queuedForMs`, `startupDelayMs`, `idleForMs`）
- P1: staleness 事件主动投递（AsyncJobManager 检测超时后向 owner sink 投递诊断，不依赖 LLM 记得 poll）

---

### 1.3 非目标

- 不替换用户的 LLM 判断层（周期性探测仍有效作为兜底）
- 不引入新子系统（watchdog 可选 P4，非强制依赖）
- 不改变现有 job/agent 生命周期语义（additive 扩展，但 intentional default behavior change: 默认启用超时）
- 不在本次交付中实现 parked-parent 的自动通知重放（已移出核心目标；自动通知可能丢失，但 output/transcript 已落盘可追溯）

---

## 2. 背景与现状

### 2.1 已验证事实（anchors from verified brief）

#### 2.1.1 架构

- Subagents 运行在进程内作为后台 jobs (AsyncJobManager; `async.enabled` default true)
- Batch spawns (`task` tool) 由 per-session semaphore 控制 (`task.maxConcurrency` default 32)
- Jobs 以 `queued: true` 注册，拿到 permit 后 `markRunning()` (`task/index.ts` `#registerSpawnJob`)

#### 2.1.2 快照与可见性

- 父代理通过 `hub` tool 协调
- `#executeWait` (`tools/hub/index.ts`) races: watched job promises + IrcBus message + poll window
- 返回 FIRST settled job（model 需 re-issue 继续等待）
- Poll window = smart ladder `[5s,10s,30s,60s,300s]` with 60s reset (`async/job-manager.ts`)
- Job snapshot (`tools/hub/jobs.ts` `snapshotJobs`) 仅暴露: id, type, status, label, durationMs, resolvedModel, resultText, errorText
- 缺失: liveness, queued flag, queued-for duration
- All-still-running wait 结果标记 `useless: true` (`isWaitingPollDetails` / `buildJobResult`)

#### 2.1.3 AgentRegistry

- `AgentRef` 有 `status` (running|idle|parked|aborted), `lastActivity` (每次 running heartbeat 刷新)
- Roster 显示 "active ... ago"
- 但 `lastActivity` 不进入 jobs path（job-backed agents 由 job rows 覆盖，不是 jobless roster）

#### 2.1.4 超时与限制

- Stream-level: pi-ai 的 first-event 100s / idle 120s watchdogs (`packages/ai/src/utils/idle-iterator.ts`)
- Tool-level: bash default 300s max 3600s, eval 30s, browser 30s... (`tools/tool-timeouts.ts`)
- Run-level: soft request budget `{scout:100, sonic:100, default:200}`; 1.5× force-stop with 5 grace (`task/executor.ts`)
- **关键缺口**: `task.maxRuntimeMs` default 0 = DISABLED (`config/settings-schema.ts` L4737)

#### 2.1.5 队列与取消

- Queued jobs: `status` 显示 "running" while `queued=true`; `getRunningJobs` includes them
- `cancel()` works on queued jobs (aborts semaphore acquire via runSignal — `task/index.ts` L1104-1114)
- Spawn failures surface: `StructuredSubagentError` → `TaskJobError` → job fails with hint
- Missing-yield: 3 reminders then `SUBAGENT_WARNING_MISSING_YIELD`

#### 2.1.6 结果投递

- Delivery: infinite retry, exp backoff 500ms→30s, while owner sink live
- Dead-lettered (dropped) when owner session parked/disposed
- Job rows evict after `DEFAULT_RETENTION_MS` = 5 min (`async/job-manager.ts`)
- **Output/transcript 持久化**: task executor 写入 `<artifactsDir>/<id>.md`; `agent://`/`history://` 从 session lineage 和 AgentRegistry retained sessionFile 读取这些文件

#### 2.1.7 现有 abort+salvage path

- `task.maxRuntimeMs` (when >0) 触发 wall-clock timeout
- Executor salvages partial output (`formatSalvageSnippet`; outputPath retained)
- Abort kinds: signal|terminate|timeout|budget
- Budget-stop 可 resume (keepAlive, non-isolated); timeout/signal/terminate terminal

---

## 3. 失败模式与用户方案评估

### 3.1 三种失败模式（用户报告，已映射到代码）

1. **卡住 (stuck mid-run)**: maxRuntimeMs=0 无 wall-clock backstop；一个 subagent 卡在单个长工具调用（bash ≤3600s）或非流式 provider call 中不可见；snapshot 隐藏活性，父代理无法区分 stuck vs slow
2. **未正确启动 (never started)**: 注册的 job 停在饱和的信号量上（e.g. 32 stuck runs ahead）显示为 "running" with growing durationMs — 与正常 job 相同；无 queued visibility，无 queued-time cap
3. **无法感知 (parent unaware)**: 检测是 pull-based（model 必须记得 poll `hub wait`/`jobs`）；polls 返回 `useless` still-running frames with no diagnosis；plus edge: parent session parked → delivery dead-lettered → **自动通知丢失**（但 output/transcript 已通过 `<artifactsDir>/<id>.md` 和 sessionFile 落盘，可通过 `agent://<id>`/`history://<id>` 追溯）

### 3.2 用户提议方向的评估

**方案**: 父代理周期性探测 (`hub jobs`/`wait`) 并干预 (`hub cancel`, 调高并发, resume)

**评估**: 
- 作为**最终兜底决策层**有效：LLM 可根据业务上下文判断是否干预
- 但作为**主要检测机制**脆弱，因为：
  - (a) 父代理自身可能处于不可中断的长工具调用中，无法探测
  - (b) LLM 无时钟纪律 — "periodic"不是保证
  - (c) 从快照推断 stuck-vs-slow 正是机器应拥有的确定性职责

**结论**: 保留为兜底，但不作为主要检测。P0/P1 必须实现 machine-owned detection。

---

## 4. 方案对比

### 4.1 候选方案

#### 方案 A: 检测+推送在 wait loop (primary)，LLM probing (fallback)

**机制**:
- P0: `task.maxRuntimeMs` default 3600000 (1h) [拟议验收目标] + queued-startup timeout 120s [拟议验收目标]
- P1: AsyncJob 持有 staleness deadline；超时后主动向 owner sink 投递诊断事件（不依赖 LLM 再次 wait）
- P1: JobSnapshot 扩展活性字段 (`queuedForMs`, `startupDelayMs`, `idleForMs`)
- P2: 诊断帧明确列出干预选项 (`hub cancel`, raise concurrency)
- P4 (optional): 独立 watchdog timer (in async/task lifecycle, not advisor subsystem)

**优势**:
- 检测完全 machine-owned，不受父代理阻塞影响
- 复用现有 AsyncJobManager、hub tool、abort+salvage path
- 增量可分阶段上线（P0→P1→P2→P4）

**劣势**:
- 需要设计 staleness event delivery priority 与去重
- 默认值尚无基线数据 [未验证假设]

---

#### 方案 B: 专用 watchdog 子系统

**机制**:
- 新增独立 SubagentWatchdog (timer 扫描 AsyncJobManager + AgentRegistry)
- 检测到 stale → 直接 abort job 或投递通知

**优势**:
- 完全独立，不干扰现有 wait/job/delivery 路径

**劣势**:
- 新增子系统（违反"小而无聊"原则）
- 仍需定义与 AsyncJobManager 的 canonical ownership（abort 必须走现有 cancel+salvage path）
- 不能早于 P1 交付（依赖 lastProgressAt 等活性字段）

**注**: 现有 `advisor/watchdog.ts` 是被动审阅配置，不是执行 owner；若未来实现方案 B，owner 必须在 async/task lifecycle，通过 AsyncJobManager cancel/abort+salvage canonical path 执行。

---

#### 方案 C: 纯 LLM probing（现状 + docs）

**机制**:
- 不改代码，只完善 prompt/文档，教育 LLM 定期 poll

**优势**:
- 零代码成本

**劣势**:
- 不解决"父代理自身阻塞"和"LLM 无时钟纪律"
- 仍依赖 `useless` poll frame 推断

---

### 4.2 推荐方案

**选择**: 方案 A

**理由**:
- 满足"machine-owned detection"核心要求
- 最大复用面（AsyncJobManager、hub、task semaphore、AgentRegistry）
- P0/P1 可在 1 周内交付，P2/P4 optional
- 保留 LLM probing 作为兜底（不互斥）

---

## 5. 详细设计（方案 A）

### 5.1 数据结构与新增字段

#### 5.1.1 AsyncJob 扩展 (`async/job-manager.ts`)

```typescript
interface AsyncJob {
  // ... existing fields ...
  
  /** Timestamp (ms) of last reportProgress call. undefined if never reported. */
  lastProgressAt?: number;
  
  /** Timestamp (ms) when markRunning() was called (permit acquired). undefined if still queued. */
  runningStartedAt?: number;
}
```

**Owner**: `AsyncJobManager.register()` 在 `reportProgress` callback 中打点 `lastProgressAt`；在 `markRunning` callback 中打点 `runningStartedAt`。

**向后兼容**: 新字段 optional；老 callers 不调用这些 callbacks 时保持 undefined，不报错。

---

#### 5.1.2 JobSnapshot 扩展 (`tools/hub/jobs.ts`)

```typescript
export interface JobSnapshot {
  // ... existing fields ...
  
  /** Time (ms) spent queued waiting for semaphore permit. ONLY present when job.queued===true (current phase). */
  queuedForMs?: number;
  
  /** Historical startup delay (ms) from registration to permit acquisition. Present when job has runningStartedAt (was queued, now running). */
  startupDelayMs?: number;
  
  /** Time (ms) since last activity. Present when job is running (not queued). Baseline: lastProgressAt ?? runningStartedAt ?? startTime. */
  idleForMs?: number;
  
  /** Agent registry lastActivity cross-check (ms since last heartbeat). Only for job-backed agents. Informational; not used for primary staleness determination. */
  agentIdleForMs?: number;
}
```

**Owner**: `snapshotJobs()` 计算并填充

**语义规则**:
- `queuedForMs` 与 `startupDelayMs` 互斥：前者表示"当前正在排队"，后者表示"曾经排队过的历史记录"
- `idleForMs` 对无首个 progress 的 job 仍可计算（fallback 到 runningStartedAt 或 startTime），确保无首个 progress 的 hung provider/setup path 也可被 staleness 检测
- 所有时间指标均为 optional；老 jobs / 未调用 markRunning/reportProgress 的 jobs 不报错

**计算逻辑**:
```typescript
const now = Date.now();
const job = manager.getJob(j.id);

// Current queued phase (queued===true): show queuedForMs
const queuedForMs = job?.queued ? now - job.startTime : undefined;

// Historical startup delay (was queued, now running): show startupDelayMs
const startupDelayMs = (!job?.queued && job?.runningStartedAt)
  ? job.runningStartedAt - job.startTime
  : undefined;

// Idle time for running (not queued) jobs: fallback chain
const idleForMs = (job?.status === "running" && !job?.queued)
  ? now - (job.lastProgressAt ?? job.runningStartedAt ?? job.startTime)
  : undefined;

// Cross-check from AgentRegistry (informational only)
let agentIdleForMs: number | undefined;
if (job?.agentId && session.agentRegistry) {
  const ref = session.agentRegistry.get(job.agentId);
  if (ref && ref.status === "running") {
    agentIdleForMs = now - ref.lastActivity;
  }
}
```

**Diagnostic per-job reason**:
诊断帧应携带每个 stale job 的明确 reason/phase，而不依赖 snapshot 字段存在性推断：

```typescript
interface JobDiagnosticReason {
  jobId: string;
  phase: "queued" | "running_idle" | "running_no_progress";
  thresholdMs: number;
  observedMs: number; // queuedForMs or idleForMs
}
```

---

#### 5.1.3 Settings schema 变更 (`config/settings-schema.ts`)

**变更项 1**: `task.maxRuntimeMs` default 从 `0` 改为 **`3600000`** (1 hour) [拟议验收目标]

```typescript
"task.maxRuntimeMs": {
  type: "number",
  default: 3600000,  // WAS: 0; [拟议验收目标: 需 p95 运行时长数据验证]
  ui: {
    tab: "tasks",
    group: "Subagents",
    label: "Max Subagent Runtime",
    description:
      "Hard wall-clock limit per subagent (ms). 0 disables. Defense-in-depth against hung provider streams and stuck tool calls. Default 1 hour; tune per workload.",
    options: [
      { value: "0", label: "Unlimited (not recommended)" },
      { value: "300000", label: "5 minutes" },
      { value: "900000", label: "15 minutes" },
      { value: "1800000", label: "30 minutes" },
      { value: "3600000", label: "1 hour", description: "Default [拟议验收目标]" },
      { value: "7200000", label: "2 hours" },
    ],
  },
},
```

**理由**: default 0 留下无限运行的窗口；1 hour 是保守默认 [未验证假设: 需基线数据]。用户可调至 0（按需禁用）或更短（严格环境）。

---

**新增项 2**: `task.queuedStartupTimeoutMs` (P0) [拟议验收目标]

```typescript
"task.queuedStartupTimeoutMs": {
  type: "number",
  default: 120000,  // 2 minutes [拟议验收目标]
  ui: {
    tab: "tasks",
    group: "Subagents",
    label: "Queued Startup Timeout",
    description:
      "Max time (ms) a job can remain queued before auto-failing. Detects semaphore saturation (all permits held by stuck runs). 0 disables.",
    options: [
      { value: "0", label: "Unlimited" },
      { value: "60000", label: "1 minute" },
      { value: "120000", label: "2 minutes", description: "Default [拟议验收目标]" },
      { value: "300000", label: "5 minutes" },
    ],
  },
},
```

**理由**: 当信号量饱和（32 stuck runs）时，新 spawn 永远不会 start；120s 是合理的"队列太长"信号 [未验证假设]。

---

**新增项 3**: `async.stalenessThresholdMs` (P1) [拟议验收目标]

```typescript
"async.stalenessThresholdMs": {
  type: "number",
  default: 600000,  // 10 minutes [拟议验收目标]
  ui: {
    tab: "tasks",
    group: "Background Jobs",
    label: "Job Staleness Threshold",
    description:
      "Time (ms) without progress before a running job is considered stale. AsyncJobManager delivers diagnostic event to owner when exceeded. 0 disables staleness detection.",
    options: [
      { value: "0", label: "Disabled" },
      { value: "300000", label: "5 minutes" },
      { value: "600000", label: "10 minutes", description: "Default [拟议验收目标]" },
      { value: "1200000", label: "20 minutes" },
    ],
  },
},
```

**理由**: 10min 无进展是 stuck 的强信号 [未验证假设: 正常 subagent 每个 tool call / message 都通过 reportProgress 报告活动]。

---

### 5.2 控制流变更


#### 5.2.1 AsyncJobManager — Staleness monitoring lifecycle event

**位置**: `async/job-manager.ts`

**变更概述**: 扩展 AsyncJobRegisterOptions 接收 staleness policy；job 先入 #jobs 再启动 run；持有 per-job generation staleness timer；投递结构化 lifecycle event 到可等待 channel；settle/cancel/evict/dispose 时清理。

---

##### 5.2.1.1 注册选项扩展

```typescript
interface AsyncJobRegisterOptions {
  // ... existing fields: id, agentId, ownerId, queued, onProgress, onSettled ...
  
  /** Staleness policy for this job. If provided, manager will monitor and emit lifecycle events. */
  stalenessPolicy?: {
    thresholdMs: number;  // from Settings at spawn time, frozen per job
  };
}
```

**Owner**: TaskTool 在 #registerSpawnJob 时读取 `settings.get("async.stalenessThresholdMs")`，若 >0 则传入 stalenessPolicy；其他 callers 省略此字段则不监控。

**语义**: threshold 在注册时冻结，不受后续 Settings 变更影响（per-job 稳定）。

---

##### 5.2.1.2 AsyncJob 扩展字段与 generation

```typescript
interface AsyncJob {
  // ... existing fields ...
  
  /** Staleness policy snapshot (frozen at registration). undefined if not monitored. */
  stalenessPolicy?: { thresholdMs: number };
  
  /** Generation counter: incremented on every progress/markRunning; used for episode deduplication. */
  generation: number;
  
  /** Timestamp (ms) of last reportProgress call. undefined if never reported. */
  lastProgressAt?: number;
  
  /** Timestamp (ms) when markRunning() was called (permit acquired). undefined if still queued. */
  runningStartedAt?: number;
}
```

**Owner**: AsyncJobManager.register()

**向后兼容**: 新字段 optional；老 jobs 不报错。

---

##### 5.2.1.3 注册与监控启动流程

```typescript
register(...): string {
  // ... existing id generation, abortController setup ...
  
  const job: AsyncJob = {
    id,
    type,
    status: "running",
    startTime,
    label,
    abortController,
    promise: Promise.resolve(),
    ownerId: options?.ownerId,
    agentId: options?.agentId,
    queued: options?.queued === true,
    stalenessPolicy: options?.stalenessPolicy,  // NEW: freeze threshold
    generation: 0,  // NEW: start at 0
    lastProgressAt: undefined,
    runningStartedAt: undefined,
  };
  
  // NEW: job 先入表，再启动 run/timer（避免 callback 时 no-op）
  this.#jobs.set(id, job);
  
  const reportProgress = async (text: string, details?: Record<string, unknown>): Promise<void> => {
    if (details) job.latestDetails = details;
    job.lastProgressAt = Date.now();
    job.generation += 1;  // NEW: progress increments generation
    
    this.#resetStalenessTimer(id);  // NEW: reset timer on progress
    
    if (!options?.onProgress) return;
    // ... existing onProgress call ...
  };
  
  job.promise = (async () => {
    try {
      const text = await run({
        jobId: id,
        signal: abortController.signal,
        reportProgress,
        markRunning: () => {
          job.queued = false;
          job.runningStartedAt = Date.now();
          job.generation += 1;  // NEW: markRunning increments generation
          this.#resetStalenessTimer(id);  // NEW: start/reset monitoring once running
        },
      });
      // ... existing completion logic ...
    } finally {
      this.#clearStalenessTimer(id);  // NEW: cleanup timer
    }
  })();
  
  // NEW: also monitor queued phase if policy exists
  if (job.stalenessPolicy) {
    this.#resetStalenessTimer(id);
  }
  
  return id;
}
```

**关键顺序**: 
1. `this.#jobs.set(id, job)` — job 入表
2. `job.promise = ...` — 启动 run
3. `#resetStalenessTimer(id)` — 启动监控（此时可安全 get job）

---

##### 5.2.1.4 Staleness timer 管理（per-job generation）

```typescript
// Per-job staleness timers
#stalenessTimers = new Map<string, { timer: NodeJS.Timeout; generation: number }>();

#resetStalenessTimer(jobId: string): void {
  const job = this.#jobs.get(jobId);
  if (!job || !job.stalenessPolicy || job.stalenessPolicy.thresholdMs <= 0) return;
  
  this.#clearStalenessTimer(jobId);
  
  const currentGeneration = job.generation;
  const timer = setTimeout(() => {
    this.#handleStaleness(jobId, currentGeneration);
  }, job.stalenessPolicy.thresholdMs);
  
  timer.unref(); // don't block process exit
  this.#stalenessTimers.set(jobId, { timer, generation: currentGeneration });
}

#clearStalenessTimer(jobId: string): void {
  const entry = this.#stalenessTimers.get(jobId);
  if (entry) {
    clearTimeout(entry.timer);
    this.#stalenessTimers.delete(jobId);
  }
}

#handleStaleness(jobId: string, expectedGeneration: number): void {
  const job = this.#jobs.get(jobId);
  if (!job || job.status !== "running") return;
  
  // Episode deduplication: only emit if generation unchanged
  if (job.generation !== expectedGeneration) return;
  
  const now = Date.now();
  const thresholdMs = job.stalenessPolicy?.thresholdMs ?? 0;
  
  // Determine phase and observedMs
  let phase: "queued" | "running_idle" | "running_no_progress";
  let observedMs: number;
  
  if (job.queued) {
    phase = "queued";
    observedMs = now - job.startTime;
  } else if (job.lastProgressAt) {
    phase = "running_idle";
    observedMs = now - job.lastProgressAt;
  } else {
    phase = "running_no_progress";
    observedMs = now - (job.runningStartedAt ?? job.startTime);
  }
  
  // Emit lifecycle event to waitable channel
  const event: AsyncJobLifecycleEvent = {
    type: "staleness",
    jobId: job.id,
    agentId: job.agentId,
    ownerId: job.ownerId,
    detectedAt: now,
    generation: job.generation,
    phase,
    observedMs,
    thresholdMs,
  };
  
  this.#emitLifecycleEvent(event);
}
```

**Episode deduplication**: timer 持有触发时的 generation；callback 检查 job.generation 未变才发送。Progress/markRunning 递增 generation → 旧 timer 的 callback 成为 no-op。

**Cleanup**: settle/cancel 时 finally 调 #clearStalenessTimer；evict/dispose 也需调用（扩展现有 evictJob/dispose）。

---

##### 5.2.1.5 Lifecycle event channel (waitable)

```typescript
interface AsyncJobLifecycleEvent {
  type: "staleness";
  jobId: string;
  agentId?: string;
  ownerId?: string;
  detectedAt: number;
  generation: number;
  phase: "queued" | "running_idle" | "running_no_progress";
  observedMs: number;
  thresholdMs: number;
}

// Lifecycle event subscribers (per owner, for hub wait to watch)
#lifecycleSubscribers = new Map<string, Array<{
  watchedIds?: string[];
  resolve: (event: AsyncJobLifecycleEvent) => void;
}>>();

subscribeLifecycleEvents(
  ownerId: string,
  watchedIds?: string[]
): { promise: Promise<AsyncJobLifecycleEvent>; unsubscribe: () => void } {
  let resolve: (event: AsyncJobLifecycleEvent) => void;
  const promise = new Promise<AsyncJobLifecycleEvent>(r => { resolve = r; });
  
  const subscriber = { watchedIds, resolve: resolve! };
  
  if (!this.#lifecycleSubscribers.has(ownerId)) {
    this.#lifecycleSubscribers.set(ownerId, []);
  }
  this.#lifecycleSubscribers.get(ownerId)!.push(subscriber);
  
  const unsubscribe = () => {
    const subs = this.#lifecycleSubscribers.get(ownerId);
    if (subs) {
      const idx = subs.indexOf(subscriber);
      if (idx >= 0) subs.splice(idx, 1);
      if (subs.length === 0) this.#lifecycleSubscribers.delete(ownerId);
    }
  };
  
  return { promise, unsubscribe };
}

#emitLifecycleEvent(event: AsyncJobLifecycleEvent): void {
  const subs = this.#lifecycleSubscribers.get(event.ownerId ?? "");
  if (!subs || subs.length === 0) return;
  
  for (const sub of subs) {
    // Check if this subscriber is watching this job
    if (sub.watchedIds && !sub.watchedIds.includes(event.jobId)) continue;
    
    sub.resolve(event);
    // Remove subscriber after resolving (one-shot)
    const idx = subs.indexOf(sub);
    if (idx >= 0) subs.splice(idx, 1);
  }
  
  if (subs.length === 0) this.#lifecycleSubscribers.delete(event.ownerId ?? "");
}
```

**语义**: 
- `subscribeLifecycleEvents` 返回 promise + unsubscribe；promise 在首个匹配 event 时 resolve
- One-shot: resolve 后自动 unsubscribe
- Hub wait 将此 promise 加入 race；若未等到则 unsubscribe cleanup

**Exactly-once**: 一个 stale episode (jobId + generation) 只 resolve 一个 active subscriber；无 subscriber 时事件丢弃（诊断性事件，非 critical delivery）。

---

##### 5.2.1.6 Cleanup on settle/evict/dispose

```typescript
// In existing settle logic (complete/fail)
private completeJob(jobId: string, text: string): void {
  // ... existing completion ...
  this.#clearStalenessTimer(jobId);  // NEW
  // ... existing delivery ...
}

// In existing evictJob
private evictJob(jobId: string): void {
  this.#clearStalenessTimer(jobId);  // NEW
  // ... existing eviction ...
}

// In dispose
dispose(): void {
  for (const jobId of this.#stalenessTimers.keys()) {
    this.#clearStalenessTimer(jobId);
  }
  this.#lifecycleSubscribers.clear();
  // ... existing dispose ...
}
```

**Job-id reuse**: 新 spawn 用旧 id → new job.generation=0，旧 timer 的 expectedGeneration 不匹配 → no-op。

---

**向后兼容**: 
- AsyncJobRegisterOptions.stalenessPolicy optional → 老 callers 不传，不监控
- subscribeLifecycleEvents 仅 HubTool 调用；其他 manager users 不受影响


#### 5.2.2 snapshotJobs() — 计算并暴露活性指标

**位置**: `tools/hub/jobs.ts` `snapshotJobs()` function

**变更**: 计算 queuedForMs/startupDelayMs/idleForMs/agentIdleForMs

```typescript
export function snapshotJobs(session: ToolSession, jobs: TrackedJobLike[]): JobSnapshot[] {
  const now = Date.now();
  return jobs.map(j => {
    const current = session.asyncJobManager?.getJob(j.id);
    const latest = current ?? j;
    
    // ... existing resolvedModel extraction ...
    
    // NEW: compute liveness metrics (per §5.1.2 semantics)
    const queuedForMs = latest.queued ? now - latest.startTime : undefined;
    
    const startupDelayMs = (!latest.queued && latest.runningStartedAt)
      ? latest.runningStartedAt - latest.startTime
      : undefined;
    
    const idleForMs = (latest.status === "running" && !latest.queued)
      ? now - (latest.lastProgressAt ?? latest.runningStartedAt ?? latest.startTime)
      : undefined;
    
    let agentIdleForMs: number | undefined;
    if (latest.agentId && session.agentRegistry) {
      const ref = session.agentRegistry.get(latest.agentId);
      if (ref && ref.status === "running") {
        agentIdleForMs = now - ref.lastActivity;
      }
    }
    
    return {
      id: latest.id,
      type: latest.type,
      status: latest.status as JobSnapshot["status"],
      label: latest.label,
      durationMs: Math.max(0, now - latest.startTime),
      ...(resolvedModel ? { resolvedModel } : {}),
      ...(queuedForMs !== undefined ? { queuedForMs } : {}),  // NEW
      ...(startupDelayMs !== undefined ? { startupDelayMs } : {}),  // NEW
      ...(idleForMs !== undefined ? { idleForMs } : {}),  // NEW
      ...(agentIdleForMs !== undefined ? { agentIdleForMs } : {}),  // NEW
      ...(latest.resultText ? { resultText: latest.resultText } : {}),
      ...(latest.errorText ? { errorText: latest.errorText } : {}),
    };
  });
}
```

---


#### 5.2.3 HubTool#executeWait() — Waitable staleness race leg with post-wake arbitration

**位置**: `tools/hub/index.ts` `#executeWait()` method

**变更概述**: 订阅 AsyncJobManager lifecycle events 作为 race leg；post-wake arbitration 确定优先级；exactly-once 消费。

---

##### 5.2.3.1 Race setup with staleness leg

```typescript
async #executeWait(
  toolCallId: string,
  { ids, from, timeoutMs }: HubWaitParams,
  signal?: AbortSignal,
  onUpdate?: AgentToolUpdateCallback<HubDetails>,
): Promise<AgentToolResult<HubDetails>> {
  // ... existing setup ...
  
  const manager = this.session.asyncJobManager;
  const messaging = this.#getMessagingBus();
  
  // Preserve message-only wait when no manager
  if (!manager) {
    if (!messaging) return errorResult("No coordination channel available");
    // ... existing message-only wait (executeMessageWait) ...
    const msg = await messaging.wait({ from, timeoutMs, signal });
    return this.#buildMessageResult(msg);
  }
  
  const ownerId = this.session.getAgentId?.() ?? undefined;
  const jobsToWatch = ids ? visibleJobs(manager, ids, ownerId) : manager.getRunningJobs({ ownerId });
  const runningJobs = jobsToWatch.filter(job => job.status === "running");
  
  if (runningJobs.length === 0 && !messaging) {
    return nothingToWaitForResult(this.session, manager, jobsToWatch);
  }
  
  const watchedJobIds = runningJobs.map(job => job.id);
  
  // Race legs setup
  const racePromises: Array<Promise<{ leg: string; value?: any }>> = [];
  const cleanups: Array<() => void> = [];
  
  // Leg 1: Buffered messages (if messaging available)
  if (messaging) {
    const msgPromise = messaging.wait({ from, timeoutMs: 0 }).then(msg => ({ leg: "message", value: msg }));
    racePromises.push(msgPromise);
  }
  
  // Leg 2: Settled jobs
  const settledPromise = Promise.race(
    runningJobs.map(job => job.promise.then(() => ({ leg: "settled", value: job.id })))
  );
  racePromises.push(settledPromise);
  
  // Leg 3: Staleness events (NEW)
  if (runningJobs.length > 0) {
    const { promise: stalenessPromise, unsubscribe } = manager.subscribeLifecycleEvents(ownerId, watchedJobIds);
    cleanups.push(unsubscribe);
    racePromises.push(stalenessPromise.then(event => ({ leg: "staleness", value: event })));
  }
  
  // Leg 4: Poll window timeout
  const pollWindowMs = this.#resolvePollWindow(timeoutMs);
  const pollPromise = new Promise<{ leg: string }>(resolve => {
    setTimeout(() => resolve({ leg: "poll" }), pollWindowMs);
  });
  racePromises.push(pollPromise);
  
  // Leg 5: Explicit abort
  if (signal) {
    const abortPromise = new Promise<{ leg: string }>((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    racePromises.push(abortPromise);
  }
  
  let winner: { leg: string; value?: any };
  
  try {
    winner = await Promise.race(racePromises);
  } catch (error) {
    // Explicit abort
    throw error;
  } finally {
    for (const cleanup of cleanups) cleanup();
  }
  
  // POST-WAKE ARBITRATION (NEW)
  return this.#arbitrateWaitResult(winner, manager, messaging, jobsToWatch, watchedJobIds, from);
}
```

**关键变更**:
1. Staleness 作为真实 race leg（通过 subscribeLifecycleEvents promise）
2. Race 返回 `{ leg, value }` 标识 winner
3. Post-wake arbitration 确定最终优先级

---

##### 5.2.3.2 Post-wake arbitration

```typescript
#arbitrateWaitResult(
  winner: { leg: string; value?: any },
  manager: AsyncJobManager,
  messaging: IrcBus | undefined,
  allJobs: TrackedJobLike[],
  watchedJobIds: string[],
  from?: string,
): AgentToolResult<HubDetails> {
  // Priority: buffered message > settled job > staleness > poll
  
  // 1. Check buffered messages (highest priority)
  if (messaging) {
    const buffered = messaging.poll(from);
    if (buffered) {
      return this.#buildMessageResult(buffered);
    }
  }
  
  // 2. Check settled jobs (re-snapshot to get latest state)
  const currentJobs = allJobs.map(j => manager.getJob(j.id) ?? j);
  const newlySettled = currentJobs.filter(j => 
    watchedJobIds.includes(j.id) && j.status !== "running"
  );
  
  if (newlySettled.length > 0) {
    const completedIds = newlySettled.map(j => j.id);
    return buildJobResult(this.session, manager, "wait", allJobs, completedIds);
  }
  
  // 3. Staleness event (if winner is staleness AND job still running)
  if (winner.leg === "staleness") {
    const event = winner.value as AsyncJobLifecycleEvent;
    const job = manager.getJob(event.jobId);
    
    // Only return diagnostic if job still running (not settled during race)
    if (job && job.status === "running" && job.generation === event.generation) {
      const diagnostic: CoordinationDetails["diagnostic"] = {
        reason: "staleness",
        thresholdMs: event.thresholdMs,
        staleJobs: [{
          jobId: event.jobId,
          phase: event.phase,
          observedMs: event.observedMs,
        }],
      };
      
      return buildJobResult(this.session, manager, "wait", allJobs, [], diagnostic);
    }
    
    // Job settled or generation changed → discard stale event, fall through to poll
  }
  
  // 4. Poll window timeout (useless still-running result)
  return buildJobResult(this.session, manager, "wait", allJobs);
}
```

**优先级规则** (FIRST wins after wake):
1. **Buffered message** — 检查 messaging.poll(from)，即使 winner 是其他 leg
2. **Settled job** — re-snapshot 检查是否有新完成的 job
3. **Staleness** — 仅当 job 仍 running 且 generation 匹配时返回 diagnostic；否则丢弃
4. **Poll** — 普通 useless still-running frame

**Exactly-once**:
- Staleness event 只 resolve 一个 subscriber（§5.2.1.5 one-shot）
- 若 job 在事件投递与 arbitration 之间 settled，generation check 丢弃 stale event
- 无 active waiter 时事件丢弃（诊断性，非 critical）

---

##### 5.2.3.3 无 manager 场景兼容

```typescript
// 已在 §5.2.3.1 处理
if (!manager) {
  if (!messaging) return errorResult("No coordination channel available");
  // executeMessageWait: pure message wait without job polling
  const msg = await messaging.wait({ from, timeoutMs, signal });
  return this.#buildMessageResult(msg);
}
```

**向后兼容**: 无 manager 环境保持 message-only wait 语义，不报错。

---

##### 5.2.3.4 Poll window resolution (unchanged)

```typescript
#resolvePollWindow(explicitTimeoutMs?: number): number {
  if (explicitTimeoutMs !== undefined && explicitTimeoutMs > 0) {
    return explicitTimeoutMs;
  }
  
  const pollMode = this.session.settings.get("async.pollWaitDuration") ?? "smart";
  
  if (pollMode === "smart") {
    // Existing smart ladder: [5s, 10s, 30s, 60s, 300s] with 60s reset
    return this.#getSmartPollWindow();
  }
  
  return typeof pollMode === "number" ? pollMode : 30000;
}
```

**不变**: poll window 逻辑保持现状；staleness 作为独立 race leg 不改变 poll 行为。


#### 5.2.4 task spawn — 队列启动超时（竞态安全）

**位置**: `task/index.ts` `#registerSpawnJob()` method

**变更概述**: 独立 try/catch acquire；unique Symbol token first-cause 判定；post-acquire check；全部释放走 canonical #releaseSpawnSemaphore；exactly-once onSettled。

---

```typescript
#registerSpawnJob(options: { ... }): string {
  const { manager, agentId, progress, buildDetails, onUpdate, onSettled } = options;
  const startedAt = Date.now();
  const semaphore = this.#getSpawnSemaphore();
  const queuedTimeoutMs = this.session.settings.get("task.queuedStartupTimeoutMs") ?? 120000;
  const stalenessThresholdMs = this.session.settings.get("async.stalenessThresholdMs") ?? 600000;
  
  return manager.register(
    "task",
    `Task ${agentId}`,
    async ({ signal: runSignal, reportProgress, markRunning }) => {
      let semaphoreHeld = false;
      
      // Canonical permit release (always goes through #releaseSpawnSemaphore)
      const releasePermit = () => { 
        if (semaphoreHeld) {
          this.#releaseSpawnSemaphore();
          semaphoreHeld = false;
        }
      };
      
      // Queued-timeout setup with unique Symbol token
      const QUEUED_TIMEOUT_TOKEN = Symbol("queued_startup_timeout");
      let queuedTimeoutId: NodeJS.Timeout | undefined;
      const queuedAbortController = new AbortController();
      
      if (queuedTimeoutMs > 0) {
        queuedTimeoutId = setTimeout(() => {
          const error = new Error(`Queued for ${queuedTimeoutMs}ms without starting — semaphore saturated`);
          (error as any)[QUEUED_TIMEOUT_TOKEN] = true;
          queuedAbortController.abort(error);
        }, queuedTimeoutMs);
      }
      
      const combinedSignal = queuedTimeoutMs > 0 
        ? AbortSignal.any([runSignal, queuedAbortController.signal])
        : runSignal;
      
      // Acquire in independent try/catch to preserve TaskJobError
      let acquireSucceeded = false;
      try {
        await semaphore.acquire(combinedSignal);
        acquireSucceeded = true;
      } catch (acquireError) {
        // Clear timer immediately on acquire failure
        if (queuedTimeoutId) {
          clearTimeout(queuedTimeoutId);
          queuedTimeoutId = undefined;
        }
        
        // Preserve TaskJobError (should not happen in acquire, but defensive)
        if (acquireError instanceof TaskJobError) {
          throw acquireError;
        }
        
        // Check first-cause via combinedSignal.reason or token
        const abortReason = combinedSignal.reason;
        
        if (abortReason && (abortReason as any)[QUEUED_TIMEOUT_TOKEN]) {
          // Queued-timeout won
          progress.status = "failed";
          onSettled?.(true);
          throw new TaskJobError(
            `${agentId} failed to start: ${abortReason.message}. Try raising task.maxConcurrency or cancelling stuck jobs.`
          );
        } else {
          // runSignal abort (cancel/signal/terminate)
          progress.status = "aborted";
          onSettled?.(true);
          throw acquireError;
        }
      } finally {
        // Ensure timer cleanup even on throw
        if (queuedTimeoutId) {
          clearTimeout(queuedTimeoutId);
          queuedTimeoutId = undefined;
        }
      }
      
      // POST-ACQUIRE CHECK: if timeout fired during acquire, release permit immediately
      if (acquireSucceeded) {
        // Clear timer after successful acquire
        if (queuedTimeoutId) {
          clearTimeout(queuedTimeoutId);
          queuedTimeoutId = undefined;
        }
        
        // Check if timeout/cancel happened during acquire
        if (queuedAbortController.signal.aborted) {
          const abortReason = queuedAbortController.signal.reason;
          if (abortReason && (abortReason as any)[QUEUED_TIMEOUT_TOKEN]) {
            // Timeout won: release permit without entering executor
            semaphore.release();
            progress.status = "failed";
            onSettled?.(true);
            throw new TaskJobError(
              `${agentId} failed to start: ${abortReason.message}. Try raising task.maxConcurrency or cancelling stuck jobs.`
            );
          }
        }
        
        if (runSignal.aborted) {
          // Cancel won: release permit without entering executor
          semaphore.release();
          progress.status = "aborted";
          onSettled?.(true);
          throw new Error("Task cancelled before starting");
        }
        
        // Permit acquired cleanly
        semaphoreHeld = true;
        markRunning();
      }
      
      try {
        // ... existing executor logic (unchanged) ...
        const result = await this.#executeTask({
          agentId,
          signal: runSignal,
          reportProgress,
          onUpdate,
          buildDetails,
        });
        
        progress.status = "completed";
        return result;
        
      } catch (executorError) {
        // Executor errors (including runtime timeout)
        progress.status = "failed";
        throw executorError;
        
      } finally {
        releasePermit();
        onSettled?.(true);  // Exactly once (only in executor finally)
      }
    },
    { 
      id: agentId, 
      agentId, 
      queued: true, 
      ownerId, 
      onProgress,
      stalenessPolicy: stalenessThresholdMs > 0 ? { thresholdMs: stalenessThresholdMs } : undefined,  // NEW
    }
  );
}
```

**关键修正**:
1. **独立 acquire try/catch**: 捕获 acquire 失败后立即检查 first-cause，不会与后续 executor catch 混淆
2. **TaskJobError 穿透**: 若 acquire 抛 TaskJobError（虽不应该），直接 throw 不重包装
3. **First-cause 判定**: 使用 `combinedSignal.reason` 或 Symbol token，不用 error.message string match
4. **Post-acquire check**: acquire 成功后再次检查 timeout/cancel 状态，若已触发则立即释放 permit 且不进 executor
5. **Canonical release**: 所有 semaphore.release() 改为 `this.#releaseSpawnSemaphore()`
6. **Exactly-once onSettled**: 只在 executor finally 调用（acquire 失败路径单独调用，但不进 executor finally）
7. **Timer cleanup**: 放入 acquire try/finally，确保无泄漏

**竞态覆盖**:
- permit-before-timeout: timeout 未触发，正常进 executor
- timeout-before-permit: acquire throw，first-cause 判定为 timeout，progress.status="failed"
- cancel-before-timeout: acquire throw，first-cause 判定为 cancel，progress.status="aborted"
- timeout/cancel 同 tick: combinedSignal.reason 或 post-acquire check 确定 first cause

**向后兼容**: queuedTimeoutMs=0 禁用超时，保留老行为。


### 5.3 Hub tool surface 变更

##### 5.3.1 CoordinationDetails 扩展 (additive only)

**位置**: `tools/hub/types.ts`

**变更**: 仅新增 optional diagnostic 字段；保留完整 HubOp、现有字段、CancelStatus

```typescript
export interface CoordinationDetails {
  op: HubOp;  // "wait" | "cancel" | "jobs" | "send" | "inbox" | "list" | ... (unchanged)
  jobs?: JobSnapshot[];  // optional (messaging-only ops may omit)
  cancelled?: Array<{ id: string; status: CancelStatus; message?: string }>;  // CancelStatus = "cancelled" | "not_found" | "already_completed"
  agents?: AgentActivitySnapshot[];  // unchanged
  
  // NEW: diagnostic info when staleness event detected (additive)
  diagnostic?: {
    reason: "staleness";
    thresholdMs: number;
    staleJobs: Array<{
      jobId: string;
      phase: "queued" | "running_idle" | "running_no_progress";
      observedMs: number;
    }>;
  };
}
```

**向后兼容**: 
- op 保持完整 HubOp 枚举
- jobs/cancelled/agents 保持 optional
- CancelStatus 保持现有三值（"cancelled" | "not_found" | "already_completed"）
- CancelOutcome.message 保留
- 新增 diagnostic 完全 optional

---

##### 5.3.2 buildJobResult 扩展 (signature preserved)

**位置**: `tools/hub/jobs.ts`

**变更**: 在末尾追加 optional diagnostic param；保持现有 signature、自动 ack、agents roster

```typescript
export function buildJobResult(
  session: ToolSession,
  manager: AsyncJobManager | undefined,
  op: HubOp,
  allJobs: TrackedJobLike[],
  completedIds: string[] = [],
  cancelledResults: Array<{ id: string; status: CancelStatus; message?: string }> = [],
  agents: AgentActivitySnapshot[] = [],  // PRESERVED (existing param)
  diagnostic?: CoordinationDetails["diagnostic"],  // NEW (appended)
): AgentToolResult<CoordinationDetails> {
  const snapshots = manager ? snapshotJobs(session, allJobs) : [];
  
  // ... existing completed/cancelled sections (unchanged) ...
  
  const lines: string[] = [];
  
  // NEW: diagnostic section (high priority, before completed/running)
  if (diagnostic) {
    lines.push(`## 🚨 Staleness Detected (${diagnostic.staleJobs.length} jobs)\n`);
    lines.push(`Threshold: ${formatDuration(diagnostic.thresholdMs)} without progress\n`);
    
    for (const staleJob of diagnostic.staleJobs) {
      const snap = snapshots.find(s => s.id === staleJob.jobId);
      if (!snap) continue;
      
      lines.push(`### \`${snap.id}\` — ${snap.label}`);
      
      if (staleJob.phase === "queued") {
        lines.push(`⏳ Queued for ${formatDuration(staleJob.observedMs)} — semaphore saturated?`);
      } else if (staleJob.phase === "running_idle") {
        lines.push(`💤 Idle for ${formatDuration(staleJob.observedMs)} — likely stuck`);
      } else {
        lines.push(`⚠️  No progress for ${formatDuration(staleJob.observedMs)} — hung provider/setup?`);
      }
      
      if (snap.agentIdleForMs !== undefined && Math.abs(staleJob.observedMs - snap.agentIdleForMs) > 5000) {
        lines.push(`   Cross-check: agent lastActivity ${formatDuration(snap.agentIdleForMs)}`);
      }
      
      lines.push("");
    }
    
    lines.push("## Intervention Options\n");
    lines.push("- `hub cancel <id>` — abort stuck job, salvage partial output");
    lines.push("- Raise `task.maxConcurrency` if semaphore saturated");
    lines.push("- `history://<id>` to inspect transcript");
    lines.push("");
  }
  
  // ... existing completed/running/agents sections (unchanged) ...
  
  const details: CoordinationDetails = {
    op,
    ...(snapshots.length > 0 ? { jobs: snapshots } : {}),
    ...(completedIds.length > 0 ? { completed: completedIds } : {}),  // PRESERVED (if exists)
    ...(cancelledResults.length > 0 ? { cancelled: cancelledResults } : {}),
    ...(agents.length > 0 ? { agents } : {}),  // PRESERVED
    ...(diagnostic ? { diagnostic } : {}),  // NEW
  };
  
  // PRESERVED: Acknowledge deliveries for settled jobs (exactly-once)
  if (manager && completedIds.length > 0) {
    manager.acknowledgeDeliveries(completedIds);
  }
  
  return {
    content: [{ type: "text", text: lines.join("\n").trimEnd() }],
    details,
    // NOT marked useless when diagnostic present (see isWaitingPollDetails)
  };
}
```

**保持不变**:
- Signature 只在末尾追加 optional param
- 自动调用 acknowledgeDeliveries（settled jobs exactly-once）
- agents roster 保留
- completedIds/cancelledResults 语义不变

**所有 callsites 迁移**:
```typescript
// executeWait: pass diagnostic from arbitration
return buildJobResult(session, manager, "wait", allJobs, completedIds, [], agents, diagnostic);

// executeCancel: no diagnostic
return buildJobResult(session, manager, "cancel", allJobs, [], cancelledResults, agents);

// executeJobs: no diagnostic
return buildJobResult(session, manager, "jobs", allJobs, [], [], agents);
```

**向后兼容**: 老 callsites 不传 diagnostic → undefined → 不渲染诊断段。

---

##### 5.3.3 isWaitingPollDetails 更新

**位置**: `tools/hub/jobs.ts`

**变更**: 要求 jobs 非空数组且无 diagnostic

```typescript
export function isWaitingPollDetails(details: CoordinationDetails): boolean {
  return (
    details.op === "wait" &&
    !details.diagnostic &&  // NEW: diagnostic frames are NOT useless
    Array.isArray(details.jobs) &&  // NEW: require jobs to be non-empty array
    details.jobs.length > 0 &&
    details.jobs.every(j => j.status === "running") &&
    !details.cancelled?.length &&
    !details.completed?.length  // if exists
  );
}
```

**语义**: 
- Message-only result (jobs undefined/empty) → NOT useless/displaceable
- Diagnostic present → NOT useless
- All-running ordinary poll → useless (unchanged)

---

##### 5.3.4 TUI renderer 扩展 (in-place modification)

**位置**: `tools/hub/jobs.ts` renderer functions

**变更**: 在现有 jobsRenderResult 内按 diagnostic staleIds 改色；保留 sealed filtering 禁用逻辑

```typescript
export function jobsRenderResult(
  details: CoordinationDetails,
  sealed: boolean,
): ToolResultComponent | undefined {
  // ... existing header/completed/cancelled sections ...
  
  const { jobs, diagnostic } = details;
  if (!jobs || jobs.length === 0) return undefined;
  
  const staleIds = diagnostic ? new Set(diagnostic.staleJobs.map(j => j.jobId)) : new Set();
  
  // Running section
  const runningJobs = jobs.filter(j => j.status === "running");
  
  if (runningJobs.length > 0) {
    // When diagnostic present, disable sealed filtering (preserve all running rows)
    const shouldFilter = sealed && !diagnostic;
    
    if (shouldFilter && runningJobs.length > 3) {
      // ... existing truncate logic ...
    } else {
      const rows = runningJobs.map(snap => renderJobRow(snap, staleIds, diagnostic?.thresholdMs));
      lines.push(...renderTreeList(rows));  // Use existing renderTreeList
    }
  }
  
  // ... existing agents roster ...
}

function renderJobRow(
  snap: JobSnapshot, 
  staleIds: Set<string>, 
  thresholdMs?: number
): string {
  const parts = [snap.id, snap.label, formatDuration(snap.durationMs)];
  
  if (snap.queuedForMs !== undefined) {
    const isStaleQueued = staleIds.has(snap.id);
    const icon = isStaleQueued ? theme.fg("⏳", "yellow") : "⏳";
    parts.push(`${icon} queued ${formatDuration(snap.queuedForMs)}`);
  } else if (snap.startupDelayMs !== undefined) {
    parts.push(`(startup ${formatDuration(snap.startupDelayMs)})`);
  }
  
  if (snap.idleForMs !== undefined) {
    const isStaleIdle = staleIds.has(snap.id) && thresholdMs && snap.idleForMs > thresholdMs;
    const icon = isStaleIdle ? theme.fg("💤", "yellow") : "⏸";
    parts.push(`${icon} idle ${formatDuration(snap.idleForMs)}`);
  }
  
  return parts.join(" · ");
}
```

**关键修正**:
- 使用现有 theme.fg、formatStatusIcon、truncate、renderTreeList APIs
- 不硬编码 thresholdMs，使用 diagnostic.thresholdMs
- Diagnostic 存在时禁用 sealed filtering（保留所有 running rows）
- 在现有 renderer 内部修改，不建平行结构

---

##### 5.3.5 TrackedJobLike 扩展

**位置**: `tools/hub/types.ts`

**变更**: 新增 optional liveness 字段

```typescript
export interface TrackedJobLike {
  id: string;
  type: string;
  status: "running" | "completed" | "failed" | "cancelled";
  label: string;
  startTime: number;
  // ... existing fields ...
  
  // NEW: liveness tracking (optional, for manager.getJob() returns)
  queued?: boolean;
  lastProgressAt?: number;
  runningStartedAt?: number;
  agentId?: string;
}
```

**向后兼容**: 新字段 optional；老 TrackedJobLike 实例不报错。

---

##### 5.3.6 executeMessageWait / nothingToWaitForResult (preserved)

```typescript
// No-manager path: preserve message-only wait
if (!manager) {
  if (!messaging) return errorResult("No coordination channel available");
  return this.#executeMessageWait(from, timeoutMs, signal);
}

// No running jobs: preserve nothingToWaitFor
if (runningJobs.length === 0 && !messaging) {
  return this.#nothingToWaitForResult(allJobs);
}
```

**向后兼容**: 无 manager 环境不报错，保持 message-only 语义。


### 5.4 错误处理

#### 5.4.1 Queued timeout 错误

**触发**: `task.queuedStartupTimeoutMs` 超时

**AsyncJob 状态**: `failed`

**AgentProgress.aborted**: false (progress.status = "failed")

**错误文本**:
```
<agentId> failed to start: Queued for 120000ms without starting — semaphore saturated. 
Try raising task.maxConcurrency or cancelling stuck jobs.
```

**Job 状态**: TaskJobError → delivery with hint

---

#### 5.4.2 Runtime timeout 错误

**触发**: `task.maxRuntimeMs` 超时

**AsyncJob 状态**: `failed` (not "aborted" — AsyncJob.status 只有 running|completed|failed|cancelled)

**AgentProgress.aborted**: true (executor sets `singleResult.aborted = true`)

**错误文本** (actual from `task/executor.ts:1163-1164, :2160`):
```
Subagent runtime limit exceeded (task.maxRuntimeMs=3600000)
```

**Salvage**: partial output retained in `<artifactsDir>/<id>.md`, accessible via `agent://<id>`

**Terminal**: timeout/signal/terminate are terminal; only budget-stop/parked-idle can resume

---

#### 5.4.3 Staleness diagnostic (not an error)

**触发**: `async.stalenessThresholdMs` 超时

**返回**: normal AgentToolResult with `diagnostic` details field

**NOT marked as error**: job continues running

**语义**: diagnostic frame 不终止 job；LLM/用户决定是否 cancel

---

#### 5.4.4 Cancel 竞态

**场景**: staleness diagnostic 返回后，LLM 发出 `hub cancel <id>` 但 job 已自然完成

**处理**: `manager.cancel(id)` checks `job.status !== "running"`，返回 CancelStatus = "already_completed"

**已有保护**: `AsyncJobManager.cancel()` L275 (`async/job-manager.ts`)

---

### 5.5 向后兼容

#### 5.5.1 现有 callers

- `AsyncJob` 新字段 optional → 老 jobs 不报错
- `JobSnapshot` 新字段 optional → 老 renderers 忽略
- `CoordinationDetails.diagnostic` optional → 老 parsers 忽略
- Settings 新增项有默认值 → 老 sessions 自动应用

---

#### 5.5.2 Settings 默认值迁移

**Migration logic**: schema additive, no data conversion required

**Intentional default behavior change**:
- `task.maxRuntimeMs` 从 0 改为 3600000 → 老 sessions 未显式配置时，现在会在 1h 自动 timeout
- `task.queuedStartupTimeoutMs` 新增 default 120000 → 排队超过 2min 自动 fail
- `async.stalenessThresholdMs` 新增 default 600000 → 10min 无进展触发诊断

**显式设置保留**: 用户已设置 `task.maxRuntimeMs=0` → 保持 0（不强制覆盖）

---

#### 5.5.3 Gallery fixtures

**位置**: `packages/coding-agent/src/cli/gallery-fixtures/agentic.ts`

**新增示例 fixtures**:

```typescript
export const staleJobFixture: JobSnapshot = {
  id: "stuck-analysis",
  type: "task",
  status: "running",
  label: "Deep codebase analysis",
  durationMs: 720000,  // 12 minutes
  idleForMs: 660000,   // 11 minutes (exceeds 10min threshold)
  resolvedModel: "gateway/claude-sonnet-4",
};

export const queuedJobFixture: JobSnapshot = {
  id: "queued-spawn",
  type: "task",
  status: "running",
  label: "Waiting for permit",
  durationMs: 150000,  // 2.5 minutes
  queuedForMs: 150000, // all time spent queued (current phase)
};

export const runningWithHistoryFixture: JobSnapshot = {
  id: "completed-slow-start",
  type: "task",
  status: "running",
  label: "Task with slow startup",
  durationMs: 300000,  // 5 minutes
  startupDelayMs: 45000,  // was queued for 45s (historical)
  idleForMs: 30000,  // idle for 30s (currently running)
};
```

---

#### 5.5.4 无 asyncJobManager 场景

**场景**: SDK consumer / orphaned host without async context

**行为**: 
- `snapshotJobs()` checks `session.asyncJobManager?.getJob(id)` → undefined 时退化到 TrackedJobLike (无 liveness fields)
- `#executeWait()` checks `!manager` → 保持 message-only wait 语义（不报错）

**向后兼容**: 无 manager 的环境不报错，仅缺失新字段（graceful degradation）

---

## 6. 风险与缓解

### 6.1 风险：默认值缺少基线数据

**描述**: 3600000ms (1h) / 120000ms (2min) / 600000ms (10min) 尚无实际 subagent p95 运行时长、排队分布数据 [未验证假设]

**影响**: 可能对合法慢任务误报或对真实 hang 反应过慢

**缓解**:
- Phase 0: shadow mode 收集 p50/p95/p99 分布
- 独立 rollout 每个 threshold，可单独回退
- 保留 0-disable 开关
- 文档明确标注 [拟议验收目标]

---

### 6.2 风险：staleness 误报（合法慢任务）

**描述**: 一个正常的 15min 深度分析会触发 10min staleness 诊断

**影响**: LLM 收到 false-positive diagnostic，可能错误 cancel

**缓解**:
- Staleness 是 non-terminal diagnostic（不自动 cancel）
- LLM/用户保留最终决策权
- 诊断帧明确列出干预选项，而非命令式
- agentIdleForMs 交叉验证（informational only；不作为主判定）

---

### 6.3 风险：queued-timeout 竞态

**描述**: timeout 与 permit acquisition 同时发生时，可能误释放 permit 或泄漏 permit

**影响**: semaphore 计数错误，后续 spawn 永久阻塞或超额运行

**缓解**:
- 使用 unique Symbol token（not error.message）区分 timeout
- Post-acquire check: 若 timeout 已触发但 acquire 成功，立即释放 permit
- Timer cleanup 放入 finally
- 测试覆盖 4 种竞态场景（permit-before-timeout, timeout-before-permit, cancel-before-timeout, same-tick）

---

### 6.4 风险：无首个 progress 的 job 不可 stale

**描述**: 一个 job 启动后卡在 provider setup/auth，从未调用 reportProgress，lastProgressAt 保持 undefined

**影响**: staleness 检测失效，只剩 1h wall-clock 兜底

**缓解**:
- idleForMs 计算使用 fallback chain: `lastProgressAt ?? runningStartedAt ?? startTime`
- 确保无首个 progress 的 job 也可被 staleness 检测（phase="running_no_progress"）
- 测试覆盖"无首个 progress 的 hung provider"场景

---

### 6.5 风险：agentIdleForMs 与 idleForMs 不一致

**描述**: lastProgressAt（job 自己报告）与 AgentRegistry.lastActivity（agent heartbeat）来自不同事件路径

**影响**: 两指标可能不一致，诊断时混淆

**缓解**:
- agentIdleForMs 仅作为 informational cross-check，不用于主 staleness 判定
- 诊断帧在两者差异 >5s 时显示 warning，但不阻止诊断
- 删除"最终一致"验收要求（两者无此不变量）

---

### 6.6 风险：parked-parent 自动通知丢失

**描述**: 父代理 session parked → delivery dead-lettered → 5min retention 后 job row evict → 复活时无自动通知

**影响**: LLM 不知道已完成的 subagent，可能重复 spawn 或放弃任务

**缓解**:
- **非 P0/P1 核心目标**（已移出）
- Output/transcript 已通过 `<artifactsDir>/<id>.md` 和 sessionFile 落盘，复活后可通过 `agent://<id>`/`history://` 手动追溯
- P3 (optional): 设计 durable delivery ledger (owner+generation+ack)，不在本次交付范围

---


## 7. 验证计划

### 7.1 单元测试

**Test owner prefix**: `packages/coding-agent/test/`

---

#### Test 1: AsyncJob liveness tracking

**文件**: `test/async-job-manager.test.ts`

**覆盖**:
- `register()` 初始化 lastProgressAt=undefined, runningStartedAt=undefined, generation=0
- `reportProgress()` 更新 lastProgressAt 并递增 generation
- `markRunning()` 设置 runningStartedAt、清除 queued flag、递增 generation
- staleness timer 启动/reset/cleanup

**实现示例**:
```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Settings } from "../../config/settings";
import { AsyncJobManager } from "../../async/job-manager";

describe("AsyncJobManager liveness tracking", () => {
  let manager: AsyncJobManager;
  let settings: Settings;
  
  beforeEach(() => {
    settings = Settings.isolated();
    manager = new AsyncJobManager({ settings });
  });
  
  afterEach(() => {
    manager.dispose();
  });
  
  test("initializes liveness fields", async () => {
    let capturedReportProgress: any;
    let capturedMarkRunning: any;
    
    const jobId = manager.register(
      "test",
      "Liveness test",
      async ({ reportProgress, markRunning }) => {
        capturedReportProgress = reportProgress;
        capturedMarkRunning = markRunning;
        // Don't complete immediately
        await new Promise(resolve => setTimeout(resolve, 100));
        return "done";
      },
      { id: "test-job", queued: true }
    );
    
    const job = manager.getJob(jobId);
    expect(job).toBeDefined();
    expect(job!.lastProgressAt).toBeUndefined();
    expect(job!.runningStartedAt).toBeUndefined();
    expect(job!.generation).toBe(0);
    
    // Call markRunning
    await capturedMarkRunning();
    expect(job!.queued).toBe(false);
    expect(job!.runningStartedAt).toBeGreaterThan(0);
    expect(job!.generation).toBe(1);
    
    // Call reportProgress
    const beforeProgress = Date.now();
    await capturedReportProgress("working");
    expect(job!.lastProgressAt).toBeGreaterThanOrEqual(beforeProgress);
    expect(job!.generation).toBe(2);
  });
  
  test("staleness timer lifecycle", async () => {
    settings.set("async.stalenessThresholdMs", 100);
    
    let markRunningFn: any;
    const events: any[] = [];
    
    const jobId = manager.register(
      "test",
      "Stale test",
      async ({ markRunning }) => {
        markRunningFn = markRunning;
        await new Promise(resolve => setTimeout(resolve, 200));
        return "done";
      },
      { 
        id: "stale-job", 
        queued: true,
        stalenessPolicy: { thresholdMs: 100 }
      }
    );
    
    // Subscribe to lifecycle events
    const ownerId = "test-owner";
    const { promise, unsubscribe } = manager.subscribeLifecycleEvents(ownerId, [jobId]);
    
    promise.then(event => events.push(event));
    
    await markRunningFn();
    
    // Wait for staleness threshold
    await new Promise(resolve => setTimeout(resolve, 150));
    
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("staleness");
    expect(events[0].jobId).toBe(jobId);
    expect(events[0].phase).toBe("running_no_progress");
    
    unsubscribe();
  });
});
```

---

#### Test 2: JobSnapshot 计算逻辑

**文件**: `test/tools/snapshot-computation.test.ts`

**覆盖**:
- queued job → queuedForMs present, startupDelayMs/idleForMs absent
- running job (曾排队) → startupDelayMs present, queuedForMs absent, idleForMs present
- running job (无首个 progress) → idleForMs fallback to runningStartedAt
- running job (无 runningStartedAt) → idleForMs fallback to startTime
- agentIdleForMs 从 AgentRegistry 提取

**实现示例**:
```typescript
import { describe, test, expect } from "bun:test";
import { snapshotJobs } from "../../tools/hub/jobs";
import type { TrackedJobLike, ToolSession } from "../../types";

describe("JobSnapshot computation", () => {
  test("queued job shows queuedForMs only", () => {
    const now = Date.now();
    const job: TrackedJobLike = {
      id: "job-1",
      type: "task",
      status: "running",
      label: "Queued",
      startTime: now - 5000,
      queued: true,
    };
    
    const session = createMockSession();
    const snapshots = snapshotJobs(session, [job]);
    
    expect(snapshots[0].queuedForMs).toBeGreaterThanOrEqual(5000);
    expect(snapshots[0].startupDelayMs).toBeUndefined();
    expect(snapshots[0].idleForMs).toBeUndefined();
  });
  
  test("running job with history shows startupDelayMs and idleForMs", () => {
    const now = Date.now();
    const job: TrackedJobLike = {
      id: "job-2",
      type: "task",
      status: "running",
      label: "Running",
      startTime: now - 10000,
      queued: false,
      runningStartedAt: now - 7000,
      lastProgressAt: now - 2000,
    };
    
    const session = createMockSession();
    const snapshots = snapshotJobs(session, [job]);
    
    expect(snapshots[0].queuedForMs).toBeUndefined();
    expect(snapshots[0].startupDelayMs).toBeCloseTo(3000, -2);
    expect(snapshots[0].idleForMs).toBeCloseTo(2000, -2);
  });
  
  test("running job without progress uses runningStartedAt fallback", () => {
    const now = Date.now();
    const job: TrackedJobLike = {
      id: "job-3",
      type: "task",
      status: "running",
      label: "No progress",
      startTime: now - 10000,
      queued: false,
      runningStartedAt: now - 7000,
      lastProgressAt: undefined,
    };
    
    const session = createMockSession();
    const snapshots = snapshotJobs(session, [job]);
    
    expect(snapshots[0].idleForMs).toBeCloseTo(7000, -2);
  });
});
```

---

#### Test 3: Staleness detection with waitable race

**文件**: `test/tools/hub-wait-staleness.test.ts`

**覆盖**:
- hub wait 跨阈值时 staleness promise resolve
- Post-wake arbitration: message > settled > staleness > poll
- Staleness event 消费后不重复
- Job 在事件到达前 settled → 丢弃 stale event
- 无 active waiter → event 丢弃

**实现示例**:
```typescript
import { describe, test, expect } from "bun:test";
import { HubTool } from "../../tools/hub";
import { AsyncJobManager } from "../../async/job-manager";

describe("Hub wait staleness integration", () => {
  test("wait resolves when staleness threshold crossed", async () => {
    const settings = Settings.isolated();
    settings.set("async.stalenessThresholdMs", 100);
    
    const manager = new AsyncJobManager({ settings });
    const session = createMockSessionWithManager(manager);
    const hub = new HubTool(session);
    
    // Register long-running job
    const jobId = manager.register(
      "test",
      "Long task",
      async ({ markRunning }) => {
        markRunning();
        await new Promise(resolve => setTimeout(resolve, 5000));
        return "done";
      },
      { 
        id: "long-job",
        queued: false,
        stalenessPolicy: { thresholdMs: 100 }
      }
    );
    
    // Wait for the job
    const waitStart = Date.now();
    const result = await hub.execute("wait", { ids: [jobId] });
    const waitDuration = Date.now() - waitStart;
    
    // Should return diagnostic after ~100ms, not 5000ms
    expect(waitDuration).toBeLessThan(200);
    expect(result.details.diagnostic).toBeDefined();
    expect(result.details.diagnostic!.staleJobs[0].jobId).toBe(jobId);
  });
  
  test("post-wake arbitration prioritizes message over staleness", async () => {
    const settings = Settings.isolated();
    settings.set("async.stalenessThresholdMs", 100);
    
    const manager = new AsyncJobManager({ settings });
    const messaging = createMockMessaging();
    const session = createMockSessionWithManagerAndMessaging(manager, messaging);
    const hub = new HubTool(session);
    
    // Register stale job
    const jobId = manager.register(
      "test",
      "Stale task",
      async ({ markRunning }) => {
        markRunning();
        await new Promise(resolve => setTimeout(resolve, 5000));
        return "done";
      },
      { id: "stale-job", stalenessPolicy: { thresholdMs: 100 } }
    );
    
    // Inject message right after wait starts
    setTimeout(() => {
      messaging.send("test-peer", "Hello");
    }, 50);
    
    const result = await hub.execute("wait", { ids: [jobId] });
    
    // Message should win over staleness
    expect(result.details.op).toBe("wait");
    expect(result.details.diagnostic).toBeUndefined();
    // ... check message present ...
  });
});
```

---

#### Test 4: Queued-timeout races

**文件**: `test/task/task-spawn-queued-timeout.test.ts`

**覆盖**:
- 使用真实 TaskTool + session semaphore (task.maxConcurrency=1)
- Scenario 1: permit-before-timeout → job starts normally
- Scenario 2: timeout-before-permit → job fails with "semaphore saturated", permit not held
- Scenario 3: cancel-before-timeout → job aborted, permit released
- Scenario 4: timeout and permit same tick → first-cause token determines outcome

**实现示例**:
```typescript
import { describe, test, expect, beforeEach } from "bun:test";
import { TaskTool } from "../../task";
import { AsyncJobManager } from "../../async/job-manager";
import { Settings } from "../../config/settings";

describe("Queued-timeout races", () => {
  let settings: Settings;
  let manager: AsyncJobManager;
  let task: TaskTool;
  
  beforeEach(() => {
    settings = Settings.isolated();
    settings.set("task.maxConcurrency", 1);
    settings.set("task.queuedStartupTimeoutMs", 200);
    manager = new AsyncJobManager({ settings });
    const session = createMockSession({ settings, manager });
    task = new TaskTool(session);
  });
  
  test("permit-before-timeout: job starts normally", async () => {
    // Blocker completes quickly
    const blocker = task.execute("spawn", {
      agents: [{ agent: "blocker", directive: "sleep 50ms" }]
    });
    
    await new Promise(resolve => setTimeout(resolve, 10));
    
    // Second task queued but blocker releases soon
    const queued = task.execute("spawn", {
      agents: [{ agent: "task2", directive: "work" }]
    });
    
    const result = await queued;
    const job = manager.getJob("task2");
    
    expect(job?.status).not.toBe("failed");
    expect(result.details.results[0].exitCode).toBe(0);
  });
  
  test("timeout-before-permit: job fails, executor not started", async () => {
    // Blocker holds permit for 1 second
    const blocker = task.execute("spawn", {
      agents: [{ agent: "blocker", directive: "sleep 1000ms" }]
    });
    
    await new Promise(resolve => setTimeout(resolve, 10));
    
    // Second task queued, will timeout after 200ms
    const queued = task.execute("spawn", {
      agents: [{ agent: "task2", directive: "work" }]
    });
    
    const queuedJob = manager.getJob("task2")!;
    await queuedJob.promise.catch(() => {});
    
    expect(queuedJob.status).toBe("failed");
    expect(queuedJob.errorText).toContain("semaphore saturated");
    
    // Verify permit not leaked: third task should still queue (not immediate fail)
    const third = task.execute("spawn", {
      agents: [{ agent: "task3", directive: "quick" }]
    });
    
    const thirdJob = manager.getJob("task3")!;
    expect(thirdJob.queued).toBe(true);
  });
  
  test("cancel-before-timeout: job aborted, permit released", async () => {
    const blocker = task.execute("spawn", {
      agents: [{ agent: "blocker", directive: "sleep 1000ms" }]
    });
    
    await new Promise(resolve => setTimeout(resolve, 10));
    
    const controller = new AbortController();
    const queued = task.execute("spawn", {
      agents: [{ agent: "task2", directive: "work" }]
    }, controller.signal);
    
    // Cancel before timeout
    await new Promise(resolve => setTimeout(resolve, 50));
    controller.abort();
    
    const queuedJob = manager.getJob("task2")!;
    await queuedJob.promise.catch(() => {});
    
    expect(queuedJob.status).not.toBe("failed"); // Should be aborted
    // Verify onSettled called exactly once
    // Verify permit released (third task can queue)
  });
});
```

---

### 7.2 手动场景（更新）

#### Scenario 1: Wall-clock timeout with salvage

**步骤**:
1. 设置 task.maxRuntimeMs=300000 (5min)
2. Spawn subagent with `while true; do sleep 10; done`
3. 观察 5min 后 job 失败

**验收**:
- SingleResult.abortReason 等于或包含 "runtime limit exceeded" / "task.maxRuntimeMs"
- AsyncJob.errorText 包含该 reason（可带 TaskJobError envelope/hint）
- AgentProgress.status = "failed"（或 SingleResult.aborted=true，取决于哪个字段暴露）
- `agent://<id>` 可读取 partial output
- 不能 resume（terminal）

---

### 7.3 回归测试

**命令**:
```bash
cd packages/coding-agent
bun test test/async-job-manager.test.ts
bun test test/tools/hub-wait.test.ts
bun test test/tools/hub-wait-staleness.test.ts
bun test test/job-poll-displacement.test.ts
bun test test/job-renderer-preview.test.ts
bun test test/tools/snapshot-computation.test.ts
bun test test/task/task-spawn.test.ts
bun test test/task/task-spawn-queued-timeout.test.ts
bun test test/task/executor-wall-clock.test.ts
```

**新增测试文件**:
- `test/tools/hub-wait-staleness.test.ts`: wait 跨阈值、post-wake arbitration、exactly-once
- `test/tools/snapshot-computation.test.ts`: queuedForMs/startupDelayMs/idleForMs 互斥与 fallback
- `test/task/task-spawn-queued-timeout.test.ts`: 4 种竞态、permit leak、onSettled exactly-once

**Settings 默认测试**:
```typescript
// test/config/settings-defaults.test.ts
import { Settings } from "../../config/settings";

test("task.maxRuntimeMs default changed to 3600000", () => {
  const settings = Settings.getDefault();
  expect(settings.get("task.maxRuntimeMs")).toBe(3600000);
});

test("task.queuedStartupTimeoutMs default is 120000", () => {
  const settings = Settings.getDefault();
  expect(settings.get("task.queuedStartupTimeoutMs")).toBe(120000);
});

test("async.stalenessThresholdMs default is 600000", () => {
  const settings = Settings.getDefault();
  expect(settings.get("async.stalenessThresholdMs")).toBe(600000);
});
```

---

## 8. 分阶段落地

### Phase 0: P0 Wall-clock + queued timeout (opt-in → default-on)

**工作内容**:
- `task.maxRuntimeMs` default 改为 3600000
- `task.queuedStartupTimeoutMs` 新增 default 120000
- task spawn 实现 queued-timeout with unique token + post-acquire check
- 现有 executor wall-clock path 验证（已存在，确认 errorText 一致）

**Activation contract**:
- **无远程 cohort 分配**：本地 CLI 无法实现 10% sessions canary
- **改为 opt-in canary**: 
  1. Shadow mode: 新增 `task.timeoutMode = "off" | "shadow" | "on"`，默认 "off"
  2. 手动 opt-in: 用户显式设为 "on" 启用
  3. 稳定后改 schema default 为 "on"（default-on）
- **独立 rollback**: 每个 timeout 可单独 disable（maxRuntimeMs=0, queuedStartupTimeoutMs=0）

**观测指标** (per-job, 按 jobId+generation 去重):
- `queued_timeout_triggered`: { jobId, ownerId, queuedForMs, threshold, outcome: "failed" | "cancelled_before_timeout" } [拟议验收目标: baseline TBD]
- `runtime_timeout_triggered`: { jobId, ownerId, runtimeMs, threshold, salvaged: boolean } [拟议验收目标: baseline TBD]

**质量 stop conditions** [拟议验收目标]:
- (a) **Timeout false-positive proxy**: timeout 后 user/LLM retry same task 且成功率 >80% 表示可能误杀（分母：all runtime_timeout events；分子：subsequent 5min 内同 agentId retry+success；窗口：24h rolling；最小样本：100 events）
- (b) **Salvage health**: salvage_success_rate >80%（有 partial output 且 agent:// 可读；分母：all runtime_timeout；窗口：同上）
- (c) **Queued-timeout actionable**: queued_timeout_rate <5% of total spawns（分母：all task spawns；若 >5% 疑似 threshold 过短或 maxConcurrency 过低）

**Stop rule**: 任一 condition 失败 → 单项 rollback（关闭该 timeout，保留另一个）。

**工作量**: 2-3 days

---

### Phase 1: P1 Liveness fields + staleness event

**工作内容**:
- AsyncJob 新增 lastProgressAt/runningStartedAt/generation/stalenessPolicy
- AsyncJobManager.register() 打点 + staleness timer + lifecycle event channel
- JobSnapshot 扩展 queuedForMs/startupDelayMs/idleForMs/agentIdleForMs
- snapshotJobs() 计算逻辑
- HubTool#executeWait 订阅 lifecycle events，加入 race，post-wake arbitration
- buildJobResult 扩展 optional diagnostic param
- isWaitingPollDetails 检查 diagnostic
- `async.stalenessThresholdMs` 新增 default 600000

**Activation contract**: 同 Phase 0（opt-in canary via `async.stalenessMode`）

**观测指标** (per-job per-episode, 按 jobId+generation 去重):
- `staleness_detected`: { jobId, phase, observedMs, threshold, agentIdleForMsDiff, featureVersion, thresholdFingerprint } [拟议验收目标: baseline TBD]
- `staleness_outcome`: { jobId, episode_generation, outcome: "ignored" | "cancelled" | "naturally_completed_within_2x_threshold" | "inspect_history" | "raise_concurrency" } [拟议验收目标: baseline TBD]

**质量 stop conditions** [拟议验收目标]:
- (d) **Diagnostic actionable-response rate**: 收到诊断后有任意干预（cancel / inspect / raise concurrency / adjust threshold）或自然完成 >50%（分母：all staleness_detected episodes；分子：subsequent 5min 内观察到干预或 job completed；窗口：24h rolling；最小样本：50 episodes）
- (e) **False-positive proxy**: 诊断后 job naturally completed within 2×threshold >30% 表示阈值可能过短（分母：all staleness episodes；分子：未干预且在 2×threshold 内完成）
- (f) **False-cancel rate**: 诊断后 LLM cancel 但 salvage empty/无 agent:// output <10%（真正 stuck 应有 partial work）

**A/B discipline**: Phase 0 与 Phase 1 独立 rollout；若同时上线则无法归因。建议 Phase 0 稳定 2 weeks 后再启动 Phase 1。

**Non-overlap interval ledger**:
```typescript
interface RolloutEpisode {
  jobId: string;
  generation: number;
  featureVersion: string;  // "p0-only" | "p0+p1-v1" | ...
  thresholdFingerprint: string;  // "maxRuntime=3600000,queued=120000,staleness=600000"
  cohortKey?: string;  // user-id or session-id (if cohort available)
  detectedAt: number;
  outcome?: string;
  recordedOnce: boolean;  // prevent double-count
}
```

**工作量**: 3-4 days

---

### Phase 2: P2 Intervention prompt optimization

**工作内容**:
- prompts/tools/hub.md 更新 staleness 语义
- prompts/tools/task-async-contract.md 同步 timeout/staleness 区别
- TUI renderer 高亮 diagnostic frame（已在 §5.3.4）
- Gallery fixtures 新增 stale/queued/running-with-history 示例（已在 §5.5.3）

**验证**: 对比 Phase 1 与 Phase 2 的 actionable-response rate（单变量 A/B）

**工作量**: 1-2 days

---

### Phase 3: P3 Parked-parent durable delivery (optional, 非核心目标)

**说明**: 已从核心目标移出（§1.3 非目标）。若未来实施，需设计 canonical durable delivery ledger（owner session identity/epoch, job id/generation, settledAt, payload ref, delivery/ack state），复用现有 .md/.jsonl 作为内容源。

**工作量**: 2-3 days (若实施)

---

### Phase 4: P4 Independent watchdog (optional, 非核心目标)

**说明**: 独立 timer 扫描 AsyncJobManager + AgentRegistry；检测到 stale → 通过 AsyncJobManager.cancel() canonical path abort。**Owner 必须在 async/task lifecycle**，不得放入 advisor/watchdog.ts（被动审阅配置）。

**工作量**: 3-4 days (若实施)


## 9. Handoff Note

### 9.1 下游评审

**Reviewer**: sol-xhigh-reviewer 或 flash-reviewer（不同于 author 的模型）

**评审重点**:
- P0/P1 机制是否真正 machine-owned（staleness event-driven, not poll-based）
- 字段语义是否闭合（queuedForMs vs startupDelayMs, idle fallback chain）
- 竞态是否安全（queued-timeout token + post-acquire check）
- 向后兼容（无 manager 场景、老 callers）
- 测试路径是否触达真实契约（真实 semaphore, observable state）

---

### 9.2 实现注意事项

1. **Staleness 优先级**: buffered message > settled job > staleness diagnostic > poll window > abort
2. **字段互斥**: queuedForMs (current phase) 与 startupDelayMs (historical) 互斥；renderer 不得误判
3. **Timeout 状态**: AsyncJob.status=failed, AgentProgress.aborted=true；不引入新 "aborted" status
4. **Canonical paths**: cancel/abort 必须走 AsyncJobManager.cancel() + salvage；不得旁路
5. **No-manager 兼容**: hub wait 保持 message-only 语义；snapshot 优雅降级
6. **Prompt 同步**: hub.md + task-async-contract.md 统一 timeout/staleness 语义
7. **Gallery/slash command**: 若 `/jobs` 在 scope，扩展 AsyncJobSnapshotItem；否则在非目标中说明

---

### 9.3 未解决问题与后续方向

1. **默认值验证**: 需收集实际 p50/p95 运行时长与排队分布，调整 3600000/120000/600000 [拟议验收目标]
2. **P3 durable delivery**: 若需要 parked-parent auto-replay，必须设计 owner+generation+ack ledger（不在本次范围）
3. **P4 watchdog**: 作为最终兜底可选；owner 必须在 async/task lifecycle（not advisor subsystem）
4. **1h vs 2h, 5min vs 20min**: 需线上 A/B 测试与非重叠 cohort，不能只计数触发次数
5. **Cross-check 不变量**: agentIdleForMs 与 idleForMs 无"最终一致"保证；仅作 informational context

---

**现有 advisor/watchdog.ts 澄清**: packages/coding-agent/src/advisor/watchdog.ts 是被动审阅配置，加载 WATCHDOG/advisor prompt；advisor/transcript-recorder.ts:37-39 明确 advisor 是 passive reviewer，不是 subagent 生命周期终止器。若未来实现 P4 独立 watchdog，owner 必须在 async/task lifecycle，通过 AsyncJobManager cancel/abort+salvage canonical path 执行。

---

**最终文档状态**: 完整，self-contained，无 TBD/TODO placeholders。所有 [未验证假设] 和 [拟议验收目标] 已明确标注。

