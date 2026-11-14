import { describe, expect, it } from "bun:test";
import { evaluateQualityGate, QUALITY_DROP_THRESHOLD, tokenSavingsFraction } from "../../src/workflow/quality-gate";

describe("evaluateQualityGate", () => {
	it("accepts when optimized quality is equal or better", () => {
		const result = evaluateQualityGate(
			{ passRate: 0.75, qualityScore: 8.0, totalTokens: 100_000 },
			{ passRate: 0.8, qualityScore: 8.2, totalTokens: 50_000 },
		);
		expect(result.decision).toBe("accept");
		expect(result.configMode).toBe("optimized");
		expect(result.passRateDrop).toBe(0);
	});

	it("accepts when drop is within 3%", () => {
		const result = evaluateQualityGate(
			{ passRate: 0.8, qualityScore: 8.0 },
			{ passRate: 0.78, qualityScore: 7.8 }, // 2% pass drop, 0.2/10 score drop
		);
		expect(result.decision).toBe("accept");
		expect(result.passRateDrop).toBeCloseTo(0.02, 5);
	});

	it("rollbacks when pass rate drops more than 3%", () => {
		const result = evaluateQualityGate(
			{ passRate: 0.85, totalTokens: 100 },
			{ passRate: 0.8, totalTokens: 40 }, // 5% drop
		);
		expect(result.decision).toBe("rollback");
		expect(result.configMode).toBe("quality_priority");
		expect(result.passRateDrop).toBeGreaterThan(QUALITY_DROP_THRESHOLD);
		expect(result.reason).toMatch(/pass_rate_drop/);
	});

	it("rollbacks when quality score drops more than 3% of scale", () => {
		const result = evaluateQualityGate(
			{ passRate: 0.9, qualityScore: 9.0 },
			{ passRate: 0.9, qualityScore: 8.5 }, // 0.5/10 = 5% of scale
		);
		expect(result.decision).toBe("rollback");
		expect(result.configMode).toBe("quality_priority");
		expect(result.reason).toMatch(/quality_score_drop/);
	});
});

describe("tokenSavingsFraction", () => {
	it("computes relative savings", () => {
		expect(tokenSavingsFraction(100, 40)).toBeCloseTo(0.6, 5);
		expect(tokenSavingsFraction(0, 10)).toBe(0);
	});
});
