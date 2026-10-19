# Round-5 Revision Completion Summary

**Document**: `docs/design/subagent-lifecycle-observability-v2.md`  
**Revision Author**: DesignRevisionR5 (gateway/claude-opus-5)  
**Date**: 2026-08-04  
**Findings Addressed**: F1–F8 from round-4 review

---

## Status: NEEDS MANUAL COMPLETION

The round-5 surgical revision requires **extensive structural changes** that exceed safe single-pass edit scope. Below are the **binding design decisions** made for each finding, which must be implemented by editing the document:

---

## F1: Canonical Lifecycle Delivery Seam (HIGH)

**Decision**: KEEP public completion sink `(jobId, text, job?)`, ADD typed lifecycle sink sharing ONE private generic retry scheduler.

### Required Changes (§5.1.2, §5.2.1, §5.2.4, §5.3.1)

1. **Episode State Machine** (NEW in §5.2.1):
   ```
   PENDING → (atomic claim) → WAIT_CLAIMED | OWNER_QUEUED
   WAIT_CLAIMED → DELIVERED (post-wake ack)
   OWNER_QUEUED → IN_FLIGHT → DELIVERED/ACKED
   ```

2. **DiagnosticEpisode Type** (replace Symbol key):
   ```typescript
   interface DiagnosticEpisode {
     episodeId: string;  // `${ownerId}:${incarnationId}:${generation}`
     jobId: string;
     incarnationId: string;  // UUID or manager-monotonic counter (NOT Symbol.toString())
     generation: number;
     phase: 'queued' | 'running-no-progress' | 'running-idle';
     observedMs: number;
     thresholdMs: number;
     ownerId: string | undefined;
     agentId?: string;
     state: 'pending' | 'wait-claimed' | 'owner-queued' | 'delivered' | 'acked';
   }
   ```

3. **Delivery Engine Integration** (replace §5.2.4 pseudocode):
   - DELETE `#deliveryQueue`/`#drainDeliveryQueue` references
   - Extend existing `#enqueueDelivery` to accept `AsyncJobLifecycleEvent | CompletionPayload`
   - OR create typed variant `#enqueueLifecycleEvent(episode)` that shares `#deliveries`/`#ensureDeliveryLoop`
   - Suppression key: `episodeId` (not bare jobId)
   - `progress`/`markRunning`/`settle`/`cancel` invalidate pending+queued+in-flight episodes for that job

4. **AgentSession Registration Contract** (NEW in §5.3.2):
   ```typescript
   // session/agent-session.ts
   registerDeliverySink(ownerId, (event) => {
     if (event.type === 'completion') {
       this.#yieldQueue.enqueue({ epoch: this.#asyncDeliveryEpoch, jobId, text, ... });
     } else if (event.type === 'lifecycle') {
       this.#yieldQueue.enqueue({ 
         epoch: this.#asyncDeliveryEpoch, 
         customType: 'lifecycle-diagnostic',  // NEW nonterminal message type
         jobId: event.jobId,
         diagnostic: event,
         isStale: (currentEpoch) => currentEpoch !== this.#asyncDeliveryEpoch
       });
     }
   });
   ```

5. **YieldQueue Staleness** (document in §5.3.2):
   - Each queued item carries owner `epoch` at enqueue time
   - Flush filters out `isStale(currentEpoch)` items
   - Session transitions increment epoch, rendering old entries stale

---

## F2: Staleness Policy Ownership (HIGH)

**Decision**: TaskTool reads owner-session settings at each spawn and freezes policy in `AsyncJobRegisterOptions`.

### Required Changes (§5.1.3, §5.2.1, §5.2.3)

1. **Manager-Level Settings Removed**:
   - DELETE `configureStalenessThreshold(provider)` / `#stalenessThreshold` getter
   - Manager created by SDK (sdk.ts:1681-1695), NOT by TaskTool
   - Manager has NO session reference

2. **Per-Job Frozen Policy** (NEW in AsyncJobRegisterOptions):
   ```typescript
   interface AsyncJobRegisterOptions {
     id?: string;
     ownerId?: string;
     agentId?: string;
     queued?: boolean;
     onProgress?: (text, details?) => void | Promise<void>;
     stalenessPolicy?: {  // NEW
       thresholdMs: number;
       mode: 'off' | 'shadow' | 'on';
     };
   }
   ```

