# Handoff / Progressive Loading / Skipped Tool UX Design

- **Date:** 2026-08-02
- **Target:** `docs/superpowers/specs/2026-08-02-handoff-progressive-loading-and-skipped-tool-ux-design.md`
- **Scope:** L; `packages/agent`, `packages/coding-agent`, persisted session lineage, internal URLs, model prompts, TUI and non-TUI presentation.
- **Lifecycle owner:** Dev Flow `design-brainstorm`; Aegis supplies architecture evidence only.
- **Implementation authorization:** `authorized`.
- **Authorization source:** User authorized evaluation/implementation, then requested complete documentation and a new-session Goal Mode handoff.
- **Author replacement:** `OptimizationDesignAuthor2` replaces `OptimizationDesignAuthor` because the original author became unresponsive and was cancelled.
- **Planned reviewer:** native read-only reviewer with model and identity different from this author.
- **Status:** revision 2 — resolves round-2 gate blockers (started-abort recovery guard, live lineage accessors, session-listing wire form); documentation only. Round-1 gate: NEEDS_REVISION (four blockers, all resolved in revision 1). Round-2 gate: NEEDS_REVISION (three blockers below, resolved in this revision 2).

## 1. Outcome and evidence boundary

The confirmed symptoms are: immediate queued `继续` skips every unstarted sibling; synthetic error-shaped results make Todo/Bash/Read cards look failed; Todo can emit `Todo update failed`; a fresh handoff process cannot reliably resolve previous-session agent/history artifacts; broad skill/rule guidance causes over-reading; and one `Read rule://oh-my-pi-catalog` display contained apparent `git status` output and repeated reads.

Confirmed evidence is the cited queue/settings code and passing focused queue test; existing `SyntheticToolResultDetails` has `__synthetic=true`, `executed=false`; Todo/event-controller/tool-card seams are the cited ranges; handoff writes a prior file path while fork paths can write IDs; internal URL roots are registry-derived; the handoff prompt lacks an ephemeral-URI prohibition; prompt seams and inventory tests are cited; a historical changelog says transcript duplication was fixed; and a deterministic read end-before-start fallback can drop or orphan a read result.

The apparent card swap has no established root cause. No code path was found that attaches Bash output to a rule-read card. It may be provider association, transcript/rendering, or copied-screen artifact; this design does not select among those explanations.

The outcome is: preserve immediate interruption, preserve paired provider results, classify never-invoked work as skipped without text matching, preserve real and started-aborted failures, make fresh handoff self-contained with bounded read-only lineage, stage prompt loading, repair the confirmed read fallback, and leave card association unchanged without a red-capable reproduction.

## 2. Canonical owners

| Behavior | Single owner | Contract consumers |
|---|---|---|
| Decide never-invoked sibling skip | `packages/agent` agent loop | provider tool result |
| Causal discriminator | `SyntheticToolResultDetails.source` | shared presentation classifier |
| Persist new parent relation | session handoff/session manager | session header/store |
| Resolve lineage URLs | internal-URL registry/protocol with session context | agent/history protocols |
| Classify presentation | one shared coding-agent classifier | every live/replay/export surface |
| Render Todo warning/card | event controller and tool components | TUI |
| Select prompt stage | static system prompt assets | model |
| Repair read end-before-start | event-controller read lifecycle | full/grouped read cards |
| Decide card-swap actionability | reproduction evidence | no speculative mapping patch |

The agent loop owns execution truth; consumers never infer it from `isError` or English text. Provider serialization may retain `isError=true` for validity, while presentation uses the shared classifier. The handoff capsule owns load-bearing conclusions; lineage is a bounded provenance/read-only extension, not a second transcript. No read ledger is introduced.

## 3. Alternatives and recommendation

### Scheme A — prompt-only plus capsule-only

