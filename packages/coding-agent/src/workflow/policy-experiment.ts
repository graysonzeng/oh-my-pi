import { stableStringify } from "../model-policy/receipt";
import type { ModelPolicyFeatureGates } from "../model-policy/types";
import { sha256Hex } from "./optimization-receipt";

export const POLICY_EXPERIMENT_RECEIPT_KIND = "policy_experiment_receipt" as const;
export const POLICY_EXPERIMENT_RECEIPT_VERSION = 1 as const;

export type PolicyLever =
	| "tool_concurrency_ceiling"
	| "descriptor_placement"
	| "cache_friendly_assembly"
	| "prompt_overlay"
	| "tool_catalog";

export type PolicyEvidenceMode = "none" | "fake" | "live_unpaired" | "live_paired";
export type PolicyLeverDecision = "shadow" | "eligible" | "active" | "rejected";

export interface PolicyExperimentEvidenceBaseV1 {
	mode: PolicyEvidenceMode;
	repetitions: number;
	caseCount: number;
	qualityGatePassed: boolean;
	hardGateFailures: string[];
}

export interface HeldOutDatasetEvidenceV1 {
	datasetVersion: string;
	datasetFingerprint: string;
	caseCount: number;
	passed: boolean;
}

export interface ProviderCacheEvidenceV1 {
	provider: string;
	model: string;
	api: string;
	modelFactsFingerprint: string;
	requestCount: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}

export interface PromptOverlayCaseEvidenceV1 {
	caseId: string;
	failureClass: string;
	independenceKey: string;
	real: boolean;
	reproducible: boolean;
}

export type PolicyExperimentEvidenceV1 = PolicyExperimentEvidenceBaseV1 &
	(
		| { kind: "paired" }
		| { kind: "cache_friendly_assembly"; cache: ProviderCacheEvidenceV1 }
		| {
				kind: "prompt_overlay";
				failureClass: string;
				cases: PromptOverlayCaseEvidenceV1[];
				heldOut: HeldOutDatasetEvidenceV1;
		  }
		| {
				kind: "tool_catalog";
				toolSelectionHeldOut: HeldOutDatasetEvidenceV1;
				taskSuccessHeldOut: HeldOutDatasetEvidenceV1;
		  }
	);

export interface PolicyLeverEvaluationInput {
	experimentId: string;
	lever: PolicyLever;
	/** Deterministic compiler/policy fingerprints, not benchmark result ids. */
	baselineFingerprint: string;
	candidateFingerprint: string;
	/** The one policy lever declared changed by the paired run. */
	changedLevers: PolicyLever[];
	/** Combination runs are diagnostic only and can never authorize production. */
	combinationRun?: boolean;
	datasetVersion: string;
	evidence: PolicyExperimentEvidenceV1;
	rolloutApproved: boolean;
}

export interface PolicyExperimentReceiptV1 {
	schemaVersion: typeof POLICY_EXPERIMENT_RECEIPT_VERSION;
	kind: typeof POLICY_EXPERIMENT_RECEIPT_KIND;
	experimentId: string;
	lever: PolicyLever;
	baselineFingerprint: string;
	candidateFingerprint: string;
	changedLevers: PolicyLever[];
	combinationRun: boolean;
	datasetVersion: string;
	policyFingerprint: string;
	decision: PolicyLeverDecision;
	applied: boolean;
	evidence: PolicyExperimentEvidenceV1;
	rolloutApproved: boolean;
	reasons: string[];
}

interface PolicyDecision {
	decision: PolicyLeverDecision;
	applied: boolean;
	reasons: string[];
}

const PRODUCTION_LEVERS: Partial<Record<PolicyLever, true>> = {
	tool_concurrency_ceiling: true,
	descriptor_placement: true,
};
const POLICY_LEVERS: Record<PolicyLever, true> = {
	tool_concurrency_ceiling: true,
	descriptor_placement: true,
	cache_friendly_assembly: true,
	prompt_overlay: true,
	tool_catalog: true,
};
const EVIDENCE_MODES: Record<PolicyEvidenceMode, true> = {
	none: true,
	fake: true,
	live_unpaired: true,
	live_paired: true,
};
const DECISIONS: Record<PolicyLeverDecision, true> = {
	shadow: true,
	eligible: true,
	active: true,
	rejected: true,
};

function nonblank(value: string): boolean {
	return value.trim().length > 0;
}

function validCount(value: number, minimum = 0): boolean {
	return Number.isInteger(value) && value >= minimum;
}

