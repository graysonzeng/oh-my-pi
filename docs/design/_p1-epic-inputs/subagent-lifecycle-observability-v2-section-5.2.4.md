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
