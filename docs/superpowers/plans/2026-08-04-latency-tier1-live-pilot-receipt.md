# Latency Tier-1 Live Pilot Receipt

- Date: 2026-08-04
- Repo revision: `c36dd14cbf76482806bb127679d7297e70e6c98a`
- Pilot id: `latency-tier1-pilot-v2-profile-aware`
- Combined arm: `tier1_context_read_bash_advisory`
- Child arms: `context_optimization`, `read_dedupe`, `bash_advisory`
- Model: `gateway/gpt-5.6-luna`
- Host artifacts: `/tmp/omp-latency-pilot/pairs_v2/`

## 1. Protocol

| Rule | Implementation |
|---|---|
| Same-task pairing | Identical fixture + prompt for control/treatment |
| Clean-context lineage | Fresh cwd copy + `--no-session` each run |
| Randomized order | Per-pair coin flip (`seed=20260804`) |
| Non-overlap | Sequential on one host; no parallel control/treatment |
| Quality gate | Exact `artifacts/answer.json` bytes match |
| Control freeze | All latency arms false; no modelOptimization profile |
| Treatment | `modelOptimization.enabled=true` + explicit `luna-pilot` profile + `readDedupe=true` + `bashAdvisory=true` |

Design target remains **≥30 comparable pairs / arm** before formal savings claims (A §6). This receipt is a **pilot**, not a formal rollout gate.

## 2. Why v2 (corrected) vs v1

v1 used `gateway/gpt-5.6-luna` with only `modelOptimization.enabled=true` and **no matching built-in profile** (`default-profiles` covers claude/gpt-5/grok/glm/deepseek, not luna).  
Result: treatment often had **no active optimization profile**, so v1 deltas are **not** valid evidence for arm efficacy.

v2 injects an explicit high-priority profile:

```yaml
modelOptimization:
  enabled: true
  profiles:
    luna-pilot:
      id: luna-pilot
      modelPattern: ["gpt-5.6-luna", "gateway/gpt-5.6-luna", "*luna*"]
      priority: 100
      toolStrategy.outputTruncation: head, read maxBytes=1200
latency.arms.readDedupe: true
latency.arms.bashAdvisory: true
```

Fixture: four ~28KB TS modules + git identity; task forces 6 full-file reads (including 2 repeats), two `false` bash failures, one success, exact JSON write.

## 3. Results (v2, n=6 comparable pairs)

All 6/6 pairs quality-pass on both sides. Pass-rate drop = **0.0pp** (quality stop not triggered).

| Metric | Median treatment improve vs control | Wins (treatment better) |
|---|---:|---:|
| Wall clock | **+29.2%** | 6/6 |
| Sum assistant duration | **+29.3%** | 6/6 |
| Total tokens | **+50.8%** | 6/6 |
| Input tokens | **+63.6%** | 6/6 |
| Cost USD | **+55.0%** | 6/6 |
| Tool-result visible chars | **+95.6%** | 6/6 |

Per-pair wall improve%: `22.1, 42.4, 29.9, 21.7, 32.6, 28.5`  
Per-pair token improve%: `50.8, 49.5, 54.7, 50.8, 53.7, 50.8`

Observed read payload sizes (sample):

- control: ~28.5–28.7KB per read × 6
- treatment: **1227 bytes** per read × 6 (truncation active)

## 4. Arm-level attribution

| Arm | Evidence in pilot | Verdict |
|---|---|---|
| `context_optimization` (1.a) | Stable ~95.6% tool-char cut; ~50% token cut; ~29% wall cut; requires explicit profile for luna | **Working under treatment profile** |
| `read_dedupe` (1.c) | `context ref` hits = **0/6**; second full-file reads still emit truncated bodies, not artifact refs | **Not observed live** |
| `bash_advisory` (3) | advisory hits = **0/6**; second `false` shows no ledger notice | **Not observed live** |

### 4.1 read_dedupe residual

- Sessioned probe saved full `*.read.log` artifacts, so artifact persistence works.
- Model-visible second read still not replaced with `[context ref: artifact://… sha256:…]`.
- JSONL tool details in print mode often expose only `displayContent`/`meta` (identity fields not visible in stream). Internal eligibility may still fail-open if identity production is incomplete on the after-tool-call path used in print mode.
- Residual: needs a focused live probe that asserts internal `ReadViewKey` eligibility + after-tool-call rewrite, not only outer JSONL.

### 4.2 bash_advisory residual (reproduced unit check)

Failure fingerprint includes normalized stdout excerpt. Current bash renderer embeds variable wall-clock text:

```
Wall time: 0.03 seconds
Wall time: 0.00 seconds
```

`normalizeBashFailureExcerpt` does **not** strip short decimals / "Wall time" lines.  
Unit check on this checkout:

- fingerprint(`Wall time: 0.03…`) ≠ fingerprint(`Wall time: 0.00…`)

So two identical `false` commands often **do not** classify as repeated failure → advisory never fires.  
This is a real logic gap for arm 3 under current bash result formatting.

## 5. Quality / cost stops

| Stop rule (design A §6.5) | Pilot observation |
|---|---|
| Completion drop >2pp | 0.0pp — OK |
| Rework / dup-read rise >10% | Not instrumented as verifier rework; task success stable |
| P0/P1 rise >10% | No failures |
| Cost p50 multiple >1.5× | Treatment cost **lower** (~0.45×) — OK |
| Latency improve <10% | Median wall **29%** — meets pilot interest threshold |

No quality-stop rollback triggered for the combined arm.

## 6. Decision

### Ship / enable now?

| Scope | Decision |
|---|---|
| Default-on for all users | **No** |
| Formal ≥30-pair claim | **No** (only 6 pairs; combined arm, not single-arm) |
| Controlled enable of **context truncation for models with a profile** | **Promising** — strongest live signal |
| Enable `readDedupe` by default | **No** — not observed live |
| Enable `bashAdvisory` by default | **No** — fingerprint collision with wall-time text |

### Recommended next actions

1. **Fix bash failure fingerprint noise**: strip `Wall time: …` / duration lines (or fingerprint terminal+exit only for simple failures) so advisory can fire.
2. **Fix or prove read dedupe live path**: ensure identity fields survive into `#dedupeOrdinaryReadResult` in print/no-session runs; add one live assertion test for second-read `context ref`.
3. **Add built-in profile coverage** for production default models in use (`gpt-5.6-luna`, `grok-4.5`, gateway ids) or document that `modelOptimization.enabled` alone is a no-op without a match.
4. Expand to **≥30 pairs**, and split single-arm ablations (`context_optimization` alone first) before combined-arm rollout.
5. Keep timeouts (`task.maxRuntimeMs`, `task.queuedStartupTimeoutMs`) as default safety rails (out of band for this latency A/B).

## 7. Rollback

```yaml
modelOptimization.enabled: false
latency.arms.readDedupe: false
latency.arms.bashAdvisory: false
# remove any temporary luna-pilot profile overlay
```

Do not touch `task.eager` / `batch` / `async` / compaction when rolling back this pilot treatment.

## 8. Artifact index

- Runner: `/tmp/omp-latency-pilot/run_pair_v2.py`
- Control config: `/tmp/omp-latency-pilot/control-tier1b.yml`
- Treatment config: `/tmp/omp-latency-pilot/treatment-tier1b.yml`
- Per-run JSONL + aggregate: `/tmp/omp-latency-pilot/pairs_v2/`
- Aggregate report JSON: `/tmp/omp-latency-pilot/pairs_v2/pilot_report.json`
- Uncorrected v1 report (invalid for arm efficacy): `/tmp/omp-latency-pilot/pairs/pilot_report.json`
