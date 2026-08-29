# Code Review: Subagent live progress preview

- Date: 2026-08-29
- Spec: `docs/superpowers/specs/2026-08-29-subagent-live-progress-preview-design.md`
- Design Gate: `docs/superpowers/plans/2026-08-29-subagent-live-progress-preview-subagent-review.md` round 2 **PASS_WITH_NOTES**
- Reviewer axes: Standards (`subagent-sol` auth_unavailable → `claude-opus-5-thinking-high` unknown-provider → `flash-reviewer` **PASS_WITH_NOTES**) + Spec (`subagent-grok` round 3 **pass**); shadow-review fail-open
- Scope: detached-subagent compact live gist on HUD and live `hub wait` / `hub jobs` rows. Out of scope: socket-closure recovery in the same commit.

## 1. 整体结论

- **PASS_WITH_NOTES** after fix-implement.
- Dual-axis first pass: both **fail**; adopted. Second pass: Spec **pass**; Standards P3 (`#getSessions`) adopted. Round 3 Spec (`SpecReview3` / `subagent-grok`): **pass**, findings empty. Round 3 Standards (`StandardsFlash` / `flash-reviewer`): **PASS_WITH_NOTES**. Adopted: renderer comment on running-without-activity; changelog home-path phrase. Kept P3: HUD `columns - 8` activity budget (outer `truncateToWidth` clamps); `shortenHomePathsInText` homeDir-with-trailing-separator (not produced by `os.homedir()`).

## 2. 设计一致性

| Gate / spec contract | Implementation | Result |
|---|---|---|
| `forwardSyncProgress` copies `currentToolArgs` / `currentToolStartMs` including `undefined` | `copySpawnJobLiveProgress` in `task/index.ts:148-166`, used at `:1337` | Met |
| `snapshotJobs` optional `liveActivity`; running-only | `hub/jobs.ts:233-275` | Met |
| `jobsRenderResult` running sub-row; settled ignores leftover live activity | `hub/jobs.ts:769-784` | Met |
| HUD compact sub-row reuses the same helpers; live render width, not baked `terminal.columns` | `SubagentHudContainer` + `renderSubagentHudLines` in `interactive-mode.ts` | Met after live-width follow-up |
| Sanitizers + viewport budget; tool label in budget; home paths shortened | `formatCompactLiveActivityLine` + `shortenHomePathsInText` | Met after Standards fix |
| Hub tests go through spawn-copy-to-render | `job-renderer-preview.test.ts` `makeCopiedProgress` | Met |
| `liveActivity` not in model-facing `content` | `buildJobResult` running lines are id/type/label only; test at `:542-571` | Met |
| Changelog `[Unreleased]` | `packages/coding-agent/CHANGELOG.md:10` | Met |
| No progress bus / thinking_delta / three-line feed / Agent Hub rewrite / new settings | Scoped diff | Met |

## 3. Dual-axis findings and disposition

### Standards (fail → fixed)

1. **MEDIUM** Embedded home paths bypassed `shortenPath` when not the first token (`jobs.ts` formatter; `extractToolArgsPreview` can emit `cat /Users/...`).
   - **Adopted.** Added `shortenHomePathsInText` in `render-utils.ts` and wired it into `formatCompactLiveActivityLine`. Tests: helper unit cases plus HUD/hub `cat ${homeFile}` rows.
2. **P3** `SubagentHudContainer` stored the session supplier as a TypeScript `private` parameter property.
   - **Adopted.** Replaced with `readonly #getSessions`. HUD `render(width)` now pads with `getPaddingX` and no longer allocates a `Text` per frame.

### Spec (fail → fixed)

1. **HIGH** Spawn-copy-to-render did not lock `currentToolStartMs` / >5s elapsed.
   - **Adopted.** Frozen `Date.now` fixtures assert `6.0s` after copy, omit elapsed below 5s, and omit elapsed on recent-tool fallback.
2. **MEDIUM** HUD missing >5s elapsed and long MCP tool-name width contracts.
   - **Adopted.** HUD tests cover elapsed and `mcp__…` truncation to 40 columns.
3. **LOW** Non-task running jobs and failed leftover `liveActivity` had no explicit contract.
   - **Adopted.** Bash running row has no live gist; failed + leftover `liveActivity` still shows `errorText`.

### Round 3 (this session)

- Spec (`SpecReview3` / `subagent-grok`): **pass**. Findings empty. P3 notes: design §6 178–180 real-terminal smoke environment-blocked; HUD `columns - 8` activity budget covered by live 40-col clamp.
- Standards (`StandardsFlash` / `flash-reviewer`): **PASS_WITH_NOTES** after sol/opus-5 fallbacks failed.
  1. **P3** `jobs.ts` running-without-activity takes the else preview branch — **Adopted.** Comment at `jobs.ts:769-771`.
  2. **P3** HUD `activityBudget = columns - 8` — **Kept.** Outer `truncateToWidth(line, columns)` already clamps; 40-col HUD tests lock overflow.
  3. **P3** `shortenHomePathsInText` homeDir trailing-separator edge — **Kept.** `os.homedir()` does not produce it.
  4. **P3** changelog omitted home-path sanitization — **Adopted.** Unreleased gist line now says home-directory prefixes are shortened.

