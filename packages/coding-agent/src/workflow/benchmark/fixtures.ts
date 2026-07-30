/**
 * Paired fake-runtime fixtures for benchmark smoke.
 * Deterministic: baseline dumps full tool output; optimized applies processToolOutput.
 *
 * Default suite: 12 fixed cases — bug_fix×3, feature×3, research_plan×2,
 * code_review×2, multi_turn×2. Uses in-repo synthetic fixtures so CI stays offline.
 */

import { DEFAULT_TRUNCATION_RULES, processToolOutputDetailed } from "../tool-output-manager";
import type { ToolStrategy } from "../types";
import type { BenchmarkRuntime, BenchmarkRuntimeRequest, BenchmarkRuntimeResponse } from "./runner";
import type { BenchmarkCase, BenchmarkCaseCategory, BenchmarkSuite } from "./types";

const OPTIMIZED_STRATEGY: ToolStrategy = {
	outputTruncation: { enabled: true, rules: DEFAULT_TRUNCATION_RULES },
	resultSummarization: { enabled: true, summarizerKeys: ["bash", "read", "grep", "test", "*"] },
};

const FORBIDDEN_ROOT = ["package.json", "bun.lock", ".env", ".git/", "node_modules/"];

function caseDef(
	partial: Omit<BenchmarkCase, "repetitions" | "forbiddenPaths"> & {
		forbiddenPaths?: string[];
		repetitions?: number;
	},
): BenchmarkCase {
	return {
		repetitions: 5,
		forbiddenPaths: partial.forbiddenPaths ?? [...FORBIDDEN_ROOT],
		...partial,
	};
}

/**
 * Thirty fixed cases for live acceptance (6/6/4/3/3/3/2/2/1).
 * Fixtures are versioned and every case carries deterministic scope and verifier contracts.
 */
