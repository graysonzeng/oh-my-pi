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
	episode: TaskEpisodeAnchor;
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
	const episode = parseTaskEpisodeAnchor(value.episode);
	if (!episode) return null;
	return {
		episode,
		attemptId: typeof value.attemptId === "string" && value.attemptId.trim() ? value.attemptId.trim() : null,
		workflowId: typeof value.workflowId === "string" && value.workflowId.trim() ? value.workflowId.trim() : null,
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
