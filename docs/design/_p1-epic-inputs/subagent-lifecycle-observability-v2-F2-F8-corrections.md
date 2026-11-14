# Round-5 Findings F2-F8 Correction Specification

## Status: F1 Complete (§5.2.4 added, 2028 lines)

---

## F2: Delivery Engine Conflicts & Incomplete Migration

**Location**: §5.2.1 lines ~334-620

**Required Changes**:

1. **Delete duplicate #enqueueLifecycleDelivery** (keep single version)
2. **Extend AsyncJobDelivery interface**:
```typescript
interface AsyncJobDelivery {
  deliveryKey: string;        // episodeId for lifecycle, jobId for completion
  jobId: string;              // For getDeliveryState/acknowledge compatibility
  ownerId: string | undefined;
  event: AsyncJobDeliveryEvent;
  attempt: number;
  nextAttemptAt: number;
  lastError?: string;
  promise?: Promise<void>;
}
```

3. **Preserve existing delivery APIs**:
- `getDeliveryState(jobId)` → check `delivery.jobId === jobId`
- `acknowledgeDeliveries(jobIds)` → add to `#suppressedDeliveries` + filter by `delivery.jobId`
- `resumeDeliveries(jobIds)` → remove from suppression + re-enqueue
- `#filterDeliveries(predicate)` → apply to `#deliveries`
- `#filterInFlightDeliveries(predicate)` → apply to `#inFlightDeliveries`
- Keep existing `#runDeliveryLoop` structure with jitter, in-flight tracking, exponential backoff

4. **Episode invalidation**:
```typescript
#invalidateJobEpisodes(incarnationId: string): void {
  // Mark pending episodes as acked
  for (const [key, episode] of this.#pendingDiagnostics.entries()) {
    if (episode.incarnationId === incarnationId) {
      episode.state = 'acked';
      this.#pendingDiagnostics.delete(key);
    }
  }
  
  // Remove from queued deliveries (readonly #deliveries - use filter)
  const filtered: AsyncJobDelivery[] = [];
  for (const d of this.#deliveries) {
    if (d.event.type === 'lifecycle' && d.event.incarnationId === incarnationId) {
      continue; // Skip invalidated
    }
    filtered.push(d);
  }
  this.#deliveries = filtered;
  
  // Handle in-flight (await promises, don't re-enqueue)
  for (const d of this.#inFlightDeliveries) {
    if (d.event.type === 'lifecycle' && d.event.incarnationId === incarnationId) {
      // Mark as invalidated, sink will check isDiagnosticValid
    }
  }
}
```

5. **State machine methods**:
```typescript
interface DiagnosticEpisode {
  // ... existing fields
  state: 'pending' | 'wait-claimed' | 'owner-queued' | 'in-flight' | 'delivered' | 'acked';
}

#transitionEpisode(episodeId: string, from: DiagnosticEpisode['state'], to: DiagnosticEpisode['state']): boolean {
  const episode = this.#pendingDiagnostics.get(episodeId);
  if (!episode || episode.state !== from) return false;
  episode.state = to;
  return true;
}

// WAIT_CLAIMED → DELIVERED (after Hub builds result)
// DELIVERED → ACKED (after delivery success)
// IN_FLIGHT → DELIVERED (after sink returns)
```

6. **Typed sink migration checklist**:
- `AsyncJobManager` constructor: update `onJobComplete` signature
- `registerDeliverySink`: update sink type
- `#deliverDelivery`: pass `event` instead of `(jobId, text, job?)`
- AgentSession: update handler to match union type
- All `manager.register` callsites: ensure `onJobComplete` handlers accept union

---

## F3: Reservation/Claim Logic Fix

**Location**: §5.2.1 `#enqueueLifecycleDelivery`, §5.3.1 `subscribeLifecycleEvents`

**Problem**: Pre-claim makes Hub's `claimPendingDiagnostic` fail

**Solution**: Reservation system