### Notes kept (P3, not blocking)

- Agent Hub detail continues to read session/transcript, not `JobSnapshot.liveActivity`. Design: Hub detail unchanged.
- Live TUI smoke (design §6 items 178–180) was not run: this environment has `TERM=dumb`, `CI=true`, and the CLI interactive path requires `process.stdin.isTTY === true` and `process.stdout.isTTY === true` (`cli.ts:429-433`). There is no existing InteractiveMode PTY smoke harness. In-process substitutes now include one `runSubprocess` tool-event sequence driving HUD, `hub wait` via `copySpawnJobLiveProgress`, Agent Hub detail opened through `InteractiveMode.showAgentHub()` on the same observer registry, HUD overflow at eight live rows plus `2 more running`, a 15-job live wait card that shows eight compact gists plus `7 more jobs`, a sealed `hub jobs` card with the same collapse contract, HUD overflow at 15 concurrent agents, and 40-column 15-job wait/jobs cards.

## 4. Verification (this session)

```
cd packages/coding-agent && bun test \
  test/task/executor-recent-output.test.ts \
  test/task/task-spawn.test.ts \
  test/job-renderer-preview.test.ts \
  test/tools/hub-wait.test.ts \
  test/subagent-hud-render.test.ts \
  test/agent-hub-ordering.test.ts \
  test/tools/render-utils.test.ts \
  test/modes/controllers/event-controller-task-async-updates.test.ts \
  test/job-model-badge-renderer.test.ts \
  test/task/task-progress-render.test.ts
# 180 pass, 0 fail, 1781 expect()

cd packages/coding-agent && bun check
# biome + tsgo --noEmit pass this turn (`bun check` in `packages/coding-agent/`: Checked 3048 files, no fixes; tsgo --noEmit pass).
```

`hub-wait.test.ts` starts a real `HubTool` wait, copies live progress through `copySpawnJobLiveProgress`, and renders the parent transcript card via `EventController` for live refresh, success/failure settle, 48-column truncation of copied MCP tool names, home-path shortening of copied bash args at 120 columns and live 40-column width without leaking the raw home path, one compact gist per running task job, no live gist on running bash jobs at 120 and live 40-column width, a mixed wait that draws gist only on the task job beside a hanging bash job at 120 and live 40-column width, copied MCP tool names truncated at both 48 and live 40-column width, current-tool elapsed growing from `6.0s` to `7.0s` across 500ms snapshot ticks at both 120 and live 40-column width, a compact gist that keeps `read: src/auth.ts` while excluding `recentOutput` / thinking text at 120 and live 40-column width, a wait card that prefers `lastIntent` (`read: Inspect login`) over copied `src/auth.ts` args at both 120 and live 40-column width, and a sealed `hub jobs` card with the same lastIntent-over-args contract without putting the gist in model-facing content, also at live 40-column width, a running wait card with no current/recent tool that keeps the job identity without inventing `thinking` or `no activity` text, a 15-job live wait that snapshots one compact gist per job while the collapsed EventController card shows eight gists plus `7 more jobs`, a sealed `hub jobs` card with the same 15-job snapshot/collapse contract without putting gists in model-facing content, and both 15-job wait/jobs cards stay within 40 columns while still showing eight gists plus `7 more jobs`. `hub jobs` snapshots now also land on an EventController card so the parent transcript shows the copied current-tool gist without putting it in model-facing content.

`job-renderer-preview.test.ts` copies a spawn snapshot that still carries `recentOutput` / thinking text, then asserts `snapshotJobs().liveActivity` is only `{ tool, detail }` and the renderer gist keeps `read: src/auth.ts` without those lines. Copied hub gists also keep `read: src/auth.ts` plus `6.0s`, `lastIntent` (`read: Inspect login`), and shortened `~/secret` at live 40-column width. Running bash jobs and failed leftover `liveActivity` still show no live gist at live 40-column width. `task-spawn.test.ts` drives a real detached `TaskTool` spawn through `runSubprocess` + `copySpawnJobLiveProgress` and asserts the job snapshot, wait renderer, and HUD all prefer `lastIntent` (`read: Inspect login`) over `src/auth.ts` while still showing `6.0s`, including at live 40-column width on both surfaces.

`executor-recent-output.test.ts` drives `runSubprocess` tool start/end events into the same EventBus as `InteractiveMode`. The HUD `subagentContainer` shows current-tool gist, recent fallback without elapsed, grep switch, and HUD clear after completion, including live 40-column paints that keep `read: src/auth.ts` then `grep: password` without overflowing. A sibling test copies that same snapshot onto a hanging task job, feeds `HubTool.execute` `onUpdate` into `EventController`, and opens Agent Hub via `showAgentHub()`. HUD and wait cards prefer `lastIntent` (`read: Inspect login`, then `grep: Inspect login`) over args at 120 and live 40-column width; after settle the wait card keeps `done` without the live gist at live 40-column width while Agent Hub still opens Task/AuthLoader detail, while Agent Hub Current still shows `read · src/auth.ts` then `grep · password`. After the job settles, the wait card drops the live gist for the settled result while Agent Hub still opens Task/AuthLoader detail.

