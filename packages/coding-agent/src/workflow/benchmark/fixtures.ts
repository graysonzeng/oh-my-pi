/**
 * Paired fake-runtime fixtures for benchmark smoke.
 * Deterministic: baseline dumps full tool output; optimized applies processToolOutput.
 */

import { DEFAULT_TRUNCATION_RULES, processToolOutputDetailed } from "../tool-output-manager";
import type { ToolStrategy } from "../types";
import type { BenchmarkRuntime, BenchmarkRuntimeRequest, BenchmarkRuntimeResponse } from "./runner";
import type { BenchmarkCase, BenchmarkSuite } from "./types";

const OPTIMIZED_STRATEGY: ToolStrategy = {
	outputTruncation: { enabled: true, rules: DEFAULT_TRUNCATION_RULES },
	resultSummarization: { enabled: true, summarizerKeys: ["bash", "read", "grep", "test", "*"] },
};

/** Ten fixed cases for suite acceptance (≥10). */
export function buildDefaultBenchmarkSuite(): BenchmarkSuite {
	const cases: BenchmarkCase[] = Array.from({ length: 10 }, (_, i) => ({
		id: `case_${String(i + 1).padStart(2, "0")}`,
		name: `Fixed task ${i + 1}`,
		request: `Implement unit task ${i + 1}: touch only allowed paths and keep tests green.`,
		baseCommit: "fixture-base",
		repoFixture: "synthetic",
		allowedPaths: [`src/task${i + 1}.ts`, `test/task${i + 1}.test.ts`],
		forbiddenPaths: ["package.json", "bun.lock", ".env"],
		verificationCommands: ["bun test", "bun check"],
		repetitions: 3,
	}));
	return {
		id: "per-model-opt-default",
		name: "Per-model optimization default suite",
		schemaVersion: 1,
		cases,
	};
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
 * Fake runtime: both variants "pass"; optimized records smaller tool-result bytes + receipts.
 * Does not call live models.
 */
export function createFakeBenchmarkRuntime(options?: {
	/** Force a specific case to fail under optimized (for gate tests). */
	failOptimizedCaseIds?: Set<string>;
}): BenchmarkRuntime {
	const failOpt = options?.failOptimizedCaseIds ?? new Set<string>();
	return async (req: BenchmarkRuntimeRequest): Promise<BenchmarkRuntimeResponse> => {
		const dump = syntheticBashDump(req.case.id);
		const failDump = syntheticBashFailure(req.case.id);
		const raw = req.repetition === 2 ? failDump : dump;

		if (req.variant === "baseline") {
			const bytes = Buffer.byteLength(raw, "utf-8");
			return {
				passed: true,
				qualityScore: 100,
				durationMs: 5 + req.repetition,
				tokens: {
					toolResultBytes: { value: bytes, provenance: "exact" },
					estimatedTotalTokens: { value: Math.ceil(bytes / 4), provenance: "estimate" },
					cacheObservable: false,
					cacheReadTokens: { value: null, provenance: "unknown" },
					cacheWriteTokens: { value: null, provenance: "unknown" },
					ttftMs: { value: null, provenance: "unknown" },
					queueMs: { value: null, provenance: "unknown" },
					costUsd: { value: null, provenance: "unknown" },
					inputTokens: { value: null, provenance: "unknown" },
					outputTokens: { value: null, provenance: "unknown" },
					systemPromptBytes: { value: 1000, provenance: "exact" },
					toolSchemaBytes: { value: 2000, provenance: "exact" },
					historyBytes: { value: 500, provenance: "exact" },
					repoMapBytes: { value: 300, provenance: "exact" },
					contextEvictedBytes: { value: 0, provenance: "exact" },
				},
				stage: {
					profileId: "baseline",
					durationMs: { value: 5 + req.repetition, provenance: "exact" },
					toolTimeMs: { value: 2, provenance: "exact" },
					schemaRetries: { value: 0, provenance: "exact" },
					fallbacks: { value: 0, provenance: "exact" },
					toolCalls: { value: 3, provenance: "exact" },
					compressionReceipts: [],
				},
				scopeStatus: "pass",
			};
		}

		const detailed = processToolOutputDetailed(raw, "bash", OPTIMIZED_STRATEGY, {
			exitCode: req.repetition === 2 ? 1 : 0,
		});
		const bytes = Buffer.byteLength(detailed.text, "utf-8");
		const passed = !failOpt.has(req.case.id);
		return {
			passed,
			qualityScore: passed ? 100 : 50,
			durationMs: 3 + req.repetition,
			tokens: {
				toolResultBytes: { value: bytes, provenance: "exact" },
				estimatedTotalTokens: { value: Math.ceil(bytes / 4), provenance: "estimate" },
				cacheObservable: false,
				cacheReadTokens: { value: null, provenance: "unknown" },
				cacheWriteTokens: { value: null, provenance: "unknown" },
				ttftMs: { value: null, provenance: "unknown" },
				queueMs: { value: null, provenance: "unknown" },
				costUsd: { value: null, provenance: "unknown" },
				inputTokens: { value: null, provenance: "unknown" },
				outputTokens: { value: null, provenance: "unknown" },
				systemPromptBytes: { value: 1000, provenance: "exact" },
				toolSchemaBytes: { value: 1800, provenance: "exact" },
				historyBytes: { value: 500, provenance: "exact" },
				repoMapBytes: { value: 300, provenance: "exact" },
				contextEvictedBytes: { value: 0, provenance: "exact" },
			},
			stage: {
				profileId: "optimized",
				durationMs: { value: 3 + req.repetition, provenance: "exact" },
				toolTimeMs: { value: 1, provenance: "exact" },
				schemaRetries: { value: 0, provenance: "exact" },
				fallbacks: { value: 0, provenance: "exact" },
				toolCalls: { value: 3, provenance: "exact" },
				compressionReceipts: detailed.receipt ? [detailed.receipt] : [],
			},
			scopeStatus: "pass",
		};
	};
}
