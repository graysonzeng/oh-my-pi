/**
 * D1 acceptance coverage matrix — visibility of *why* coverage is missing.
 *
 * Reuses existing parent-final receipts and child delivery evidence. Does not
 * invent a second evidence schema. "Fields exist" is never treated as
 * production coverage complete: every unknown cell carries an explicit reason.
 */
import type { ParentIntegrateDecision } from "../task/child-delivery-evidence";
import type { ParentFinalVerificationObservation } from "./parent-final-verification";
import { episodeKey, type AcceptanceAuthority } from "./task-episode";

/** Stable reason codes for missing / incomplete acceptance coverage. */
export type MissingCoverageReasonCode =
	| "no_parent_final_receipt"
	| "receipt_lacks_authority"
	| "missing_authority"
	| "legacy_compat"
	| "fixture_authority_excluded"
	| "acceptance_contract_missing"
	| "code_state_missing"
	| "evidence_refs_missing"
	| "episode_linkage_missing"
	| "receipt_failed"
	| "child_unproven"
	| "pending_parent_integrate"
	| "stale_or_scope_unknown"
	| "candidate_not_user_confirmed"
	| "price_unknown"
	| "unknown_receipt_version";

export type CoverageCellStatus = "covered" | "missing" | "incomplete" | "excluded" | "pending";

export interface AcceptanceCoverageCell {
	/** Episode key when known; otherwise a stable row id (path hash / session stem). */
	rowId: string;
	episodeKey: string | null;
	/** Acceptance item id, signal name, or "*" for whole-task verdict. */
	itemId: string;
	status: CoverageCellStatus;
	/** Empty when status is covered; otherwise at least one reason. */
	reasons: MissingCoverageReasonCode[];
	/** Human-readable detail for operators (not prompt material). */
	detail?: string;
}

export interface AcceptanceCoverageMatrix {
	/** Schema version for offline reports / Hub projections. */
	v: 1;
	/** When true, fixture-authority rows are counted as excluded, not covered. */
	excludeFixtureAuthority: boolean;
	cells: AcceptanceCoverageCell[];
	summary: {
		covered: number;
		missing: number;
		incomplete: number;
		excluded: number;
		pending: number;
		/** Distinct reason codes present in the matrix. */
		reasonCounts: Partial<Record<MissingCoverageReasonCode, number>>;
	};
}

export interface ClassifyParentFinalCoverageInput {
	rowId: string;
	observation: ParentFinalVerificationObservation | null | undefined;
	/** Production stats exclude fixture authority by default. */
	excludeFixtureAuthority?: boolean;
	/** Optional current workspace fingerprint — mismatch ⇒ stale. */
	currentCodeFingerprint?: string | null;
	/** Goal/UI candidate without user_confirmed. */
	candidateComplete?: boolean;
	/** Episode key when observation is missing but the episode exists in the universe. */
	episodeKeyHint?: string | null;
}

export interface ClassifyChildIntegrateCoverageInput {
	rowId: string;
	episodeKey?: string | null;
	decision: ParentIntegrateDecision | null | undefined;
}

function emptySummary(): AcceptanceCoverageMatrix["summary"] {
	return { covered: 0, missing: 0, incomplete: 0, excluded: 0, pending: 0, reasonCounts: {} };
}

function bumpReason(
	counts: Partial<Record<MissingCoverageReasonCode, number>>,
	reason: MissingCoverageReasonCode,
): void {
	counts[reason] = (counts[reason] ?? 0) + 1;
}

function summarize(cells: readonly AcceptanceCoverageCell[]): AcceptanceCoverageMatrix["summary"] {
	const summary = emptySummary();
	for (const cell of cells) {
		summary[cell.status]++;
		for (const reason of cell.reasons) bumpReason(summary.reasonCounts, reason);
	}
	return summary;
}

function episodeFromObservation(obs: ParentFinalVerificationObservation): string | null {
	const episode = obs.attempt?.episode;
	return episode ? episodeKey(episode) : null;
}

function isTrustedProductionAuthority(authority: AcceptanceAuthority | undefined): boolean {
	return (
		authority === "trusted_verifier" ||
		authority === "user_explicit" ||
		authority === "extension" ||
		authority === "workflow"
	);
}