Static prompts would select one primary routing skill, load rules only for known paths, and prohibit immutable rereads. Handoff would inline all required findings and forbid load-bearing ephemeral URIs. This is the smallest surface and preserves prompt-cache locality, but it cannot distinguish a never-invoked Todo call from an executed failure, cannot repair the read lifecycle defect, and cannot expose persisted ancestor evidence in a fresh process.

### Scheme B — structured runtime plus session lineage plus capsule (recommended)

The agent loop uses the existing synthetic-details contract with one closed `source` discriminator; all consumers use one classifier. Handoff stores a canonical session-store reference, passes session-scoped lineage roots through `ToolSession` and `ResolveContext`, and resolves old IDs in a bounded read-only manner. The capsule remains self-contained, prompts are static and staged, and the deterministic read fallback is fixed. This is the smallest complete scheme: it changes semantic ownership where symptoms originate without weakening interruption or adding a dynamic prompt ledger.

### Scheme C — Scheme B plus a read ledger

A per-read ledger would rebuild prompt state and attempt to suppress duplicate reads. It adds persistence, replay, and ownership with no evidence that prompt reconstruction is needed, and risks destroying provider prompt-cache locality. It is rejected; staged static instructions address over-reading directly.

## 4. Synthetic result contract

### 4.1 One discriminator and execution phase

Reuse `SyntheticToolResultDetails`; do not add a top-level `skipped` field. The existing details location preserves the provider envelope and avoids competing markers. `source` is the sole causal discriminator; do not add a parallel `reason` field.

Retain the existing `assistant_stop_aborted`, `assistant_stop_error`, `assistant_stop_skipped`, and `assistant_stop_length` variants. Extend that same closed union with actual pre-start causes and a distinct started-abort family, using distinct variants for at least:

```ts
type SyntheticResultSource =
  | "assistant_stop_aborted"
  | "assistant_stop_error"
  | "assistant_stop_skipped"
  | "assistant_stop_length"
  | "prestart_queued_steering"
  | "prestart_budget"
  | "prestart_user_cancel"
  | "prestart_system_cancel"
  | "prestart_irc_cancel"
  | "started_aborted_user"
  | "started_aborted_system"
  | "started_aborted_irc"
  | "started_aborted_external";
```

The implementation must reconcile these names with the existing declaration, retaining its current variants and adding only causes represented by real call paths. `source` owns cause; `executed` owns whether `tool.execute()` was entered. `executed:false` is legal only when `tool.execute()` was never invoked; `executed:true` is legal for a started tool regardless of outcome.

A queued sibling therefore has `__synthetic:true`, `executed:false`, and `source:"prestart_queued_steering"`; budget and user/system/IRC pre-start causes use their corresponding source. A tool whose `execute()` started and then aborted must not receive `executed:false`; it retains `executed:true` and a `started_aborted_*` source naming the runtime cause (user/system steering, peer IRC, or external abort). It is presented as aborted, never as not executed or as a failed execution. An executed error remains an executed failure.

The pre-start interrupt sources map exhaustively to the real dispatch: queued user steering (`interruptState.source === "user"`) → `prestart_queued_steering`; queued system advisory (`"system"`) → `prestart_system_cancel`; peer IRC → `prestart_irc_cancel`; unknown source → `prestart_queued_steering` (the generic variant is reserved for `unknown`); an external/user abort signal observed before `execute()` (the `createToolSignalAbortedResult` path) → `prestart_user_cancel`; exhausted budget → `prestart_budget`. Started-abort causes map the same way: user → `started_aborted_user`, system → `started_aborted_system`, IRC → `started_aborted_irc`, unknown or external signal → `started_aborted_external`. This mapping is deterministic; no pre-start cause collapses into another.

The never-invoked consumer guard MUST check both markers, not `__synthetic` alone: `isSyntheticToolResultMessage` (and any retry/turn-recovery walk such as `syntheticToolResultTailStart` in `packages/coding-agent/src/session/turn-recovery.ts`) narrows to `__synthetic === true && executed === false`. A `started_aborted_*` result (`executed:true`) is never walked as a never-invoked placeholder, so a retry cannot re-execute a tool whose side effects may already have occurred.

