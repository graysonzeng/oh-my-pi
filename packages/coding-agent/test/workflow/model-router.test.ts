import { describe, expect, it } from "bun:test";
import { DEFAULT_MODEL_PROFILES } from "../../src/workflow/default-config";
import { WorkflowPolicyError } from "../../src/workflow/errors";
import { FindingTracker } from "../../src/workflow/finding-tracker";
import { ModelRouter } from "../../src/workflow/model-router";
import type { ModelProfile, ReviewFindingV1, WorkflowRole } from "../../src/workflow/types";

function qualityProfile(id: string, role: WorkflowRole, provider: string, model: string): ModelProfile {
	return {
		id,
		vendor: provider,
		modelPattern: `${provider}/${model}`,
		roles: [role],
		thinkingLevel: "medium" as ModelProfile["thinkingLevel"],
		strictIdentity: true,
		promptTemplate: "quality-test",
		promptVersion: "1",
		toolPolicyId: "quality-test",
		maxRequests: 2,
		maxRuntimeMs: 1000,
		retryPolicy: { maxAttempts: 2, retryableErrorKinds: ["provider_transient"], fallbackProfileIds: [] },
		contextPolicy: {
			includePlan: true,
			includeReviewFindings: true,
			includeVerification: true,
			includeFullTranscript: false,
			maxArtifactBytes: 1000,
		},
	};
}

function qualityProfiles(): ModelProfile[] {
	return [
		qualityProfile("planner_openai", "planner", "openai", "gpt-5.6-sol"),
		qualityProfile("planner_anthropic", "planner", "anthropic", "claude-fable-5"),
		qualityProfile("plan_reviewer_anthropic", "plan_reviewer", "anthropic", "claude-fable-5"),
		qualityProfile("plan_reviewer_openai", "plan_reviewer", "openai", "gpt-5.6-sol"),
		qualityProfile("implementer_openai", "implementer", "openai", "gpt-5.6-sol"),
		qualityProfile("implementer_xai", "implementer", "xai", "grok-4.6"),
		qualityProfile("reviewer_xai", "code_reviewer", "xai", "grok-4.6"),
		qualityProfile("reviewer_openai", "code_reviewer", "openai", "gpt-5.6-sol"),
		qualityProfile("repair_xai", "repair", "xai", "grok-4.6"),
	];
}