function heldOutReasons(evidence: HeldOutDatasetEvidenceV1, prefix: string): string[] {
	const reasons: string[] = [];
	if (
		!nonblank(evidence.datasetVersion) ||
		!nonblank(evidence.datasetFingerprint) ||
		!validCount(evidence.caseCount, 1)
	) {
		reasons.push(`${prefix}_held_out_dataset_required`);
	}
	if (evidence.passed !== true) reasons.push(`${prefix}_held_out_pass_required`);
	return reasons;
}

function expectedEvidenceKind(lever: PolicyLever): PolicyExperimentEvidenceV1["kind"] {
	if (lever === "cache_friendly_assembly") return "cache_friendly_assembly";
	if (lever === "prompt_overlay") return "prompt_overlay";
	if (lever === "tool_catalog") return "tool_catalog";
	return "paired";
}

function evidenceReasons(lever: PolicyLever, evidence: PolicyExperimentEvidenceV1): string[] {
	const reasons: string[] = [];
	if (evidence.mode !== "live_paired") reasons.push("live_paired_evidence_required");
	if (evidence.repetitions < 5) reasons.push("five_repetitions_required");
	if (evidence.caseCount < 30) reasons.push("thirty_case_suite_required");
	if (!evidence.qualityGatePassed) reasons.push("quality_gate_required");
	for (const failure of evidence.hardGateFailures) reasons.push(`hard_gate_failure:${failure}`);

	if (evidence.kind !== expectedEvidenceKind(lever)) {
		reasons.push("lever_evidence_kind_mismatch");
		return reasons;
	}

	if (evidence.kind === "cache_friendly_assembly") {
		const cache = evidence.cache;
		if (
			!nonblank(cache.provider) ||
			!nonblank(cache.model) ||
			!nonblank(cache.api) ||
			!nonblank(cache.modelFactsFingerprint)
		) {
			reasons.push("provider_model_api_facts_fingerprint_required");
		}
		if (
			!validCount(cache.requestCount, 1) ||
			!validCount(cache.cacheReadTokens) ||
			!validCount(cache.cacheWriteTokens)
		) {
			reasons.push("provider_cache_counters_required");
		}
	}

	if (evidence.kind === "prompt_overlay") {
		const failureClass = evidence.failureClass.trim();
		const caseIds = new Set<string>();
		const independenceKeys = new Set<string>();
		let allCasesValid = nonblank(failureClass);
		for (const item of evidence.cases) {
			const caseId = item.caseId.trim();
			const independenceKey = item.independenceKey.trim();
			if (
				!nonblank(caseId) ||
				!nonblank(independenceKey) ||
				item.failureClass.trim() !== failureClass ||
				item.real !== true ||
				item.reproducible !== true
			) {
				allCasesValid = false;
			}
			caseIds.add(caseId);
			independenceKeys.add(independenceKey);
		}
		if (!allCasesValid || caseIds.size < 5 || independenceKeys.size < 5) {
			reasons.push("five_same_class_real_reproducible_independent_cases_required");
		}
		reasons.push(...heldOutReasons(evidence.heldOut, "overlay"));
	}

	if (evidence.kind === "tool_catalog") {
		reasons.push(...heldOutReasons(evidence.toolSelectionHeldOut, "tool_selection"));
		reasons.push(...heldOutReasons(evidence.taskSuccessHeldOut, "task_success"));
	}

	return reasons;
}

function decidePolicy(
	input: Omit<PolicyLeverEvaluationInput, "combinationRun"> & { combinationRun: boolean },
): PolicyDecision {
	const reasons: string[] = [];
	if (input.baselineFingerprint === input.candidateFingerprint) {
		reasons.push("distinct_policy_fingerprints_required");
	}
	if (input.changedLevers.length !== 1) {
		reasons.push("exactly_one_changed_lever_required");
	} else if (input.changedLevers[0] !== input.lever) {
		reasons.push("changed_lever_must_match_receipt_lever");
	}
	if (input.combinationRun) reasons.push("combination_run_shadow_only");
	reasons.push(...evidenceReasons(input.lever, input.evidence));
	if (PRODUCTION_LEVERS[input.lever] !== true) reasons.push("lever_not_production_mappable");

	const hardFailure = input.evidence.hardGateFailures.length > 0 || !input.evidence.qualityGatePassed;
	if (hardFailure) return { decision: "rejected", applied: false, reasons };
	if (reasons.length > 0) return { decision: "shadow", applied: false, reasons };
	if (!input.rolloutApproved) {
		return {
			decision: "eligible",
			applied: false,
			reasons: ["explicit_rollout_approval_required"],
		};
	}
	return { decision: "active", applied: true, reasons };
}

