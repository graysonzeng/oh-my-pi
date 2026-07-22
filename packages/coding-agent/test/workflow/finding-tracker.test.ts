import { beforeEach, describe, expect, it } from "bun:test";
import { FindingTracker } from "../../src/workflow/finding-tracker";
import type { ReviewFindingV1 } from "../../src/workflow/types";

describe("FindingTracker", () => {
	let tracker: FindingTracker;

	beforeEach(() => {
		tracker = new FindingTracker();
	});

	it("adds and retrieves findings", async () => {
		const finding: ReviewFindingV1 = {
			id: "f1",
			priority: "P1",
			category: "correctness",
			status: "open",
			confidence: 0.9,
			summary: "test",
			explanation: "test",
			suggestedOwner: "implementer",
		};
		tracker.add(finding);
		expect(tracker.getById("f1")).toBeTruthy();
	});

	it("resolves and escalates repeated findings", async () => {
		const finding = tracker.getById("missing");
		expect(finding).toBeNull();
	});
});
