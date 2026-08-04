## 6. 风险与缓解

### 6.1 设置默认值变更（Intentional Behavior Change）

**变更**：
- `task.maxRuntimeMs`: 0 → 3600000（1h）[拟议验收目标]
- `task.queuedStartupTimeoutMs`: 新增，默认 120000（2min）[拟议验收目标]
- `async.stalenessThresholdMs`: 新增，默认 600000（10min）[拟议验收目标]
- `async.stalenessMode`: 新增，默认 "off"（显式 opt-in）

**风险**：老 session 未显式配置时，subagent 将自动 timeout/fail（1h runtime, 2min queued）

**缓解**：
1. **Schema migration 无需数据转换**：additive schema，老 session 继续使用已保存配置
2. **[未验证假设]**："1h 覆盖 99% 正常任务"——需要 baseline 运行时分布验证
3. **[未验证假设]**："2min 排队意味着前方有 stuck jobs"——需要 maxConcurrency=4/8/32 下的健康排队时长数据
4. **Rollback**：用户可显式设为 0 禁用（per-setting 独立开关）

### 6.2 False-Positive Mitigation

**Queued timeout false-positive**：
- **Proxy**：permit-leak rate（timeout 后 permit 未释放）应为 0
- **Verification**：§7 Test 4 覆盖 post-acquire first-cause + releasePermit exactly-once

**Runtime timeout false-positive**：
- **Proxy**：salvage-success rate（timeout 后 artifact 落盘成功）[拟议验收目标] >80%
- **Verification**：现有 executor-wall-clock.test.ts 覆盖 abort+salvage contract

**Staleness false-positive**：
- **Proxy**：diagnostic-actionable rate（owner 在通知后 inspect/cancel/adjust）[拟议验收目标]
- **Non-goal**：不以"diagnostic 后 cancel rate"作质量指标（正确干预包括 inspect、wait、调整阈值、自然完成）

### 6.3 Queued Timeout Races（F4: Closed）

**场景**：`acquire()` 与 `queuedAbortController` 同 tick abort

**缓解**：
- Post-acquire 检查 `combinedSignal.reason`（unique timeout token）保持 first-cause
- `semaphoreHeld` flag 在 acquire 返回后立即设为 true
- 所有 exit 路径统一走 `releasePermit() → #releaseSpawnSemaphore()`
- Single settlement guard 保证 `onSettled` exactly once

**验证**：§7 Test 4 四种 interleaving（permit-before-timeout, timeout-before-permit, cancel-before-timeout, same-tick）

### 6.4 Staleness Fallback（F4: Closed）

**场景**：Job 启动后从未调用 `reportProgress`

**行为**：`idleForMs = now - (lastProgressAt ?? runningStartedAt ?? startTime)`

**验证**：§7 Test 3 覆盖 no-first-progress case

### 6.5 AgentRegistry Cross-Check（Informational）

**字段**：`JobSnapshot.agentIdleForMs`（F4: 标注为 informational）

**用途**：辅助 warning（job idle 与 agent idle 不一致时提示可能的 progress 未上报）

**非不变量**：job.lastProgressAt 与 AgentRef.lastActivity 来自不同事件路径，不保证"最终一致"

### 6.6 Parked-Parent Replay（Out of Scope）

**现状**：5min job-row retention 后，自动通知 dead-letter

**可追溯性保持**：
- Artifact output: `agent://<id>` [已核实] agent-protocol.ts:37-44（无 .md 后缀）
- Transcript: `history://<id>` [已核实] internal-urls/history-protocol.ts

**非本次设计**：durable cross-session delivery ledger / artifact-dir scan / exactly-once replay