Do not collapse started-aborted into a pre-start skip: side effects may already have occurred. Do not collapse assistant stop error, length, abort, and skip into one source. Do not collapse user/system/IRC/external abort causes into one started-abort source. `isError` remains a provider-envelope property, not the presentation discriminator.

### 4.2 Why not a top-level `skipped`

A top-level field would force a second envelope contract across adapters, replay, persistence, ACP, export, and terminal code, while duplicating `details.executed` and `details.source`. Reusing the existing type keeps the synthetic marker where existing consumers already recover it, preserves provider pairing, and permits one classifier. No `any` or dynamic import is allowed.

### 4.3 Shared presentation classifier

Create one shared, typed classifier in the coding-agent owner and make every presentation path call it:

```ts
type ToolPresentation = "running" | "succeeded" | "failed" | "aborted" | "skipped";

classify(result) {
  if (result.details?.__synthetic === true && result.details.executed === false)
    return "skipped";
  if (isStartedAbortSource(result.details?.source)) return "aborted";
  if (result.isError) return "failed";
  return "succeeded";
}
```

The actual implementation must use the repository's exact types and treat missing details conservatively. `isStartedAbortSource` matches the `started_aborted_*` family (user/system/IRC/external), and the classifier MUST NOT reach `isError` before the structured phase. It must never classify `isError=true` as failed before checking the structured phase. It must not infer skipped state from message text. The never-invoked narrow requires `executed === false`; a `started_aborted_*` result with `executed:true` is never classified as skipped.

The classifier is consumed by live `EventController` and Todo warning logic; `ToolExecutionComponent`; `ReadToolGroupComponent`; transcript rebuild and history replay; ACP tool-call updates and Todo-plan mapping; commit-agent terminal output; collaboration event display; TUI replay; export/share sanitization; HTML template rendering; and any text/JSON terminal or share representation. Share/export either preserves a safe non-secret presentation marker or materializes `ToolPresentation` before stripping details. Provider serialization remains paired and may remain error-shaped.

Skipped cards show not-executed and an optional source label. Started-aborted shows aborted, not skipped and not failed. Real failures remain failures. Todo suppresses `Todo update failed` only for `executed:false` synthetic results.

## 5. Session-store lineage and URI precedence

### 5.1 Canonical persisted reference

Normal sessions live beneath the configured session root, normally outside the repository. Therefore session artifacts are never encoded as repository-relative paths. New handoff, branch, and fork writes use a canonical absolute session-file path string validated by `resolveManagedSessionRoot`/the configured session root before persistence. The header wire value stays a STRING (canonical absolute path for new writes, legacy ID for legacy writes) so existing consumers that read `parentSession` as a string — `session-listing.ts` (`sessionListHeaderFromRecord`, `extractStringProperty`) and the session-selector fork marker — keep working unchanged; normalization to a structured reference happens at read/resolve time, not at write time:

```ts
type ParentSessionRef =
  | { kind: "session-file"; canonicalPath: string }
  | { kind: "legacy-session-id"; id: string };
```

New writes use only `kind:"session-file"`; the ID form exists solely for legacy reads. A legacy path-form string is normalized to `session-file` only after canonicalization and root validation. Unsafe, malformed, missing, or outside-root paths are unresolved diagnostics, not alternate roots. `fork()`/`forkFrom()` legacy IDs use bounded lookup in the configured session store. Session listing must preserve the parent reference: a new canonical path and a legacy ID both flow through `SessionInfo.parentSessionPath` so the fork marker still renders.

### 5.2 Session-scoped resolver seam

Thread the current session and its ancestor roots through the tool/session boundary instead of relying on the process-global registry. The seam MUST preserve the existing live nullable accessor pattern: `ToolSession` already exposes `getSessionFile(): string | null` as a live getter over the mutable session manager, and the manager changes files on switch/new/fork and may have no file for in-memory sessions. Lineage context is therefore derived per-resolve, never snapshotted as a required field:

```ts
type LineageRoot = { canonicalPath: string; depth: number };
type LineageContext = {
  currentSessionFile: string | null;
  lineageRoots: readonly LineageRoot[];
};
// ToolSession gains a live accessor:
//   getLineageContext(): LineageContext
// ResolveContext carries the derived value for the current resolve:
//   lineage?: LineageContext
```

`ToolSession` supplies the derived `LineageContext` into `ResolveContext` across the router/read boundary on each resolve. `agent://` and `history://` resolve the current session plus its explicit bounded roots before consulting registry-derived current-process roots. A second top-level session gets a distinct context and cannot see or prioritize the first session's ancestors merely because both run in one host. No global registration is used as a substitute for lineage.

Null/empty degradation: an in-memory session or a session mid-transition has `currentSessionFile: null` and/or empty `lineageRoots`; resolution then falls back to registry-derived current-process roots for non-lineage artifacts and returns a typed diagnostic for a lineage-specific request that needs a session identity. Every resolve re-derives the context from the live manager, so a switch/new/fork that changed the current file cannot retain a stale ancestor set.

### 5.3 Precedence and degradation

Resolution order is: (1) exact canonical session-file reference from the current relation; (2) explicit session-scoped lineage roots ordered by depth; (3) validated legacy path-form parent link; (4) bounded legacy ID lookup in the configured store; (5) registry-derived roots for non-lineage current-process artifacts; (6) typed unresolved diagnostic.

An exact canonical path beats IDs and registry candidates. A path outside the managed root is rejected. Duplicate normalized paths collapse to one artifact. Conflicting opaque IDs resolve to neither by ID. A URI cannot override an explicit lineage path. Maximum depth and byte limits are fixed by existing safe-read limits; visited canonical paths stop cycles. Missing/deleted artifacts, malformed links, cycles, and collisions return diagnostics while preserving inline capsule conclusions. Resolution is read-only and never mutates sessions. Fresh-process reads do not require `Main` to be registered.

### 5.4 Capsule

The capsule is load-bearing and self-contained: it contains objective, authorization, scope, facts, inferences, selected design, reviewer findings, acceptance criteria, and stable repository-relative source citations. Session artifacts are cited by canonical session-store reference, not repository-relative path. `agent://` and `history://` are explicitly ephemeral and may appear only as non-load-bearing provenance when all conclusions are inline. Handoff generation rejects or rewrites an ephemeral URI presented as required next action. It records bounded lineage metadata and missing/cyclic/malformed/collision diagnostics. It does not claim a reviewer digest or verdict that has not been produced, and does not claim a card-swap root cause without reproduction.

## 6. Progressive prompt contract

Update both static `system-prompt.md` and `custom-system-prompt.md`. Keep context files and always-apply rules fully injected; keep ordinary skills/rules as an index until target paths are known. In order: identify goal and target paths; choose at most one primary routing/lifecycle skill; load that skill before a cross-module plan; load domain rules only for known target paths; choose the narrowest relevant set; do not reread immutable skill/rule bodies already in the current transcript; do not bulk-read every indexed skill/rule/spec; and inspect only the smallest locator set when paths are unknown. The wording must replace the broad bulk-read trigger without promising dynamic prompt rebuilding. Assets remain static Markdown imported with `{ type: "text" }`; inventory tests remain authoritative. No read ledger is introduced.

## 7. Confirmed read fallback and unreplicated swap boundary

The event controller's end-before-start path routes a missing read component to `ReadToolGroupComponent` without rechecking `readArgsCollapseIntoGroup`, timeline registration, or orphan holding; `updateResult` silently ignores an unknown ID. This can drop a `rule://` result, create an empty grouped card, and leave a full card unsettled. The event-controller read lifecycle is the sole owner. Reapply the grouping decision, register or hold the event until the correct component exists, make unknown IDs observable to focused tests, and settle grouped/full cards exactly once.

