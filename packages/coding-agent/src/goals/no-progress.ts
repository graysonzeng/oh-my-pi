/**
 * D2 goal no-progress observation — host facts only.
 *
 * `consecutiveContinueCount` is NOT no-progress. Progress fingerprints come from
 * comparable host observations (acceptance revision, trusted check failure set,
 * coverage change, blocker clearance). Code-hash alone does not clear the
 * counter; model nextStep / todo flips are not progress.
 *
 * Policy is opt-in; default is observe-only (record fingerprints, never pause).
 */
import { fingerprintStable } from "../latency/stable-serialize";
import type { GoalHostGateDecisionKind, GoalHostGateState, NoProgressPauseReason } from "./state";

export type { NoProgressPauseReason } from "./state";

export const NO_PROGRESS_OBSERVATION_VERSION = 1 as const;

/** Offline fixture default threshold — not a production default commitment. */
export const NO_PROGRESS_FIXTURE_THRESHOLD = 3;

export interface ProgressObservationInput {
	/**
	 * Acceptance list revision / fingerprint when known.
	 * Unknown → omitted (do not invent).
	 */
	acceptanceRevision?: string | null;
	/**
	 * Sorted trusted-check failure ids / seals for the current code version.
	 * Empty array means no failures observed; omit when checks are unknown.
	 */
	trustedFailureIds?: readonly string[] | null;
	/**
	 * Coverage of acceptance items with trusted evidence (sorted ids).
	 * Omit when coverage is unknown.
	 */
	provenAcceptanceIds?: readonly string[] | null;
	/** Host blocker key if still blocked (e.g. unpaired_tools). */
	blockerKey?: string | null;
	/** Host-gate continue reasons (sorted). */
	hostReasons?: readonly string[] | null;
	/**
	 * Code version fingerprint — used only to detect stale evidence pairing,
	 * never alone as progress.
	 */
	codeVersionFingerprint?: string | null;
	/** Nomination that produced this observation (dedupe replays). */
	nominationId?: string | null;
	/** When true, evaluator was unavailable / fail-open — not host progress. */
	evaluatorUnavailable?: boolean;
}

export interface ProgressObservationResult {
	/** Stable fingerprint of comparable host facts (null when observation unknown). */
	fingerprint: string | null;
	/** Whether this observation is comparable enough to update noProgressCount. */
	comparable: boolean;
	/** True when fingerprint matches prior and observation is comparable. */
	identicalToPrior: boolean;
	/** Updated no-progress count (0 when progress or incomparable reset baseline). */
	noProgressCount: number;
	/** Prior fingerprint retained for persistence. */
	lastProgressFingerprint: string | null;
	lastObservedNominationId: string | null;
	lastPauseReason?: NoProgressPauseReason;
	/** True when opt-in policy should pause (never when observe-only). */
	shouldPause: boolean;
}

function sortedUnique(values: readonly string[] | null | undefined): string[] | undefined {
	if (values == null) return undefined;
	const cleaned = [...new Set(values.map(v => v.trim()).filter(Boolean))].sort();
	return cleaned;
}

/**
 * Build a progress fingerprint from host facts.
 * Returns null when there is nothing comparable (missing observation → unknown,
 * rely on existing budgets; do not count as no-progress).
 */
export function buildProgressFingerprint(input: ProgressObservationInput): string | null {
	if (input.evaluatorUnavailable === true) {
		return null;
	}
	const acceptanceRevision = input.acceptanceRevision?.trim() || undefined;
	const trustedFailureIds = sortedUnique(input.trustedFailureIds);
	const provenAcceptanceIds = sortedUnique(input.provenAcceptanceIds);
	const hostReasons = sortedUnique(input.hostReasons);
	const blockerKey = input.blockerKey?.trim() || undefined;

	const hasComparable =
		acceptanceRevision !== undefined ||
		trustedFailureIds !== undefined ||
		provenAcceptanceIds !== undefined ||
		blockerKey !== undefined ||
		(hostReasons !== undefined && hostReasons.length > 0);

	if (!hasComparable) return null;

	// Intentionally omit codeVersionFingerprint from the equality key: hash
	// churn alone is not progress. Include it only as pairing context so stale
	// evidence against a different version is not compared.
	return fingerprintStable({
		v: NO_PROGRESS_OBSERVATION_VERSION,
		acceptanceRevision: acceptanceRevision ?? null,
		trustedFailureIds: trustedFailureIds ?? null,
		provenAcceptanceIds: provenAcceptanceIds ?? null,
		blockerKey: blockerKey ?? null,
		hostReasons: hostReasons ?? null,
		codeVersionPairing: input.codeVersionFingerprint?.trim() || null,
	});
}

