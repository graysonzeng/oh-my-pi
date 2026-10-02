# Multi-Model Coding Agent Implementation Plan

> **For agentic workers:** Execute this plan task-by-task. Use isolated worktrees for implementation agents, perform independent review after each phase, and do not commit, push, publish, or call paid model APIs unless the user explicitly authorizes it.

**Goal:** Build a production-oriented multi-model coding workflow on oh-my-pi in which Claude/GPT perform planning and review, Grok performs most code implementation, deterministic verification gates every write, and failures enter a bounded repair loop.

**Architecture:** Keep oh-my-pi's existing Agent, provider, task, structured-subagent, isolation, reviewer, advisor, telemetry, and session runtimes. Add a deterministic workflow layer inside `packages/coding-agent/src/workflow/`; it owns stage transitions, artifacts, model/vendor policy, budgets, persistence, verification, and recovery, while delegating individual model turns to `runStructuredSubagent()`.

**Tech Stack:** Bun 1.3.14+, TypeScript in Node strip-only syntax, ArkType-compatible JSON schemas where integration requires it, `bun:sqlite`, existing oh-my-pi task/worktree runtime, existing model registry, existing telemetry, and targeted Bun tests.

---

## 1. Document purpose

This document is the complete context package and implementation blueprint for a new Grok Goal session. It is intentionally self-contained: the implementer should not need the previous conversation to understand the product objective, repository choice, verified facts, design decisions, constraints, implementation order, tests, failure rules, or completion criteria.

The plan is for implementation in:

`/Users/sheng/tencent/oh-my-pi`

The repository was read at:

- Commit: `7b141199d524b859c357fc89654f10b62b9f3df1`
- Version: `17.0.7`
- Commit date observed during the audit: 2026-07-21
- Runtime declared by the repository: Bun `>=1.3.14`
- License observed: MIT

These facts are a snapshot. The implementation session must re-check `git status`, HEAD, repository instructions, and relevant source files before editing.

## 2. User objective

Create a multi-model Coding Agent with the following default lifecycle:

1. Claude or GPT designs the implementation plan.
2. A second strong reasoning model reviews the plan.
3. Grok implements the approved plan and produces most code tokens.
4. Claude or GPT reviews the resulting patch.
5. Grok or Claude/GPT repairs findings according to finding complexity.
6. Deterministic verification and independent review repeat until accepted or a bounded failure threshold is reached.

Primary business goals:

- Preserve or improve engineering quality.
- Reduce model cost by routing implementation-heavy output to Grok.
- Retain strong reasoning for architecture, review, difficult repair, and escalation.
- Support per-model tool format, prompt, context, retry, timeout, budget, and behavior customization.
- Reuse proven coding-agent harness behavior rather than rebuilding every loop from scratch.
- Produce a system that is recoverable, observable, testable, and suitable for later benchmark-driven optimization.

## 3. Explicit design decision

Use oh-my-pi as the capability base.

Do not use `packages/swarm-extension` as the production workflow engine.

Do not initially reimplement the full Claude, Codex, and Grok coding loops in the smaller Pi repository.

Do not replace oh-my-pi's core task execution path. Add a deterministic workflow controller that calls the existing structured-subagent runtime through one narrow adapter.

The decision boundary is:

- oh-my-pi owns model execution, tools, sessions, task agents, isolation, streaming, provider compatibility, and low-level usage data.
- The new workflow layer owns business process, stage order, acceptance, reviewer diversity, recovery, budgets, and durable workflow state.

## 4. Why oh-my-pi is the selected base

The audit found that oh-my-pi is not a lightweight plugin over the current Pi checkout. The two repositories had 187 common tracked paths, and only 14 of those paths had identical blobs at the audited commits. oh-my-pi is a large product fork with its own Bun, Rust/native, provider, TUI, task, memory, telemetry, and release systems.

That divergence creates maintenance cost, but it also means the difficult runtime primitives already exist:

- Stateful Agent loop and streaming events.
- Context transformation and provider conversion.
- Steering, follow-up, abort, retries, and tool execution.
- Per-agent models, tools, thinking levels, prompts, spawn policies, and output schemas.
- Structured subagent output with strict/permissive validation.
- Request budgets and wall-clock limits.
- Model fallback chains and credential-aware resolution.
- Worktree/copy-on-write isolation with patch or branch capture.
- Merge conflict preservation and recovery artifacts.
- Nested repository handling.
- Structured reviewer prompts and findings.
- Independent advisor context with noise suppression.
- Usage, cost, context, lifecycle, and telemetry data.

Recreating these primitives in the smaller Pi codebase would delay validation of the actual product hypothesis: whether multi-model routing can lower cost without lowering accepted patch quality.

## 5. Verified source evidence

The implementation should re-open these files before changing their consumers.

### 5.1 Structured task runtime

- `packages/coding-agent/src/task/structured-subagent.ts`
  - Exposes `runStructuredSubagent()`.
  - Accepts assignment, context, agent, model override, output schema, schema mode, isolation controls, runtime limit, progress callbacks, and abort signal.
- `packages/coding-agent/src/task/types.ts`
  - Defines structured output status and task request/result types.
  - Supports `outputSchema`, `schemaMode`, and `isolated` task fields.
- `packages/coding-agent/src/task/executor.ts`
  - Implements request-budget handling, forced yield, timeout/abort classification, retry fallback, tool restrictions, telemetry, session lifecycle, and result finalization.

### 5.2 Isolation runtime

- `packages/coding-agent/src/task/isolation-runner.ts`
  - Runs subagents in an isolated merged view.
  - Captures branch or patch output.
  - Preserves patch artifacts when branch creation or merge fails.
  - Cleans the isolation handle in `finally`.
- `packages/coding-agent/src/task/worktree.ts`
  - Captures dirty baselines, including staged, unstaged, untracked, and nested repository state.
  - Detaches isolation Git metadata from the source checkout.
  - Stashes and restores pre-existing work during merge.
  - Keeps conflicted branches or stashes for manual recovery.

