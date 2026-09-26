/**
 * Pure gate-retry predicates (R3).
 * Gate retry may only absorb recoverable parse/schema failures — never budget,
 * identity, policy, configuration, or cancel.
 */
import {
	BudgetExhaustedError,
	WorkflowCancelledError,
	WorkflowError,
	WorkflowIdentityError,
	WorkflowPolicyError,
} from "./errors";

/** Errors that must abort the gate path without a second full gate run. */
export function isNonRetryableGateError(error: unknown): boolean {
	if (error instanceof WorkflowCancelledError) return true;
	if (error instanceof BudgetExhaustedError) return true;
	if (error instanceof WorkflowIdentityError) return true;
	if (error instanceof WorkflowPolicyError) return true;
	if (error instanceof WorkflowError) {
		return (
			error.kind === "budget_exhausted" ||
			error.kind === "identity_mismatch" ||
			error.kind === "policy_violation" ||
			error.kind === "configuration" ||
			error.kind === "cancelled"
		);
	}
	return false;
}

/** Recoverable parse/schema-ish failures may retry once; everything else is either fatal or non-retryable. */
export function isGateParseRetryCandidate(error: unknown): boolean {
	if (isNonRetryableGateError(error)) return false;
	if (error instanceof WorkflowError && error.kind === "schema_violation") return true;
	// Plain Error / unknown parse failures stay retryable (legacy gate parse path).
	return true;
}
