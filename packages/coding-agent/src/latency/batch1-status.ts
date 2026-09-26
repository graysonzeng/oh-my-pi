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
 * Status after production-wiring PR. Update only when call sites or evidence change.
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
		mechanism_verified: false,
		paired_evidence_ready: false,
		note: "Ordinary sink wired (/goal complete + extension appendEntry); gaps: multi-episode production path + abandoned-branch filter not fully mechanism-verified",
	},
	{
		id: "W2",
		code_complete: true,
		runtime_wired: true,
		mechanism_verified: false,
		paired_evidence_ready: false,
		note: "Parent consume reclassify+bind wired; gaps: terminal-required proven seal + forged path-only negatives need broader fixture coverage",
	},
	{
		id: "W3",
		code_complete: true,
		runtime_wired: true,
		mechanism_verified: false,
		paired_evidence_ready: false,
		note: "Durable observe wired; gaps: plan/start vs run/end + unique multi-round eventIds need production-path regression lock-in",
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
