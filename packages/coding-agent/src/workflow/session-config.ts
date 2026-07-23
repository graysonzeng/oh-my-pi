import { getDefaultConfig, type WorkflowDefaultConfig } from "./default-config";
import { assertSupportedModelProfile } from "./model-profile-registry";
import type { ModelProfile } from "./types";

/**
 * Merge settings `workflow.profiles` over defaults.
 * Empty / missing / non-object values fall back to defaults unchanged.
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
		assertSupportedModelProfile(profile);
		merged[key] = profile;
	}
	return merged;
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

	return {
		degradedMode: asBool("workflow.degradedMode", defaults.degradedMode),
		requireIndependentReview: asBool("workflow.requireIndependentReview", defaults.requireIndependentReview),
		maxBudgetUsd: asNumber("workflow.maxBudgetUsd", defaults.maxBudgetUsd),
		maxRepairCycles: asNumber("workflow.maxRepairCycles", defaults.maxRepairCycles),
		maxPlanCycles: asNumber("workflow.maxPlanCycles", defaults.maxPlanCycles),
		confidenceThreshold: asNumber("workflow.confidenceThreshold", defaults.confidenceThreshold),
		isolation: { merge: isolationMerge, apply: defaults.isolation.apply },
		verificationTimeoutMs: asNumber("workflow.verificationTimeoutMs", defaults.verificationTimeoutMs),
		verificationCommands: asStringArray("workflow.verificationCommands", defaults.verificationCommands),
		profiles: resolveWorkflowProfilesFromSettings(get("workflow.profiles"), defaults.profiles),
	};
}
