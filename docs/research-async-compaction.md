# Research: Async / Sidecar Compaction in omp

Date: 2026-08-02  
Scope: can omp compact in a separate thread while the main agent continues?  
Primary sources: `docs/compaction.md`, `packages/coding-agent/src/session/session-maintenance.ts`, `packages/agent/src/compaction/openai.ts`, `packages/agent/src/compaction/compaction-v2-streaming.ts`, `packages/coding-agent/src/session/compact-modes.ts`, `packages/coding-agent/examples/hooks/custom-compaction.ts`, `packages/catalog/src/discovery/codex.ts`.

## Short answer

**No.** omp does **not** support a sidecar/background compaction thread that runs in parallel with the main agent on the same session.

Compaction rewrites the active session history (`CompactionEntry` + message rebuild). While it runs, the session is `isCompacting`; new user input is queued, not executed against the live agent loop. That is intentional consistency, not a missing spinner.

What exists instead:

1. Faster local strategies (`snapcompact`, `shake`)
2. Provider-native / self-hosted **remote summarization** (still blocking for the session)
3. Idle pre-compaction when the agent is already idle
4. Hooks/extensions that replace the summarizer, still on the compact critical path

## Why a parallel compact thread is hard

From `docs/compaction.md` and `session-maintenance.ts`:

- Compaction appends a `CompactionEntry` with `firstKeptEntryId`, then rebuilds agent messages from that boundary.
- Manual compact aborts the current agent op first (`disconnectFromAgent` + abort with `preserveCompaction: true`).
- `isCompacting` is true whenever either the manual or auto abort controller is installed.
- Mid-turn / pre-prompt / overflow / incomplete recovery all need a coherent post-rewrite history before the next provider request.
- Input typed during compact goes to `compactionQueuedMessages`, drained only after compact finishes.

A true async compact that “doesn’t affect the main agent” would require one of:

- **Speculative compact against a frozen snapshot**, then a merge/rebase when the main turn ends (conflict if tools mutated history mid-run)
- **Forked session / handoff** (already exists as `compaction.strategy: "handoff"` — but that is a new session, not background work on the same one)
- **On-wire only compression** (does not rewrite durable session history; omp already defends against this hiding real growth via local token floor)

None of those exist as a background compact worker today.

## What omp already has (usable now)

### 1. Strategies (default is already the fast local path)

| Strategy | Blocking? | LLM call? | Notes |
|---|---|---|---|
| `snapcompact` (**default**) | Yes, but local | No | Archives history as dense vision frames; usually much faster than summarizer LLM |
| `context-full` | Yes | Yes | Local or remote summarizer |
| `shake` | Yes, local | No | Drops heavy tool results / large blocks |
| `handoff` | Yes | Yes | New session with handoff doc |
| `off` | — | — | Disables auto maintenance |

Source: `settings-schema.ts` (`compaction.strategy` default `"snapcompact"`), `docs/compaction.md`.

If you are stuck on slow auto-compact near 80%, first check you are not on `context-full`/remote summarizer for a vision model that could use snapcompact.

### 2. Remote compaction (not “async”, but can be faster / better quality)

Three flavors in `packages/agent/src/compaction/openai.ts`:

1. **OpenAI / Codex native V2 streaming** — `compaction_trigger` on Responses stream; stores `preserveData.openaiRemoteCompaction`
2. **OpenAI native V1** — `/responses/compact`
3. **Generic remote endpoint** — `compaction.remoteEndpoint`
   - custom omp shape: `{ systemPrompt, prompt }` → `{ summary, shortSummary? }`
   - OpenAI-compatible `/chat/completions` also accepted (llama.cpp / vLLM)

Settings:

- `compaction.remoteEnabled` (default `true`)
- `compaction.remoteStreamingV2Enabled` (default `true`)
- `compaction.remoteEndpoint` (optional self-hosted summarizer)
- Manual: `/compact remote`

Codex GPT-5.6 family ships with provider remote compaction enabled (`packages/catalog/src/discovery/codex.ts`: `v2StreamingEnabled: true`). That still **blocks the session** while the provider compact request runs (timeout ceiling 180s).

### 3. Idle compaction (closest thing to “do it when not busy”)