function cloneHeldOut(evidence: HeldOutDatasetEvidenceV1): HeldOutDatasetEvidenceV1 {
	return { ...evidence };
}

function cloneEvidence(evidence: PolicyExperimentEvidenceV1): PolicyExperimentEvidenceV1 {
	const base: PolicyExperimentEvidenceBaseV1 = {
		mode: evidence.mode,
		repetitions: evidence.repetitions,
		caseCount: evidence.caseCount,
		qualityGatePassed: evidence.qualityGatePassed,
		hardGateFailures: [...evidence.hardGateFailures].sort(),
	};
	if (evidence.kind === "cache_friendly_assembly") {
		return { ...base, kind: evidence.kind, cache: { ...evidence.cache } };
	}
	if (evidence.kind === "prompt_overlay") {
		return {
			...base,
			kind: evidence.kind,
			failureClass: evidence.failureClass,
			cases: evidence.cases.map(item => ({ ...item })).sort((a, b) => a.caseId.localeCompare(b.caseId)),
			heldOut: cloneHeldOut(evidence.heldOut),
		};
	}
	if (evidence.kind === "tool_catalog") {
		return {
			...base,
			kind: evidence.kind,
			toolSelectionHeldOut: cloneHeldOut(evidence.toolSelectionHeldOut),
			taskSuccessHeldOut: cloneHeldOut(evidence.taskSuccessHeldOut),
		};
	}
	return { ...base, kind: "paired" };
}

function receiptFingerprint(receipt: Omit<PolicyExperimentReceiptV1, "policyFingerprint">): string {
	return sha256Hex(stableStringify(receipt));
}

