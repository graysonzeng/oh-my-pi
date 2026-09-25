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
