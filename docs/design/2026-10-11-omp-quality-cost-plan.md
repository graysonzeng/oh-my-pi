# omp quality + time/cost plan (P0/P1/P2)

Companion to `2026-10-11-model-routing-cost-latency.md`. Only numbers measured from one user's history
(last 21 days, real projects, no `/tmp` benchmark sessions in window). Reproduce with
`scripts/model-routing-report.sh` (stats.db) and `scripts/model-routing-roles.py` (session jsonl).
No paired A/B evidence exists (`paired_evidence_ready=false`); savings below are estimates, not measured wins.
Docs origin: draft PR #42 (`docs/model-routing-cost-latency`) — referenced, not merged.

## 1. Measurements

### Role split (subagent jsonl stem → `task` tool `details.progress[].agent`; all subagent cost mapped)
| role | model | calls | model h | $ | errors | avg ctx K |
|---|---|---:|---:|---:|---:|---:|
| task | grok-4.7 | 2800 | 10.0 | 247 | 13 | 148 |
| subagent-astra (user agent) | gpt-6-astra | 456 | 3.2 | 61 | 0 | 53 |
| task | grok-4.6 | 1248 | 4.5 | 54 | 13 | 103 |
| scout | deepseek-flash | 912 | 2.3 | 1 | 0 | 53 |
| sonic / flash-reviewer | deepseek(-v4)-flash | 133 | 0.4 | 0 | 0 | 73–86 |
| reviewer | grok-4.6 | 16 | 0.1 | 1 | 1 | 40 |
| reviewer | grok-4.7 | 8 | 0.0 | 0 | **8/8** | 0 |
Main: gpt-6-astra $670 / 19 h (avg ctx ~160K). Advisor: $135 / 5.6 h.

### Quality signals
- Errored/aborted calls: 123 of 12,618. Top causes: provider auth/credit exhaustion **57**
  (xai grok-4.7 23, grok-4.6 23, codex gpt-6-astra 11), user interrupt 25, Codex websocket 1006: 9,
  API-key validation 4, advisor reset 4, thinking-loop detected 3.
- Reviewer subagent was barely used (24 calls total) and **all 8 grok-4.7 reviewer runs failed before the first token** (auth).
  Verification is mostly done inline by the main model.
- Tool errors: 87 `edit` errors in main sessions (5 consecutive edit retries); 115 same-tool consecutive-error pairs;
  in stats.db, grok-4.7 subagent `edit` errors 58/566 (10%), grok-4.6 subagent `read` errors 71/1806.
- Goal/acceptance: 21 `goal-continuation`, 38 `parent_integrate_decision` events; task result payloads were not
  persisted in `details.results` (empty), so per-task pass/fail could not be measured.

## 2. Problems → root cause → fix (owners verified on `workflow`)
| # | Problem (evidence) | Root cause | Fix / owner |
|---|---|---|---|
| A | 57 auth/credit failures; 8/8 grok reviewer runs dead | single-provider role chains, no fallback when credits run out | Configure fallback chains in `modelRoles` (comma lists); `resolveRoleChain` expands each entry; `getRetryFallbackChains` derives runtime tails; route-unavailable in `src/latency/credential-route-unavailable.ts`. |
| B | Verification rarely delegated (reviewer 24 calls) | reviewer chain failing + main does it inline at 160K ctx | Reviewer stays `@slow` (`src/prompts/agents/reviewer.md`); set `slow` to astra:high with fallback; parent spawns reviewer for multi-file changes (`system-prompt.md` §Verify). |
| C | Top model doing lookups (astra main: 2139 read / 338 grep / 280 glob) | scout under-delegated | `scout.md` (`@smol`) + system/task prompts steer broad exploration; summaries not raw dumps. |
| D | Large context (160K main, 148K grok-4.7 task; 281K pre-compaction) | long sessions, pasted tool output | 60% window soft-cap kept (`DEFAULT_COMPACTION_SOFT_CAP_PERCENT=60`, `thresholdTokens=-1`); scout returns summaries. |
| E | Edit failures (10% on grok-4.7 executor, consecutive retries) | stale anchors / re-edit without re-read | `session/edit-failure-escalation.ts` + `TurnRecovery.noteEditToolOutcome` / `escalateEditFailuresToTopModel`: after 2 edit failures on a file, re-read advisory + escalate to `@slow`/`@default`. |
| F | Advisor 11% of cost, 4 advisor resets | advisor runs every turn | Keep `advisor.allowSameModel=false` and `consult.*` caps in `src/config/workflow-settings.ts`. |
| G | Task outcome not measurable | results not persisted in `details.results` | Persist `finalStatus`/`status`/`exitCode`/`agent` on `async-result` jobs (`async-job-delivery.ts`); report via `src/stats/task-outcome.ts` + `scripts/model-routing-roles.py`. |

