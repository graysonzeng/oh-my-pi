export const SHADOW_REVIEW_JOB_LABEL = "shadow-review";

export const SHADOW_DIMENSION_IDS = [
	"architecture-review",
	"grounded-review",
	"correctness-review",
	"completion-review",
] as const;

export type ShadowDimensionId = (typeof SHADOW_DIMENSION_IDS)[number];

export type ShadowReviewMode = "code" | "off";

export type ShadowDimensionStatus = "reported" | "completed_no_finding" | "timeout" | "error" | "aborted";

export interface ShadowDimensionResult {
	id: ShadowDimensionId;
	status: ShadowDimensionStatus;
	content?: string;
	error?: string;
	durationMs: number;
}

export interface ShadowReviewDetails {
	dimensions: ShadowDimensionResult[];
}

export const SHADOW_PER_CHILD_TIMEOUT_SECONDS = 90;
export const SHADOW_COHORT_DRAIN_TIMEOUT_SECONDS = 120;
