# Phase 0 Baseline Receipt — Latency Optimization Implementation

- Date: 2026-08-04
- Status: frozen control for implementation
- Repo revision: `93927e87ab6965a0d1ff60528a311c697f70adce`
- Design authority: `docs/superpowers/specs/2026-08-03-latency-optimization-plan-design.md` (A)

## 1. Input manifest verification

Peer hashes vs A Appendix A (recomputed 2026-08-04):

| Input | Manifest SHA-256 | Current SHA-256 | Match |
|---|---|---|---|
| A design | `6c2c1106…ba483d3` (canonical self-hash) | whole-file `52870ed9aeb70a1d54c6b13144d2ada9ca0185508aa992848daba5755ab674c5` | self-hash row only |
| B defaults-gaps | `7970a19125a3d3c33c79561fe583d4c6d1b78651b33c12c12927dbecd179237d` | same | YES |
| C plan review | `dc17a2976ee5f0aaa0c00cb080def13970f166b11948ba133e4c127879867eec` | same | YES |
| D plan-review pipeline | `91504fac740d8b1b37df43333fbb64f0733bb128652555f3df98323909fd900e` | same | YES |
| E proactive delegation | `5e0228fa6073aab711cac544dd549440ed0ef0570351a07ba9372ae70d517437` | same | YES |
| Collective review | `d07eeeba8319d5094c0b3b75f1a35ecf9e0f27665450f2e382daf1efa0a4bea9` | same | YES |
| long-session analysis | `0fd71c4dc5ad665b65118f0d80381ee5800360c31b72ca0800715218e3048089` | same | YES |
| dated config (A §1.4) | `1eb09e44cb35d1a2ad0dda2162c0e711d044e039e9e4c18fba9b070c756bd5f1` | **current** `996a4953b3e7c60bbb2855056030244f57d4632b48fe1a194ed391c47df14fd5` | **DRIFT** |

A peer docs (B/C/D/E/analysis/collective) match Appendix A. Config full-file hash drifted since the 2026-08-04 design receipt; §1.4 latency-control keys still match (see §2).

## 2. Effective config control baseline

Source: `/Users/sheng/.omp/agent/config.yml`  
Current full-file SHA-256: `996a4953b3e7c60bbb2855056030244f57d4632b48fe1a194ed391c47df14fd5`  
Bytes: 17120  
Captured at: 2026-08-04T06:34:08Z

### §1.4 latency-control keys (must freeze for A/B)

| Setting | Effective value | Classification | Schema default |
|---|---|---|---|
| `task.agentModelOverrides` | scout=flash:max, designer=sol:high, task=luna:max, reviewer=sol:xhigh | explicit | `{}` |
| `task.eager` | `preferred` | explicit | `default` |
| `task.batch` | `true` | explicit | `true` |
| `async.enabled` | `true` | explicit | `true` |
| `compaction.thresholdPercent` | `70` | explicit | `-1` |
| `compaction.idleEnabled` | `true` | explicit | `false` |
| `compaction.idleThresholdTokens` | `200000` | default-derived (absent) | `200000` |
| `defaultThinkingLevel` | `high` | default-derived (absent) | `high` |
| `modelOptimization.enabled` | `false` | default-derived (absent) | `false` |

### Related explicit keys (not in §1.4 table, freeze for lineage)

| Setting | Effective value | Notes |
|---|---|---|
| `task.enableEffort` | `true` | explicit |
| `task.enableLsp` | `true` | explicit |
| `task.prewalk` | `false` | explicit |
| `task.isolation` | `{mode:auto, apply:true, merge:patch}` | explicit |
| `modelRoles.plan` | `gateway/gpt-5.6-luna:max` | explicit |
| `modelRoles.default` | `gateway/grok-4.5:high` | explicit; **drifted** from B receipt `gateway/deepseek-v4-flash:max` |
| `compaction.strategy` | `snapcompact` | default-derived |
| `async.pollWaitDuration` | `smart` | default-derived |

**Control rule:** treatment arms may flip only their own owner-controlled switch. Do not rewrite `task.eager`/`batch`/`async`/`compaction`/`agentModelOverrides` inside a single-arm experiment.

## 3. Residual pool measurement

Historical active pool (analysis evidence, not current residual):

```
306.6h active = 174.3h gen + 92.0h TTFT + 40.3h tools
tools subclasses (non-additive with top-level): hub 21.3h, bash 6.2h, eval 3.7h, web_search 3.7h
```

### Already configured defenses (not residual treatment arms)