### 5.3 Reviewer and advisor

- `packages/coding-agent/src/prompts/agents/reviewer.md`
  - Defines priority, confidence, file/line, correctness, and explanation output.
- `packages/coding-agent/src/advisor/runtime.ts`
  - Maintains independent advisor context.
  - Queues primary transcript deltas.
  - Retries bounded failures and suppresses repeated noise.
  - Explicitly avoids letting a failing advisor indefinitely gate the primary Agent.

Advisor is therefore optional online supervision, not the final acceptance gate.

### 5.4 Model and tool customization

- `packages/coding-agent/src/config/model-registry.ts`
  - Resolves configured models and provider authentication.
- `packages/ai/src/dialect/`
  - Provides model/tool dialect implementations.
- `packages/ai/src/types.ts`
  - Supports `customWireName` for tools.
- `packages/coding-agent/src/system-prompt.ts`
  - Resolves tool prompt names and wire-name overrides.

The existing pieces are strong, but they do not form a unified role-specific `ModelProfile` registry. The workflow layer must add that abstraction.

## 6. Why swarm-extension is not the main engine

The current `packages/swarm-extension` provides YAML DAGs, per-agent model selection, sequential/parallel execution, cycle detection, logs, and a JSON state file. It is useful as a UX and configuration reference.

It has blocking gaps for the target product:

- Agents execute in a shared workspace.
- A dependency records completion, not successful acceptance.
- A failed wave does not provide the required fail-closed transition semantics.
- Loading state is not equivalent to resuming the interrupted execution point.
- The schema lacks output contracts, permissions, timeout, budget, retry class, acceptance gate, isolation policy, runtime adapter, and failure transition.
- Exit code zero is too weak to mean accepted code.
- There is no first-class finding-to-repair-to-reverify loop.

The new engine may borrow its human-readable pipeline configuration later, but not its executor or success semantics.

## 7. Scope

### 7.1 Must implement

- Deterministic workflow state machine.
- Durable workflow and attempt state.
- Versioned stage artifacts.
- Model profiles and role routing.
- Vendor-diversity enforcement.
- Structured plan, review, implementation, repair, and verification contracts.
- Isolated implementation and repair stages.
- Read-only planning and review stages.
- Deterministic verification before review and before completion.
- Bounded retry and repair policy.
- Budget accounting and hard stop.
- Resume after process restart.
- Audit trail with secret-safe summaries.
- A built-in `workflow` tool usable by the main Agent.
- Unit and integration tests with faux providers; no paid provider calls in tests.

### 7.2 Conditional later work

- Native Claude Code, Codex CLI, and Grok Build process adapters.
- Parallel multi-reviewer quorum.
- Advisor-guided live implementation interruption.
- Web dashboard.
- Remote execution.
- Cross-repository workflow orchestration.
- Long-term memory integration.

Each conditional item requires benchmark or product evidence before entering the core.

### 7.3 Explicit non-goals for the first production slice

- Replacing the oh-my-pi TUI.
- Rewriting provider SDKs.
- Rebuilding the task Agent loop.
- Replacing worktree isolation.
- Adding another generic multi-agent chat/swarm system.
- Automatic deployment, push, PR creation, or external messaging.
- Automatically approving security-sensitive changes based only on an LLM review.
- Persisting hidden reasoning or chain-of-thought.
- Supporting arbitrary user-authored code inside workflow configuration.

## 8. High-level architecture

```text
User / Main Agent
        |
        v
WorkflowTool
        |
        v
WorkflowEngine ------------------------+
  |       |       |       |            |
  v       v       v       v            v
State   Router  Policy  Verifier   ArtifactStore
Store     |       |                    |
          v       |                    v
   StructuredSubagentRuntime      patch/json/md
          |
          +--> Claude/GPT planner
          +--> Claude/GPT plan reviewer
          +--> Grok implementer in isolation
          +--> Claude/GPT code reviewer
          +--> routed repair agent in isolation
```

The Workflow Engine is deterministic. Models do not select arbitrary next stages. A model returns a typed artifact; engine policy validates it and selects the next state.

## 9. Workflow state machine

Use these states exactly for the initial implementation:

```ts
export type WorkflowStatus =
  | "created"
  | "planning"
  | "plan_review"
  | "implementing"
  | "implementation_verify"
  | "code_review"
  | "repairing"
  | "final_verify"
  | "completed"
  | "blocked"
  | "cancelled"
  | "failed";
```

Allowed transitions:

```text
created -> planning
planning -> plan_review | blocked | failed | cancelled
plan_review -> implementing | planning | blocked | failed | cancelled
implementing -> implementation_verify | blocked | failed | cancelled
implementation_verify -> code_review | repairing | blocked | failed | cancelled
code_review -> final_verify | repairing | blocked | failed | cancelled
repairing -> implementation_verify | blocked | failed | cancelled
final_verify -> completed | repairing | blocked | failed | cancelled
```

No other transition is legal. Illegal transitions must throw before persistence changes.

Terminal states:

- `completed`: all required gates passed.
- `blocked`: human decision or new authority is required.
- `cancelled`: caller requested cancellation.
- `failed`: an unrecoverable internal or configuration failure occurred.

## 10. Stage semantics

### 10.1 Planning

- Default role: `planner`.
- Default model class: Claude or GPT strong reasoning profile.
- Tools: read-only repository tools.
- Writes: prohibited.
- Input: normalized request, repository snapshot, constraints, and relevant evidence.
- Output: `PlanArtifactV1`.
- Failure: one schema retry, then fallback planner if configured, then `blocked` or `failed` according to error class.

### 10.2 Plan review

- Default role: `plan_reviewer`.
- Must use an independent Agent context.
- Prefer a different vendor from the planner; require a different model profile.
- Tools: read-only.
- Output: `ReviewArtifactV1` with `subject: "plan"`.
- `approved` continues to implementation.
- `changes_requested` returns to planning with findings.
- Maximum plan cycles default: two.

