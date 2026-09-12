/**
 * EvalGateParityReceiptV1 — design A §4.5.
 * Migration requires proven bridge↔native parity; failed/unknown keeps bridge control.
 */

export const EVAL_GATE_PARITY_RECEIPT_KIND = "eval_gate_parity_receipt" as const;
export const EVAL_GATE_PARITY_RECEIPT_VERSION = 1 as const;

export type EvalParityStatus = "proven" | "failed" | "unknown";
export type EvalParityTargetOwner = "workflow" | "task";

export interface EvalGateParityReceiptV1 {
	schemaVersion: typeof EVAL_GATE_PARITY_RECEIPT_VERSION;
	kind: typeof EVAL_GATE_PARITY_RECEIPT_KIND;
	sourceBridge: string;
	sourceRequestSha256: string;
	sourceDecisionContract: string;
	sourceInlineIsolationContract: string;
	targetOwner: EvalParityTargetOwner;
	targetArtifactRef?: string;
	targetArtifactSha256?: string;
	targetDecision?: string;
	targetIdentityReceiptRef?: string;
	targetContextReceiptRef?: string;
	cancelResumeReceiptRef?: string;
	parity: EvalParityStatus;
	notes?: string[];
	createdAt: string;
}

export function buildEvalGateParityReceipt(
	input: Omit<EvalGateParityReceiptV1, "schemaVersion" | "kind" | "createdAt"> & {
		createdAt?: string;
	},
): EvalGateParityReceiptV1 {
	return {
		schemaVersion: EVAL_GATE_PARITY_RECEIPT_VERSION,
		kind: EVAL_GATE_PARITY_RECEIPT_KIND,
		sourceBridge: input.sourceBridge,
		sourceRequestSha256: input.sourceRequestSha256,
		sourceDecisionContract: input.sourceDecisionContract,
		sourceInlineIsolationContract: input.sourceInlineIsolationContract,
		targetOwner: input.targetOwner,
		targetArtifactRef: input.targetArtifactRef,
		targetArtifactSha256: input.targetArtifactSha256,
		targetDecision: input.targetDecision,
		targetIdentityReceiptRef: input.targetIdentityReceiptRef,
		targetContextReceiptRef: input.targetContextReceiptRef,
		cancelResumeReceiptRef: input.cancelResumeReceiptRef,
		parity: input.parity,
		notes: input.notes,
		createdAt: input.createdAt ?? new Date().toISOString(),
	};
}

/** Only proven parity may enable native migration treatment. */
export function mayMigrateEvalGate(receipt: EvalGateParityReceiptV1 | null | undefined, armEnabled: boolean): boolean {
	return armEnabled === true && receipt?.parity === "proven";
}

export type EvalGateControl = "bridge-control" | "native-control";

/**
 * Return the execution owner allowed by the migration arm and parity receipt.
 * Unknown or failed parity always retains bridge control; this helper never
 * starts, retries, or migrates an eval backend by itself.
 */
export function recordOrRequireEvalParity(
	receipt: EvalGateParityReceiptV1 | null | undefined,
	armEnabled: boolean,
): EvalGateControl {
	return mayMigrateEvalGate(receipt, armEnabled) ? "native-control" : "bridge-control";
}

/**
 * Overlap is allowed only when parent has independent ready work
 * with disjoint ownership/dependency from the eval gate.
 */
export function mayOverlapEvalWithParent(input: {
	parityProven: boolean;
	parentHasIndependentReadyWork: boolean;
	ownershipDisjoint: boolean;
}): boolean {
	return input.parityProven && input.parentHasIndependentReadyWork && input.ownershipDisjoint;
}
