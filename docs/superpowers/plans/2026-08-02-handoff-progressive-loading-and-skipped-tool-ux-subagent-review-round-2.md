# Design Review Gate Round 2 — Handoff / Progressive Loading / Skipped Tool UX

## Metadata

- **Reviewer model:** `gateway/gpt-5.6-sol`
- **Reviewer identity:** `DesignReviewGate` (host-native read-only reviewer; reviewer agent type, model override `gateway/gpt-5.6-sol:xhigh`)
- **Design author:** `OptimizationDesignAuthor2` (`gateway/gpt-5.6-luna`)
- **Review mode:** host-native, read-only
- **Verdict:** **NEEDS_REVISION**
- **Implementation authorization:** authorized, but the blocking design findings below must be resolved before implementation claims completion.

## Reviewed Inputs / Revision

- Primary design: `docs/superpowers/specs/2026-08-02-handoff-progressive-loading-and-skipped-tool-ux-design.md`
- Declared SHA-256: `14d2d59b226ac76310f9d18583d62db82c3e3ce8a92f333ca95b98169ae56f10`
- Round-1 review (prior revision): `docs/superpowers/plans/2026-08-02-handoff-progressive-loading-and-skipped-tool-ux-subagent-review-round-1.md` (NEEDS_REVISION, blockers S1/S2/S3 + P1)
- Key seams read: `packages/agent/src/agent-loop.ts` (SyntheticToolResultDetails, createSkippedToolResult, createAbortedToolResult, interrupt-state paths), `packages/coding-agent/src/session/turn-recovery.ts` (syntheticToolResultTailStart), `packages/coding-agent/src/tools/index.ts` (ToolSession), `packages/coding-agent/src/sdk.ts` (ToolSession construction), `packages/coding-agent/src/session/session-manager.ts` (fork/forkFrom/newSession/setSessionFile), `packages/coding-agent/src/session/session-listing.ts`, `packages/coding-agent/src/modes/components/session-selector.ts`, `packages/agent/src/compaction/prompts/handoff-document.md`, system-prompt assets, event-controller read lifecycle, and round-1 review findings.
- The declared hash above came from the review contract; this read-only review did not run a hashing command.

## Round-1 resolution assessment

The revision resolves round-1 S3 and P1 (full consumer enumeration and the added started-aborted / non-TUI / two-session matrix rows are present), and substantially corrects S1 (single `source` discriminator, no parallel `reason`) and S2 (canonical session-store path + session-scoped resolver seam). The capsule, prompt staging, read-lifecycle owner, and card-swap evidence gate are sound.

## Standards findings

### S1 — BLOCKER — Keep started aborts out of the never-invoked recovery path

**Design section:** §4.1 (`SyntheticResultSource`), §8 WP1.

**Evidence:** Design §4.1 reuses `SyntheticToolResultDetails` for a started tool with `executed:true`, which also carries `__synthetic:true`. `isSyntheticToolResultMessage` (`packages/agent/src/agent-loop.ts:3112-3119`) narrows on `__synthetic === true` alone and documents "a tool_result emitted for a tool call the assistant never invoked"; `syntheticToolResultTailStart` (`packages/coding-agent/src/session/turn-recovery.ts:72-84`) then routes every `__synthetic` match through the never-invoked retry tail. A started-abort result with `executed:true` would therefore be consumed as a never-invoked placeholder, and assigning it `assistant_stop_aborted` also loses the actual user/system/IRC runtime cause still available at `packages/agent/src/agent-loop.ts:2308-2356,2639-2646`.

**Required action:** Define a started-abort-aware details/source variant; make the never-invoked guard require `executed === false` (or use a separate marker so the two phases cannot be confused); migrate turn recovery accordingly; add a retry/no-reexecution verification row proving a started-aborted tool is never walked as never-invoked.

### S2 — HIGH — Preserve the live nullable accessor seam for lineage context

**Design section:** §5.2 (`ToolSession` / `ResolveContext` shapes).

