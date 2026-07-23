import type { WorkflowErrorKind } from "./types";

export class WorkflowError extends Error {
	readonly kind: WorkflowErrorKind;
	readonly details?: unknown;

	constructor(message: string, kind: WorkflowErrorKind, details?: unknown) {
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
	constructor(attempt: number, budgetUsed: number | "unknown", limit: number) {
		super(`Budget exhausted after ${attempt} attempts. Used ${budgetUsed} of ${limit}`, "budget_exhausted", {
			attempt,
			budgetUsed,
			limit,
		});
	}
}

export class WorkflowSchemaError extends WorkflowError {
	constructor(message: string, details?: unknown) {
		super(message, "schema_violation", details);
	}
}

export class WorkflowCancelledError extends WorkflowError {
	constructor(message = "Workflow cancelled", details?: unknown) {
		super(message, "cancelled", details);
	}
}

export class WorkflowTimeoutError extends WorkflowError {
	constructor(message = "Workflow stage timed out", details?: unknown) {
		super(message, "timeout", details);
	}
}

export class ArtifactIntegrityError extends WorkflowError {
	constructor(message: string, details?: unknown) {
		super(message, "internal", details);
	}
}
