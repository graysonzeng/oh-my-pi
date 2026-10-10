# omp quality + time/cost plan (P0/P1/P2)

Companion to `2026-10-11-model-routing-cost-latency.md`. Only numbers measured from one user's history
(last 21 days, real projects, no `/tmp` benchmark sessions in window). Reproduce with
`scripts/model-routing-report.sh` (stats.db) and `scripts/model-routing-roles.py` (session jsonl).
No paired A/B evidence exists (`paired_evidence_ready=false`); savings below are estimates, not measured wins.

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
- User feedback: 384 user messages; stats.db profanity/anguish/negation/blame counters all 0, yelling 1;
  `frustration_verdicts` empty. Correction-like messages (不对/重来/回滚/revert/错了/wrong/undo): 9
  (astra 2, grok-4.7 2, grok-4.6 1, unknown 4) — too few to rank models.
- Goal/acceptance: 21 `goal-continuation`, 38 `parent_integrate_decision` events; task result payloads were not
  persisted in `details.results` (empty), so per-task pass/fail could not be measured.

### Compaction and context
39 compactions (all `snapcompact`), avg 281K → 49K tokens. Main astra context ~160K/call; cache-read is 71% of cost.
Post-compaction rework could not be attributed reliably (no explicit lost-constraint marker).

### Wall clock
122 main sessions, 1646 h wall span but 1547 h are gaps >5 min (sessions left open / waiting on user),
so ~99 h active vs 50 h model time. Median session span 143 min. Latency is model time + tool time,
not idle; idle is user-side.

### Quality vs model/role (what we can and can't say)
- Cheap scout (deepseek-flash) ran 912 calls with 0 errors at $0.001/call → safe for read-only discovery.
- Execution on grok-4.7: 10% edit error rate, higher avg context (148K) than grok-4.6 (103K).
- No measured quality signal distinguishes astra vs grok for verification; therefore keep verification on the top model by policy.

## 2. Problems → root cause → fix (owners verified on `workflow`)
| # | Problem (evidence) | Root cause | Fix / owner |
|---|---|---|---|
| A | 57 auth/credit failures; 8/8 grok reviewer runs dead | single-provider role chains, no fallback when credits run out | Configure fallback chains in `modelRoles` (comma lists already supported, e.g. `smol`); route-unavailable handling in `src/latency/credential-route-unavailable.ts`, model chain in `src/config/model-resolver.ts`. Workflow tip `097749a8` already drops auth-failed subagents — verify it surfaces to parent. |
| B | Verification rarely delegated (reviewer 24 calls) | reviewer chain failing + main does it inline at 160K ctx | Reviewer stays `@slow` (`src/prompts/agents/reviewer.md`); set `slow` to astra with a fallback; parent spawns reviewer for non-trivial changes. |
| C | Top model doing lookups (astra main: 2139 read / 338 grep / 280 glob) | scout under-delegated | `scout.md` (`@smol`) guidance; delegate broad discovery; keep bounded lookups inline. |
| D | Large context (160K main, 148K grok-4.7 task; 281K pre-compaction) | long sessions, pasted tool output | 60% window soft-cap (PR #41); scout returns summaries; task contexts scoped. |
| E | Edit failures (10% on grok-4.7 executor, consecutive retries) | stale anchors / re-edit without re-read | Turn recovery in `src/session/turn-recovery.ts`; policy: after 2 edit failures on a file, re-read then escalate to top model. |
| F | Advisor 11% of cost, 4 advisor resets | advisor runs every turn | `advisor.allowSameModel` (default off) and `consult.*` caps in `src/config/workflow-settings.ts`; advisor role cheaper than `default`. |
| G | Task outcome not measurable | results not persisted in `details.results` | Persist final status per task in session jsonl (stats owner `src/stats/`). |

## 3. Routing + policy
Orchestrate/design/plan/verify → gpt-6-astra (`default`, `slow`, `plan`); execute → strong coding model (`task`);
scout/search/commit → deepseek-v4.1-flash (`smol`, `commit`); advisor → cheaper than default, with fallback.
Escalate to top model on: ambiguity, 2+ failed attempts of a step, failing tests, design change. Verification never on `smol`.

## 4. Phased rollout
**P0 (config + reliability, no code default change)**
- A: add fallback models to every role in user config. *Accept:* auth/credit errors <10 per 21 days; 0 reviewer runs dying pre-first-token.
- B: reviewer on astra with fallback, spawned for multi-file changes. *Accept:* reviewer calls ≥ 1 per change-making session; reviewer error rate <5%.
- `plan` role → astra. *Accept:* config shows it; no rise in correction-like messages.

**P1 (cost/time)**
- C: scout delegation. *Accept:* read+grep+glob on top-model main −30% vs baseline 2757; scout error rate stays 0–1%.
- D: context control (soft-cap 60%). *Accept:* avg main ctx <120K (baseline 160K); cache-read share <60% (baseline 71%).
- F: advisor caps. *Accept:* advisor cost share <7% (baseline 11%).
- Expected order of magnitude: C ≈ $130–200 / 3 weeks, D proportional to ctx reduction on $891 cache-read, F ≈ $50 (estimates).

**P2 (measurement + execution quality)**
- E: edit-failure escalation. *Accept:* subagent edit error rate <5% (baseline 10%).
- G: persist task outcomes; extend report with pass/fail. *Accept:* report prints per-role success rate.
- Use `frustration_verdicts` (currently empty) or correction regex as a guardrail metric.

## 5. Guardrail metrics (report every period; real vs bench separately)
cost by role×model; cache-read share; avg main ctx; top-model lookup calls; edit error rate; errored/aborted calls by cause;
reviewer invocation + pass/fail; correction-like user messages; compactions per session. Any rollout item that raises
correction-like messages or error rate beyond baseline is reverted.

## 6. Iteration loop
Every 2–3 weeks: run both scripts, update tables here, re-rank P-items, adjust `modelRoles` / agent frontmatter.