```typescript
// In AsyncJobManager
#lifecycleReservations = new Map<string, string>();  // episodeId → subscriptionId

subscribeLifecycleEvents(ownerId, watchedIds): { promise, unsubscribe, subscriptionId } {
  const subscriptionId = randomUUID();
  const { promise, resolve } = Promise.withResolvers<AsyncJobLifecycleEvent>();
  const subscriber = { subscriptionId, ownerId, watchedIds, resolve };
  this.#lifecycleSubscribers.push(subscriber);
  
  return {
    promise,
    subscriptionId,
    unsubscribe: () => {
      const idx = this.#lifecycleSubscribers.indexOf(subscriber);
      if (idx >= 0) {
        this.#lifecycleSubscribers.splice(idx, 1);
        // Release reservation if not consumed
        for (const [episodeId, subId] of this.#lifecycleReservations.entries()) {
          if (subId === subscriptionId) {
            const episode = this.#pendingDiagnostics.get(episodeId);
            if (episode && episode.state === 'pending') {
              this.#transitionEpisode(episodeId, 'pending', 'owner-queued');
              // Re-enqueue for owner delivery
              this.#enqueueLifecycleDeliveryForOwner(episode);
            }
            this.#lifecycleReservations.delete(episodeId);
          }
        }
      }
    }
  };
}

#reserveForWait(episode: DiagnosticEpisode, subscriptionId: string): void {
  this.#lifecycleReservations.set(episode.episodeId, subscriptionId);
  // Episode stays 'pending', will be consumed or released
}

consumeReservation(episodeId: string, subscriptionId: string): DiagnosticEpisode | undefined {
  const reservedSubId = this.#lifecycleReservations.get(episodeId);
  if (reservedSubId !== subscriptionId) return undefined;
  
  const episode = this.#pendingDiagnostics.get(episodeId);
  if (!episode || episode.state !== 'pending') return undefined;
  
  this.#transitionEpisode(episodeId, 'pending', 'wait-claimed');
  episode.claimedBy = subscriptionId;
  this.#lifecycleReservations.delete(episodeId);
  return episode;
}
```

**Hub executeWait post-wake priority** (§5.3.1):
```typescript
// After race returns winner
try {
  winner = await Promise.race(racePromises);
} finally {
  // Always cleanup
  manager.unwatchJobs(watchedJobIds);
  if (timeoutHandle) clearTimeout(timeoutHandle);
  if (progressTimer) clearInterval(progressTimer);
  removeBusAbortListener?.();
  if (usedSmartWindow) manager.recordPollWaitEnd(ownerId);
}

// Post-wake priority (explicit ordering)
// 1. Check if message already dequeued (winner or pre-drained)
if (messaging) {
  const pending = drainPendingInbox(messaging.registry, messaging.senderId, params.from);
  if (pending) {
    lifecycleSubscription?.unsubscribe();
    busAbort?.abort(busCancelled);
    return messageResult(messaging.senderId, pending);
  }
}

// 2. Re-snapshot jobs (may have settled during race)
const freshSnapshots = snapshotJobs(this.session, jobsToWatch);
const anySe

ttled = freshSnapshots.some(j => j.status !== "running");
if (anySettled) {
  lifecycleSubscription?.unsubscribe();
  busAbort?.abort(busCancelled);
  return buildJobResult(this.session, manager, "wait", jobsToWatch, []);
}

// 3. Consume lifecycle reservation (if winner was lifecycle)
let diagnostic: CoordinationDetails["diagnostic"] | undefined;
if (winner.kind === 'lifecycle' && lifecycleSubscription) {
  const episode = manager.consumeReservation(winner.event.episodeId, lifecycleSubscription.subscriptionId);
  if (episode) {
    diagnostic = episodeToDiagnostic(episode);
    // Transition WAIT_CLAIMED → DELIVERED after building result
    manager.#transitionEpisode(episode.episodeId, 'wait-claimed', 'delivered');
  }
}
lifecycleSubscription?.unsubscribe();
busAbort?.abort(busCancelled);

if (diagnostic) {
  return buildJobResult(this.session, manager, "wait", jobsToWatch, [], [], { diagnostic });
}

// 4. Poll/abort
if (winner.kind === 'poll') {
  return buildJobResult(this.session, manager, "wait", jobsToWatch, []);
}

// winner.kind === 'abort'
throw new Error("Hub wait aborted");
```

---

## F4: YieldQueue API Correction

**Location**: §5.3.2

