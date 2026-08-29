# Facts Brief: Subagent live progress preview

Date: 2026-08-29
Scope of this file: verified facts only. No scheme recommendation.

## User request

1. Original: while a parent is blocked on `hub wait` for a detached subagent, the TUI `waiting on 1 job` row shows only name + duration. User wants live thinking or normal output so the child looks alive.
2. Follow-up: survey other open-source coding-agent CLIs; a PR #3821-style HUD tool sub-row is acceptable. After research, recommend the best implementation scheme. Reusing the community PR is allowed. Design only — no code.

Screenshot surface (parent transcript, live `hub wait` block):

```
i waiting on 1 job
  ⊙ <task> SpecReviewer  9m55s   [empty gist here]
```

Footer HUD in the same screenshot:

```
Subagents
  • SpecReviewer ⟨subagent-grok⟩ Complete assignment thoroughly: …
```

## OMP current surfaces (this checkout)

Canonical owner: `packages/coding-agent/`.

### Data already collected

`AgentProgress` (`packages/coding-agent/src/task/types.ts:417-491`) already has:

- `lastIntent` — tool `i` / intent, set in `task/executor.ts` on `tool_execution_start` from `event.intent`
- `currentTool` / `currentToolArgs` / `currentToolStartMs`
- `recentTools` (last 5)
- `recentOutput` (last 8 non-empty lines from an 8KB `text_delta` tail)
- `retryState` / `retryFailure`
- `inflightTaskDetails`

`extractToolArgsPreview` (`task/executor.ts:794-806`) picks first string among `command`, `file_path`, `path`, `pattern`, `query`, `url`, `task`, `prompt`, truncated at 60 chars. Does not call `shortenPath()`.

Activity gist pushed to registry (`executor.ts:1347-1349`):

```
progress.lastIntent ?? (progress.currentTool ? `running ${progress.currentTool}` : undefined)
```

Thinking is **not** stored. `message_update` keeps only `text_delta`; any other `assistantMessageEvent.type` (including `thinking_delta`) is dropped (`executor.ts:1652-1657`). `replaceRecentOutputFromContent` also skips non-`text` blocks.

Progress is emitted on a coalesced timer (~150ms) via `onProgress` and `TASK_SUBAGENT_PROGRESS_CHANNEL`.

### Surface A — sync `task` tool block (`task/render.ts`)

Running rows already draw a tool sub-row (`render.ts:966-990`):

- current tool, else most recent completed tool
- detail = `lastIntent ?? currentToolArgs` (or recent args)
- elapsed warning after 5s on current tool
- `recentOutput` only when **expanded** (`render.ts:1097-1109`)

Detached async `task` returns immediately; parent later `hub wait`s. The live wait block is **not** this renderer.

### Surface B — Subagents HUD (`modes/interactive-mode.ts:520-566`)

`renderSubagentHudLines`: detached + `kind===subagent` + `status===active` only. Shape:

```
Subagents
  • SpecReviewer ⟨role⟩: description
```

No current-tool sub-row on this checkout. Limit 8 visible; overflow points to Agent Hub. Sync `task` and eval `agent()` excluded because they already have inline progress.

Tests: `packages/coding-agent/test/subagent-hud-render.test.ts` (header + id:description only).

### Surface C — `hub wait` / `hub jobs` (`tools/hub/jobs.ts`)

Detached spawn 的 `#registerSpawnJob` / `forwardSyncProgress`（`packages/coding-agent/src/task/index.ts:1325-1334`）会把 executor snapshot 的 `currentTool`、`lastIntent`、`recentTools`、`recentOutput` 等字段复制到 job-owned progress object；`buildAsyncDetails()`（`task/index.ts:993-1001`）再把该对象放入 `latestDetails.progress[]`。这份 copy **不包含** `currentToolArgs` 或 `currentToolStartMs`。

HUD 不走该 copy：`TASK_SUBAGENT_PROGRESS_CHANNEL` 把完整 executor `AgentProgress` snapshot 交给 session observer，后者直接保存为 `session.progress`（`packages/coding-agent/src/modes/session-observer-registry.ts:191-220`）。

