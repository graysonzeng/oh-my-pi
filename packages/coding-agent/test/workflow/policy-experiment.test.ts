import { describe, expect, it } from "bun:test";
import {
	evaluatePolicyLever,
	featureGatesFromExperiment,
	type PolicyLeverEvaluationInput,
} from "../../src/workflow/policy-experiment";

const eligibleInput: PolicyLeverEvaluationInput = {
	experimentId: "exp-concurrency-1",
	lever: "tool_concurrency_ceiling",
	baselineFingerprint: "baseline-fp",
	candidateFingerprint: "candidate-fp",
	datasetVersion: "live-suite-2.0.0",
	providerFactsObservable: true,
	evidence: {
		mode: "live_paired",
		repetitions: 5,
		caseCount: 30,
		qualityGatePassed: true,
		hardGateFailures: [],
	},
	rolloutApproved: true,
};

describe("PolicyExperimentV1", () => {
	it("keeps every lever shadowed without live paired hard-gate evidence", () => {
		for (const lever of [
			"tool_concurrency_ceiling",
			"descriptor_placement",
			"cache_friendly_assembly",
			"prompt_overlay",
			"tool_catalog",
		] as const) {
			const receipt = evaluatePolicyLever({
				...eligibleInput,
				lever,
				evidence: { ...eligibleInput.evidence, mode: "fake" },
			});
			expect(receipt.decision).toBe("shadow");
			expect(receipt.applied).toBe(false);
			expect(receipt.reasons).toContain("live_paired_evidence_required");
		}
	});

	it("requires provider facts for cache assembly, five independent failure cases for overlays, and held-out tool selection for catalog", () => {
		const cache = evaluatePolicyLever({
			...eligibleInput,
			lever: "cache_friendly_assembly",
			providerFactsObservable: false,
		});
		const overlay = evaluatePolicyLever({
			...eligibleInput,
			lever: "prompt_overlay",
			failureCaseIds: ["case-1", "case-2", "case-3", "case-4"],
			heldOutEvalPassed: true,
		});
		const catalog = evaluatePolicyLever({
			...eligibleInput,
			lever: "tool_catalog",
			heldOutEvalPassed: false,
		});

		expect(cache.reasons).toContain("provider_cache_facts_required");
		expect(overlay.reasons).toContain("five_independent_failure_cases_required");
		expect(catalog.reasons).toContain("held_out_tool_selection_required");
		expect([cache, overlay, catalog].every(receipt => receipt.applied === false)).toBe(true);
	});

	it("records eligibility without changing production when rollout approval is absent", () => {
		const receipt = evaluatePolicyLever({ ...eligibleInput, rolloutApproved: false });
		expect(receipt.decision).toBe("eligible");
		expect(receipt.applied).toBe(false);
		expect(receipt.reasons).toContain("explicit_rollout_approval_required");
	});

	it("allows one approved lever only after all evidence gates pass", () => {
		const receipt = evaluatePolicyLever(eligibleInput);
		expect(receipt).toMatchObject({
			schemaVersion: 1,
			kind: "policy_experiment_receipt",
			lever: "tool_concurrency_ceiling",
			decision: "active",
			applied: true,
		});
		expect(receipt.policyFingerprint.length).toBe(64);
	});

	it("fails closed on hard-gate regressions even when rollout is approved", () => {
		const receipt = evaluatePolicyLever({
			...eligibleInput,
			evidence: {
				...eligibleInput.evidence,
				hardGateFailures: ["scope_adherence"],
			},
		});
		expect(receipt.decision).toBe("rejected");
		expect(receipt.applied).toBe(false);
		expect(receipt.reasons).toContain("hard_gate_failure:scope_adherence");
	});

	it("maps only active receipts to a single compiler lever gate", () => {
		const active = evaluatePolicyLever(eligibleInput);
		const shadow = evaluatePolicyLever({ ...eligibleInput, rolloutApproved: false });

		expect(featureGatesFromExperiment(active)).toEqual({
			compilerShadow: true,
			compilerActive: true,
			activeLever: "tool_concurrency_ceiling",
		});
		expect(featureGatesFromExperiment(shadow)).toEqual({ compilerShadow: true, compilerActive: false });
	});
});
