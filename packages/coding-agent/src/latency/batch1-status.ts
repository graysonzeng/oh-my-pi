/**
 * Batch 1 delivery status honesty table.
 *
 * Separates code_complete / runtime_wired / mechanism_verified /
 * paired_evidence_ready. Never claim live cost wins from library tests alone.
 */
export type Batch1WorkPackageId = "W0" | "W1" | "W2" | "W3" | "W8";

export interface Batch1WorkPackageStatus {
	id: Batch1WorkPackageId;
	/** Library / API surface exists and compiles. */
	code_complete: boolean;
	/** Real production callers invoke the API (not test-only). */
	runtime_wired: boolean;
	/** Focused tests exercise the wired contract with fixtures. */
	mechanism_verified: boolean;
	/** Paid live paired evidence — Batch 1 always false. */
	paired_evidence_ready: false;
	/** Short note for PR / coordinator honesty. */
	note: string;
}

/**
 * Status after production-wiring PR + residual alignment.
 * Update only when call sites or evidence change.
 * paired_evidence_ready remains false for the whole batch.
 */
export const BATCH1_STATUS: readonly Batch1WorkPackageStatus[] = [
	{
		id: "W0",
		code_complete: true,
		runtime_wired: true,
		mechanism_verified: true,
		paired_evidence_ready: false,
		note: "Session init persists runtime_build_identity; no Mac omp binary replace",
	},
	{
		id: "W1",
		code_complete: true,
		runtime_wired: true,
		mechanism_verified: true,
		paired_evidence_ready: false,
		note: "Ordinary sink wired (/goal complete + extension appendEntry); multi-episode attribution + abandoned-branch filter locked by delivery-batch1-w1-w2-regressions; no live cost claims",
	},
	{
		id: "W2",
		code_complete: true,
		runtime_wired: true,
		mechanism_verified: true,
		paired_evidence_ready: false,
		note: "Parent consume reclassify+bind wired; terminal-required proven seal + forged path-only negatives covered by child-delivery-batch1-w2 + w1-w2-regressions + e4-host-terminal-checks; no live cost claims",
	},
	{
		id: "W3",
		code_complete: true,
		runtime_wired: true,
		mechanism_verified: true,
		paired_evidence_ready: false,
		note: "Durable observe wired; plan/start vs run/end + multi-round unique eventIds locked by evidence-handoff-observe-durable + workpool scope keys + delivery-batch1-w3-observe-regressions; no live cost claims",
	},
	{
		id: "W8",
		code_complete: true,
		runtime_wired: false,
		mechanism_verified: true,
		paired_evidence_ready: false,
		note: "Offline L0 fixtures only; no live paid pairs",
	},
] as const;

/** Batch 1 never claims paired live cost evidence. */
export const BATCH1_PAIRED_EVIDENCE_READY = false as const;

export function batch1Status(id: Batch1WorkPackageId): Batch1WorkPackageStatus {
	const found = BATCH1_STATUS.find(row => row.id === id);
	if (!found) throw new Error(`unknown_batch1_package:${id}`);
	return found;
}
