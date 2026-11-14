import { getDefaultConfig, type WorkflowDefaultConfig } from "./default-config";
import { WorkflowPolicyError } from "./errors";
import { assertSupportedModelProfile, normalizeModelProfile } from "./model-profile-registry";
import type { ModelProfile, WorkflowQualityRoutes, WorkflowQualityTier, WorkflowRole } from "./types";

/**
 * Merge settings `workflow.profiles` over defaults.
 * Empty / missing / non-object values fall back to defaults unchanged.
 * Every merged profile is normalized (legacy profile.runtime is rejected).
 */
export function resolveWorkflowProfilesFromSettings(
	rawProfiles: unknown,
	defaults: Record<string, ModelProfile>,
): Record<string, ModelProfile> {
	if (!rawProfiles || typeof rawProfiles !== "object" || Array.isArray(rawProfiles)) {
		return defaults;
	}
	const entries = Object.entries(rawProfiles as Record<string, unknown>);
	if (entries.length === 0) return defaults;

	const merged: Record<string, ModelProfile> = { ...defaults };
	for (const [key, value] of entries) {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			continue;
		}
		const partial = value as Partial<ModelProfile>;
		const base = defaults[key] ?? defaults[partial.id ?? ""];
		const profile = {
			...(base ?? {}),
			...partial,
			id: typeof partial.id === "string" && partial.id.length > 0 ? partial.id : key,
		} as ModelProfile;
		// Orphan overrides without a default base may be incomplete migration leftovers.
		// Fail closed: a partial profile must never reach the runtime (missing
		// contextPolicy would throw mid-stage; a missing identity silently degrades).
		const normalized = normalizeModelProfile(profile);
		assertSupportedModelProfile(normalized);
		merged[key] = normalized;
	}
	return merged;
}

const QUALITY_TIERS: readonly WorkflowQualityTier[] = ["balanced", "critical"];
const QUALITY_ROUTE_ROLES: readonly WorkflowRole[] = [
	"planner",
	"plan_reviewer",
	"implementer",
	"code_reviewer",
	"repair",
	"plan_arbitrator",
];

/** Arbitration is known but optional: absent routes remain default-off. */
const OPTIONAL_QUALITY_ROUTE_ROLES: readonly WorkflowRole[] = ["plan_arbitrator"];

export function resolveWorkflowQualityRoutesFromSettings(
	rawRoutes: unknown,
	profiles: Readonly<Record<string, ModelProfile>>,
): WorkflowQualityRoutes {
	if (rawRoutes === undefined || rawRoutes === null) return {};
	if (typeof rawRoutes !== "object" || Array.isArray(rawRoutes)) {
		throw new WorkflowPolicyError("invalid_quality_routes", { reason: "expected object" });
	}
	const entries = Object.entries(rawRoutes as Record<string, unknown>);
	if (entries.length === 0) return {};
	const routes: WorkflowQualityRoutes = {};
	for (const [tierKey, rawTier] of entries) {
		if (!QUALITY_TIERS.includes(tierKey as WorkflowQualityTier)) {
			throw new WorkflowPolicyError("unknown_quality_tier", { qualityTier: tierKey });
		}
		if (!rawTier || typeof rawTier !== "object" || Array.isArray(rawTier)) {
			throw new WorkflowPolicyError("invalid_quality_route_tier", { qualityTier: tierKey });
		}
		const rawRoleMap = rawTier as Record<string, unknown>;
		const unknownRoles = Object.keys(rawRoleMap).filter(role => !QUALITY_ROUTE_ROLES.includes(role as WorkflowRole));
		if (unknownRoles.length > 0) {
			throw new WorkflowPolicyError("unknown_quality_route_role", { qualityTier: tierKey, roles: unknownRoles });
		}
		const roleMap = {} as Record<WorkflowRole, readonly string[]>;
		for (const role of QUALITY_ROUTE_ROLES) {
			const rawIds = rawRoleMap[role];
			const optional = OPTIONAL_QUALITY_ROUTE_ROLES.includes(role);
			if (rawIds === undefined && optional) {
				roleMap[role] = [];
				continue;
			}
			if (
				!Array.isArray(rawIds) ||
				rawIds.length === 0 ||
				!rawIds.every(id => typeof id === "string" && id.length > 0)
			) {
				throw new WorkflowPolicyError("empty_or_invalid_quality_route_role", {
					qualityTier: tierKey,
					role,
				});
			}
			const ids = rawIds as string[];
			if (new Set(ids).size !== ids.length) {
				throw new WorkflowPolicyError("duplicate_quality_route_profile", { qualityTier: tierKey, role });
			}
			for (const profileId of ids) {
				const profile = profiles[profileId];
				if (!profile) {
					throw new WorkflowPolicyError("unknown_quality_route_profile", {
						qualityTier: tierKey,
						role,
						profileId,
					});
				}
				if (!profile.roles.includes(role)) {
					throw new WorkflowPolicyError("quality_route_profile_role_mismatch", {
						qualityTier: tierKey,
						role,
						profileId,
						profileRoles: profile.roles,
					});
				}
				if (profile.strictIdentity !== true) {
					throw new WorkflowPolicyError("quality_route_profile_not_strict", {
						qualityTier: tierKey,
						role,
						profileId,
					});
				}
			}
			roleMap[role] = [...ids];
		}
		routes[tierKey as WorkflowQualityTier] = roleMap;
	}
	return routes;
}