/** True when any (or default) criterion still requires a code fingerprint bind. */
function contractRequiresCodeFingerprint(obs: ParentFinalVerificationObservation): boolean {
	const criteria = obs.acceptanceContract?.criteria;
	if (!criteria || criteria.length === 0) return true;
	return criteria.some(c => c.verification === "command-check");
}

/**
 * Classify one parent-final receipt into coverage cell(s).
 * Missing receipt ⇒ one missing cell with `no_parent_final_receipt`.
 * Presence of fields alone never yields `covered` without trusted authority + passed status.
 * Legacy pre-v1 (authority+v both absent) is labeled `legacy_compat` — never covered.
 * Review/manual-only criteria do not force a code fingerprint obligation.
 */
export function classifyParentFinalCoverage(input: ClassifyParentFinalCoverageInput): AcceptanceCoverageCell[] {
	const excludeFixture = input.excludeFixtureAuthority !== false;
	const obs = input.observation;

	if (input.candidateComplete === true) {
		const ep = obs ? episodeFromObservation(obs) : (input.episodeKeyHint ?? null);
		return [
			{
				rowId: input.rowId,
				episodeKey: ep,
				itemId: "*",
				status: "pending",
				reasons: ["candidate_not_user_confirmed"],
				detail: "candidate_complete is advisory — not accepted until user_confirmed",
			},
		];
	}

	if (!obs) {
		return [
			{
				rowId: input.rowId,
				episodeKey: input.episodeKeyHint ?? null,
				itemId: "*",
				status: "missing",
				reasons: ["no_parent_final_receipt"],
				detail: "No parent_final_verification receipt — session stop / tool exit 0 is not acceptance",
			},
		];
	}

	const ep = episodeFromObservation(obs) ?? input.episodeKeyHint ?? null;

	const sharedReasons: MissingCoverageReasonCode[] = [];

	if (obs.status === "failed") {
		sharedReasons.push("receipt_failed");
	}

	// Unknown / future schema versions must never count as covered.
	if (obs.v !== undefined && obs.v !== 1) {
		sharedReasons.push("unknown_receipt_version");
	}

	if (obs.authority === undefined && obs.v === undefined) {
		sharedReasons.push("legacy_compat");
	} else if (obs.authority === undefined) {
		sharedReasons.push("missing_authority");
	} else if (obs.authority === "fixture" && excludeFixture) {
		sharedReasons.push("fixture_authority_excluded");
	} else if (!isTrustedProductionAuthority(obs.authority) && obs.authority !== "fixture") {
		sharedReasons.push("receipt_lacks_authority");
	}

	if (!obs.acceptanceContract || obs.acceptanceContract.items.length === 0) {
		sharedReasons.push("acceptance_contract_missing");
	}
	if (!obs.evidenceRefs || obs.evidenceRefs.length === 0) {
		sharedReasons.push("evidence_refs_missing");
	}
	if (!obs.attempt?.episode) {
		sharedReasons.push("episode_linkage_missing");
	}

	const criteria = obs.acceptanceContract?.criteria;
	const items: Array<{ itemId: string; needsCodeFingerprint: boolean }> =
		criteria && criteria.length > 0
			? criteria.map(c => ({
					itemId: c.criterionId,
					needsCodeFingerprint: c.verification === "command-check",
				}))
			: obs.acceptanceContract && obs.acceptanceContract.items.length > 0
				? obs.acceptanceContract.items.map(itemId => ({
						itemId,
						needsCodeFingerprint: true,
					}))
				: [{ itemId: "*", needsCodeFingerprint: contractRequiresCodeFingerprint(obs) }];

	const trustOk = isTrustedProductionAuthority(obs.authority) || (obs.authority === "fixture" && !excludeFixture);
	const passedTrusted = obs.status === "passed" && trustOk;

	const cells: AcceptanceCoverageCell[] = [];
	for (const item of items) {
		const reasons = [...sharedReasons];
		if (item.needsCodeFingerprint && !obs.codeState?.fingerprint) {
			reasons.push("code_state_missing");
		}
		if (
			item.needsCodeFingerprint &&
			input.currentCodeFingerprint &&
			obs.codeState?.fingerprint &&
			input.currentCodeFingerprint !== obs.codeState.fingerprint
		) {
			reasons.push("stale_or_scope_unknown");
		}

		if (passedTrusted && reasons.length === 0) {
			cells.push({
				rowId: input.rowId,
				episodeKey: ep,
				itemId: item.itemId,
				status: "covered",
				reasons: [],
			});
			continue;
		}

		let status: CoverageCellStatus = "incomplete";
		if (reasons.includes("fixture_authority_excluded") && reasons.length === 1) {
			status = "excluded";
		} else if (reasons.includes("receipt_failed")) {
			status = "incomplete";
		} else if (
			!passedTrusted &&
			(reasons.includes("receipt_lacks_authority") ||
				reasons.includes("missing_authority") ||
				reasons.includes("legacy_compat"))
		) {
			status = "incomplete";
		}

		cells.push({
			rowId: input.rowId,
			episodeKey: ep,
			itemId: item.itemId,
			status,
			reasons,
			detail:
				status === "excluded"
					? "fixture authority excluded from production coverage"
					: "Evidence incomplete — do not treat as accepted",
		});
	}
	return cells;
}

