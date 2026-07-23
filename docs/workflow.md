# Multi-model coding workflow

Deterministic multi-stage coding workflow: **plan → plan review → implement (isolated) → implementation verify → code review → repair (bounded) → final verify → completed**.

The engine owns transitions. Models only return versioned artifacts. Deterministic verification cannot be overridden by model claims.

## Lifecycle

| Stage | Who | Notes |
| --- | --- | --- |
| `created` | tool `start` | No model call yet |
| `planning` | planner profile | Strict `PlanArtifact` |
| `plan_review` | independent reviewer | `approved` / `changes_requested` / `blocked` |
| `implementing` | implementer (Grok-preferred) | Isolation required; real patch/branch only |
| `implementation_verify` | verifier (no LLM) | Configured commands + policy checks |
| `code_review` | independent vendor when possible | Findings drive repair |
| `repairing` | routed repair profile | Finding IDs; escalation then block |
| `final_verify` | verifier | Only engine may move to `completed` |

Terminal states: `completed`, `blocked`, `cancelled`, `failed`.

## Tool operations

Built-in tool `workflow` supports **only**:

- `start` — create workflow (write)
- `status` — read-only snapshot (stage, attempts, artifacts, budget)
- `resume` — continue from persisted stage (write; refuses terminal)
- `cancel` — abort + persist `cancelled` (write)

## Recovery

State lives in SQLite (`workflow.storagePath` or default `workflow.db`). Artifact **content** is on disk under `~/.omp/workflow-artifacts` by default (not the repo cwd) with **sha256** metadata; load fails on hash mismatch.

`resume` reconstructs:

- current stage / version
- attempts
- artifact refs (+ content when present)
- transition log
- budget totals when stored

Exclusive `runner_owner` claims prevent two runners from advancing the same workflow silently.

Stuck lock after a hard crash (previous process died holding the lock): resume with `forceUnlock: true` (tool: `workflow op=resume forceUnlock=true`), or call engine `forceUnlock(workflowId)`. **Do not** use `cancel` solely to clear a lock if you still intend to resume — cancel is terminal. In-process cancel also aborts any registered running engine via the abort registry.

## Blocked states

Common block reasons:

- Budget exhausted (hard-stop before provider call)
- Independent reviewer unavailable (unless `workflow.degradedMode`)
- Same finding fingerprint reaches third unresolved repair cycle
- Policy / configuration failures

Inspect with `workflow op=status`. Artifacts under the workflow artifact directory retain verification logs (secrets redacted).

## Configuration

Settings group `workflow.*` (see settings schema):

- `enabled`, `storagePath`
- `degradedMode`, `requireIndependentReview`
- `maxBudgetUsd`, `maxRepairCycles`, `maxPlanCycles`, `confidenceThreshold`
- `isolationMerge`, `verificationCommands`, `verificationTimeoutMs`

Default verification commands are trusted repository checks (`git diff --check`, `bun check`). Full-suite `bun test` is opt-in via settings. Model profile mappings live in `default-config` / registry and are wired into the production engine router — **do not hardcode public model IDs in engine logic**. Exact model availability and cost claims require **local** configuration and benchmark evidence; they are not guaranteed by this package.

Unsupported profile fields (`toolAliases`, `argumentAliases`, `maxInputTokens`, `maxOutputTokens`) are rejected at construction until the structured-subagent runtime can honor them. Supported mappings include `thinkingLevel`, `disabledTools`, `maxRuntimeMs`, and `contextPolicy`.

## Safety

- No fictional patch/branch/changedFiles in production stages; verification derives changed files from readable isolation patch content
- Isolation write stages fail if `changesApplied === false` or patch is unreadable
- Write/command path policies are enforced at tool execution (not only by tool-name allowlists)
- Empty repair `addressedStepIds` does **not** auto-clear findings
- New review findings enter engine state as `open`; only evidence-bearing engine actions resolve/reject them
- Final verify fails closed on every unresolved **blocking** finding (including P2/P3 from `changes_requested`)
- Write-stage crash → `blocked` (no silent re-run)
- Abort registration is owner-scoped so concurrent resume/cancel cannot unregister another runner
- Authentication / transient provider errors advance through explicit profile fallbacks before failing
- Secret-like content redacted in durable artifacts, error summaries, and verifier logs
- Context templates live under `prompts/workflow/context-*.hbs.md`
- When workflow requests isolation and `task.isolation.mode` is `none`, session is upgraded to `auto` for that run only
- Readonly roles use plan-mode tool sets; implement/repair use scoped tool allowlists (no unrestricted task spawn)
- Per-profile `maxRequests` / `maxCostUsd` and tool-call counters restore from budget snapshots on resume
- Routing audit + resolved runtime model evidence artifacts are persisted when available