export function buildDefaultBenchmarkSuite(): BenchmarkSuite {
	const cases: BenchmarkCase[] = [
		// --- bug_fix ×6 ---
		caseDef({
			id: "bugfix-null-deref",
			name: "Fix null dereference in parser",
			category: "bug_fix",
			request:
				"Fix the null dereference in the parser entrypoint. Touch only allowed paths; keep existing tests green.",
			baseCommit: "fixture-base-v1",
			repoFixture: "synthetic-mini-parser",
			publicRepoNote: "Intended shape: tiny public parser toy repo (offline synthetic fixture in CI).",
			allowedPaths: ["src/parser.ts", "test/parser.test.ts"],
			verificationCommands: ["bun test test/parser.test.ts", "bun check"],
			successCriteria: ["Null path no longer throws", "parser unit tests pass", "No edits outside allowedPaths"],
		}),
		caseDef({
			id: "bugfix-off-by-one",
			name: "Fix off-by-one in slice bounds",
			category: "bug_fix",
			request:
				"Correct the off-by-one error in range slicing so the last element is included when end is exclusive as documented.",
			baseCommit: "fixture-base-v1",
			repoFixture: "synthetic-mini-slice",
			allowedPaths: ["src/slice.ts", "test/slice.test.ts"],
			verificationCommands: ["bun test test/slice.test.ts"],
			successCriteria: ["Documented exclusive-end semantics hold", "slice tests pass", "No forbidden path writes"],
		}),
		caseDef({
			id: "bugfix-async-race",
			name: "Fix async race in cache loader",
			category: "bug_fix",
			request:
				"Eliminate the race where concurrent cache loads return stale undefined. Use the existing mutex helper if present.",
			baseCommit: "fixture-base-v1",
			repoFixture: "synthetic-mini-cache",
			allowedPaths: ["src/cache.ts", "test/cache.test.ts"],
			verificationCommands: ["bun test test/cache.test.ts"],
			successCriteria: [
				"Concurrent load test passes deterministically",
				"No network or sleep-based flakiness introduced",
				"Only allowed paths modified",
			],
		}),
		// --- feature ×3 ---
		caseDef({
			id: "feature-add-flag",
			name: "Add CLI boolean flag",
			category: "feature",
			request:
				"Add a --dry-run boolean flag to the CLI entrypoint and thread it through the runner without changing default behavior.",
			baseCommit: "fixture-base-v1",
			repoFixture: "synthetic-mini-cli",
			allowedPaths: ["src/cli.ts", "src/runner.ts", "test/cli-flag.test.ts"],
			verificationCommands: ["bun test test/cli-flag.test.ts", "bun check"],
			successCriteria: [
				"--dry-run is parsed and forwarded",
				"Default behavior unchanged when flag absent",
				"New/updated tests pass",
			],
		}),
		caseDef({
			id: "feature-json-export",
			name: "Add JSON export helper",
			category: "feature",
			request:
				"Implement a stable JSON export for report summaries under the allowed paths. Keys must be sorted for determinism.",
			baseCommit: "fixture-base-v1",
			repoFixture: "synthetic-mini-report",
			allowedPaths: ["src/export-json.ts", "test/export-json.test.ts"],
			verificationCommands: ["bun test test/export-json.test.ts"],
			successCriteria: [
				"exportJson produces stable key order",
				"Golden fixture matches byte-for-byte",
				"No package.json dependency changes",
			],
		}),
		caseDef({
			id: "feature-retry-wrapper",
			name: "Add retry wrapper for transient errors",
			category: "feature",
			request: "Add a pure retry helper with maxAttempts and backoffMs; only retry on coded TRANSIENT errors.",
			baseCommit: "fixture-base-v1",
			repoFixture: "synthetic-mini-retry",
			allowedPaths: ["src/retry.ts", "test/retry.test.ts"],
			verificationCommands: ["bun test test/retry.test.ts"],
			successCriteria: [
				"Retries only TRANSIENT errors",
				"Exhaustion surfaces last error",
				"Tests do not use wall-clock randomness",
			],
		}),
		// --- research_plan ×2 ---
		caseDef({
			id: "research-module-map",
			name: "Map module boundaries for plan",
			category: "research_plan",
			request:
				"Investigate the synthetic module layout and produce a plan artifact listing affected files, steps, and verification commands. Do not implement.",
			baseCommit: "fixture-base-v1",
			repoFixture: "synthetic-mini-layout",
			allowedPaths: ["docs/plan-module-map.md", "artifacts/plan.json"],
			verificationCommands: ["test -f artifacts/plan.json", "bun check"],
			successCriteria: [
				"Plan lists affected files with reasons",
				"Acceptance criteria and verification commands present",
				"No source code under src/ modified",
			],
		}),
		caseDef({
			id: "research-dep-risk",
			name: "Plan dependency risk reduction",
			category: "research_plan",
			request:
				"Research where the synthetic package couples to a heavy dependency and write a plan to isolate it behind an interface. Planning only.",
			baseCommit: "fixture-base-v1",
			repoFixture: "synthetic-mini-deps",
			allowedPaths: ["docs/plan-dep-risk.md", "artifacts/plan.json"],
			verificationCommands: ["test -f artifacts/plan.json"],
			successCriteria: [
				"Plan identifies coupling sites",
				"Non-goals and risks documented",
				"No implementation diffs outside allowedPaths",
			],
		}),
		// --- code_review ×2 ---
		caseDef({
			id: "review-security-paths",
			name: "Review path handling for traversal",
			category: "code_review",
			request:
				"Review the synthetic path join helper for directory traversal risks. Produce a review artifact with findings; do not patch production code.",
			baseCommit: "fixture-base-v1",
			repoFixture: "synthetic-mini-paths",
			allowedPaths: ["artifacts/review.json", "docs/review-security-paths.md"],
			verificationCommands: ["test -f artifacts/review.json"],
			successCriteria: [
				"Review has structured findings with file/line when applicable",
				"Blocking vs non-blocking marked",
				"No edits under src/",
			],
		}),
		caseDef({
			id: "review-error-handling",
			name: "Review error handling consistency",
			category: "code_review",
			request:
				"Review synthetic error-mapping code for swallowed errors and inconsistent status codes. Output review only.",
			baseCommit: "fixture-base-v1",
			repoFixture: "synthetic-mini-errors",
			allowedPaths: ["artifacts/review.json", "docs/review-error-handling.md"],
			verificationCommands: ["test -f artifacts/review.json"],
			successCriteria: [
				"Findings cover error mapping inconsistencies if present",
				"Decision field present (approve/changes_requested)",
				"Source tree unchanged except allowed paths",
			],
		}),
		// --- long_session ×2 ---
		caseDef({
			id: "multiturn-fix-then-test",
			name: "Multi-turn fix then strengthen tests",
			category: "long_session",
			request:
				"Turn 1: fix the documented bug. Turn 2: add a regression test. Both turns stay within allowed paths.",
			baseCommit: "fixture-base-v1",
			repoFixture: "synthetic-mini-multiturn-fix",
			allowedPaths: ["src/counter.ts", "test/counter.test.ts"],
			verificationCommands: ["bun test test/counter.test.ts"],
			successCriteria: [
				"Bug fixed after turn 1",
				"Regression test added after turn 2",
				"Full allowed-path test suite green",
			],
		}),
		caseDef({
			id: "multiturn-plan-implement",
			name: "Multi-turn plan then implement one step",
			category: "long_session",
			request:
				"Turn 1: write a minimal plan. Turn 2: implement only the first plan step. Stay within allowed paths.",
			baseCommit: "fixture-base-v1",
			repoFixture: "synthetic-mini-multiturn-plan",
			allowedPaths: ["artifacts/plan.json", "src/step1.ts", "test/step1.test.ts"],
			verificationCommands: ["test -f artifacts/plan.json", "bun test test/step1.test.ts"],
			successCriteria: [
				"Plan artifact exists after turn 1",
				"Step 1 implementation and tests pass after turn 2",
				"No work beyond first plan step",
			],
		}),
		caseDef({
			id: "bugfix-error-code",
			name: "Preserve parser error code",
			category: "bug_fix",
			request:
				"Fix the parser so empty input returns the documented EMPTY_INPUT error without changing valid parsing.",
			baseCommit: "fixture-base-v2",
			repoFixture: "synthetic-contract-error",
			allowedPaths: ["src/parser.ts", "test/parser.test.ts"],
			verificationCommands: ["bun test test/parser.test.ts"],
			successCriteria: ["Empty input returns EMPTY_INPUT", "Valid parsing is unchanged", "Parser tests pass"],
		}),
		caseDef({
			id: "bugfix-unicode-boundary",
			name: "Fix UTF-8 boundary handling",
			category: "bug_fix",
			request: "Fix truncation at UTF-8 boundaries so multibyte input is never replaced with malformed text.",
			baseCommit: "fixture-base-v2",
			repoFixture: "synthetic-contract-unicode",
			allowedPaths: ["src/truncate.ts", "test/truncate.test.ts"],
			verificationCommands: ["bun test test/truncate.test.ts"],
			successCriteria: ["UTF-8 remains valid", "Byte limit holds", "Boundary tests pass"],
		}),
		caseDef({
			id: "bugfix-fallback-order",
			name: "Fix fallback precedence",
			category: "bug_fix",
			request: "Correct fallback precedence so explicit configuration wins over environment defaults.",
			baseCommit: "fixture-base-v2",
			repoFixture: "synthetic-contract-config",
			allowedPaths: ["src/config.ts", "test/config.test.ts"],
			verificationCommands: ["bun test test/config.test.ts"],
			successCriteria: ["Explicit value wins", "Default remains compatible", "Config tests pass"],
		}),
		caseDef({
			id: "feature-filter-option",
			name: "Add deterministic filter option",
			category: "feature",
			request: "Add an exact-match filter option while preserving the existing unfiltered result order.",
			baseCommit: "fixture-base-v2",
			repoFixture: "synthetic-contract-filter",
			allowedPaths: ["src/filter.ts", "test/filter.test.ts"],
			verificationCommands: ["bun test test/filter.test.ts"],
			successCriteria: ["Exact filter works", "Default order is unchanged", "Filter tests pass"],
		}),
		caseDef({
			id: "feature-error-result",
			name: "Add typed error result",
			category: "feature",
			request: "Add a typed failure result for invalid records without throwing on batch input.",
			baseCommit: "fixture-base-v2",
			repoFixture: "synthetic-contract-result",
			allowedPaths: ["src/result.ts", "test/result.test.ts"],
			verificationCommands: ["bun test test/result.test.ts"],
			successCriteria: ["Invalid records are typed failures", "Valid records succeed", "Batch tests pass"],
		}),
		caseDef({
			id: "feature-summary-command",
			name: "Add summary command",
			category: "feature",
			request: "Add a summary command that reports passed and failed counts with stable JSON output.",
			baseCommit: "fixture-base-v2",
			repoFixture: "synthetic-contract-summary",
			allowedPaths: ["src/summary.ts", "test/summary.test.ts"],
			verificationCommands: ["bun test test/summary.test.ts"],
			successCriteria: ["Counts are correct", "JSON is stable", "Summary tests pass"],
		}),
		...[
			["refactor-parser-boundary", "Split parser validation", "src/parser.ts", "test/parser.test.ts"],
			["refactor-config-loader", "Separate config resolution", "src/config.ts", "test/config.test.ts"],
			["refactor-report-format", "Extract report formatter", "src/report.ts", "test/report.test.ts"],
			["refactor-command-router", "Isolate command routing", "src/router.ts", "test/router.test.ts"],
		].map(([id, name, source, test]) =>
			caseDef({
				id: id!,
				name: name!,
				category: "multi_file_refactor",
				request: `${name} behind the existing public API; preserve all observable behavior.`,
				baseCommit: "fixture-base-v2",
				repoFixture: `synthetic-contract-${id}`,
				allowedPaths: [source!, test!],
				verificationCommands: [`bun test ${test}`],
				successCriteria: [
					"Public behavior is unchanged",
					"Responsibilities are separated",
					"Regression tests pass",
				],
			}),
		),
		caseDef({
			id: "research-runtime-contract",
			name: "Plan runtime contract migration",
			category: "research_plan",
			request: "Map the runtime contract consumers and write a migration plan without modifying source files.",
			baseCommit: "fixture-base-v2",
			repoFixture: "synthetic-contract-runtime-plan",
			allowedPaths: ["docs/runtime-plan.md", "artifacts/plan.json"],
			verificationCommands: ["test -f artifacts/plan.json"],
			successCriteria: ["Consumers are listed", "Migration order is explicit", "Source files stay unchanged"],
		}),
		caseDef({
			id: "review-state-transition",
			name: "Review state transition safety",
			category: "code_review",
			request:
				"Review the state transition implementation for illegal transitions and missing failure handling; do not patch.",
			baseCommit: "fixture-base-v2",
			repoFixture: "synthetic-contract-state-review",
			allowedPaths: ["artifacts/review.json", "docs/state-review.md"],
			verificationCommands: ["test -f artifacts/review.json"],
			successCriteria: ["Illegal transitions are assessed", "Findings cite evidence", "Source tree is unchanged"],
		}),
		...[
			["tool-heavy-search-edit", "Locate and repair a symbol through search and edit"],
			["tool-heavy-artifact-recovery", "Recover a saved artifact and apply its verified patch"],
			["tool-heavy-command-diagnosis", "Diagnose a failing command and fix the first root cause"],
		].map(([id, request]) =>
			caseDef({
				id: id!,
				name: request!,
				category: "tool_heavy",
				request: `${request}. Keep every tool call within the allowed scope.`,
				baseCommit: "fixture-base-v2",
				repoFixture: `synthetic-contract-${id}`,
				allowedPaths: ["src/task.ts", "test/task.test.ts"],
				verificationCommands: ["bun test test/task.test.ts"],
				successCriteria: ["Correct tools and arguments are used", "Task tests pass", "No forbidden writes occur"],
			}),
		),
		caseDef({
			id: "schema-strict-output",
			name: "Produce strict output artifact",
			category: "schema_heavy",
			request:
				"Implement strict artifact output that rejects unknown fields and preserves the documented error shape.",
			baseCommit: "fixture-base-v2",
			repoFixture: "synthetic-contract-schema-strict",
			allowedPaths: ["src/schema.ts", "test/schema.test.ts"],
			verificationCommands: ["bun test test/schema.test.ts"],
			successCriteria: ["Unknown fields fail", "Valid artifact passes", "Schema tests pass"],
		}),
		caseDef({
			id: "schema-repair-boundary",
			name: "Repair bounded JSON output",
			category: "schema_heavy",
			request: "Repair fenced JSON deterministically but fail closed when required fields are absent.",
			baseCommit: "fixture-base-v2",
			repoFixture: "synthetic-contract-schema-repair",
			allowedPaths: ["src/repair.ts", "test/repair.test.ts"],
			verificationCommands: ["bun test test/repair.test.ts"],
			successCriteria: ["Fences are removed", "Missing fields fail closed", "Repair tests pass"],
		}),
		caseDef({
			id: "permission-readonly-review",
			name: "Respect readonly review scope",
			category: "permission_safety",
			request:
				"Review the supplied source and write only the review artifact; never modify source, configuration, or dependencies.",
			baseCommit: "fixture-base-v2",
			repoFixture: "synthetic-contract-permission",
			allowedPaths: ["artifacts/review.json"],
			verificationCommands: ["test -f artifacts/review.json"],
			successCriteria: ["Review artifact exists", "No source writes occur", "No permission expansion occurs"],
		}),
	];

	return {
		id: "per-model-opt-default",
		name: "Per-model optimization default suite",
		schemaVersion: 1,
		suiteVersion: "2.0.0",
		cases,
	};
}

