import { beforeEach, describe, expect, it } from "bun:test";
import { CodeReviewStage } from "../../../src/workflow/stages/code-review";

describe("CodeReviewStage", () => {
	let stage: CodeReviewStage;

	beforeEach(() => {
		stage = new CodeReviewStage();
	});

	it("executes code review stage with artifact", async () => {
		const artifact = { workflowId: "wf1", attemptId: "att1", stage: "code_review" };
		const result = await stage.execute(artifact);
		expect(result.kind).toBe("review");
		expect(result.subject).toBe("implementation");
	});
});
