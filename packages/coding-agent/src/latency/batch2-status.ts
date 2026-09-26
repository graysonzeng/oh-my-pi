/**
 * Batch 2 delivery status honesty table (W4–W7).
 *
 * Separates code_complete / runtime_wired / mechanism_verified /
 * paired_evidence_ready. Never claim live cost wins from library tests alone.
 * paired_evidence_ready remains false for the whole batch (no paid live pairs).
 *
 * completed ≠ accepted: mechanisms may pass while 效果证据不足. Do not raise
 * any package to fully closed / paired_evidence_ready until residuals are honest.
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
 * Status after Batch 2 review-fix residuals. Update only when call sites or
 * evidence change. paired_evidence_ready remains false for the whole batch.
 */
export const BATCH2_STATUS: readonly Batch2WorkPackageStatus[] = [
	{
		id: "W4",
		code_complete: true,
		runtime_wired: true,
		mechanism_verified: true,
		paired_evidence_ready: false,
		note: "selectedRoute parse-owner revision for config env/!command (unobservable → fail-open); credentialRouteAuthScope wired; stream-stall thinking-loop fixtures retained but full side-effect durable reopen acceptance still residual; no live cost / 13.60min claim",
		call_sites: [
			"packages/ai/src/auth/cascade.ts#selectedRoute",
			"packages/ai/src/auth/cascade.ts#KeyOverrides.configParseRevision",
			"packages/coding-agent/src/latency/credential-route-unavailable.ts#credentialRouteAuthScope",
			"packages/coding-agent/src/session/turn-recovery.ts#credentialRouteScope",
			"packages/coding-agent/src/workflow/availability-preflight.ts#availabilityCredentialRouteScope",
			"packages/coding-agent/src/session/agent-session.ts (stream-stall/thinking-loop → TurnRecovery.handleRetryableError)",
		],
	},
	{
		id: "W5",
		code_complete: true,
		runtime_wired: false,
		mechanism_verified: true,
		paired_evidence_ready: false,
		note: "NOT fully request-wired: observe remains at prepare/assembly (not provider-final serialize); toolSchemaFingerprint is presentation-mode best-effort not full send schema; scope often unknown; reorder_static_prefix refuses applied when treatment===control; A/B/S2 single-factor mutex at entrypoints; claimedLiveWin false; no auto warmup/paid traffic",
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
		note: "requireArtifact on phase rewrite (save failure keeps original); failed rewrite leaves boundary pending; boundaryKey includes durable entry id; refuses A/B cross-experiment; claimedLiveWin false; no paired cost wins",
		call_sites: [
			"packages/coding-agent/src/session/phase-handoff-carry.ts#buildPhaseHandoffCarriedFromBranch",
			"packages/coding-agent/src/session/phase-handoff-carry.ts#resolvePhaseHandoffBoundaryObservation",
			"packages/coding-agent/src/session/session-maintenance.ts#applyPhaseHandoffAtMaintenanceBoundary",
			"packages/coding-agent/src/session/session-maintenance.ts#checkCompaction",
			"packages/coding-agent/src/session/session-maintenance.ts#shake(elide)",
		],
	},
	{
		id: "W7",
		code_complete: true,
		runtime_wired: true,
		mechanism_verified: true,
		paired_evidence_ready: false,
		note: "Experiment A selection layer over ordinary read-dedupe arm; >8MiB in-memory artifacts spill to temp file so line-range recover works; S3 pagination replay fixtures retained; reuse≠toolCall drop claim; no second cache table",
		call_sites: [
			"packages/coding-agent/src/latency/read-dedupe-selection.ts#selectReadDedupeReuse",
			"packages/coding-agent/src/session/agent-session.ts#dedupeOrdinaryReadResult",
			"packages/coding-agent/src/tools/read.ts (composeReadPaginationArgs)",
			"packages/coding-agent/src/internal-urls/artifact-protocol.ts#locate (spill oversized in-memory)",
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
