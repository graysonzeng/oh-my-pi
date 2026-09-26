/**
 * Task episode / attempt identity contract (Batch 1 W1 §4).
 *
 * Reuses persisted session entry ids — never ephemeral counters. One user
 * message (rootUserEntryId) anchors an episode; repairs/clarifications are
 * later attempts on the same episode. Explicit new tasks or post-acceptance
 * requests start a new episode. When the boundary cannot be determined,
 * leave attribution unattributed rather than inventing task ids from tool calls.
 */
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import { fingerprintStable } from "./stable-serialize";

export const TASK_EPISODE_CONTRACT_VERSION = 1 as const;

/** Trusted acceptance authorities — LLM "done", child proven, exit 0, todo-complete are NOT among these. */
export type AcceptanceAuthority = "trusted_verifier" | "user_explicit" | "extension" | "workflow" | "fixture";

export interface TaskEpisodeAnchor {
	/** Persisted session id. */
	sessionId: string;
	/** Persisted user message entry id that opened this episode. */
	rootUserEntryId: string;
}

export interface TaskAttemptIdentity {
	/**
	 * Episode anchor when a real root user entry is known.
	 * Null when attribution is intentionally unattributed (do not invent ids).
	 */
	episode: TaskEpisodeAnchor | null;
	/**
	 * Attempt id within the episode. Prefer persisted workflow attemptId or a
	 * stable receipt event id; null when unattributed.
	 */
	attemptId: string | null;
	/** Workflow id when the episode runs on the workflow path. */
	workflowId: string | null;
	/** Active branch leaf id at record time (for abandoned-branch isolation). */
	branchLeafId: string | null;
	/** Subagent / job linkage when cost is attributed to a child. */
	taskToolCallId: string | null;
	jobId: string | null;
	agentId: string | null;
}

export interface AcceptanceContractRef {
	/** Stable ids or exact acceptance texts from the task contract. */
	items: string[];
	/** Optional content fingerprint of the acceptance list. */
	fingerprint?: string;
}

export function episodeKey(episode: TaskEpisodeAnchor): string {
	return `${episode.sessionId}::${episode.rootUserEntryId}`;
}

export function buildAcceptanceContractRef(items: readonly string[]): AcceptanceContractRef | null {
	const cleaned = items.map(item => item.trim()).filter(Boolean);
	if (cleaned.length === 0) return null;
	return {
		items: cleaned,
		fingerprint: fingerprintStable(cleaned),
	};
}

export function parseTaskEpisodeAnchor(value: unknown): TaskEpisodeAnchor | null {
	if (!isRecord(value)) return null;
	const sessionId = typeof value.sessionId === "string" ? value.sessionId.trim() : "";
	const rootUserEntryId = typeof value.rootUserEntryId === "string" ? value.rootUserEntryId.trim() : "";
	if (!sessionId || !rootUserEntryId) return null;
	return { sessionId, rootUserEntryId };
}

export function parseTaskAttemptIdentity(value: unknown): TaskAttemptIdentity | null {
	if (!isRecord(value)) return null;
	// Episode may be explicitly null (unattributed) or a valid anchor. Missing /
	// invalid episode objects without an explicit null fail closed only when no
	// other attempt linkage exists — prefer preserving workflow/attempt ids.
	const hasExplicitNullEpisode = value.episode === null;
	const episode = hasExplicitNullEpisode ? null : parseTaskEpisodeAnchor(value.episode);
	if (!hasExplicitNullEpisode && !episode) {
		// Legacy / partial: require a parseable episode when one was supplied as an object.
		if (value.episode !== undefined) return null;
		return null;
	}
	const attemptId = typeof value.attemptId === "string" && value.attemptId.trim() ? value.attemptId.trim() : null;
	const workflowId = typeof value.workflowId === "string" && value.workflowId.trim() ? value.workflowId.trim() : null;
	if (!episode && !attemptId && !workflowId) return null;
	return {
		episode: episode ?? null,
		attemptId,
		workflowId,
		branchLeafId:
			typeof value.branchLeafId === "string" && value.branchLeafId.trim() ? value.branchLeafId.trim() : null,
		taskToolCallId:
			typeof value.taskToolCallId === "string" && value.taskToolCallId.trim() ? value.taskToolCallId.trim() : null,
		jobId: typeof value.jobId === "string" && value.jobId.trim() ? value.jobId.trim() : null,
		agentId: typeof value.agentId === "string" && value.agentId.trim() ? value.agentId.trim() : null,
	};
}