`subagent-hud-render.test.ts` rebuilds the HUD from a progress-channel snapshot at `ui.terminal.columns = 40`, truncates the compact activity line to that width, keeps overflow at eight live rows plus `2 more running`, shortens `cat $HOME/secret/token.ts` to `~/secret/token.ts` at 120 columns and keeps `~/secret` without the raw home path at live 40-column width, excludes `recentOutput` / thinking text from the compact HUD activity line at 120 and live 40-column width, keeps the HUD identity line without inventing `thinking` / `no activity` when the detached subagent has no current or recent tool, including at live 40-column width, keeps `grep: password` after a progress-channel tool switch at live 40-column width, and drops AuthLoader after completion at live 40-column width, keeps first-paint `read: src/auth.ts` plus `6.0s` at live 40-column width, grows current-tool elapsed from `6.0s` to `7.0s` when a later progress snapshot rebuilds the observer, keeps eight compact rows plus `7 more running` across 15 concurrent agents at both 120 and 40 columns, with `Worker0` still visible and `Worker8` omitted at 40 columns, truncates the compact activity line to the current render width instead of a previously baked `terminal.columns`, grows current-tool elapsed from `6.0s` to `7.0s` on a later paint without emitting a new progress snapshot, including at live 40-column width, and prefers `lastIntent` (`read: Inspect login`) over current args through InteractiveMode at both 120 and live 40-column width.

`event-controller-task-async-updates.test.ts` truncates a hub-wait live card to 48 and live 40 columns on the parent transcript path, shortens home paths in the same card, including a live 40-column paint that keeps `~/secret` without the raw home path, and keeps `read: src/auth.ts` / `grep: password` then drops them for `settled body` at live 40-column width. `job-model-badge-renderer.test.ts` still renders `resolvedModel` from a shrinking progress fixture without inventing a live gist. `task-progress-render.test.ts` keeps the sync `task` current/recent tool renderer unchanged.

Implementation, dual-axis review, and review-fix loop are complete. Second dual-axis pass: Spec **pass**; Standards P3 (ES `#private` HUD callback) adopted. Round 3: Spec **pass**; Standards **PASS_WITH_NOTES** (comment + changelog adopted; remaining P3 kept). HUD identity/overflow/activity lines now clamp to the current render width (40-column 15-agent HUD stays ≤40). This turn: `cd packages/coding-agent && bun test` on the 10 live-progress files = 180 pass / 0 fail / 1781 expect; `bun check` = biome 3048 files no fixes + `tsgo --noEmit`. Production-path PTY substitutes under `script` (`TERM=xterm-256color`, stdin/stdout `isTTY=true`) painted `InteractiveMode.subagentContainer` `read: src/auth.ts · 6.0s` → `grep: password`, `HubTool.execute` wait through spawn-copy + 500ms refresh, 40-col `~/secret` without raw home, truncated MCP tool label, 15-agent HUD overflow (`Worker0`…`Worker7` + `7 more running`), and settled `settled body` without live gist. Dual-surface `runSubprocess` test also passed under the same PTY (1 pass / 55 expect). InteractiveMode HUD two-tool switch and HubTool wait two-tool switch both succeeded under PTY with a complete session stub.

## 5. Remaining issues

Not blocking Gate / dual-axis / in-process contracts. Recorded so a later operator session can finish design §6 178–180 without re-deriving the hang.

1. **Full interactive CLI hang (design §6 178–180).** `bun src/cli.ts --no-session` under PTY with no operator still hangs in `runInteractiveMode` → `while (true) await mode.getUserInput()` (`main.ts:625-628`). Earlier PID 91452 was SIGKILLed. This is the TUI input loop, not a live-gist renderer bug. Substitutes that already passed: production `renderSubagentHudLines` / `jobsRenderResult` / `HubTool.execute` wait / `InteractiveMode.subagentContainer` under `script` PTY; dual-surface executor test under PTY.
2. **Uncommitted delivery.** Live-progress source, tests, changelog, design, Gate, and this review artifact are still unstaged on `workflow` (ahead 3). HEAD `17cd763fc0` already has the first live-activity cut; unstaged follow-ups include HUD live-width/`SubagentHudContainer`, `shortenHomePathsInText`, spawn-copy tests, and renderer comment. Out-of-scope dirt is mixed in the same working tree (shadow-mind, consult, scout changelog, other plan docs). Do not commit this tree as one blob.
3. **Kept P3 (Standards, not defects).** HUD `activityBudget = columns - 8` is clamped by outer `truncateToWidth(line, columns)`. `shortenHomePathsInText` does not strip a trailing-separator `homeDir`; `os.homedir()` does not produce that form.
4. **Out of scope, unchanged.** Socket-closure recovery in the same commit; Agent Hub rewrite; progress bus / thinking_delta / three-line feed / new settings.

Confirm with `/goal complete`.