describe("ModelRouter", () => {
	const router = new ModelRouter(Object.values(DEFAULT_MODEL_PROFILES));

	it("resolves role to profile with audit metadata", () => {
		const decision = router.resolve("planner");
		expect(decision.profile.roles).toContain("planner");
		expect(decision.profileId).toBeTruthy();
		expect(decision.vendor).toBeTruthy();
		expect(decision.reason).toContain("role");
		expect(decision.degraded).toBe(false);
	});

	it("falls back when preferred profile is unavailable", () => {
		const primary = router.resolve("planner");
		expect(primary.profileId).toBe("claude_planner");
		expect(primary.qualityTier).toBeUndefined();
		expect(primary.candidateProfileIds).toBeUndefined();
		const decision = router.resolve("planner", { unavailableProfileIds: [primary.profileId] });
		expect(decision.profileId).toBe("gpt_planner");
		expect(decision.reason).toBe("fallback_from:claude_planner");
		expect(decision.qualityTier).toBeUndefined();
		expect(decision.candidateProfileIds).toBeUndefined();
	});

	it("selects a distinct plan-review profile and prefers another vendor", () => {
		const decision = router.resolve("plan_reviewer", {
			excludedProfileIds: ["claude_plan_reviewer"],
			avoidVendor: "anthropic",
		});
		expect(decision.profileId).toBe("gpt_plan_reviewer");
		expect(decision.vendor).toBe("openai");
	});

	it("rejects same-vendor code review unless degraded", () => {
		expect(() =>
			router.resolve("code_reviewer", {
				implementerVendor: "anthropic",
				// force only anthropic reviewers by marking openai unavailable
				unavailableProfileIds: ["gpt_reviewer"],
				degradedMode: false,
			}),
		).toThrow("independent_reviewer_unavailable");

		const degraded = router.resolve("code_reviewer", {
			implementerVendor: "anthropic",
			unavailableProfileIds: ["gpt_reviewer"],
			degradedMode: true,
		});
		expect(degraded.degraded).toBe(true);
		expect(degraded.reason).toBe("degraded_same_vendor_review");
	});

	it("routes complex and repeated findings to reasoning repair", () => {
		const finding: ReviewFindingV1 = {
			id: "f1",
			priority: "P0",
			category: "security",
			status: "open",
			confidence: 0.9,
			summary: "auth bypass",
			explanation: "critical",
			suggestedOwner: "reasoning_repair",
		};
		const tracker = new FindingTracker();
		tracker.add(finding);
		const decision = router.resolve("repair", { finding, findingTracker: tracker });
		expect(["anthropic", "openai"]).toContain(decision.vendor);
		expect(decision.reason).toMatch(/complex|role|repeated/);
	});

	it("escalates repeated findings via tracker + router", () => {
		const finding: ReviewFindingV1 = {
			id: "f2",
			priority: "P2",
			category: "correctness",
			status: "open",
			confidence: 0.8,
			summary: "off by one",
			explanation: "loop",
			suggestedOwner: "implementer",
		};
		const tracker = new FindingTracker();
		const tracked = tracker.add(finding);
		tracker.recordRepairCycle(tracked.fingerprint);
		tracker.recordRepairCycle(tracked.fingerprint);
		expect(tracker.hasRepeated(tracked.fingerprint)).toBe(true);
		const decision = router.resolve("repair", {
			finding,
			findingTracker: tracker,
			preferReasoningRepair: tracker.needsReasoningRepair(finding),
		});
		expect(["anthropic", "openai"]).toContain(decision.vendor);
	});
	it("keeps balanced and critical snapshot candidate order", () => {
		const qualityRouter = new ModelRouter(qualityProfiles());
		const balanced = qualityRouter.resolve("planner", {
			preferredProfileIds: ["planner_anthropic", "planner_openai"],
			qualityTier: "balanced",
			snapshotFingerprint: "balanced-fingerprint",
		});
		expect(balanced.profileId).toBe("planner_anthropic");
		expect(balanced.reason).toBe("quality_route:planner");
		expect(balanced.qualityTier).toBe("balanced");
		expect(balanced.snapshotFingerprint).toBe("balanced-fingerprint");
		expect(balanced.candidateProfileIds).toEqual(["planner_anthropic", "planner_openai"]);
		expect(balanced.skipped).toEqual([]);

		const critical = qualityRouter.resolve("planner", {
			preferredProfileIds: ["planner_openai", "planner_anthropic"],
			qualityTier: "critical",
			snapshotFingerprint: "critical-fingerprint",
		});
		expect(critical.profileId).toBe("planner_openai");
		expect(critical.reason).toBe("quality_route:planner");
		expect(critical.qualityTier).toBe("critical");
		expect(critical.snapshotFingerprint).toBe("critical-fingerprint");
		expect(critical.candidateProfileIds).toEqual(["planner_openai", "planner_anthropic"]);
		expect(critical.skipped).toEqual([]);
	});

	it("records deterministic skip reasons for every quality candidate rejection", () => {
		const qualityRouter = new ModelRouter([
			...qualityProfiles(),
			qualityProfile("wrong_role", "implementer", "openai", "gpt-5.6-sol"),
			qualityProfile("excluded", "planner", "openai", "gpt-5.6-sol"),
			qualityProfile("identity", "planner", "openai", "gpt-5.6-sol"),
			qualityProfile("attestation", "planner", "openai", "gpt-5.6-sol"),
			qualityProfile("effort", "planner", "openai", "gpt-5.6-sol"),
			qualityProfile("generic", "planner", "openai", "gpt-5.6-sol"),
			qualityProfile("opaque", "planner", "openai", "opaque-model"),
		]);
		const decision = qualityRouter.resolve("planner", {
			preferredProfileIds: [
				"missing_profile",
				"wrong_role",
				"excluded",
				"identity",
				"attestation",
				"effort",
				"generic",
				"opaque",
				"planner_openai",
			],
			qualityTier: "balanced",
			excludedProfileIds: ["excluded"],
			unavailableProfileIds: ["identity", "attestation", "effort", "generic"],
			unavailableReasons: {
				identity: "identity_mismatch: provider echo differs",
				attestation: "attestation_missing: gateway did not echo identity",
				effort: "effort_unsupported: requested medium",
				generic: "preflight unavailable",
			},
		});
		expect(decision.profileId).toBe("planner_openai");
		expect(decision.candidateProfileIds).toEqual([
			"missing_profile",
			"wrong_role",
			"excluded",
			"identity",
			"attestation",
			"effort",
			"generic",
			"opaque",
			"planner_openai",
		]);
		expect(decision.skipped).toEqual([
			{ profileId: "missing_profile", reason: "profile_not_found" },
			{ profileId: "wrong_role", reason: "role_mismatch" },
			{ profileId: "excluded", reason: "excluded" },
			{ profileId: "identity", reason: "identity_mismatch", detail: "identity_mismatch: provider echo differs" },
			{
				profileId: "attestation",
				reason: "attestation_missing",
				detail: "attestation_missing: gateway did not echo identity",
			},
			{ profileId: "effort", reason: "effort_unsupported", detail: "effort_unsupported: requested medium" },
			{ profileId: "generic", reason: "unavailable", detail: "preflight unavailable" },
			{
				profileId: "opaque",
				reason: "opaque_lineage",
				detail: "Policy violation: strict_model_profile_lineage_unknown",
			},
		]);
	});

	it("uses model lineage for planner/reviewer and implementer/reviewer independence", () => {
		const qualityRouter = new ModelRouter(qualityProfiles());
		const planner = qualityRouter.resolve("planner", {
			preferredProfileIds: ["planner_anthropic", "planner_openai"],
			qualityTier: "balanced",
		});
		expect(planner.modelFamily).toBe("anthropic");
		const planReviewer = qualityRouter.resolve("plan_reviewer", {
			preferredProfileIds: ["plan_reviewer_anthropic", "plan_reviewer_openai"],
			qualityTier: "balanced",
			avoidModelFamily: planner.modelFamily,
		});
		expect(planReviewer.profileId).toBe("plan_reviewer_openai");
		expect(planReviewer.modelFamily).toBe("openai");
		expect(planReviewer.skipped).toEqual([
			{ profileId: "plan_reviewer_anthropic", reason: "author_lineage_conflict", detail: "anthropic" },
		]);

		const implementer = qualityRouter.resolve("implementer", {
			preferredProfileIds: ["implementer_openai", "implementer_xai"],
			qualityTier: "critical",
		});
		const reviewer = qualityRouter.resolve("code_reviewer", {
			preferredProfileIds: ["reviewer_xai", "reviewer_openai"],
			qualityTier: "critical",
			implementerModelFamily: implementer.modelFamily,
		});
		expect(implementer.modelFamily).toBe("openai");
		expect(reviewer.profileId).toBe("reviewer_xai");
		expect(reviewer.modelFamily).toBe("xai");
		expect(reviewer.skipped).toEqual([
			{ profileId: "reviewer_openai", reason: "author_lineage_conflict", detail: "openai" },
		]);
	});

	it("recomputes reviewer independence after implementer fallback", () => {
		const qualityRouter = new ModelRouter(qualityProfiles());
		const initialImplementer = qualityRouter.resolve("implementer", {
			preferredProfileIds: ["implementer_openai", "implementer_xai"],
			qualityTier: "critical",
		});
		const fallbackImplementer = qualityRouter.resolve("implementer", {
			preferredProfileIds: ["implementer_openai", "implementer_xai"],
			qualityTier: "critical",
			unavailableProfileIds: [initialImplementer.profileId],
			unavailableReasons: { [initialImplementer.profileId]: "provider_transient: timeout" },
		});
		expect(initialImplementer.modelFamily).toBe("openai");
		expect(fallbackImplementer.profileId).toBe("implementer_xai");
		expect(fallbackImplementer.modelFamily).toBe("xai");
		expect(fallbackImplementer.reason).toBe("fallback_from:implementer_openai");

		const initialReviewer = qualityRouter.resolve("code_reviewer", {
			preferredProfileIds: ["reviewer_xai", "reviewer_openai"],
			qualityTier: "critical",
			implementerModelFamily: initialImplementer.modelFamily,
		});
		const recomputedReviewer = qualityRouter.resolve("code_reviewer", {
			preferredProfileIds: ["reviewer_xai", "reviewer_openai"],
			qualityTier: "critical",
			implementerModelFamily: fallbackImplementer.modelFamily,
		});
		expect(initialReviewer.profileId).toBe("reviewer_xai");
		expect(recomputedReviewer.profileId).toBe("reviewer_openai");
		expect(recomputedReviewer.skipped).toEqual([
			{ profileId: "reviewer_xai", reason: "author_lineage_conflict", detail: "xai" },
		]);
	});

	it("reports exact quality-route independence failure details", () => {
		const qualityRouter = new ModelRouter(qualityProfiles());
		let thrown: unknown;
		try {
			qualityRouter.resolve("code_reviewer", {
				preferredProfileIds: ["reviewer_xai"],
				qualityTier: "critical",
				implementerModelFamily: "xai",
			});
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(WorkflowPolicyError);
		const policyError = thrown as WorkflowPolicyError;
		expect(policyError.kind).toBe("policy_violation");
		expect(policyError.message).toBe("Policy violation: independent_reviewer_unavailable");
		expect(policyError.details).toEqual({
			role: "code_reviewer",
			qualityTier: "critical",
			authorModelFamily: "xai",
			candidateProfileIds: ["reviewer_xai"],
			skipped: [{ profileId: "reviewer_xai", reason: "author_lineage_conflict", detail: "xai" }],
		});
	});
});
