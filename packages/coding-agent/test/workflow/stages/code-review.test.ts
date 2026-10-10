import { describe, expect, it } from "bun:test";
import { DEFAULT_MODEL_PROFILES } from "../../../src/workflow/default-config";
import { RuntimeAdapter } from "../../../src/workflow/runtime-adapter";
import { CodeReviewStage } from "../../../src/workflow/stages/code-review";
import { fakeSession, reviewArtifact, scriptedRunner } from "../helpers";

describe("CodeReviewStage", () => {
	it("surfaces findings from runtime without hardcoded approve", async () => {
		const stage = new CodeReviewStage(
			new RuntimeAdapter(
				scriptedRunner({
					codeReview: reviewArtifact("changes_requested", "implementation", [
						{
							id: "f1",
							priority: "P0",
							category: "security",
							status: "open",
							confidence: 0.99,
							summary: "xss",
							explanation: "escape",
							suggestedOwner: "reasoning_repair",
						},
					]),
				}),
			),
		);
		const { artifact: review } = await stage.execute({
			workflowId: "wf1",
			attemptId: "a1",
			profile: DEFAULT_MODEL_PROFILES.claude_reviewer,
			assignment: "review code",
			context: "ctx",
			session: fakeSession(),
		});
		expect(review.decision).toBe("changes_requested");
		expect(review.findings[0]?.id).toBe("f1");
	});
});
