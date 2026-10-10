import type { WorkflowStatus } from "./types";

export const VALID_TRANSITIONS: Record<WorkflowStatus, WorkflowStatus[]> = {
	created: ["planning", "blocked", "failed", "cancelled"],
	planning: ["plan_review", "blocked", "failed", "cancelled"],
	plan_review: ["implementing", "planning", "blocked", "failed", "cancelled"],
	implementing: ["implementation_verify", "blocked", "failed", "cancelled"],
	implementation_verify: ["code_review", "repairing", "blocked", "failed", "cancelled"],
	code_review: ["final_verify", "repairing", "blocked", "failed", "cancelled"],
	repairing: ["implementation_verify", "blocked", "failed", "cancelled"],
	final_verify: ["completed", "repairing", "blocked", "failed", "cancelled"],
	completed: [],
	blocked: [],
	cancelled: [],
	failed: [],
};

/** Decision inputs that map a stage outcome to the next legal status. */
export type TransitionDecision = "approved" | "changes_requested" | "blocked" | "passed" | "failed" | null;

export function isValidTransition(from: WorkflowStatus, to: WorkflowStatus): boolean {
	return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Pure policy: map stage + decision → next status.
 * Models never choose the next stage; the engine validates this result against VALID_TRANSITIONS.
 */
export function getNextStage(current: WorkflowStatus, decision: TransitionDecision): WorkflowStatus | null {
	switch (current) {
		case "created":
			return "planning";
		case "planning":
			if (decision === "blocked") return "blocked";
			if (decision === "failed") return "failed";
			// Successful plan artifact advances to review
			return "plan_review";
		case "plan_review":
			if (decision === "approved") return "implementing";
			if (decision === "changes_requested") return "planning";
			if (decision === "blocked") return "blocked";
			if (decision === "failed") return "failed";
			return null;
		case "implementing":
			if (decision === "blocked") return "blocked";
			if (decision === "failed") return "failed";
			return "implementation_verify";
		case "implementation_verify":
			if (decision === "passed" || decision === "approved") return "code_review";
			if (decision === "failed" || decision === "changes_requested") return "repairing";
			if (decision === "blocked") return "blocked";
			return null;
		case "code_review":
			if (decision === "approved") return "final_verify";
			if (decision === "changes_requested") return "repairing";
			if (decision === "blocked") return "blocked";
			if (decision === "failed") return "failed";
			return null;
		case "repairing":
			if (decision === "blocked") return "blocked";
			if (decision === "failed") return "failed";
			return "implementation_verify";
		case "final_verify":
			if (decision === "passed" || decision === "approved") return "completed";
			if (decision === "failed" || decision === "changes_requested") return "repairing";
			if (decision === "blocked") return "blocked";
			return null;
		default:
			return null;
	}
}

export function assertValidTransition(from: WorkflowStatus, to: WorkflowStatus): void {
	if (!isValidTransition(from, to)) {
		throw new Error(`invalid_transition:${from}->${to}`);
	}
}
