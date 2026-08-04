/**
 * WorkflowMechanicalClassV1 — design A §4.2.
 * Caller-declared / deterministic / previously-accepted-finding classification only.
 * Must never use current in-progress review findings to pick the current reviewer.
 * Target model class for eligible work: Flash.
 */

export const WORKFLOW_MECHANICAL_CLASS_VERSION = 1 as const;

export type MechanicalClassKind =
	| "deterministic_evidence"
	| "mechanical_repair"
	| "format_check"
	| "none";

export type MechanicalEvidenceSource =
	| "caller_declaration"
	| "deterministic_rule"
	| "accepted_finding";

export type MechanicalTargetRole = "evidence" | "repair" | "code_review_experiment";

export interface WorkflowMechanicalClassV1 {
	schemaVersion: typeof WORKFLOW_MECHANICAL_CLASS_VERSION;
	class: MechanicalClassKind;
	evidence: {
		source: MechanicalEvidenceSource;
		/** Deterministic rule id or accepted finding id when applicable. */
		ref?: string;
	};
	targetRole: MechanicalTargetRole;
	/** Flash when eligible; otherwise existing strong route. */
	requestedModelClass: "flash" | "existing";
}

export const ROLE_STATIC_SPLIT_ARM = "role_static_split" as const;
export const MECHANICAL_TARGET_MODEL_HINT = "flash" as const;

export function buildMechanicalClass(input: {
	class: MechanicalClassKind;
	source: MechanicalEvidenceSource;
	ref?: string;
	targetRole: MechanicalTargetRole;
}): WorkflowMechanicalClassV1 {
	const eligible = input.class !== "none";
	return {
		schemaVersion: WORKFLOW_MECHANICAL_CLASS_VERSION,
		class: input.class,
		evidence: { source: input.source, ref: input.ref },
		targetRole: input.targetRole,
		requestedModelClass: eligible ? "flash" : "existing",
	};
}

/** Ineligible / unknown → strong model conservative path. */
export function isMechanicalFlashEligible(
	cls: WorkflowMechanicalClassV1 | null | undefined,
	armEnabled: boolean,
): boolean {
	if (!armEnabled || !cls) return false;
	if (cls.class === "none") return false;
	if (cls.requestedModelClass !== "flash") return false;
	// Plan review / arbitration / architecture never eligible.
	if (cls.targetRole === "code_review_experiment") {
		// only when explicitly declared experiment
		return cls.evidence.source === "caller_declaration";
	}
	return true;
}
