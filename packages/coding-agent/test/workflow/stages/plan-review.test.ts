import { describe, expect, it } from "bun:test";
import { DEFAULT_MODEL_PROFILES } from "../../../src/workflow/default-config";
import { RuntimeAdapter } from "../../../src/workflow/runtime-adapter";
import { PlanReviewStage } from "../../../src/workflow/stages/plan-review";
import { fakeSession, reviewArtifact, scriptedRunner } from "../helpers";

describe("PlanReviewStage", () => {
	it("does not hardcode approval — uses runtime artifact", async () => {
		const stage = new PlanReviewStage(
			new RuntimeAdapter(scriptedRunner({ planReview: reviewArtifact("changes_requested", "plan") })),
		);
		const { artifact: review } = await stage.execute({
			workflowId: "wf1",
			attemptId: "a1",
			profile: DEFAULT_MODEL_PROFILES.claude_plan_reviewer,
			assignment: "review",
			context: "ctx",
			session: fakeSession(),
		});
		expect(review.decision).toBe("changes_requested");
		expect(review.subject).toBe("plan");
	});
});
