/**
 * Observation helpers for evidence-handoff generate → consume → reject-stale
 * (history supplement S1) plus Batch 1 W3 durable lifecycle summaries.
 *
 * Process-local counters remain for in-process tests. Durable records use the
 * existing session `custom` entry channel (one dedupe+persist owner) — small
 * summaries at lifecycle boundaries only; no per-token spam; no new model calls.
 *
 * Package 1 `costPerAcceptedTask` remains uncomputable until explicit
 * `parent_final_verification` receipts exist; this module does not invent
 * acceptance from tool success or process exit. Worker green ≠ final accept.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import type { WorkerReuseDecision } from "./evidence-handoff";

export const EVIDENCE_HANDOFF_OBSERVE_CUSTOM_TYPE = "evidence_handoff_observe";
export const EVIDENCE_HANDOFF_OBSERVE_VERSION = 1 as const;

export type EvidenceHandoffObservePhase =
	| "generate"
	| "inspect"
	| "reject_stale"
	| "reuse"
	| "child_settled"
	| "parent_consumed"
	| "verify_run"
	| "verify_reuse"
	| "verify_reject"
	| "management_overhead";

export interface EvidenceHandoffObserveSnapshot {
	generate: number;
	consumeValid: number;
	consumeMissing: number;
	rejectStale: number;
	rejectInvalid: number;
	reuseContinue: number;
	reuseSpawnFresh: number;
	childSettled: number;
	parentConsumed: number;
	verifyRun: number;
	verifyReuse: number;
	verifyReject: number;
	managementOverheadMs: number;
}

export interface EvidenceHandoffObserveRecord {
	kind: typeof EVIDENCE_HANDOFF_OBSERVE_CUSTOM_TYPE;
	v: typeof EVIDENCE_HANDOFF_OBSERVE_VERSION;
	/** Idempotent event id — duplicate persists must not double-count. */
	eventId: string;
	phase: EvidenceHandoffObservePhase;
	ts: number;
	episodeKey?: string;
	jobId?: string;
	agentId?: string;
	receiptEventId?: string;
	reason?: string;
	/** Management / observe overhead ms for this boundary (never a model call). */
	overheadMs?: number;
	details?: Record<string, unknown>;
}

export interface EvidenceHandoffObservePersistSink {
	appendCustomEntry(customType: string, data?: unknown): string;
}

const emptySnapshot = (): EvidenceHandoffObserveSnapshot => ({
	generate: 0,
	consumeValid: 0,
	consumeMissing: 0,
	rejectStale: 0,
	rejectInvalid: 0,
	reuseContinue: 0,
	reuseSpawnFresh: 0,
	childSettled: 0,
	parentConsumed: 0,
	verifyRun: 0,
	verifyReuse: 0,
	verifyReject: 0,
	managementOverheadMs: 0,
});

let snapshot = emptySnapshot();
/** In-process dedupe of durable event ids (also enforced when replaying records). */
const seenEventIds = new Set<string>();

/** Process-local observe counters (tests reset via {@link resetEvidenceHandoffObserveForTests}). */
export function getEvidenceHandoffObserveSnapshot(): EvidenceHandoffObserveSnapshot {
	return { ...snapshot };
}

export function resetEvidenceHandoffObserveForTests(): void {
	snapshot = emptySnapshot();
	seenEventIds.clear();
}

function applyPhaseToSnapshot(
	phase: EvidenceHandoffObservePhase,
	meta?: { reason?: string; overheadMs?: number },
): void {
	switch (phase) {
		case "generate":
			snapshot.generate += 1;
			break;
		case "inspect":
			break;
		case "reject_stale":
			snapshot.rejectStale += 1;
			break;
		case "reuse":
			break;
		case "child_settled":
			snapshot.childSettled += 1;
			break;
		case "parent_consumed":
			snapshot.parentConsumed += 1;
			break;
		case "verify_run":
			snapshot.verifyRun += 1;
			break;
		case "verify_reuse":
			snapshot.verifyReuse += 1;
			break;
		case "verify_reject":
			snapshot.verifyReject += 1;
			break;
		case "management_overhead":
			if (typeof meta?.overheadMs === "number" && Number.isFinite(meta.overheadMs) && meta.overheadMs > 0) {
				snapshot.managementOverheadMs += meta.overheadMs;
			}
			break;
	}
}

