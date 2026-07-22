import type { PlanArtifactV1, ReviewArtifactV1, VerificationArtifactV1 } from "./types";

export class ContextBuilder {
	buildPlanContext(plan: PlanArtifactV1, verification: VerificationArtifactV1 | null = null) {
		return {
			plan,
			verification,
			verificationCommands: plan.verificationCommands,
			forbiddenPaths: ["node_modules", "dist", "build", ".git"],
		};
	}

	buildReviewContext(review: ReviewArtifactV1, plan: PlanArtifactV1) {
		return {
			plan,
			reviewFindings: review.findings,
			independentReview: true, // enforce
		};
	}

	// more builders for other stages
}
