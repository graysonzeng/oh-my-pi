import { describe, expect, it } from "bun:test";
import type { BenchmarkRunOptions, BenchmarkSuite } from "../../../src/workflow/benchmark";
import {
	buildBenchmarkReport,
	buildDefaultBenchmarkSuite,
	buildFingerprint,
	buildScorecard,
	caseFingerprint,
	createFakeBenchmarkRuntime,
	fingerprintIdentity,
	resolveActiveLever,
	runBenchmarkSuite,
} from "../../../src/workflow/benchmark";

function miniSuite(): BenchmarkSuite {
	const full = buildDefaultBenchmarkSuite();
	return { ...full, cases: full.cases.slice(0, 1) };
}

function baseOpts(suite: BenchmarkSuite, over: Partial<BenchmarkRunOptions> = {}): BenchmarkRunOptions {
	return {
		suite,
		runtime: createFakeBenchmarkRuntime(),
		optimizedProfileId: "grok_implementer",
		optimizedStrategyFingerprint: "smart-v1",
		...over,
	};
}

describe("benchmark fingerprint + single-lever policy", () => {
	it("same identity is deterministic across builds and repetitions", async () => {
		const suite = miniSuite();
		const opts = baseOpts(suite, {
			provider: "openai",
			model: "gpt-5.4",
			checkpoint: "2026-03-01",
			api: "responses",
			adapter: "pi-ai@1",
			parser: "sse-v1",
			modelFactsFingerprint: "facts-aaa",
			taskPolicyFingerprint: "task-bbb",
			sessionStateFingerprint: "session-ccc",
			compiledPolicyFingerprint: "policy-ddd",
			compiledPolicyReceiptId: "receipt-eee",
			activeLever: "prompt_overlay",
		});
		const a = buildFingerprint(suite, suite.cases[0]!, "optimized", opts);
		const b = buildFingerprint(suite, suite.cases[0]!, "optimized", opts);
		expect(a).toEqual(b);
		expect(fingerprintIdentity(a)).toBe(fingerprintIdentity(b));
		// No timestamps on fingerprint object.
		expect(JSON.stringify(a)).not.toMatch(/T\d{2}:\d{2}:\d{2}/);
		expect(a).not.toHaveProperty("generatedAt" as never);

		const results = await runBenchmarkSuite({ ...opts, minRepetitions: 2 });
		const ids = results.map(r => fingerprintIdentity(r.fingerprint));
		// Same case×variant shares identity across reps.
		const optIds = results
			.filter(r => r.fingerprint.variant === "optimized")
			.map(r => fingerprintIdentity(r.fingerprint));
		expect(new Set(optIds).size).toBe(1);
		expect(ids.length).toBeGreaterThan(0);
	});

	it("interleaves and counterbalances paired variants by repetition", async () => {
		const suite = miniSuite();
		suite.cases = [{ ...suite.cases[0]!, repetitions: 2 }];
		const order: string[] = [];
		await runBenchmarkSuite({
			...baseOpts(suite),
			runtime: async request => {
				order.push(`${request.variant}:${request.repetition}`);
				return { passed: true, qualityScore: 1, durationMs: 1 };
			},
		});
		expect(order).toEqual(["baseline:1", "optimized:1", "optimized:2", "baseline:2"]);
	});

	it("any identity / policy / lever change flips the identity hash", () => {
		const suite = miniSuite();
		const base = baseOpts(suite, {
			provider: "openai",
			model: "gpt-5.4",
			checkpoint: "2026-03-01",
			api: "responses",
			adapter: "pi-ai@1",
			parser: "sse-v1",
			modelFactsFingerprint: "facts-aaa",
			taskPolicyFingerprint: "task-bbb",
			sessionStateFingerprint: "session-ccc",
			compiledPolicyFingerprint: "policy-ddd",
			compiledPolicyReceiptId: "receipt-eee",
			activeLever: "prompt_overlay",
		});
		const root = fingerprintIdentity(buildFingerprint(suite, suite.cases[0]!, "optimized", base));
		const mutations: Array<Partial<BenchmarkRunOptions>> = [
			{ provider: "anthropic" },
			{ model: "claude-opus" },
			{ checkpoint: "2026-04-01" },
			{ api: "messages" },
			{ adapter: "pi-ai@2" },
			{ parser: "event-stream-v2" },
			{ modelFactsFingerprint: "facts-zzz" },
			{ taskPolicyFingerprint: "task-zzz" },
			{ sessionStateFingerprint: "session-zzz" },
			{ compiledPolicyFingerprint: "policy-zzz" },
			{ compiledPolicyReceiptId: "receipt-zzz" },
			{ activeLever: "tool_surface" },
		];
		for (const m of mutations) {
			const next = fingerprintIdentity(buildFingerprint(suite, suite.cases[0]!, "optimized", { ...base, ...m }));
			expect(next).not.toBe(root);
		}
		// variant change also flips
		const baseFp = fingerprintIdentity(buildFingerprint(suite, suite.cases[0]!, "baseline", base));
		expect(baseFp).not.toBe(root);
	});

	it("rejects multi-lever ordinary paired runs without combinationRun", () => {
		expect(() => resolveActiveLever(["prompt_overlay", "tool_surface"], false)).toThrow(/single-lever invariant/);
		expect(() => resolveActiveLever(["prompt_overlay", "tool_surface"], undefined)).toThrow(/single-lever invariant/);
		const suite = miniSuite();
		expect(() =>
			buildFingerprint(suite, suite.cases[0]!, "optimized", {
				...baseOpts(suite),
				activeLever: ["prompt_overlay", "context_cache"],
			}),
		).toThrow(/single-lever invariant/);
	});

	it("allows explicit combination runs without mutating production profile stamps", () => {
		const suite = miniSuite();
		const fp = buildFingerprint(suite, suite.cases[0]!, "optimized", {
			...baseOpts(suite),
			activeLever: ["prompt_overlay", "tool_surface"],
			combinationRun: true,
			// profile/strategy stamps remain explicit caller values only
			optimizedProfileId: "combo-profile",
			optimizedStrategyFingerprint: "combo-strategy",
		});
		expect(fp.activeLever).toBe("combo:prompt_overlay+tool_surface");
		expect(fp.profileId).toBe("combo-profile");
		expect(fp.strategyFingerprint).toBe("combo-strategy");
		// order-insensitive
		const fp2 = buildFingerprint(suite, suite.cases[0]!, "optimized", {
			...baseOpts(suite),
			activeLever: ["tool_surface", "prompt_overlay"],
			combinationRun: true,
		});
		expect(fp2.activeLever).toBe("combo:prompt_overlay+tool_surface");
	});

	it("keeps old fixture callers compatible when identity fields are omitted", async () => {
		const suite = miniSuite();
		const results = await runBenchmarkSuite({
			suite,
			runtime: createFakeBenchmarkRuntime(),
			optimizedProfileId: "grok_implementer",
			optimizedStrategyFingerprint: "smart-v1",
			minRepetitions: 1,
		});
		expect(results.length).toBe(suite.cases.length * 2 * suite.cases[0]!.repetitions);
		for (const r of results) {
			expect(r.fingerprint.provider).toBeNull();
			expect(r.fingerprint.model).toBeNull();
			expect(r.fingerprint.checkpoint).toBeNull();
			expect(r.fingerprint.api).toBeNull();
			expect(r.fingerprint.adapter).toBeNull();
			expect(r.fingerprint.parser).toBeNull();
			expect(r.fingerprint.modelFactsFingerprint).toBeNull();
			expect(r.fingerprint.taskPolicyFingerprint).toBeNull();
			expect(r.fingerprint.sessionStateFingerprint).toBeNull();
			expect(r.fingerprint.compiledPolicyFingerprint).toBeNull();
			expect(r.fingerprint.compiledPolicyReceiptId).toBeNull();
			expect(r.fingerprint.activeLever).toBeNull();
			expect(r.fingerprint.caseFingerprint).toBe(caseFingerprint(suite.cases[0]!));
		}
		const scorecard = buildScorecard(suite, results);
		expect(scorecard.liveQualityUnknown).toBe(true);
		expect(scorecard.notes.some(n => n.includes("live quality unknown"))).toBe(true);
		expect(scorecard.notes.some(n => n.includes("cache facts unknown"))).toBe(true);
		// No live quality claim.
		expect(scorecard.notes.join(" ")).not.toMatch(/quality gain|quality improved|pass rate improved/i);
	});

	it("associates compiled policy receipt id/hash on scorecard and report", async () => {
		const suite = miniSuite();
		const results = await runBenchmarkSuite({
			...baseOpts(suite),
			minRepetitions: 1,
			compiledPolicyFingerprint: "policy-hash-1",
			compiledPolicyReceiptId: "rcp_abc",
			activeLever: "structured_tier",
			modelFactsFingerprint: "facts-1",
			taskPolicyFingerprint: "task-1",
			sessionStateFingerprint: "session-1",
		});
		const scorecard = buildScorecard(suite, results);
		expect(scorecard.compiledPolicyFingerprint).toBe("policy-hash-1");
		expect(scorecard.compiledPolicyReceiptId).toBe("rcp_abc");
		expect(scorecard.activeLever).toBe("structured_tier");
		expect(scorecard.notes).toEqual(
			expect.arrayContaining([
				"compiledPolicyReceiptId=rcp_abc",
				"compiledPolicyFingerprint=policy-hash-1",
				"activeLever=structured_tier",
			]),
		);
		const report = buildBenchmarkReport(suite, results);
		expect(report.compiledPolicyReceiptId).toBe("rcp_abc");
		expect(report.compiledPolicyFingerprint).toBe("policy-hash-1");
		expect(report.activeLever).toBe("structured_tier");
		expect(report.liveQualityUnknown).toBe(true);
		// Provenance buckets preserved on fake runtime.
		const run = results[0]!;
		expect(run.tokens.toolResultBytes.provenance).toBe("exact");
		expect(run.tokens.estimatedTotalTokens.provenance).toBe("estimate");
		expect(run.tokens.cacheReadTokens.provenance).toBe("unknown");
		expect(run.tokens.cacheObservable).toBe(false);
	});
});
