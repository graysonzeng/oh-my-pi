import { describe, expect, it } from "bun:test";
import {
	evaluatePolicyLever,
	featureGatesFromExperiment,
	type HeldOutDatasetEvidenceV1,
	type PolicyExperimentEvidenceV1,
	type PolicyLeverEvaluationInput,
	productionPolicyFeatureGates,
	validatePolicyExperimentReceipt,
} from "../../src/workflow/policy-experiment";

const pairedEvidence: PolicyExperimentEvidenceV1 = {
	kind: "paired",
	mode: "live_paired",
	repetitions: 5,
	caseCount: 30,
	qualityGatePassed: true,
	hardGateFailures: [],
};

const eligibleInput: PolicyLeverEvaluationInput = {
	experimentId: "exp-concurrency-1",
	lever: "tool_concurrency_ceiling",
	baselineFingerprint: "baseline-fp",
	candidateFingerprint: "candidate-fp",
	changedLevers: ["tool_concurrency_ceiling"],
	datasetVersion: "live-suite-2.0.0",
	evidence: pairedEvidence,
	rolloutApproved: true,
};

function heldOut(name: string, passed = true): HeldOutDatasetEvidenceV1 {
	return {
		datasetVersion: `${name}-1.0.0`,
		datasetFingerprint: `${name}-fingerprint`,
		caseCount: 30,
		passed,
	};
}

function overlayEvidence(): PolicyExperimentEvidenceV1 {
	return {
		...pairedEvidence,
		kind: "prompt_overlay",
		failureClass: "scope_drift",
		cases: Array.from({ length: 5 }, (_, index) => ({
			caseId: `real-case-${index}`,
			failureClass: "scope_drift",
			independenceKey: `root-cause-${index}`,
			real: true,
			reproducible: true,
		})),
		heldOut: heldOut("overlay"),
	};
}

