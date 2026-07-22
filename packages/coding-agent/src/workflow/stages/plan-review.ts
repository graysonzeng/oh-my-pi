import type { ReviewArtifactV1 } from "../types";

export class PlanReviewStage {
	async execute(artifact: Pick<ReviewArtifactV1, "workflowId" | "attemptId">): Promise<ReviewArtifactV1> {
		const review: ReviewArtifactV1 = {
			kind: "review",
			subject: "plan",
			decision: "approved",
			findings: [],
			explanation: "Plan approved",
			confidence: 0.95,
			schemaVersion: 1,
			workflowId: artifact.workflowId,
			attemptId: artifact.attemptId,
			stage: "plan_review",
			createdAt: new Date().toISOString(),
			modelProfileId: "claude_reviewer",
			provider: "anthropic",
			model: "claude-3-5-sonnet",
			promptVersion: "1.0",
		};
		return review;
	}
}
