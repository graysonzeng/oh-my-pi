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
