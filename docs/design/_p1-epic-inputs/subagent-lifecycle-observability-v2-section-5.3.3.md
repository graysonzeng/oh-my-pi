#### 5.3.3 buildJobResult 与 TUI Integration（F5: Surgical Diff）

##### buildJobResult Signature（F5: 7th Param）

```typescript
// packages/coding-agent/src/tools/hub/jobs.ts

export function buildJobResult(
  session: ToolSession,
  manager: AsyncJobManager,
  op: "wait" | "cancel" | "jobs",
  jobs: TrackedJobLike[],
  cancelOutcomes: CancelOutcome[],
  agents: AgentActivitySnapshot[] = [],
  options?: { diagnostic?: CoordinationDetails["diagnostic"] }  // F5: NEW 7th param
): AgentToolResult<CoordinationDetails> {
  // F5: 保持现有 dedupe
  const seen = new Set<string>();
  const uniqueJobs = jobs.filter(j => {
    if (seen.has(j.id)) return false;
    seen.add(j.id);
    return true;
  });
  const jobResults = snapshotJobs(session, uniqueJobs);

  // F5: 保持自动 ack
  manager.acknowledgeDeliveries(jobResults.filter(j => j.status !== "running").map(j => j.id));

  const completed = jobResults.filter(j => j.status !== "running");
  const running = jobResults.filter(j => j.status === "running");

  // F5: 保持 conditional spreads
  const details: CoordinationDetails = {
    op,
    jobs: jobResults,
    ...(cancelOutcomes.length > 0 ? { cancelled: cancelOutcomes } : {}),
    ...(agents.length > 0 ? { agents } : {}),
    ...(options?.diagnostic ? { diagnostic: options.diagnostic } : {}),  // F5: NEW
  };

  // F5: 保持 empty fallback
  if (jobResults.length === 0 && agents.length === 0) {
    return { content: [{ type: "text", text: "No background jobs." }], details };
  }

  const lines: string[] = [];

  // F5: 保持 CancelOutcome.message
  if (cancelOutcomes.length > 0) {
    lines.push(`## Cancelled (${cancelOutcomes.length})\n`);
    for (const o of cancelOutcomes) lines.push(`- ${o.message}`);
    lines.push("");
  }

  if (completed.length > 0) {
    lines.push(`## Completed (${completed.length})\n`);
    for (const j of completed) {
      lines.push(`### ${j.id} [${j.type}] — ${j.status}`);
      lines.push(`Label: ${j.label}`);
      if (j.resultText) {
        lines.push("```", j.resultText, "```");
      }
      if (j.errorText) {
        lines.push(`Error: ${j.errorText}`);
      }
      lines.push("");
    }
  }

  if (running.length > 0) {
    lines.push(`## Still Running (${running.length})\n`);
    for (const j of running) {
      lines.push(`- \`${j.id}\` [${j.type}] — ${j.label}`);
    }
  }

  if (agents.length > 0) {
    lines.push("", ...describeAgents(agents));
  }

  // F5: 保持 ordinary useless
  const allRunning = jobResults.length > 0 && jobResults.every(j => j.status === "running");
  if (allRunning && cancelOutcomes.length === 0 && !options?.diagnostic) {
    details.useless = true;
  }

  return { content: [{ type: "text", text: lines.join("\n") }], details };
}
```

##### isWaitingPollDetails 扩展（F5）

```typescript
// packages/coding-agent/src/tools/hub/jobs.ts

export function isWaitingPollDetails(details: unknown): boolean {
  if (!isRecord(details)) return false;
  const jobs = details.jobs;
  if (!Array.isArray(jobs) || jobs.length === 0) return false;
  
  // F5: Diagnostic 存在时永不 displaceable
  if (details.diagnostic) return false;
  
  const allRunning = jobs.every(j => isRecord(j) && j.status === "running");
  const noCancelled = !details.cancelled || !Array.isArray(details.cancelled) || details.cancelled.length === 0;
  return allRunning && noCancelled;
}
```

##### jobsRenderResult Seam（F5: TUI Integration）

```typescript
// packages/coding-agent/src/tools/hub/jobs.ts

