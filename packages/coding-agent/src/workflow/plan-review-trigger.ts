import type { PlanReviewArtifactV2, PlanReviewTriggerReasonV1 } from "./types";

/**
 * Engine-owned derivation of plan-review arbitration triggers.
 * Never trust model-emitted triggerReason; stamp this value instead.
 *
 * ponytail: no suspicious_pass heuristics; add when product defines pass-score signals.
 */
export function derivePlanReviewTrigger(
	review: PlanReviewArtifactV2,
): Exclude<PlanReviewTriggerReasonV1, null> | null {
	const statusesByRequirement = new Map<string, Set<string>>();
	for (const row of review.coverage) {
		let statuses = statusesByRequirement.get(row.requirementId);
		if (!statuses) {
			statuses = new Set();
			statusesByRequirement.set(row.requirementId, statuses);
		}
		statuses.add(row.status);
	}
	for (const statuses of statusesByRequirement.values()) {
		if (statuses.has("satisfied") && statuses.has("violated")) {
			return "contradiction";
		}
	}

	const satisfiedIds = new Set(
		review.coverage.filter(row => row.status === "satisfied").map(row => row.requirementId),
	);
	for (const finding of review.findings) {
		if (finding.status !== "open") continue;
		if (!(finding.blocking === true || finding.priority === "P0" || finding.priority === "P1")) continue;
		if (finding.requirementId && satisfiedIds.has(finding.requirementId)) {
			return "contradiction";
		}
	}

	return null;
}
