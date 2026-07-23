import { beforeEach, describe, expect, it } from "bun:test";
import { FindingTracker } from "../../src/workflow/finding-tracker";
import type { ReviewFindingV1 } from "../../src/workflow/types";

function finding(partial: Partial<ReviewFindingV1> & { id: string; summary: string }): ReviewFindingV1 {
	return {
		priority: "P1",
		category: "correctness",
		status: "open",
		confidence: 0.9,
		explanation: "detail",
		suggestedOwner: "implementer",
		...partial,
	};
}

describe("FindingTracker", () => {
	let tracker: FindingTracker;

	beforeEach(() => {
		tracker = new FindingTracker();
	});

	it("generates stable fingerprints", () => {
		const a = finding({ id: "1", summary: "Off by one", file: "a.ts", line: 10 });
		const b = finding({ id: "2", summary: "  off   by one ", file: "A.ts", line: 10 });
		expect(FindingTracker.fingerprint(a)).toBe(FindingTracker.fingerprint(b));
	});

	it("first repair, reasoning escalation, third-cycle block", () => {
		const f = tracker.add(finding({ id: "f1", summary: "bug" }));
		expect(tracker.recordRepairCycle(f.fingerprint)).toBe("first_repair");
		expect(tracker.hasRepeated(f.fingerprint)).toBe(false);
		expect(tracker.recordRepairCycle(f.fingerprint)).toBe("reasoning");
		expect(tracker.hasRepeated(f.fingerprint)).toBe(true);
		expect(tracker.recordRepairCycle(f.fingerprint)).toBe("block");
		expect(tracker.shouldBlock()).toBe(true);
	});

	it("resolves findings", () => {
		tracker.add(finding({ id: "f1", summary: "bug" }));
		tracker.resolve("f1", "resolved");
		expect(tracker.getById("f1")?.status).toBe("resolved");
		expect(tracker.getOpen().length).toBe(0);
	});
});
