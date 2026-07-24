# CLI Provider Multi-Model Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` or `executing-plans` to implement this plan task-by-task. Track every checkbox. Repository instructions forbid commits unless the user explicitly authorizes them, so use diff checkpoints instead of the commit steps commonly found in generic plans.

**Goal:** Add a mixed CLI runtime to the existing workflow so Claude runs through Claude Code, GPT/Grok run through Codex CLI, and the deterministic workflow engine keeps its current stages, policies, recovery, budgets, and verification gates.

**Architecture:** Add a `RuntimePort` dispatcher selected by `ModelProfile.runtime.kind`. Extract shared workflow invocation policy from the embedded adapter, add injectable CLI process and parser boundaries, and generalize task isolation to accept external execution callbacks. Production wiring creates embedded, Codex CLI, and Claude CLI adapters; tests use fake runners and temporary repositories only.

**Tech Stack:** Bun 1.3.14+, TypeScript, `Bun.spawn`, existing workflow schemas and error types, existing task isolation/worktree runtime, Bun tests, Biome through `bun check`.

---

## 1. Execution Context

Read these before editing:

- `AGENTS.md`
- `docs/superpowers/specs/2026-07-24-cli-provider-multi-model-runtime-design.md`
- This plan
- `packages/coding-agent/src/workflow/types.ts`
- `packages/coding-agent/src/workflow/runtime-adapter.ts`
- `packages/coding-agent/src/workflow/runtime-default.ts`
- `packages/coding-agent/src/workflow/default-config.ts`
- `packages/coding-agent/src/workflow/model-profile-registry.ts`
- `packages/coding-agent/src/workflow/session-config.ts`
- `packages/coding-agent/src/task/isolation-runner.ts`
- `packages/coding-agent/src/task/structured-subagent.ts`

Revalidate the branch and baseline before edits:

```bash
git status --short --branch
git rev-parse HEAD
codex --version
claude --version
```

Expected initial snapshot when this plan was written:

```text
branch: workflow
head: 36934636607e80b479cc67037bc3934f6189ced9
codex-cli: 0.145.0
claude-code: 2.1.178
```

If the branch, HEAD, or relevant interfaces changed, reconcile this plan with the current code and record the differences before implementation. Do not reset or discard user changes.

## 2. File Map

### New production files

- `packages/coding-agent/src/workflow/runtime-invocation.ts`
  - Shared prompt, context, role-policy, tool-policy, and isolation validation.
- `packages/coding-agent/src/workflow/cli-process.ts`
  - Shell-free process execution with stdin, timeout, cancellation, bounded output, and injectable runner types.
- `packages/coding-agent/src/workflow/cli-runtime-result.ts`
  - Shared usage, error, model identity, and `SingleResult` normalization helpers.
- `packages/coding-agent/src/workflow/codex-cli-runtime.ts`
  - Codex argv construction, JSONL parsing, final artifact extraction, and isolated write execution.
- `packages/coding-agent/src/workflow/claude-cli-runtime.ts`
  - Claude argv construction, JSON envelope parsing, structured output extraction, and isolated write execution.
- `packages/coding-agent/src/workflow/runtime-dispatcher.ts`
  - `RuntimePort` implementation that selects embedded, Codex CLI, or Claude CLI.

### Modified production files

- `packages/coding-agent/src/workflow/types.ts`
  - Runtime configuration types and `ModelProfile.runtime`.
- `packages/coding-agent/src/workflow/model-profile-registry.ts`
  - Runtime validation and backward-compatible normalization.
- `packages/coding-agent/src/workflow/session-config.ts`
  - Preserve normalized runtime configuration when merging profile settings.
- `packages/coding-agent/src/workflow/runtime-adapter.ts`
  - Consume shared invocation preparation; retain embedded behavior.
- `packages/coding-agent/src/workflow/runtime-default.ts`
  - Build the mixed runtime dispatcher and CLI isolation dependencies.
- `packages/coding-agent/src/workflow/default-config.ts`
  - Add runtime declarations and staged default profile selection.
- `packages/coding-agent/src/workflow/index.ts`
  - Star-export new public workflow modules.
- `packages/coding-agent/src/task/isolation-runner.ts`
  - Add callback-based generic isolation execution and keep current wrapper.
- `packages/coding-agent/src/config/settings-schema.ts`
  - Clarify `workflow.profiles` runtime configuration in the UI description.
- `packages/coding-agent/CHANGELOG.md`
  - Add an `[Unreleased]` entry when runtime behavior is enabled.

### New tests

- `packages/coding-agent/test/workflow/runtime-invocation.test.ts`
- `packages/coding-agent/test/workflow/cli-process.test.ts`
- `packages/coding-agent/test/workflow/cli-runtime-result.test.ts`
- `packages/coding-agent/test/workflow/codex-cli-runtime.test.ts`
- `packages/coding-agent/test/workflow/claude-cli-runtime.test.ts`
- `packages/coding-agent/test/workflow/runtime-dispatcher.test.ts`
- `packages/coding-agent/test/workflow/mixed-runtime-engine.test.ts`

### Modified tests

- `packages/coding-agent/test/workflow/runtime-adapter.test.ts`
- `packages/coding-agent/test/workflow/session-config.test.ts`
- `packages/coding-agent/test/workflow/model-router.test.ts`
- `packages/coding-agent/test/task/isolation-runner.test.ts`

## 3. Implementation Tasks

### Task 1: Add Runtime Configuration To Model Profiles

**Files:**