**Evidence:** Design §5.2 models `sessionFile` and `lineageRoots` as required values, but the existing seam deliberately exposes `getSessionFile(): string | null` (`packages/coding-agent/src/tools/index.ts:240-243`) and constructs it as a live getter over the mutable manager (`packages/coding-agent/src/sdk.ts:1734-1769`). That manager changes files on switch/new/fork (`packages/coding-agent/src/session/session-manager.ts:1193-1249,1265-1276`) and may have no file at all for in-memory sessions (`session-manager.ts:2509-2514`). A required snapshot can therefore retain a previous session's roots after a transition or cannot represent a valid no-file session.

**Required action:** Preserve the existing live getter seam; add a live lineage-root accessor or derive both values for each resolve; define null/empty degradation; cover new/switch/no-file transitions in addition to two simultaneous sessions.

## Spec findings

### P1 — HIGH — Route structured parent references through session listing

**Design section:** §5.1 (`ParentSessionRef` wire form), §8 WP3.

**Evidence:** Design §5.1 says new persisted writes use the structured `{ kind: "session-file", canonicalPath }` form, but the consuming session-listing dispatch still accepts only a string: `sessionListHeaderFromRecord` drops every non-string `parentSession`, and the fast parser calls `extractStringProperty` (`packages/coding-agent/src/session/session-listing.ts:309-347`). The object would be silently omitted from `SessionInfo.parentSessionPath` (lines 463-464), removing the fork marker rendered by `packages/coding-agent/src/modes/components/session-selector.ts:615-618`.

**Required action:** Either keep the header wire value as a canonical absolute string and normalize it to `ParentSessionRef` after parsing, or explicitly migrate both listing parsers and add a structured-parent listing test; §8/§9 currently name neither consumer nor evidence.

### P2 — NOTE — Round-1 P1 matrix additions verified; remaining rows are sound

The started-aborted, non-TUI surface, share/export preservation, and two-session isolation matrix rows are present as required by round-1 P1. Capsule, staged prompts, read fallback, and card-swap boundary remain directionally sound.

## Gate Evidence

| Gate concern | Evidence reviewed | Result |
|---|---|---|
| Single discriminator | §4.1 closed union; no `reason` field | Direction correct; started-abort needs recovery-path guard (S1) |
| Never-invoked vs started-aborted | `isSyntheticToolResultMessage`, `syntheticToolResultTailStart` | Blocking: `__synthetic` guard ignores `executed` (S1) |
| Session topology | `fork`/`forkFrom`/`newSession`/`setSessionFile` writes | Lineage path direction correct |
| Lineage seam | `ToolSession` live getter, `sdk.ts` construction | Blocking: required-snapshot model conflicts with live accessor (S2) |
| Session listing | `session-listing.ts` parsers, session-selector fork marker | Blocking: structured wire form dropped by string parsers (P1) |
| Fresh-process URI resolution | Registry-derived roots, `agent://`/`history://` | Session-scoped precedence correct |
| Live/replay UI, ACP, commit, HTML/share | Consumer enumeration in §4.3, §9 | Resolved from round-1 S3 |
| Capsule, prompts, read fallback, card swap | §5.4, §6, §7, §9 | Sound |

No implementation, edits, tests, checks, or commands were performed in this read-only gate.

## Next steps / complete handoff

1. Revise §4.1/§8/§9 so started-abort results carry a distinct source and cannot enter the never-invoked recovery/retry path; add the retry/no-reexecution matrix row.
2. Revise §5.2 to preserve live nullable accessors for session file and lineage roots, with null/empty degradation and transition coverage.
3. Revise §5.1 to keep the header wire value string-normalizable (canonical absolute string) and normalize to `ParentSessionRef` after parsing, or migrate the listing parsers; add listing evidence to §8/§9.
4. Re-run an independent Design Review Gate on the revised document. Implementation may proceed only after the blocking findings are resolved and the gate returns `PASS` or `PASS_WITH_NOTES`.

**Gate decision:** **NEEDS_REVISION**. The revision resolves most of round-1; the remaining blockers are the started-abort recovery-path contract, the live lineage accessor seam, and the session-listing wire form.
