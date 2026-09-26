/**
 * Parent consume of child delivery evidence (Batch 1 W2 production wiring).
 *
 * Settle stamps packet-only decisions; this module reclassifies against the
 * **current** workspace + acceptance contract + freshness, binds a controlled
 * decision entry, and optionally persists durable observe (W3).
 *
 * `done_valid` / integrate-eligible ≠ final parent acceptance.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { resolveRootUserEntryIdFromBranch } from "../latency/task-episode";
import {
	bindParentIntegrateDecisionEntry,
	PARENT_INTEGRATE_DECISION_CUSTOM_TYPE,
	reclassifyParentIntegrateAgainstWorkspace,
	type ChildDeliveryEvidenceV1,
	type ParentIntegrateDecision,
} from "./child-delivery-evidence";
import { inspectEvidenceHandoffContext } from "./evidence-handoff";
import {
	buildEvidenceHandoffObserveRecord,
	persistEvidenceHandoffObserve,
	type EvidenceHandoffObservePersistSink,
} from "./evidence-handoff-observe";

export type ParentDeliveryConsumeSink = EvidenceHandoffObservePersistSink & {
	getSessionId?: () => string;
	getBranch?: () => readonly { id: string; type: string; message?: { role?: string } }[];
	getLeafId?: () => string | null | undefined;
};

export interface ParentDeliveryConsumeInput {
	delivery: ChildDeliveryEvidenceV1 | null | undefined;
	/** Current workspace / patch identity fingerprint (required for freshness). */
	currentCodeVersion: string;
	requiredAcceptance?: readonly string[];
	staleEvidence?: boolean;
	outOfScopeEdits?: boolean;
	crossModule?: boolean;
	/** Parent-confirmed release only — never inherit child claim. */
	writeOwnershipReleased?: boolean;
	episodeSessionId: string;
	rootUserEntryId: string;
	taskToolCallId?: string | null;
	jobId?: string | null;
	agentId?: string | null;
	sink: ParentDeliveryConsumeSink;
	/** Persist child_settled + parent_consumed observe (default true). */
	observe?: boolean;
	eventIdPrefix?: string;
}

export interface ParentDeliveryConsumeResult {
	decision: ParentIntegrateDecision & { boundToWorkspaceVersion: string };
	entry: ReturnType<typeof bindParentIntegrateDecisionEntry>;
	entryId: string;
}

/** Derive required acceptance + stale flags from an evidence-handoff context string. */
export function acceptanceAndFreshnessFromContext(context: string | undefined): {
	requiredAcceptance: string[];
	staleEvidence: boolean;
} {
	const inspected = inspectEvidenceHandoffContext(context);
	if (inspected.invalid) {
		return { requiredAcceptance: [], staleEvidence: true };
	}
	const handoff = inspected.handoff;
	if (!handoff) return { requiredAcceptance: [], staleEvidence: false };
	const staleEvidence = handoff.confirmedFacts.some(fact => fact.stale === true);
	return {
		requiredAcceptance: [...handoff.acceptance],
		staleEvidence,
	};
}

/**
 * Reclassify against workspace, bind decision entry, persist (one owner).
 * Packet-only settle decisions must not be treated as integrate-of-record.
 */
export function consumeChildDeliveryForParent(input: ParentDeliveryConsumeInput): ParentDeliveryConsumeResult {
	const decision = reclassifyParentIntegrateAgainstWorkspace({
		delivery: input.delivery,
		currentCodeVersion: input.currentCodeVersion,
		requiredAcceptance: input.requiredAcceptance,
		staleEvidence: input.staleEvidence,
		outOfScopeEdits: input.outOfScopeEdits,
		crossModule: input.crossModule,
		writeOwnershipReleased: input.writeOwnershipReleased,
	});

	const entry = bindParentIntegrateDecisionEntry({
		decision,
		episodeSessionId: input.episodeSessionId,
		rootUserEntryId: input.rootUserEntryId,
		taskToolCallId: input.taskToolCallId,
		jobId: input.jobId,
		agentId: input.agentId,
		workspaceVersion: decision.boundToWorkspaceVersion,
	});

	const entryId = input.sink.appendCustomEntry(PARENT_INTEGRATE_DECISION_CUSTOM_TYPE, entry);
	const observe = input.observe !== false;
	const prefix = input.eventIdPrefix?.trim() || `consume:${entryId}`;

	if (observe) {
		try {
			persistEvidenceHandoffObserve(
				input.sink,
				buildEvidenceHandoffObserveRecord({
					eventId: `${prefix}:parent_consumed`,
					phase: "parent_consumed",
					ts: Date.now(),
					reason: decision.action,
					jobId: input.jobId ?? undefined,
					agentId: input.agentId ?? undefined,
					details: {
						classification: decision.classification,
						action: decision.action,
						finalAccepted: false,
						boundToWorkspaceVersion: decision.boundToWorkspaceVersion,
					},
				}),
			);
		} catch (error) {
			logger.warn("parent delivery consume: observe persist failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return { decision, entry, entryId };
}

/** Persist a child_settled observe boundary (W3). */
export function noteChildSettledObserve(input: {
	sink: EvidenceHandoffObservePersistSink;
	eventId: string;
	jobId?: string;
	agentId?: string;
	reason?: string;
}): void {
	persistEvidenceHandoffObserve(
		input.sink,
		buildEvidenceHandoffObserveRecord({
			eventId: input.eventId,
			phase: "child_settled",
			ts: Date.now(),
			jobId: input.jobId,
			agentId: input.agentId,
			reason: input.reason,
		}),
	);
}

/**
 * Resolve episode anchors from a session manager-like sink for parent consume.
 * Returns null when the active branch has no user root (leave unattributed).
 */
export function resolveParentConsumeEpisode(sink: ParentDeliveryConsumeSink): {
	sessionId: string;
	rootUserEntryId: string;
} | null {
	const sessionId = sink.getSessionId?.();
	if (!sessionId) return null;
	const rootUserEntryId = resolveRootUserEntryIdFromBranch(sink.getBranch?.() ?? []);
	if (!rootUserEntryId) return null;
	return { sessionId, rootUserEntryId };
}
