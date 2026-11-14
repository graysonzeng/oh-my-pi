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
	| "mechanical_implement"
	| "format_check"
	| "none";

export type MechanicalEvidenceSource = "caller_declaration" | "deterministic_rule" | "accepted_finding";

export type MechanicalTargetRole = "evidence" | "repair" | "implementer" | "code_review_experiment";

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

const MECHANICAL_CLASS_KINDS: Record<MechanicalClassKind, true> = {
	deterministic_evidence: true,
	mechanical_repair: true,
	mechanical_implement: true,
	format_check: true,
	none: true,
};
const MECHANICAL_EVIDENCE_SOURCES: Record<MechanicalEvidenceSource, true> = {
	caller_declaration: true,
	deterministic_rule: true,
	accepted_finding: true,
};
const MECHANICAL_TARGET_ROLES: Record<MechanicalTargetRole, true> = {
	evidence: true,
	repair: true,
	implementer: true,
	code_review_experiment: true,
};
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

/**
 * Strict runtime parse for policy/object evidence. Malformed or incomplete
 * mechanical classes fail closed to the strong route (return null).
 */
export function parseWorkflowMechanicalClass(value: unknown): WorkflowMechanicalClassV1 | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;
	if (raw.schemaVersion !== WORKFLOW_MECHANICAL_CLASS_VERSION) return null;
	if (typeof raw.class !== "string" || !(raw.class in MECHANICAL_CLASS_KINDS)) {
		return null;
	}
	if (typeof raw.targetRole !== "string" || !(raw.targetRole in MECHANICAL_TARGET_ROLES)) {
		return null;
	}
	if (raw.requestedModelClass !== "flash" && raw.requestedModelClass !== "existing") return null;
	if (!raw.evidence || typeof raw.evidence !== "object") return null;
	const evidence = raw.evidence as Record<string, unknown>;
	if (typeof evidence.source !== "string" || !(evidence.source in MECHANICAL_EVIDENCE_SOURCES)) {
		return null;
	}
	const ref = evidence.ref;
	if (ref !== undefined && (typeof ref !== "string" || ref.trim().length === 0)) return null;
	// Deterministic/accepted-finding evidence requires a concrete ref; caller
	// declaration may omit one when the declaration itself is the proof.
	if (
		(evidence.source === "deterministic_rule" || evidence.source === "accepted_finding") &&
		(typeof ref !== "string" || ref.trim().length === 0)
	) {
		return null;
	}
	return {
		schemaVersion: WORKFLOW_MECHANICAL_CLASS_VERSION,
		class: raw.class as MechanicalClassKind,
		evidence: {
			source: evidence.source as MechanicalEvidenceSource,
			...(typeof ref === "string" ? { ref: ref.trim() } : {}),
		},
		targetRole: raw.targetRole as MechanicalTargetRole,
		requestedModelClass: raw.requestedModelClass,
	};
}

/** Ineligible / unknown → strong model conservative path. */
export function isMechanicalFlashEligible(
	cls: WorkflowMechanicalClassV1 | null | undefined,
	armEnabled: boolean,
): boolean {
	if (!armEnabled || !cls) return false;
	// Re-validate even for typed callers so malformed casts cannot route Flash.
	const parsed = parseWorkflowMechanicalClass(cls);
	if (!parsed) return false;
	if (parsed.class === "none") return false;
	if (parsed.requestedModelClass !== "flash") return false;
	// Plan review / arbitration / architecture never eligible.
	if (parsed.targetRole === "code_review_experiment") {
		// only when explicitly declared experiment
		return parsed.evidence.source === "caller_declaration";
	}
	return true;
}

/** Minimal plan shape for deterministic implementer routing. Avoids a workflow import cycle. */
export interface MechanicalImplementerPlanScope {
	affectedFiles?: readonly unknown[] | null;
	implementationSteps?: readonly unknown[] | null;
	workPackages?: readonly unknown[] | null;
}

export const MECHANICAL_IMPLEMENT_RULE_REF = "plan_scope:single_file_single_step";
export const VERY_COMPLEX_IMPLEMENT_FILE_THRESHOLD = 4;
export const VERY_COMPLEX_IMPLEMENT_STEP_THRESHOLD = 4;

export type ImplementerComplexityClass = "mechanical" | "complex" | "very_complex";

/**
 * Fail closed to Grok 4.6: unknown/empty scope is relatively complex, not Flash.
 * Single-file, single-step, at most one work package → mechanical Flash.
 * ≥4 files or ≥4 steps → very complex (Astra, fallback Grok 4.6).
 */
export function classifyImplementerComplexity(
	plan: MechanicalImplementerPlanScope | null | undefined,
): ImplementerComplexityClass {
	if (!plan) return "complex";
	const files = plan.affectedFiles?.length ?? 0;
	const steps = plan.implementationSteps?.length ?? 0;
	const packages = plan.workPackages?.length ?? 0;
	if (files === 0 && steps === 0) return "complex";
	if (files <= 1 && steps <= 1 && packages <= 1) return "mechanical";
	if (files >= VERY_COMPLEX_IMPLEMENT_FILE_THRESHOLD || steps >= VERY_COMPLEX_IMPLEMENT_STEP_THRESHOLD) {
		return "very_complex";
	}
	return "complex";
}

export function classifyPlanMechanicalImplementer(
	plan: MechanicalImplementerPlanScope | null | undefined,
): WorkflowMechanicalClassV1 | null {
	if (classifyImplementerComplexity(plan) !== "mechanical") return null;
	return buildMechanicalClass({
		class: "mechanical_implement",
		source: "deterministic_rule",
		ref: MECHANICAL_IMPLEMENT_RULE_REF,
		targetRole: "implementer",
	});
}

export function isVeryComplexImplementerPlan(plan: MechanicalImplementerPlanScope | null | undefined): boolean {
	return classifyImplementerComplexity(plan) === "very_complex";
}
