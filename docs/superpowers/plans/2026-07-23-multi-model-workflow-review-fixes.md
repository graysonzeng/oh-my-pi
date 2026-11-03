# Multi-Model Workflow Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every actionable correctness, policy, recovery, configuration, standards, and test-contract finding from the multi-model workflow review.

**Architecture:** Preserve the existing workflow engine and task runtime. Add enforcement at the runtime adapter and verifier seams, make engine-owned state durable, and connect validated configuration to routing. Each task starts with a focused failing regression test and ends with adjacent-suite verification.

**Tech Stack:** Bun 1.3.14+, TypeScript, Zod schemas, `bun:sqlite`, existing structured-subagent and isolation runtimes, Bun test.

## Global Constraints

- Do not call real or paid model providers in tests.
- Do not modify generated model metadata, dependencies, lockfiles, CI, release code, or unrelated user files.
- Prompts remain static `.md` or `.hbs` assets.
- Use Bun APIs and repository helpers according to `AGENTS.md`; do not use `any`, `ReturnType<>`, inline imports, or `console.*`.
- Do not commit, push, publish, or clean unrelated worktree changes.
- Every behavior change requires a test that is observed failing before production code changes.

---

### Task 1: Enforce write-stage policy and trusted isolation evidence

**Files:**
- Modify: `packages/coding-agent/src/workflow/tool-policy.ts`
- Modify: `packages/coding-agent/src/workflow/runtime-adapter.ts`
- Modify: `packages/coding-agent/src/workflow/stages/implementation-verify.ts`
- Modify: `packages/coding-agent/src/workflow/verifier.ts`
- Test: `packages/coding-agent/test/workflow/tool-policy.test.ts`
- Test: `packages/coding-agent/test/workflow/runtime-adapter.test.ts`
- Test: `packages/coding-agent/test/workflow/implementation-verify.test.ts`
- Test: `packages/coding-agent/test/workflow/verifier.test.ts`

**Interfaces:**
- Produces a policy-enforced `ToolSession` or equivalent workflow-specific tool guard.
- Verification receives a trusted patch and derives changed files from that patch.

- [ ] Add regression tests proving forbidden write paths and disallowed bash commands are rejected before delegation.
- [ ] Run the focused tests and confirm they fail because current code only filters tool names.
- [ ] Add regression tests proving branch-only/model-reported file evidence cannot pass implementation verification.
- [ ] Run the focused tests and confirm they fail on current branch-mode behavior.
- [ ] Implement normalized repository-relative path checks and command allowlisting at the tool execution seam.
- [ ] Require persisted readable patch evidence for every writing stage; derive changed files only from trusted diff content.
- [ ] Run:
  - `bun test packages/coding-agent/test/workflow/tool-policy.test.ts`
  - `bun test packages/coding-agent/test/workflow/runtime-adapter.test.ts`
  - `bun test packages/coding-agent/test/workflow/implementation-verify.test.ts`
  - `bun test packages/coding-agent/test/workflow/verifier.test.ts`
- [ ] Confirm all focused tests pass without provider/network activity.

### Task 2: Make findings engine-owned and final verification fail closed

**Files:**
- Modify: `packages/coding-agent/src/workflow/schemas.ts`
- Modify: `packages/coding-agent/src/workflow/finding-tracker.ts`
- Modify: `packages/coding-agent/src/workflow/engine.ts`
- Modify: `packages/coding-agent/src/workflow/stages/final-verify.ts`
- Test: `packages/coding-agent/test/workflow/schemas.test.ts`
- Test: `packages/coding-agent/test/workflow/finding-tracker.test.ts`
- Test: `packages/coding-agent/test/workflow/engine-repair-loop.test.ts`
- Test: `packages/coding-agent/test/workflow/engine-policy-bounds.test.ts`

**Interfaces:**
- New review findings enter tracking as `open`.
- Tracked findings preserve whether the review decision made them blocking.
- Only engine repair/rejection actions can close findings.

- [ ] Add tests rejecting or normalizing model-supplied `resolved/rejected` status on new findings.
- [ ] Verify the schema/tracker tests fail on current behavior.
- [ ] Add an engine test where a blocking P2 finding remains open through final verification.
- [ ] Verify it incorrectly completes before implementing the fix.
- [ ] Normalize new findings to `open`, persist blocking disposition, and require evidence-bearing engine transitions for resolution/rejection.
- [ ] Pass all unresolved blocking findings to final verification regardless of priority.
- [ ] Run the four focused test files and confirm they pass.

### Task 3: Repair cancellation, timeout, error, and fallback semantics

**Files:**
- Modify: `packages/coding-agent/src/workflow/abort-registry.ts`
- Modify: `packages/coding-agent/src/workflow/engine.ts`
- Modify: `packages/coding-agent/src/workflow/errors.ts`
- Modify: `packages/coding-agent/src/workflow/default-config.ts`
- Test: `packages/coding-agent/test/workflow/workflow-tool.test.ts`
- Test: `packages/coding-agent/test/workflow/engine-fallback.test.ts`
- Test: `packages/coding-agent/test/workflow/engine-resume.test.ts`
- Test: `packages/coding-agent/test/workflow/engine-policy-bounds.test.ts`

