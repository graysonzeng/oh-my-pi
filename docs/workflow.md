# Multi-model coding workflow

Deterministic multi-stage coding workflow: **plan → plan review → implement (isolated) → implementation verify → code review → repair (bounded) → final verify → completed**.

The engine owns transitions. Models only return versioned artifacts. Deterministic verification cannot be overridden by model claims.

Multi-model execution is **embedded only**: `RuntimeAdapter` → `runStructuredSubagent` with omp provider models and per-profile strategies. Vendor CLI backends (`profile.runtime` / `codex_cli` / `claude_cli`) were removed and fail closed if set.

## Lifecycle

| Stage | Who | Notes |
| --- | --- | --- |
| `created` | tool `start` | No model call yet |
| `planning` | planner profile | Strict `PlanArtifact` |
| `plan_review` | independent reviewer | `approved` / `changes_requested` / `blocked` |
| `implementing` | routed implementer profile | Isolation required; strict quality profiles capture a real patch with `apply: false` before engine-owned validation and merge |
| `implementation_verify` | verifier (no LLM) | Configured commands + policy checks |
| `code_review` | independent vendor when possible | Findings drive repair |
| `repairing` | routed repair profile | Finding IDs; escalation then block |
| `final_verify` | verifier | Only engine may move to `completed` |

Terminal states: `completed`, `blocked`, `cancelled`, `failed`.

Default profile registration order is the router preference (see `DEFAULT_MODEL_PROFILES` in `packages/coding-agent/src/workflow/default-config.ts`):

| Role | Default preference |
| --- | --- |
| planner | Claude (Fable) → GPT-Sol → GLM |
| plan_reviewer | Claude (Fable) → GPT-Sol |
| implementer | DeepSeek-V4-Flash → Grok-4.5 → GPT-5.6-Luna → session model (last resort) |
| code_reviewer | Claude (Fable) → GPT |
| repair (simple) | Grok; complex escalation → Claude/GPT |

## Tool operations

Built-in tool `workflow` supports **only**:

- `start` — create workflow (write; optional `qualityTier: balanced | critical`)
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

Strict write stages commit through a durable `prepared → applied` state machine. Before the merge starts, the engine persists a `prepared` state with the validated implementation artifact, the aggregate patch path + SHA-256, identity receipt, approved scope, and stage/attempt. A live merger that reports success is trusted to have applied: the engine verifies the persisted patch is byte-identical to the prepared hash and persists `applied` immediately, without recovery-style git proof. A merger that throws, is cancelled, or reports failure is reconciled against the tree. On every resume of `prepared`/`applied` state, the engine independently proves the persisted aggregate patch is still present and applicable only in reverse (reverse applies, forward does not); missing, reverted, empty, hash-mismatched, or ambiguous evidence fails closed without rerunning implementers or the merge seam.

Stuck lock after a hard crash (previous process died holding the lock): resume with `forceUnlock: true` (tool: `workflow op=resume forceUnlock=true`), or call engine `forceUnlock(workflowId)`. **Do not** use `cancel` solely to clear a lock if you still intend to resume — cancel is terminal. In-process cancel also aborts any registered running engine via the abort registry and waits for that runner's settlement barrier, so an in-flight merge outcome is persisted before the terminal `cancelled` state is written.

## Blocked states

Common block reasons:

- Budget exhausted (hard-stop before provider call)
- Independent reviewer unavailable (unless `workflow.degradedMode`)
- Same finding fingerprint reaches third unresolved repair cycle
- Policy / configuration failures
- Isolation write stages without a readable patch / `changesApplied === false`

**Not** a hard cancel: wall-clock profile `maxRuntimeMs` / "runtime limit exceeded" aborts map to retryable `timeout` so profile fallbacks can continue. True user/process cancel still yields terminal `cancelled`.

Inspect with `workflow op=status`. Artifacts under the workflow artifact directory retain verification logs (secrets redacted).

