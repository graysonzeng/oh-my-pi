/**
 * Explicit parent-final-verification receipts.
 *
 * Subagent exit, successful bash, and normal session stop never imply
 * acceptance. Offline reports and ordinary cohort joins only treat a parent as
 * verified when this custom entry (or an equivalent parsed receipt) is present.
 *
 * Batch 1 W1: receipts carry episode/attempt linkage, acceptance contract refs,
 * codeState, and authority. Metadata is stored on `custom` entries (not model
 * context). Readers accept both `custom` and legacy `custom_message` shapes.
 */
import { isRecord } from "@oh-my-pi/pi-utils";
import type { OrdinaryVerifierSource, OrdinaryVerifierStatus } from "./rollout-cohort";
import {
	isAcceptanceAuthority,
	parseAcceptanceContractRef,
	parseTaskAttemptIdentity,
	type AcceptanceAuthority,
	type AcceptanceContractRef,
	type TaskAttemptIdentity,
} from "./task-episode";

/** `customType` for parent acceptance evidence (custom and legacy custom_message). */
export const PARENT_FINAL_VERIFICATION_MESSAGE_TYPE = "parent_final_verification";

export const PARENT_FINAL_VERIFICATION_DETAILS_VERSION = 1 as const;

export type ParentFinalVerificationStatus = "passed" | "failed";
export type ParentFinalVerificationSource = OrdinaryVerifierSource | "workflow" | "fixture";

export interface ParentFinalCodeStateRef {
	/** Workspace / patch fingerprint (sha256, head id, …). */
	fingerprint: string;
	patchSha256?: string;
	headId?: string;
}

export interface ParentFinalVerificationDetails {
	status: ParentFinalVerificationStatus;
	source: ParentFinalVerificationSource;
	/** Epoch ms when verification settled; message timestamp is used when omitted. */
	verifiedAtMs?: number;
	/** Schema version for extended fields; omitted on legacy receipts. */
	v?: typeof PARENT_FINAL_VERIFICATION_DETAILS_VERSION;
	/** Idempotent event id — duplicate writes with the same id must not double-bill. */
	eventId?: string;
	/** Episode/attempt linkage (sessionId + rootUserEntryId). */
	attempt?: TaskAttemptIdentity;
	/** Acceptance items that were verified. */
	acceptanceContract?: AcceptanceContractRef;
	/** Workspace snapshot the verdict is bound to. */
	codeState?: ParentFinalCodeStateRef;
	/** Who is allowed to mint this verdict. */
	authority?: AcceptanceAuthority;
	/** Compact runtime build identity ref from W0. */
	buildIdentityRef?: string;
	/** Evidence artifact / check ids (not full logs). */
	evidenceRefs?: string[];
}