describe("PolicyExperimentV1", () => {
	it("rejects raw active gates at the production boundary", () => {
		expect(
			productionPolicyFeatureGates({
				compilerShadow: false,
				compilerActive: true,
				activeLever: "tool_concurrency_ceiling",
			}),
		).toEqual({ compilerShadow: true, compilerActive: false });
	});

	it("keeps self-reported live evidence shadowed without a verifiable rollout authority", () => {
		const receipt = evaluatePolicyLever(eligibleInput);
		expect(validatePolicyExperimentReceipt(receipt)).toBe(true);
		expect(receipt).toMatchObject({
			schemaVersion: 1,
			kind: "policy_experiment_receipt",
			lever: "tool_concurrency_ceiling",
			decision: "shadow",
			applied: false,
		});
		expect(receipt.reasons).toContain("verified_rollout_authority_unavailable");
		expect(featureGatesFromExperiment(receipt)).toEqual({
			compilerShadow: true,
			compilerActive: false,
		});
		expect(
			productionPolicyFeatureGates(
				{ compilerActive: true, activeLever: "descriptor_placement", contextCache: true },
				receipt,
			),
		).toEqual({
			compilerShadow: true,
			compilerActive: false,
			contextCache: true,
		});
	});

	it("rejects mutated and forged receipts by recomputing stored evidence", () => {
		const receipt = evaluatePolicyLever(eligibleInput);
		const mutated = structuredClone(receipt);
		mutated.evidence.repetitions = 4;
		const forged = { ...receipt, decision: "active" as const, applied: true };
		const forgedFingerprint = { ...receipt, policyFingerprint: "0".repeat(64) };

		expect(validatePolicyExperimentReceipt(mutated)).toBe(false);
		expect(validatePolicyExperimentReceipt(forged)).toBe(false);
		expect(validatePolicyExperimentReceipt(forgedFingerprint)).toBe(false);
		expect(featureGatesFromExperiment(mutated)).toEqual({ compilerShadow: true, compilerActive: false });
	});

	it("keeps identical, zero, multiple, and mismatched lever diffs shadowed", () => {
		const cases: PolicyLeverEvaluationInput[] = [
			{ ...eligibleInput, candidateFingerprint: eligibleInput.baselineFingerprint },
			{ ...eligibleInput, changedLevers: [] },
			{ ...eligibleInput, changedLevers: ["tool_concurrency_ceiling", "descriptor_placement"] },
			{ ...eligibleInput, changedLevers: ["descriptor_placement"] },
		];
		const receipts = cases.map(evaluatePolicyLever);
		expect(receipts.every(receipt => receipt.decision === "shadow" && !receipt.applied)).toBe(true);
		expect(receipts[0]?.reasons).toContain("distinct_policy_fingerprints_required");
		expect(receipts[1]?.reasons).toContain("exactly_one_changed_lever_required");
		expect(receipts[2]?.reasons).toContain("exactly_one_changed_lever_required");
		expect(receipts[3]?.reasons).toContain("changed_lever_must_match_receipt_lever");
	});

	it("keeps unsupported levers and explicit combination runs shadow-only", () => {
		const unsupported = evaluatePolicyLever({
			...eligibleInput,
			lever: "prompt_overlay",
			changedLevers: ["prompt_overlay"],
			evidence: overlayEvidence(),
		});
		const combo = evaluatePolicyLever({ ...eligibleInput, combinationRun: true });

		expect(unsupported.decision).toBe("shadow");
		expect(unsupported.reasons).toContain("lever_not_production_mappable");
		expect(combo.decision).toBe("shadow");
		expect(combo.reasons).toContain("combination_run_shadow_only");
		expect(featureGatesFromExperiment(unsupported)).toEqual({ compilerShadow: true, compilerActive: false });
	});

	it("requires typed cache counters and provider/model/API/facts identity", () => {
		const validCache: PolicyExperimentEvidenceV1 = {
			...pairedEvidence,
			kind: "cache_friendly_assembly",
			cache: {
				provider: "openai",
				model: "gpt-5",
				api: "responses",
				modelFactsFingerprint: "facts-fingerprint",
				requestCount: 30,
				cacheReadTokens: 1200,
				cacheWriteTokens: 300,
			},
		};
		const missingIdentity = evaluatePolicyLever({
			...eligibleInput,
			lever: "cache_friendly_assembly",
			changedLevers: ["cache_friendly_assembly"],
			evidence: { ...validCache, cache: { ...validCache.cache, api: "" } },
		});
		const missingCounters = evaluatePolicyLever({
			...eligibleInput,
			lever: "cache_friendly_assembly",
			changedLevers: ["cache_friendly_assembly"],
			evidence: { ...validCache, cache: { ...validCache.cache, requestCount: 0 } },
		});

		expect(missingIdentity.reasons).toContain("provider_model_api_facts_fingerprint_required");
		expect(missingCounters.reasons).toContain("provider_cache_counters_required");
		expect(missingIdentity.applied || missingCounters.applied).toBe(false);
	});

	it("requires five nonblank same-class real reproducible independent overlay cases and held-out data", () => {
		const evidence = overlayEvidence();
		if (evidence.kind !== "prompt_overlay") throw new Error("expected overlay evidence");
		const invalid = structuredClone(evidence);
		invalid.cases[0] = { ...invalid.cases[0]!, caseId: " ", failureClass: "other" };
		invalid.cases[1] = { ...invalid.cases[1]!, independenceKey: invalid.cases[2]!.independenceKey };
		invalid.cases[3] = { ...invalid.cases[3]!, real: false };
		invalid.heldOut.passed = false;
		const receipt = evaluatePolicyLever({
			...eligibleInput,
			lever: "prompt_overlay",
			changedLevers: ["prompt_overlay"],
			evidence: invalid,
		});

		expect(receipt.reasons).toContain("five_same_class_real_reproducible_independent_cases_required");
		expect(receipt.reasons).toContain("overlay_held_out_pass_required");
		expect(receipt.applied).toBe(false);
	});

	it("requires both tool-selection and task-success held-out results", () => {
		const evidence: PolicyExperimentEvidenceV1 = {
			...pairedEvidence,
			kind: "tool_catalog",
			toolSelectionHeldOut: heldOut("selection"),
			taskSuccessHeldOut: heldOut("success", false),
		};
		const receipt = evaluatePolicyLever({
			...eligibleInput,
			lever: "tool_catalog",
			changedLevers: ["tool_catalog"],
			evidence,
		});
		expect(receipt.reasons).toContain("task_success_held_out_pass_required");
		expect(receipt.applied).toBe(false);
	});

	it("keeps an unapproved self-reported receipt shadowed", () => {
		const receipt = evaluatePolicyLever({ ...eligibleInput, rolloutApproved: false });
		expect(receipt.decision).toBe("shadow");
		expect(receipt.applied).toBe(false);
		expect(receipt.reasons).toContain("verified_rollout_authority_unavailable");
		expect(featureGatesFromExperiment(receipt)).toEqual({ compilerShadow: true, compilerActive: false });
	});

	it("fails closed on hard-gate regressions even when rollout is approved", () => {
		const receipt = evaluatePolicyLever({
			...eligibleInput,
			evidence: { ...pairedEvidence, hardGateFailures: ["scope_adherence"] },
		});
		expect(receipt.decision).toBe("rejected");
		expect(receipt.applied).toBe(false);
		expect(receipt.reasons).toContain("hard_gate_failure:scope_adherence");
	});
});
