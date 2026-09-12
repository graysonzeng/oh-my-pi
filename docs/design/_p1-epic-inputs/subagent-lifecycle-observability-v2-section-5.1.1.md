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
