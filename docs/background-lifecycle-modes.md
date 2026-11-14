# Background / autonomy lifecycle modes (D8)

Date: 2026-09-27. **No new permanent service in this round.**

Modes are usage paths, not a linear “higher is better” ladder. Provider request limits, task concurrency, and async job capacity remain **separate** units — do not merge into one semaphore.

## Mode table

| Mode | Existing entry / reuse | Alive after session end? | Alive after process exit? | Cancel | Auth on resume | Notes |
|---|---|---|---|---|---|---|
| Interactive | Ordinary session + tool approvals | No | No | User abort / stop | N/A | Unfinished work stays in session artifacts |
| Bounded goal | `goals/` + workflow | Goal state may persist paused | No auto-resume across process | `/goal` pause/drop + abort | Re-check host gate; no-progress opt-in default OFF | `candidate_complete` ≠ accepted |
| Multi-task | `task/` + Agent Hub + child delivery evidence | Child may park | No | Kill / release via Hub | Write ownership + integrate owner | Action queue is a view, not a scheduler |
| In-process background | `async/job-manager`, `/jobs` | Until process exit or cancel | **No** | Job cancel APIs | N/A | Products remain readable under session artifacts |
| Recover history / parked agent | Session artifacts + Hub revive | Parked record | Record only — not a running worker | Tombstone / release | **Must re-validate** auth + workspace version | Revive ≠ continue an old process |
| Cross-process cron / daemon | **Not promised** | — | — | — | — | Needs separate storage, lease, idempotency, credentials design |

## Rate-limit ownership (do not merge)

| Limiter | Unit | Hold duration | Owner |
|---|---|---|---|
| Provider request | HTTP/stream requests | Single request / retry window | `packages/ai` rate-limit + provider quirks |
| Task concurrency | Parallel child agents | Child lifetime | task spawn / workflow execution control |
| Async job capacity | Background jobs | Job lifetime | `AsyncJobManager` |

UI / Hub may show “waiting on which limiter”; they must not unify the locks. `attributeLimiterState` (`packages/coding-agent/src/latency/limiter-attribution.ts`) reports occupancy and waits **per owner** and always sets `unifiedSemaphore: false`.

## Exit / revoke matrix (verification targets)

| Event | Who still runs | Artifacts | Retry of irreversible send/publish | Verify status |
|---|---|---|---|---|
| Session stop | In-process jobs until cancelled; no new model turns | Session JSONL / outputs retained | Never auto | Fixture: `AsyncJobManager` cancel + session dispose paths; live TUI stop 未验证 |
| Main process exit | Nothing | On-disk artifacts retained | Never auto | Documented; process-exit integration 未验证 |
| Worker terminate | That worker only | Partial outputs as written | Confirm external state first | Stats/tiny workers via `omp --smoke-test`; computer worker 未验证 on all platforms |
| Auth revoke | Pending privileged tools fail closed | Unchanged | Need new user auth | Approval fail-closed unit paths; live revoke 未验证 |
| Resume after crash | Nothing until explicit revive | History readable | Unknown external results → ask user; no exactly-once | Hub revive ≠ continue process; blind replay forbidden |
| Dispose / exit diagnostics | Session writes exit marker + pending tool calls | Exit diagnostics retained | N/A | `session/exit-diagnostics.ts` + pending tool collection |

Isolate-verify notes (no new daemon, no blind replay):

- Occupancy for provider / task / job is observed separately via `observeLimiterAttribution` (`latency/limiter-observation.ts`) and shown on `/jobs` + `/context` diagnosis. Missing samples → `unknown_occupancy=…`, never a merged semaphore.
- `attributeLimiterState(...).unifiedSemaphore` is always `false`.
- Cross-process cron / permanent service remains out of scope.

## Related docs

- `docs/agent-hub.md` — roster / inspector / `/jobs` pointer
- `docs/computer-use.md` — `read_only` is not a sandbox
- `docs/approval-mode.md` — authorization tiers
- `docs/workflow.md` — orchestration
