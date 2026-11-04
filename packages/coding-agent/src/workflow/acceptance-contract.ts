/**
 * Explicit acceptance-criterion mapping (Batch 1 F3).
 *
 * Command seals prove only criteria that bind them via verification=command-check
 * and evidenceRefs / verificationCommands — never an unbound free-for-all.
 */
import { fingerprintStable } from "../latency/stable-serialize";
import type { AcceptanceContractRef } from "../latency/task-episode";

export type AcceptanceVerificationKind = "command-check" | "review" | "manual";

export interface AcceptanceCriterionV1 {
	criterionId: string;
	description: string;
	verification: AcceptanceVerificationKind;
	evidenceRefs: string[];
}

/** Normalize plan-era string criteria into explicit mapped criteria (legacy → structured). */
export function normalizeAcceptanceCriteria(
	items: readonly string[] | readonly AcceptanceCriterionV1[],
): AcceptanceCriterionV1[] {
	const out: AcceptanceCriterionV1[] = [];
	for (const item of items) {
		if (typeof item === "string") {
			const description = item.trim();
			if (!description) continue;
			out.push({
				criterionId: description,
				description,
				verification: "manual",
				evidenceRefs: [],
			});
			continue;
		}
		const criterionId = item.criterionId.trim();
		const description = item.description.trim() || criterionId;
		if (!criterionId) continue;
		const verification: AcceptanceVerificationKind =
			item.verification === "command-check" || item.verification === "review" || item.verification === "manual"
				? item.verification
				: "manual";
		out.push({
			criterionId,
			description,
			verification,
			evidenceRefs: item.evidenceRefs.map(ref => ref.trim()).filter(Boolean),
		});
	}
	return out;
}

/** Build a contract ref that carries both legacy items and structured criteria. */
export function buildAcceptanceContractFromCriteria(
	criteria: readonly AcceptanceCriterionV1[],
): AcceptanceContractRef | null {
	const normalized = normalizeAcceptanceCriteria(criteria);
	if (normalized.length === 0) return null;
	const items = normalized.map(c => c.criterionId);
	return {
		items,
		fingerprint: fingerprintStable(normalized),
		criteria: normalized,
	};
}

/** Command-check criteria whose evidenceRefs / bound commands include `command`. */
export function criteriaBoundToCommand(
	criteria: readonly AcceptanceCriterionV1[],
	command: string,
	verificationCommands?: readonly string[],
): AcceptanceCriterionV1[] {
	const cmd = command.trim();
	if (!cmd) return [];
	const commandAllow = new Set((verificationCommands ?? []).map(c => c.trim()).filter(Boolean));
	return criteria.filter(criterion => {
		if (criterion.verification !== "command-check") return false;
		if (commandAllow.size > 0 && !commandAllow.has(cmd)) return false;
		// Explicit bind: criterion id/description is the command, or evidenceRefs lists it.
		if (criterion.criterionId === cmd || criterion.description === cmd) return true;
		return criterion.evidenceRefs.includes(cmd);
	});
}