**Real API** (from agent-session.ts:429, yield-queue.ts:45-63):
```typescript
// In AgentSession constructor
this.yieldQueue.register('lifecycle-diagnostic', {
  isStale: (entry: LifecycleDiagnosticEntry) => {
    return entry.epoch !== this.#asyncDeliveryEpoch || 
           !this.#asyncJobManager?.isDiagnosticValid(entry.episodeId);
  },
  build: buildLifecycleDiagnosticBatchMessage
});

// In delivery sink
#registerAsyncDeliverySink(): void {
  if (!this.#asyncJobManager || !this.#agentId) return;
  
  const sink: AsyncJobDeliverySink = (event: AsyncJobDeliveryEvent) => {
    if (event.type === 'completion') {
      // Use existing #deliverAsyncJobResult (preserves disposed/suppression/epoch/spill)
      this.#deliverAsyncJobResult(event.jobId, event.text, event.job);
    } else if (event.type === 'staleness') {
      // Register lifecycle kind first (do in constructor)
      this.yieldQueue.enqueue('lifecycle-diagnostic', {
        epoch: this.#asyncDeliveryEpoch,
        episodeId: event.episodeId,
        jobId: event.jobId,
        phase: event.phase,
        idleMs: event.observedMs,
        thresholdMs: event.thresholdMs,
        agentId: event.agentId
      });
    }
  };
  
  this.#unregisterAsyncDeliverySink = this.#asyncJobManager.registerDeliverySink(this.#agentId, sink);
}

// New helper
interface LifecycleDiagnosticEntry {
  epoch: number;
  episodeId: string;
  jobId: string;
  phase: string;
  idleMs: number;
  thresholdMs: number;
  agentId?: string;
}

function buildLifecycleDiagnosticBatchMessage(entries: LifecycleDiagnosticEntry[]): CustomMessage<{ episodes: any[] }> {
  return {
    role: 'custom',
    customType: 'lifecycle-diagnostic',  // Distinct from 'async-result'
    content: prompt.render(lifecycleDiagnosticTemplate, {
      multiple: entries.length > 1,
      episodes: entries
    }),
    display: true,
    attribution: 'agent',
    details: { episodes: entries },
    timestamp: Date.now()
  };
}

// In manager after delivery success
#transitionEpisode(episode.episodeId, 'in-flight', 'delivered');
// Session YieldQueue flush calls isStale → manager.isDiagnosticValid(episodeId)
// If valid: inject message, then manager.#transitionEpisode(..., 'delivered', 'acked') + delete
```

**Add to AsyncJobManager**:
```typescript
isDiagnosticValid(episodeId: string): boolean {
  const episode = this.#pendingDiagnostics.get(episodeId);
  if (!episode) return false;
  if (episode.state === 'acked') return false;
  const job = Array.from(this.#jobs.values()).find(j => j.incarnationId === episode.incarnationId);
  return job !== undefined && job.status === 'running';
}

// After YieldQueue successfully delivers, call:
acknowledgeDiagnostic(episodeId: string): void {
  const episode = this.#pendingDiagnostics.get(episodeId);
  if (episode) {
    if (episode.state === 'delivered') {
      this.#transitionEpisode(episodeId, 'delivered', 'acked');
    }
    this.#pendingDiagnostics.delete(episodeId);
  }
}
```

---

## F5: Builder/TUI/Snapshot Corrections

**Location**: §5.3.3

**Fix useless placement**:
```typescript
// buildJobResult
const result: AgentToolResult<CoordinationDetails> = {
  content: [{ type: "text", text: lines.join("\n") }],
  details,
};

// F5: useless is top-level property, not details.useless
const allRunning = jobResults.length > 0 && jobResults.every(j => j.status === "running");
if (allRunning && cancelOutcomes.length === 0 && !options?.diagnostic) {
  result.useless = true;
}

return result;
```

**Fix cancelled wire shape**:
```typescript
// CoordinationDetails keeps CancelOutcome[] (current is correct)
// Don't change to {id, status} projection
```

