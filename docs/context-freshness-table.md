# Context / config freshness table (D3)

Date: 2026-09-27. Owner: capability FS cache + SessionMaintenance + rule/skill discovery.

This table is a **published visibility contract**, not a new TTL cache. The capability FS layer (`packages/coding-agent/src/capability/fs.ts`) is invalidate/clear based — silent TTL refresh is rejected (would drift prompts and break stable-prefix experiments).

## Asset → invalidate / reload → session visibility

| Asset | Write / external change | Invalidate / reload trigger | Same session request sees change? | Next `/clear` or `/new`? | Process restart? |
|---|---|---|---|---|---|
| Project / user rules | Edit tool or external editor | Re-discover on `/clear`/`/new` mid-session rebuild; capability FS invalidate when discovery dirs busted | **Partial** — mid-session prompt rebuild paths refresh rules (issue #10940); arbitrary external edit without rebuild may keep snapshot | Yes | Yes |
| Skills | Edit / install | Skills reload when `skillsReloadable`; warnings captured on discover | When reload path runs | Yes | Yes |
| Context files | Edit | SessionMaintenance / context refresh deadlines | Per existing context-file refresh | Yes | Yes |
| Managed skills (autolearn) | Autolearn write to isolated dir | Managed-skills isolation; not mixed into hand-written skills | New candidates after accept path only | Yes | Yes |
| Memory summary / learned.md | Consolidation / `learn` / import | MemoryBackend prompt hooks; local summary reread on startup completion | Summary may arrive after first prompt (startup race documented); learned.md re-read rules per memories owner | Yes | Yes |
| Settings (omp) | Settings UI / file | Settings watch / applySettings | Live settings getters | Yes | Yes |
| Capability FS content cache | Any file under cached path | `invalidate(path)` / `clearCache()` after known write owners | Only after invalidate | N/A (cache empty) | Yes (cold) |

## What this does **not** change

- No universal TTL on capability reads.
- No second SessionMaintenance owner.
- Stable-prefix and read-dedupe experiments stay opt-in and OFF by default (`docs/context-strategy-experiment.md`, `docs/delivery-read-cache-experiments.md`).
- Estimated tokens vs provider `cacheRead`/`cacheWrite` stay separate columns in receipts.

## Gaps still marked 未验证

- Exhaustive external-editor → every entrypoint matrix on every OS.
- Provider-side cache hit proof (client fingerprint equality ≠ server hit).

When a documented “immediate refresh” promise fails for a specific entrypoint, fix that owner’s invalidate chain — do not add blanket `stat` on every read.
