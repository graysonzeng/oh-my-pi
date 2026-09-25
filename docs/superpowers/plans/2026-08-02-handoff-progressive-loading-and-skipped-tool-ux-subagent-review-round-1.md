# Design Review Gate — Handoff / Progressive Loading / Skipped Tool UX

## Metadata

- **Reviewer model:** `gateway/gpt-5.6-sol`
- **Reviewer identity:** `OptimizationDesignReviewer2`
- **Design author:** `OptimizationDesignAuthor2` (`gateway/gpt-5.6-luna`)
- **Review mode:** host-native, read-only
- **Verdict:** **NEEDS_REVISION**
- **Implementation authorization:** authorized, but the blocking design findings below must be resolved before implementation claims completion.

## Reviewed Inputs / Revision

- Primary design: `docs/superpowers/specs/2026-08-02-handoff-progressive-loading-and-skipped-tool-ux-design.md`
- Declared SHA-256: `cc293ca0349518823c1e3660c258d310e6f5b8f869d72182a748d9be734ef6c2`
- Reviewed Revision: `c71787d3e2c06272d37527ba80bce4f489d9e9b108b0c63889913965d73327eb`
- Intended review artifact: `docs/superpowers/plans/2026-08-02-handoff-progressive-loading-and-skipped-tool-ux-subagent-review.md`
- Key seams read: `packages/agent/src/agent-loop.ts`, session header/manager/handoff/path code, `agent://` and `history://` handlers and router context, live/replay TUI components, ACP event mapping, commit-agent terminal output, HTML/share export, system prompt variants, handoff prompt asset, and focused handoff/fork/read-group tests.
- The declared hashes above came from the review contract; this read-only review did not run a hashing command.

## Root-cause assessment

The design correctly identifies the user-visible symptom as an ownership failure: the agent loop knows that work did not execute, but downstream consumers currently infer failure from `isError` and English text. It also correctly separates the deterministic read end-before-start defect from the unreproduced card-swap report.

The revision is nevertheless blocked because it introduces two competing discriminators for the same synthetic-result cause, chooses a lineage path representation that does not match the actual session-store topology, and does not close all concrete consuming surfaces that currently translate provider-valid `isError=true` into “failed.” These are contract defects, not implementation nits.

## Standards findings

### S1 — BLOCKER — Keep one discriminator owner for synthetic non-execution

**Exact design sections:** §6.1 “Canonical type”, §6.3 “Terminal and replay invariants”, Package A.

**Evidence:** `SyntheticToolResultDetails` already has the required `source` discriminator with the closed variants `assistant_stop_aborted`, `assistant_stop_error`, `assistant_stop_skipped`, and `assistant_stop_length`, plus `executed:false`. The design says existing fields must be retained while also requiring a new `reason` field with `queued-steering`, `budget`, and `provider-termination`. That creates two fields owning the same causal classification, with no precedence rule. It also makes `provider-termination` less precise than the existing source variants, collapsing error, abort, skip, and length while the old field continues to carry one of them.

There is a second boundary hidden by the proposed type: the current `createSkippedToolResult(...)` path is used both for never-started siblings and for a tool whose `execute()` was entered but aborted before returning usable output. Applying `executed:false` to the helper wholesale would state that the latter never ran, even though side effects may already have occurred.

**Required action:** Replace the proposed `reason` addition with one canonical closed `source` union. Extend `source` with the actual pre-start causes (at minimum queued steering, budget, and any required user/system/IRC distinction) while retaining the existing `assistant_stop_*` variants. Specify that `executed:false` is emitted only when `tool.execute()` was never invoked. Give started-then-aborted execution a separate result state that cannot be rendered as “not executed,” and add a verification row proving this distinction. Do not retain both `source` and `reason` as competing owners.

### S2 — BLOCKER — Normalize lineage to the session store and make resolution session-scoped

