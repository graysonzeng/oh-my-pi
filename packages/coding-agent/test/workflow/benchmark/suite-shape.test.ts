import { describe, expect, it } from "bun:test";
import {
	buildDefaultBenchmarkSuite,
	countCasesByCategory,
	DEFAULT_SUITE_CATEGORY_COUNTS,
} from "../../../src/workflow/benchmark";

describe("default benchmark suite shape", () => {
	it("defines ≥10 cases with category counts 3/3/2/2/2 and complete fields", () => {
		const suite = buildDefaultBenchmarkSuite();
		expect(suite.schemaVersion).toBe(1);
		expect(suite.suiteVersion.length).toBeGreaterThan(0);
		expect(suite.cases.length).toBeGreaterThanOrEqual(10);
		expect(suite.cases.length).toBe(12);

		const counts = countCasesByCategory(suite);
		expect(counts).toEqual(DEFAULT_SUITE_CATEGORY_COUNTS);
		expect(counts.bug_fix).toBe(3);
		expect(counts.feature).toBe(3);
		expect(counts.research_plan).toBe(2);
		expect(counts.code_review).toBe(2);
		expect(counts.multi_turn).toBe(2);

		for (const c of suite.cases) {
			expect(c.id.length).toBeGreaterThan(0);
			expect(c.name.length).toBeGreaterThan(0);
			expect(c.request.length).toBeGreaterThan(0);
			expect(c.category).toBeTruthy();
			expect(c.successCriteria.length).toBeGreaterThan(0);
			expect(c.allowedPaths.length).toBeGreaterThan(0);
			expect(c.forbiddenPaths.length).toBeGreaterThan(0);
			expect(c.verificationCommands.length).toBeGreaterThan(0);
			expect(c.repetitions).toBeGreaterThanOrEqual(3);
			expect(c.baseCommit || c.repoFixture).toBeTruthy();
		}

		const ids = suite.cases.map(c => c.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});
