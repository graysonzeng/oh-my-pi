import { describe, expect, it } from "bun:test";
import type { WorkflowDefaultConfig } from "../../src/workflow/default-config";
import { WorkflowPolicyError } from "../../src/workflow/errors";
import {
	compileQualityRouteSnapshot,
	qualityRouteProfiles,
	verifyQualityRouteSnapshot,
} from "../../src/workflow/quality-route-snapshot";
import type { ModelProfile, WorkflowRole } from "../../src/workflow/types";

type SnapshotConfig = Pick<WorkflowDefaultConfig, "profiles" | "qualityRoutes">;

function snapshotProfile(id: string, role: WorkflowRole, provider: string, model: string): ModelProfile {
	return {
		id,
		vendor: provider,
		modelPattern: `${provider}/${model}`,
		roles: [role],
		thinkingLevel: "medium" as ModelProfile["thinkingLevel"],
		strictIdentity: true,
		promptTemplate: "quality-snapshot-test",
		promptVersion: "1",
		toolPolicyId: "quality-snapshot-test",
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

function snapshotConfig(
	plannerOrder: readonly [string, string] = ["planner_primary", "planner_backup"],
): SnapshotConfig {
	const profiles: Record<string, ModelProfile> = {
		planner_primary: snapshotProfile("planner_primary", "planner", "openai", "gpt-5.6-sol"),
		planner_backup: snapshotProfile("planner_backup", "planner", "anthropic", "claude-fable-5"),
		plan_reviewer_primary: snapshotProfile("plan_reviewer_primary", "plan_reviewer", "anthropic", "claude-fable-5"),
		plan_reviewer_backup: snapshotProfile("plan_reviewer_backup", "plan_reviewer", "openai", "gpt-5.6-sol"),
		implementer_primary: snapshotProfile("implementer_primary", "implementer", "xai", "grok-4.6"),
		implementer_backup: snapshotProfile("implementer_backup", "implementer", "openai", "gpt-5.6-sol"),
		reviewer_primary: snapshotProfile("reviewer_primary", "code_reviewer", "openai", "gpt-5.6-sol"),
		reviewer_backup: snapshotProfile("reviewer_backup", "code_reviewer", "xai", "grok-4.6"),
		repair_primary: snapshotProfile("repair_primary", "repair", "xai", "grok-4.6"),
		repair_backup: snapshotProfile("repair_backup", "repair", "anthropic", "claude-fable-5"),
	};
	const secretProfile = profiles.planner_primary as ModelProfile & {
		apiKey?: string;
		authToken?: string;
	};
	secretProfile.apiKey = "secret-api-key";
	secretProfile.authToken = "secret-auth-token";

	return {
		profiles,
		qualityRoutes: {
			balanced: {
				planner: [...plannerOrder],
				plan_reviewer: ["plan_reviewer_primary", "plan_reviewer_backup"],
				plan_arbitrator: [],
				implementer: ["implementer_primary", "implementer_backup"],
				code_reviewer: ["reviewer_primary", "reviewer_backup"],
				repair: ["repair_primary", "repair_backup"],
			},
			critical: {
				planner: [...plannerOrder].reverse(),
				plan_reviewer: ["plan_reviewer_backup", "plan_reviewer_primary"],
				plan_arbitrator: [],
				implementer: ["implementer_backup", "implementer_primary"],
				code_reviewer: ["reviewer_backup", "reviewer_primary"],
				repair: ["repair_backup", "repair_primary"],
			},
		},
	};
}

function expectPolicyError(run: () => unknown, reason: string, details: unknown): void {
	let thrown: unknown;
	try {
		run();
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(WorkflowPolicyError);
	const policyError = thrown as WorkflowPolicyError;
	expect(policyError.kind).toBe("policy_violation");
	expect(policyError.message).toBe(`Policy violation: ${reason}`);
	expect(policyError.details).toEqual(details);
}

describe("quality route snapshots", () => {
	it("compiles ordered, deeply frozen, secret-safe profiles", () => {
		const config = snapshotConfig();
		const snapshot = compileQualityRouteSnapshot(config, "balanced");

		expect(snapshot.qualityTier).toBe("balanced");
		expect(snapshot.degradedMode).toBe(false);
		expect(snapshot.routes.planner).toEqual(["planner_primary", "planner_backup"]);
		expect(snapshot.routes.plan_reviewer).toEqual(["plan_reviewer_primary", "plan_reviewer_backup"]);
		expect(snapshot.profiles.map(entry => entry.profile.id)).toEqual([
			"planner_primary",
			"planner_backup",
			"plan_reviewer_primary",
			"plan_reviewer_backup",
			"implementer_primary",
			"implementer_backup",
			"reviewer_primary",
			"reviewer_backup",
			"repair_primary",
			"repair_backup",
		]);
		const persistedProfile = snapshot.profiles[0]!.profile as ModelProfile & {
			apiKey?: string;
			authToken?: string;
		};
		expect(persistedProfile.apiKey).toBeUndefined();
		expect(persistedProfile.authToken).toBeUndefined();
		expect(JSON.stringify(snapshot)).not.toContain("secret-api-key");
		expect(JSON.stringify(snapshot)).not.toContain("secret-auth-token");
		expect(snapshot.profiles.every(entry => entry.configuredIdentity.provenance === "configured")).toBe(true);
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.routes)).toBe(true);
		expect(Object.isFrozen(snapshot.routes.planner)).toBe(true);
		expect(Object.isFrozen(snapshot.profiles)).toBe(true);
		expect(Object.isFrozen(snapshot.profiles[0])).toBe(true);
		expect(Object.isFrozen(snapshot.profiles[0]!.profile)).toBe(true);

		const sourcePlannerOrder = config.qualityRoutes.balanced!.planner as string[];
		sourcePlannerOrder.reverse();
		expect(snapshot.routes.planner).toEqual(["planner_primary", "planner_backup"]);
		const clonedProfiles = qualityRouteProfiles(snapshot);
		clonedProfiles[0]!.id = "mutated-copy";
		expect(snapshot.profiles[0]!.profile.id).toBe("planner_primary");
	});

	it("keeps fingerprints stable and changes them when candidate order changes", () => {
		const config = snapshotConfig();
		const first = compileQualityRouteSnapshot(config, "balanced");
		const second = compileQualityRouteSnapshot(snapshotConfig(), "balanced");
		const reordered = compileQualityRouteSnapshot(snapshotConfig(["planner_backup", "planner_primary"]), "balanced");

		expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
		expect(second.fingerprint).toBe(first.fingerprint);
		expect(reordered.fingerprint).not.toBe(first.fingerprint);
	});

	it("verifies a frozen clone and rejects fingerprint tampering with exact details", () => {
		const original = compileQualityRouteSnapshot(snapshotConfig(), "balanced");
		const changed = compileQualityRouteSnapshot(snapshotConfig(["planner_backup", "planner_primary"]), "balanced");
		const verified = verifyQualityRouteSnapshot(original);
		expect(verified).not.toBe(original);
		expect(verified).toEqual(original);
		expect(Object.isFrozen(verified)).toBe(true);
		expect(Object.isFrozen(verified.routes.planner)).toBe(true);

		const tampered = structuredClone(changed);
		tampered.fingerprint = original.fingerprint;
		expectPolicyError(() => verifyQualityRouteSnapshot(tampered), "quality_route_snapshot_fingerprint_mismatch", {
			expected: changed.fingerprint,
			actual: original.fingerprint,
		});
	});

	it("rejects a missing quality tier with exact error kind and details", () => {
		const config = snapshotConfig();
		delete (config.qualityRoutes as Record<string, unknown>).critical;
		expectPolicyError(() => compileQualityRouteSnapshot(config, "critical"), "quality_route_not_configured", {
			qualityTier: "critical",
		});
	});
});