## Configuration

Settings group `workflow.*` (schema in `packages/coding-agent/src/config/settings-schema.ts`; also listed via `omp config list` under Modes). Prefer **nested** YAML under `workflow:` / `task:` (flat dotted keys may not bind depending on loader path):

- `enabled`, `storagePath`
- `degradedMode`, `requireIndependentReview`
- `defaultQualityTier` — optional `balanced` or `critical` tier used when configured quality routes are enabled
- `qualityRoutes` — optional ordered profile-ID lists per tier and workflow role; empty/absent preserves legacy role-router and degraded-mode behavior
- `maxBudgetUsd`, `maxRepairCycles`, `maxPlanCycles`, `confidenceThreshold`
- `isolationMerge`, `verificationCommands`, `verificationTimeoutMs`
- `profiles` — optional override map; empty uses built-in defaults

Related (not under `workflow.*`):

- `task.isolation.mode` — use `auto` or `none` (legacy bare `worktree` is invalid). When workflow requests isolation and mode is `none`, the session is upgraded to `auto` for that run only.

Default verification commands are trusted repository checks (`git diff --check`, `bun check`). Full-suite `bun test` is opt-in via settings. Model profile mappings live in `default-config` / registry and are wired into the production engine router — **do not hardcode public model IDs in engine logic**. Exact model availability and cost claims require **local** configuration and benchmark evidence; they are not guaranteed by this package.

### Profile fields

| Category | Fields | Behavior |
| --- | --- | --- |
| Supported (runtime + strategies) | `thinkingLevel`, `strictIdentity`, `disabledTools`, `maxRuntimeMs`, `contextPolicy`, `modelPattern`, `promptStrategy` / `toolStrategy` / `contextStrategy` / `outputStrategy`, `toolAliases`, `argumentAliases` | Honored via structured-subagent + schema enhancer / tool-alias wraps |
| Rejected | `maxInputTokens`, `maxOutputTokens` | Fail closed at profile registration until the runner can honor them |
| Removed | `runtime` (`codex_cli` / `claude_cli` / legacy embedded tag) | Fail closed; multi-model is embedded RuntimeAdapter only |

Default plan/code reviewer `maxRuntimeMs` is **300s** (slow gateways); implementer defaults are higher (up to 600s).

### Quality tiers and strict execution identity

When `qualityRoutes` is configured, `start` compiles the selected tier into an immutable snapshot containing ordered candidates and normalized non-secret profile fields. The persisted fingerprint is verified on resume; later settings changes cannot alter model, effort, lineage, or fallback order. Quality routes require `degradedMode: false`. Without configured routes, availability preflight remains advisory and the legacy router behavior is unchanged.

Strict profiles require one exact `provider/model` pattern and one concrete effort. Effort compatibility uses exact provider-scoped catalog facts before cross-provider family defaults. Runtime receipts keep three distinct coordinates: configured selection, local resolution, and provider/gateway attestation. Local resolution never proves execution; unknown, conflicting, mismatched, or effort-unsupported attestations fail closed.

Strict implement/repair calls run isolated with `apply: false`. The engine verifies identity, artifact schema, patch-derived scope, and changed paths before using the existing merge seam. Provider adapters aggregate identity-bearing lifecycle envelopes so a terminal model/checkpoint can enrich an earlier envelope; conflicting coordinates are rejected, and an upstream gateway-reported provider is retained separately from the transport provider.

## Safety