Do not patch renderer/provider association/transcript/card mapping for the displayed `git status` swap without a deterministic reproduction containing raw provider call IDs, transcript/event-controller inputs, rendered cards, and a failing assertion naming the owner. If absent, leave mapping unchanged. The fallback fix is independent and remains allowed.

## 8. Goal Mode work packages

1. **Agent loop:** reconcile the existing closed `source` union; emit pre-start variants only when `execute()` was never invoked; emit `started_aborted_*` (user/system/IRC/external) only when `execute()` was entered; keep started-aborted `executed:true`; tighten the never-invoked guard (`isSyntheticToolResultMessage`, `syntheticToolResultTailStart`) to require `executed === false`; preserve paired provider results and `isError` envelope validity.
2. **Shared classifier/consumers:** implement one typed classifier mapping `started_aborted_*` to aborted and never-invoked (`executed:false`) to skipped; update EventController/Todo, tool execution, read group, transcript rebuild/history replay, ACP mapper/Todo plan, commit terminal, collaboration, TUI replay, export/share, and HTML; preserve safe status through detail stripping.
3. **Session lineage:** write canonical absolute session-store path strings; read legacy paths/IDs; derive live `LineageContext` per resolve through `ToolSession`/`ResolveContext`; enforce precedence, bounded depth, root validation, cycle/collision/missing degradation, read-only behavior, and null/empty (in-memory / mid-transition) degradation; keep `parentSession` a string through session listing so `SessionInfo.parentSessionPath` and the fork marker survive.
4. **Capsule/prompt:** inline findings and stable repo source citations; prohibit load-bearing ephemeral URIs; update both static staged prompts and inventory expectations without a ledger.
5. **Read fallback:** repair end-before-start grouping/holding/registration and exactly-once settlement in the event-controller seam.
6. **Fresh Goal Mode:** read this stable design, preserve unrelated workflow, `packages/ai/test/openai-codex-stream.test.ts`, and `docs/research-async-compaction.md` changes; do not reset/checkout/commit/clean; implement in the order above.

## 9. Verification matrix

| Area | Red-capable scenario | Green evidence |
|---|---|---|
| Queued steering | Interrupt a multi-call batch | Every never-invoked sibling has paired result, `executed:false`, pre-start queued source |
| Immediate mode | Default `interruptMode=immediate` | Steering remains immediate; started call is not retroactively skipped |
| Started-aborted | Enter `execute()`, abort before usable output | `executed:true`, `started_aborted_*` source, classifier says aborted, never not-executed |
| Retry/no-reexecution | Retry after a started-aborted turn | `isSyntheticToolResultMessage`/`syntheticToolResultTailStart` do not walk `executed:true` results; no tool is re-executed |
| Real error | Execute a real failing tool | Executed error remains failed |
| Budget/user/system/IRC | Pre-start each cancellation path | Distinct source; no collapse into queued steering |
| Todo/Bash/Read live | Skip each tool type | Skipped card; no Todo false-failure warning |
| TUI replay/read group | Replay skip and end-before-start read | Same classifier state; read settles exactly once |
| ACP | Map skipped and started-aborted `tool_execution_end` | Skipped is not ACP failed; aborted is not skipped; Todo plan agrees |
| Commit terminal | Print skipped and real-error events | No failure cross for skip; cross remains for real error |
| Collaboration/export | Send/replay collaborative event and sanitized share | Safe skipped marker/status survives detail stripping |
| HTML | Render skipped, aborted, and real-error persisted results | Classes/labels match classifier, not raw `isError` |
| Provider pairing | Inspect provider sequence | One result for every emitted call; error-shaped skip remains valid |
| Two-session isolation | Two top-level sessions with different lineage roots resolve same URI | Each sees only its own roots; registry state cannot cross-prioritize |
| Lineage transitions | Switch/new/fork and in-memory (no-file) sessions resolve lineage | Context re-derived per resolve; no stale roots; null/empty degrades to typed diagnostic, never wrong roots |
| Fresh handoff | New process without prior registry | Inline capsule works; canonical store ancestor is optional read-only evidence |
| Legacy/degradation | Old path, old ID, missing, deleted, cycle, collision | Bounded typed diagnostics; inline conclusions survive |
| Session listing | New canonical parent and legacy-ID headers in listing | `parentSession` stays a string; `SessionInfo.parentSessionPath` and fork marker survive both forms |
| Precedence | Competing path, lineage, ID, registry candidates | Canonical session-store path and session-scoped lineage win |
| Prompt | Inspect both prompt variants after multi-read session | One primary skill; path-gated rules; no immutable reread or ledger |
| Read fallback | End before component start for grouped and full read | Correct component, no dropped result/empty orphan, exactly once |
| Card swap boundary | Re-run exact report with raw IDs | Patch only if red and owner identified; otherwise no mapping change |
| Package check | Affected TypeScript packages | `bun check` passes; no `any`/dynamic imports |

