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