export function jobsRenderResult(
  result: { content: Array<{ type: string; text?: string }>; details?: CoordinationDetails; isError?: boolean },
  options: RenderResultOptions,
  uiTheme: Theme,
  hubArgs?: HubRenderArgs,
): Component {
  const details = result.details;
  if (!details) return /* existing fallback */;
  
  // F5: Sealed poll filtering
  if (isWaitingPollDetails(details) && !details.diagnostic) {
    // 现有 sealed poll logic: 全 running 且无 diagnostic → displacement
    if (options.sealed) {
      return null;  // TUI displaces
    }
    // Filter out running rows in sealed poll
    const filteredJobs = details.jobs?.filter(j => j.status !== "running") ?? [];
    if (filteredJobs.length === 0 && !details.agents?.length) {
      return null;  // Nothing to show
    }
  }
  
  // F5: renderItem with liveness/diagnostic info
  const renderItem = (job: JobSnapshot, diagnostic?: CoordinationDetails["diagnostic"]) => {
    const statusIcon = formatStatusIcon(job.status);
    const isDiagnosticJob = diagnostic?.staleIds.includes(job.id);
    const color = isDiagnosticJob ? uiTheme.fg.yellow : statusToColor(job.status);
    
    const parts: string[] = [
      `${statusIcon} ${job.id} [${job.type}]`,
      ` — ${job.label}`,
    ];
    
    // F4: Append liveness info
    if (job.queuedForMs !== undefined) {
      parts.push(` (queued ${formatDuration(job.queuedForMs)})`);
    } else if (job.idleForMs !== undefined) {
      parts.push(` (idle ${formatDuration(job.idleForMs)})`);
    }
    
    // F5: Append diagnostic stale marker
    if (isDiagnosticJob) {
      const episode = diagnostic!.episodes.find(e => e.jobId === job.id);
      if (episode) {
        parts.push(` [STALE: ${episode.phase}, ${formatDuration(episode.idleMs)}/${formatDuration(diagnostic!.thresholdMs)}]`);
      }
    }
    
    return uiTheme.text(parts.join(""), color);
  };
  
  // F5: 保持 existing renderTreeList/shimmer/cache/truncate/preview pipeline
  const jobRows = (details.jobs ?? []).map(j => renderItem(j, details.diagnostic));
  
  return renderTreeList(jobRows, { shimmer: options.shimmer, /* ... */ });
}
```

##### snapshotJobs 扩展（F4: Liveness Computation）

```typescript
// packages/coding-agent/src/tools/hub/jobs.ts

export function snapshotJobs(session: ToolSession, jobs: TrackedJobLike[]): JobSnapshot[] {
  const now = Date.now();
  return jobs.map(j => {
    const latest = 'latestDetails' in j ? j : j;
    
    const snapshot: JobSnapshot = {
      id: latest.id,
      type: latest.type,
      status: latest.status as JobSnapshot["status"],
      label: latest.label,
      durationMs: Math.max(0, now - latest.startTime),
    };
    
    // F4: Liveness fields
    if (latest.queued) {
      snapshot.queuedForMs = now - latest.startTime;
    } else if (latest.runningStartedAt) {
      snapshot.startupDelayMs = latest.runningStartedAt - latest.startTime;
      snapshot.idleForMs = now - (latest.lastProgressAt ?? latest.runningStartedAt);
    } else {
      // No markRunning yet, fallback to startTime
      snapshot.idleForMs = now - (latest.lastProgressAt ?? latest.startTime);
    }
    
    // F4: agentIdleForMs (informational cross-check)
    if (latest.agentId) {
      const ref = AgentRegistry.global().get(latest.agentId);
      if (ref?.lastActivity) {
        snapshot.agentIdleForMs = now - ref.lastActivity;
      }
    }
    
    // Existing resolvedModel/resultText/errorText logic
    if (latest.type === "task") {
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

##### TrackedJobLike 扩展（F5: Type Fix）

```typescript
// packages/coding-agent/src/tools/hub/jobs.ts (local interface)

interface TrackedJobLike {
  id: string;
  type: "bash" | "task";
  status: "running" | "completed" | "failed" | "cancelled";
  label: string;
  startTime: number;
  resultText?: string;
  errorText?: string;
  latestDetails?: Record<string, unknown>;
  
  // F2+F4: New fields
  queued?: boolean;
  runningStartedAt?: number;
  lastProgressAt?: number;
  agentId?: string;
}
```