/** Map child→parent integrate decision into coverage visibility (done_valid ≠ accepted). */
export function classifyChildIntegrateCoverage(input: ClassifyChildIntegrateCoverageInput): AcceptanceCoverageCell {
	const decision = input.decision;
	if (!decision) {
		return {
			rowId: input.rowId,
			episodeKey: input.episodeKey ?? null,
			itemId: "*",
			status: "missing",
			reasons: ["no_parent_final_receipt"],
			detail: "No child delivery / integrate decision",
		};
	}

	switch (decision.classification) {
		case "done_valid":
			return {
				rowId: input.rowId,
				episodeKey: input.episodeKey ?? null,
				itemId: "*",
				status: "pending",
				reasons: ["pending_parent_integrate"],
				detail: "done_valid means integrate-eligible — not parent accepted",
			};
		case "missing_local_evidence":
			return {
				rowId: input.rowId,
				episodeKey: input.episodeKey ?? null,
				itemId: "*",
				status: "incomplete",
				reasons: ["child_unproven"],
				detail: decision.reasons.join("; ") || "child evidence unproven",
			};
		case "cross_module":
		case "parent_verification_required":
			return {
				rowId: input.rowId,
				episodeKey: input.episodeKey ?? null,
				itemId: "*",
				status: "pending",
				reasons: ["pending_parent_integrate"],
				detail: decision.classification,
			};
		case "stale_context":
		case "scope_unknown":
			return {
				rowId: input.rowId,
				episodeKey: input.episodeKey ?? null,
				itemId: "*",
				status: "incomplete",
				reasons: ["stale_or_scope_unknown"],
				detail: decision.classification,
			};
	}
}

export function buildAcceptanceCoverageMatrix(
	cells: readonly AcceptanceCoverageCell[],
	options?: { excludeFixtureAuthority?: boolean },
): AcceptanceCoverageMatrix {
	return {
		v: 1,
		excludeFixtureAuthority: options?.excludeFixtureAuthority !== false,
		cells: [...cells],
		summary: summarize(cells),
	};
}

export function formatAcceptanceCoverageMatrix(matrix: AcceptanceCoverageMatrix): string {
	const lines = [
		"acceptance coverage matrix (D1)",
		`excludeFixtureAuthority=${matrix.excludeFixtureAuthority}`,
		`summary: covered=${matrix.summary.covered} missing=${matrix.summary.missing} incomplete=${matrix.summary.incomplete} excluded=${matrix.summary.excluded} pending=${matrix.summary.pending}`,
		"reasonCounts:",
		...Object.entries(matrix.summary.reasonCounts)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([code, n]) => `  ${code}=${n}`),
		"cells:",
		...matrix.cells.map(
			cell =>
				`  ${cell.rowId} item=${cell.itemId} status=${cell.status} reasons=[${cell.reasons.join(",")}]` +
				(cell.detail ? ` // ${cell.detail}` : ""),
		),
	];
	return lines.join("\n");
}