### 10.3 Implementation

- Default role: `implementer`.
- Preferred profile: Grok.
- Must run with isolation enabled.
- Tools: scoped implementation tools.
- Input: approved plan, acceptance criteria, allowed paths, deterministic commands, and only necessary review context.
- Output: `ImplementationArtifactV1` plus patch/branch artifact from the task runtime.
- The model is not allowed to mark the workflow completed.

### 10.4 Implementation verification

- No LLM decision.
- Runs configured deterministic commands.
- Checks forbidden paths and dirty-worktree policy.
- Failure produces `VerificationArtifactV1` and enters repair.
- Pass continues to code review.

### 10.5 Code review

- Default role: `code_reviewer`.
- Must not use the implementer's vendor unless degraded mode was explicitly enabled.
- Tools: read-only.
- Reviews the approved plan, current patch, relevant consumers, and verification evidence.
- Output: `ReviewArtifactV1` with `subject: "implementation"`.
- Findings with confidence below the configured threshold remain advisory.
- Accepted blocking findings enter repair.

### 10.6 Repair

- Chooses model by finding class.
- Mechanical, local, well-specified fixes prefer Grok.
- Architecture, concurrency, state, security, cross-module contract, or repeated findings route to Claude/GPT.
- Runs in a fresh isolation based on the current accepted working state.
- Receives finding IDs and must report which IDs were addressed.
- Cannot silently dismiss findings; dismissal requires structured evidence.

### 10.7 Final verification

- Re-runs all required deterministic commands.
- Confirms no unresolved blocking findings.
- Confirms budget and policy ledgers are consistent.
- Only the engine can transition to `completed`.

## 11. Artifact contracts

Create versioned artifacts. Never pass full stage transcripts by default.

```ts
export interface ArtifactHeader {
  schemaVersion: 1;
  workflowId: string;
  attemptId: string;
  stage: WorkflowStatus;
  createdAt: string;
  modelProfileId?: string;
  provider?: string;
  model?: string;
  promptVersion?: string;
}

export interface PlanArtifactV1 extends ArtifactHeader {
  kind: "plan";
  summary: string;
  assumptions: string[];
  nonGoals: string[];
  affectedFiles: Array<{
    path: string;
    action: "create" | "modify" | "delete";
    reason: string;
  }>;
  implementationSteps: Array<{
    id: string;
    description: string;
    dependsOn: string[];
  }>;
  acceptanceCriteria: string[];
  verificationCommands: string[];
  risks: string[];
  rollback: string[];
}

export interface ReviewFindingV1 {
  id: string;
  priority: "P0" | "P1" | "P2" | "P3";
  category:
    | "correctness"
    | "architecture"
    | "security"
    | "concurrency"
    | "compatibility"
    | "testing"
    | "maintainability";
  confidence: number;
  summary: string;
  explanation: string;
  file?: string;
  line?: number;
  suggestedOwner: "implementer" | "reasoning_repair" | "human";
}

export interface ReviewArtifactV1 extends ArtifactHeader {
  kind: "review";
  subject: "plan" | "implementation";
  decision: "approved" | "changes_requested" | "blocked";
  findings: ReviewFindingV1[];
  explanation: string;
  confidence: number;
}

export interface ImplementationArtifactV1 extends ArtifactHeader {
  kind: "implementation";
  summary: string;
  changedFiles: string[];
  addressedStepIds: string[];
  commandsRun: Array<{
    command: string;
    exitCode: number;
    summary: string;
  }>;
  patchPath?: string;
  branchName?: string;
  unresolved: string[];
}

export interface VerificationArtifactV1 extends ArtifactHeader {
  kind: "verification";
  passed: boolean;
  checks: Array<{
    id: string;
    command?: string;
    status: "passed" | "failed" | "skipped";
    exitCode?: number;
    summary: string;
    logPath?: string;
  }>;
}
```

Persist raw model/session traces separately from these normalized artifacts. Downstream stages receive artifact summaries and explicit evidence paths, not hidden reasoning.

## 12. ModelProfile abstraction

```ts
export type WorkflowRole =
  | "planner"
  | "plan_reviewer"
  | "implementer"
  | "code_reviewer"
  | "repair";

export interface ModelProfile {
  id: string;
  vendor: "anthropic" | "openai" | "xai" | string;
  modelPattern: string | string[];
  roles: WorkflowRole[];
  thinkingLevel?: string;
  promptTemplate: string;
  promptVersion: string;
  toolPolicyId: string;
  toolAliases?: Record<string, string>;
  argumentAliases?: Record<string, Record<string, string>>;
  disabledTools?: string[];
  maxRequests: number;
  maxRuntimeMs: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxCostUsd?: number;
  retryPolicy: {
    maxAttempts: number;
    retryableErrorKinds: WorkflowErrorKind[];
    fallbackProfileIds: string[];
  };
  contextPolicy: {
    includePlan: boolean;
    includeReviewFindings: boolean;
    includeVerification: boolean;
    includeFullTranscript: boolean;
    maxArtifactBytes: number;
  };
}
```

Do not hardcode current public model IDs in engine logic. Default configuration resolves model patterns through the existing model registry. Exact provider/model/version availability must be established by runtime configuration and later benchmark results.

## 13. Routing policy

Default routing:

| Work | Preferred vendor class | Reason |
|---|---|---|
| Planning | Claude or GPT | Strong reasoning and architecture |
| Plan review | Different strong reasoning profile | Independent challenge |
| Implementation | Grok | High code-output volume and cost objective |
| Code review | Claude or GPT, not xAI | Independent vendor review |
| Mechanical repair | Grok | Low-cost targeted code output |
| Complex repair | Claude or GPT | Cross-module reasoning |
| Deterministic verification | No model | Reproducible acceptance |

Complex repair triggers:

- P0 or P1 security finding.
- Concurrency, transaction, state-machine, authorization, or data-loss category.
- Finding spans more than one package.
- Same finding ID or fingerprint reappears after repair.
- Repair requires changing the approved architecture or public contract.

Vendor-diversity rule:

```ts
if (
  policy.requireIndependentReview &&
  implementer.vendor === codeReviewer.vendor &&
  !workflow.degradedMode
) {
  throw new WorkflowPolicyError("independent_reviewer_unavailable");
}
```

Degraded mode must be opt-in and recorded in the final report.

## 14. Tool policies

Define named policies instead of embedding tool lists in stage code.

### `readonly-planning`

Allow repository reading, grep/glob, LSP inspection, and safe read-only shell commands. Deny edit/write, package installation, Git mutation, external writes, and task spawning unless specifically required by the plan role.

### `readonly-review`

Allow all planning reads plus diff inspection and targeted tests only when the review policy permits execute-only verification. Deny repository writes.

### `scoped-implementation`

Allow edit/write, read/search, LSP, and configured test commands inside the isolation. Deny dependency changes, lockfiles, CI, release scripts, credentials, and paths outside the approved plan unless the workflow policy explicitly includes them.

### `scoped-repair`

Allow only files implicated by accepted findings plus required tests. If impact expands, return a contract-change request and stop the attempt.

All tool inputs and outputs are untrusted data. Validate schemas, redact secrets, propagate abort signals, cap runtime, and make failure visible.

## 15. Context handoff policy

Each stage receives:

- Normalized user request.
- Current workflow constraints.
- Required versioned artifacts.
- Repository paths or patch references.
- Explicit unresolved questions.
- Stage-specific tool and budget policy.

Each stage does not receive by default:

- Full prior transcripts.
- Hidden reasoning.
- Credentials.
- Unrelated repository files.
- Advisor chatter that was not promoted into an accepted finding.

Use a deterministic context builder so prompt input can be reproduced from workflow state.

## 16. Failure taxonomy

```ts
export type WorkflowErrorKind =
  | "configuration"
  | "authentication"
  | "quota"
  | "rate_limit"
  | "timeout"
  | "cancelled"
  | "provider_transient"
  | "provider_permanent"
  | "schema_violation"
  | "tool_failure"
  | "verification_failure"
  | "policy_violation"
  | "merge_conflict"
  | "budget_exhausted"
  | "internal";
```

Default handling:

| Error kind | Default action |
|---|---|
| authentication | Try configured credential/model fallback, then block |
| quota/rate_limit | Try fallback profile if allowed; otherwise block |
| timeout | One bounded retry when idempotent, then fallback or block |
| provider_transient | Exponential backoff within attempt budget |
| provider_permanent | No blind retry; fallback or fail |
| schema_violation | One constrained retry, then fallback or fail |
| tool_failure | Classify command/tool; repair only if task-relevant |
| verification_failure | Enter repair with exact evidence |
| policy_violation | Fail closed and block |
| merge_conflict | Preserve artifacts and block for recovery |
| budget_exhausted | Stop and block; never silently exceed |

The same failure condition must not be retried indefinitely. Two ineffective repair attempts for the same finding fingerprint trigger reasoning escalation; a third unresolved cycle blocks the workflow.

## 17. Persistence model

Use `bun:sqlite`, following repository patterns in `packages/metaharness/src/store.ts` and existing coding-agent storage.

Minimum tables:

```sql
CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  request_json TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  current_stage TEXT NOT NULL,
  current_attempt_id TEXT,
  degraded_mode INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL
);

CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  model_profile_id TEXT,
  status TEXT NOT NULL,
  error_kind TEXT,
  error_summary TEXT,
  usage_json TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  FOREIGN KEY(workflow_id) REFERENCES workflows(id)
);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  relative_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(workflow_id) REFERENCES workflows(id),
  FOREIGN KEY(attempt_id) REFERENCES attempts(id)
);

CREATE TABLE transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id TEXT NOT NULL,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  reason TEXT NOT NULL,
  attempt_id TEXT,
  created_at TEXT NOT NULL
);
```

Requirements:

- Enable foreign keys.
- Use transactions for attempt completion plus stage transition.
- Use optimistic workflow `version` checks to prevent duplicate runners.
- Persist transition before starting the next external model call.
- Store artifact content on disk and hash it; keep metadata in SQLite.
- Do not store secrets or unredacted provider payloads in workflow artifacts.

## 18. Budget ledger

Track at minimum:

- Requests.
- Input, output, cache-read, and cache-write tokens.
- Provider-reported total cost when available.
- Wall-clock stage time.
- Tool calls.
- Repair cycles.
- Reviewer cycles.

Budget checks run:

1. Before a stage begins.
2. Before a retry.
3. After every model response.
4. Before a repair cycle.
5. Before final completion.

The engine uses provider-reported usage where available and records `unknown` instead of inventing costs.

## 19. Cost hypothesis and benchmark requirement

The expected saving is not a guaranteed fixed percentage. It depends on how much of the baseline token bill is implementation output.

Use this comparison:

```text
premium_baseline = sum(all stage token and request costs on Claude/GPT)

mixed_workflow =
  planning premium cost
  + plan-review premium cost
  + Grok implementation cost
  + premium code-review cost
  + routed repair cost
  + retry amplification
```

Initial product hypothesis: if implementation accounts for most output tokens, mixed routing may reduce total model cost by roughly 35-65% while retaining premium review. This range is an unverified planning hypothesis, not a measured repository result.

Do not claim savings until the same task set has been run with:

- Same repository commit.
- Same acceptance checks.
- Same maximum attempts.
- Same artifact contracts.
- Same reviewer policy.
- Recorded model/profile versions.

## 20. Verification policy

Verification is configuration-driven but fail-closed.

For this repository, implementation must respect the local `AGENTS.md` rules. In particular:

- After code changes, run `npm run check` with full output.
- Do not run `npm run build` or the full test command unless the user asks.
- Run specific tests for changed test files.
- Never use real providers in coding-agent test suites.
- Never commit unless the user asks.

Workflow verification types:

- `command`: run an exact command with timeout and capture output.
- `forbidden-path`: fail if unapproved paths changed.
- `required-path`: ensure expected artifacts exist.
- `diff-size`: warn or fail above configured thresholds.
- `secret-scan`: reject obvious credentials in patch/artifacts.
- `finding-resolution`: require every blocking finding to be resolved or explicitly rejected with evidence.
- `vendor-diversity`: enforce independent code review.

## 21. Required file structure

Keep the first implementation inside the coding-agent package to avoid premature workspace package and release-system changes.

```text
packages/coding-agent/src/workflow/
├── index.ts
├── types.ts
├── schemas.ts
├── errors.ts
├── transitions.ts
├── engine.ts
├── context-builder.ts
├── artifact-store.ts
├── sqlite-store.ts
├── budget-ledger.ts
├── finding-tracker.ts
├── model-profile.ts
├── model-profile-registry.ts
├── model-router.ts
├── tool-policy.ts
├── runtime-adapter.ts
├── verifier.ts
├── workflow-tool.ts
├── default-config.ts
└── stages/
    ├── plan.ts
    ├── plan-review.ts
    ├── implement.ts
    ├── implementation-verify.ts
    ├── code-review.ts
    ├── repair.ts
    └── final-verify.ts

packages/coding-agent/test/workflow/
├── transitions.test.ts
├── schemas.test.ts
├── sqlite-store.test.ts
├── model-router.test.ts
├── budget-ledger.test.ts
├── finding-tracker.test.ts
├── verifier.test.ts
├── runtime-adapter.test.ts
├── engine-happy-path.test.ts
├── engine-plan-rejection.test.ts
├── engine-repair-loop.test.ts
├── engine-budget-stop.test.ts
├── engine-resume.test.ts
└── workflow-tool.test.ts
```

Existing files expected to change:

- `packages/coding-agent/src/index.ts`: export workflow public types/API.
- `packages/coding-agent/src/tools/index.ts`: register built-in `workflow` tool factory.
- `packages/coding-agent/src/config/settings-schema.ts`: add workflow settings only when required by the MVP surface.
- `packages/coding-agent/CHANGELOG.md`: add an Unreleased entry after implementation is complete.

Do not modify generated model metadata directly.

## 22. Implementation phases

### Phase 0: Re-validate repository evidence

- [ ] Read `/Users/sheng/tencent/oh-my-pi/AGENTS.md` completely.
- [ ] Run `git status --short` and record unrelated user changes.
- [ ] Record `git rev-parse HEAD`.
- [ ] Re-read `task/structured-subagent.ts`, `task/types.ts`, `task/isolation-runner.ts`, `task/executor.ts`, `tools/index.ts`, and relevant test harnesses before editing.
- [ ] Confirm exact test invocation conventions from current repository files.
- [ ] Stop if the audited integration APIs have materially changed; update this plan before implementation.

Acceptance: a short evidence note identifies current HEAD, dirty files, relevant exported APIs, and any drift from this document.

### Phase 1: Domain types, schemas, and transition policy

**Create:**

- `packages/coding-agent/src/workflow/types.ts`
- `packages/coding-agent/src/workflow/schemas.ts`
- `packages/coding-agent/src/workflow/errors.ts`
- `packages/coding-agent/src/workflow/transitions.ts`
- `packages/coding-agent/test/workflow/transitions.test.ts`
- `packages/coding-agent/test/workflow/schemas.test.ts`

- [ ] Write tests proving every allowed transition succeeds.
- [ ] Write tests proving every unlisted transition fails.
- [ ] Write artifact validation tests for missing required fields, unknown schema versions, invalid finding priority, and invalid confidence range.
- [ ] Implement only the types and validation required for those tests.
- [ ] Run the two specific test files.
- [ ] Run `npm run check` after code changes and fix all reported issues.

Acceptance: invalid model output cannot enter persistent workflow state.

### Phase 2: Durable state and artifact storage

**Create:**

- `packages/coding-agent/src/workflow/sqlite-store.ts`
- `packages/coding-agent/src/workflow/artifact-store.ts`
- `packages/coding-agent/test/workflow/sqlite-store.test.ts`

- [ ] Write a failing test for creating a workflow and loading it after reopening the database.
- [ ] Write a failing test for atomic attempt completion plus transition.
- [ ] Write a failing test for optimistic-version conflict.
- [ ] Write a failing test for artifact hash mismatch.
- [ ] Implement SQLite schema creation, transactions, and artifact metadata.
- [ ] Store test databases and artifact directories in temporary directories.
- [ ] Run the specific storage test.
- [ ] Run `npm run check`.

Acceptance: a process restart can reconstruct the exact current stage, attempts, artifact references, and budget totals.

### Phase 3: Model profiles, routing, and policy

**Create:**

- `packages/coding-agent/src/workflow/model-profile.ts`
- `packages/coding-agent/src/workflow/model-profile-registry.ts`
- `packages/coding-agent/src/workflow/model-router.ts`
- `packages/coding-agent/src/workflow/tool-policy.ts`
- `packages/coding-agent/src/workflow/default-config.ts`
- `packages/coding-agent/test/workflow/model-router.test.ts`

- [ ] Test role-to-profile resolution.
- [ ] Test unavailable profile fallback.
- [ ] Test vendor-diversity rejection.
- [ ] Test explicit degraded-mode acceptance and audit flag.
- [ ] Test complex-finding routing to a reasoning repair profile.
- [ ] Test repeated-finding escalation.
- [ ] Implement the minimum registry and router.
- [ ] Do not embed API keys or assume exact public model IDs.
- [ ] Run the specific router test.
- [ ] Run `npm run check`.