- Modify: `packages/coding-agent/src/workflow/types.ts`
- Modify: `packages/coding-agent/src/workflow/model-profile-registry.ts`
- Modify: `packages/coding-agent/test/workflow/session-config.test.ts`
- Create: `packages/coding-agent/test/workflow/runtime-dispatcher.test.ts`

- [ ] **Step 1: Write failing profile-normalization tests**

Add tests proving that omitted runtime config resolves to embedded, valid CLI configs survive settings merging, and invalid combinations fail.

```ts
it("defaults profiles without runtime to embedded", () => {
	const profile = normalizeModelProfile({ ...DEFAULT_MODEL_PROFILES.claude_planner, runtime: undefined });
	expect(profile.runtime).toEqual({ kind: "embedded" });
});

it("keeps a codex cli executable and profile", () => {
	const profile = normalizeModelProfile({
		...DEFAULT_MODEL_PROFILES.gpt_planner,
		runtime: { kind: "codex_cli", executable: "/opt/homebrew/bin/codex", profile: "cli" },
	});
	expect(profile.runtime).toEqual({
		kind: "codex_cli",
		executable: "/opt/homebrew/bin/codex",
		profile: "cli",
	});
});

it("rejects a claude runtime carrying a codex profile", () => {
	expect(() =>
		normalizeModelProfile({
			...DEFAULT_MODEL_PROFILES.claude_planner,
			runtime: { kind: "claude_cli", profile: "cli" },
		}),
	).toThrow(/profile.*codex_cli/i);
});
```

- [ ] **Step 2: Run the tests and confirm the missing contract**

```bash
bun test packages/coding-agent/test/workflow/session-config.test.ts packages/coding-agent/test/workflow/runtime-dispatcher.test.ts
```

Expected: failure because runtime types and `normalizeModelProfile()` do not exist.

- [ ] **Step 3: Add types and normalization**

In `types.ts` add:

```ts
export type WorkflowRuntimeKind = "embedded" | "codex_cli" | "claude_cli";

export interface WorkflowRuntimeConfig {
	kind: WorkflowRuntimeKind;
	executable?: string;
	profile?: string;
}
```

Add to `ModelProfile`:

```ts
runtime?: WorkflowRuntimeConfig;
```

In `model-profile-registry.ts` export:

```ts
export function normalizeModelProfile(profile: ModelProfile): ModelProfile {
	const runtime = profile.runtime ?? { kind: "embedded" as const };
	if (runtime.kind !== "codex_cli" && runtime.profile !== undefined) {
		throw new WorkflowPolicyError("runtime_profile_only_supported_by_codex_cli", {
			profileId: profile.id,
			runtimeKind: runtime.kind,
		});
	}
	if (runtime.executable !== undefined && !runtime.executable.trim()) {
		throw new WorkflowPolicyError("runtime_executable_must_not_be_empty", { profileId: profile.id });
	}
	return { ...profile, runtime };
}
```

Update `assertSupportedModelProfile()` to call normalization and validate the three known kinds. Do not infer runtime from vendor.

- [ ] **Step 4: Normalize settings profiles**

In `session-config.ts`, normalize every merged profile before returning it:

```ts
const normalized = normalizeModelProfile(profile);
assertSupportedModelProfile(normalized);
merged[key] = normalized;
```

- [ ] **Step 5: Run focused tests**

```bash
bun test packages/coding-agent/test/workflow/session-config.test.ts packages/coding-agent/test/workflow/runtime-dispatcher.test.ts
```

Expected: pass.

- [ ] **Step 6: Record a diff checkpoint**

```bash
git diff -- packages/coding-agent/src/workflow/types.ts packages/coding-agent/src/workflow/model-profile-registry.ts packages/coding-agent/src/workflow/session-config.ts packages/coding-agent/test/workflow
```

Do not commit unless explicitly authorized.

### Task 2: Extract Shared Invocation Preparation

**Files:**

- Create: `packages/coding-agent/src/workflow/runtime-invocation.ts`
- Create: `packages/coding-agent/test/workflow/runtime-invocation.test.ts`
- Modify: `packages/coding-agent/src/workflow/runtime-adapter.ts`
- Modify: `packages/coding-agent/test/workflow/runtime-adapter.test.ts`

- [ ] **Step 1: Write failing policy-equivalence tests**

Cover prompt injection, context truncation, disabled tools, read-only isolation rejection, and write policy attachment.

```ts
it("prepares the same strict role policy for every runtime", () => {
	const prepared = prepareWorkflowInvocation(baseRequest({
		role: "implementer",
		profile: { ...profile, disabledTools: ["delete"] },
	}));
	expect(prepared.assignment).toBe("implement safely");
	expect(prepared.context).toContain("## Context");
	expect(prepared.allowedTools).not.toContain("delete");
	expect(prepared.readonly).toBe(false);
	expect(prepared.isolationRequested).toBe(true);
});
```

- [ ] **Step 2: Run tests and verify failure**

```bash
bun test packages/coding-agent/test/workflow/runtime-invocation.test.ts packages/coding-agent/test/workflow/runtime-adapter.test.ts
```

Expected: failure because `prepareWorkflowInvocation` is missing.

- [ ] **Step 3: Create the prepared invocation type**

```ts
export interface PreparedWorkflowInvocation {
	request: WorkflowAgentRequest;
	assignment: string;
	context?: string;
	readonly: boolean;
	isolation?: WorkflowIsolationControls;
	isolationRequested: boolean;
	allowedTools?: string[];
	session: ToolSession;
}
```

