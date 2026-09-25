# Context strategy experiment (P1-3)

Single-factor experiment surface over existing `SessionMaintenance` /
`cfgCompaction` knobs. This is a **mechanism + harness + docs** delivery —
not a claim of live latency wins, and not a second compaction scheduler.

## What this is

| Item | Contract |
|---|---|
| Owner | `SessionMaintenance` (existing pre / mid / post / idle / speculation chain) |
| Gate | `compaction.experiment.enabled` — **default `false`** (production defaults unchanged) |
| Rule | Change **one** factor per run; multi-factor overlays fail closed to control |
| 200k | Experiment **tier** for `threshold_tokens` only — **not** a global fixed cap for all models |
| Preserve | Recent edits (`keepRecentTokens` floor), open constraints + acceptance criteria (via handoff/structured retention; recorded on the receipt) |

Do **not**:

- Reopen Track C / add a sidecar compactor
- Claim historical 57% / 30% / 316k figures as current-version evidence
- Change model defaults, concurrency, or Track E prompts in this experiment

## Factors (one at a time)

| Factor | Setting value | Treatment field | Notes |
|---|---|---|---|
| `threshold_tokens` | `compaction.experiment.factor: threshold_tokens` | `compaction.experiment.thresholdTokens` (default `200000`) | If the tier cannot fit `contextWindow − reserve`, resolution returns `baseline_threshold_fallback` and keeps control settings |
| `keep_recent_tokens` | `…factor: keep_recent_tokens` | `compaction.experiment.keepRecentTokens` | Values below the preserve floor (`8000`) are rejected |
| `reserve_tokens` | `…factor: reserve_tokens` | `compaction.experiment.reserveTokens` | Usable-budget floor only |

## How to run a single-factor experiment

Fix task, snapshot, model, tools, and scorer. Alternate control vs treatment.
Only the declared factor may differ.

### Control (production defaults)

```yaml
# ~/.omp/agent/config.yml (or project .omp/settings.json)
compaction:
  experiment:
    enabled: false
```

Or omit the block entirely — defaults are off / `factor: none`.

### Treatment example: 200k threshold tier

Use only on models whose usable window can host the tier. If the tier cannot
fit `contextWindow − reserve`, resolution returns `baseline_threshold_fallback`
and keeps control settings. `SessionMaintenance` logs that fail-closed outcome
once per distinct reason/fingerprint (`logger.warn`,
`Context strategy experiment fell back to control`) so operators can tell
treatment was requested but not applied. The UI status boundaries and recovery
fit checks share the same `effectiveCompactionSettings` overlay.

```yaml
compaction:
  experiment:
    enabled: true
    factor: threshold_tokens
    thresholdTokens: 200000
```

### Treatment example: keep-recent retention

```yaml
compaction:
  experiment:
    enabled: true
    factor: keep_recent_tokens
    keepRecentTokens: 16000   # must be >= 8000 preserve floor
```

### Programmatic harness (tests / offline pairing)

```ts
import {
  applyContextStrategyExperiment,
  buildContextStrategyExperimentRun,
  judgeContextStrategyExperiment,
  CONTEXT_STRATEGY_EXPERIMENT_TIER_TOKENS,
} from "@oh-my-pi/pi-coding-agent/session/context-strategy-experiment";

const control = applyContextStrategyExperiment({
  base: productionCompactionSettings,
  experiment: { enabled: false, factor: "threshold_tokens", thresholdTokens: CONTEXT_STRATEGY_EXPERIMENT_TIER_TOKENS, keepRecentTokens: undefined, reserveTokens: undefined },
  contextWindow: 400_000,
});

const treatment = applyContextStrategyExperiment({
  base: productionCompactionSettings,
  experiment: { enabled: true, factor: "threshold_tokens", thresholdTokens: CONTEXT_STRATEGY_EXPERIMENT_TIER_TOKENS, keepRecentTokens: undefined, reserveTokens: undefined },
  contextWindow: 400_000,
});
```

Record arms with `buildContextStrategyExperimentRun` and judge with
`judgeContextStrategyExperiment`. The harness **never** sets
`claimedLiveWin: true` — live wins require a recorded paired corpus.

## How to judge

Report all three; do not hide a regression behind total wall-clock alone.

1. **Total task time** — end-to-end wall from task start → accepted result (`totalTaskTimeMs`). Prefer parent critical path; do not sum parallel child intervals as e2e.
2. **Constraint retention** — after maintenance, are open constraints still present and actionable? (`retained` / `lost` / `unknown`)
3. **Recovery quality** — can the session recover omitted content / continue correctly after compaction? (`recovered` / `failed` / `unknown`)

Also keep the shared experiment bar from the revised optimization plan:

- Success rate, first-pass rate, rework, cost
- Failures stay in the corpus (do not drop)
- Sample-size caveats: small n is a screening signal only

`judgeContextStrategyExperiment` returns `incomplete_metrics` when any of the
three primary fields is missing/`unknown` on either arm, and always leaves
`claimedLiveWin: false`.

## Preserve policy

Whatever factor you expose, the receipt always records:

- `preserve.recentEdits: true` — verbatim recent suffix via `keepRecentTokens` (floor enforced on that factor)
- `preserve.openConstraints: true` — retained through handoff / structured method content (not a separate numeric knob)
- `preserve.acceptanceCriteria: true` — same path as constraints

Do not ship a treatment that strips handoff/structured from `methodOrder` as
part of this experiment surface.

## Code map

| Path | Role |
|---|---|
| `packages/coding-agent/src/session/context-strategy-experiment.ts` | Resolve / receipt / run / judge |
| `packages/coding-agent/src/session/context-settings.ts` | `compaction.experiment.*` settings (default off) |
| `packages/coding-agent/src/session/session-maintenance.ts` | `#compactionSettings()` applies overlay inside the existing owner |
| `packages/coding-agent/test/session/context-strategy-experiment.test.ts` | Focused contracts |

## Remaining live evidence needs

This PR ships mechanism + docs + focused tests only. Before promoting any
treatment as a default:

1. Paired control/treatment runs on fixed tasks with the three judge metrics filled (not `unknown`)
2. Per-window fit evidence for the 200k tier (fallback rate on smaller windows)
3. Constraint-retention and recovery spot-checks after structured/handoff maintenance
4. No bundling with model / concurrency / Track E prompt changes

Until that corpus exists, leave `compaction.experiment.enabled` off in production.