Acceptance: the engine can explain which profile was selected, why it was selected, and whether review independence was degraded.

### Phase 4: Budget ledger and finding tracker

**Create:**

- `packages/coding-agent/src/workflow/budget-ledger.ts`
- `packages/coding-agent/src/workflow/finding-tracker.ts`
- `packages/coding-agent/test/workflow/budget-ledger.test.ts`
- `packages/coding-agent/test/workflow/finding-tracker.test.ts`

- [ ] Test accumulation of request, token, cost, tool, stage-time, and repair counters.
- [ ] Test unknown cost handling.
- [ ] Test pre-stage and pre-retry budget rejection.
- [ ] Test stable finding fingerprint generation.
- [ ] Test first repair, reasoning escalation, and third-cycle block.
- [ ] Implement minimal immutable ledger updates and finding state.
- [ ] Run both specific tests.
- [ ] Run `npm run check`.

Acceptance: no retry or stage can silently exceed configured limits.

### Phase 5: Structured-subagent runtime adapter

**Create:**

- `packages/coding-agent/src/workflow/runtime-adapter.ts`
- `packages/coding-agent/test/workflow/runtime-adapter.test.ts`

The adapter is the only workflow module allowed to import task execution internals.

```ts
export interface WorkflowAgentRequest<TArtifact> {
  workflowId: string;
  attemptId: string;
  role: WorkflowRole;
  profile: ModelProfile;
  assignment: string;
  context: string;
  outputSchema: unknown;
  isolation: {
    requested: boolean;
    merge: "patch" | "branch";
    apply: boolean;
  };
  signal?: AbortSignal;
}

export interface WorkflowAgentResult<TArtifact> {
  artifact: TArtifact;
  rawResultId: string;
  patchPath?: string;
  branchName?: string;
  usage: unknown;
}
```

- [ ] Use the repository faux provider/test harness; do not call real providers.
- [ ] Test schema-valid structured output.
- [ ] Test strict schema rejection.
- [ ] Test timeout and cancellation mapping.
- [ ] Test isolated patch metadata propagation.
- [ ] Test provider/model usage propagation.
- [ ] Implement the adapter with `runStructuredSubagent()`.
- [ ] Keep task-specific error details behind normalized workflow errors.
- [ ] Run the specific adapter test.
- [ ] Run `npm run check`.

Acceptance: workflow stage code has no dependency on task executor internals.

### Phase 6: Deterministic verifier

**Create:**

- `packages/coding-agent/src/workflow/verifier.ts`
- `packages/coding-agent/test/workflow/verifier.test.ts`

- [ ] Test successful command checks.
- [ ] Test timeout, non-zero exit, and cancellation.
- [ ] Test forbidden-path detection.
- [ ] Test unchanged working tree.
- [ ] Test secret-like patch rejection without logging the secret.
- [ ] Test log artifact creation and truncation policy.
- [ ] Implement command execution without shell interpolation where possible.
- [ ] Preserve full failure logs in artifacts while returning concise summaries.
- [ ] Run the specific verifier test.
- [ ] Run `npm run check`.

Acceptance: deterministic failures cannot be overridden by an LLM's claim that the code works.

### Phase 7: Stage implementations

**Create:**

- `packages/coding-agent/src/workflow/context-builder.ts`
- All seven files under `packages/coding-agent/src/workflow/stages/`.

- [ ] Implement a reproducible context builder from persisted artifacts.
- [ ] Implement plan stage with strict `PlanArtifactV1` output.
- [ ] Implement plan review with strict `ReviewArtifactV1` output.
- [ ] Implement isolated Grok-preferred implementation stage.
- [ ] Implement deterministic implementation verification.
- [ ] Implement independent code review.
- [ ] Implement routed repair using finding IDs.
- [ ] Implement final verification.
- [ ] Unit test each stage through fake runtime and fake verifier ports.
- [ ] Run the new stage tests.
- [ ] Run `npm run check`.

Acceptance: each stage is independently testable and cannot choose arbitrary workflow transitions.

### Phase 8: Workflow engine and recovery

**Create:**

- `packages/coding-agent/src/workflow/engine.ts`
- `packages/coding-agent/test/workflow/engine-happy-path.test.ts`
- `packages/coding-agent/test/workflow/engine-plan-rejection.test.ts`
- `packages/coding-agent/test/workflow/engine-repair-loop.test.ts`
- `packages/coding-agent/test/workflow/engine-budget-stop.test.ts`
- `packages/coding-agent/test/workflow/engine-resume.test.ts`

- [ ] Test the full accepted path.
- [ ] Test plan rejection returning to planning.
- [ ] Test verification failure entering repair.
- [ ] Test code-review finding entering repair.
- [ ] Test repeated finding escalation and terminal block.
- [ ] Test budget exhaustion before a provider call.
- [ ] Test cancellation propagation.
- [ ] Test restart from each non-terminal persisted stage.
- [ ] Test duplicate-runner optimistic lock rejection.
- [ ] Implement one-stage-at-a-time engine execution.
- [ ] Persist stage intent before external calls and completion after artifact validation.
- [ ] Run all workflow engine tests.
- [ ] Run `npm run check`.

Acceptance: process interruption never causes an accepted stage to be silently skipped or a write stage to run twice without detection.

### Phase 9: Built-in workflow tool

**Create:**

- `packages/coding-agent/src/workflow/workflow-tool.ts`
- `packages/coding-agent/src/workflow/index.ts`
- `packages/coding-agent/test/workflow/workflow-tool.test.ts`

**Modify:**

- `packages/coding-agent/src/tools/index.ts`
- `packages/coding-agent/src/index.ts`

Initial tool operations:

```ts
export type WorkflowToolOperation =
  | "start"
  | "status"
  | "resume"
  | "cancel";
```