export function parseAcceptanceContractRef(value: unknown): AcceptanceContractRef | null {
	if (!isRecord(value)) return null;
	if (!Array.isArray(value.items)) return null;
	const items = value.items
		.filter((item): item is string => typeof item === "string")
		.map(item => item.trim())
		.filter(Boolean);
	if (items.length === 0) return null;
	const out: AcceptanceContractRef = { items };
	if (typeof value.fingerprint === "string" && value.fingerprint.trim()) {
		out.fingerprint = value.fingerprint.trim();
	}
	return out;
}

export function isAcceptanceAuthority(value: unknown): value is AcceptanceAuthority {
	return (
		value === "trusted_verifier" ||
		value === "user_explicit" ||
		value === "extension" ||
		value === "workflow" ||
		value === "fixture"
	);
}

/**
 * Resolve the root user entry id for the active branch: the earliest user
 * message still on the branch after the previous accepted episode boundary,
 * or the earliest user message when no boundary exists.
 *
 * Callers that already know the episode root should pass it explicitly rather
 * than relying on this heuristic.
 */
export function resolveRootUserEntryIdFromBranch(
	entries: readonly { id: string; type: string; message?: { role?: string } }[],
	opts?: { afterEntryId?: string | null },
): string | null {
	let started = !opts?.afterEntryId;
	let root: string | null = null;
	for (const entry of entries) {
		if (!started) {
			if (entry.id === opts?.afterEntryId) started = true;
			continue;
		}
		if (entry.type !== "message") continue;
		if (entry.message?.role !== "user") continue;
		root = entry.id;
		break;
	}
	return root;
}

/** Entry shapes that can carry a parent-final acceptance receipt. */
export type BranchEntryForEpisodeBoundary = {
	id: string;
	type: string;
	customType?: string;
	data?: unknown;
	details?: unknown;
	message?: { role?: string; customType?: string; details?: unknown };
};

/**
 * Latest **passed** parent-final verification entry id on the branch.
 * Used as `afterEntryId` so the next user message opens a new episode instead
 * of rebinding to the session's first user message.
 */
export function resolvePreviousAcceptedBoundaryEntryId(
	entries: readonly BranchEntryForEpisodeBoundary[],
): string | null {
	let boundary: string | null = null;
	for (const entry of entries) {
		let customType: string | undefined;
		let payload: unknown;
		if (entry.type === "custom") {
			customType = typeof entry.customType === "string" ? entry.customType : undefined;
			payload = entry.data;
		} else if (entry.type === "custom_message") {
			customType = typeof entry.customType === "string" ? entry.customType : undefined;
			payload = entry.details;
		} else if (entry.type === "message" && entry.message?.role === "custom") {
			customType = typeof entry.message.customType === "string" ? entry.message.customType : undefined;
			payload = entry.message.details;
		} else {
			continue;
		}
		if (customType !== "parent_final_verification") continue;
		if (!isRecord(payload)) continue;
		if (payload.status !== "passed") continue;
		boundary = entry.id;
	}
	return boundary;
}

/**
 * Episode root for ordinary / workflow / child delivery: first user message
 * after the previous accepted receipt boundary (or earliest user message).
 */
export function resolveEpisodeRootFromBranch(entries: readonly BranchEntryForEpisodeBoundary[]): string | null {
	const afterEntryId = resolvePreviousAcceptedBoundaryEntryId(entries);
	return resolveRootUserEntryIdFromBranch(entries, { afterEntryId });
}

/**
 * Prefer an explicit attempt id; otherwise reuse a durable receipt event id so
 * fail→repair→pass keeps distinct attempts under one episode.
 */
export function resolveAttemptId(explicit: string | null | undefined, eventId: string | null | undefined): string | null {
	const fromExplicit = typeof explicit === "string" && explicit.trim() ? explicit.trim() : null;
	if (fromExplicit) return fromExplicit;
	const fromEvent = typeof eventId === "string" && eventId.trim() ? eventId.trim() : null;
	return fromEvent;
}