export interface ParentFinalVerificationObservation {
	status: ParentFinalVerificationStatus;
	source: ParentFinalVerificationSource;
	ts: number | null;
	eventId?: string;
	attempt?: TaskAttemptIdentity;
	acceptanceContract?: AcceptanceContractRef;
	codeState?: ParentFinalCodeStateRef;
	authority?: AcceptanceAuthority;
	/** Schema version when present — v1+ requires authority to count as accepted. */
	v?: typeof PARENT_FINAL_VERIFICATION_DETAILS_VERSION;
	buildIdentityRef?: string;
	evidenceRefs?: string[];
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

function parseCodeState(value: unknown): ParentFinalCodeStateRef | undefined {
	if (!isRecord(value)) return undefined;
	const fingerprint = typeof value.fingerprint === "string" ? value.fingerprint.trim() : "";
	if (!fingerprint) return undefined;
	const out: ParentFinalCodeStateRef = { fingerprint };
	if (typeof value.patchSha256 === "string" && value.patchSha256.trim()) {
		out.patchSha256 = value.patchSha256.trim();
	}
	if (typeof value.headId === "string" && value.headId.trim()) {
		out.headId = value.headId.trim();
	}
	return out;
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
	const attempt = parseTaskAttemptIdentity(details.attempt) ?? undefined;
	const acceptanceContract = parseAcceptanceContractRef(details.acceptanceContract) ?? undefined;
	const codeState = parseCodeState(details.codeState);
	const authority = isAcceptanceAuthority(details.authority) ? details.authority : undefined;
	const eventId = typeof details.eventId === "string" && details.eventId.trim() ? details.eventId.trim() : undefined;
	const buildIdentityRef =
		typeof details.buildIdentityRef === "string" && details.buildIdentityRef.trim()
			? details.buildIdentityRef.trim()
			: undefined;
	const evidenceRefs = Array.isArray(details.evidenceRefs)
		? details.evidenceRefs
				.filter((item): item is string => typeof item === "string")
				.map(item => item.trim())
				.filter(Boolean)
		: undefined;
	const v =
		details.v === PARENT_FINAL_VERIFICATION_DETAILS_VERSION ? PARENT_FINAL_VERIFICATION_DETAILS_VERSION : undefined;

	return {
		status,
		source,
		...(verifiedAtMs !== undefined ? { verifiedAtMs } : {}),
		...(v !== undefined ? { v } : {}),
		...(eventId ? { eventId } : {}),
		...(attempt ? { attempt } : {}),
		...(acceptanceContract ? { acceptanceContract } : {}),
		...(codeState ? { codeState } : {}),
		...(authority ? { authority } : {}),
		...(buildIdentityRef ? { buildIdentityRef } : {}),
		...(evidenceRefs && evidenceRefs.length > 0 ? { evidenceRefs } : {}),
	};
}

export interface BuildParentFinalVerificationDetailsInput {
	status: ParentFinalVerificationStatus;
	source: ParentFinalVerificationSource;
	verifiedAtMs?: number;
	eventId?: string;
	attempt?: TaskAttemptIdentity;
	acceptanceContract?: AcceptanceContractRef;
	codeState?: ParentFinalCodeStateRef;
	authority?: AcceptanceAuthority;
	buildIdentityRef?: string;
	evidenceRefs?: readonly string[];
}

/** Build details for a parent-final-verification custom entry. */
export function buildParentFinalVerificationDetails(
	status: ParentFinalVerificationStatus,
	source: ParentFinalVerificationSource,
	verifiedAtMs: number = Date.now(),
	extended?: Omit<BuildParentFinalVerificationDetailsInput, "status" | "source" | "verifiedAtMs">,
): ParentFinalVerificationDetails {
	const evidenceRefs = extended?.evidenceRefs?.map(item => item.trim()).filter(Boolean);
	return {
		status,
		source,
		verifiedAtMs,
		v: PARENT_FINAL_VERIFICATION_DETAILS_VERSION,
		...(extended?.eventId?.trim() ? { eventId: extended.eventId.trim() } : {}),
		...(extended?.attempt ? { attempt: extended.attempt } : {}),
		...(extended?.acceptanceContract ? { acceptanceContract: extended.acceptanceContract } : {}),
		...(extended?.codeState ? { codeState: extended.codeState } : {}),
		...(extended?.authority ? { authority: extended.authority } : {}),
		...(extended?.buildIdentityRef?.trim() ? { buildIdentityRef: extended.buildIdentityRef.trim() } : {}),
		...(evidenceRefs && evidenceRefs.length > 0 ? { evidenceRefs: [...evidenceRefs] } : {}),
	};
}

/**
 * Trusted ordinary sink gate: only mint a receipt when acceptance criteria exist
 * and the caller provides a trusted authority. Session stop / tool green alone
 * never pass this gate.
 */
export function canRecordTrustedParentFinal(input: {
	acceptanceItems: readonly string[] | undefined;
	authority: AcceptanceAuthority | undefined;
	status: ParentFinalVerificationStatus;
}): { ok: true } | { ok: false; reason: string } {
	const items = (input.acceptanceItems ?? []).map(item => item.trim()).filter(Boolean);
	if (items.length === 0) {
		return { ok: false, reason: "missing_acceptance_criteria" };
	}
	if (!input.authority) {
		return { ok: false, reason: "missing_acceptance_authority" };
	}
	if (input.authority === "fixture") {
		// Fixture authority is allowed for offline L0/L1 only — callers still opt in.
		return { ok: true };
	}
	if (
		input.authority !== "trusted_verifier" &&
		input.authority !== "user_explicit" &&
		input.authority !== "extension" &&
		input.authority !== "workflow"
	) {
		return { ok: false, reason: "untrusted_authority" };
	}
	return { ok: true };
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