- [ ] Test operation schema and approval tier.
- [ ] Test `start` creates but does not bypass policy gates.
- [ ] Test `status` is read-only.
- [ ] Test `resume` refuses terminal workflows.
- [ ] Test `cancel` propagates an abort and persists cancellation.
- [ ] Register the tool through the existing built-in tool factory pattern.
- [ ] Export only stable workflow APIs from the coding-agent entrypoint.
- [ ] Run the specific tool test.
- [ ] Run `npm run check`.

Acceptance: the main Agent can start and inspect workflows without directly controlling stage transitions.

### Phase 10: Configuration and prompts

**Create:**

- Versioned workflow prompt templates under `packages/coding-agent/src/prompts/workflow/`.

**Modify only if required after inspecting existing settings patterns:**

- `packages/coding-agent/src/config/settings-schema.ts`

Configuration groups:

- enabled flag.
- storage location.
- model profile mappings.
- vendor-diversity policy.
- isolation merge/apply mode.
- stage budgets.
- repair-cycle limits.
- reviewer confidence threshold.
- deterministic verification commands.
- degraded mode.

- [ ] Keep prompts role-specific and versioned.
- [ ] Separate system rules, artifact context, repository evidence, and user request.
- [ ] Include prompt-injection boundary language.
- [ ] Add settings validation tests.
- [ ] Add prompt snapshot or focused rendering tests.
- [ ] Run the specific tests.
- [ ] Run `npm run check`.

Acceptance: changing a model profile or prompt version does not require changing engine logic.

### Phase 11: Documentation, changelog, and final audit

**Create or modify:**

- User-facing workflow documentation in the repository's established docs location.
- `packages/coding-agent/CHANGELOG.md` under `## [Unreleased]`.

- [ ] Document configuration and lifecycle.
- [ ] Document recovery artifacts and blocked states.
- [ ] Document that model IDs and cost claims require local benchmark evidence.
- [ ] Run every changed test file explicitly.
- [ ] Run `npm run check` with full output.
- [ ] Review `git diff --check`.
- [ ] Review `git status --short` and confirm no unrelated files were changed.
- [ ] Perform a read-only code audit against every acceptance item below.
- [ ] Do not commit unless the user explicitly requests it.

Acceptance: documentation, implementation, tests, configuration, and changelog describe the same behavior.

## 23. Acceptance matrix

| Requirement | Required evidence |
|---|---|
| Claude/GPT planning | persisted plan artifact with profile/vendor metadata |
| Independent plan review | separate attempt and review artifact |
| Grok implementation | implementation attempt resolved to xAI/Grok profile when available |
| Worktree isolation | patch/branch artifact from existing isolation runtime |
| Independent code review | reviewer vendor differs from implementer or degraded flag is explicit |
| Repair loop | finding IDs linked to repair attempt and re-verification |
| Deterministic quality gate | command results and policy checks persisted |
| Bounded failures | repeated-finding and budget tests reach `blocked` |
| Resume | process-reopen test continues from persisted stage |
| Per-model customization | profile tests cover prompt/tools/budget/retry/context |
| Cost visibility | usage ledger records known values and preserves unknowns |
| No paid tests | faux provider evidence in tests |
| No silent success | every terminal state has explicit transition evidence |

## 24. Quality and security gates

The implementation is not accepted if any of these are missing:

- Strict artifact validation.
- Independent review policy.
- Deterministic verifier.
- Worktree isolation for code-writing stages.
- Durable transition log.
- Bounded retries and repair cycles.
- Secret-safe logs and artifacts.
- Cancellation propagation.
- Resume tests.
- No-real-provider tests.

Treat repository content, issue text, logs, external pages, tool output, model output, and subagent output as untrusted input. None may override higher-priority workflow policy.

## 25. Observability

Emit or persist these fields where the existing telemetry stack supports them:

- `workflow.id`
- `workflow.stage`
- `workflow.attempt_id`
- `workflow.transition`
- `workflow.model_profile`
- `gen_ai.provider.name`
- `gen_ai.request.model`
- prompt version
- request count
- input/output/cache tokens
- cost when provider-reported
- stage latency
- verifier check ID
- finding fingerprint
- repair cycle
- degraded-mode flag
- terminal reason

Never emit prompt contents, credentials, private patch content, or unredacted tool arguments by default.

## 26. Benchmark plan after MVP

Use `packages/metaharness` as the starting point for evaluation storage and runs.

Minimum experiment matrix:

| Harness | Planner | Implementer | Reviewer |
|---|---|---|---|
| oh-my-pi workflow | Claude | Grok | GPT |
| oh-my-pi workflow | GPT | Grok | Claude |
| oh-my-pi workflow | Claude | Claude | Claude |
| oh-my-pi workflow | GPT | GPT | GPT |

Optional later matrix:

- Claude Code native CLI.
- Codex CLI native harness.
- Grok Build native harness.

Metrics:

- Acceptance rate.
- Deterministic test pass rate.
- Blocking findings per accepted patch.
- Repair cycles.
- Human intervention rate.
- Wall-clock latency.
- Provider failure rate.
- Input/output/reasoning tokens where available.
- Total provider-reported cost.
- Cost per accepted patch.

Do not compare harnesses with different acceptance gates.

## 27. Native CLI reuse strategy

The first implementation uses oh-my-pi's internal model/provider loop because it offers the deepest control over tools, artifacts, budgets, and context.

Later, add a runtime port rather than embedding CLI behavior in stages:

```ts
export interface WorkflowRuntime {
  run<TArtifact>(request: WorkflowAgentRequest<TArtifact>): Promise<WorkflowAgentResult<TArtifact>>;
  cancel(attemptId: string): Promise<void>;
}
```

Possible adapters:

- `PiStructuredSubagentRuntime`: primary production adapter.
- `ClaudeCodeCliRuntime`: benchmark or fallback adapter.
- `CodexCliRuntime`: benchmark or fallback adapter.
- `GrokBuildCliRuntime`: benchmark or fallback adapter.