export function noteEvidenceHandoffGenerate(meta?: { agentId?: string; synthesized?: boolean }): void {
	snapshot.generate += 1;
	logger.debug("evidence-handoff: generate", {
		synthesized: meta?.synthesized === true,
		agentId: meta?.agentId,
	});
}

export function noteEvidenceHandoffInspect(kind: "valid" | "missing" | "invalid"): void {
	if (kind === "valid") snapshot.consumeValid += 1;
	else if (kind === "missing") snapshot.consumeMissing += 1;
	else snapshot.rejectInvalid += 1;
	logger.debug("evidence-handoff: inspect", { kind });
}

/**
 * Record a worker-reuse decision. Stale reasons increment `rejectStale` here
 * (inspect only sees parse validity). Invalid handoffs are counted only by
 * {@link noteEvidenceHandoffInspect} so the live workpool path does not
 * double-count `rejectInvalid`.
 */
export function noteEvidenceHandoffReuseDecision(decision: WorkerReuseDecision, meta?: { agentId?: string }): void {
	if (decision.action === "continue") snapshot.reuseContinue += 1;
	else snapshot.reuseSpawnFresh += 1;
	if (decision.reason === "stale_evidence") snapshot.rejectStale += 1;
	logger.debug("workpool: evidence-handoff reuse", {
		action: decision.action,
		reason: decision.reason,
		agentId: meta?.agentId ?? decision.agentId,
	});
}

/**
 * Observe-only signal: a generate + valid continue path is present, so a parent
 * that trusts confirmed facts can avoid an unnecessary full re-read. Never used
 * as an acceptance or cost metric.
 */
export function observeImpliesFewerUnnecessaryRereads(snapshotValue: EvidenceHandoffObserveSnapshot): boolean {
	return snapshotValue.generate > 0 && snapshotValue.consumeValid > 0 && snapshotValue.reuseContinue > 0;
}

export function buildEvidenceHandoffObserveRecord(
	input: Omit<EvidenceHandoffObserveRecord, "kind" | "v">,
): EvidenceHandoffObserveRecord {
	const eventId = input.eventId.trim();
	if (!eventId) throw new Error("evidence_handoff_observe_missing_event_id");
	return {
		kind: EVIDENCE_HANDOFF_OBSERVE_CUSTOM_TYPE,
		v: EVIDENCE_HANDOFF_OBSERVE_VERSION,
		eventId,
		phase: input.phase,
		ts: input.ts,
		...(input.episodeKey ? { episodeKey: input.episodeKey } : {}),
		...(input.jobId ? { jobId: input.jobId } : {}),
		...(input.agentId ? { agentId: input.agentId } : {}),
		...(input.receiptEventId ? { receiptEventId: input.receiptEventId } : {}),
		...(input.reason ? { reason: input.reason } : {}),
		...(typeof input.overheadMs === "number" ? { overheadMs: input.overheadMs } : {}),
		...(input.details ? { details: input.details } : {}),
	};
}

export function parseEvidenceHandoffObserveRecord(value: unknown): EvidenceHandoffObserveRecord | null {
	if (!isRecord(value)) return null;
	if (value.kind !== EVIDENCE_HANDOFF_OBSERVE_CUSTOM_TYPE || value.v !== EVIDENCE_HANDOFF_OBSERVE_VERSION) {
		return null;
	}
	if (typeof value.eventId !== "string" || !value.eventId.trim()) return null;
	if (typeof value.phase !== "string" || !value.phase.trim()) return null;
	if (typeof value.ts !== "number" || !Number.isFinite(value.ts)) return null;
	try {
		return buildEvidenceHandoffObserveRecord({
			eventId: value.eventId,
			phase: value.phase as EvidenceHandoffObservePhase,
			ts: value.ts,
			episodeKey: typeof value.episodeKey === "string" ? value.episodeKey : undefined,
			jobId: typeof value.jobId === "string" ? value.jobId : undefined,
			agentId: typeof value.agentId === "string" ? value.agentId : undefined,
			receiptEventId: typeof value.receiptEventId === "string" ? value.receiptEventId : undefined,
			reason: typeof value.reason === "string" ? value.reason : undefined,
			overheadMs: typeof value.overheadMs === "number" ? value.overheadMs : undefined,
			details: isRecord(value.details) ? value.details : undefined,
		});
	} catch {
		return null;
	}
}

/**
 * Single owner for durable observe persist+dedupe. Duplicate eventId is a no-op
 * (in-memory and when replaying). Write failures are logged and rethrown so
 * callers cannot treat a failed persist as observed.
 */
