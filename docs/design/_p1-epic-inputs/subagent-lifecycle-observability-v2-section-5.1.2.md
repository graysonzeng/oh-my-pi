#### 5.1.2 类型扩展

##### DiagnosticEpisode（F1 内部状态）

```typescript
// packages/coding-agent/src/async/job-manager.ts (internal)
interface DiagnosticEpisode {
  episodeId: string;              // `${ownerId}:${incarnationId}:${generation}`
  jobId: string;
  incarnationId: string;
  generation: number;
  phase: 'queued' | 'running-no-progress' | 'running-idle';
  observedMs: number;             // 实际 idle 时长
  thresholdMs: number;            // 冻结的阈值
  ownerId: string | undefined;
  agentId?: string;
  state: 'pending' | 'wait-claimed' | 'owner-queued' | 'delivered' | 'acked';
  claimedBy?: string;
}
```

**状态机**（F1）：
```
PENDING → (atomic claim) → WAIT_CLAIMED | OWNER_QUEUED
  WAIT_CLAIMED → DELIVERED (post-wake ack)
  OWNER_QUEUED → IN_FLIGHT → DELIVERED → ACKED
```

##### CoordinationDetails.diagnostic（F1 wire contract）

```typescript
// packages/coding-agent/src/tools/hub/types.ts
export interface CoordinationDetails {
  op: HubOp;  // 保持完整 union，不收窄
  // ... 现有 from/to/receipts/waited/inbox/peers/jobs/cancelled/agents ...
  
  // F1: 新增 optional diagnostic
  diagnostic?: {
    staleIds: string[];        // 触发 staleness 的 job id 列表
    thresholdMs: number;       // 使用的阈值
    episodes: Array<{
      jobId: string;
      phase: 'queued' | 'running-no-progress' | 'running-idle';
      idleMs: number;          // 实际 idle 时长
      agentId?: string;        // 关联 AgentRef id（若有）
    }>;
  };
}
```

##### JobSnapshot 扩展字段（F4）

```typescript
// packages/coding-agent/src/tools/hub/types.ts
export interface JobSnapshot {
  // ... 现有 id/type/status/label/durationMs/resolvedModel/resultText/errorText ...
  
  // F4: Liveness fields
  queuedForMs?: number;       // 仅当 job.queued === true 时存在
  startupDelayMs?: number;    // 历史启动延迟：runningStartedAt - startTime（markRunning 后存在）
  idleForMs?: number;         // now - (lastProgressAt ?? runningStartedAt ?? startTime)
  agentIdleForMs?: number;    // 辅助：AgentRegistry cross-check（标注为 informational）
}
```

##### Episode→Diagnostic 转换（F3）

```typescript
// packages/coding-agent/src/tools/hub/jobs.ts (new helper)
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
