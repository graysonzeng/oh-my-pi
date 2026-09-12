## 8. 实现阶段（F6: Opt-In Rollout）

### Phase 0: Schema Defaults + Off Mode

**时间**：Week 1  
**交付**：
- Settings schema 添加四个新字段（§5.1.3）
- `task.maxRuntimeMs` 默认改为 3600000（1h）
- `task.queuedStartupTimeoutMs` 默认 120000（2min）
- `async.stalenessThresholdMs` 默认 600000（10min）
- `async.stalenessMode` 默认 **"off"**（F6: 删除 shadow，简化为显式 opt-in）

**行为**：
- Runtime/queued timeout **自动生效**（默认非零）
- Staleness detection **不生效**（mode="off"）

**验证**：
- [拟议验收目标] N=10 本地测试 session，1 week
- Metrics: permit-leak rate=0, settlement-failure rate=0
- Min sample: 50 queued spawns, 20 runtime timeout

**Stop Condition**：
- Permit-leak rate > 0 → 回滚 queued timeout 到 0
- Settlement-failure rate > 5% → 修复 onSettled exactly-once

### Phase 1: Staleness Opt-In Canary

**时间**：Week 2-3  
**Activation**：显式设置 `async.stalenessMode="on"` 或 `async.stalenessThresholdMs>0`（任一即启用）

**交付**：
- AsyncJobManager lifecycle delivery 完整实现（§5.2.1）
- HubTool subscription API（§5.3.1）
- AgentSession typed event handler（§5.3.2）
- TUI diagnostic rendering（§5.3.3）

**验证**：
- [拟议验收目标] N=20 opt-in sessions，2 weeks，non-overlap interval
- Metrics (per-episode dedupe):
  - Staleness episode count
  - Diagnostic-actionable rate（owner 在通知后有干预行为）
  - False-positive proxy: salvage-success rate >80%
- Min sample: 50 staleness episodes

**Stop Condition**：
- Delivery exactly-once violated（同一 episode 重复注入）→ 修复 F1 claim 机制
- Episode state leak（pending 不清理）→ 修复 invalidation logic
- Diagnostic actionable rate <20% → 调整默认阈值或 fallback 到 off

**Rollback**：设置改回 `mode="off"`

### Phase 2: Default Mode="On"（Optional）

**前提**：Phase 1 通过所有 stop conditions

**时间**：Week 4-5  
**交付**：Settings schema default 改为 `async.stalenessMode="on"`

**验证**：
- [拟议验收目标] 全量观察 2 weeks
- Metrics 同 Phase 1，扩大分母

**Rollback**：Settings default 改回 "off"

### Phase 3: Queued Phase Timer（Optional）

**决定**：保留 queued phase（§5.2.1 queued-phase timer 启动逻辑）

**验证**：queued job 的 staleness episode.phase="queued" 可观测

### Phase 4: Watchdog/Advisor Integration（Optional, Out of P0-P2 Scope）

**注意**：现有 advisor/watchdog.ts 是被动审阅配置/prompt 加载器 [已核实]，不是 subagent 生命周期终止器。若未来实现主动干预，owner 必须仍在 async/task lifecycle，通过 AsyncJobManager cancel/abort+salvage canonical path 执行。