Move `WORKFLOW_PROMPTS`, `injectWorkflowPrompt`, context truncation, role policy resolution, disabled-tool filtering, session wrapping, and read-only isolation rejection into this module.

- [ ] **Step 4: Refactor the embedded adapter**

Replace its inline preparation with:

```ts
const prepared = prepareWorkflowInvocation(request);
const mappedRequest: StructuredRunnerRequest = {
	session: prepared.session,
	invocationKind: "task",
	assignment: prepared.assignment,
	context: prepared.context,
	agent: RuntimeAdapter.agentNameForRole(request.role),
	model: request.profile.modelPattern,
	thinkingLevel: request.profile.thinkingLevel,
	outputSchema: request.outputSchema,
	schemaMode: "strict",
	isolation: prepared.isolation,
	maxRuntimeMs: request.profile.maxRuntimeMs,
	signal: request.signal,
	retainArtifacts: prepared.isolationRequested,
	workflowId: request.workflowId,
	attemptId: request.attemptId,
	allowedTools: prepared.allowedTools,
};
```

- [ ] **Step 5: Run focused tests**

```bash
bun test packages/coding-agent/test/workflow/runtime-invocation.test.ts packages/coding-agent/test/workflow/runtime-adapter.test.ts packages/coding-agent/test/workflow/tool-policy.test.ts
```

Expected: pass with no embedded behavior changes.

### Task 3: Add A Controlled CLI Process Runner

**Files:**

- Create: `packages/coding-agent/src/workflow/cli-process.ts`
- Create: `packages/coding-agent/test/workflow/cli-process.test.ts`

- [ ] **Step 1: Write failing process-boundary tests**

Use `bun -e` child fixtures, not Codex or Claude:

```ts
it("writes stdin and captures stdout without a shell", async () => {
	const result = await runCliProcess({
		command: [process.execPath, "-e", "process.stdin.pipe(process.stdout)"],
		cwd: process.cwd(),
		stdin: "hello",
		timeoutMs: 5_000,
	});
	expect(result.exitCode).toBe(0);
	expect(result.stdout).toBe("hello");
});

it("classifies timeout separately from cancellation", async () => {
	await expect(runCliProcess({
		command: [process.execPath, "-e", "await Bun.sleep(5000)"],
		cwd: process.cwd(),
		stdin: "",
		timeoutMs: 10,
	})).rejects.toBeInstanceOf(WorkflowTimeoutError);
});
```

- [ ] **Step 2: Run the test and confirm failure**

```bash
bun test packages/coding-agent/test/workflow/cli-process.test.ts
```

- [ ] **Step 3: Implement the public types and runner**

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

export type CliProcessRunner = (request: CliProcessRequest) => Promise<CliProcessResult>;
```

Production `runCliProcess()` uses `Bun.spawn()` with `stdin: "pipe"`, `stdout: "pipe"`, `stderr: "pipe"`; reads streams concurrently; terminates on signal or timeout; and rejects output exceeding a named byte limit.

- [ ] **Step 4: Add missing-executable and abort tests**

Assert:

```ts
await expect(runCliProcess({
	command: ["definitely-missing-omp-cli"],
	cwd: process.cwd(),
	stdin: "",
	timeoutMs: 1_000,
})).rejects.toMatchObject({ kind: "configuration" });
```

Use an `AbortController` to verify caller abort maps to `WorkflowCancelledError`.

- [ ] **Step 5: Run focused tests**

```bash
bun test packages/coding-agent/test/workflow/cli-process.test.ts
```

Expected: pass without lingering child processes.

### Task 4: Generalize Isolation For External CLI Execution

**Files:**

- Modify: `packages/coding-agent/src/task/isolation-runner.ts`
- Modify: `packages/coding-agent/test/task/isolation-runner.test.ts`

- [ ] **Step 1: Write a failing callback isolation test**

Create a temporary git repository and pass a callback that writes one file in the provided worktree:

```ts
const result = await runIsolatedExecution({
	context,
	preferredBackend: undefined,
	agentId: "cli-test",
	mergeMode: "patch",
	artifactsDir,
	buildFailureResult,
	run: async worktree => {
		await Bun.write(path.join(worktree, "from-cli.txt"), "ok\n");
		return successfulSingleResult("cli-test");
	},
});
expect(result.patchPath).toBeTruthy();
expect(await Bun.file(result.patchPath!).text()).toContain("from-cli.txt");
```

- [ ] **Step 2: Run the isolation test and verify failure**

```bash
bun test packages/coding-agent/test/task/isolation-runner.test.ts
```

- [ ] **Step 3: Add the generic isolation API**

```ts
export interface IsolatedExecutionOptions
	extends Omit<IsolatedRunOptions, "baseOptions"> {
	run: (worktree: string) => Promise<SingleResult>;
}

