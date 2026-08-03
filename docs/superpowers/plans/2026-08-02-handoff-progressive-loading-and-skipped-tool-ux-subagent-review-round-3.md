# Design Review Gate Round 3 — Handoff / Progressive Loading / Skipped Tool UX

## Metadata

- **Reviewer model:** `gateway/gpt-5.6-sol`
- **Reviewer identity:** `DesignReviewGate2` (host-native read-only reviewer; reviewer agent type, model override `gateway/gpt-5.6-sol:xhigh`)
- **Design author:** `OptimizationDesignAuthor2` (`gateway/gpt-5.6-luna`)
- **Review mode:** host-native, read-only
- **Verdict:** **PASS_WITH_NOTES**
- **Implementation authorization:** authorized — no blocking findings; implementation may proceed. The four notes below were tightened in revision 3 (documentation only) and do not change the semantic contract.

## Reviewed Inputs / Revision

- Primary design: `docs/superpowers/specs/2026-08-02-handoff-progressive-loading-and-skipped-tool-ux-design.md`
- Reviewed SHA-256: `61f599ac1b305cb677fdfcc1a8214c7809d0269b79bd1d9ad2f2eef84ee9b00b` (revision 2)
- Post-review revision: `221afa2fda7a279fdfc18f545b6fc110899c7245a608a7a82a9863e778b606ac` (revision 3 — applies the four notes below; documentation only)
- Round-1 review: `docs/superpowers/plans/2026-08-02-handoff-progressive-loading-and-skipped-tool-ux-subagent-review-round-1.md` (NEEDS_REVISION)
- Round-2 review: `docs/superpowers/plans/2026-08-02-handoff-progressive-loading-and-skipped-tool-ux-subagent-review-round-2.md` (NEEDS_REVISION; blockers F1/F2/F3 resolved in revision 2)

## Round-2 blocker resolution assessment (revision 2)

- **F1 (started-abort recovery guard)** — RESOLVED. §4.1 now requires `executed:true` for `started_aborted_*` and tightens the never-invoked guard (`isSyntheticToolResultMessage` / `syntheticToolResultTailStart`) to `__synthetic === true && executed === false`, matching `packages/agent/src/agent-loop.ts:3097-3119` and `packages/coding-agent/src/session/turn-recovery.ts:72-84`. A started-aborted tool cannot enter the never-invoked retry tail.
- **F2 (live lineage accessors)** — RESOLVED. The live nullable `getLineageContext()` and per-resolve `ResolveContext.lineage` model matches the real `ToolSession.getSessionFile(): string | null` seam (`tools/index.ts:240-243`), the live SDK closure (`sdk.ts:1767-1769`), and mutable switch/new/fork + no-file session states.
- **F3 (session-listing wire form)** — RESOLVED. The persisted wire value remains a string; both string-only listing parsers preserve it into `SessionInfo.parentSessionPath` (`session-listing.ts:319-347,463-464`), and the selector's fork marker (`session-selector.ts:616-618`) survives.

## Findings (non-blocking notes, revision 2)

| # | Severity | Section | Finding | Resolution in revision 3 |
|---|---|---|---|---|
| N1 | NOTE | §4.1, §4.3 | "aborted/failed" phrasing could let a consumer render started-abort as failed | Replaced with "aborted"; §9 row already said "classifier says aborted" |
| N2 | NOTE | §10 ACP | ACP `ToolCallStatus` is closed (`pending\|in_progress\|completed\|failed`); adapter mapping for skipped/aborted unspecified | Specified: skipped → `completed` + safe marker in `rawOutput`; aborted → `failed` + `started_aborted_*` in `rawOutput`; Todo-plan follows classifier |
| N3 | NOTE | §4.1 | Pre-start source mapping ambiguous for `unknown` and external/user signal aborts | Mapped exhaustively: unknown → `prestart_queued_steering` (generic reserved for unknown); external/user signal → `prestart_user_cancel`; started causes map 1:1 |
| N4 | NOTE | §11 | "Write the review to a stable repository file" contradicts read-only gate contract | Clarified: coordinator persists returned findings; reviewer writes nothing |

## Gate Evidence

| Gate concern | Result |
|---|---|
| F1/F2/F3 blocker resolution | All resolved; no BLOCKER/HIGH findings |
| Twelve-point checklist (source union, classifier, capsule, prompts, read fallback, card swap, work packages, matrix) | Covered; started-abort row says `executed:true`, `started_aborted_*`, "classifier says aborted" |
| Reviewer identity/model | `gateway/gpt-5.6-sol`, `DesignReviewGate2` — distinct from author `gateway/gpt-5.6-luna` |
| SHA-256 | Not independently recomputed by the reviewer (read-only bash); coordinator-verified `61f599ac...` at gate time and `221afa2f...` after note application |

No implementation, build, formatter, linter, or test was run by the reviewer. The exact card-swap cause remains unverified; smallest evidence remains raw provider call IDs, transcript/EventController inputs, rendered cards, and a red assertion naming the owner.

**Gate decision:** **PASS_WITH_NOTES**. F1/F2/F3 are resolved; implementation may proceed. Revision 3 applies the four notes without changing the semantic contract.
