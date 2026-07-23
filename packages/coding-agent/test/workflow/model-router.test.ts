import { describe, expect, it } from "bun:test";
import { DEFAULT_MODEL_PROFILES } from "../../src/workflow/default-config";
import { FindingTracker } from "../../src/workflow/finding-tracker";
import { ModelRouter } from "../../src/workflow/model-router";
import type { ReviewFindingV1 } from "../../src/workflow/types";

describe("ModelRouter", () => {
	const router = new ModelRouter(Object.values(DEFAULT_MODEL_PROFILES));

	it("resolves role to profile with audit metadata", () => {
		const decision = router.resolve("planner");
		expect(decision.profile.roles).toContain("planner");
		expect(decision.profileId).toBeTruthy();
		expect(decision.vendor).toBeTruthy();
		expect(decision.reason).toContain("role");
		expect(decision.degraded).toBe(false);
	});

	it("falls back when preferred profile is unavailable", () => {
		const primary = router.resolve("planner");
		const decision = router.resolve("planner", { unavailableProfileIds: [primary.profileId] });
		expect(decision.profileId).not.toBe(primary.profileId);
		expect(decision.reason).toMatch(/fallback/);
	});

	it("selects a distinct plan-review profile and prefers another vendor", () => {
		const decision = router.resolve("plan_reviewer", {
			excludedProfileIds: ["claude_plan_reviewer"],
			avoidVendor: "anthropic",
		});
		expect(decision.profileId).toBe("gpt_plan_reviewer");
		expect(decision.vendor).toBe("openai");
	});

	it("rejects same-vendor code review unless degraded", () => {
		expect(() =>
			router.resolve("code_reviewer", {
				implementerVendor: "anthropic",
				// force only anthropic reviewers by marking openai unavailable
				unavailableProfileIds: ["gpt_reviewer"],
				degradedMode: false,
			}),
		).toThrow("independent_reviewer_unavailable");

		const degraded = router.resolve("code_reviewer", {
			implementerVendor: "anthropic",
			unavailableProfileIds: ["gpt_reviewer"],
			degradedMode: true,
		});
		expect(degraded.degraded).toBe(true);
		expect(degraded.reason).toBe("degraded_same_vendor_review");
	});

	it("routes complex and repeated findings to reasoning repair", () => {
		const finding: ReviewFindingV1 = {
			id: "f1",
			priority: "P0",
			category: "security",
			status: "open",
			confidence: 0.9,
			summary: "auth bypass",
			explanation: "critical",
			suggestedOwner: "reasoning_repair",
		};
		const tracker = new FindingTracker();
		tracker.add(finding);
		const decision = router.resolve("repair", { finding, findingTracker: tracker });
		expect(["anthropic", "openai"]).toContain(decision.vendor);
		expect(decision.reason).toMatch(/complex|role|repeated/);
	});

	it("escalates repeated findings via tracker + router", () => {
		const finding: ReviewFindingV1 = {
			id: "f2",
			priority: "P2",
			category: "correctness",
			status: "open",
			confidence: 0.8,
			summary: "off by one",
			explanation: "loop",
			suggestedOwner: "implementer",
		};
		const tracker = new FindingTracker();
		const tracked = tracker.add(finding);
		tracker.recordRepairCycle(tracked.fingerprint);
		tracker.recordRepairCycle(tracked.fingerprint);
		expect(tracker.hasRepeated(tracked.fingerprint)).toBe(true);
		const decision = router.resolve("repair", {
			finding,
			findingTracker: tracker,
			preferReasoningRepair: tracker.needsReasoningRepair(finding),
		});
		expect(["anthropic", "openai"]).toContain(decision.vendor);
	});
});
