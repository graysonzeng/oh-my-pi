/**
 * Batch 2 delivery status honesty table (W4–W7).
 *
 * Separates code_complete / runtime_wired / mechanism_verified /
 * paired_evidence_ready. Never claim live cost wins from library tests alone.
 * paired_evidence_ready remains false for the whole batch (no paid live pairs).
 */
export type Batch2WorkPackageId = "W4" | "W5" | "W6" | "W7";

export interface Batch2WorkPackageStatus {
	id: Batch2WorkPackageId;
	/** Library / API surface exists and compiles. */
	code_complete: boolean;
	/** Real production callers invoke the API (not test-only). */
	runtime_wired: boolean;
	/** Focused tests exercise the wired contract with fixtures. */
	mechanism_verified: boolean;
	/** Paid live paired evidence — Batch 2 always false. */
	paired_evidence_ready: false;
	/** Short note for PR / coordinator honesty. */
	note: string;
	/** Call-site anchors claimed for runtime_wired (src/ paths). */
	call_sites: readonly string[];
}

/**
 * Status after Batch 2 wiring. Update only when call sites or evidence change.
 * paired_evidence_ready remains false for the whole batch.
 */
export const BATCH2_STATUS: readonly Batch2WorkPackageStatus[] = [
	{
		id: "W4",
		code_complete: true,
		runtime_wired: true,
		mechanism_verified: true,
		paired_evidence_ready: false,
		note: "selectedRoute identity+revision in KeysApi; credentialRouteAuthScope uses it; AgentSession/TurnRecovery stream-stall+thinking-loop paths retained; no 13.60min savings claim",
		call_sites: [
			"packages/ai/src/auth/cascade.ts#selectedRoute",
			"packages/coding-agent/src/latency/credential-route-unavailable.ts#credentialRouteAuthScope",
			"packages/coding-agent/src/session/turn-recovery.ts#credentialRouteScope",
			"packages/coding-agent/src/workflow/availability-preflight.ts#availabilityCredentialRouteScope",
			"packages/coding-agent/src/session/agent-session.ts (stream-stall/thinking-loop → TurnRecovery.handleRetryableError)",
		],
	},
	{
		id: "W5",
		code_complete: true,
		runtime_wired: true,
		mechanism_verified: true,
		paired_evidence_ready: false,
		note: "prepareWorkflowInvocation observes (+ optional reorder) at assembly boundary; claimedLiveWin stays false; no auto warmup/paid traffic",
		call_sites: [
			"packages/coding-agent/src/latency/stable-prefix-assembly-bridge.ts#observeStablePrefixAtAssembly",
			"packages/coding-agent/src/workflow/runtime-invocation.ts#prepareWorkflowInvocation",
		],
	},
	{
		id: "W6",
		code_complete: true,
		runtime_wired: true,
		mechanism_verified: true,
		paired_evidence_ready: false,
		note: "SessionMaintenance.checkCompaction shadows phase-handoff when flag on; treatment via observePhaseHandoffBoundary + existing compaction owner; off = unchanged",
		call_sites: [
			"packages/coding-agent/src/session/phase-handoff-maintenance.ts#runPhaseHandoffMaintenance",
			"packages/coding-agent/src/session/session-maintenance.ts#observePhaseHandoffBoundary",
			"packages/coding-agent/src/session/session-maintenance.ts#checkCompaction",
		],
	},
	{
		id: "W7",
		code_complete: true,
		runtime_wired: true,
		mechanism_verified: true,
		paired_evidence_ready: false,
		note: "Experiment A selection layer over ordinary read-dedupe arm (no second cache); S3 pagination replay fixtures retained; reuse≠toolCall drop claim",
		call_sites: [
			"packages/coding-agent/src/latency/read-dedupe-selection.ts#selectReadDedupeReuse",
			"packages/coding-agent/src/session/agent-session.ts#dedupeOrdinaryReadResult",
			"packages/coding-agent/src/tools/read.ts (composeReadPaginationArgs)",
		],
	},
] as const;

/** Batch 2 never claims paired live cost evidence. */
export const BATCH2_PAIRED_EVIDENCE_READY = false as const;

export function batch2Status(id: Batch2WorkPackageId): Batch2WorkPackageStatus {
	const found = BATCH2_STATUS.find(row => row.id === id);
	if (!found) throw new Error(`unknown_batch2_package:${id}`);
	return found;
}