## 3. Routing + policy
Orchestrate/design/plan/verify → gpt-6-astra:high (`default`, `slow`, `plan`); execute → grok-4.6 (`task`);
scout/search/commit → deepseek-v4.1-flash (`smol`, `commit`); advisor → cheaper than default, with fallback.
Escalate to top model on: ambiguity, 2+ failed edits on the same file, failing tests, design change. Verification never on `smol`.

## 4. Phased rollout
**P0 (config + reliability)**
- A: per-role fallback models in `modelRoles` (comma lists) + chain expansion in resolver/retry. *Accept:* auth/credit errors <10 per 21 days; 0 reviewer runs dying pre-first-token.
- B: reviewer on astra:high with fallback via `@slow`, spawned for multi-file changes. *Accept:* reviewer calls ≥ 1 per change-making session; reviewer error rate <5%.
- `plan` role → top model @ high. *Accept:* recommended config shows it; no rise in correction-like messages.

**P1 (cost/time)**
- C: scout delegation + summary-only returns. *Accept:* read+grep+glob on top-model main −30% vs baseline 2757; scout error rate stays 0–1%.
- D: context control (soft-cap 60% intact). *Accept:* avg main ctx <120K (baseline 160K); cache-read share <60% (baseline 71%).
- F: advisor caps unchanged (defaults). *Accept:* advisor cost share <7% (baseline 11%).

**P2 (measurement + execution quality)**
- E: edit-failure escalation after 2 fails on same file. *Accept:* subagent edit error rate <5% (baseline 10%).
- G: persist task outcomes; report per-role success rate. *Accept:* report prints per-role success rate.
- Guardrail: correction-like messages / error rate beyond baseline → revert the offending item.

## 5. Guardrail metrics (report every period; real vs bench separately)
cost by role×model; cache-read share; avg main ctx; top-model lookup calls; edit error rate; errored/aborted calls by cause;
reviewer invocation + pass/fail; correction-like user messages; compactions per session; **per-role task success rate**.
Any rollout item that raises correction-like messages or error rate beyond baseline is reverted.

## 6. Iteration loop
Every 2–3 weeks: run both scripts, update tables here, re-rank P-items, adjust `modelRoles` / agent frontmatter.

## 7. Implementation record (this branch)

| Item | Status | Notes |
|---|---|---|
| P0-A comma fallbacks in modelRoles → resolveRoleChain + derived retry chains | **done** | `model-resolver.ts`, `retry-fallback-chains.ts`; example config shipped |
| P0-B reviewer `@slow` + multi-file spawn guidance | **done** | `reviewer.md` already `@slow`; `system-prompt.md` / `task.md` updated |
| P0 plan → top @ high | **done** | recommended example + docs; no personal `~/.omp` writes |
| P0 gpt-6-astra:high for top roles | **done** | via existing `:high` thinking suffix in modelRoles examples |
| P0 task = grok-4.6 | **done** | recommended example; smol priority head → deepseek-v4.1-flash |
| P1-C scout delegation + summaries | **done** | system/scout/task prompts |
| P1-D soft-cap 60% | **done** (verified intact) | `DEFAULT_COMPACTION_SOFT_CAP_PERCENT=60`, `thresholdTokens=-1` |
| P1-F advisor/consult caps | **done** (verified intact) | `advisor.allowSameModel=false`, consult limits unchanged |
| P2-E edit failure → re-read + top model | **done** | `edit-failure-escalation.ts` + `TurnRecovery` |
| P2-G persist finalStatus + success rate | **done** | `async-job-delivery.ts`, `src/stats/task-outcome.ts`, roles script |
| Paid A/B / experiment master switches / claimedLiveWin | **deferred** | out of scope; `paired_evidence_ready=false` |

Example config: `packages/coding-agent/examples/config/model-roles-quality-cost.example.yml`.
