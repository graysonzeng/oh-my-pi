/**
 * Per-file edit failure escalation (quality/cost plan P2-E).
 *
 * After {@link EDIT_FAILURE_ESCALATION_THRESHOLD} failed `edit` calls on the
 * same path, advise a forced re-read and signal that the session should escalate
 * to the top model (`@slow`, then `@default`) instead of looping the same edit.
 * Success on that path clears the streak. `escalated` is set only after the host
 * successfully applies a model swap via {@link TurnRecovery.escalateEditFailuresToTopModel};
 * a failed apply stays re-triggerable. When escalation is unavailable (e.g.
 * `retry.modelFallback=false` or already on the top model), the advisory is
 * re-read-only and does not claim an escalation.
 */
import * as path from "node:path";
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
	/**
	 * True while the host should still attempt a top-model swap. Cleared only by
	 * {@link markEditFailureEscalated} after a successful apply (or by success clear).
	 */
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
export function normalizeEditFailurePath(filePath: string, cwd = process.cwd()): string {
	const trimmed = filePath.trim();
	if (!trimmed) return trimmed;
	return path.resolve(cwd, trimmed);
}

/** Extract the primary path from edit tool arguments (single-file or first of a batch). */
export function editPathFromToolArgs(args: unknown, cwd?: string): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const record = args as Record<string, unknown>;
	if (typeof record.path === "string" && record.path.trim()) {
		return normalizeEditFailurePath(record.path, cwd);
	}
	if (typeof record.file_path === "string" && record.file_path.trim()) {
		return normalizeEditFailurePath(record.file_path, cwd);
	}
	if (Array.isArray(record.edits)) {
		for (const entry of record.edits) {
			if (!entry || typeof entry !== "object") continue;
			const entryPath = (entry as { path?: unknown }).path;
			if (typeof entryPath === "string" && entryPath.trim()) {
				return normalizeEditFailurePath(entryPath, cwd);
			}
		}
	}
	return undefined;
}

/** Clear the per-path streak after a successful edit (or when the path is abandoned). */
export function clearEditFailureEscalation(session: object, filePath?: string, cwd?: string): void {
	const map = (session as SessionWithEditFailures)[kEditFailureEscalation];
	if (!map) return;
	if (filePath === undefined) {
		map.clear();
		return;
	}
	map.delete(normalizeEditFailurePath(filePath, cwd));
}

/** Render the model-visible advisory; `escalate` controls the "Escalating…" clause. */
export function formatEditFailureAdvisory(filePath: string, count: number, escalate: boolean): string {
	return prompt.render(editFailureEscalationHint, { path: filePath, count, escalate }).trim();
}

/**
 * Mark that a top-model swap for this path succeeded. Further failures stay silent
 * for escalation until success clears the streak.
 */
export function markEditFailureEscalated(session: object, filePath: string, cwd?: string): void {
	const normalized = normalizeEditFailurePath(filePath, cwd);
	const prev = streakMap(session).get(normalized);
	if (prev) prev.escalated = true;
}

/**
 * Record an edit error for `path`. Returns a re-read advisory once at the
 * threshold. `escalateToTop` stays true until {@link markEditFailureEscalated}
 * (failed applies remain re-triggerable). Pass `escalateAvailable: false` when
 * the host will not attempt a model swap so the advisory omits "Escalating…".
 */
export function noteEditFailureEscalation(
	session: object,
	filePath: string,
	options?: { cwd?: string; escalateAvailable?: boolean },
): EditFailureEscalationResult {
	const normalized = normalizeEditFailurePath(filePath, options?.cwd);
	const map = streakMap(session);
	const prev = map.get(normalized);
	if (!prev) {
		map.set(normalized, { count: 1, advised: false, escalated: false });
		return { escalateToTop: false, path: normalized, count: 1 };
	}
	prev.count += 1;
	if (prev.count < EDIT_FAILURE_ESCALATION_THRESHOLD) {
		return { escalateToTop: false, path: normalized, count: prev.count };
	}
	const escalateToTop = !prev.escalated;
	const escalateAvailable = options?.escalateAvailable !== false;
	if (!prev.advised) {
		prev.advised = true;
		return {
			advisory: formatEditFailureAdvisory(normalized, prev.count, escalateToTop && escalateAvailable),
			escalateToTop,
			path: normalized,
			count: prev.count,
		};
	}
	return { escalateToTop, path: normalized, count: prev.count };
}
