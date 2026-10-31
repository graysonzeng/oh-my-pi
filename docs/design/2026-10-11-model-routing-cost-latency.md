# Model routing for cost & latency (without lowering quality)

Status: living document. Re-run the analysis below periodically and update the numbers.
Companion prioritized plan: `2026-10-11-omp-quality-cost-plan.md`.

## Goal
Finish omp tasks **fast and well**: keep a top-tier model where judgement matters
(design/plan, verification, final acceptance) and move mechanical work to cheaper/faster
models (scout/search/read → fast cheap model; code execution → strong coding model).

## Findings (one user's history, last 21 days, real projects only)
Source: `~/.omp/stats.db` (`messages`, `tool_calls`), aggregated with `scripts/model-routing-report.sh`.
No `/tmp` benchmark sessions fell in this window. Costs are as recorded by omp (`cost_total`, USD); `cost_unpriced=0` for all rows.
`paired_evidence_ready=false` — savings below are estimates from history, not A/B measured wins. Do not claim live cost/latency wins without paired evidence.

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

## Routing policy
| Phase | Model tier | Example |
|---|---|---|
| Orchestrate / design / plan | top @ high | gpt-6-astra:high (`default`, `plan`) |
| Verify / review / final acceptance | top @ high (never cheap) | gpt-6-astra:high (`reviewer` → `@slow`) |
| Execute / write code (`task`) | strong coding model | grok-4.6 |
| Scout / search / read-only exploration | fast cheap | deepseek-v4.1-flash (`scout` → `@smol`) |
| Commit messages, titles | fast cheap | `@smol` / `commit` role |

## Mapping to existing config (no personal machine config)
`modelRoles` in `~/.omp/agent/config.yml` (`cfgModelRoles`, `config/model-settings.ts`). Roles: `default`, `slow`, `smol`,
`plan`, `task`, `commit`, `advisor`. Bundled agents: `scout.md` → `model: "@smol"`, `reviewer.md` → `model: "@slow"`.
Recommended example (also at `packages/coding-agent/examples/config/model-roles-quality-cost.example.yml`):
```yaml
modelRoles:
  default: gateway/gpt-6-astra:high, openai-codex/gpt-5.6-sol
  slow: gateway/gpt-6-astra:high, openai-codex/gpt-5.6-sol
  plan: gateway/gpt-6-astra:high, openai-codex/gpt-5.6-sol
  task: gateway/grok-4.6:high, gateway/grok-4.5:high
  smol: gateway/deepseek-v4.1-flash:high, gateway/deepseek-v4-flash:max
  commit: gateway/deepseek-v4.1-flash:high, gateway/deepseek-v4-flash:max
  advisor: gateway/grok-4.6:high, gateway/deepseek-v4.1-flash:high
```
Comma lists are ordered credential/auth fallbacks (expanded by `resolveRoleChain` and derived into
`retry.fallbackChains` when that role has no explicit chain). Production code defaults remain in
`priority.json` / settings registers; this document does not flip experiment master switches.

## Quality guardrails
- Verification, review and the final "done" judgement never run on the cheap tier.
- Escalate to the top model on: ambiguous requirements, 2+ failed edit attempts on the same file, design changes, failing tests.
- Scout output is evidence (paths, lines) and summaries, not decisions or raw dumps; the main model decides.
- Do not claim live cost/latency wins without paired evidence (`paired_evidence_ready=false`); history numbers are estimates.
- Rollback any rollout item that raises correction-like messages or error rate beyond baseline (see plan guardrail metrics).

## Metrics to track (per period, real vs bench separately)
cost by agent_type × model; cost share of cache-read; avg context per main call; read/grep/glob calls on the top model;
subagent edit-error rate; stop_reason error/aborted rate; wall time per session; user-frustration signals (`user_messages`);
per-role task success rate from persisted `finalStatus` / `progress.status` / `async-result` jobs.

## Iteration loop
1. Run `scripts/model-routing-report.sh [days]` against `~/.omp/stats.db`.
2. Run `scripts/model-routing-roles.py [days]` for role split + success rate.
3. Compare with the tables; update this doc with the new numbers and date.
4. Adjust `modelRoles` / agent frontmatter; keep guardrails; re-measure next period.
