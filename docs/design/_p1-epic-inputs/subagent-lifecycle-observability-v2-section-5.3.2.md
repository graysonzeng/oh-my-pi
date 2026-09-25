#### 5.3.2 AgentSession Delivery Sink Registration（F1: Typed Event Handler）

```typescript
// packages/coding-agent/src/session/agent-session.ts

#registerAsyncDeliverySink(): void {
  if (!this.#asyncJobManager || !this.#agentId) return;
  
  // F1: Typed event handler
  const sink: AsyncJobDeliverySink = (event: AsyncJobDeliveryEvent) => {
    if (event.type === 'completion') {
      // 现有 completion delivery → YieldQueue
      this.#yieldQueue.enqueue({
        epoch: this.#asyncDeliveryEpoch,
        jobId: event.jobId,
        result: event.text,
        job: event.job,
        durationMs: event.job ? Date.now() - event.job.startTime : undefined,
        isStale: (currentEpoch: number) => currentEpoch !== this.#asyncDeliveryEpoch,
      });
    } else if (event.type === 'staleness') {
      // F1: Lifecycle diagnostic → YieldQueue (nonterminal custom message)
      this.#yieldQueue.enqueue({
        epoch: this.#asyncDeliveryEpoch,
        customType: 'lifecycle-diagnostic',  // NEW message type
        jobId: event.jobId,
        episodeId: event.episodeId,
        phase: event.phase,
        idleMs: event.observedMs,
        thresholdMs: event.thresholdMs,
        agentId: event.agentId,
        isStale: (currentEpoch: number) => currentEpoch !== this.#asyncDeliveryEpoch,
      });
    }
  };
  
  this.#unregisterAsyncDeliverySink = this.#asyncJobManager.registerDeliverySink(
    this.#agentId,
    sink
  );
}
```

**F1 YieldQueue Epoch/Stale Semantics**:
- 每个 queued item 携带 `epoch` at enqueue time
- Session transitions (`/new`, handoff) increment `#asyncDeliveryEpoch`
- Flush 时调用 `isStale(currentEpoch)` 过滤 stale entries
- 即使 job-id reuse，epoch 不匹配的 delivery 被丢弃

**Nonterminal Lifecycle Message Template**:
```typescript
// packages/coding-agent/src/prompts/tools/lifecycle-diagnostic.md (NEW)
{{#if multiple}}
## Lifecycle Diagnostics ({{count}})
{{#each episodes}}
- `{{jobId}}`: {{phase}}, idle {{idleMs}}ms (threshold {{thresholdMs}}ms){{#if agentId}} — agent `{{agentId}}`{{/if}}
{{/each}}
{{else}}
## Lifecycle Diagnostic
Job `{{jobId}}` is {{phase}}, idle {{idleMs}}ms (threshold {{thresholdMs}}ms).
{{#if agentId}}Agent: `{{agentId}}`{{/if}}
{{/if}}

Consider: inspect with `agent://{{jobId}}` or `history://{{agentId}}`, adjust threshold, or cancel if hung.
```