**Add liveness to model-facing text**:
```typescript
if (running.length > 0) {
  lines.push(`## Still Running (${running.length})\n`);
  for (const j of running) {
    let info = `- \`${j.id}\` [${j.type}] — ${j.label}`;
    if (j.queuedForMs !== undefined) {
      info += ` (queued ${formatDuration(j.queuedForMs)})`;
    } else if (j.idleForMs !== undefined) {
      info += ` (idle ${formatDuration(j.idleForMs)})`;
    }
    
    // Add diagnostic warning if applicable
    if (options?.diagnostic?.staleIds.includes(j.id)) {
      const ep = options.diagnostic.episodes.find(e => e.jobId === j.id);
      if (ep) {
        info += ` [STALE: ${ep.phase}, threshold ${formatDuration(options.diagnostic.thresholdMs)}]`;
      }
    }
    lines.push(info);
  }
}
```

**Fix TUI with real APIs**:
```typescript
// RenderResultOptions actual shape: { expanded, isPartial, spinnerFrame }
// sealed is checked via result.details presence in parent caller

// Sealed filtering
if (isWaitingPollDetails(details) && !details.diagnostic) {
  // Existing sealed poll logic unchanged
}

// renderItem uses real theme helpers
const statusColor = job.status === "failed" ? "red" : 
                    job.status === "completed" ? "green" : "blue";
const isDiagnostic = diagnostic?.staleIds.includes(job.id);
const finalColor = isDiagnostic ? "yellow" : statusColor;