export function evaluatePolicyLever(input: PolicyLeverEvaluationInput): PolicyExperimentReceiptV1 {
	const evidence = cloneEvidence(input.evidence);
	const changedLevers = [...input.changedLevers].sort();
	const combinationRun = input.combinationRun === true;
	const decision = decidePolicy({ ...input, evidence, changedLevers, combinationRun });
	const receiptWithoutFingerprint: Omit<PolicyExperimentReceiptV1, "policyFingerprint"> = {
		schemaVersion: POLICY_EXPERIMENT_RECEIPT_VERSION,
		kind: POLICY_EXPERIMENT_RECEIPT_KIND,
		experimentId: input.experimentId,
		lever: input.lever,
		baselineFingerprint: input.baselineFingerprint,
		candidateFingerprint: input.candidateFingerprint,
		changedLevers,
		combinationRun,
		datasetVersion: input.datasetVersion,
		decision: decision.decision,
		applied: decision.applied,
		evidence,
		rolloutApproved: input.rolloutApproved,
		reasons: [...decision.reasons],
	};
	return {
		...receiptWithoutFingerprint,
		policyFingerprint: receiptFingerprint(receiptWithoutFingerprint),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
}

function isHeldOutEvidence(value: unknown): value is HeldOutDatasetEvidenceV1 {
	if (!isRecord(value)) return false;
	return (
		typeof value.datasetVersion === "string" &&
		typeof value.datasetFingerprint === "string" &&
		typeof value.caseCount === "number" &&
		typeof value.passed === "boolean"
	);
}

function isPromptCaseEvidence(value: unknown): value is PromptOverlayCaseEvidenceV1 {
	if (!isRecord(value)) return false;
	return (
		typeof value.caseId === "string" &&
		typeof value.failureClass === "string" &&
		typeof value.independenceKey === "string" &&
		typeof value.real === "boolean" &&
		typeof value.reproducible === "boolean"
	);
}

function isPolicyEvidence(value: unknown): value is PolicyExperimentEvidenceV1 {
	if (!isRecord(value)) return false;
	if (
		typeof value.mode !== "string" ||
		EVIDENCE_MODES[value.mode as PolicyEvidenceMode] !== true ||
		typeof value.repetitions !== "number" ||
		typeof value.caseCount !== "number" ||
		typeof value.qualityGatePassed !== "boolean" ||
		!isStringArray(value.hardGateFailures)
	) {
		return false;
	}
	if (value.kind === "paired") return true;
	if (value.kind === "cache_friendly_assembly") {
		if (!isRecord(value.cache)) return false;
		return (
			typeof value.cache.provider === "string" &&
			typeof value.cache.model === "string" &&
			typeof value.cache.api === "string" &&
			typeof value.cache.modelFactsFingerprint === "string" &&
			typeof value.cache.requestCount === "number" &&
			typeof value.cache.cacheReadTokens === "number" &&
			typeof value.cache.cacheWriteTokens === "number"
		);
	}
	if (value.kind === "prompt_overlay") {
		return (
			typeof value.failureClass === "string" &&
			Array.isArray(value.cases) &&
			value.cases.every(isPromptCaseEvidence) &&
			isHeldOutEvidence(value.heldOut)
		);
	}
	if (value.kind === "tool_catalog") {
		return isHeldOutEvidence(value.toolSelectionHeldOut) && isHeldOutEvidence(value.taskSuccessHeldOut);
	}
	return false;
}

/** Validate every authority-bearing field and recompute the deterministic fingerprint. */
export function validatePolicyExperimentReceipt(value: unknown): value is PolicyExperimentReceiptV1 {
	if (!isRecord(value)) return false;
	if (
		value.schemaVersion !== POLICY_EXPERIMENT_RECEIPT_VERSION ||
		value.kind !== POLICY_EXPERIMENT_RECEIPT_KIND ||
		typeof value.experimentId !== "string" ||
		typeof value.lever !== "string" ||
		POLICY_LEVERS[value.lever as PolicyLever] !== true ||
		typeof value.baselineFingerprint !== "string" ||
		typeof value.candidateFingerprint !== "string" ||
		!Array.isArray(value.changedLevers) ||
		!value.changedLevers.every(lever => typeof lever === "string" && POLICY_LEVERS[lever as PolicyLever] === true) ||
		typeof value.combinationRun !== "boolean" ||
		typeof value.datasetVersion !== "string" ||
		typeof value.policyFingerprint !== "string" ||
		typeof value.decision !== "string" ||
		DECISIONS[value.decision as PolicyLeverDecision] !== true ||
		typeof value.applied !== "boolean" ||
		!isPolicyEvidence(value.evidence) ||
		typeof value.rolloutApproved !== "boolean" ||
		!isStringArray(value.reasons)
	) {
		return false;
	}

	const receipt = value as unknown as PolicyExperimentReceiptV1;
	const expected = decidePolicy({
		experimentId: receipt.experimentId,
		lever: receipt.lever,
		baselineFingerprint: receipt.baselineFingerprint,
		candidateFingerprint: receipt.candidateFingerprint,
		changedLevers: receipt.changedLevers,
		combinationRun: receipt.combinationRun,
		datasetVersion: receipt.datasetVersion,
		evidence: receipt.evidence,
		rolloutApproved: receipt.rolloutApproved,
	});
	if (receipt.decision !== expected.decision || receipt.applied !== expected.applied) return false;
	if (stableStringify(receipt.reasons) !== stableStringify(expected.reasons)) return false;
	const { policyFingerprint, ...withoutFingerprint } = receipt;
	return policyFingerprint === receiptFingerprint(withoutFingerprint);
}

export function featureGatesFromExperiment(receipt: unknown): ModelPolicyFeatureGates {
	if (!validatePolicyExperimentReceipt(receipt) || receipt.decision !== "active" || !receipt.applied) {
		return { compilerShadow: true, compilerActive: false };
	}
	if (receipt.lever !== "tool_concurrency_ceiling" && receipt.lever !== "descriptor_placement") {
		return { compilerShadow: true, compilerActive: false };
	}
	return {
		compilerShadow: true,
		compilerActive: true,
		activeLever: receipt.lever,
	};
}

/**
 * Production boundary: raw gates can describe a shadow candidate, but only a
 * validated experiment receipt can authorize a live compiler lever.
 */
export function productionPolicyFeatureGates(
	rawGates?: ModelPolicyFeatureGates,
	receipt?: unknown,
): ModelPolicyFeatureGates {
	const { compilerActive: _rawActive, activeLever: _rawLever, ...shadowCandidate } = rawGates ?? {};
	const approved = featureGatesFromExperiment(receipt);
	return {
		...shadowCandidate,
		compilerShadow:
			approved.compilerActive === true ? true : rawGates?.compilerShadow !== false || _rawActive === true,
		compilerActive: approved.compilerActive,
		...(approved.activeLever ? { activeLever: approved.activeLever } : {}),
	};
}