| Mechanism | Current state | Historical pool it may touch |
|---|---|---|
| `task.eager=preferred` + `task.batch=true` | ON | hub wait / serial spawn path |
| `async.enabled=true` | ON | hub wait / parent blocked interval |
| compaction 70% + idle + idleThreshold 200k | ON | TTFT high-context buckets |
| `modelRoles.default` | grok-4.5:high (was flash) | TTFT/gen; lineage must record actual model |

### Residual treatment opportunities (arms still OFF / missing)

| Residual class | Arm | Canonical owner | Status before Phase 1 |
|---|---|---|---|
| Ordinary tool-output volume | `context_optimization` (1.a) | `modelOptimization` + `tool-output-manager` + `agent-session` | seam exists, `enabled=false` |
| Repeated read full payload | `read_dedupe` (1.c) | context-ledger + read view identity | **missing** ReadViewKeyV1 / tool_result eligible dedupe |
| Identical bash failure re-run | `bash_advisory` / `bash_bounded_injection` (3) | `tools/bash.ts` + executor | **missing** BashAttemptLedgerV1 |
| Independent work critical path | `concurrency_declaration` / `concurrency_execution` (4) | task + workflow RuntimePort | batch/parallel exist; **missing** WorkflowConcurrencyDeclarationV1 lifecycle |
| Mechanical role TTFT | `role_static_split` (2) | workflow model-router + quality-route-snapshot | mechanical heuristic only on repair/xai; **missing** WorkflowMechanicalClassV1 → Flash |
| Eval parent blocked interval | `eval_gate_migration` (5) | eval bridges → workflow/task | bridges exist; **missing** EvalGateParityReceiptV1 |

**Residual accounting rule:** do not subtract historical hours as “already saved.” Residual is the set of still-off arms above; A/B reports only paired deltas on frozen control.

### Double ledger freeze

1. **Canonical interval-union:** parent + descendants half-open intervals; overlap counted once; blocked interval separate.
2. **Legacy sum:** parent/child/tool durations summed only for historical reconcilation; never add to union savings.
3. **Additive cost:** requests/tokens/USD always sum parent+subtree; unknown ≠ 0.

## 4. Independent arms (default-off) and rollback owners

| Arm ID | Control | Treatment | Gate / snapshot | Rollback |
|---|---|---|---|---|
| `context_optimization` | modelOptimization off | conservative ordinary profile on | profile/compiler hash + ToolOptimizationReceiptV1 | set `modelOptimization.enabled=false` |
| `read_dedupe` | repeated full payload | same-view ref replacement | ReadViewKeyV1 + ContextOptimizationReceiptV1 | disable read eligible transform |
| `role_static_split` | existing quality route | eligible mechanical → Flash | QualityRouteSnapshot + class evidence | restore control route snapshot |
| `bash_advisory` | no advisory | same-ledger advisory notice | BashAttemptLedgerV1 | disable advisory mode |
| `bash_bounded_injection` | advisory only | bounded context injection | same ledger + injection hash | disable injection; keep ledger |
| `concurrency_declaration` | ad hoc batch/work-packages | strict declaration validation | declaration fingerprint/state | disable declaration adapter |
| `concurrency_execution` | current task/workflow path | declaration-backed lowering | unit intervals/artifacts | disable execution lowering |
| `eval_gate_migration` | bridge path | parity-proven native + independent overlap | EvalGateParityReceiptV1 | restore bridge |

Combined experiments require a separate `combinedArmId` listing child arms. Quality stop (any arm): completion/verifier/review −>2pp, rework/dup-read +>10%, P0/P1 +>10% → rollback that arm only.

## 5. Phase 0 exit checklist

- [x] Repo revision frozen
- [x] Effective config hash frozen (current + note drift from design-dated hash)
- [x] §1.4 latency keys classified explicit vs default-derived
- [x] Residual pool defined without claiming historical savings
- [x] Independent arm IDs + rollback owners listed
- [x] Peer design hashes verified
- [ ] Per-arm flags present in schema (Phase 1+; default-off, no control leakage)
- [ ] Versioned receipt/schema types for missing arms (Phase 1+)

## 6. Implementation order (authorized)

1. Phase 1–2a: 1.a activation path + tests, 1.c ReadViewKeyV1 fail-open, 3 bash ledger, 5 parity scaffolding
2. Phase 2b: 4.a/4.b WorkflowConcurrencyDeclarationV1 → task/parallel or RuntimePort; plan_review remains single-strong + rereview + arbitration under D
3. Phase 2c–3: 2 mechanical Flash route; combined arms only as pre-registered ids

Forbidden: `task-batch.ts`, `tool-output-processor.ts`, `performance.contextVolume.truncation.*`, `fresh` param, second scheduler/engine/router.
