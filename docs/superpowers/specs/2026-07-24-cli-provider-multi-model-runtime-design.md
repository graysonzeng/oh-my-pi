# CLI Provider Multi-Model Runtime Design

## 1. Purpose

Extend the existing deterministic workflow runtime so one workflow can use locally installed coding CLIs through a shared gateway:

- GPT and Grok through Codex CLI and the OpenAI Responses protocol.
- Claude through Claude Code CLI and the Anthropic Messages protocol.
- The existing embedded oh-my-pi structured-subagent runtime as an explicit compatibility and fallback backend.

The workflow engine remains responsible for stages, routing, budgets, artifacts, verification, recovery, and acceptance. Runtime adapters are responsible only for executing one typed model assignment and normalizing its result.

## 2. Snapshot And Evidence

This design was written against:

- Repository: `/Users/sheng/tencent/oh-my-pi`
- Branch: `workflow`
- HEAD: `36934636607e80b479cc67037bc3934f6189ced9`
- Codex CLI: `0.145.0`
- Claude Code: `2.1.178`
- Existing workflow tests: `124 pass, 0 fail`
- Existing repository type check: `bun check` passes

Verified provider behavior on 2026-07-24:

| Path | Requested model | Result | Resolved model / protocol |
| --- | --- | --- | --- |
| Codex CLI via `cli` provider | `gpt-5.6-sol` | Success | OpenAI Responses |
| Codex CLI via `cli` provider | `grok-4.5` | Success | `grok-4.5-build`, OpenAI Responses |
| Codex CLI via `cli` provider | Claude model variants | Upstream HTTP 502 | OpenAI Responses path is not accepted for Claude |
| Claude Code via `ANTHROPIC_BASE_URL` | `sonnet` | Success | `claude-sonnet-4-6`, Anthropic Messages |

Local Claude configuration evidence:

- `~/.claude/settings.json` resolves to `/Users/sheng/file/claude-code-config/claude/settings.json`.
- `ANTHROPIC_BASE_URL` points to `https://cli.688663.xyz`.
- Sonnet and Opus aliases resolve to Claude 4.6 models.
- The file contains an authentication token and currently has mode `0644`.

The implementation must never copy, print, persist, or pass the token in command arguments. The file-permission issue is a documented prerequisite and security risk, not an authorization to modify the user's shared Claude configuration.

## 3. Goals

1. Allow each `ModelProfile` to select an execution runtime independently of its vendor and model.
2. Route GPT and Grok profiles to Codex CLI and Claude profiles to Claude Code CLI.
3. Preserve the workflow state machine and all existing stage semantics.
4. Normalize structured output, provider/model identity, usage, timeout, cancellation, errors, and isolation evidence into `WorkflowAgentResult`.
5. Reuse the existing task isolation lifecycle for write-capable CLI runs.
6. Fail closed when a CLI is missing, output is invalid, isolation cannot be captured, or requested changes cannot be applied.
7. Keep unit and integration tests offline by using fake process runners and fixture output.

## 4. Non-Goals

- Do not add a new workflow state or let a model choose the next state.
- Do not force Claude through Codex CLI or `/v1/responses`.
- Do not replace the internal provider stack or `runStructuredSubagent()`.
- Do not add arbitrary user-provided shell templates or command strings.
- Do not automatically edit `~/.codex`, `~/.claude`, credentials, provider URLs, or model aliases.
- Do not persist CLI conversation sessions or hidden reasoning.
- Do not add deployment, push, pull request, issue, or external messaging behavior.
- Do not make live paid-provider calls part of automated tests.

## 5. Architectural Decision

Use a runtime dispatcher behind the existing `RuntimePort`:

```text
WorkflowEngine
    |
    v
WorkflowRuntimeDispatcher
    |-- embedded ------> RuntimeAdapter -> runStructuredSubagent()
    |-- codex_cli -----> CodexCliRuntimeAdapter -> codex exec
    `-- claude_cli ----> ClaudeCliRuntimeAdapter -> claude -p
```

`WorkflowEngine`, stages, `ModelRouter`, `BudgetLedger`, `ArtifactStore`, `Verifier`, and `WorkflowStore` continue to consume the same `RuntimePort` and `WorkflowAgentResult` contracts.

The dispatcher selects an adapter from `request.profile.runtime.kind`. Runtime selection is configuration, not vendor inference. This avoids assuming that every Anthropic model must use Claude Code or every OpenAI-compatible model must use Codex CLI.

## 6. Model Profile Contract

Add a required runtime block to normalized profiles, while treating an omitted block from existing user settings as `embedded` for backward compatibility:

```ts
export type WorkflowRuntimeKind = "embedded" | "codex_cli" | "claude_cli";