/** Build engine config fields from session `workflow.*` settings getters. */
export function buildWorkflowConfigFromSessionSettings(
	get: (key: string) => unknown,
): Partial<WorkflowDefaultConfig> & { profiles: Record<string, ModelProfile> } {
	const defaults = getDefaultConfig();
	const asBool = (key: string, fallback: boolean): boolean => {
		const value = get(key);
		return typeof value === "boolean" ? value : fallback;
	};
	const asNumber = (key: string, fallback: number): number => {
		const value = get(key);
		return typeof value === "number" && Number.isFinite(value) ? value : fallback;
	};
	const asStringArray = (key: string, fallback: string[]): string[] => {
		const value = get(key);
		return Array.isArray(value) && value.every(item => typeof item === "string") ? value : fallback;
	};
	const isolationRaw = get("workflow.isolationMerge");
	const isolationMerge: "patch" | "branch" =
		isolationRaw === "branch" || isolationRaw === "patch" ? isolationRaw : defaults.isolation.merge;
	const profiles = resolveWorkflowProfilesFromSettings(get("workflow.profiles"), defaults.profiles);
	const qualityRoutes = resolveWorkflowQualityRoutesFromSettings(get("workflow.qualityRoutes"), profiles);
	const tierRaw = get("workflow.defaultQualityTier");
	const defaultQualityTier: WorkflowQualityTier =
		tierRaw === "critical" || tierRaw === "balanced" ? tierRaw : defaults.defaultQualityTier;
	if (Object.keys(qualityRoutes).length > 0 && !qualityRoutes[defaultQualityTier]) {
		throw new WorkflowPolicyError("default_quality_tier_not_configured", { defaultQualityTier });
	}

	return {
		degradedMode: asBool("workflow.degradedMode", defaults.degradedMode),
		requireIndependentReview: asBool("workflow.requireIndependentReview", defaults.requireIndependentReview),
		maxBudgetUsd: asNumber("workflow.maxBudgetUsd", defaults.maxBudgetUsd),
		maxRepairCycles: asNumber("workflow.maxRepairCycles", defaults.maxRepairCycles),
		maxPlanCycles: asNumber("workflow.maxPlanCycles", defaults.maxPlanCycles),
		confidenceThreshold: asNumber("workflow.confidenceThreshold", defaults.confidenceThreshold),
		defaultQualityTier,
		qualityRoutes,
		isolation: { merge: isolationMerge, apply: defaults.isolation.apply },
		verificationTimeoutMs: asNumber("workflow.verificationTimeoutMs", defaults.verificationTimeoutMs),
		verificationCommands: asStringArray("workflow.verificationCommands", defaults.verificationCommands),
		profiles,
		presentationOptimizationEnabled: asBool(
			"workflow.presentationOptimization.enabled",
			defaults.presentationOptimizationEnabled,
		),
	};
}
