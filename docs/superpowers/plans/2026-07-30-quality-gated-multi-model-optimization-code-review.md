# Code Review: Quality-Gated Multi-Model Optimization Phase 0-2

- Date: 2026-07-30
- Design Input: `docs/superpowers/specs/2026-07-30-quality-gated-multi-model-optimization-design.md`
- Design Review: `docs/superpowers/plans/2026-07-30-quality-gated-multi-model-optimization-design-review.md`
- Implementation: `docs/superpowers/plans/2026-07-30-quality-gated-multi-model-optimization-implementation.md`
- Scope: Phase 0-2 implementation and contract tests

## 1. Initial Conclusion

- **NEEDS_FIX**
- Phase 0 baseline, ContextLedger measurement, 30-case benchmark shape, provider-usage provenance, and Phase 2 single-lever gates were implemented consistently with the design.
- Two production-contract gaps blocked completion: context optimization was not called by the runtime, and 29 of the 30 advertised live-suite fixtures were not executable.

## 2. Design Consistency

- Production defaults remain unchanged: compiler activation requires an explicit supported `activeLever`; absent evidence keeps the compiler shadowed.
- Only `tool_concurrency_ceiling` and `descriptor_placement` can map an active experiment receipt to a compiler lever.
- Cache assembly, prompt overlay, and tool catalog remain fail-closed behind provider facts, failure-cluster, and held-out-eval requirements.
- Provider counters remain `unknown` when absent; UTF-8 byte estimates remain explicitly versioned estimates.
- The fixed benchmark suite contains 30 cases with at least five repetitions; fake mode is labeled as live quality unknown.

## 3. Findings

### HIGH correctness: Context optimization was not connected to the production runtime

**文件**: `packages/coding-agent/src/workflow/context-ledger.ts:134`, `packages/coding-agent/src/workflow/runtime-adapter.ts:343`

**问题**: `optimizeContextEntries()` implemented exact-hash dedupe and verified artifact replacement, but repository references showed only unit-test callers. `RuntimeAdapter` prepared and sent provider context without invoking it.

**影响**: Phase 1's observable contract was not delivered end to end. Production workflow requests could not produce dedupe/artifact-ref receipts, and old replaceable tool-result bodies remained inline even when a verified artifact store was available.

**建议**: Add an explicit typed context-entry boundary, run optimization asynchronously before provider preparation, use the session ArtifactManager for one-hop numeric `artifact://` references, preserve inline content on persistence/integrity failure, and persist receipts/refs in ContextLedger.

### HIGH correctness: The advertised 30-case live suite had only one executable fixture

**文件**: `packages/coding-agent/src/workflow/benchmark/fixtures.ts:35`, `packages/coding-agent/src/workflow/benchmark/live-runtime.ts:129`

**问题**: The suite described 30 fixed live-acceptance cases, but `prepareFixture()` accepted only `synthetic-mini-parser`. Every other descriptor failed before provider execution with `Live benchmark fixture is not implemented`.

**影响**: The suite-shape contract overstated the live benchmark's executable coverage. A full 30-case live run could never complete, so the acceptance distribution was metadata rather than a runnable benchmark.

**建议**: Materialize a separate repository shape from every case descriptor, keep case-specific allowed paths and verification commands, preserve the concrete null-dereference fixture, and add a contract that executes all 30 fixtures through verifier and scope checks.

### HIGH provenance: Live CLI runs omitted provider and model from benchmark fingerprints

**文件**: `packages/coding-agent/src/cli/workflow-bench-cli.ts:112`

**问题**: Live mode required explicit provider/model flags and mentioned them in notes, but did not pass them to `runBenchmarkSuite()`. Every live `BenchmarkRunFingerprint` therefore stored `provider: null` and `model: null`.

**影响**: Reports could not prove which configured provider/model produced a run, invalidating model-card drift checks and paired-run identity despite real provider execution.

**建议**: Stamp explicit provider/model into live run fingerprints at the CLI boundary; retain null identity for fake runs.

### HIGH correctness: Paired gate passed when both variants failed 40% of runs

**文件**: `packages/coding-agent/src/workflow/benchmark/runner.ts:423`