export function persistEvidenceHandoffObserve(
	sink: EvidenceHandoffObservePersistSink,
	record: EvidenceHandoffObserveRecord,
): { persisted: boolean; entryId?: string } {
	const normalized = parseEvidenceHandoffObserveRecord(record);
	if (!normalized) throw new Error("evidence_handoff_observe_invalid_record");
	if (seenEventIds.has(normalized.eventId)) {
		return { persisted: false };
	}
	seenEventIds.add(normalized.eventId);
	applyPhaseToSnapshot(normalized.phase, {
		reason: normalized.reason,
		overheadMs: normalized.overheadMs,
	});
	try {
		const entryId = sink.appendCustomEntry(EVIDENCE_HANDOFF_OBSERVE_CUSTOM_TYPE, normalized);
		logger.debug("evidence-handoff: persist observe", {
			phase: normalized.phase,
			eventId: normalized.eventId,
			reason: normalized.reason,
		});
		return { persisted: true, entryId };
	} catch (error) {
		seenEventIds.delete(normalized.eventId);
		logger.warn("evidence-handoff: observe persist failed", {
			eventId: normalized.eventId,
			phase: normalized.phase,
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}

/** Recompute an in-memory snapshot from durable records (restart-safe). */
export function recomputeEvidenceHandoffObserveSnapshot(
	records: readonly EvidenceHandoffObserveRecord[],
): EvidenceHandoffObserveSnapshot {
	const out = emptySnapshot();
	const seen = new Set<string>();
	for (const raw of records) {
		const record = parseEvidenceHandoffObserveRecord(raw);
		if (!record) continue;
		if (seen.has(record.eventId)) continue;
		seen.add(record.eventId);
		switch (record.phase) {
			case "generate":
				out.generate += 1;
				break;
			case "inspect":
				if (record.reason === "valid") out.consumeValid += 1;
				else if (record.reason === "missing") out.consumeMissing += 1;
				else if (record.reason === "invalid") out.rejectInvalid += 1;
				break;
			case "reject_stale":
				out.rejectStale += 1;
				break;
			case "reuse":
				if (record.reason === "continue") out.reuseContinue += 1;
				else out.reuseSpawnFresh += 1;
				break;
			case "child_settled":
				out.childSettled += 1;
				break;
			case "parent_consumed":
				out.parentConsumed += 1;
				break;
			case "verify_run":
				out.verifyRun += 1;
				break;
			case "verify_reuse":
				out.verifyReuse += 1;
				break;
			case "verify_reject":
				out.verifyReject += 1;
				break;
			case "management_overhead":
				if (typeof record.overheadMs === "number" && Number.isFinite(record.overheadMs)) {
					out.managementOverheadMs += record.overheadMs;
				}
				break;
		}
	}
	return out;
}

/**
 * Convenience: note verify reuse/reject with an observable reason.
 * `async.running` must never be recorded as verify_reuse/pass.
 */
export function noteVerificationObserve(input: {
	disposition: "run" | "reuse" | "reject";
	reason?: string;
	asyncRunning?: boolean;
	eventId: string;
	episodeKey?: string;
	jobId?: string;
	overheadMs?: number;
	sink?: EvidenceHandoffObservePersistSink;
}): void {
	if (input.asyncRunning === true) {
		// Never count async.running as pass/reuse.
		if (input.sink) {
			persistEvidenceHandoffObserve(
				input.sink,
				buildEvidenceHandoffObserveRecord({
					eventId: input.eventId,
					phase: "verify_reject",
					ts: Date.now(),
					reason: input.reason ?? "async_running_not_terminal",
					episodeKey: input.episodeKey,
					jobId: input.jobId,
					overheadMs: input.overheadMs,
				}),
			);
		} else {
			snapshot.verifyReject += 1;
		}
		return;
	}
	const phase: EvidenceHandoffObservePhase =
		input.disposition === "run" ? "verify_run" : input.disposition === "reuse" ? "verify_reuse" : "verify_reject";
	if (input.sink) {
		persistEvidenceHandoffObserve(
			input.sink,
			buildEvidenceHandoffObserveRecord({
				eventId: input.eventId,
				phase,
				ts: Date.now(),
				reason: input.reason,
				episodeKey: input.episodeKey,
				jobId: input.jobId,
				overheadMs: input.overheadMs,
			}),
		);
		return;
	}
	applyPhaseToSnapshot(phase, { reason: input.reason, overheadMs: input.overheadMs });
}
