import { beforeEach, describe, expect, it } from "bun:test";
import { PlanReviewStage } from "../../../src/workflow/stages/plan-review";

describe("PlanReviewStage", () => {
	let stage: PlanReviewStage;

	beforeEach(() => {
		stage = new PlanReviewStage();
	});

	it("executes plan review stage with artifact", async () => {
		const artifact = { workflowId: "wf1", attemptId: "att1", stage: "plan_review" };
		const result = await stage.execute(artifact);
		expect(result.kind).toBe("review");
		expect(result.subject).toBe("plan");
	});
});