CLI adapters must normalize events, usage, artifacts, cancellation, timeout, and error taxonomy. They must not become a second workflow engine.

## 28. Maintenance strategy

- Keep workflow code in a dedicated directory.
- Keep only one task-runtime adapter importing task internals.
- Avoid scattered modifications across TUI, provider, memory, browser, and native packages.
- Pin the oh-my-pi base commit for benchmark runs.
- Add compatibility tests around `runStructuredSubagent()`.
- Re-run workflow golden tests before adopting upstream task/runtime changes.
- Preserve MIT attribution for copied or modified source.
- Do not extract a new workspace package until the workflow API is stable and release overhead is justified.

## 29. Main technical risks and mitigations

### Upstream coupling

Risk: structured-subagent and ToolSession APIs may change.

Mitigation: one adapter, compatibility tests, pinned benchmark commits.

### Reviewer correlation

Risk: different models can repeat the same mistaken assumption.

Mitigation: isolated reviewer context, artifact-based input, vendor diversity, deterministic tests.

### Repair loops increase cost

Risk: cheap implementation followed by repeated premium review may erase savings.

Mitigation: finding fingerprinting, targeted repair context, bounded cycles, cost per accepted patch metric.

### Shared source worktree is dirty

Risk: applying isolated changes can conflict with user work.

Mitigation: reuse existing baseline, stash, patch, branch, and recovery behavior; preserve conflicts instead of forcing merge.

### Model/profile drift

Risk: provider aliases and behavior change.

Mitigation: record resolved provider/model/profile/prompt version and replay golden tasks.

### Tool overreach

Risk: an implementation Agent changes dependencies, CI, credentials, or unrelated files.

Mitigation: named tool policies, forbidden-path verifier, isolation, fail-closed acceptance.

### False completion

Risk: a model reports success despite failed commands or malformed output.

Mitigation: strict schema, deterministic verifier, engine-owned terminal transitions.

## 30. Expected gap from Cursor-like first-party experience

Likely initial gaps:

- Less mature context ranking and edit prediction.
- Less polished IDE-native interaction.
- Less proprietary training feedback from editor telemetry.
- More visible latency from explicit review gates.
- More configuration work for model profiles and repository-specific verification.

Compensating advantages:

- Explicit model routing.
- Strong isolation and recovery.
- Inspectable prompts and policies.
- Vendor-independent review.
- Reproducible artifacts and evaluation.
- Cost and quality controls that can be tuned per repository.

Do not attempt to close the UI gap in the first implementation. First prove accepted patch quality and cost.

## 31. Stop conditions for the implementation Agent

Stop and report instead of guessing when:

- Current source APIs materially differ from the evidence in this document.
- Required changes expand into provider, native, release, or memory subsystems without a demonstrated need.
- A task-runtime integration requires removing intentional functionality.
- Two fixes for the same failure produce no progress.
- Tests require paid providers or credentials.
- The worktree contains overlapping user changes in files the implementation must edit.
- Dependency or lockfile changes become necessary but were not explicitly approved.
- `npm run check` reports unrelated pre-existing failures that cannot be safely separated.
- A destructive Git operation appears necessary.

## 32. Required implementation return format

The Grok Goal session must return:

```text
status: completed | blocked | partial
conclusion: one concise outcome
changed_files:
  - path and responsibility
tests_run:
  - exact command, exit code, result
check_result:
  - exact command and result
requirements_accounting:
  - each acceptance requirement -> implemented/partial/not implemented + evidence
risks:
  - remaining risk and impact
gaps:
  - unverified or deferred work
needs_human:
  - explicit decision or authorization needed
next_steps:
  - smallest safe next action
```

Claims without file references or command evidence must be marked unverified.

## 33. Copyable Grok Goal brief

Use the following as the objective in the new implementation session:

```text
Implement the multi-model Coding Agent workflow described in:
/Users/sheng/tencent/oh-my-pi/docs/superpowers/plans/2026-07-22-multi-model-coding-agent.md

Work in /Users/sheng/tencent/oh-my-pi.

Read the repository AGENTS.md and the entire plan before editing. Re-check HEAD,
git status, relevant task/runtime APIs, and test conventions. Execute the plan
phase-by-phase with targeted tests and npm run check after code changes.

Core objective:
- Claude/GPT plan and review.
- Grok performs the default implementation stage.
- Code-writing stages use existing oh-my-pi isolation.
- The workflow engine, not an LLM, owns transitions and completion.
- Enforce independent-vendor code review unless explicit degraded mode is enabled.
- Persist artifacts, attempts, transitions, budgets, findings, and recovery state.
- Use deterministic verification before review and completion.
- Use faux providers in tests; do not call paid model APIs.

Implementation boundaries:
- Add the workflow layer under packages/coding-agent/src/workflow.
- Reuse runStructuredSubagent and existing isolation/task behavior through one adapter.
- Do not replace the task loop or use swarm-extension as the production executor.
- Do not modify unrelated provider, native, TUI, browser, memory, or release systems.
- Do not change dependencies, lockfiles, commit, push, deploy, or publish without explicit authorization.
- Stop after two ineffective fixes to the same problem and report the root blocker.

Complete each phase's acceptance criteria and return the structured implementation
report required by section 32 of the plan.
```

## 34. Final completion definition

The project is complete only when all of the following are true:

- Workflow transitions are deterministic and exhaustively tested.
- All model outputs entering state are schema-validated.
- Planning, plan review, implementation, code review, repair, and final verification are represented as durable attempts.
- Implementation and repair reuse oh-my-pi isolation.
- Code review is independently routed or explicitly degraded.
- Deterministic verification can fail the workflow.
- Repeated findings and budget exhaustion reach a bounded terminal state.
- Workflow resume is tested across process reopen.
- Tool access is stage-scoped.
- Usage and cost are recorded without invented values.
- Tests use faux providers.
- Repository-required checks pass.
- Documentation and changelog match behavior.
- No unrelated changes are included.
