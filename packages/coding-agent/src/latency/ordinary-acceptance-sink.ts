/**
 * Ordinary-session trusted acceptance sink helpers (Batch 1 W1 production wiring).
 *
 * Authority must be trusted verifier / extension / explicit user accept /
 * workflow / fixture. Never auto-pass from LLM done, child proven, exit0, or
 * todo-complete. Metadata stays on `custom` entries (not model context).
 */
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import { logger } from "@oh-my-pi/pi-utils";
import { buildAcceptanceContractRef, parseAcceptanceContractRef } from "./task-episode";
import {
	canRecordTrustedParentFinal,
	PARENT_FINAL_VERIFICATION_MESSAGE_TYPE,
	parseParentFinalVerificationDetails,
	type ParentFinalVerificationDetails,
	type ParentFinalVerificationStatus,
} from "./parent-final-verification";
import type { AcceptanceAuthority } from "./task-episode";

export type OrdinaryAcceptanceSession = {
	tryRecordTrustedParentFinalVerification: (input: {
		status: ParentFinalVerificationStatus;
		authority: AcceptanceAuthority;
		acceptanceItems: readonly string[];
		source?: ParentFinalVerificationDetails["source"];
		verifiedAtMs?: number;
		eventId?: string;
		codeState?: ParentFinalVerificationDetails["codeState"];
		evidenceRefs?: readonly string[];
	}) =>
		| { recorded: true; entryId: string; details: ParentFinalVerificationDetails }
		| { recorded: false; reason: string };
	sessionManager: {
		appendCustomEntry(customType: string, data?: unknown): string;
	};
};

function authorityFromDetails(value: unknown): AcceptanceAuthority | undefined {
	if (!isRecord(value)) return undefined;
	const authority = value.authority;
	if (
		authority === "trusted_verifier" ||
		authority === "user_explicit" ||
		authority === "extension" ||
		authority === "workflow" ||
		authority === "fixture"
	) {
		return authority;
	}
	return undefined;
}

function acceptanceItemsFromData(data: unknown): string[] {
	const parsed = parseParentFinalVerificationDetails(data);
	if (parsed?.acceptanceContract?.items?.length) {
		return [...parsed.acceptanceContract.items];
	}
	if (!isRecord(data)) return [];
	if (Array.isArray(data.acceptanceItems)) {
		return data.acceptanceItems
			.filter((item): item is string => typeof item === "string")
			.map(item => item.trim())
			.filter(Boolean);
	}
	const contract = parseAcceptanceContractRef(data.acceptanceContract);
	return contract?.items ? [...contract.items] : [];
}

/**
 * Extension `appendEntry` owner: route `parent_final_verification` through the
 * trusted sink. Other custom types pass through unchanged.
 *
 * Rejected / ungated writes do not mint green — they throw so callers cannot
 * treat a bypassed append as acceptance.
 */
export function appendEntryViaOrdinaryAcceptanceSink(
	session: OrdinaryAcceptanceSession,
	customType: string,
	data?: unknown,
): string {
	if (customType !== PARENT_FINAL_VERIFICATION_MESSAGE_TYPE) {
		return session.sessionManager.appendCustomEntry(customType, data);
	}

	const parsed = parseParentFinalVerificationDetails(data);
	const status: ParentFinalVerificationStatus = parsed?.status ?? "failed";
	const authority = parsed?.authority ?? authorityFromDetails(data) ?? ("extension" as const);
	const acceptanceItems = acceptanceItemsFromData(data);
	const gate = canRecordTrustedParentFinal({ acceptanceItems, authority, status });
	if (!gate.ok) {
		logger.warn("ordinary acceptance: extension appendEntry rejected", {
			reason: gate.reason,
			status,
			authority,
		});
		throw new Error(`parent_final_verification_rejected:${gate.reason}`);
	}

	const result = session.tryRecordTrustedParentFinalVerification({
		status,
		authority,
		acceptanceItems,
		source: parsed?.source === "workflow" || parsed?.source === "fixture" ? parsed.source : "extension",
		verifiedAtMs: parsed?.verifiedAtMs,
		eventId: parsed?.eventId,
		codeState: parsed?.codeState,
		evidenceRefs: parsed?.evidenceRefs,
	});
	if (!result.recorded) {
		logger.warn("ordinary acceptance: trusted sink gated out", { reason: result.reason });
		throw new Error(`parent_final_verification_rejected:${result.reason}`);
	}
	return result.entryId;
}

/**
 * Explicit user-accept path (e.g. host-confirmed `/goal complete`).
 * Requires non-empty acceptance criteria (typically the goal objective).
 * Write failure propagates — never mint green from a failed persist.
 */
export function recordExplicitUserAcceptance(
	session: OrdinaryAcceptanceSession,
	input: {
		acceptanceItems: readonly string[];
		status?: ParentFinalVerificationStatus;
		eventId?: string;
		codeState?: ParentFinalVerificationDetails["codeState"];
		evidenceRefs?: readonly string[];
	},
): { recorded: true; entryId: string; details: ParentFinalVerificationDetails } | { recorded: false; reason: string } {
	const status = input.status ?? "passed";
	const authority: AcceptanceAuthority = "user_explicit";
	const items = input.acceptanceItems.map(item => item.trim()).filter(Boolean);
	const gate = canRecordTrustedParentFinal({ acceptanceItems: items, authority, status });
	if (!gate.ok) return { recorded: false, reason: gate.reason };
	// Ensure contract ref shape is available for offline readers.
	buildAcceptanceContractRef(items);
	return session.tryRecordTrustedParentFinalVerification({
		status,
		authority,
		acceptanceItems: items,
		source: "extension",
		eventId: input.eventId,
		codeState: input.codeState,
		evidenceRefs: input.evidenceRefs,
	});
}