export async function runIsolatedExecution(opts: IsolatedExecutionOptions): Promise<SingleResult> {
	// Keep the existing ensure, baseline clone, patch/branch capture, and cleanup body.
	// Replace the hard-coded runSubprocess call with opts.run(isolationDir).
}
```

Keep the existing API as a wrapper:

```ts
export async function runIsolatedSubprocess(opts: IsolatedRunOptions): Promise<SingleResult> {
	return runIsolatedExecution({
		...opts,
		run: worktree => runSubprocess({
			...opts.baseOptions,
			worktree,
			preloadedExtensionPaths: undefined,
			preloadedCustomToolPaths: undefined,
		}),
	});
}
```

- [ ] **Step 4: Prove compatibility and merge behavior**

Run:

```bash
bun test packages/coding-agent/test/task/isolation-runner.test.ts packages/coding-agent/test/task/structured-subagent.test.ts
```

Expected: all existing isolation and structured-subagent tests pass.

### Task 5: Add Shared CLI Result Normalization

**Files:**

- Create: `packages/coding-agent/src/workflow/cli-runtime-result.ts`
- Create: `packages/coding-agent/test/workflow/cli-runtime-result.test.ts`

- [ ] **Step 1: Write failing usage and error tests**

```ts
it("normalizes emitted token usage without estimating cost", () => {
	const usage = normalizeCliUsage({ input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 3 });
	expect(usage).toMatchObject({ input: 10, output: 4, cacheRead: 3, cacheWrite: 0, totalTokens: 17 });
	expect(usage.cost.total).toBe(0);
});

it("prefers parsed status over stderr regex", () => {
	const error = classifyCliFailure({ exitCode: 1, status: 429, stderr: "request failed" });
	expect(error.kind).toBe("rate_limit");
});
```

- [ ] **Step 2: Implement named helpers**

Add:

```ts
export interface CliUsageLike {
	input_tokens?: number;
	output_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
	total_cost_usd?: number;
}

