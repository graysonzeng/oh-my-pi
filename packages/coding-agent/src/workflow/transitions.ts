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

export function isValidTransition(from: WorkflowStatus, to: WorkflowStatus): boolean {
	return VALID_TRANSITIONS[from]?.includes(to) || false;
}

export function getNextStage(
	current: WorkflowStatus,
	decision: "approved" | "changes_requested" | "blocked" | null,
): WorkflowStatus | null {
	switch (current) {
		case "planning":
			return decision === "approved" ? "plan_review" : "blocked";
		case "plan_review":
			return decision === "approved" ? "implementing" : "planning";
		case "implementing":
			return "implementation_verify";
		case "implementation_verify":
			return "code_review";
		case "code_review":
			return "final_verify";
		case "repairing":
			return "implementation_verify";
		case "final_verify":
			return "completed";
		default:
			return null;
	}
}
