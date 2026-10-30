# Coding Harness — production 200K soft-cap landing

Tip base: `4316b36d90abc73ab23009c85ec9c2b14dfcfe25` (`workflow`).  
Branch: `cursor/soft-cap-200k-default-6420`.

## Effective threshold math

Production default: `compaction.thresholdTokens = 200_000` (experiment master switch remains off).

| Window | Before | After |
|---:|---:|---:|
| 128K | 108.8K | 108.8K |
| 200K | 170K | 170K |
| 256K | 217.6K | **200K** |
| 1M | 850K | **200K** |

Clamp: fixed tokens → `min(configured, window − reserve)` via `resolveUsableContextTokens`.

## Commands

```text
bun check
bun test packages/agent/test/compaction-soft-cap-threshold.test.ts
bun test packages/coding-agent/test/session/soft-cap-default.test.ts
bun test packages/coding-agent/test/task/result-summary.test.ts
bun test packages/coding-agent/test/agent-session-goal-midrun-compaction.test.ts -t reinjects
```

All above pass. Residual: pre-existing flake `delivers parent steering…`; no paid/model evals.
