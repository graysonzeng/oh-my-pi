/**
 * Pure gate-retry predicates (R3/C4).
 * Recoverable output/schema defects may retry once. Identity, stale ids, budget,
 * auth, timeout, and plain Error keep their original kind.
 */
import {
	BudgetExhaustedError,
	WorkflowCancelledError,
	WorkflowError,
	WorkflowIdentityError,
	WorkflowPolicyError,
} from "./errors";
import { GateParseError } from "./schemas";

export type GateRetryDisposition = "retry_parse" | "abort_original";

/** Errors that must abort the gate path without a second full gate run. */
export function isNonRetryableGateError(error: unknown): boolean {
	if (error instanceof WorkflowCancelledError) return true;
	if (error instanceof BudgetExhaustedError) return true;
	if (error instanceof WorkflowIdentityError) return true;
	if (error instanceof WorkflowPolicyError) return true;
	if (error instanceof GateParseError) {
		return (
			error.code === "identity_mismatch" ||
			error.code === "stale_workflow_id" ||
			error.code === "stale_attempt_id" ||
			error.code === "missing_requirements_snapshot"
		);
	}
	if (error instanceof WorkflowError) {
		return (
			error.kind === "budget_exhausted" ||
			error.kind === "identity_mismatch" ||
			error.kind === "policy_violation" ||
			error.kind === "configuration" ||
			error.kind === "cancelled" ||
			error.kind === "authentication" ||
			error.kind === "quota" ||
			error.kind === "timeout" ||
			error.kind === "merge_conflict"
		);
	}
	return false;
}

/**
 * Parse/schema retry fuel. GateParseError retries unless isNonRetryableGateError
 * already rejected it (identity, stale id, missing snapshot). Plain Error does not.
 */
export function isGateParseRetryCandidate(error: unknown): boolean {
	if (isNonRetryableGateError(error)) return false;
	if (error instanceof GateParseError) return true;
	if (error instanceof WorkflowError && error.kind === "schema_violation") return true;
	if (error instanceof SyntaxError) return true;
	return error instanceof Error && error.name === "ZodError";
}

/**
 * Engine gate loop must use this, not a catch-all.
 * `abort_original` means rethrow; do not relabel as gate_parse_failed.
 */
export function classifyGateError(error: unknown): GateRetryDisposition {
	return isGateParseRetryCandidate(error) ? "retry_parse" : "abort_original";
}
