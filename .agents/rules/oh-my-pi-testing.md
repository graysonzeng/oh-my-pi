---
description: "Read before writing/changing tests; repo-specific mocking/isolation/assertion rules."
globs: ["**/test/**", "**/tests/**", "**/*.test.ts", "**/*.test.tsx", "**/*_test.rs"]
---

# Testing

- NEVER add placeholders, tautologies, or “code ran” assertions: `expect(true).toBe(true)`, bare `not.toThrow()`, non-empty checks, length-growth checks, or prompt-existence checks without semantic assertions.
- NEVER duplicate coverage across abstraction levels. An integration test proving behavior replaces a narrower mocked restatement.
- Tests MUST remain full-suite safe. AVOID file-wide mutation of `Bun.*`, `process.platform`, `process.env`, or `Bun.env`; prefer per-test `vi.spyOn(...)` and `vi.restoreAllMocks()` in `afterEach`.
- NEVER use Bun `mock.module()`; it mutates the global module registry and leaks across files (oven-sh/bun#12823). For pass dependencies, import the pass and spy on `.run`. For package dependencies, namespace-import and spy on the exported function.
- Smoke tests are valid only for failure modes narrower tests cannot catch. “Package boots” or “command starts” alone is insufficient.
- Assert exact strings, ordering, or formatting only when downstream consumers depend on exact bytes; otherwise assert semantics.
- Compile-time guarantees require type checks/type tests, never runtime placeholders.
- NEVER source-grep implementation `.ts`, `.rs`, or build-script text. Source-text assertions such as `toContain("someCall()")`, import regexes, banned-name scans, and comment checks fail on harmless refactors while missing broken behavior. Run code and assert output/state/errors; use runtime smoke probes for otherwise inaccessible wiring; enforce structural imports with type tests or lint/biome rules.
- Reading and asserting a file produced by the code—an apply-patch result, generated bundle, or temporary fixture—is valid behavioral testing, not source-grep.
- Prefer focused package-local verification for the changed area.
