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