**Exact design sections:** §7.1 “Canonical persisted relation”, §7.2 “Internal URI precedence”, §7.3 “Read-only exposure”, Package C.

**Evidence:** Normal sessions are created beneath the configured session root via `getSessionsDir(...)` and `computeDefaultSessionDir(...)`, normally outside the repository. Handoff already writes `previousSessionFile`; branch creation also writes a session-file path, while `fork()`/`forkFrom()` write a session ID. Therefore a “stable repository-relative path” is not normally available for the parent session artifact. A constant object such as `{ kind: "parent-session", sessionPath }` does not itself resolve this: `kind` has only one value, and `sessionPath` still lacks a declared base. A repository-relative encoding of a file under the external session store would either escape the repository or become ambiguous.

The resolver seam is also incomplete. `agent://` and `history://` derive roots from the process-global `AgentRegistry`; `ResolveContext` is deliberately session-scoped but currently carries no current session file or lineage roots. In a host with multiple top-level sessions, globally registering one handoff’s ancestors can expose or prioritize another session’s artifacts. The proposed “explicit lineage before registry” precedence cannot be implemented safely until the calling session is carried across the read/router boundary.

**Required action:** Choose one path contract based on the real store: preferably normalize all new `parentSession` writes to a canonical session-file reference and treat legacy UUID values through bounded legacy lookup. The reference must be either a canonical absolute path validated against `resolveManagedSessionRoot`/the configured session root, or a session-root-relative path with an explicit root identity; remove the repository-relative claim for session artifacts. If a new object remains, its discriminator must distinguish genuinely different reference forms rather than repeat a constant relation name. Thread the current session file or resolved lineage roots through `ToolSession` and `ResolveContext`, and require `agent://`/`history://` to use those session-scoped roots before global registry roots. Add concurrent-session isolation, unsafe-root, cycle, collision, missing-parent, legacy-path, and legacy-ID tests.

### S3 — BLOCKER — Enumerate and update every `isError`-driven presentation surface

**Exact design sections:** §3 owner table row “Render skipped versus failed”, §6.3, Package B, verification-matrix rows “Todo UX”, “Bash/Read UX”, and “Replay/terminal”.

**Evidence:** The event controller is not the only consumer. `packages/coding-agent/src/modes/acp/acp-event-mapper.ts` maps every `tool_execution_end` with `isError` to ACP status `failed`; `packages/coding-agent/src/commit/agentic/agent.ts` prints a failure cross solely from `event.isError`; `packages/coding-agent/src/export/html/template.js` assigns the error class solely from persisted `result.isError`; and `packages/coding-agent/src/export/share.ts` strips tool-result `details`, which would erase the proposed discriminator before the HTML viewer sees it. Within TUI replay, `ReadToolGroupComponent.updateResult` also maps `isError` directly to `error`. Updating only the event controller and ordinary tool card cannot satisfy the design’s own “all terminal/replay surfaces” invariant while provider pairing continues to require `isError=true`.

**Required action:** Define one shared presentation classifier, derived from the structured synthetic details but leaving the provider-facing envelope unchanged. Enumerate its consuming paths explicitly: live EventController/Todo warning, `ToolExecutionComponent`, `ReadToolGroupComponent`, transcript rebuild/history replay, ACP tool-call updates and Todo plan mapping, commit-agent terminal output, collaboration/export/HTML rendering, and any sanitized share representation. Preserve a safe non-secret skip marker through share/export or materialize presentation status before details are stripped. Add focused assertions for every named surface showing skipped/not-executed, while an actual executed error still renders failed.

## Spec findings

### P1 — HIGH — Verification matrix omits the failure modes created by the proposed contract

**Exact design section:** §12 “Verification matrix”.

The matrix is strong for queue pairing, reason distinction, read fallback, capsule degradation, and card-swap restraint. It does not cover: (a) a tool that started and then aborted versus a call never invoked; (b) ACP/commit/export/HTML presentation; or (c) isolation between two simultaneously active top-level sessions with different lineage roots. Those omissions would allow all listed checks to pass while the concrete mislabeling and cross-session resolution defects above remain.