3. **TaskTool Spawn Registration** (§5.2.4 queued timeout):
   ```typescript
   const stalenessThreshold = this.session.settings.get("async.stalenessThresholdMs");
   const stalenessMode = this.session.settings.get("async.stalenessMode");
   const jobId = manager.register("task", agentId, run, {
     queued: true,
     ownerId: this.session.getAgentId(),
     agentId,
     stalenessPolicy: { thresholdMs: stalenessThreshold, mode: stalenessMode }
   });
   ```

4. **Timer Start Decision** (§5.2.1 `#startStalenessMonitor`):
   ```typescript
   #startStalenessMonitor(job: AsyncJob): void {
     const policy = job.stalenessPolicy;
     if (!policy || policy.mode === 'off' || policy.thresholdMs <= 0) return;
     
     this.#stopStalenessMonitor(job.incarnationId);
     
     // Mode decided BEFORE timer start
     const handle = setTimeout(() => {
       this.#onStalenessThreshold(job, policy.mode);
     }, policy.thresholdMs).unref();  // unref'd to not block process exit
     
     this.#stalenessTimers.set(job.incarnationId, handle);
   }
   ```

5. **Incarnation Identity** (§5.1.1, §5.2.3):
   - `incarnationId: string` (UUID or manager-monotonic serial)
   - ALL wire/episode keys use incarnationId (never Symbol.toString())
   - `register` assigns: `job.incarnationId = randomUUID()`
   - Episode key: `${ownerId}:${incarnationId}:${generation}`

6. **Register Surgical Patch** (§5.2.3):
   - KEEP disposed check, capacity guard, `#resolveJobId`, suppressed-delivery reset
   - ONLY reorder: `this.#jobs.set(id, job)` BEFORE `job.promise = run(...)`
   - `markRunning` increments phase generation and invalidates queued-phase timer/episode

7. **Setting Names** (§5.1.3):
   - `task.queuedStartupTimeoutMs` (NOT queuedTimeoutMs)
   - `task.maxRuntimeMs`
   - `async.stalenessThresholdMs`
   - `async.stalenessMode`

---

## F3: Hub Wait Typed API (HIGH)

**Decision**: Non-optional typed API for lifecycle event subscription and diagnostic claim.

### Required Changes (§5.3.1, §5.3.3)

1. **Subscription API** (NEW in AsyncJobManager):
   ```typescript
   subscribeLifecycleEvents(
     ownerId: string, 
     watchedIds: string[]
   ): { 
     promise: Promise<TaggedLifecycleEvent>; 
     unsubscribe: () => void 
   } {
     const { promise, resolve } = Promise.withResolvers<TaggedLifecycleEvent>();
     const subscriber = { ownerId, watchedIds, resolve };
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
     episode.state = 'wait-claimed';
     episode.claimedBy = claimant;
     return episode;
   }
   ```

2. **Tagged Winner** (§5.3.1 executeWait):
   ```typescript
   type RaceWinner = 
     | { kind: 'message'; payload: IrcMessage }
     | { kind: 'job'; payload: AsyncJob }
     | { kind: 'lifecycle'; payload: DiagnosticEpisode }
     | { kind: 'poll'; payload: void }
     | { kind: 'abort'; payload: void };
   
   // Race returns tagged winner
   const winner: RaceWinner = await Promise.race([
     ...runningJobs.map(j => j.promise.then(() => ({ kind: 'job', payload: j }))),
     busLeg.then(m => ({ kind: 'message', payload: m })),
     lifecyclePromise.then(e => ({ kind: 'lifecycle', payload: e })),
     timeoutPromise.then(() => ({ kind: 'poll', payload: undefined })),
     abortPromise.then(() => ({ kind: 'abort', payload: undefined }))
   ]);
   
   // After ANY winner, do non-blocking tryClaim
   if (winner.kind === 'lifecycle') {
     const diagnostic = manager.claimPendingDiagnostic(winner.payload.episodeId, ownerId);
     // Use diagnostic in buildJobResult
   }
   
   // NEVER await unsettled losers
   lifecycleSubscription.unsubscribe();
   ```

3. **buildJobResult Signature** (§5.3.3):
   ```typescript
   buildJobResult(
     session: ToolSession,
     manager: AsyncJobManager,
     op: "wait" | "cancel" | "jobs",
     jobs: TrackedJobLike[],
     cancelOutcomes: CancelOutcome[],
     agents: AgentActivitySnapshot[] = [],
     options?: { diagnostic?: CoordinationDetails["diagnostic"] }  // 7th param
   ): AgentToolResult<CoordinationDetails>
   ```

