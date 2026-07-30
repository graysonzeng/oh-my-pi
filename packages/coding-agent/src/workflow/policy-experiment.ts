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

export interface PolicyExperimentEvidenceV1 {
	mode: PolicyEvidenceMode;
	repetitions: number;
	caseCount: number;
	qualityGatePassed: boolean;
	hardGateFailures: string[];
}

export interface PolicyLeverEvaluationInput {
	experimentId: string;
	lever: PolicyLever;
	baselineFingerprint: string;
	candidateFingerprint: string;
	datasetVersion: string;
	providerFactsObservable: boolean;
	evidence: PolicyExperimentEvidenceV1;
	rolloutApproved: boolean;
	failureCaseIds?: string[];
	heldOutEvalPassed?: boolean;
}

export interface PolicyExperimentReceiptV1 {
	schemaVersion: typeof POLICY_EXPERIMENT_RECEIPT_VERSION;
	kind: typeof POLICY_EXPERIMENT_RECEIPT_KIND;
	experimentId: string;
	lever: PolicyLever;
	baselineFingerprint: string;
	candidateFingerprint: string;
	datasetVersion: string;
	policyFingerprint: string;
	decision: PolicyLeverDecision;
	applied: boolean;
	evidence: PolicyExperimentEvidenceV1;
	reasons: string[];
}

export function evaluatePolicyLever(input: PolicyLeverEvaluationInput): PolicyExperimentReceiptV1 {
	const reasons: string[] = [];
	const independentFailureCaseCount = new Set(input.failureCaseIds ?? []).size;

	if (input.evidence.mode !== "live_paired") reasons.push("live_paired_evidence_required");
	if (input.evidence.repetitions < 5) reasons.push("five_repetitions_required");
	if (input.evidence.caseCount < 30) reasons.push("thirty_case_suite_required");
	if (!input.evidence.qualityGatePassed) reasons.push("quality_gate_required");
	for (const failure of input.evidence.hardGateFailures) reasons.push(`hard_gate_failure:${failure}`);
	if (input.lever === "cache_friendly_assembly" && !input.providerFactsObservable) {
		reasons.push("provider_cache_facts_required");
	}
	if (input.lever === "prompt_overlay" && independentFailureCaseCount < 5) {
		reasons.push("five_independent_failure_cases_required");
	}
	if (input.lever === "prompt_overlay" && input.heldOutEvalPassed !== true) {
		reasons.push("held_out_overlay_eval_required");
	}
	if (input.lever === "tool_catalog" && input.heldOutEvalPassed !== true) {
		reasons.push("held_out_tool_selection_required");
	}

	const hardFailure = input.evidence.hardGateFailures.length > 0 || !input.evidence.qualityGatePassed;
	const evidenceEligible = reasons.length === 0;
	let decision: PolicyLeverDecision;
	if (hardFailure) {
		decision = "rejected";
	} else if (!evidenceEligible) {
		decision = "shadow";
	} else if (!input.rolloutApproved) {
		decision = "eligible";
		reasons.push("explicit_rollout_approval_required");
	} else {
		decision = "active";
	}

	const fingerprintInput = JSON.stringify({
		experimentId: input.experimentId,
		lever: input.lever,
		baselineFingerprint: input.baselineFingerprint,
		candidateFingerprint: input.candidateFingerprint,
		datasetVersion: input.datasetVersion,
		evidence: input.evidence,
		providerFactsObservable: input.providerFactsObservable,
		failureCaseIds: [...new Set(input.failureCaseIds ?? [])].sort(),
		heldOutEvalPassed: input.heldOutEvalPassed === true,
		rolloutApproved: input.rolloutApproved,
	});

	return {
		schemaVersion: POLICY_EXPERIMENT_RECEIPT_VERSION,
		kind: POLICY_EXPERIMENT_RECEIPT_KIND,
		experimentId: input.experimentId,
		lever: input.lever,
		baselineFingerprint: input.baselineFingerprint,
		candidateFingerprint: input.candidateFingerprint,
		datasetVersion: input.datasetVersion,
		policyFingerprint: sha256Hex(fingerprintInput),
		decision,
		applied: decision === "active",
		evidence: {
			...input.evidence,
			hardGateFailures: [...input.evidence.hardGateFailures],
		},
		reasons,
	};
}

export function featureGatesFromExperiment(receipt: PolicyExperimentReceiptV1): ModelPolicyFeatureGates {
	if (receipt.decision !== "active" || !receipt.applied) {
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
