/**
 * Per-file edit failure escalation (quality/cost plan P2-E).
 *
 * After {@link EDIT_FAILURE_ESCALATION_THRESHOLD} failed `edit` calls on the
 * same path, advise a forced re-read and signal that the session should escalate
 * to the top model (`@slow`, then `@default`) instead of looping the same edit.
 * Success on that path clears the streak. Advisory only until the host applies
 * the model swap via {@link TurnRecovery.escalateEditFailuresToTopModel}.
 */
import { prompt } from "@oh-my-pi/pi-utils";
import editFailureEscalationHint from "../prompts/latency/edit-failure-escalation.md" with { type: "text" };

export const EDIT_FAILURE_ESCALATION_THRESHOLD = 2;

const kEditFailureEscalation = Symbol("session.editFailureEscalation");

interface PathStreak {
	count: number;
	advised: boolean;
	escalated: boolean;
}

interface SessionWithEditFailures {
	[kEditFailureEscalation]?: Map<string, PathStreak>;
}

export interface EditFailureEscalationResult {
	/** Model-visible advisory once at threshold; undefined otherwise. */
	advisory?: string;
	/** True once when the host should swap to the top model for the next turn. */
	escalateToTop: boolean;
	path: string;
	count: number;
}

function streakMap(session: object): Map<string, PathStreak> {
	const holder = session as SessionWithEditFailures;
	holder[kEditFailureEscalation] ??= new Map();
	return holder[kEditFailureEscalation];
}

/** Normalize edit paths so relative/absolute variants of the same file share a streak. */
export function normalizeEditFailurePath(path: string): string {
	return path.trim().replace(/\\/g, "/");
}

/** Extract the primary path from edit tool arguments (single-file or first of a batch). */
export function editPathFromToolArgs(args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const record = args as Record<string, unknown>;
	if (typeof record.path === "string" && record.path.trim()) return normalizeEditFailurePath(record.path);
	if (typeof record.file_path === "string" && record.file_path.trim()) {
		return normalizeEditFailurePath(record.file_path);
	}
	if (Array.isArray(record.edits)) {
		for (const entry of record.edits) {
			if (!entry || typeof entry !== "object") continue;
			const path = (entry as { path?: unknown }).path;
			if (typeof path === "string" && path.trim()) return normalizeEditFailurePath(path);
		}
	}
	return undefined;
}

/** Clear the per-path streak after a successful edit (or when the path is abandoned). */
export function clearEditFailureEscalation(session: object, path?: string): void {
	const map = (session as SessionWithEditFailures)[kEditFailureEscalation];
	if (!map) return;
	if (path === undefined) {
		map.clear();
		return;
	}
	map.delete(normalizeEditFailurePath(path));
}

/**
 * Record an edit error for `path`. Returns advisory + escalate flag once at the
 * threshold; further identical failures stay silent until success clears the path.
 */
export function noteEditFailureEscalation(session: object, path: string): EditFailureEscalationResult {
	const normalized = normalizeEditFailurePath(path);
	const map = streakMap(session);
	const prev = map.get(normalized);
	if (!prev) {
		map.set(normalized, { count: 1, advised: false, escalated: false });
		return { escalateToTop: false, path: normalized, count: 1 };
	}
	prev.count += 1;
	if (prev.count < EDIT_FAILURE_ESCALATION_THRESHOLD || prev.advised) {
		return { escalateToTop: false, path: normalized, count: prev.count };
	}
	prev.advised = true;
	const escalateToTop = !prev.escalated;
	prev.escalated = true;
	return {
		advisory: prompt.render(editFailureEscalationHint, { path: normalized, count: prev.count }).trim(),
		escalateToTop,
		path: normalized,
		count: prev.count,
	};
}