export interface ApplyNoProgressPolicyInput {
	gate: GoalHostGateState;
	observation: ProgressObservationInput;
	/** When false (default), only observe — never set shouldPause. */
	policyEnabled: boolean;
	/** Identical comparable observations before pause; fixture default 3. */
	threshold: number;
	decision: GoalHostGateDecisionKind;
}

/**
 * Update no-progress observation on a gate snapshot.
 * Does not mutate consecutiveContinueCount — that remains a separate continue tally.
 */
export function applyNoProgressObservation(input: ApplyNoProgressPolicyInput): ProgressObservationResult {
	const { gate, observation, policyEnabled, threshold, decision } = input;

	if (decision !== "continue") {
		return {
			fingerprint: null,
			comparable: false,
			identicalToPrior: false,
			noProgressCount: 0,
			lastProgressFingerprint: null,
			lastObservedNominationId: observation.nominationId?.trim() || gate.lastObservedNominationId || null,
			shouldPause: false,
		};
	}

	// Unsettled / waiting reasons should not burn a no-progress quota.
	const waiting =
		observation.hostReasons?.includes("unpaired_tools") === true && (observation.hostReasons?.length ?? 0) === 1;
	if (waiting) {
		return {
			fingerprint: gate.lastProgressFingerprint ?? null,
			comparable: false,
			identicalToPrior: false,
			noProgressCount: gate.noProgressCount ?? 0,
			lastProgressFingerprint: gate.lastProgressFingerprint ?? null,
			lastObservedNominationId: gate.lastObservedNominationId ?? null,
			shouldPause: false,
		};
	}

	if (observation.evaluatorUnavailable === true) {
		return {
			fingerprint: null,
			comparable: false,
			identicalToPrior: false,
			noProgressCount: gate.noProgressCount ?? 0,
			lastProgressFingerprint: gate.lastProgressFingerprint ?? null,
			lastObservedNominationId: observation.nominationId?.trim() || gate.lastObservedNominationId || null,
			lastPauseReason: "evaluator_unavailable_not_progress",
			shouldPause: false,
		};
	}

	const nominationId = observation.nominationId?.trim() || undefined;
	if (nominationId && gate.lastObservedNominationId === nominationId) {
		// Replay of same nomination — do not double-count.
		return {
			fingerprint: gate.lastProgressFingerprint ?? null,
			comparable: Boolean(gate.lastProgressFingerprint),
			identicalToPrior: true,
			noProgressCount: gate.noProgressCount ?? 0,
			lastProgressFingerprint: gate.lastProgressFingerprint ?? null,
			lastObservedNominationId: nominationId,
			lastPauseReason: gate.lastPauseReason,
			shouldPause: false,
		};
	}

	const fingerprint = buildProgressFingerprint(observation);
	if (fingerprint === null) {
		return {
			fingerprint: null,
			comparable: false,
			identicalToPrior: false,
			noProgressCount: gate.noProgressCount ?? 0,
			lastProgressFingerprint: gate.lastProgressFingerprint ?? null,
			lastObservedNominationId: nominationId ?? gate.lastObservedNominationId ?? null,
			lastPauseReason: "missing_observation_budget_only",
			shouldPause: false,
		};
	}

	const prior = gate.lastProgressFingerprint ?? null;
	const identical = prior !== null && prior === fingerprint;
	// Streak length: first comparable observation starts at 1; identical repeats increment.
	const noProgressCount = identical ? (gate.noProgressCount ?? 0) + 1 : 1;
	const shouldPause = policyEnabled && noProgressCount >= Math.max(1, threshold);

	return {
		fingerprint,
		comparable: true,
		identicalToPrior: identical,
		noProgressCount,
		lastProgressFingerprint: fingerprint,
		lastObservedNominationId: nominationId ?? null,
		lastPauseReason: shouldPause ? "identical_host_observation" : undefined,
		shouldPause,
	};
}

/** Merge observation result into a host-gate state object (immutable update). */
export function mergeNoProgressIntoGate(gate: GoalHostGateState, result: ProgressObservationResult): GoalHostGateState {
	return {
		...gate,
		lastProgressFingerprint: result.lastProgressFingerprint ?? undefined,
		noProgressCount: result.noProgressCount,
		lastObservedNominationId: result.lastObservedNominationId ?? undefined,
		lastPauseReason: result.lastPauseReason ?? gate.lastPauseReason,
	};
}