export interface WorkflowRuntimeConfig {
	kind: WorkflowRuntimeKind;
	executable?: string;
	profile?: string;
}
```

`ModelProfile` gains:

```ts
runtime?: WorkflowRuntimeConfig;
```

Rules:

- `runtime.kind` is the only dispatch key.
- `executable` is a binary name or absolute path, never a shell fragment.
- `profile` is supported only by Codex CLI and maps to `--profile`.
- Unknown fields and unsupported runtime/profile combinations fail validation.
- Existing profiles without `runtime` resolve to `{ kind: "embedded" }`.
- `modelPattern` remains `string | string[]`; a CLI adapter tries candidates in order only through workflow fallback profiles, not within one invocation.
- CLI profiles should use one exact model identifier per profile. Wildcards remain useful only for the embedded runtime.

Recommended initial built-in profiles:

| Workflow role | Primary runtime | Model | Fallback |
| --- | --- | --- | --- |
| planner | `claude_cli` | `claude-sonnet-4-6` | GPT planner on `codex_cli` |
| plan reviewer | `codex_cli` | `gpt-5.6-sol` | Claude reviewer on `claude_cli` |
| implementer | `codex_cli` | `grok-4.5` | no automatic cross-model fallback for writes |
| code reviewer | `claude_cli` | `claude-sonnet-4-6` | GPT reviewer on `codex_cli` |
| repair | `codex_cli` | `grok-4.5` | explicit reasoning repair profile only when already configured |

Exact defaults must be easy to override through `workflow.profiles`; profile validation must not silently rewrite user-selected models.

## 7. Shared Invocation Preparation

All adapters need the same workflow-owned preparation before provider-specific execution:

1. Reject an already-aborted request.
2. Validate that read-only roles do not request isolation.
3. Inject the static workflow role prompt.
4. Truncate workflow context using `contextPolicy.maxArtifactBytes`.
5. Resolve the role tool policy.
6. Remove profile-disabled tools.
7. Determine read-only versus write-capable execution.
8. Produce a provider-neutral prepared invocation.

Extract this logic from `runtime-adapter.ts` into a focused `runtime-invocation.ts`. The embedded adapter and both CLI adapters consume the same prepared shape, preventing policy drift.

No prompts may be constructed as new inline prompt content. Existing prompt `.md` imports remain the source of role instructions; the preparation layer only composes already-approved static prompt content with assignment and context.

## 8. Process Execution Boundary

Create an injectable process runner so tests do not spawn real CLIs:

```ts
export interface CliProcessRequest {
	command: string[];
	cwd: string;
	stdin: string;
	env?: Record<string, string | undefined>;
	signal?: AbortSignal;
	timeoutMs: number;
}

export interface CliProcessResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	durationMs: number;
}
```

Production execution uses `Bun.spawn()` because stdin, stdout, stderr, cancellation, timeout, and process termination must be controlled. It must:

- Pass argv as an array without a shell.
- Stream the prompt through stdin.
- Capture bounded stdout and stderr.
- Abort the child on `AbortSignal`.
- Enforce `profile.maxRuntimeMs` with `Bun.sleep()` and an abort controller.
- Await process exit and stream collection before returning.
- Redact secrets before attaching stderr to workflow errors.
- Distinguish caller cancellation from runtime timeout.

Unknown or oversized CLI output is an error. Raw CLI event streams may be retained only as redacted workflow artifacts with a configured size limit; they are not placed in workflow state rows.

## 9. Codex CLI Adapter

The Codex adapter invokes:

```text
codex exec
  --ephemeral
  --color never
  --json
  --output-schema <schema-file>
  --output-last-message <result-file>
  --model <exact-model>
  --sandbox <read-only|workspace-write>
  --cd <execution-root>
  [-p <codex-profile>]
  -
```

Rules:

- Never use `--dangerously-bypass-approvals-and-sandbox`.
- Read-only roles use `--sandbox read-only`.
- Write roles run only inside an oh-my-pi isolation worktree and use `--sandbox workspace-write`.
- `--ephemeral` prevents persistent Codex sessions.
- The schema is written to a temporary file under the workflow attempt artifact directory.
- The final structured payload is read from `--output-last-message`; JSONL stdout supplies diagnostics, resolved model hints, and usage when available.
- If final output is not valid JSON matching the workflow schema, return `schema_violation`.
- Grok and GPT use the same adapter; the model argument decides the upstream model.

The adapter reports `resolvedProvider` from Codex JSONL when present. If the CLI does not emit a provider, use `codex-cli` as the execution provider and preserve the requested model separately. Never claim an upstream-resolved model that was not present in output.

## 10. Claude Code Adapter

The Claude adapter invokes:

```text
claude
  --print
  --output-format json
  --json-schema <compact-schema-json>
  --model <exact-model>
  --permission-mode <plan|dontAsk>
  --no-session-persistence
  --disable-slash-commands
  --tools <tool-list-or-empty>
