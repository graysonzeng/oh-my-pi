---
description: "Read before writing/changing tests; repo-specific mocking/isolation/assertion rules."
globs: ["**/test/**", "**/tests/**", "**/*.test.ts", "**/*.test.tsx", "**/*_test.rs"]
---

# Testing

Test the contract the system exposes — not the easiest internal detail to assert.

- Every new test MUST defend one concrete, externally observable contract: behavior, output shape, state transition, error mapping, or a regression-prone parsing boundary. If you cannot name the contract, do not add the test.
- **Name the failure mode.** Every test MUST state what a consumer observes if it regresses. Cannot name one? NEVER add it.
- **Good: transformation.** One fixture MAY prove parse/render/normalize/encode/resolve behavior when output is computed, not echoed.
- **Good: branch or boundary.** Distinct inputs, empty values, malformed input, version/provider routing, and state transitions MUST prove distinct outcomes.
- **Good: external contract.** Exact bytes/shape MAY be asserted when a provider, parser, protocol, or persisted consumer reads them.
- **Good: precedence or negative contract.** Keep explicit `false`/override-wins assertions and required absence only when they prevent a documented leak, downgrade, 400, or incompatible wire field.
- **Good: regression.** A repro MUST trigger the prior real failure path and assert the corrected observable result.
- **Bad: static echo.** NEVER test a constructor/builder merely copied a fixture or baked constant into an in-memory config/metadata field.
- **Bad: success passthrough.** NEVER assert `fn(x) === x` when `x` was already supplied/declared valid; assert a transform, rejection, or downstream effect instead.
- **Bad: wording/defaults.** NEVER assert prompt/UI boilerplate, a default literal, object existence, non-empty output, or length growth without a consumer contract.
- **Bad: duplicate rows.** Parameterized/loop rows MUST each cover a distinct branch, provider/model path, or consumer contract; delete same-path duplicates.
- **Metadata exception.** Exact metadata, identity, ordering, or `undefined` MAY remain only when a downstream consumer depends on it and the test establishes branch, precedence, negative-contract, wire, or regression evidence.
- **Termination exception.** For cyclic/large inputs, assert a bounded output, surfaced error, or state change; bare `not.toThrow()` is insufficient.
- NEVER add placeholders, tautologies, or “code ran” assertions: `expect(true).toBe(true)`, bare `not.toThrow()`, non-empty checks, length-growth checks, or prompt-existence checks without semantic assertions.
- Prefer contract-level tests over implementation details. Avoid asserting internal helper wiring, field assignment, singleton identity, incidental ordering, prompt boilerplate, or passthrough option forwarding unless another component depends on that exact detail.
- NEVER duplicate coverage across abstraction levels. An integration test proving behavior replaces a narrower mocked restatement.
- Tests MUST remain full-suite safe. AVOID file-wide mutation of `Bun.*`, `process.platform`, `process.env`, or `Bun.env`; prefer per-test `vi.spyOn(...)` and `vi.restoreAllMocks()` in `afterEach`.
- NEVER use Bun `mock.module()`; it mutates the global module registry and leaks across files (oven-sh/bun#12823). For pass dependencies, import the pass and spy on `.run`. For package dependencies, namespace-import and spy on the exported function.
- For lifecycle/stateful code, prefer one test per invariant or transition over several tiny tests asserting one field each from the same transition.
- For error handling, trigger the real failure path and assert the surfaced contract — don't instantiate error classes directly or inspect internal metadata.
- Smoke tests are valid only for failure modes narrower tests cannot catch. “Package boots” or “command starts” alone is insufficient.
- Assert exact strings, ordering, or formatting only when downstream consumers depend on exact bytes; otherwise assert semantics.
- Compile-time guarantees require type checks/type tests, never runtime placeholders.
- NEVER source-grep implementation `.ts`, `.rs`, or build-script text. Source-text assertions such as `toContain("someCall()")`, import regexes, banned-name scans, and comment checks fail on harmless refactors while missing broken behavior. Run code and assert output/state/errors; use runtime smoke probes for otherwise inaccessible wiring; enforce structural imports with type tests or lint/biome rules.
- Reading and asserting a file produced by the code—an apply-patch result, generated bundle, or temporary fixture—is valid behavioral testing, not source-grep.
- Don't add tests for tiny low-risk changes unless they protect a real contract or fix a regression-prone edge case.
- Prefer focused package-local verification for the changed area.