export function normalizeCliUsage(source: CliUsageLike | undefined): Usage | undefined;
export function classifyCliFailure(input: CliFailureInput): WorkflowError;
export function createCliSingleResult(input: CliSingleResultInput): SingleResult;
export function parseExactCliModel(modelPattern: string | string[]): string;
```

`parseExactCliModel()` rejects arrays with more than one entry and wildcard characters for CLI profiles. Fallback belongs to workflow profiles.

- [ ] **Step 3: Add redaction and truncation assertions**

Feed stderr containing fields named `token`, `api_key`, and `authorization`; assert the returned error contains redacted markers and never the source values.

- [ ] **Step 4: Run focused tests**

```bash
bun test packages/coding-agent/test/workflow/cli-runtime-result.test.ts
```

### Task 6: Implement Codex CLI Runtime Parsing And Read-Only Execution

**Files:**

- Create: `packages/coding-agent/src/workflow/codex-cli-runtime.ts`
- Create: `packages/coding-agent/test/workflow/codex-cli-runtime.test.ts`

- [ ] **Step 1: Create fixture-driven failing tests**

The fake runner must capture argv/stdin and return representative JSONL plus a final-message file payload. Assert:

```ts
expect(call.command).toContain("exec");
expect(call.command).toContain("--ephemeral");
expect(call.command).toContain("--json");
expect(call.command).toContain("--sandbox");
expect(call.command).toContain("read-only");
expect(call.command).not.toContain("--dangerously-bypass-approvals-and-sandbox");
expect(call.stdin).toContain("review the plan");
expect(result.artifact).toEqual(planArtifact());
```

- [ ] **Step 2: Run and confirm failure**

```bash
bun test packages/coding-agent/test/workflow/codex-cli-runtime.test.ts
```

- [ ] **Step 3: Implement argv construction**

Export a pure builder for exact testing:

```ts
export function buildCodexCliCommand(input: CodexCliCommandInput): string[] {
	const command = [
		input.executable,
		"exec",
		"--ephemeral",
		"--color",
		"never",
		"--json",
		"--output-schema",
		input.schemaPath,
		"--output-last-message",
		input.resultPath,
		"--model",
		input.model,
		"--sandbox",
		input.readonly ? "read-only" : "workspace-write",
		"--cd",
		input.cwd,
	];
	if (input.profile) command.push("--profile", input.profile);
	command.push("-");
	return command;
}
```

- [ ] **Step 4: Implement the adapter read path**

```ts
export class CodexCliRuntimeAdapter implements RuntimePort {
	constructor(options: CodexCliRuntimeOptions) {}
	buildRequest(request: WorkflowAgentRequest): WorkflowAgentRequest { return request; }
	async run<TArtifact>(request: WorkflowAgentRequest): Promise<WorkflowAgentResult<TArtifact>>;
}
```

The adapter prepares the invocation, writes schema/result temp files with Bun APIs, runs the process, parses JSONL with `Bun.JSONL.parse()`, reads the final message with `Bun.file()`, parses JSON, and returns normalized evidence.

- [ ] **Step 5: Add negative tests**

Cover missing `outputSchema`, invalid final JSON, non-zero exit, 401/429/502 events, timeout, and caller cancellation.

- [ ] **Step 6: Run focused tests**

```bash
bun test packages/coding-agent/test/workflow/codex-cli-runtime.test.ts packages/coding-agent/test/workflow/cli-process.test.ts packages/coding-agent/test/workflow/cli-runtime-result.test.ts
```

### Task 7: Add Codex CLI Isolated Write Execution

**Files:**

- Modify: `packages/coding-agent/src/workflow/codex-cli-runtime.ts`
- Modify: `packages/coding-agent/test/workflow/codex-cli-runtime.test.ts`
- Modify: `packages/coding-agent/src/workflow/runtime-default.ts`

- [ ] **Step 1: Write a failing isolated implementation test**

Use a real temporary git repository and a fake process runner that writes a file into `request.cwd`. Assert:

```ts
expect(call.command).toContain("workspace-write");
expect(call.cwd).not.toBe(parentRepo);
expect(result.patchPath).toBeTruthy();
expect(result.changesApplied).toBe(true);
expect(await Bun.file(path.join(parentRepo, "implemented.txt")).text()).toBe("grok\n");
```

- [ ] **Step 2: Run and confirm failure**

```bash
bun test packages/coding-agent/test/workflow/codex-cli-runtime.test.ts
```

- [ ] **Step 3: Wire the generic isolation lifecycle**

For write roles:

```ts
const context = await prepareIsolationContext(request.session.cwd);
const singleResult = await runIsolatedExecution({
	context,
	preferredBackend: parseIsolationMode(request.session.settings.get("task.isolation.mode")),
	agentId: request.attemptId,
	mergeMode: prepared.isolation?.merge ?? "patch",
	artifactsDir,
	buildCommitMessage: makeIsolationCommitMessage(request.session),
	buildFailureResult: error => createCliFailureSingleResult(request, error),
	run: worktree => this.#runInDirectory(request, prepared, worktree),
});
```

Then apply with `mergeIsolatedChanges()` and `applyEligibleNestedPatches()`. Preserve a durable patch under the workflow artifact directory before temporary cleanup.

- [ ] **Step 4: Add fail-closed tests**

Cover:

- requested write without isolation
- successful CLI exit with missing patch evidence
- apply conflict
- `apply: false`
- empty patch as a valid no-op

- [ ] **Step 5: Run focused isolation tests**

```bash
bun test packages/coding-agent/test/workflow/codex-cli-runtime.test.ts packages/coding-agent/test/task/isolation-runner.test.ts
```

### Task 8: Implement Claude Code Runtime

**Files:**

- Create: `packages/coding-agent/src/workflow/claude-cli-runtime.ts`
- Create: `packages/coding-agent/test/workflow/claude-cli-runtime.test.ts`

- [ ] **Step 1: Write failing argv and envelope tests**

Assert the read-only command includes:

```ts
expect(call.command).toEqual(expect.arrayContaining([
	"--print",
	"--output-format", "json",
	"--json-schema", JSON.stringify(request.outputSchema),
	"--model", "claude-sonnet-4-6",
	"--permission-mode", "plan",
	"--no-session-persistence",
	"--disable-slash-commands",
	"--setting-sources", "user",
]));
expect(call.command).not.toContain("--dangerously-skip-permissions");
```

Use a JSON envelope fixture with `session_id`, `model`, `usage`, and `structured_output`; assert normalization.

- [ ] **Step 2: Run and confirm failure**

```bash
bun test packages/coding-agent/test/workflow/claude-cli-runtime.test.ts
```

- [ ] **Step 3: Implement the pure command builder**

```ts
export function buildClaudeCliCommand(input: ClaudeCliCommandInput): string[] {
	return [
		input.executable,
		"--print",
		"--output-format", "json",
		"--json-schema", input.schemaJson,
		"--model", input.model,
		"--permission-mode", input.readonly ? "plan" : "dontAsk",
		"--no-session-persistence",
		"--disable-slash-commands",
		"--setting-sources", "user",
		"--tools", input.tools.join(","),
	];
}
```

- [ ] **Step 4: Implement read-only execution and parsing**

Use `prepareWorkflowInvocation()`, pass prompt on stdin, parse stdout as one JSON object, extract `structured_output`, and return only emitted model/usage evidence.

- [ ] **Step 5: Implement write execution behind profile configuration**

Reuse the same generic isolation lifecycle as Codex. Do not select it in built-in write profiles during this task.

- [ ] **Step 6: Add failure tests**

Cover auth failure, invalid settings response, schema mismatch, tool failure, timeout, cancellation, and missing executable. Verify no shared settings file is written.

- [ ] **Step 7: Run focused tests**

```bash
bun test packages/coding-agent/test/workflow/claude-cli-runtime.test.ts packages/coding-agent/test/task/isolation-runner.test.ts
```

### Task 9: Add Runtime Dispatcher

**Files:**

- Create: `packages/coding-agent/src/workflow/runtime-dispatcher.ts`
- Modify: `packages/coding-agent/test/workflow/runtime-dispatcher.test.ts`
- Modify: `packages/coding-agent/src/workflow/index.ts`

- [ ] **Step 1: Write dispatch contract tests**

```ts
it.each([
	["embedded", "embedded-result"],
	["codex_cli", "codex-result"],
	["claude_cli", "claude-result"],
] as const)("dispatches %s", async (kind, expected) => {
	const dispatcher = new WorkflowRuntimeDispatcher({ embedded, codexCli, claudeCli });
	const result = await dispatcher.run(baseRequest({ profile: { ...profile, runtime: { kind } } }));
	expect(result.rawResultId).toBe(expected);
});
```

- [ ] **Step 2: Implement the dispatcher**

```ts
export interface WorkflowRuntimeDispatcherOptions {
	embedded: RuntimePort;
	codexCli: RuntimePort;
	claudeCli: RuntimePort;
}