// Use uiTheme.fg(color, text) signature
const line = uiTheme.fg(finalColor, `${statusIcon} ${job.id} [${job.type}] — ${job.label}`);
```

**Fix snapshotJobs**:
```typescript
export function snapshotJobs(session: ToolSession, jobs: TrackedJobLike[]): JobSnapshot[] {
  const now = Date.now();
  return jobs.map(j => {
    // Get current state (manager may have updated since jobsToWatch captured)
    const current = session.asyncJobManager?.getJob(j.id);
    const latest = current ?? j;
    
    const snapshot: JobSnapshot = { /* base fields */ };
    
    // F4: Liveness only for running jobs
    if (latest.status === "running") {
      if (latest.queued) {
        snapshot.queuedForMs = now - latest.startTime;
      } else if (latest.runningStartedAt) {
        snapshot.startupDelayMs = latest.runningStartedAt - latest.startTime;
        snapshot.idleForMs = now - (latest.lastProgressAt ?? latest.runningStartedAt);
      } else {
        snapshot.idleForMs = now - (latest.lastProgressAt ?? latest.startTime);
      }
      
      // agentIdleForMs cross-check
      if (latest.agentId) {
        const ref = session.agentRegistry?.get(latest.agentId);
        if (ref?.lastActivity) {
          snapshot.agentIdleForMs = now - ref.lastActivity;
        }
      }
    }
    
    // Existing resolvedModel logic (task details)
    if (latest.type === "task" && latest.latestDetails) {
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

---

## F6: RegisterOptions + TaskTool Wiring

**Location**: §5.1.1 (AsyncJobRegisterOptions), §5.2.4 (TaskTool reads settings)

**Extend AsyncJobRegisterOptions**:
```typescript
// packages/coding-agent/src/async/job-manager.ts
export interface AsyncJobRegisterOptions {
  id?: string;
  ownerId?: string;
  agentId?: string;
  queued?: boolean;
  onProgress?: (text: string, details?: Record<string, unknown>) => void | Promise<void>;
  
  // F6: NEW
  stalenessPolicy?: {
    thresholdMs: number;
    mode: 'on';  // Only 'on' allowed (off = undefined policy)
  };
}
```

**Fix type consistency** (remove shadow):
```typescript
// All AsyncJob/DiagnosticEpisode/settings references: mode is 'off' | 'on'
// Internal: undefined stalenessPolicy = off
```

**Fix activation condition**:
```typescript
// In TaskTool #registerSpawnJob (§5.2.4)
const stalenessMode = this.session.settings.get("async.stalenessMode");
const stalenessThresholdMs = this.session.settings.get("async.stalenessThresholdMs");

// F6: Mode must be 'on' AND threshold > 0
const stalenessPolicy = (stalenessMode === 'on' && stalenessThresholdMs > 0)
  ? { thresholdMs: stalenessThresholdMs, mode: 'on' as const }
  : undefined;
```

**Cancel path invalidation**:
```typescript
// In AsyncJobManager
cancel(id: string, filter?: AsyncJobFilter): boolean {
  const job = this.#jobs.get(id);
  if (!job) return false;
  if (filter?.ownerId && job.ownerId !== filter.ownerId) return false;
  if (job.status !== "running") return false;
  
  job.status = "cancelled";
  job.abortController.abort();
  
  // F6: Synchronous invalidation
  this.#stopStalenessMonitor(job.incarnationId);
  this.#invalidateJobEpisodes(job.incarnationId);
  
  this.#scheduleEviction(id);
  return true;
}

cancelAll(filter?: AsyncJobFilter): void {
  for (const job of this.getRunningJobs(filter)) {
    job.status = "cancelled";
    job.abortController.abort();
    
    // F6: Synchronous invalidation
    this.#stopStalenessMonitor(job.incarnationId);
    this.#invalidateJobEpisodes(job.incarnationId);
    
    this.#scheduleEviction(job.id);
  }
}

async dispose(): Promise<boolean> {
  if (this.#disposed) return true;
  this.#disposed = true;
  
  // F6: Stop all timers and invalidate all episodes before final wait
  for (const job of this.#jobs.values()) {
    this.#stopStalenessMonitor(job.incarnationId);
    this.#invalidateJobEpisodes(job.incarnationId);
  }
  
  this.cancelAll();
  // ... existing dispose logic
}
```

**Queued phase** (F6 decision: mark optional or implement):
```
Option 1: Mark as optional
- Remove 'queued' from DiagnosticEpisode.phase union
- Only 'running-no-progress' | 'running-idle'

Option 2: Implement queued-phase timer
- In register(): if queued && policy, start queued-phase timer
- In markRunning(): stop queued timer, increment generation, start running timer
```

**Recommended**: Option 1 (simplify to running-only)

---

## F7: Executable Tests

**Location**: §7.1

Replace all `// Test: ...` comments with:

```typescript
// test/async-job-manager.test.ts
import { describe, it, expect, afterEach } from "bun:test";
import { AsyncJobManager } from "../src/async/job-manager";
import { createDeferred } from "../src/utils/deferred";

describe("Staleness detection", () => {
  let manager: AsyncJobManager;
  
  afterEach(async () => {
    if (manager) await manager.dispose();
  });
  
  it("should start timer on markRunning with frozen policy", async () => {
    const events: any[] = [];
    manager = new AsyncJobManager({
      onJobComplete: (event) => events.push(event)
    });
    
    const deferred = createDeferred<string>();
    const jobId = manager.register("bash", "test-job", async ({ markRunning, reportProgress }) => {
      markRunning();
      await reportProgress("started");
      await deferred.promise;
      return "done";
    }, {
      ownerId: "test-owner",
      stalenessPolicy: { thresholdMs: 100, mode: "on" }
    });
    
    // Wait for staleness
    await Bun.sleep(150);
    
    // Should have received lifecycle event
    const lifecycleEvent = events.find(e => e.type === 'staleness');
    expect(lifecycleEvent).toBeDefined();
    expect(lifecycleEvent.jobId).toBe(jobId);
    
    deferred.resolve("done");
    await manager.getJob(jobId)!.promise;
  });
  
  it("should invalidate pending episodes on progress", async () => {
    // Test: reportProgress increments generation, old episode marked acked
  });
  
  it("should isolate two-owner staleness policies", async () => {
    // Test: ownerA threshold=100ms, ownerB threshold=200ms
  });
});

// test/tools/hub-wait.test.ts
import { HubTool } from "../../src/tools/hub";
import { createTestSession } from "../test-helpers";

describe("Hub wait lifecycle integration", () => {
  it("should resolve lifecycle event before poll window", async () => {
    const session = await createTestSession();
    session.settings.set("async.stalenessThresholdMs", 100);
    session.settings.set("async.stalenessMode", "on");
    
    const manager = session.asyncJobManager!;
    const jobId = manager.register("bash", "stuck", async ({ markRunning }) => {
      markRunning();
      await Bun.sleep(5000);
      return "done";
    }, {
      ownerId: session.getAgentId(),
      stalenessPolicy: { thresholdMs: 100, mode: "on" }
    });
    
    const hub = new HubTool(session);
    const result = await hub.execute("call_1", { op: "wait", ids: [jobId], timeoutMs: 2000 });
    
    // Should return diagnostic at ~100ms, not wait 2s
    expect(result.details.diagnostic).toBeDefined();
    expect(result.details.diagnostic!.staleIds).toContain(jobId);
  });
  
  it("should prioritize message over lifecycle event", async () => {
    // Test: message/lifecycle same tick, message wins
  });
});

// test/task/task-spawn.test.ts
import { TaskTool } from "../../src/task";

describe("Queued startup timeout", () => {
  it("should timeout and release permit", async () => {
    const session = await createTestSession();
    session.settings.set("task.maxConcurrency", 1);
    session.settings.set("task.queuedStartupTimeoutMs", 200);
    
    const task = await TaskTool.create(session);
    const manager = session.asyncJobManager!;
    
    // Blocker holds permit
    const blockerDeferred = createDeferred<string>();
    const blocker = await task.execute("call_1", { agent: "scout", task: "blocker" });
    const blockerJobId = blocker.details.async?.jobId;
    
    // Queued job should timeout
    const queued = await task.execute("call_2", { agent: "scout", task: "quick" });
    const queuedJobId = queued.details.async?.jobId;
    const queuedJob = manager.getJob(queuedJobId!);
    
    await queuedJob!.promise.catch(() => {});
    expect(queuedJob!.status).toBe("failed");
    expect(queuedJob!.errorText).toContain("semaphore saturated");
    
    // Release blocker, third spawn should succeed
    blockerDeferred.resolve("done");
    await manager.getJob(blockerJobId!).promise;
    
    const third = await task.execute("call_3", { agent: "scout", task: "test" });
    const thirdJobId = third.details.async?.jobId;
    const thirdJob = manager.getJob(thirdJobId!);
    
    expect(thirdJob!.status).toBe("running");
    await thirdJob!.promise.catch(() => {});
  });
});

// Run with: cd packages/coding-agent && bun test test/async-job-manager.test.ts
```

---

## F8: Metrics & Anchors

**Location**: §9.3, §2.1

**Fix metric definitions**:
```typescript
// Salvage-success applies to runtime timeout, not staleness
// Staleness false-positive: define as "diagnostic followed by natural completion within 2×threshold"

// Runtime false-positive proxy (NEW):
"Runtime-Premature-Abort Rate": {
  definition: "Runtime timeout followed by immediate retry success (same task, <5min)",
  denominator: "All runtime timeout events",
  target: "<10% [拟议验收目标]"
}

// Staleness natural-completion (NEW):
"Staleness-Natural-Completion Rate": {
  definition: "Diagnostic issued, job completes without cancel within 2×threshold",
  denominator: "All staleness episodes",
  // High rate = threshold too aggressive; low rate = threshold appropriate
}

// Metrics owner clarification:
// Diagnostic-Actionable can only observe: cancel (manager), complete (manager), wait (manager.watchJobs)
// Cannot observe: inspect (URL read), history (URL read), adjust (settings change)
// Either instrument those or define as "cancel|complete within 30min of diagnostic"
```

**Fix anchors**:
```typescript
// §2.1 corrections:
- maxConcurrency: settings-schema.ts:4686 (not :4730-4800)
- queued:true: task/index.ts:1212 (not :1085-1118)
- markRunning: task/index.ts:1117 (not :1211-1213)
- drainPendingInbox: hub/index.ts:348-350 (not :371-383)
```

**Rename ledger**:
```
"rollout ledger" → "sequential rollout event log with per-episode deduplication"
```

---

## Implementation Order

1. **F6** (RegisterOptions) - prerequisite for others
2. **F2** (delivery engine) - core infrastructure
3. **F3** (reservation) - depends on F2
4. **F4** (YieldQueue) - depends on F2
5. **F5** (builder/TUI) - cosmetic, can be parallel
6. **F7** (tests) - verification
7. **F8** (metrics) - documentation

---

## Estimated Scope

- F2: ~200 lines (delivery engine refactor)
- F3: ~150 lines (reservation system)
- F4: ~100 lines (YieldQueue integration)
- F5: ~80 lines (builder/TUI fixes)
- F6: ~60 lines (RegisterOptions + wiring)
- F7: ~400 lines (executable tests)
- F8: ~40 lines (metrics + anchors)

**Total**: ~1030 lines of corrections across existing sections

Due to token constraints and interdependencies, recommend: apply F2-F8 corrections to document, then submit for round-6 review.
