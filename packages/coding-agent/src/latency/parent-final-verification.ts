/**
 * Explicit parent-final-verification receipts.
 *
 * Subagent exit, successful bash, and normal session stop never imply
 * acceptance. Offline reports and ordinary cohort joins only treat a parent as
 * verified when this custom message (or an equivalent parsed receipt) is present.
 */
import { isRecord } from "@oh-my-pi/pi-utils";
import type { OrdinaryVerifierSource, OrdinaryVerifierStatus } from "./rollout-cohort";

/** `customType` / `custom_message.customType` for parent acceptance evidence. */
export const PARENT_FINAL_VERIFICATION_MESSAGE_TYPE = "parent_final_verification";

export type ParentFinalVerificationStatus = "passed" | "failed";
export type ParentFinalVerificationSource = OrdinaryVerifierSource | "workflow" | "fixture";

export interface ParentFinalVerificationDetails {
	status: ParentFinalVerificationStatus;
	source: ParentFinalVerificationSource;
	/** Epoch ms when verification settled; message timestamp is used when omitted. */
	verifiedAtMs?: number;
}

export interface ParentFinalVerificationObservation {
	status: ParentFinalVerificationStatus;
	source: ParentFinalVerificationSource;
	ts: number | null;
}

const SOURCES: Record<ParentFinalVerificationSource, true> = {
	session_stop: true,
	extension: true,
	unknown: true,
	workflow: true,
	fixture: true,
};

export function isParentFinalVerificationSource(value: unknown): value is ParentFinalVerificationSource {
	return typeof value === "string" && SOURCES[value as ParentFinalVerificationSource] === true;
}

export function parseParentFinalVerificationDetails(details: unknown): ParentFinalVerificationDetails | null {
	if (!isRecord(details)) return null;
	const status = details.status;
	if (status !== "passed" && status !== "failed") return null;
	const source = isParentFinalVerificationSource(details.source) ? details.source : "unknown";
	const verifiedAtMs =
		typeof details.verifiedAtMs === "number" && Number.isFinite(details.verifiedAtMs) && details.verifiedAtMs >= 0
			? details.verifiedAtMs
			: undefined;
	return {
		status,
		source,
		...(verifiedAtMs !== undefined ? { verifiedAtMs } : {}),
	};
}

/** Build details for a parent-final-verification custom message. */
export function buildParentFinalVerificationDetails(
	status: ParentFinalVerificationStatus,
	source: ParentFinalVerificationSource,
	verifiedAtMs: number = Date.now(),
): ParentFinalVerificationDetails {
	return { status, source, verifiedAtMs };
}

/** Map an explicit receipt onto ordinary cohort verifier fields. Unknown stays unknown. */
export function ordinaryVerifierFromParentFinal(observation: ParentFinalVerificationObservation | null | undefined): {
	source: OrdinaryVerifierSource;
	status: OrdinaryVerifierStatus;
} {
	if (!observation) return { source: "unknown", status: "unknown" };
	const source: OrdinaryVerifierSource =
		observation.source === "session_stop" || observation.source === "extension" ? observation.source : "unknown";
	return { source, status: observation.status };
}

/**
 * Critical-path duration for one parent timeline.
 *
 * With only start/verify timestamps and child file spans (no finer causal
 * edges), the parent wall start→verify is the critical path. Overlapping
 * children must never be summed into that path — callers compare against
 * `sumChildIntervalMs` in tests to catch regressions.
 */
export function criticalPathMsFromIntervals(args: {
	startTs: number;
	verifyTs: number;
	childIntervals: readonly { start: number; end: number }[];
}): number | null {
	const { startTs, verifyTs } = args;
	if (!(verifyTs >= startTs)) return null;
	return verifyTs - startTs;
}

/** Serial sum of child interval lengths (incorrect e2e when children overlap). */
export function sumChildIntervalMs(childIntervals: readonly { start: number; end: number }[]): number {
	let sum = 0;
	for (const interval of childIntervals) {
		if (!(Number.isFinite(interval.start) && Number.isFinite(interval.end) && interval.end >= interval.start)) {
			continue;
		}
		sum += interval.end - interval.start;
	}
	return sum;
}

/** Union duration of overlapping child intervals (parallel work counted once). */
export function unionChildIntervalMs(childIntervals: readonly { start: number; end: number }[]): number {
	const valid = childIntervals
		.filter(
			interval => Number.isFinite(interval.start) && Number.isFinite(interval.end) && interval.end >= interval.start,
		)
		.map(interval => ({ start: interval.start, end: interval.end }))
		.sort((a, b) => a.start - b.start || a.end - b.end);
	if (valid.length === 0) return 0;
	const merged: Array<{ start: number; end: number }> = [];
	for (const interval of valid) {
		const last = merged[merged.length - 1];
		if (!last || interval.start > last.end) merged.push({ ...interval });
		else last.end = Math.max(last.end, interval.end);
	}
	let union = 0;
	for (const interval of merged) union += interval.end - interval.start;
	return union;
}
