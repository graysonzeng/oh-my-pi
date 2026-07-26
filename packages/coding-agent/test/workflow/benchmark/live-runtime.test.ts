import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	buildDefaultBenchmarkSuite,
	buildLiveBenchmarkProfileOverrides,
	createLiveWorkflowBenchmarkRuntime,
	runBenchmarkSuite,
} from "../../../src/workflow/benchmark";

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
			agentRunner: async (_request, cwd) => {
				calls += 1;
				await Bun.write(
					path.join(cwd, "src/parser.ts"),
					'export function parseValue(input: string | null): string {\n\treturn input?.trim() ?? "";\n}\n',
				);
				return {
					terminalStatus: "completed",
					inputTokens: 11,
					outputTokens: 7,
					cacheReadTokens: 3,
					cacheWriteTokens: 0,
					cacheObservable: true,
					costUsd: 0.02,
					toolCalls: 2,
				};
			},
		});

		const results = await runBenchmarkSuite({
			suite: selectedSuite,
			runtime,
			variants: ["baseline"],
			minRepetitions: 1,
			liveQualityUnknown: false,
		});

		expect(calls).toBe(3);
		expect(results.map(result => result.error)).toEqual([undefined, undefined, undefined]);
		expect(results.every(result => result.passed)).toBe(true);
		expect(results.every(result => result.scopeStatus === "adhered")).toBe(true);
		expect(results[0]?.tokens.inputTokens).toEqual({ value: 11, provenance: "provider_fact" });
		expect(results[0]?.stage.toolCalls).toEqual({ value: 2, provenance: "exact" });
		expect(results[0]?.stage.schemaRetries).toEqual({ value: null, provenance: "unknown" });
		expect(results[0]?.stage.duplicateReadCount).toEqual({ value: null, provenance: "unknown" });
	}, 20_000);

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
});