**问题**: The default gate used `minPassRate: 0`, checked only relative optimized-vs-baseline drop, and treated missing scope evidence as non-failing. A credentialed 5×paired run reported 60%/60% pass rates and missing scope on 3 runs but emitted `gate.passed=true`.

**影响**: Equal baseline/candidate failure could be mislabeled as acceptance, violating verified-success and scope hard gates.

**建议**: Default fixed-suite acceptance to 100% pass for both variants, fail closed on missing scope evidence, and retain explicit custom thresholds only for diagnostic callers.

### HIGH provenance: Outer workflow session zeros were mislabeled as provider facts and same-model fallbacks distorted live runs

**文件**: `packages/coding-agent/src/workflow/benchmark/live-runtime.ts:196`

**问题**: The outer workflow session does not aggregate child-agent tokens/cost/tool calls, but its zeros were stamped `provider_fact`. Benchmark overrides also preserved profile fallback chains after forcing every profile to the same provider/model, causing repeated same-model attempts and 300-second stage aborts.

**影响**: Provider cost/token reports were false zeros, and paired runs measured alias-profile retry behavior instead of a fixed model environment.

**建议**: Mark outer-session usage unknown unless an injected runner explicitly declares it observable; disable fallback chains in fixed-model live overrides, allow one bounded 600-second attempt, and raise the workflow resume ceiling without making it unbounded.

## 4. Fix Applied

- Added `WorkflowAgentRequest.contextEntries` as the explicit typed input. Unstructured markdown is not guessed or reclassified.
- Added `optimizeWorkflowRequestContext()` at the asynchronous production adapter boundary.
- Reused the session ArtifactManager/id space and verified persisted bytes by SHA-256 before replacement.
- Appended optimized explicit entries to provider-visible dynamic context.
- Added ContextLedger `optimizationReceipts` and `artifactRefs`.
- Preserved original inline content when no artifact store exists or persistence/integrity verification fails.
- Replaced the single-fixture guard with data-driven, case-specific repository materialization for all 30 descriptors.
- Kept implementation tasks initially failing and planning/review tasks artifact-driven; no case bypasses its configured verifier or scope check.
- Live CLI runs now stamp explicit provider/model into every run fingerprint; fake runs retain null identity.
- Fixed-suite paired acceptance now requires 100% pass for both variants and complete scope evidence by default.
- Production live runtime keeps outer-session usage unknown, disables same-model fallback aliases, uses one bounded 600-second profile attempt, and permits up to 32 workflow resume steps.

## 5. Verification Evidence

- RED: focused runtime-adapter contract failed because provider context contained no `artifact://` reference.
- GREEN: focused runtime-adapter file completed with 21 passing tests and 62 assertions.
- Expanded Phase 0-2 contracts: 19 files, 187 tests, 1,850 assertions, 0 failures.
- `bun check`: passed; root Biome passed.
- LSP diagnostics: no issues in `context-ledger.ts`, `runtime-invocation.ts`, `runtime-adapter.ts`, or `types.ts`.
- Production build: passed.
- Fresh built artifact smoke: `smoke-test: ok`.
- Fresh fake CLI pipeline: 10 results; `liveQualityUnknown=true`; report output written successfully.
- RED: the all-suite live materializer contract failed on `bugfix-off-by-one` with `Live benchmark fixture is not implemented`.
- GREEN: all 30 fixtures materialized, executed their configured verifier, and passed scope checks; live-runtime test file completed with 5 tests and 110 assertions.
- RED: the live CLI report contract observed null provider/model in its first run fingerprint.
- GREEN: CLI and fingerprint contracts completed with 10 tests and 195 assertions; the live fingerprint contains the explicit provider/model.
- Credentialed evidence: the first 5×paired report completed but exposed 60%/60% pass rates, 3 missing scope verdicts, false provider-fact zeros, and a false-positive gate.
- RED/GREEN: absolute-quality/missing-scope、双方 explicit scope violation 与 usage-observability contracts 均在修复前失败；benchmark suite 现为 31 tests / 1,164 assertions，`bun check` 与 LSP diagnostics clean。

## 6. Re-review Status

- Pending final live paired A/B completion and final installed-artifact verification.
- Final conclusion will be updated after the post-fix full verification loop.