export class WorkflowRuntimeDispatcher implements RuntimePort {
	readonly #runtimes: Readonly<Record<WorkflowRuntimeKind, RuntimePort>>;
	constructor(options: WorkflowRuntimeDispatcherOptions) {
		this.#runtimes = {
			embedded: options.embedded,
			codex_cli: options.codexCli,
			claude_cli: options.claudeCli,
		};
	}
	buildRequest(request: WorkflowAgentRequest): WorkflowAgentRequest {
		return this.#runtime(request).buildRequest(request);
	}
	run<TArtifact>(request: WorkflowAgentRequest): Promise<WorkflowAgentResult<TArtifact>> {
		return this.#runtime(request).run<TArtifact>(request);
	}
}
```

- [ ] **Step 3: Export through the workflow barrel**

Use star exports:

```ts
export * from "./claude-cli-runtime";
export * from "./cli-process";
export * from "./cli-runtime-result";
export * from "./codex-cli-runtime";
export * from "./runtime-dispatcher";
export * from "./runtime-invocation";
```

- [ ] **Step 4: Run dispatcher tests**

```bash
bun test packages/coding-agent/test/workflow/runtime-dispatcher.test.ts
```

### Task 10: Wire Production Runtime And Settings

**Files:**

- Modify: `packages/coding-agent/src/workflow/runtime-default.ts`
- Modify: `packages/coding-agent/src/workflow/default-config.ts`
- Modify: `packages/coding-agent/src/config/settings-schema.ts`
- Modify: `packages/coding-agent/test/workflow/session-config.test.ts`

- [ ] **Step 1: Write a failing production-factory test through injected dependencies**

Avoid loading real binaries. Add a factory seam:

```ts
export interface DefaultRuntimeDependencies {
	processRunner?: CliProcessRunner;
	resolveExecutable?: (name: string) => Promise<string | null>;
}
```

Test that `createDefaultRuntimeAdapter(deps)` returns a dispatcher and routes a configured profile to the selected fake adapter.

- [ ] **Step 2: Implement executable resolution**

Use `$which()` from `@oh-my-pi/pi-utils`. Cache resolution per executable string. An absolute configured path is accepted only when it resolves to an executable file. Never invoke `which` through a subprocess.

- [ ] **Step 3: Build the dispatcher in production wiring**

```ts
export function createDefaultRuntimeAdapter(
	dependencies: DefaultRuntimeDependencies = {},
): WorkflowRuntimeDispatcher {
	const processRunner = dependencies.processRunner ?? runCliProcess;
	return new WorkflowRuntimeDispatcher({
		embedded: new RuntimeAdapter(productionRunner),
		codexCli: new CodexCliRuntimeAdapter({ processRunner, resolveExecutable }),
		claudeCli: new ClaudeCliRuntimeAdapter({ processRunner, resolveExecutable }),
	});
}
```

- [ ] **Step 4: Add staged runtime defaults**

First land runtime declarations without switching every default in one change:

```ts
runtime: { kind: "claude_cli" }, // Claude planner/reviewer profiles
runtime: { kind: "codex_cli", profile: "cli" }, // GPT/Grok profiles
```

Use exact models for CLI profiles:

```ts
modelPattern: "claude-sonnet-4-6"
modelPattern: "gpt-5.6-sol"
modelPattern: "grok-4.5"
```

If live smoke authorization is not available in the implementation session, retain `embedded` built-in defaults and document the configuration required to enable CLI profiles. Do not claim the default switch completed without live evidence.

- [ ] **Step 5: Update settings description**

Clarify that each profile may contain:

```text
runtime: { kind: embedded | codex_cli | claude_cli, executable?: string, profile?: string }
```

Do not add UI fields for credentials or base URLs.

- [ ] **Step 6: Run focused tests**

```bash
bun test packages/coding-agent/test/workflow/session-config.test.ts packages/coding-agent/test/workflow/runtime-dispatcher.test.ts
```

### Task 11: Verify Mixed Runtime Engine Behavior

**Files:**

- Create: `packages/coding-agent/test/workflow/mixed-runtime-engine.test.ts`
- Modify: `packages/coding-agent/test/workflow/engine-fallback.test.ts` only if an existing helper is reusable without duplicate coverage.

- [ ] **Step 1: Write a full offline workflow test**

Configure:

- Claude CLI planner
- Codex CLI GPT plan reviewer
- Codex CLI Grok implementer
- Claude CLI code reviewer

Inject fake runtimes returning existing workflow artifact fixtures. Assert route order, resolved provider/model evidence, two deterministic verification gates, and completion.

```ts
expect(routes).toEqual([
	"claude_cli:planner:claude-sonnet-4-6",
	"codex_cli:plan_reviewer:gpt-5.6-sol",
	"codex_cli:implementer:grok-4.5",
	"claude_cli:code_reviewer:claude-sonnet-4-6",
]);
expect(result.state.status).toBe("completed");
```

- [ ] **Step 2: Add fallback and resume tests**

Prove:

- Claude auth failure advances to the configured GPT planner fallback.
- A persisted workflow resumes with the same profile/runtime policy.
- Usage from both CLIs contributes to the existing budget ledger.
- A failed write adapter cannot leave parent-worktree changes before fallback.

- [ ] **Step 3: Run engine tests**

```bash
bun test packages/coding-agent/test/workflow/mixed-runtime-engine.test.ts packages/coding-agent/test/workflow/engine-fallback.test.ts packages/coding-agent/test/workflow/engine-resume.test.ts packages/coding-agent/test/workflow/engine-budget-stop.test.ts
```

### Task 12: Update Changelog And Operator Documentation

**Files:**

- Modify: `packages/coding-agent/CHANGELOG.md`
- Modify: `docs/superpowers/specs/2026-07-24-cli-provider-multi-model-runtime-design.md` only when implementation evidence requires a factual correction.

- [ ] **Step 1: Add one `[Unreleased]` entry**

Under the appropriate section:

```markdown
- Added profile-selectable embedded, Codex CLI, and Claude Code runtimes for deterministic multi-model workflows, including structured output, cancellation, usage evidence, and isolated write execution.
```

- [ ] **Step 2: Document operational prerequisites in release notes or existing workflow docs**

Include:

- `codex` and `claude` must be installed and authenticated.
- CLI profiles use current user configuration but never store credentials.
- Live smoke tests are opt-in and cost-bearing.
- Claude must use Claude Code/Anthropic Messages on the verified gateway.
- The current Claude settings file permission risk must be reported without modifying the file.

- [ ] **Step 3: Scan for accidental secrets**

```bash
git diff | rg -n "ANTHROPIC_AUTH_TOKEN|OPENAI_API_KEY|Bearer [A-Za-z0-9._-]+|api[_-]?key\s*[:=]\s*[^<]"
```

Expected: no credential values. Configuration key names in documentation are acceptable only without values.

### Task 13: Run The Full Verification Matrix

**Files:** all changed files.

- [ ] **Step 1: Run CLI runtime tests**

```bash
bun test \
  packages/coding-agent/test/workflow/runtime-invocation.test.ts \
  packages/coding-agent/test/workflow/cli-process.test.ts \
  packages/coding-agent/test/workflow/cli-runtime-result.test.ts \
  packages/coding-agent/test/workflow/codex-cli-runtime.test.ts \
  packages/coding-agent/test/workflow/claude-cli-runtime.test.ts \
  packages/coding-agent/test/workflow/runtime-dispatcher.test.ts \
  packages/coding-agent/test/workflow/mixed-runtime-engine.test.ts