## 10. Cross-surface semantic rules

The provider-facing result and the presentation-facing status are intentionally separate.

The provider adapter serializes the original tool call and exactly one result, including any required `isError=true` shape.

The shared classifier receives the structured result before any surface converts it to a status, icon, CSS class, ACP state, terminal glyph, or warning.

Every adapter that strips `details` must first materialize the safe status and source category permitted for that surface.

No export or collaboration payload may expose session secrets merely to preserve skipped status.

The safe marker can be a closed presentation enum and may omit causal source when the destination does not need it.

The live event controller, transcript rebuild, and history replay must agree on one call ID and one result ID.

The read group is not allowed to silently turn an unknown result ID into a successful or failed card.

ACP `failed` is reserved for an executed failure; a pre-start skip is a valid non-execution status even when its provider result is error-shaped. Because ACP's `ToolCallStatus` is closed (`pending | in_progress | completed | failed`), the adapter encodes `skipped` as `completed` plus a safe presentation marker carried in `rawOutput` (the structured result already travels there, so `details.__synthetic`/`source` reach status-aware clients); it encodes `aborted` as `failed` (an execution that started and produced no usable output) with the `started_aborted_*` source in `rawOutput`, so `skipped`, `aborted`, and executed failure remain distinguishable to clients that read the marker. Todo-plan mapping follows the classifier: `skipped` and `aborted` todo ends produce no plan mutation.

Commit-agent output follows the same rule: a failure glyph requires an executed failure, not merely `isError`.

HTML and share viewers use the materialized status, not persisted `result.isError` alone.

Collaboration and replay preserve status through round trips and do not reclassify from localized display strings.

For a missing or legacy details object, the classifier may conservatively return `failed` when `isError` is true, but it must never call such a result `skipped` without the structured marker.

This conservative legacy behavior is compatibility handling, not permission to emit unstructured new skips.

## 11. Implementation acceptance and failure handling

The agent-loop change is accepted only when the call-start boundary is explicit: the result constructor receives whether `execute()` was invoked, and the pre-start constructor cannot be called from a started-abort path. It is accepted only when the never-invoked guard (`isSyntheticToolResultMessage` and `syntheticToolResultTailStart`) requires `executed === false`, so a `started_aborted_*` result is never walked as a never-invoked placeholder.

The classifier is accepted only when all named consumers share it or consume a status materialized by it; a local `isError` shortcut is a contract failure.

The session resolver is accepted only when its input carries current session identity and roots; a process-global registry fallback cannot satisfy a lineage request. It is accepted only when the context is derived live per-resolve (nullable current file, empty-safe roots) rather than snapshotted, so switch/new/fork and in-memory sessions cannot retain stale roots.

The canonical path is accepted only after managed-root validation and canonicalization; repository-relative encoding is not an alternative for session artifacts. The header wire value remains a string so session listing (`SessionInfo.parentSessionPath`) and the fork marker keep working.

