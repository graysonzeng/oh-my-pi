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