`JobSnapshot` (`tools/hub/types.ts:59-69`): `id`, `type`, `status`, `label`, `durationMs`, optional `resolvedModel`, `resultText`, `errorText`.

Hub 路径的第二次字段丢失发生在 `snapshotJobs()`：它已经遍历 task job 的 `latestDetails.progress[]`，但**只复制 `resolvedModel`**，因此 spawn copy 中其余 live fields 也被丢弃。

`jobsRenderResult` running row: icon + type badge + shimmering label + optional model + duration. Preview only from `errorText`/`resultText` (settled). Running jobs have neither → empty gist (the screenshot hole).

`hub wait` refreshes via `onUpdate` every `PROGRESS_INTERVAL_MS = 500` (`tools/hub/index.ts:137,465-473`).

Pending call frame `jobsRenderCall` is a static "Job" status line; live content is the **result** frame with `isPartial`/spinner.

Tests: `packages/coding-agent/test/job-renderer-preview.test.ts` — settled envelope stripping, not live gist.

### Surface D — Agent Hub (`modes/components/agent-hub.ts`)

Detail panel "Current": `currentTool` + args, else `lastIntent` / `ref.activity`. Opened via `Alt+A` / observe / empty-editor double-tap ←. Full transcript exists; not the default wait view.

### Surface E — cleanse board (`cleanse/board.ts:255-267`)

One-line activity: retry → intent+tool → `thinking` fallback (the word "thinking", not model reasoning).

## Community PRs / issues

### Issue #3815 (OPEN)

https://github.com/can1357/oh-my-pi/issues/3815
Author @pageton. Labels: enhancement, tui, ux, agent, triaged.
Ask: live preview of running subagent activity (current tool + key param, optional output snippet, color liveness). Explicitly not #2512 (panel chrome), #2762 (model-facing job progress).

### PR #3821 (OPEN, stale, conflicts)

https://github.com/can1357/oh-my-pi/pull/3821
Author @oldschoola. Head `feat/subagent-live-preview` @ `bc8bbab8ab40`. Created 2026-06-29, last update 2026-07-08. Labels: tui, ux, agent, triaged, feat, review:p2, vouched. Declares Closes #3815.

Files (3):

- `packages/coding-agent/CHANGELOG.md` (+4)
- `packages/coding-agent/src/modes/interactive-mode.ts` (+36 -1)
- `packages/coding-agent/test/subagent-hud-render.test.ts` (+82 -3)

Quoted mock:

```
Subagents
  ├ ● AuthLoader: Refactoring the auth flow
  │   ┎ read src/auth.ts:50-100 · 10s
```

Logic (from PR patch): after the HUD id:description row, if `progress.currentTool` or `progress.recentTools[0]`:

- `tool = currentTool ?? recentTools[0].tool`
- `detail = lastIntent ?? (currentTool ? currentToolArgs : recent.args)`
- elapsed only if `currentToolStartMs` and elapsed > 5s
- detail budgeted to viewport via `previewLine`; tool name itself is **not** truncated
- `previewLine` does not `shortenPath`

**Does not touch `tools/hub/`.** Hub wait stays empty after this PR.

Maintainer nits (@roboomp, 2026-06-29, should-fix):

1. Truncate/budget the **tool label** itself; MCP/custom names can overflow.
2. `currentToolArgs` can leak absolute home paths; `previewLine` ≠ `shortenPath`.

Also: Codex bot P2 “refresh HUD while a tool is still running”. No approval. Merge state DIRTY/CONFLICTING vs current main. ~8 weeks stale. Main already exports `previewLine`.

### Other related

- PR #5939 CLOSED: fake `fix.md`, auto-closed (unvouched).
- PR #8953 OPEN: collapse settled live task rows; not hub wait gist.
- Issue #2512 OPEN: anchored Background Jobs panel (chrome). Maintainer said go; publish was gated; no matching changelog on this checkout.
- Issue #2762: incremental progress to the **model**, not TUI.