Legacy degradation is successful when it terminates, returns a typed diagnostic, and leaves inline capsule conclusions readable.

Prompt changes are accepted only as static assets and only when the inventory contract still detects required prompt sections.

The read fallback is accepted only when both grouped and non-grouped paths settle once, including an end event received before the start component.

The card-swap report remains an evidence-gated investigation; a non-reproducing run is a valid reason for no mapping edit.

Implementation completion must report changed package surfaces, focused test names, smoke scenarios, and any unverified reproduction boundary without relabeling it as a root cause.
## 10. Stop conditions and non-goals

Do not weaken immediate steering or provider pairing. Do not use English-text matching, a top-level duplicate discriminator, a session read ledger, prompt reconstruction, repository-relative session paths, or process-global lineage roots. Stop lineage at depth, byte, root, cycle, collision, or malformed-link boundaries. Stop card-mapping work without red reproduction. Preserve unrelated user changes. Do not claim an unproduced review digest/verdict or an unproven card root cause.

## 11. Design Review and Goal Mode handoff

Start the next session in Goal Mode and read this stable design before implementation. Give the native read-only reviewer this complete prompt:

```text
You are the native read-only Design Review reviewer for the handoff/progressive-loading/skipped-tool UX design.

Read the stable design at docs/superpowers/specs/2026-08-02-handoff-progressive-loading-and-skipped-tool-ux-design.md, every cited source seam, and applicable repository instructions. Review against the original brief and the design's acceptance matrix, not an assumed implementation.

Check separately under Standards and Spec:
1. source is the sole causal discriminator; pre-start never-invoked and started-aborted execution cannot be confused, and the never-invoked guard (`isSyntheticToolResultMessage`/`syntheticToolResultTailStart`) requires `executed === false` so retry never re-executes a started-aborted tool;
2. SyntheticToolResultDetails reuse preserves paired provider results without a top-level duplicate;
3. the canonical session reference is a validated absolute session-store path string, legacy IDs are bounded, no repository-relative session-path claim remains, and the string flows through session listing so `parentSessionPath`/the fork marker survive;
4. ToolSession/ResolveContext carry a live nullable lineage context (current file + roots) derived per resolve with null/empty degradation, two-session isolation, and documented precedence;
5. one shared classifier drives EventController/Todo, ToolExecutionComponent, ReadToolGroupComponent, transcript/history replay, ACP/tool and Todo-plan mapping, commit terminal, collaboration, TUI replay, export/share, and HTML;
6. skipped, started-aborted, executed-failure, budget, user/system/IRC, and provider-termination states remain distinguishable while provider serialization stays paired and valid;
7. capsule conclusions are inline, ephemeral agent:// and history:// URIs are non-load-bearing, and no unproduced digest/verdict is claimed;
8. staged prompts select at most one primary skill, gate domain rules on known paths, prohibit immutable rereads, preserve static imports, and reject a read ledger;
9. read end-before-start has a precise owner and exactly-once test contract;
10. exact card swap remains out of scope without raw-event red reproduction;
11. work packages and matrix cover all acceptance criteria without speculative changes.

Return a findings table with severity, exact section, evidence, and required action; separate Standards from Spec; then return approve, revise, or reject with reasons. Include actual reviewer model and agent identity. Do not invent source facts, reproduction, implementation results, digest, or verdict; mark absent evidence unverified and name the smallest evidence needed. The coordinator persists the returned findings to a stable repository review file; the reviewer itself performs no file writes (read-only exception: the review artifact is the sole permitted write, performed by the coordinator). Implementation may claim completion only after every blocking finding is resolved and the matrix has fresh evidence.
```

No reviewer digest or verdict is asserted here. Completion requires the stable design and review files, focused tests and smoke scenarios for every applicable matrix row, fresh-process handoff without `Main`, prompt inspection, exact-once read fallback, and an explicit reproduced/unreproduced status for the card swap.