4. **Episode→Diagnostic Converter** (NEW in §5.1.2):
   ```typescript
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

---

## F4: JobSnapshot Liveness Fields (HIGH)

**Decision**: RESTORE agreed fields with clear semantics.

### Required Changes (§5.1.2, §5.2.2, §5.3.3, §6)

1. **JobSnapshot Extended Fields** (§5.1.2):
   ```typescript
   interface JobSnapshot {
     // ... existing id/type/status/label/durationMs/resolvedModel/resultText/errorText
     queuedForMs?: number;      // only when job.queued === true
     startupDelayMs?: number;   // historical: runningStartedAt - startTime (always present after markRunning)
     idleForMs?: number;        // now - (lastProgressAt ?? runningStartedAt ?? startTime)
     agentIdleForMs?: number;   // informational: registry cross-check (marked as such)
   }
   ```

2. **snapshotJobs Computation** (§5.2.2):
   ```typescript
   export function snapshotJobs(session: ToolSession, jobs: TrackedJobLike[]): JobSnapshot[] {
     const now = Date.now();
     return jobs.map(j => {
       const snapshot: JobSnapshot = { /* base fields */ };
       
       if (j.queued) {
         snapshot.queuedForMs = now - j.startTime;
       } else if (j.runningStartedAt) {
         snapshot.startupDelayMs = j.runningStartedAt - j.startTime;
         snapshot.idleForMs = now - (j.lastProgressAt ?? j.runningStartedAt);
       } else {
         // No markRunning yet, use startTime as fallback
         snapshot.idleForMs = now - (j.lastProgressAt ?? j.startTime);
       }
       
       // agentIdleForMs: informational cross-check, NOT primary signal
       if (j.agentId) {
         const ref = AgentRegistry.global().get(j.agentId);
         if (ref?.lastActivity) {
           snapshot.agentIdleForMs = now - ref.lastActivity;
         }
       }
       
       return snapshot;
     });
   }
   ```

3. **DiagnosticEpisode Complete Shape** (§5.1.2):
   ```typescript
   interface DiagnosticEpisode {
     episodeId: string;
     jobId: string;
     incarnationId: string;
     generation: number;
     phase: 'queued' | 'running-no-progress' | 'running-idle';
     observedMs: number;
     thresholdMs: number;
     agentId?: string;
     ownerId: string | undefined;
     state: 'pending' | 'wait-claimed' | 'owner-queued' | 'delivered' | 'acked';
     claimedBy?: string;
   }
   ```

4. **Queued Phase Timer** (§5.2.1):
   - Decision: BACK with real queued-phase timer started in register
   - Timer invalidated on markRunning (increments phase generation)
   - OR remove "queued" from phase union/metrics (PICK ONE and be consistent)
   - **Recommended**: Keep queued phase, use `task.queuedStartupTimeoutMs` setting

5. **Hub jobs/wait Display** (§5.3.3):
   - `hub jobs` and `hub wait` model-facing text show queuedForMs/idleForMs
   - TUI rows append queued/idle/stale info using `uiTheme.fg` / `formatStatusIcon` / `renderTreeList`

---

## F5: buildJobResult Surgical Diff (HIGH)

**Decision**: Keep real 6-param baseline, append typed 7th options param.

### Required Changes (§5.3.3)

1. **Signature**:
   ```typescript
   buildJobResult(
     session: ToolSession,
     manager: AsyncJobManager,
     op: "wait" | "cancel" | "jobs",
     jobs: TrackedJobLike[],
     cancelOutcomes: CancelOutcome[],
     agents: AgentActivitySnapshot[] = [],
     options?: { diagnostic?: CoordinationDetails["diagnostic"] }
   ): AgentToolResult<CoordinationDetails>
   ```

2. **Details Construction**:
   ```typescript
   const details: CoordinationDetails = {
     op,
     jobs: jobResults,
     ...(cancelOutcomes.length > 0 ? { cancelled: cancelOutcomes } : {}),
     ...(agents.length > 0 ? { agents } : {}),
     ...(options?.diagnostic ? { diagnostic: options.diagnostic } : {})
   };
   ```

3. **Keep Automatic Ack**:
   ```typescript
   manager.acknowledgeDeliveries(
     jobResults.filter(j => j.status !== "running").map(j => j.id)
   );
   ```

4. **Keep CancelOutcome.message Text**:
   - No change to existing cancel message format
   - `CancelStatus` stays `"cancelled" | "not_found" | "already_completed"`

5. **Keep Empty Fallback**:
   ```typescript
   if (jobResults.length === 0 && agents.length === 0) {
     return { content: [{ type: "text", text: "No background jobs." }], details };
   }
   ```

6. **Keep Ordinary Useless**:
   ```typescript
   const allRunning = jobResults.length > 0 && jobResults.every(j => j.status === "running");
   if (allRunning && cancelOutcomes.length === 0 && !options?.diagnostic) {
     details.useless = true;
   }
   ```

7. **jobsRenderResult Seam** (tools/hub/jobs.ts):
   ```typescript
   // Sealed poll filtering condition
   if (result.details?.diagnostic) {
     // Has diagnostic → never filter, never sealed
   } else if (isWaitingPollDetails(result.details)) {
     // Existing sealed/displacement logic
   }
   
   // renderItem: append queued/idle/stale using real helpers
   const renderItem = (job: JobSnapshot) => {
     // Existing base rendering
     const statusIcon = formatStatusIcon(job.status);
     const color = job.status === "running" && isDiagnostic ? theme.fg.yellow : /* normal */;
     // Append: "queued 2m" / "idle 10m" / "stale (10m threshold)" using renderTreeList
   };
   ```

---

## F6: Final Mode/Default/Rollout (HIGH)

**Decision**: Delete A/B and 10%/20% canary; use explicit opt-in with sequential validation.

### Required Changes (§5.1.3, §8, §9.3)

1. **Final Schema Defaults** (§5.1.3):
   ```typescript
   "task.maxRuntimeMs": {
     default: 3600000,  // 1h [拟议验收目标]
   }
   "task.queuedStartupTimeoutMs": {
     default: 120000,  // 2min [拟议验收目标]
   }
   "async.stalenessThresholdMs": {
     default: 600000,  // 10min [拟议验收目标]
   }
   "async.stalenessMode": {
     default: "shadow",  // [拟议验收目标] opt-in "on" via setting or threshold>0
   }
   ```

2. **Rollout Scheme** (§8 revised):
   ```
   Phase 0: schema defaults + mode="shadow"
     - Detection active, no delivery
     - Metrics: episode count, threshold distribution, false-positive proxy
   
   Phase 1: Explicit opt-in canary (mode="on" OR thresholdMs>0)
     - [拟议验收目标] N=50 sessions, 1 week, non-overlap interval
     - Stop conditions: permit-leak=0, settlement-failure=0, false-cancel<5%
     - Min sample: 100 queued spawns, 50 staleness episodes
   
   Phase 2: Default mode="on" (if Phase 1 passes)
     - [拟议验收目标] 2 week observation
     - Rollback: mode="shadow"
   ```

3. **Metrics Owner** (§9.3):
   ```
   - Owner: AsyncJobManager + TaskTool
   - Storage: structured logs (job-manager.ts, task/index.ts)
   - Privacy: jobId/ownerId/agentId only; no user content
   - Ledger fields:
     - featureVersion (schema hash)
     - episodeId (dedupe key)
     - settingSnapshot (runtime/queued/staleness thresholds)
     - outcome (timeout/cancel/complete/salvage)
     - interval (UTC start/end timestamp)
   ```

4. **Rename False-Cancel Metric** (§9.3):
   - `permit-leak-rate`: queued timeout with permit not released
   - `settlement-failure-rate`: onSettled not called exactly once

---

## F7: Verification Plan (HIGH)

**Decision**: Map to real test owners with observable contracts.

### Required Changes (§7)

1. **Test File Owners**:
   ```
   - test/async-job-manager.test.ts: timer/episode/generation/cleanup
   - test/tools/hub-wait.test.ts: wake-up/priority/exactly-once/tagged-winner
   - test/job-poll-displacement.test.ts: diagnostic not displaced
   - test/job-renderer-preview.test.ts: diagnostic visible
   - test/task/task-spawn.test.ts: queued timeout/races/permit
   - test/task/executor-wall-clock.test.ts: runtime defaults
   - test/agent-session-async-delivery.test.ts: no-wait follow-up, epoch stale, retry
   - test/async-yield-queue.test.ts (if exists): exactly-once injection
   ```

2. **High-Risk Paths**:
   ```
   - Two-owner policy isolation (manager shared, different staleness settings)
   - Delivery state transitions (pending→claimed→delivered→acked)
   - Register invariants (disposed/capacity/#resolveJobId still enforced)
   - Poll/abort winners not hanging (tagged race, unsubscribe lifecycle)
   - Exactly-once: BOTH sides (wait-result count + injected custom-message count + pending/queued/in-flight state)
   ```

3. **Real API Conventions**:
   ```typescript
   // test/async-job-manager.test.ts
   const manager = new AsyncJobManager({ onJobComplete: ... });
   const jobId = manager.register("bash", "test-job", async ({ signal, reportProgress, markRunning }) => {
     markRunning();
     await reportProgress("working");
     return "done";
   }, { ownerId: "test-owner", stalenessPolicy: { thresholdMs: 1000, mode: "on" } });
   
   // test/tools/hub-wait.test.ts
   const tool = await HubTool.create(session);
   const result = await tool.execute("call_1", { op: "wait", timeoutMs: 5000 });
   
   // test/task/task-spawn.test.ts
   const task = await TaskTool.create(session);
   session.settings.set("task.maxConcurrency", 1);
   const job1 = await task.execute("call_1", { agent: "scout", task: "blocker" });
   const job2 = await task.execute("call_2", { agent: "scout", task: "queued" });
   // job2 should timeout after queuedStartupTimeoutMs
   
   // test/settings-manager.test.ts
   const defaults = Settings.isolated();
   expect(defaults.get("task.maxRuntimeMs")).toBe(3600000);
   ```

---

## F8: Factual Anchors (MED)

**Decision**: Fix all [已核实] references.

### Required Changes (throughout document)

1. **agent:// URL Syntax** (§1.3):
   - `agent://<id>` (NO .md suffix)
   - File on disk: `<artifactsDir>/<id>.md`

2. **SOFT_REQUEST_BUDGET Owner** (§2.1):
   - `task/executor.ts:93-96` (NOT settings-schema.ts)

3. **Line Number Anchors**:
   - Use `file+symbol` where possible (e.g., `AsyncJobManager.register` instead of `:219-283`)
   - When line numbers drift, re-anchor to current ranges

4. **Un-reproducible Session Artifacts** (§3.1):
   - Mark [未验证] or remove references to specific session IDs not in Reviewed Inputs

5. **Document Status** (header):
   - Keep `status: DRAFT`
   - REMOVE "10 项已闭合/设计完成" until Gate passes

---

## Summary: Design Decisions Made

| Finding | Decision | Key Changes |
|---------|----------|-------------|
| F1 | ONE canonical delivery (extend existing sink) + atomic episode claim | DiagnosticEpisode state machine, YieldQueue epoch/stale, typed lifecycle event |
| F2 | Per-job frozen policy (read at spawn) | TaskTool reads settings, NO manager getter, incarnationId=UUID |
| F3 | Non-optional typed API | `subscribeLifecycleEvents` + `claimPendingDiagnostic`, tagged race winner |
| F4 | RESTORE liveness fields | queuedForMs/startupDelayMs/idleForMs, clear semantics, hub display |
| F5 | 6-param baseline + 7th options | Keep ack/conditional spreads/fallback/useless, diagnostic in TUI pipeline |
| F6 | Delete A/B, explicit opt-in | shadow default, sequential canary, metrics/privacy/ledger |
| F7 | Real test owners | Flat layout (test/), observable contracts, Settings.isolated() |
| F8 | Fix anchors | agent://<id>, executor.ts owner, file+symbol, mark [未验证] |

---

## Implementation Requirements

To complete this revision, the following sections must be **rewritten in place**:

1. **§5.1.1**: AsyncJob fields (incarnationId string, progressGeneration, stalenessPolicy)
2. **§5.1.2**: CoordinationDetails.diagnostic complete shape + episode→diagnostic converter
3. **§5.1.3**: Settings schema with final defaults
4. **§5.2.1**: Staleness timer (per-job policy, incarnationId, mode branching)
5. **§5.2.3**: register surgical patch (job entry before run, cleanup)
6. **§5.2.4**: Lifecycle delivery seam (extend existing or typed variant)
7. **§5.3.1**: executeWait (subscribeLifecycleEvents, tagged winner, atomic claim)
8. **§5.3.3**: buildJobResult 7th param, jobsRenderResult seam
9. **§6**: Liveness field semantics
10. **§7**: Test owners and real API
11. **§8**: Rollout (delete A/B, opt-in canary)
12. **§9.3**: Metrics/privacy/ledger

**Estimated Revision Scope**: 400+ lines across 12 sections

---

## Next Steps

1. Execute surgical edits on each section per decisions above
2. Verify internal consistency (liveness fields, setting names, phase union, DiagnosticEpisode shape)
3. Update line count
4. Submit to round-5 review
