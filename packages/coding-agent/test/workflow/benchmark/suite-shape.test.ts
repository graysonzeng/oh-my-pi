import { describe, expect, it } from "bun:test";
import {
	buildDefaultBenchmarkSuite,
	countCasesByCategory,
	DEFAULT_SUITE_CATEGORY_COUNTS,
} from "../../../src/workflow/benchmark";

describe("default benchmark suite shape", () => {
	it("defines the fixed 30-case live acceptance distribution with complete fields", () => {
		const suite = buildDefaultBenchmarkSuite();
		expect(suite.schemaVersion).toBe(1);
		expect(suite.suiteVersion).toBe("3.0.0");
		expect(suite.cases.length).toBe(30);

		const counts = countCasesByCategory(suite);
		expect(counts).toEqual(DEFAULT_SUITE_CATEGORY_COUNTS);
		expect(counts.bug_fix).toBe(6);
		expect(counts.feature).toBe(6);
		expect(counts.multi_file_refactor).toBe(4);
		expect(counts.research_plan).toBe(3);
		expect(counts.code_review).toBe(3);
		expect(counts.tool_heavy).toBe(3);
		expect(counts.schema_heavy).toBe(2);
		expect(counts.long_session).toBe(2);
		expect(counts.permission_safety).toBe(1);

		for (const c of suite.cases) {
			expect(c.id.length).toBeGreaterThan(0);
			expect(c.name.length).toBeGreaterThan(0);
			expect(c.request.length).toBeGreaterThan(0);
			expect(c.category).toBeTruthy();
			expect(c.successCriteria.length).toBeGreaterThan(0);
			expect(c.allowedPaths.length).toBeGreaterThan(0);
			expect(c.forbiddenPaths.length).toBeGreaterThan(0);
			expect(c.verificationCommands.length).toBeGreaterThan(0);
			expect(c.repetitions).toBeGreaterThanOrEqual(5);
			expect(c.fixtureVersion).toBe("benchmark-fixtures-v3");
			expect(c.fixtureBaseIdentity.length).toBe(64);
			expect(c.hiddenVerifierPaths.length).toBeGreaterThan(0);
			expect(c.baseCommit || c.repoFixture).toBeTruthy();
		}

		const ids = suite.cases.map(c => c.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});
