import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	applyKnownGoodBenchmarkSolution,
	buildDefaultBenchmarkSuite,
	buildLiveBenchmarkProfileOverrides,
	createLiveWorkflowBenchmarkRuntime,
	runBenchmarkSuite,
} from "../../../src/workflow/benchmark";
import type { BenchmarkRuntimeProvenance } from "../../../src/workflow/benchmark/types";

const FIXTURE_PROVENANCE: BenchmarkRuntimeProvenance = {
	source: "runtime_observed",
	provider: "fixture-provider",
	model: "fixture-model",
	checkpoint: null,
	api: "openai-completions",
	adapter: "coding-agent:createAgentSession",
	parser: "pi-ai:openai-completions",
};

describe("live workflow benchmark runtime", () => {
	it("uses the agent seam, verifies the fixture, and reports provider facts without synthetic quality", async () => {
		const suite = buildDefaultBenchmarkSuite();
		const benchmarkCase = suite.cases.find(item => item.id === "bugfix-null-deref");
		expect(benchmarkCase).toBeDefined();
		const selectedSuite = { ...suite, cases: [benchmarkCase!] };
		let calls = 0;
		const runtime = createLiveWorkflowBenchmarkRuntime({
			provider: "fixture-provider",
			model: "fixture-model",
			agentRunner: async (request, cwd) => {
				calls += 1;
				await applyKnownGoodBenchmarkSolution(cwd, request.case);
				return {
					terminalStatus: "completed",
					inputTokens: 11,
					outputTokens: 7,
					cacheReadTokens: 3,
					cacheWriteTokens: 0,
					cacheObservable: true,
					costUsd: 0.02,
					toolCalls: 2,
					usageObservable: true,
					runtimeProvenance: FIXTURE_PROVENANCE,
				};
			},
		});

		const results = await runBenchmarkSuite({
			suite: selectedSuite,
			runtime,
			variants: ["baseline"],
			minRepetitions: 1,
			liveQualityUnknown: false,
			provider: "fixture-provider",
			model: "fixture-model",
		});

		expect(calls).toBe(5);
		expect(results.map(result => result.error)).toEqual([undefined, undefined, undefined, undefined, undefined]);
		expect(results.every(result => result.passed)).toBe(true);
		expect(results.every(result => result.scopeStatus === "adhered")).toBe(true);
		expect(results.every(result => result.runtimeProvenance?.provider === "fixture-provider")).toBe(true);
		expect(results[0]?.tokens.inputTokens).toEqual({ value: 11, provenance: "provider_fact" });
		expect(results[0]?.stage.toolCalls).toEqual({ value: 2, provenance: "exact" });
		expect(results[0]?.stage.schemaRetries).toEqual({ value: null, provenance: "unknown" });
		expect(results[0]?.stage.duplicateReadCount).toEqual({ value: null, provenance: "unknown" });
		expect(results[0]?.tokens.costUsd).toEqual({ value: 0.02, provenance: "provider_fact" });
	}, 20_000);

	it("materializes and verifies every fixed live-suite fixture", async () => {
		const suite = buildDefaultBenchmarkSuite();
		const runtime = createLiveWorkflowBenchmarkRuntime({
			provider: "fixture-provider",
			model: "fixture-model",
			agentRunner: async (request, cwd) => {
				await applyKnownGoodBenchmarkSolution(cwd, request.case);
				return {
					terminalStatus: "completed",
					inputTokens: 1,
					outputTokens: 1,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					cacheObservable: false,
					usageObservable: false,
					costUsd: 0,
					toolCalls: 1,
					runtimeProvenance: FIXTURE_PROVENANCE,
				};
			},
		});

		for (const benchmarkCase of suite.cases) {
			const [result] = await runBenchmarkSuite({
				suite: { ...suite, cases: [{ ...benchmarkCase, repetitions: 1 }] },
				runtime,
				variants: ["baseline"],
			});
			expect(result?.error).toBeUndefined();
			expect(result?.passed).toBe(true);
			expect(result?.scopeStatus).toBe("adhered");
		}
	}, 60_000);

	it("keeps outer-session zero usage unknown when workflow child usage is not observable", async () => {
		const suite = buildDefaultBenchmarkSuite();
		const benchmarkCase = { ...suite.cases[0]!, repetitions: 1 };
		const runtime = createLiveWorkflowBenchmarkRuntime({
			provider: "fixture-provider",
			model: "fixture-model",
			agentRunner: async (request, cwd) => {
				await applyKnownGoodBenchmarkSolution(cwd, request.case);
				return {
					terminalStatus: "completed",
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					cacheObservable: false,
					usageObservable: false,
					costUsd: 0,
					toolCalls: 0,
				};
			},
		});
		const [result] = await runBenchmarkSuite({
			suite: { ...suite, cases: [benchmarkCase] },
			runtime,
			variants: ["baseline"],
			minRepetitions: 1,
		});
		expect(result?.tokens.inputTokens).toEqual({ value: null, provenance: "unknown" });
		expect(result?.tokens.outputTokens).toEqual({ value: null, provenance: "unknown" });
		expect(result?.tokens.costUsd).toEqual({ value: null, provenance: "unknown" });
	});

	it("fails closed when provider or model is omitted", () => {
		expect(() => createLiveWorkflowBenchmarkRuntime({ provider: "", model: "model" })).toThrow(
			"explicit provider and model",
		);
		expect(() => createLiveWorkflowBenchmarkRuntime({ provider: "provider", model: "" })).toThrow(
			"explicit provider and model",
		);
	});

	it("builds a real baseline without optimization strategies and preserves them for optimized", () => {
		const baseline = buildLiveBenchmarkProfileOverrides("provider", "model", "baseline");
		const optimized = buildLiveBenchmarkProfileOverrides("provider", "model", "optimized");
		const profileId = Object.keys(baseline)[0]!;
		expect(baseline[profileId]?.modelPattern).toBe("provider/model");
		expect(optimized[profileId]?.modelPattern).toBe("provider/model");
		expect(baseline[profileId]?.toolStrategy).toBeUndefined();
		expect(baseline[profileId]?.promptStrategy).toBeUndefined();
		expect(baseline[profileId]?.presentationPolicy).toEqual({ enabled: false, mode: "direct" });
		expect(Object.hasOwn(optimized[profileId] ?? {}, "toolStrategy")).toBe(false);
		for (const overrides of [baseline, optimized]) {
			for (const profile of Object.values(overrides)) {
				expect(profile.maxRuntimeMs).toBe(600_000);
				expect(profile.retryPolicy).toEqual({
					maxAttempts: 1,
					retryableErrorKinds: [],
					fallbackProfileIds: [],
				});
			}
		}
	});

	it("includes untracked files in the live scope verdict", async () => {
		const suite = buildDefaultBenchmarkSuite();
		const benchmarkCase = suite.cases.find(item => item.id === "bugfix-null-deref")!;
		const runtime = createLiveWorkflowBenchmarkRuntime({
			provider: "fixture-provider",
			model: "fixture-model",
			agentRunner: async (_request, cwd) => {
				await Bun.write(path.join(cwd, "untracked.txt"), "out of scope\n");
				return {
					terminalStatus: "completed",
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					cacheObservable: false,
					usageObservable: false,
					costUsd: 0,
					toolCalls: 0,
				};
			},
		});
		const [result] = await runBenchmarkSuite({
			suite: { ...suite, cases: [{ ...benchmarkCase, repetitions: 1, verificationCommands: [] }] },
			runtime,
			variants: ["baseline"],
		});
		expect(result?.passed).toBe(false);
		expect(result?.scopeStatus).toBe("violation");
		expect(result?.error).toContain("untracked.txt");
	}, 10_000);

	it("still reports scope evidence when the agent seam throws before completion", async () => {
		const suite = buildDefaultBenchmarkSuite();
		const benchmarkCase = { ...suite.cases[0]!, repetitions: 1, verificationCommands: [] };
		const runtime = createLiveWorkflowBenchmarkRuntime({
			provider: "fixture-provider",
			model: "fixture-model",
			agentRunner: async () => {
				throw new Error("Policy violation: required_role_unavailable: planner");
			},
		});
		const [result] = await runBenchmarkSuite({
			suite: { ...suite, cases: [benchmarkCase] },
			runtime,
			variants: ["baseline"],
			minRepetitions: 1,
		});
		expect(result?.passed).toBe(false);
		expect(result?.scopeStatus).toBe("adhered");
		expect(result?.error).toContain("required_role_unavailable");
		expect(result?.runtimeProvenance).toBeNull();
	}, 10_000);
});
