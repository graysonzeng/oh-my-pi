import { describe, expect, it } from "bun:test";
import {
	buildBenchmarkReport,
	buildComparisonRows,
	buildDefaultBenchmarkSuite,
	buildScorecard,
	createFakeBenchmarkRuntime,
	evaluateBenchmarkQualityGate,
	formatComparisonMarkdown,
	runBenchmarkSuite,
} from "../../../src/workflow/benchmark";

describe("comparison report + quality gate markers", () => {
	it("Markdown groups Quality / Token (measured) / Provider (actual) / Performance with Delta", async () => {
		const suite = {
			...buildDefaultBenchmarkSuite(),
			cases: buildDefaultBenchmarkSuite().cases.slice(0, 2),
		};
		const results = await runBenchmarkSuite({
			suite,
			runtime: createFakeBenchmarkRuntime(),
			minRepetitions: 3,
		});
		const report = buildBenchmarkReport(suite, results);
		const md = formatComparisonMarkdown(report);

		expect(md).toContain("## Quality");
		expect(md).toContain("## Token (measured)");
		expect(md).toContain("## Provider (actual)");
		expect(md).toContain("## Performance");
		expect(md).toContain("| Case | Metric | Baseline | Optimized | Delta |");
		expect(md).toContain("live quality unknown");
		expect(md).toContain("liveQualityUnknown");
		// Optimized should show improve markers on token metrics
		expect(md).toMatch(/✅/);
		// Estimated tokens labeled
		expect(md).toContain("estimated_total_tokens");
		expect(md).toContain("tool_result_bytes");
		// Scope adherence summary visible when runs report scopeStatus
		expect(md).toContain("scope adherence:");
		expect(md).toMatch(/adhered=/);
	});

	it("surfaces scope warning vs violation so pass+creep is distinguishable", async () => {
		const suite = buildDefaultBenchmarkSuite();
		const slim = { ...suite, cases: suite.cases.slice(0, 1) };
		const results = await runBenchmarkSuite({
			suite: slim,
			runtime: async req => ({
				passed: true,
				qualityScore: 100,
				scopeStatus: req.variant === "optimized" ? "warning" : "adhered",
				durationMs: 1,
			}),
			minRepetitions: 1,
		});
		const report = buildBenchmarkReport(slim, results);
		const md = formatComparisonMarkdown(report);
		expect(md).toContain("scope adherence:");
		expect(md).toMatch(/warning=/);
		expect(md).toMatch(/adhered=/);
		// tests pass + unplanned warning does not hard-fail gate by itself
		expect(report.gate.passed).toBe(true);
	});

	it("fails closed when paired acceptance has incomplete success or missing scope evidence", async () => {
		const suite = buildDefaultBenchmarkSuite();
		const slim = { ...suite, cases: [{ ...suite.cases[0]!, repetitions: 1 }] };
		const results = await runBenchmarkSuite({
			suite: slim,
			runtime: async req => ({
				passed: req.variant === "baseline",
				firstPassed: req.variant === "baseline",
				qualityScore: req.variant === "baseline" ? 1 : 0,
				scopeStatus: req.variant === "baseline" ? "adhered" : null,
			}),
			minRepetitions: 1,
		});
		const gate = evaluateBenchmarkQualityGate(buildScorecard(slim, results, { liveQualityUnknown: false }));
		expect(gate.passed).toBe(false);
		expect(gate.reasons).toEqual(
			expect.arrayContaining([
				expect.stringContaining("optimized passRate"),
				expect.stringContaining("missing scope evidence"),
			]),
		);
	});

	it("fails when baseline has an explicit scope violation", async () => {
		const suite = buildDefaultBenchmarkSuite();
		const slim = { ...suite, cases: [{ ...suite.cases[0]!, repetitions: 1 }] };
		const results = await runBenchmarkSuite({
			suite: slim,
			runtime: async req => ({
				passed: true,
				firstPassed: true,
				qualityScore: 1,
				scopeStatus: req.variant === "baseline" ? "violation" : "adhered",
			}),
			minRepetitions: 1,
		});
		const gate = evaluateBenchmarkQualityGate(buildScorecard(slim, results, { liveQualityUnknown: false }));
		expect(gate.passed).toBe(false);
		expect(gate.reasons).toContain(
			"bugfix-null-deref: baseline scope hard gate requires adhered; got violation (1/1)",
		);
	});
	it("marks pass-rate drop >3pp as gate failure with red fail reason", async () => {
		const suite = buildDefaultBenchmarkSuite();
		const caseId = suite.cases[0]!.id;
		const slim = { ...suite, cases: [suite.cases[0]!] };
		const results = await runBenchmarkSuite({
			suite: slim,
			runtime: createFakeBenchmarkRuntime({
				failOptimizedCaseIds: new Set([caseId]),
			}),
			minRepetitions: 3,
		});
		const scorecard = buildScorecard(slim, results);
		const gate = evaluateBenchmarkQualityGate(scorecard);
		expect(gate.passed).toBe(false);
		expect(gate.reasons.some(r => r.includes(caseId) && r.includes("dropped"))).toBe(true);

		const report = buildBenchmarkReport(slim, results);
		expect(report.gate.passed).toBe(false);
		const passRows = buildComparisonRows(scorecard, gate).filter(
			r => r.metric === "pass_rate" && r.caseId === caseId,
		);
		expect(passRows.length).toBe(1);
		expect(passRows[0]!.gateFail).toBe(true);
		expect(passRows[0]!.marker).toBe("❌");

		const md = formatComparisonMarkdown(report);
		expect(md).toMatch(/❌ failed|gate.passed=false|quality gate: ❌/);
		expect(md).toContain("FAIL");
	});

	it("quality-score-only drop marks quality_score not pass_rate", async () => {
		const suite = buildDefaultBenchmarkSuite();
		const slim = { ...suite, cases: [suite.cases[0]!] };
		const results = await runBenchmarkSuite({
			suite: slim,
			runtime: async req => ({
				passed: true,
				firstPassed: true,
				qualityScore: req.variant === "optimized" ? 90 : 100,
				durationMs: 1,
				tokens: {
					toolResultBytes: { value: 100, provenance: "exact" },
					estimatedTotalTokens: { value: 25, provenance: "estimate" },
				},
			}),
			minRepetitions: 3,
		});
		const scorecard = buildScorecard(slim, results);
		const gate = evaluateBenchmarkQualityGate(scorecard);
		expect(gate.passed).toBe(false);
		expect(gate.reasons.some(r => /quality dropped/.test(r))).toBe(true);

		const rows = buildComparisonRows(scorecard, gate);
		const passRow = rows.find(r => r.metric === "pass_rate")!;
		const qRow = rows.find(r => r.metric === "quality_score")!;
		expect(passRow.gateFail).toBeUndefined();
		expect(passRow.marker).toBe("—");
		expect(qRow.gateFail).toBe(true);
		expect(qRow.marker).toBe("❌");
	});

	it("single-variant scorecard is inconclusive (gate fails)", async () => {
		const suite = buildDefaultBenchmarkSuite();
		const slim = { ...suite, cases: [suite.cases[0]!] };
		const results = await runBenchmarkSuite({
			suite: slim,
			runtime: createFakeBenchmarkRuntime(),
			variants: ["optimized"],
			minRepetitions: 1,
		});
		const gate = evaluateBenchmarkQualityGate(buildScorecard(slim, results));
		expect(gate.passed).toBe(false);
		expect(gate.reasons.some(r => /inconclusive/.test(r))).toBe(true);
	});

	it("exact 3pp pass-rate drop does not fail gate (contract is drop > 3pp)", async () => {
		const suite = buildDefaultBenchmarkSuite();
		const slim = { ...suite, cases: [suite.cases[0]!] };
		// 100 baseline passes / 97 optimized → exactly 3pp; float would make (1-0.97)*100 > 3.
		const total = 100;
		const optPass = 97;
		let baseI = 0;
		let optI = 0;
		const results = await runBenchmarkSuite({
			suite: slim,
			runtime: async req => {
				const i = req.variant === "baseline" ? baseI++ : optI++;
				const passed = req.variant === "baseline" ? i < total : i < optPass;
				return {
					passed,
					firstPassed: passed,
					qualityScore: 100,
					durationMs: 1,
					scopeStatus: "adhered",
					tokens: {
						toolResultBytes: { value: 100, provenance: "exact" },
						estimatedTotalTokens: { value: 25, provenance: "estimate" },
					},
				};
			},
			minRepetitions: total,
		});
		const scorecard = buildScorecard(slim, results);
		const base = scorecard.summaries.find(s => s.variant === "baseline")!;
		const opt = scorecard.summaries.find(s => s.variant === "optimized")!;
		expect(base.passRate).toBe(1);
		expect(opt.passRate).toBe(0.97);
		// Prove the float trap still exists on raw arithmetic
		expect((base.passRate - opt.passRate) * 100).toBeGreaterThan(3);

		const gate = evaluateBenchmarkQualityGate(scorecard, {
			minPassRate: 0,
			maxPassRateDropPp: 3,
			maxQualityDropPp: 3,
		});
		expect(gate.passed).toBe(true);
		expect(gate.reasons.some(r => /passRate dropped/.test(r))).toBe(false);

		const passRow = buildComparisonRows(scorecard, gate).find(r => r.metric === "pass_rate")!;
		// May still show regress marker (lower rate) but must NOT gate-fail at exactly 3pp.
		expect(passRow.gateFail).toBeUndefined();
		expect(passRow.delta).toBeCloseTo(-3, 5);
	});

	it("pass-rate drop of 4pp still fails gate", async () => {
		const suite = buildDefaultBenchmarkSuite();
		const slim = { ...suite, cases: [suite.cases[0]!] };
		const total = 100;
		const optPass = 96;
		let baseI = 0;
		let optI = 0;
		const results = await runBenchmarkSuite({
			suite: slim,
			runtime: async req => {
				const i = req.variant === "baseline" ? baseI++ : optI++;
				const passed = req.variant === "baseline" ? i < total : i < optPass;
				return { passed, qualityScore: 100, durationMs: 1 };
			},
			minRepetitions: total,
		});
		const scorecard = buildScorecard(slim, results);
		const gate = evaluateBenchmarkQualityGate(scorecard);
		expect(gate.passed).toBe(false);
		expect(gate.reasons.some(r => /passRate dropped/.test(r))).toBe(true);
		const passRow = buildComparisonRows(scorecard, gate).find(r => r.metric === "pass_rate")!;
		expect(passRow.gateFail).toBe(true);
	});
});