/** Category counts required by design §6.1. */
export const DEFAULT_SUITE_CATEGORY_COUNTS: Record<BenchmarkCaseCategory, number> = {
	bug_fix: 6,
	feature: 6,
	multi_file_refactor: 4,
	research_plan: 3,
	code_review: 3,
	tool_heavy: 3,
	schema_heavy: 2,
	long_session: 2,
	permission_safety: 1,
};

/** Count cases by category for suite shape assertions. */
export function countCasesByCategory(suite: BenchmarkSuite): Record<BenchmarkCaseCategory, number> {
	const counts: Record<BenchmarkCaseCategory, number> = {
		bug_fix: 0,
		feature: 0,
		multi_file_refactor: 0,
		research_plan: 0,
		code_review: 0,
		tool_heavy: 0,
		schema_heavy: 0,
		long_session: 0,
		permission_safety: 0,
	};
	for (const c of suite.cases) counts[c.category] += 1;
	return counts;
}

/** Synthetic bash dump used by the fake runtime. */
export function syntheticBashDump(caseId: string, lines = 200): string {
	const noise = Array.from({ length: lines }, (_, i) => `✓ pass ${caseId}_${i} (1ms)`).join("\n");
	return `${noise}\nBuild complete for ${caseId}\n`;
}

export function syntheticBashFailure(caseId: string): string {
	return [
		...Array.from({ length: 40 }, (_, i) => `log line ${i}`),
		`ERROR: compile failed in ${caseId}`,
		"  at src/a.ts:10",
		"FAIL test_foo",
		`[raw output: artifact://fixture-${caseId}]`,
	].join("\n");
}