- `compaction.idleEnabled` default `false`
- `compaction.idleThresholdTokens` default `200000`
- `compaction.idleTimeoutSeconds` default `300`
- `runIdleCompaction()` only runs when **not streaming and not already compacting**

This is preemptive maintenance during idle, not a parallel worker during a live turn.

### 4. Trigger surfaces (all session-blocking)

From `docs/compaction.md`:

1. Manual `/compact [soft|remote|snapcompact] [focus]`
2. Overflow recovery
3. Incomplete-output recovery (`stopReason === "length"`)
4. Post-turn threshold
5. Mid-turn threshold (`compaction.midTurnEnabled`, default true)
6. Idle maintenance

Default threshold: `floor(contextWindow * 0.55)` (schema default `compaction.thresholdPercent` = `55`; `-1` restores the legacy reserve-based ~80–85% behavior).

### 5. Extension / hook escape hatches

- `session_before_compact` can cancel or supply a full custom `CompactionResult`
- `session.compacting` can override prompt / inject context / preserveData
- Example: `packages/coding-agent/examples/hooks/custom-compaction.ts` — use a cheaper/faster model (e.g. Gemini Flash) for the summary

Still synchronous w.r.t. the session: the main agent does not continue tools/LLM turns until the hook returns and the entry is installed.

There is **no marketplace “async compact plugin”** in-tree that forks a background thread for the live session. Plugin surface can replace summarization, not the ownership model.

## Practical recommendations for gpt-5.6-sol long sessions

1. **Prefer snapcompact if the active model is vision-capable**  
   gpt-5.6-sol catalog entries include `"image"` in `input` for several providers, so snapcompact is eligible. Default strategy is already snapcompact — confirm settings were not overridden to `context-full`.

2. **If remote/native compact is the slow path**  
   - Keep `remoteEnabled` only when you want provider-native preserve history  
   - Or force local: `/compact soft` / `compaction.remoteEnabled: false`  
   - Or point `compaction.remoteEndpoint` at a **fast small summarizer** (self-hosted)

3. **Enable idle pre-compaction** so the 80% hit happens less often mid-task:
   ```yaml
   compaction:
     idleEnabled: true
     idleThresholdTokens: 150000   # tune below your pain threshold
     idleTimeoutSeconds: 120
   ```

4. **Use shake earlier** for tool-output bloat without a full summary:
   - strategy `shake`, or manual `/shake` when heavy tool results dominate

5. **Raise threshold slightly** only if you accept more overflow risk:
   - `compaction.thresholdPercent` / `thresholdTokens`

6. **Do not expect true parallel compact** without a product change. Closest productized alternatives today:
   - handoff → new session (isolates work, not background compact)
   - idle compact (when already idle)
   - faster local strategy (snapcompact)

## If we were to design async compact later

Minimum viable design that would actually help:

1. Snapshot branch at threshold (frozen entry ids + messages)
2. Background job produces a candidate `CompactionResult` against that snapshot
3. Main agent continues; job must invalidate if `firstKeptEntryId` region mutates incompatibly
4. At next safe boundary (`agent_end` / pre-prompt), apply candidate if still valid; else discard and compact sync

Hard parts already encoded in current code:

- tool-call/result pairing integrity
- provider-native `preserveData` (OpenAI remote history)
- mid-turn tool-loop ownership of `activeMessages`
- prompt-cache / session routing keys
- queue drain ordering for steer/follow-up

This is a multi-week core change, not a plugin drop-in.

## Sources

- `docs/compaction.md` — pipeline, triggers, remote modes, settings
- `packages/coding-agent/src/session/session-maintenance.ts` — `isCompacting`, `compact()`, `runIdleCompaction()`, mid-run maintenance
- `packages/coding-agent/src/session/compact-modes.ts` — `/compact soft|remote|snapcompact`
- `packages/agent/src/compaction/openai.ts` — remote compact transports + 180s timeout
- `packages/agent/src/compaction/compaction-v2-streaming.ts` — Codex/OpenAI V2 streaming compact
- `packages/catalog/src/discovery/codex.ts` — GPT-5.6 remote compaction defaults
- `packages/coding-agent/examples/hooks/custom-compaction.ts` — custom summarizer hook
- `packages/coding-agent/src/config/settings-schema.ts` — compaction settings defaults
