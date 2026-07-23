import type { WorkflowErrorKind } from "./types";

/** Terminal / control-flow outcome after classifying a workflow error. */
export type WorkflowErrorOutcome = "retry_or_fallback" | "blocked" | "cancelled" | "failed";

const RETRYABLE_KINDS: ReadonlySet<WorkflowErrorKind> = new Set([
	"timeout",
	"rate_limit",
	"schema_violation",
	"provider_transient",
	"quota",
	"authentication",
]);

const BLOCKED_KINDS: ReadonlySet<WorkflowErrorKind> = new Set([
	"policy_violation",
	"budget_exhausted",
	"configuration",
	"merge_conflict",
]);

/**
 * Map a classified error kind to engine outcome.
 * Authentication is retryable so explicit profile fallbacks can run before blocking.
 */
export function mapWorkflowErrorOutcome(kind: WorkflowErrorKind): WorkflowErrorOutcome {
	if (kind === "cancelled") return "cancelled";
	if (RETRYABLE_KINDS.has(kind)) return "retry_or_fallback";
	if (BLOCKED_KINDS.has(kind)) return "blocked";
	return "failed";
}

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