- No fictional patch/branch/changedFiles in production stages; verification derives changed files from readable isolation patch content
- Isolation write stages fail if `changesApplied === false` or patch is unreadable
- Write/command path policies are enforced at tool execution (not only by tool-name allowlists)
- Empty repair `addressedStepIds` does **not** auto-clear findings
- New review findings enter engine state as `open`; only evidence-bearing engine actions resolve/reject them
- Final verify fails closed on every unresolved **blocking** finding (including P2/P3 from `changes_requested`)
- Write-stage crash → `blocked` (no silent re-run)
- Abort registration is owner-scoped so concurrent resume/cancel cannot unregister another runner; `cancel` waits for the in-flight runner to settle before persisting terminal `cancelled` state
- Authentication / transient provider errors advance through explicit profile fallbacks before failing
- Secret-like content redacted in durable artifacts, error summaries, and verifier logs
- Context templates live under `prompts/workflow/context-*.hbs.md`
- When workflow requests isolation and `task.isolation.mode` is `none`, session is upgraded to `auto` for that run only
- Readonly roles use plan-mode tool sets; implement/repair use scoped tool allowlists (no unrestricted task spawn)
- Per-profile `maxRequests` / `maxCostUsd` and tool-call counters restore from budget snapshots on resume
- Routing audit + resolved runtime model evidence artifacts are persisted when available
- Model-supplied artifact `createdAt` values are coerced to ISO-8601 UTC before Zod validation (date-only / missing `Z` must not fail closed)
- Wall-clock profile `maxRuntimeMs` / "runtime limit exceeded" subagent aborts map to retryable `timeout` (not hard `cancelled`)
- Tool alias Proxies must use the underlying tool as `Reflect.get` receiver so class private-field getters (e.g. `BashTool.#asyncEnabled`) keep working

## Live multi-model verification

Optional, cost-bearing. Automated tests use injectable runners only; live smoke is opt-in.

**Credentials (gateway):** load `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (mapped to `ANTHROPIC_API_KEY`) from `~/.claude/settings.json` `env`, or export them in the shell. Do not commit tokens.

**Default protocol:** `anthropic-messages` via omp `providers.anthropic` / `models.yml`. The same gateway also answers OpenAI-compatible `POST /v1/chat/completions` (Bearer token) for dual-protocol checks.

**Harness:** `.agent-artifacts/live-e2e/run-live-e2e.ts` (local artifact; not a package test and not published).

1. Probe multiple model ids over anthropic-messages (`completeSimple` + `buildModel`).
2. Create a fixture git repo + temp `agentDir` with gateway `models.yml` and nested `config.yml` (`workflow.*`, `task.isolation.mode: auto`, lightweight `verificationCommands` for the fixture).
3. Drive production `workflow` tool via `createAgentSession`: `start` → `resume` (`singleStep`) until terminal.
4. Write redacted `.agent-artifacts/live-e2e/report.json` (no secrets).

**Pass criteria (harness):** ≥5 probe ok; durable `plan` + `review` artifacts; full path prefers terminal `completed` (with `implementation`); `blocked` after plan/review remains a minimum live success.

**Recorded full path (2026-07-25):** protocol default anthropic-messages; OpenAI chat/completions smoke ok; probes 7/7 (`claude-sonnet-5`, `claude-fable-5`, `claude-opus-4-8`, `gpt-5.6-sol`, `gpt-5.6-terra`, `grok-4.5`, `glm-5.2`); workflow `wf_61f89e3f-…` → **`completed`** (`final_verify:passed`) through plan → plan_review → implement → implementation_verify → code_review → final_verify; artifacts include `plan`, `review`, `implementation`, `verification`, `findings-state`, `routing-audit`, `usage`, `stage_handoff`, `prompt_assembly_receipt`. Details: `.agent-artifacts/live-e2e/report.json` and root `progress.md` (session notes; not a package artifact).

**Recorded quality-route fixtures (2026-08-02):** `balanced` workflow `wf_2588513c-…` and `critical` workflow `wf_dc1cf3ad-…` both reached `completed`, changed only `src/math.ts`, passed the fixture test, persisted routing/runtime/usage/scope/verification evidence, and had no model attempt in deterministic verify stages. Reports: `.agent-artifacts/quality-routing-goal/e2e-balanced-latest.json` and `e2e-critical-latest.json`. These local live checks prove route availability and execution identity only; they are not a statistical quality claim.
