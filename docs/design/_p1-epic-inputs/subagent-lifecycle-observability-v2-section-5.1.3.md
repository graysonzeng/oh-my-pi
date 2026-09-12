#### 5.1.3 Settings schema（新增条目）

```typescript
// packages/coding-agent/src/config/settings-schema.ts

"task.queuedStartupTimeoutMs": {  // F8: 正确命名（不是 queuedTimeoutMs）
  type: "number",
  default: 120000,  // 2min [拟议验收目标]
  ui: {
    tab: "tasks",
    group: "Subagents",
    label: "Queued Startup Timeout",
    description: "Max time a spawn may wait for a semaphore permit (ms). 0 disables. Crossing the limit fails the spawn with a clear 'semaphore saturated' reason and releases the permit so later spawns can proceed.",
    options: [
      { value: "0", label: "Unlimited" },
      { value: "60000", label: "1 minute" },
      { value: "120000", label: "2 minutes" },
      { value: "300000", label: "5 minutes" },
    ],
  },
},

"task.maxRuntimeMs": {
  type: "number",
  default: 3600000,  // 1h [拟议验收目标] (changed from 0)
  ui: {
    tab: "tasks",
    group: "Subagents",
    label: "Task Runtime Limit",
    description: "Wall-clock limit for subagent execution (ms). 0 disables. Crossing the limit aborts the executor and salvages partial output.",
    options: [
      { value: "0", label: "Unlimited" },
      { value: "1800000", label: "30 minutes" },
      { value: "3600000", label: "1 hour" },
      { value: "7200000", label: "2 hours" },
    ],
  },
},

"async.stalenessThresholdMs": {
  type: "number",
  default: 600000,  // 10min [拟议验收目标]
  ui: {
    tab: "tasks",
    group: "Subagents",
    label: "Staleness Notification Threshold",
    description: "Idle time before AsyncJobManager proactively notifies the owner of a stale running job (ms). 0 disables staleness detection.",
    options: [
      { value: "0", label: "Disabled" },
      { value: "300000", label: "5 minutes" },
      { value: "600000", label: "10 minutes" },
      { value: "1200000", label: "20 minutes" },
    ],
  },
},

"async.stalenessMode": {
  type: "enum",
  values: ["off", "on"],  // F6: 删除 shadow，简化为 off|on
  default: "off",  // F6: 默认 off，显式 opt-in
  ui: {
    tab: "tasks",
    group: "Subagents",
    label: "Staleness Notification Mode",
    description: "off: disabled; on: deliver diagnostic to owner when threshold crossed.",
  },
},
```

**F6 Mode 决定**：删除 `shadow` 模式（需要复杂的"检测但不投递"语义），简化为 **off（默认）/ on（opt-in）**。

**Activation contract**：
- `task.queuedStartupTimeoutMs`：TaskTool#registerSpawnJob post-acquire 检查（§5.2.4）
- `task.maxRuntimeMs`：executor preflight（现有路径，[已核实] task/executor.ts）
- `async.stalenessThresholdMs` / `async.stalenessMode`：TaskTool spawn 时读取并冻结到 `AsyncJobRegisterOptions.stalenessPolicy`（§5.2.1）
