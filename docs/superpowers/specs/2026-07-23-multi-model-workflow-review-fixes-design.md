# Multi-Model Workflow Review Fixes

## Goal

Resolve every actionable finding from the review of the multi-model coding workflow without expanding the workflow architecture or changing its intended lifecycle.

## Scope

The repair covers:

- Runtime enforcement of stage tool, command, and path policies.
- Trusted isolation diff evidence for verification.
- Engine-owned finding lifecycle and complete blocking-finding gates.
- Cancellation ownership under concurrent resume attempts.
- Error classification, fallback, timeout, and blocked-state semantics.
- Durable per-profile and tool-call budget accounting.
- Runtime consumption of configured model profiles and supported profile options.
- Repository-standard Bun APIs, barrel exports, Biome findings, and ineffective tests.
- Documentation and changelog alignment where behavior changes.

The repair does not include a general engine refactor or replacement of the existing task/isolation runtime.

## Design

### Runtime boundaries

Convert named tool policies from descriptive metadata into runtime guards. Write tools validate normalized repository-relative paths, and command execution validates configured command patterns before delegation. Verification derives changed files and secret/path checks from persisted isolation output rather than model-reported fields. Branch-mode isolation must retain a verifiable patch or fail closed.

### State and recovery

Abort registration becomes owner-aware so a failed concurrent runner cannot remove another runner's controller. Workflow errors map by kind to retry, fallback, blocked, cancelled, or failed outcomes. Verification commands receive a configured hard timeout. Authentication can advance through explicit profile fallbacks before blocking.

Budget snapshots include per-profile requests and costs. Runtime usage contributes tool-call counts. Resume restores all counters before another stage or retry is allowed.

### Review and routing

New review findings always enter engine state as open regardless of model-supplied status. Only engine actions with structured evidence resolve or reject them. Final verification rejects every unresolved finding that was blocking under the accepted review decision, including P2/P3 findings.

Plan review receives the planner profile and prefers a distinct profile/vendor. Production settings construct the router from validated configured profiles. Supported model-profile fields are mapped to the structured runtime; unsupported fields are rejected or removed rather than silently accepted.

### Standards and tests

Use Bun file APIs and project-approved hashing APIs where required, remove redundant workflow exports, and fix Biome findings. Replace tests that copy production algorithms or only assert fixture setup with behavior-level engine/verifier tests.

## Test strategy

Each behavioral repair follows red-green-refactor:

1. Add one focused regression test and verify that it fails for the reviewed defect.
2. Implement the smallest production change that satisfies the contract.
3. Run the focused test and adjacent workflow tests.
4. After all batches, run the complete workflow test directory, `bun check`, and `git diff --check`.
5. Run an independent read-only code review of the final diff.

No test may call a real provider.

## Completion criteria

- All reviewed P1-P3 functional findings are fixed or rejected with repository evidence.
- Tool and verification policies fail closed on untrusted model output.
- Concurrent cancellation and process resume preserve ownership and budget limits.
- Model routing and profile configuration affect production behavior as documented.
- Workflow tests, `bun check`, and `git diff --check` pass.
- No unrelated user changes are modified.
