# Model routing for cost & latency (without lowering quality)

Status: living document. Re-run the analysis below periodically and update the numbers.

## Goal
Finish omp tasks **fast and well**: keep a top-tier model where judgement matters
(design/plan, verification, final acceptance) and move mechanical work to cheaper/faster
models (scout/search/read → fast cheap model; code execution → strong coding model).

## Findings (one user's history, last 21 days, real projects only)
Source: `~/.omp/stats.db` (`messages`, `tool_calls`), aggregated with `scripts/model-routing-report.sh`.
See the prioritized plan with quality data: `2026-10-11-omp-quality-cost-plan.md`.
No `/tmp` benchmark sessions fell in this window. Costs are as recorded by omp (`cost_total`, USD); `cost_unpriced=0` for all rows.

| agent_type | calls | sessions | model time (h) | input M | output M | cache-read M | cost $ |
|---|---:|---:|---:|---:|---:|---:|---:|
| main | 4426 | 78 | 23.8 | 24.3 | 2.24 | 609 | 747 |
| subagent | 5624 | 125 | 20.7 | 30.7 | 4.05 | 604 | 368 |
| advisor | 2568 | 52 | 5.6 | 15.7 | 0.81 | 248 | 135 |
| **total** | 12618 | | 50.1 | | | | **1250** |

By model (top): `gpt-6-astra` main 3103 calls / 19.0 h / **$670** (avg 22 s, ~160K ctx, $0.216/call);
`grok-4.7` subagent 2808 / 10.1 h / $247; `grok-4.7` advisor 1058 / $77; `grok-4.6` advisor 1510 / $58;
`deepseek-flash` subagent **1000 calls / 2.6 h / $1** (0 errors, $0.001/call).

Cost composition: cache-read **$891 (71%)**, input $255, output $104. Cost is driven by
*context size × number of turns on the expensive model*, not by output.

Tool usage on the top model: `gpt-6-astra` main ran 2139 `read`, 338 `grep`, 280 `glob` calls
(vs 811 `bash`, 406 `write`, 304 `edit`) — most of its turns are lookup work.

Reliability: stop_reason error 87, aborted 36 of 12618 calls. `grok-4.7` subagent `edit` errors 58/566 (10%);
`grok-4.6` subagent `read` errors 71/1806.

Projects: oh-my-pi $727 / 28 h (122 sessions), starrocks-diagnostics-skills $254, starrocks-aiops $109.

## Savings opportunities (estimates from history, not A/B measured)
1. **Lookups on the top model.** ~2.7K read/grep/glob calls ran in astra main turns at ~$0.22/turn. Delegating broad
   exploration to `scout` (`@smol` → deepseek-flash, ~$0.001/call) is the largest lever; even moving 20–30% of
   main astra turns would save on the order of $130–200 per 3 weeks for this user. Bounded single lookups stay inline.
2. **Context size.** Cache-read is 71% of cost; astra main averages ~160K context per call. The 60%-of-window soft-cap
   (PR #41) plus scout delegation (results summarised, not pasted) directly reduce this.
3. **Advisor overhead.** 11% of cost ($135) and 5.6 h; keep advisor on a cheaper model than main and skip when same model
   (`advisor.allowSameModel=false`, default).
4. **Execution rework.** 10% edit-error rate on the grok-4.7 executor causes retry loops; pick the executor by edit
   success, and escalate after repeated failures rather than looping.
5. **Cheap model already proven for scout.** deepseek-flash ran 1000 subagent calls with zero errors.

## Routing policy
| Phase | Model tier | Example |
|---|---|---|
| Orchestrate / design / plan | top | gpt-6-astra |
| Verify / review / final acceptance | top (never the cheap tier) | gpt-6-astra (`reviewer` uses `@slow`) |
| Execute / write code (`task`) | strong coding model | grok-4.x or equivalent |
| Scout / search / read-only exploration | fast cheap | deepseek-v4.1-flash (`scout` uses `@smol`) |
| Commit messages, titles | fast cheap | `@smol` / `commit` role |

## Mapping to existing config (no new settings)
`modelRoles` in `~/.omp/agent/config.yml` (`cfgModelRoles`, `config/model-settings.ts`). Roles: `default`, `slow`, `smol`,
`plan`, `task`, `commit`, `advisor`. Bundled agents: `scout.md` → `model: "@smol"`, `reviewer.md` → `model: "@slow"`.
Recommended example:
```yaml
modelRoles:
  default: gateway/gpt-6-astra:medium     # main / orchestrator
  slow: gateway/gpt-6-astra:high          # reviewer / verification, consult fallback
  plan: gateway/gpt-6-astra:high          # design & planning (top tier)
  task: gateway/<coding-model>:high       # execution subagents
  smol: gateway/deepseek-v4.1-flash:high  # scout / search
  commit: gateway/deepseek-v4.1-flash:high
  advisor: gateway/<cheaper-than-default>:high
```
Note: in the analysed config `plan` pointed at grok-4.6; this policy moves planning to the top tier.
Production code defaults are unchanged by this document.

## Quality guardrails
- Verification, review and the final "done" judgement never run on the cheap tier.
- Escalate to the top model on: ambiguous requirements, 2+ failed attempts of the same step, design changes, failing tests.
- Scout output is evidence (paths, lines), not decisions; the main model decides.
- Do not claim live cost/latency wins without paired evidence; history numbers are estimates.

## Metrics to track (per period, real vs bench separately)
cost by agent_type × model; cost share of cache-read; avg context per main call; read/grep/glob calls on the top model;
subagent edit-error rate; stop_reason error/aborted rate; wall time per session; user-frustration signals (`user_messages`).

## Iteration loop
1. Run `scripts/model-routing-report.sh [days]` against `~/.omp/stats.db`.
2. Compare with the table above; update this doc with the new numbers and date.
3. Adjust `modelRoles` / agent frontmatter; keep guardrails; re-measure next period.
