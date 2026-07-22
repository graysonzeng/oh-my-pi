export class WorkflowError extends Error {
	kind: string;
	details?: unknown;
	constructor(message: string, kind: string, details?: unknown) {
		super(message);
		this.kind = kind;
		this.details = details;
		this.name = "WorkflowError";
	}
}

export class WorkflowPolicyError extends WorkflowError {
	constructor(reason: string, details?: unknown) {
		super(`Policy violation: ${reason}`, "policy_violation", details);
	}
}

export class BudgetExhaustedError extends WorkflowError {
	constructor(attempt: number, budgetUsed: number, limit: number) {
		super(`Budget exhausted after ${attempt} attempts. Used ${budgetUsed} of ${limit}`, "budget_exhausted");
	}
}