## Other CLIs (primary sources)

### Gemini CLI (google-gemini/gemini-cli)

`packages/cli/src/ui/components/messages/SubagentProgressDisplay.tsx` + `SubagentGroupDisplay.tsx` @ `3c311beac2e78336816dd4a123db39743f9fbf85`.

- Collapsed (default): **one compact line per agent**  
  `{icon} {agentName} · {content} {args}`  
  content = last activity `displayName || content`; thought prefix `💭`; args = description or `formatToolArgs` (description / command / file_path / dir_path / query / url / target), truncated 60.
- Expanded (`ctrl+o`): full recent activity list; **thoughts** as `💭` rows; tool calls with spinner / ✓ / error + formatted args.
- Header: `Running subagent {name}...` or N-agent counts.
- Thinking **is** shown (activity type `thought`).

### OpenAI Codex CLI (openai/codex)

`codex-rs/tui/src/app/agent_status_feed.rs` @ `60fc6995608e8188c0c9f8407d6cd98676efa247`.

- `/subagents` history cell: title + up to **3 preview lines**, 6 items, 240 graphemes, indented.
- Maps last thread items: agent message / plan text, **reasoning summary last chunk**, `$ command`, `Updated N file(s)`, `MCP server/tool`, `Tool {name}`, web search, etc.
- Empty → `No recent activity yet.`
- Issue #36266 (OPEN, App variant): Subagents panel already has status + assignment; users want current focus / latest activity / model. Not CLI-merged as of that issue.

### OpenCode (anomalyco/opencode)

`packages/tui/src/routes/session/subagent-footer.tsx` @ `df35e842f59bc115bb7c0479a8e11f017d443f2c`.

- Footer when **inside** a child session: agent label + `(index of total)` + tokens/cost. Navigation Parent/Prev/Next.
- Not a parent-wait live tool gist. Issue #15915: after v1.2.16 task/subagent progress redesign, agent-type label (Explore/General) disappeared from task lines — implies parent **does** have an inline task/subagent progress line (current tool + title); first-party TUI source for that line was not fully retrieved (GitHub search 429). Web writeups of PR #15607 claim live tool-call count + currently running tool title on the Task tool; treat as secondary unless author re-verifies.

### Claude Code (docs)

https://code.claude.com/docs/en/agents.md , https://code.claude.com/docs/en/agent-view.md

- In-session subagents: `@`-mention typeahead with status; `/tasks` to list/attach/stop background items.
- `claude agents` = Agent View (separate sessions): state colors (working / needs input / completed / failed), not a one-line current-tool gist in the parent transcript.
- Task overlay `Ctrl+T` is the **task list** (`activeForm` present-tense label), not subagent tool stream.

### Crush (charmbracelet/crush)

`internal/agent/agent_tool.go` @ `6d14dd93a9e526505f7de54ae5999431bc32a793`: `agent` tool spawns a child SessionAgent and returns text. No dedicated live-progress TUI component found in that file.

## Constraints that bind any design

- TUI sanitization: `replaceTabs`, `truncateToWidth`, `shortenPath`, `PREVIEW_LIMITS` / `TRUNCATE_LENGTHS`. No ad-hoc widths.
- Running `hub wait` blocks already refresh at 500ms; extra payload must stay small (gist, not thinking stream).
- #3815 comment: 8–15 parallel rows — always-inline full output collides with height and diff cost; compact per-agent line is the industry default (Gemini collapsed; Codex 3-line cap).
- `renderAgentProgress` in `task/render.ts` is **not exported**; HUD and hub currently duplicate or omit the tool sub-row.
- Changelog: `packages/coding-agent/CHANGELOG.md` `[Unreleased]`.
- Tests: contract-level, no source-grep; HUD tests already exist; job renderer tests exist for settled preview.

## Explicit non-facts

- Whether #3821 still rebases cleanly: unverified (API mergeable flapped CONFLICTING/UNKNOWN/DIRTY).
- OpenCode parent Task-tool live line exact source: not fully retrieved.
- User did **not** authorize implementation in this turn.