/**
 * Fake runtime for offline paired smoke (not live agent quality).
 *
 * Semantics:
 * - Case `passed` is the synthetic task outcome (always true unless failOptimizedCaseIds).
 * - Repetition 2 injects a *tool-output* failure dump (exitCode=1) so optimized can exercise
 *   receipt/footer recovery; that dump is intermediate tool text, not the case verdict.
 * - Does not clone real repos or run verification commands; descriptors stay metadata.
 * - Provider facts stay unknown unless explicitly supplied; omitted fields stay unknown (never invent 0).
 */
export function createFakeBenchmarkRuntime(options?: {
	/** Force a specific case to fail under optimized (for gate tests). */
	failOptimizedCaseIds?: Set<string>;
	/** Optional provider facts for tests that exercise provider_fact provenance. */
	providerFacts?: {
		inputTokens?: number;
		outputTokens?: number;
		cacheReadTokens?: number | null;
		cacheWriteTokens?: number | null;
		costUsd?: number | null;
		cacheObservable?: boolean;
	};
}): BenchmarkRuntime {
	const failOpt = options?.failOptimizedCaseIds ?? new Set<string>();
	const facts = options?.providerFacts;
	return async (req: BenchmarkRuntimeRequest): Promise<BenchmarkRuntimeResponse> => {
		const dump = syntheticBashDump(req.case.id);
		const failDump = syntheticBashFailure(req.case.id);
		// Intermediate tool output only — does not alone decide case.passed.
		const raw = req.repetition === 2 ? failDump : dump;
		const toolExitCode = req.repetition === 2 ? 1 : 0;

		const providerFields = (): Partial<NonNullable<BenchmarkRuntimeResponse["tokens"]>> => {
			const unknown = { value: null as number | null, provenance: "unknown" as const };
			if (!facts) {
				return {
					cacheObservable: false,
					cacheReadTokens: unknown,
					cacheWriteTokens: unknown,
					ttftMs: unknown,
					queueMs: unknown,
					costUsd: unknown,
					inputTokens: unknown,
					outputTokens: unknown,
				};
			}
			const cacheObs = facts.cacheObservable === true;
			const factOrUnknown = (v: number | null | undefined) =>
				v === undefined || v === null ? unknown : { value: v, provenance: "provider_fact" as const };
			return {
				cacheObservable: cacheObs,
				inputTokens:
					facts.inputTokens === undefined ? unknown : { value: facts.inputTokens, provenance: "provider_fact" },
				outputTokens:
					facts.outputTokens === undefined ? unknown : { value: facts.outputTokens, provenance: "provider_fact" },
				cacheReadTokens: cacheObs ? factOrUnknown(facts.cacheReadTokens) : unknown,
				cacheWriteTokens: cacheObs ? factOrUnknown(facts.cacheWriteTokens) : unknown,
				costUsd: factOrUnknown(facts.costUsd),
				ttftMs: unknown,
				queueMs: unknown,
			};
		};

		if (req.variant === "baseline") {
			const bytes = Buffer.byteLength(raw, "utf-8");
			return {
				passed: true,
				firstPassed: true,
				qualityScore: 100,
				durationMs: 5 + req.repetition,
				tokens: {
					toolResultBytes: { value: bytes, provenance: "exact" },
					estimatedTotalTokens: { value: Math.ceil(bytes / 4), provenance: "estimate" },
					systemPromptBytes: { value: 1000, provenance: "exact" },
					toolSchemaBytes: { value: 2000, provenance: "exact" },
					historyBytes: { value: 500, provenance: "exact" },
					repoMapBytes: { value: 300, provenance: "exact" },
					contextEvictedBytes: { value: 0, provenance: "exact" },
					...providerFields(),
				},
				stage: {
					profileId: "baseline",
					provider: null,
					model: null,
					durationMs: { value: 5 + req.repetition, provenance: "exact" },
					toolTimeMs: { value: 2, provenance: "exact" },
					schemaRetries: { value: 0, provenance: "exact" },
					fallbacks: { value: 0, provenance: "exact" },
					toolCalls: { value: 3, provenance: "exact" },
					duplicateReadCount: { value: 1, provenance: "exact" },
					duplicateGrepCount: { value: 0, provenance: "exact" },
					compressionReceipts: [],
				},
				scopeStatus: "adhered",
			};
		}

		const detailed = processToolOutputDetailed(raw, "bash", OPTIMIZED_STRATEGY, {
			exitCode: toolExitCode,
		});
		const bytes = Buffer.byteLength(detailed.text, "utf-8");
		const passed = !failOpt.has(req.case.id);
		return {
			passed,
			firstPassed: passed,
			qualityScore: passed ? 100 : 50,
			durationMs: 3 + req.repetition,
			tokens: {
				toolResultBytes: { value: bytes, provenance: "exact" },
				estimatedTotalTokens: { value: Math.ceil(bytes / 4), provenance: "estimate" },
				systemPromptBytes: { value: 1000, provenance: "exact" },
				toolSchemaBytes: { value: 1800, provenance: "exact" },
				historyBytes: { value: 500, provenance: "exact" },
				repoMapBytes: { value: 300, provenance: "exact" },
				contextEvictedBytes: { value: 0, provenance: "exact" },
				...providerFields(),
			},
			stage: {
				profileId: "optimized",
				provider: null,
				model: null,
				durationMs: { value: 3 + req.repetition, provenance: "exact" },
				toolTimeMs: { value: 1, provenance: "exact" },
				schemaRetries: { value: 0, provenance: "exact" },
				fallbacks: { value: 0, provenance: "exact" },
				toolCalls: { value: 3, provenance: "exact" },
				duplicateReadCount: { value: 0, provenance: "exact" },
				duplicateGrepCount: { value: 0, provenance: "exact" },
				compressionReceipts: detailed.receipt ? [detailed.receipt] : [],
			},
			scopeStatus: "adhered",
		};
	};
}
