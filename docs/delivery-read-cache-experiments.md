# Delivery-first Package 4 — read dedupe & stable-prefix cache experiments

Two **separate** opt-in experiment surfaces. Do **not** attribute their
results together. Default production behavior is unchanged; enabling an entry
does **not** auto-run paid traffic.

Aligns with `docs/research/2026-09-09-subagent-harness-next-optimizations.md`
(P1 evidence read + real request cache) and the 2026-09-26 delivery-first plan.

## Shared bar

1. Fixed task set, code snapshot, model/effort, tools, scorer
2. **One** primary factor per paired run (and one experiment surface)
3. Success / first-pass / rework / wall / cost reported together when claiming
4. Failures retained; unknown stays unknown
5. `claimedLiveWin` on harness receipts is always `false` in this scaffolding;
   live wins require a separate paired-receipt surface — never set true here

Do **not**: globally lower all output caps; add forced “don’t re-read” prompt
rules; reopen Track C; change permissions / instruction priority / tool
capability; flip P2 model/effort/concurrency defaults.

**Enablement note (Batch 2):** settings keys below remain **opt-in** (defaults
off). Wired consumers:

- Experiment A → controlled selection layer over ordinary
  `latency.arms.readDedupe` (`selectReadDedupeReuse` in AgentSession); no
  second cache table.
- Experiment B → `prepareWorkflowInvocation` observes (and optionally
  reorders) at the prompt-assembly boundary via
  `observeStablePrefixAtAssembly`. Fingerprints only by default; no auto
  warmup / paid traffic. `claimedLiveWin` stays false.

Enabling **both** A and B in one session fails closed (`multi_factor_rejected`).
Paired live evidence is still insufficient — do not treat mechanism receipts
as cost wins.

**Naming note:** ordinary-session `latency.arms.readDedupe` (default on under
`modelOptimization`) is a **separate** production arm from Experiment A
(`deliveryExperiment.readDedupe`). Ordinary arm owns the artifact map +
rewrite; Experiment A only gates selection. Do not attribute them together.

---

## Experiment A — less duplicate transfer, keep full recovery

| Item | Contract |
|---|---|
| Owner | `packages/coding-agent/src/latency/read-dedupe-experiment.ts` + `ReadViewKeyV1` |
| Gate | `deliveryExperiment.readDedupe.enabled` — **default `false`** |
| Factor | `same_version_view_reuse` (or `none`) |
| Reuse rule | Same version **and** same view only (`ReadViewKey` eligible + equal) |
| Recovery | Large/truncated content keeps a clear recovery entry; count extra tool calls |
| Forbidden | Global output-cap lowers; forced “don’t re-read” prompts |

### Control

```yaml
deliveryExperiment:
  readDedupe:
    enabled: false
```

### Treatment

```yaml
deliveryExperiment:
  readDedupe:
    enabled: true
    factor: same_version_view_reuse
```

### Programmatic

```ts
import {
  decideReadViewReuse,
  resolveReadDedupeExperiment,
  countTruncationRecoveryToolCalls,
  truncationRecoveryNotIncreased,
} from "@oh-my-pi/pi-coding-agent/..."; // or relative latency import in tests
```

Acceptance for mechanism tests: opt-in behavior; defaults unchanged; recovery
round-trips not increased in fixtures.

---

## Experiment B — stable prefixes vs cache hits

| Item | Contract |
|---|---|
| Owner | `packages/coding-agent/src/latency/stable-prefix-cache-experiment.ts` |
| Gate | `deliveryExperiment.stablePrefixCache.enabled` — **default `false`** |
| Factors | `inspect_provider_prefix` \| `reorder_static_prefix` (one at a time) |
| Inspect | What the provider actually receives (segment order), not vibe-tuned prompts |
| Metrics | `cacheRead` / `ttftMs` / `costTotal` when present; scope `same_child_session` vs `sibling` |
| Forbidden | Changing permissions, instruction priority, or tool sets |

### Control

```yaml
deliveryExperiment:
  stablePrefixCache:
    enabled: false
```

### Treatment (inspect only — no assembly change)

```yaml
deliveryExperiment:
  stablePrefixCache:
    enabled: true
    factor: inspect_provider_prefix
```

### Treatment (opt-in reorder)

```yaml
deliveryExperiment:
  stablePrefixCache:
    enabled: true
    factor: reorder_static_prefix
```

Paid live-net pairs need **separate authorization**. Implementing this entry
must not schedule provider traffic by itself.

---

## Attribution

Run A and B as distinct paired studies. A report that mixes both factors in one
delta is invalid for merge decisions. Resolvers reject concurrent enablement
(`multi_factor_rejected`) so a single session cannot apply both treatments.
