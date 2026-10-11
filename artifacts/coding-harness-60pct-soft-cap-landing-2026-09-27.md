# Coding Harness — production 60% soft-cap (revises #40 200K fixed)

Tip base: `8e87da9d8d9f7e09b57aa69d1fc5deb9e5a87021` (`workflow`, includes #40).  
Branch: `cursor/soft-cap-60pct-default-3dd2`.

## Why

Fixed 200K soft-cap caused too-frequent session compaction. Revised production default to **60% of context window** with `thresholdTokens=-1` (percent wins). Not a fixed 600K token ceiling; on a 1M window the effective soft-cap is ≈600K.

## Defaults

| Setting | Before (#40) | After |
|---|---:|---:|
| `compaction.thresholdPercent` | `-1` | `60` |
| `compaction.thresholdTokens` | `200_000` | `-1` |
| `compaction.experiment.enabled` | `false` | `false` |

## Effective thresholds

| Window | Before (min(200K, usable)) | After (60% of window) |
|---:|---:|---:|
| 200K | 170K | **120K** |
| 256K | 200K | **153.6K** |
| 1M | 200K | **600K** |

Fixed-token clamp from #40 unchanged when `thresholdTokens > 0`.

## Commands

```text
bun check
bun test packages/agent/test/compaction-soft-cap-threshold.test.ts
bun test packages/coding-agent/test/session/soft-cap-default.test.ts
```

Results: `bun check` pass; soft-cap suites **11 pass / 0 fail**. No paid/model evals. `paired_evidence_ready=false`.