```

Rules:

- The prompt is provided on stdin, not argv.
- Read-only roles use `--permission-mode plan` and an explicit read-only tool list.
- Write roles use `--permission-mode dontAsk`, explicit allowed tools, and only an isolation worktree.
- Never use `--dangerously-skip-permissions` or `--allow-dangerously-skip-permissions`.
- Do not use `--bare` initially because the current authenticated configuration uses `ANTHROPIC_AUTH_TOKEN`; `--bare` changes auth lookup semantics.
- Use `--setting-sources user` so the verified user provider configuration is available while project/local settings cannot silently widen permissions.
- Use `--no-session-persistence` to avoid resumable external conversations.
- Parse the JSON envelope, then validate `structured_output` against the workflow schema.
- Normalize `session_id` as the raw result id, without persisting or resuming the session.
- Normalize model and usage only from fields actually emitted by Claude Code.

The initial rollout enables Claude CLI only for planner and reviewer roles. Write-capable Claude CLI execution is implemented and tested behind profile configuration but is not selected by built-in defaults until isolation and tool restrictions pass the full acceptance suite.

## 11. Structured Output

The workflow already provides `outputSchema`. CLI adapters must fail closed when it is missing because every workflow stage expects a typed artifact.

Normalization sequence:

1. Serialize the supplied JSON Schema with `JSON.stringify()`.
2. Execute the CLI with its native schema option.
3. Parse the provider envelope using structured JSON APIs.
4. Extract the candidate artifact.
5. Validate it again with the existing workflow schema validation path.
6. Return the parsed artifact only after local validation succeeds.

Provider-side schema enforcement is helpful but not trusted as the sole validator.

## 12. Isolation And Change Evidence

Write-capable CLI runs must reuse task isolation rather than modifying the parent worktree directly.

Generalize `runIsolatedSubprocess()` into a callback-based isolation primitive:

```ts
runIsolatedExecution({
	...isolationOptions,
	run: worktree => Promise<SingleResult>,
})
```

Keep `runIsolatedSubprocess()` as a compatibility wrapper that calls the generic primitive with `runSubprocess()`.

CLI adapters create a normalized `SingleResult`, use the generic isolation lifecycle to capture a patch or branch, and call the existing `mergeIsolatedChanges()` plus `applyEligibleNestedPatches()` logic. This preserves:

- Dirty baseline handling.
- Patch and branch merge modes.
- Nested repository evidence.
- Conflict preservation.
- Fail-closed `changesApplied` semantics.
- Durable patch copying for verification.

If a write role returns no patch artifact in patch mode, the attempt fails. Model-reported `changedFiles` never substitutes for isolation evidence.

## 13. Error Taxonomy

Map process and envelope failures into existing `WorkflowErrorKind` values:

| Condition | Error kind |
| --- | --- |
| executable missing, invalid runtime config | `configuration` |
| 401/403, auth/login/credential failure | `authentication` |
| budget or quota rejection | `quota` |
| 429 or explicit rate limit | `rate_limit` |
| adapter wall-clock expiry | `timeout` |
| caller abort or terminated signal | `cancelled` |
| 502/503/overload/retryable transport | `provider_transient` |
| unsupported model or stable 4xx | `provider_permanent` |
| malformed envelope or invalid artifact | `schema_violation` |
| CLI tool execution failure | `tool_failure` |
| isolation setup/apply failure | `configuration`, `merge_conflict`, or `policy_violation` as appropriate |
| unexpected parser/runtime defect | `internal` |

Error classification must use exit status and parsed provider error fields before regex matching stderr. Stderr is always redacted and truncated.

## 14. Usage And Cost

Normalize emitted usage into the existing `Usage` shape:

- input tokens
- output tokens
- cache-read tokens
- cache-write tokens
- total tokens
- total cost when explicitly reported

Missing values remain zero or undefined according to the existing `Usage` contract. Do not estimate monetary cost inside CLI adapters from model names. If a CLI does not emit cost, workflow cost controls rely on request and token budgets and report cost as unavailable.

`toolCalls` comes from CLI events when available. Unknown tool-call counts remain undefined rather than zero.

## 15. Persistence And Resume

No workflow database schema change is required. Existing attempt and artifact records already persist:

- selected profile id
- resolved provider/model evidence
- usage JSON
- error kind and summary
- patch or branch artifacts
- workflow transition state

External CLI sessions are deliberately ephemeral. Resume restarts the interrupted workflow stage as a new attempt using persisted workflow artifacts; it never resumes a Codex or Claude conversation id.

## 16. Observability And Redaction

Add structured debug logs through `logger`, never `console`:

- runtime kind
- executable basename
- workflow id and attempt id
- role and profile id
- requested and resolved model
- duration and exit code
- normalized error kind
- whether isolation evidence was captured/applied
- token counts and reported cost

Never log:

- environment values
- authentication tokens
- complete CLI argv when it could contain schema or sensitive paths
- raw prompts
- raw stdout/stderr before redaction
- contents of `~/.claude/settings.json` or `~/.codex` auth files

## 17. Configuration And Preflight

Production runtime creation performs cheap preflight lazily on first use of each runtime kind:

- Resolve `codex` and `claude` using `$which()` unless an absolute executable was configured.
- Verify the binary is executable.
- Reject shell metacharacter-based executable values.
- Do not call a model during preflight.
- Do not read or validate secret values.

The workflow status output should expose the runtime kind and requested/resolved model through existing attempt evidence. A separate health command is outside this change.

Operational prerequisite:

- The owner should restrict `/Users/sheng/file/claude-code-config/claude/settings.json` from mode `0644` to a user-only mode after reviewing other consumers. The implementation session must report this risk but must not change the shared file without explicit authorization.

## 18. Degraded And Fallback Behavior

- Workflow fallback remains profile-based and bounded by `retryPolicy`.
- A CLI adapter never silently falls back to the embedded runtime.
- Authentication failures may advance to an explicitly configured fallback profile.
- Write-stage profiles do not automatically switch model/runtime after partial changes; isolation is cleaned or evidence is preserved before engine fallback.
- Vendor-diversity checks use the profile vendor, while runtime diversity is recorded separately.
- `degradedMode` continues to affect independent-review requirements only.

## 19. Rollout

### Phase 1: Contracts And Offline Tests

- Add runtime config validation and dispatcher tests.
- Add process runner and parser fixtures.
- Generalize isolation execution with compatibility tests.
- No built-in profile changes.

### Phase 2: Read-Only Claude CLI

- Enable Claude CLI for planner and reviewer profiles.
- Run offline contract tests and an explicitly authorized one-step live planner smoke.
- Verify no files change and no session is persisted.

### Phase 3: Codex CLI GPT/Grok

- Enable GPT review/planning and Grok implementation profiles.
- Run an explicitly authorized isolated live smoke in a disposable fixture repository.
- Verify patch capture, application, verification, cancellation, and error mapping.

### Phase 4: Default Profile Switch

- Change built-in runtime defaults only after Phase 2 and Phase 3 acceptance criteria pass.
- Preserve `embedded` as a documented override and fallback option.

## 20. Rollback

Rollback is configuration-first:

1. Set affected profiles to `runtime.kind = "embedded"`.
2. Restore previous built-in profile runtime defaults if the release changed them.
3. Leave workflow state and artifact schemas unchanged so existing workflows remain resumable.
4. If isolation regressions occur, disable CLI write profiles while retaining read-only CLI profiles.

No database migration rollback is needed.

## 21. Test Strategy

Automated tests use injected process runners and temporary repositories. They cover:

- Runtime config validation and backward compatibility.
- Dispatcher selection for all three runtime kinds.
- Exact argv and stdin behavior without secrets.
- Codex JSONL and final-message parsing.
- Claude JSON envelope and structured-output parsing.
- Usage and resolved-model normalization.
- Missing executable, auth, quota, rate limit, timeout, cancellation, transient, permanent, schema, and tool failures.
- Read-only permission flags.
- Write-role isolation, patch capture, apply success, no-change behavior, and merge failure.
- Existing embedded runtime behavior.
- Engine fallback and resume across mixed runtime profiles.

Required final verification:

```bash
bun test packages/coding-agent/test/workflow
bun test packages/coding-agent/test/task/isolation-runner.test.ts
bun check
git diff --check
```

Live provider smoke tests are manual, opt-in, cost-bearing verification and are never part of CI.

## 22. Acceptance Criteria

1. A workflow can route Claude, GPT, and Grok profiles to the intended CLI runtime without changing workflow stage semantics.
2. Claude succeeds through Claude Code's Anthropic Messages path and is never sent through Codex Responses by default.
3. GPT and Grok execute through Codex CLI using exact configured model ids.
4. Every successful stage returns a locally validated workflow artifact.
5. Cancellation terminates the child and yields `cancelled`; timeout yields `timeout`.
6. Write stages never run in the parent worktree and produce trusted patch or branch evidence.
7. Missing binaries, invalid config, invalid output, and unapplied changes fail closed.
8. Existing embedded workflow tests remain green.
9. Automated tests make no real model calls and contain no credentials.
10. Logs, artifacts, errors, and documentation contain no secret values.
11. Mixed-runtime fallback and process-restart resume preserve budgets and attempt evidence.
12. The final diff passes focused tests, `bun check`, `git diff --check`, and a read-only code audit.