```

Expected: pass, zero real provider calls.

- [ ] **Step 2: Run task isolation tests**

```bash
bun test packages/coding-agent/test/task/isolation-runner.test.ts packages/coding-agent/test/task/structured-subagent.test.ts
```

Expected: pass.

- [ ] **Step 3: Run the complete workflow suite**

```bash
bun test packages/coding-agent/test/workflow
```

Expected: all tests pass.

- [ ] **Step 4: Run repository type/lint checks**

```bash
bun check
```

Expected: exit 0.

- [ ] **Step 5: Run diff hygiene checks**

```bash
git diff --check
git status --short
git diff --stat
```

Expected: no whitespace errors; only intended files changed.

- [ ] **Step 6: Run a final read-only audit**

Review the diff against every acceptance criterion in the design. Findings lead the report and include file/line evidence. Confirm:

- no shell execution for CLI argv
- no dangerous CLI bypass flags
- no credential reads or writes
- no parent-worktree execution for write roles
- no provider calls in tests
- no workflow state-machine changes
- no missing cancellation cleanup
- no unbounded stdout/stderr capture
- no model/vendor claims without output evidence

### Task 14: Optional Authorized Live Smoke

This task is conditional. Execute it only when the user explicitly authorizes cost-bearing model calls and any temporary writes.

- [ ] **Step 1: Create a disposable temporary git repository**

Use `mktemp -d`, initialize a small repository, and record the exact path. Do not use the oh-my-pi checkout for the first live write smoke.

- [ ] **Step 2: Run a Claude read-only planner smoke**

Use one workflow step with a Claude CLI profile. Verify:

- success through Claude Code
- resolved model evidence reports `claude-sonnet-4-6` when emitted
- no files change
- no external session is persisted by the adapter
- no token appears in logs or artifacts

- [ ] **Step 3: Run a Codex GPT read-only review smoke**

Verify the Responses path succeeds and returns a locally valid review artifact.

- [ ] **Step 4: Run a Codex Grok isolated write smoke**

Ask for one deterministic file edit in the disposable repo. Verify patch capture, apply, changed-file evidence, and deterministic verification.

- [ ] **Step 5: Decide the built-in default switch**

Switch built-in profiles to CLI runtimes only when all three live smokes pass. Otherwise retain embedded defaults, report exact evidence, and leave user-configured CLI profiles available.

## 4. Acceptance-To-Task Mapping

| Design acceptance criterion | Implemented by |
| --- | --- |
| Profile-selectable mixed runtime | Tasks 1, 9, 10 |
| Claude uses Claude Code/Anthropic Messages | Tasks 8, 10, 14 |
| GPT/Grok use Codex CLI | Tasks 6, 7, 10, 14 |
| Local schema validation | Tasks 5, 6, 8 |
| Cancellation and timeout taxonomy | Tasks 3, 5, 6, 8 |
| Isolated write evidence | Tasks 4, 7, 8 |
| Fail-closed configuration/output/apply | Tasks 1, 5, 6, 7, 8 |
| Embedded compatibility | Tasks 2, 9, 13 |
| No real calls in automated tests | Tasks 3-11, 13 |
| Secret-safe logs and artifacts | Tasks 3, 5, 12, 13 |
| Resume and budget preservation | Task 11 |
| Final tests, type check, diff audit | Task 13 |

## 5. Stop Conditions

Stop implementation and report evidence when any of these occurs:

1. The current repository interfaces materially contradict the design and proceeding would require workflow state-machine changes.
2. Two consecutive fixes for the same failing contract do not change the failure.
3. CLI output lacks enough structured data to validate a workflow artifact without parsing prose.
4. Write execution cannot reuse trusted isolation or cannot produce patch/branch evidence.
5. Completion would require changing shared credentials, `~/.claude/settings.json`, `~/.codex`, provider URLs, permissions, or authentication state.
6. A destructive action, deployment, commit, push, GitHub write, or paid live call is required without explicit authorization.
7. Existing unrelated user changes overlap the same lines and cannot be preserved safely.

## 6. Goal-Mode Handoff Prompt

Use the following prompt in a new session from `/Users/sheng/tencent/oh-my-pi`:

```text
进入 Goal 模式，完整实现 oh-my-pi 的 CLI provider 多模型 workflow runtime。