**Required action:** Add explicit red-capable rows for started-aborted classification, every named non-TUI surface, share/export preservation of the skip marker, and two-session lineage isolation. Green evidence must show provider serialization remains paired and error-shaped without forcing presentation consumers to report execution failure.

### P2 — NOTE — Capsule, staged prompts, read fallback, and card-swap boundary are directionally sound

- The capsule rule that load-bearing conclusions must be inline and ephemeral `agent://`/`history://` URIs may only be provenance is correct.
- Updating both `system-prompt.md` and `custom-system-prompt.md`, preserving full context/always-apply injection, rejecting a dynamic read ledger, and keeping prompt assets as static Markdown imports is consistent with the current prompt assembly.
- §9 identifies the actual read lifecycle defect precisely: a missing read component is routed to `ReadToolGroupComponent` without reapplying `readArgsCollapseIntoGroup`, and unknown IDs are silently ignored. The exactly-once grouped/full-card acceptance is appropriate.
- §10 correctly refuses a renderer/provider/card-mapping patch without raw IDs and a red-capable reproduction. The historical changelog entry is not treated as proof of the exact reported swap.
- Provider tool-call/result pairing is preserved in intent; `isError=true` may remain necessary on the provider boundary. The required revision is to separate that protocol shape from presentation state.

## Gate Evidence

| Gate concern | Evidence reviewed | Result |
|---|---|---|
| Immediate steering and paired results | Agent-loop queue/missing-result/synthetic-result constructors | Direction correct; discriminator contract needs revision |
| Existing synthetic owner | `SyntheticToolResultDetails.source`, `executed:false`, recovery consumers | New `reason` duplicates owner; blocking |
| Session topology | Session header, manager create/fork/forkFrom/branch, handoff, session paths | Repository-relative session path is invalid for normal storage; blocking |
| Fresh-process URI resolution | Registry-derived artifact roots, `agent://`, `history://`, router `ResolveContext` | No session-scoped lineage seam; blocking |
| Live/replay UI | Event controller, tool card, read group, transcript builder, initial replay | Requirements do not enumerate all consumers; blocking |
| Other presentation surfaces | ACP mapper, commit terminal, HTML/share export | Still classify `isError` as failed or discard details; blocking |
| Capsule and prompts | Handoff prompt asset, both system prompt variants | Proposed direction acceptable after contract fixes |
| Read fallback | Event-controller missing-component path and read-group unknown-ID behavior | Owner and non-speculative boundary correctly identified |
| Unreproduced card swap | Design evidence boundary and stop conditions | Correctly excluded pending reproduction |

No implementation, edits, tests, checks, or commands were performed in this read-only gate.

## Next steps / complete handoff

1. Revise §6.1 and Package A so `source` is the single causal discriminator and started-aborted execution cannot receive `executed:false`.
2. Revise §7.1–§7.3 and Package C around a real session-store path contract, then define the session-scoped resolver input carried through `ToolSession`/`ResolveContext`.
3. Revise §3, §6.3, Package B, and §12 to enumerate ACP, commit terminal, TUI read/tool replay, collaboration/export/HTML, and share sanitization, backed by a shared presentation classifier and focused tests.
4. Preserve the accepted parts unchanged: provider pairing, self-contained capsule, static staged prompts without a ledger, deterministic read fallback repair, and no card-association patch without reproduction.
5. Re-run an independent Design Review Gate on the revised document. Implementation may proceed only after the blocking findings are resolved and the gate returns `PASS` or `PASS_WITH_NOTES`.

**Gate decision:** **NEEDS_REVISION**. The design has the right root-cause direction, but its schema ownership, lineage path/seam, and complete consumer matrix are not yet implementation-safe.