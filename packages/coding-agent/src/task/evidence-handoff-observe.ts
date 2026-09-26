/**
 * Observation helpers for evidence-handoff generate → consume → reject-stale
 * (history supplement S1). No schema expansion — counters + structured logs only.
 *
 * Package 1 `costPerAcceptedTask` remains uncomputable until explicit
 * `parent_final_verification` receipts exist in the corpus; this module does
 * not invent acceptance from tool success or process exit.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { WorkerReuseDecision } from "./evidence-handoff";

export interface EvidenceHandoffObserveSnapshot {
	generate: number;
	consumeValid: number;
	consumeMissing: number;
	rejectStale: number;
	rejectInvalid: number;
	reuseContinue: number;
	reuseSpawnFresh: number;
}

const emptySnapshot = (): EvidenceHandoffObserveSnapshot => ({
	generate: 0,
	consumeValid: 0,
	consumeMissing: 0,
	rejectStale: 0,
	rejectInvalid: 0,
	reuseContinue: 0,
	reuseSpawnFresh: 0,
});

let snapshot = emptySnapshot();

/** Process-local observe counters (tests reset via {@link resetEvidenceHandoffObserveForTests}). */
export function getEvidenceHandoffObserveSnapshot(): EvidenceHandoffObserveSnapshot {
	return { ...snapshot };
}

export function resetEvidenceHandoffObserveForTests(): void {
	snapshot = emptySnapshot();
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
