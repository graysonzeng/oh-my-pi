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
		repetitions: 3,
		forbiddenPaths: partial.forbiddenPaths ?? [...FORBIDDEN_ROOT],
		...partial,
	};
}

/**
 * Twelve fixed cases for suite acceptance (categories 3/3/2/2/2).
 * Paths and verification commands are synthetic but deterministic (no network/time/RNG).
 */
export function buildDefaultBenchmarkSuite(): BenchmarkSuite {
	const cases: BenchmarkCase[] = [
		// --- bug_fix ×3 ---
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
		// --- multi_turn ×2 ---
		caseDef({
			id: "multiturn-fix-then-test",
			name: "Multi-turn fix then strengthen tests",
			category: "multi_turn",
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
			category: "multi_turn",
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
	];

	return {
		id: "per-model-opt-default",
		name: "Per-model optimization default suite",
		schemaVersion: 1,
		suiteVersion: "1.0.0",
		cases,
	};
}

/** Category counts expected for the default suite composition gate. */
export const DEFAULT_SUITE_CATEGORY_COUNTS: Record<BenchmarkCaseCategory, number> = {
	bug_fix: 3,
	feature: 3,
	research_plan: 2,
	code_review: 2,
	multi_turn: 2,
};

/** Count cases by category for suite shape assertions. */
export function countCasesByCategory(suite: BenchmarkSuite): Record<BenchmarkCaseCategory, number> {
	const counts: Record<BenchmarkCaseCategory, number> = {
		bug_fix: 0,
		feature: 0,
		research_plan: 0,
		code_review: 0,
		multi_turn: 0,
	};
	for (const c of suite.cases) {
		counts[c.category] += 1;
	}
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
