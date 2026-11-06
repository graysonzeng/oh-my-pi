import { describe, expect, it } from "bun:test";
import {
	buildBenchmarkReport,
	buildDefaultBenchmarkSuite,
	buildScorecard,
	caseFingerprint,
	createFakeBenchmarkRuntime,
	evaluateBenchmarkQualityGate,
	runBenchmarkSuite,
} from "../../../src/workflow/benchmark";

describe("paired fake-runtime smoke", () => {
	it("runs baseline vs optimized with equal fingerprints, 3 reps, and provenance buckets", async () => {
		const suite = buildDefaultBenchmarkSuite();
		const results = await runBenchmarkSuite({
			suite,
			runtime: createFakeBenchmarkRuntime(),
			optimizedProfileId: "grok_implementer",
			optimizedStrategyFingerprint: "smart-v1",
		});

		const caseCount = suite.cases.length;
		// cases × 2 variants × 5 fixed live-acceptance repetitions
		expect(results.length).toBe(caseCount * 2 * 5);

		// Same case fingerprint across variants
		for (const c of suite.cases) {
			const base = results.find(r => r.fingerprint.caseId === c.id && r.fingerprint.variant === "baseline")!;
			const opt = results.find(r => r.fingerprint.caseId === c.id && r.fingerprint.variant === "optimized")!;
			expect(base.fingerprint.caseFingerprint).toBe(opt.fingerprint.caseFingerprint);
			expect(base.fingerprint.caseFingerprint).toBe(caseFingerprint(c));
			expect(base.fingerprint.profileId).toBe("baseline");
			expect(opt.fingerprint.profileId).toBe("grok_implementer");
			expect(opt.fingerprint.strategyFingerprint).toBe("smart-v1");
		}

		const scorecard = buildScorecard(suite, results);
		expect(scorecard.liveQualityUnknown).toBe(true);
		expect(scorecard.suiteVersion).toBe(suite.suiteVersion);
		expect(scorecard.summaries.length).toBe(caseCount * 2);

		// Aggregation: 5 runs per case×variant, pass rates in [0,1]
		for (const s of scorecard.summaries) {
			expect(s.runs.length).toBe(5);
			expect(s.passRate).toBeGreaterThanOrEqual(0);
			expect(s.passRate).toBeLessThanOrEqual(1);
			expect(s.firstPassRate).not.toBeNull();
		}

		// Optimized tool-result / estimated tokens smaller than baseline
		const firstId = suite.cases[0]!.id;
		const base = scorecard.summaries.find(s => s.caseId === firstId && s.variant === "baseline")!;
		const opt = scorecard.summaries.find(s => s.caseId === firstId && s.variant === "optimized")!;
		expect(opt.meanEstimatedTokens).not.toBeNull();
		expect(base.meanEstimatedTokens).not.toBeNull();
		expect(opt.meanEstimatedTokens!).toBeLessThan(base.meanEstimatedTokens!);
		expect(opt.meanToolResultBytes!).toBeLessThan(base.meanToolResultBytes!);
		expect(opt.meanToolSchemaBytes!).toBeLessThan(base.meanToolSchemaBytes!);

		// Unknown fields stay null
		const run = opt.runs[0]!;
		expect(run.tokens.cacheObservable).toBe(false);
		expect(run.tokens.cacheReadTokens.value).toBeNull();
		expect(run.tokens.cacheReadTokens.provenance).toBe("unknown");
		expect(run.tokens.ttftMs.value).toBeNull();
		expect(run.tokens.ttftMs.provenance).toBe("unknown");
		expect(run.tokens.queueMs.value).toBeNull();
		expect(run.tokens.inputTokens.value).toBeNull();
		expect(run.tokens.estimatedTotalTokens.provenance).toBe("estimate");
		expect(run.tokens.toolResultBytes.provenance).toBe("exact");
		expect(run.tokens.systemPromptBytes.provenance).toBe("exact");

		const gate = evaluateBenchmarkQualityGate(scorecard);
		expect(gate.passed).toBe(true);

		const report = buildBenchmarkReport(suite, results);
		expect(report.liveQualityUnknown).toBe(true);
		expect(report.comparison.length).toBeGreaterThan(0);
		expect(report.gate.passed).toBe(true);
	});

	it("preserves artifact footer through optimized fake runtime failure dump", async () => {
		const suite = buildDefaultBenchmarkSuite();
		const oneCase = { ...suite, cases: [suite.cases[0]!] };
		const results = await runBenchmarkSuite({
			suite: oneCase,
			runtime: createFakeBenchmarkRuntime(),
			variants: ["optimized"],
		});
		const failRep = results.find(r => r.repetition === 2)!;
		expect(failRep.stage.compressionReceipts.length).toBeGreaterThan(0);
		expect(failRep.stage.compressionReceipts[0]?.recoveryUri).toBe(`artifact://fixture-${suite.cases[0]!.id}`);
	});

	it("accepts optional provider facts without inventing cache when not observable", async () => {
		const suite = buildDefaultBenchmarkSuite();
		const one = { ...suite, cases: [suite.cases[0]!] };
		const results = await runBenchmarkSuite({
			suite: one,
			runtime: createFakeBenchmarkRuntime({
				providerFacts: {
					inputTokens: 1200,
					outputTokens: 300,
					cacheObservable: false,
					costUsd: null,
				},
			}),
			minRepetitions: 1,
			variants: ["baseline"],
		});
		const run = results[0]!;
		expect(run.tokens.inputTokens.value).toBe(1200);
		expect(run.tokens.inputTokens.provenance).toBe("provider_fact");
		expect(run.tokens.cacheReadTokens.value).toBeNull();
		expect(run.tokens.cacheReadTokens.provenance).toBe("unknown");
		expect(run.tokens.costUsd.value).toBeNull();
		expect(run.tokens.costUsd.provenance).toBe("unknown");
	});

	it("does not invent provider_fact zeros for omitted cache counters", async () => {
		const suite = buildDefaultBenchmarkSuite();
		const one = { ...suite, cases: [suite.cases[0]!] };
		const results = await runBenchmarkSuite({
			suite: one,
			runtime: createFakeBenchmarkRuntime({
				providerFacts: {
					cacheObservable: true,
					// intentionally omit input/output/cache counts
				},
			}),
			minRepetitions: 1,
			variants: ["baseline"],
		});
		const run = results[0]!;
		expect(run.tokens.cacheObservable).toBe(true);
		expect(run.tokens.inputTokens.value).toBeNull();
		expect(run.tokens.inputTokens.provenance).toBe("unknown");
		expect(run.tokens.cacheReadTokens.value).toBeNull();
		expect(run.tokens.cacheReadTokens.provenance).toBe("unknown");
	});

	it("rep2 failure dump is intermediate tool text; case still passes unless fail set", async () => {
		const suite = buildDefaultBenchmarkSuite();
		const one = { ...suite, cases: [suite.cases[0]!] };
		const results = await runBenchmarkSuite({
			suite: one,
			runtime: createFakeBenchmarkRuntime(),
			variants: ["optimized"],
			minRepetitions: 3,
		});
		const failRep = results.find(r => r.repetition === 2)!;
		// Tool dump may contain ERROR text + receipt, but synthetic case verdict stays pass.
		expect(failRep.passed).toBe(true);
		expect(failRep.qualityScore).toBe(100);
		expect(failRep.stage.compressionReceipts.length).toBeGreaterThan(0);
		expect(failRep.stage.compressionReceipts[0]?.recoveryUri).toContain("artifact://fixture-");
		expect(results.every(r => r.passed)).toBe(true);
	});
});
