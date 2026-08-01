import type { ModelRouter } from "./model-router";
import type { AvailabilityRequirement, ModelProfile, WorkflowRole, WorkflowStatus } from "./types";

/** Stable role order for reports (registration order within each role is preserved separately). */
export const AVAILABILITY_ROLE_ORDER: readonly WorkflowRole[] = [
	"planner",
	"plan_reviewer",
	"implementer",
	"code_reviewer",
	"repair",
] as const;

export interface AvailabilityRoleSpec {
	role: WorkflowRole;
	requirement: AvailabilityRequirement;
}

export interface AvailabilityCandidate {
	role: WorkflowRole;
	requirement: AvailabilityRequirement;
	profile: ModelProfile;
}

/**
 * Single-flight key for physical probes within one preflight invocation.
 * Same embedded runtime + model pattern + auth-scope collapses to one live call.
 */
export function availabilityProbeDedupeKey(profile: ModelProfile, authScope = "default"): string {
	const model = Array.isArray(profile.modelPattern) ? profile.modelPattern.join(",") : String(profile.modelPattern);
	const effort = profile.thinkingLevel ?? "none";
	return `embedded|${model}|${effort}|strict:${profile.strictIdentity === true}|${authScope}`;
}

/**
 * Roles that may invoke a model for the current stage (singleStep=true).
 * Deterministic verify / pure status transitions return empty (not_required).
 */
export function modelRolesForCurrentStep(status: WorkflowStatus): AvailabilityRoleSpec[] {
	switch (status) {
		case "planning":
			return [{ role: "planner", requirement: "required" }];
		case "plan_review":
			return [{ role: "plan_reviewer", requirement: "required" }];
		case "implementing":
			return [{ role: "implementer", requirement: "required" }];
		case "code_review":
			return [{ role: "code_reviewer", requirement: "required" }];
		case "repairing":
			return [{ role: "repair", requirement: "required" }];
		default:
			// created → planning transition, verify stages, terminal
			return [];
	}
}

/**
 * Reachable model roles from the current status for a full (non-singleStep) run.
 * required = happy-path success route; conditional = review changes / repair / re-plan loops.
 */
export function reachableModelRoles(status: WorkflowStatus): AvailabilityRoleSpec[] {
	switch (status) {
		case "created":
		case "planning":
			return [
				{ role: "planner", requirement: "required" },
				{ role: "plan_reviewer", requirement: "required" },
				{ role: "implementer", requirement: "required" },
				{ role: "code_reviewer", requirement: "required" },
				{ role: "repair", requirement: "conditional" },
			];
		case "plan_review":
			return [
				{ role: "plan_reviewer", requirement: "required" },
				{ role: "implementer", requirement: "required" },
				{ role: "code_reviewer", requirement: "required" },
				{ role: "planner", requirement: "conditional" },
				{ role: "repair", requirement: "conditional" },
			];
		case "implementing":
			return [
				{ role: "implementer", requirement: "required" },
				{ role: "code_reviewer", requirement: "required" },
				{ role: "repair", requirement: "conditional" },
			];
		case "implementation_verify":
			return [
				{ role: "code_reviewer", requirement: "required" },
				{ role: "repair", requirement: "conditional" },
			];
		case "code_review":
			return [
				{ role: "code_reviewer", requirement: "required" },
				{ role: "repair", requirement: "conditional" },
			];
		case "repairing":
			return [
				{ role: "repair", requirement: "required" },
				{ role: "code_reviewer", requirement: "required" },
			];
		case "final_verify":
			return [{ role: "repair", requirement: "conditional" }];
		default:
			return [];
	}
}

/** Role specs for this preflight scope (independent of whether profiles are registered). */
export function resolveAvailabilityRoleSpecs(status: WorkflowStatus, singleStep: boolean): AvailabilityRoleSpec[] {
	return singleStep ? modelRolesForCurrentStep(status) : reachableModelRoles(status);
}

/**
 * Build preflight candidates from the engine ModelRouter registry.
 * Includes every registered profile that claims the role (primary + fallbacks).
 * Roles with zero matching profiles are NOT listed here — callers must still
 * fail-closed on required roles from {@link resolveAvailabilityRoleSpecs}.
 */
export function buildAvailabilityCandidates(options: {
	router: ModelRouter;
	status: WorkflowStatus;
	singleStep: boolean;
	/** Optional precomputed role specs (avoids re-resolving). */
	roleSpecs?: AvailabilityRoleSpec[];
}): AvailabilityCandidate[] {
	const roleSpecs = options.roleSpecs ?? resolveAvailabilityRoleSpecs(options.status, options.singleStep);

	const profiles = options.router.list();
	const out: AvailabilityCandidate[] = [];

	for (const spec of roleSpecs) {
		for (const profile of profiles) {
			if (!profile.roles.includes(spec.role)) continue;
			out.push({
				role: spec.role,
				requirement: spec.requirement,
				profile,
			});
		}
	}

	return out;
}

/** Roles from roleSpecs that have zero matching profiles in the candidate list. */
export function rolesMissingProfiles(
	roleSpecs: readonly AvailabilityRoleSpec[],
	candidates: readonly AvailabilityCandidate[],
): AvailabilityRoleSpec[] {
	const present = new Set(candidates.map(c => c.role));
	return roleSpecs.filter(spec => !present.has(spec.role));
}

/** Stable sort: role order, then profile registration order within the router list. */
export function sortAvailabilityCandidates(
	candidates: AvailabilityCandidate[],
	registrationOrder: readonly string[],
): AvailabilityCandidate[] {
	const profileIndex = new Map(registrationOrder.map((id, i) => [id, i]));
	const roleIndex = new Map(AVAILABILITY_ROLE_ORDER.map((role, i) => [role, i]));
	return [...candidates].sort((a, b) => {
		const roleDelta = (roleIndex.get(a.role) ?? 99) - (roleIndex.get(b.role) ?? 99);
		if (roleDelta !== 0) return roleDelta;
		return (profileIndex.get(a.profile.id) ?? 99) - (profileIndex.get(b.profile.id) ?? 99);
	});
}
