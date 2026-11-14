# Context / config freshness table (D3)

Date: 2026-09-27. Owner: **session-tools capability reset / prompt rebuild** (primary visibility owner). Capability FS invalidate + SessionMaintenance are dependencies, not the mid-session visibility owner.

This table is a **published visibility contract**, not a new TTL cache. The capability FS layer (`packages/coding-agent/src/capability/fs.ts`) is invalidate/clear based — silent TTL refresh is rejected (would drift prompts and break stable-prefix experiments). Live rule/skill visibility after `/clear`/`/new` is owned by session-tools rebuild + sdk rediscover (`sdk.ts` bucketRules / rediscover paths).

## Asset → invalidate / reload → session visibility

| Asset | Write / external change | Invalidate / reload trigger | Same session request sees change? | Next `/clear` or `/new`? | Process restart? |
|---|---|---|---|---|---|
| Project / user rules | Edit tool or external editor | Re-discover on `/clear`/`/new` mid-session rebuild; capability FS invalidate when discovery dirs busted | **Partial** — mid-session prompt rebuild paths refresh rules (issue #10940); arbitrary external edit without rebuild may keep snapshot | Yes | Yes |
| Skills (authored) | Edit / install | Skills reload when `skillsReloadable`; warnings captured on discover | When reload path runs | Yes | Yes |
| Context files | Edit | SessionMaintenance / context refresh deadlines | Per existing context-file refresh | Yes | Yes |
| Managed skills (autolearn) | `manage_skill` write (approval=`write`) or `learn` skill payload | `manage_skill` calls `refreshSkills` after successful create/update/delete; **`learn` does not refresh** (discovered on a later skill refresh / session) | **After `manage_skill` + refreshSkills: yes** in the writing session. **After `learn`: no** until an explicit skill refresh / `/clear`/`/new` / restart. Not accept-gated — writes go to the isolated managed-skills dir under write approval; authored skills still win on same name | Yes | Yes |
| Memory summary / learned.md | Consolidation / `learn` / import | MemoryBackend prompt hooks; local summary reread on startup completion | Summary may arrive after first prompt (startup race documented); learned.md re-read rules per memories owner | Yes | Yes |
| Settings (omp) | Settings UI / file | Settings watch / applySettings | Live settings getters | Yes | Yes |
| Capability FS content cache | Any file under cached path | `invalidate(path)` / `clearCache()` after known write owners | Only after invalidate | N/A (cache empty) | Yes (cold) |

## Visibility matrix (edit / external / refresh / clear / new / restart)

| Trigger | Rules | Authored skills | Managed skills | Context files | Memory summary |
|---|---|---|---|---|---|
| In-session edit tool write | Rebuild paths / known invalidate | Reload when reloadable | Via `manage_skill`→`refreshSkills` only | SessionMaintenance deadlines | Backend hooks |
| External editor (no invalidate) | May keep snapshot until rebuild | May keep snapshot | May keep snapshot until refresh | May keep until refresh deadline | May keep until reread |
| Explicit refresh / reload-plugins | Re-discover | Re-discover | Re-discover | Refresh | Backend-dependent |
| `/clear` or `/new` | Yes (mid-session rediscover) | Yes | Yes | Yes | Prompt rebuild |
| Process restart | Yes (cold) | Yes | Yes | Yes | Yes (startup race noted) |

## Recommended action (existing exits only)

Diagnosis surfaces (`/context`, and backend `/memory diagnose` where present) may project a **recommended session action**. This is advisory text only — no second SessionMaintenance owner and no TTL scheduler.

| Recommended action | Reason (when shown) | Impact if taken | Impact if ignored |
|---|---|---|---|
| Continue | Same goal; evidence still valid; context budget usable | Stay on current turn / prefix | N/A |
| Compact | Goal unchanged; history heavy; constraints still needed | Run existing compaction owner; keep unfinished acceptance + recent edits | Risk of context pressure / worse retrieval |
| New session | Independent goal or polluted context; handoff available | Fresh snapshot; carry only declared items | Continue with noisy / stale context |
| Delegate | Clear isolation boundary; integrate owner known | Child work with delivery evidence; parent keeps acceptance | Parent keeps all work in one context |
| Branch / rewind | Explicit wrong path; recoverable checkpoint exists | Dialog branch ≠ file rollback; user must choose | Keep digging in a bad path |

`/context` appends this projection plus rule-source diagnosis (winner / shadowed / disabled) and optional limiter attribution when occupancy is observable. New session, rewind, and expanded delegate scope are **never auto-executed** by the diagnosis view.

## What this does **not** change

- No universal TTL on capability reads.
- No second SessionMaintenance owner.
- Stable-prefix and read-dedupe experiments stay opt-in and OFF by default (`docs/context-strategy-experiment.md`, `docs/delivery-read-cache-experiments.md`).
- Estimated tokens vs provider `cacheRead`/`cacheWrite` stay separate columns in receipts.
- Managed skills are **not** accept-gated: `manage_skill` mutates under write approval and refreshes; `learn` may mint a managed skill without refreshing the active skill list.

## Gaps still marked 未验证

- Exhaustive external-editor → every entrypoint matrix on every OS.
- Provider-side cache hit proof (client fingerprint equality ≠ server hit).
- Live paired A/B for context strategy (`paired_evidence_ready` remains false).

When a documented “immediate refresh” promise fails for a specific entrypoint, fix that owner’s invalidate chain — do not add blanket `stat` on every read.
