import { describe, expect, it } from "bun:test";
import {
	readPathFromToolArgs,
	resolveReviewerSoftRequestBudget,
	resolveReviewerSoftRuntimeMs,
	shouldPreserveExplicitReadRange,
} from "@oh-my-pi/pi-coding-agent/task";

describe("reviewer performance helpers", () => {
	it("caps reviewer-class request budgets at 80", () => {
		expect(resolveReviewerSoftRequestBudget("reviewer", 200)).toBe(80);
		expect(resolveReviewerSoftRequestBudget("subagent-sol", 90)).toBe(80);
		expect(resolveReviewerSoftRequestBudget("reviewer", 20)).toBe(20);
		expect(resolveReviewerSoftRequestBudget("reviewer", 0)).toBe(0);
	});

	it("schedules a reviewer wrap-up before the hard wall-clock abort", () => {
		expect(resolveReviewerSoftRuntimeMs("reviewer", 1_800_000)).toBe(1_350_000);
		expect(resolveReviewerSoftRuntimeMs("task", 1_800_000)).toBe(0);
		expect(resolveReviewerSoftRuntimeMs("reviewer", 0)).toBe(0);
		expect(resolveReviewerSoftRuntimeMs("reviewer", 1)).toBe(0);
	});

	it("treats both path and file_path as explicit raw/range selectors", () => {
		expect(shouldPreserveExplicitReadRange("src/x.ts:raw")).toBe(true);
		expect(shouldPreserveExplicitReadRange("src/x.ts:10-20")).toBe(true);
		expect(shouldPreserveExplicitReadRange("src/x.ts")).toBe(false);
		expect(shouldPreserveExplicitReadRange(readPathFromToolArgs({ file_path: "src/x.ts:raw" }))).toBe(true);
		expect(shouldPreserveExplicitReadRange(readPathFromToolArgs({ path: "src/x.ts" }))).toBe(false);
	});
});