**Interfaces:**
- Abort registration returns or accepts an owner token and only removes the matching owner.
- Verification timeout is a required bounded configuration value.
- Error kind deterministically maps to retry/fallback, blocked, cancelled, or failed.

- [ ] Add a concurrent resume/cancel test reproducing controller overwrite and incorrect unregister.
- [ ] Verify the test fails against the single-value abort registry.
- [ ] Add tests for authentication fallback, merge/policy blocked states, redacted persisted errors, and verifier timeout propagation.
- [ ] Verify each test fails for the reviewed behavior.
- [ ] Implement owner-aware abort registration and conditional unregister.
- [ ] Centralize error outcome mapping and redact summaries before persistence.
- [ ] Include authentication in explicit profile fallback while preserving bounded attempts.
- [ ] Add and propagate a finite verification timeout.
- [ ] Run the four focused test files and confirm they pass.

### Task 4: Persist complete budgets and runtime model evidence

**Files:**
- Modify: `packages/coding-agent/src/workflow/budget-ledger.ts`
- Modify: `packages/coding-agent/src/workflow/types.ts`
- Modify: `packages/coding-agent/src/workflow/runtime-adapter.ts`
- Modify: `packages/coding-agent/src/workflow/engine.ts`
- Test: `packages/coding-agent/test/workflow/budget-ledger.test.ts`
- Test: `packages/coding-agent/test/workflow/engine-budget-stop.test.ts`
- Test: `packages/coding-agent/test/workflow/engine-resume.test.ts`
- Test: `packages/coding-agent/test/workflow/runtime-adapter.test.ts`

**Interfaces:**
- `BudgetSnapshot` serializes per-profile request/cost entries.
- Runtime results expose actual resolved provider/model and tool-call count when available.

- [ ] Add a restore test proving a profile at its request limit remains blocked after restart.
- [ ] Add tests for tool-call accumulation and resolved model persistence.
- [ ] Verify all new tests fail on current snapshots/results.
- [ ] Extend snapshots and restore logic with JSON-safe profile entries.
- [ ] Accumulate runtime tool-call usage and persist resolved model metadata without inventing unknown values.
- [ ] Run the four focused test files and confirm they pass.

### Task 5: Connect configured profiles and plan-review diversity

**Files:**
- Modify: `packages/coding-agent/src/workflow/default-config.ts`
- Modify: `packages/coding-agent/src/workflow/model-profile-registry.ts`
- Modify: `packages/coding-agent/src/workflow/model-router.ts`
- Modify: `packages/coding-agent/src/workflow/runtime-adapter.ts`
- Modify: `packages/coding-agent/src/workflow/engine.ts`
- Modify when required: `packages/coding-agent/src/config/settings-schema.ts`
- Test: `packages/coding-agent/test/workflow/model-router.test.ts`
- Test: `packages/coding-agent/test/workflow/runtime-adapter.test.ts`
- Test: `packages/coding-agent/test/workflow/engine-happy-path.test.ts`

**Interfaces:**
- Engine construction uses validated configured profiles rather than `DEFAULT_MODEL_PROFILES`.
- Plan-review routing receives planner profile/vendor and excludes the same profile while preferring another vendor.
- Supported profile fields are passed into the structured runner; unsupported fields fail validation instead of being ignored.

- [ ] Add a production-construction test proving custom profiles change routing.
- [ ] Add a plan-review test proving a distinct profile/vendor is selected.
- [ ] Add adapter tests for each supported profile option.
- [ ] Verify tests fail against the current fixed router and empty route options.
- [ ] Build the router from validated configuration, persist the planner route, and pass diversity options to plan review.
- [ ] Map supported thinking/context/tool alias/token fields through existing task APIs after confirming their exact types; reject fields the runtime cannot support.
- [ ] Replace default full `bun test` verification with trusted repository checks plus explicitly configured targeted tests.
- [ ] Run the three focused test files and confirm they pass.

### Task 6: Standards cleanup and behavior-level test repair

**Files:**
- Modify: `packages/coding-agent/src/workflow/artifact-store.ts`
- Modify: `packages/coding-agent/src/workflow/finding-tracker.ts`
- Modify: `packages/coding-agent/src/workflow/sqlite-store.ts`
- Modify: `packages/coding-agent/src/workflow/verifier.ts`
- Modify: `packages/coding-agent/src/index.ts`
- Modify: `packages/coding-agent/src/tools/index.ts`
- Modify: `packages/coding-agent/test/workflow/cr8-contracts.test.ts`
- Modify: `packages/coding-agent/test/workflow/p1-production-fixes.test.ts`
- Modify as required by Biome: workflow files reported by `bun check`

**Interfaces:**
- Public workflow API has one non-redundant barrel path.
- Tests drive production engine/verifier behavior rather than copied algorithms or fixture state.

- [ ] Replace copied-algorithm and fixture-only tests with behavior-level failing tests.
- [ ] Verify they fail when the corresponding production behavior is absent.
- [ ] Adopt Bun file APIs and approved hashing APIs where repository rules require them.
- [ ] Remove redundant workflow exports and fix all Biome diagnostics in changed workflow files.
- [ ] Run `bun test packages/coding-agent/test/workflow`.
- [ ] Run `bun check`.
- [ ] Run `git diff --check`.
- [ ] Confirm all commands exit zero and the worktree contains no unrelated modifications.
- [ ] Perform an independent read-only review of the final diff against the original findings.