工作目录：/Users/sheng/tencent/oh-my-pi

先按顺序完整阅读：
1. /Users/sheng/tencent/oh-my-pi/AGENTS.md
2. /Users/sheng/tencent/oh-my-pi/docs/superpowers/specs/2026-07-24-cli-provider-multi-model-runtime-design.md
3. /Users/sheng/tencent/oh-my-pi/docs/superpowers/plans/2026-07-24-cli-provider-multi-model-runtime.md

目标：在现有 RuntimePort 边界后增加 mixed CLI runtime。Claude 通过 Claude Code CLI 和 Anthropic Messages 协议执行；GPT、Grok 通过 Codex CLI 和 Responses 协议执行；embedded runtime 保留为兼容/回退后端。保持现有 workflow 状态机、预算、恢复、artifact、验证和安全策略不变。

已验证事实（实现前必须重新核验，不得把快照当当前事实）：
- 文档编写时分支为 workflow，HEAD 为 36934636607e80b479cc67037bc3934f6189ced9。
- Codex CLI 0.145.0 的 cli provider 已验证 gpt-5.6-sol 和 grok-4.5 可用，Grok 曾解析为 grok-4.5-build。
- Claude 模型经 Codex Responses 路径曾返回 502，不得强行走该路径。
- Claude Code 2.1.178 经当前 ANTHROPIC_BASE_URL 已验证 sonnet 成功并解析为 claude-sonnet-4-6。
- ~/.claude/settings.json 是共享配置软链接，目标文件含 token 且文档编写时权限为 0644。严禁输出 token，严禁未经明确授权修改该文件、权限、base URL、模型别名或认证状态。
- 文档编写时 workflow 测试为 124 pass、0 fail，bun check 通过。

执行规则：
- 建立并维护 Goal/checklist，严格按实施计划 Task 1 到 Task 13 顺序推进；Task 14 只有得到用户明确授权后才能执行。
- 先检查 git status、HEAD、相关接口、codex/claude 版本和二进制可用性；发现漂移先记录并修订执行策略。
- 使用 TDD：每个行为先写能证明外部契约的失败测试，确认红灯，再写最小实现，再跑绿灯和相邻测试。
- 使用 Bun 和仓库既有模式；禁止 tsc/npx tsc，使用 bun check；禁止 console；禁止 any、ReturnType、inline/dynamic import；prompt 必须来自静态 .md。
- 文件编辑使用 apply_patch；保留并绕开用户已有改动，不得 reset、checkout 或回退不属于本任务的修改。
- CLI 进程必须用 argv 数组和 Bun.spawn，不得经过 shell；prompt 通过 stdin；stdout/stderr 有界；支持 timeout、AbortSignal 和子进程清理。
- 不得使用 Codex/Claude 的 dangerous bypass flags。
- 所有写角色必须在 oh-my-pi isolation worktree 中运行，并产生可信 patch/branch 证据；不得直接在父工作区运行外部 CLI 写任务。
- 自动化测试严禁调用真实模型或依赖真实凭据，使用 fake process runner、fixtures 和临时 git 仓库。
- 不得读取、打印、记录或持久化 token/cookie/API key；日志和错误必须脱敏。
- 未经授权不得 commit、push、deploy、创建/评论 GitHub issue/PR/discussion，也不得执行付费 live smoke。
- 同一问题连续两次修复无效时停止，复盘根因和证据，不继续堆补丁。

实现门禁：
- 不改变 workflow 状态集合或合法转换，除非代码证据证明设计无法成立；此时停止并报告。
- 不把 Claude 强制接入 /v1/responses。
- 不静默从 CLI runtime 回退 embedded；fallback 必须由 profile retryPolicy 显式配置。
- 不根据模型名估算 CLI 成本；只记录 CLI 明确输出的 usage/cost。
- 不把模型报告的 changedFiles 当作验证证据；必须使用 isolation patch/branch。
- 缺二进制、配置无效、schema 无效、输出无法解析、patch 无法捕获或应用时 fail closed。

每完成一个 Task：
1. 更新 Goal/checklist 状态。
2. 运行该 Task 指定的 focused tests。
3. 检查 git diff，确认无越界文件和无 secret。
4. 汇报简短进度、证据和下一步，然后继续。

最终必须运行：
- bun test packages/coding-agent/test/workflow
- bun test packages/coding-agent/test/task/isolation-runner.test.ts packages/coding-agent/test/task/structured-subagent.test.ts
- bun check
- git diff --check
- git status --short
- git diff --stat
- 最终只读代码审计，按严重级别列 findings 和 file:line；无 finding 也要说明剩余风险和未执行的 live smoke。

完成回传格式：
- status：complete 或 blocked
- conclusion：一句话结果
- changed_files：实际修改文件列表
- implementation：按 Task 说明已完成内容
- evidence：关键 file:line、命令和测试结果
- provider_validation：自动测试结果；真实 live smoke 未授权时明确写未运行
- security：secret、权限、危险 flags、隔离边界检查结果
- risks：剩余风险
- gaps：未完成项及原因
- next_steps：需要用户授权或后续发布动作

不要只输出计划。读取文档、建立 Goal 后直接开始实现，持续推进到全部授权范围内任务完成或命中停止条件。
```

