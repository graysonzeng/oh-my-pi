/**
 * Shared presentation classifier for tool results.
 *
 * Every live/replay/export surface (TUI event controller, tool cards, read
 * group, transcript rebuild, ACP, commit terminal, collaboration, share/export,
 * HTML) MUST classify presentation through this single owner instead of
 * inferring status from `isError` or message text. The agent loop owns the
 * execution truth (structured `SyntheticToolResultDetails`); this module turns
 * that truth into the presentation status.
 *
 * Order of precedence (never reorder):
 * 1. never-invoked synthetic (`__synthetic === true && executed === false`)
 *    → `skipped`; the provider envelope may still be error-shaped.
 * 2. started-abort family (`started_aborted_*`, `executed:true`) → `aborted`.
 * 3. provider-envelope error → `failed`.
 * 4. otherwise `succeeded`.
 *
 * Legacy/missing details: a result with `isError:true` but no structured
 * marker conservatively classifies `failed` (never `skipped`) — compatibility
 * handling, not permission to emit unstructured new skips.
 */
import type { SyntheticResultSource } from "@oh-my-pi/pi-agent-core";

export type ToolPresentation = "running" | "succeeded" | "failed" | "aborted" | "skipped";

/** Minimal structured input the classifier needs; adapters pass the full result. */
export interface ClassifiableToolResult {
	details?: unknown;
	isError?: boolean;
}

/**
 * Static started-abort source family. `execute()` was entered for every member,
 * so these are never never-invoked placeholders.
 */
const STARTED_ABORT_SOURCES: Record<string, true> = {
	started_aborted_user: true,
	started_aborted_system: true,
	started_aborted_irc: true,
	started_aborted_external: true,
};

/** Whether the source is a started-abort cause (execute() was entered). */
export function isStartedAbortSource(source: SyntheticResultSource | undefined): boolean {
	return source !== undefined && STARTED_ABORT_SOURCES[source] === true;
}

function syntheticSourceOf(details: unknown): SyntheticResultSource | undefined {
	if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
	const record = details as { __synthetic?: unknown; source?: unknown };
	if (record.__synthetic !== true) return undefined;
	return typeof record.source === "string" ? (record.source as SyntheticResultSource) : undefined;
}

/**
 * Classify a tool result's presentation status. Prefer this over any local
 * `isError` shortcut; a local shortcut is a contract failure.
 */
export function classifyToolPresentation(result: ClassifiableToolResult): ToolPresentation {
	if (typeof result.details === "object" && result.details !== null && !Array.isArray(result.details)) {
		const details = result.details as { __synthetic?: unknown; executed?: unknown };
		if (details.__synthetic === true && details.executed === false) return "skipped";
	}
	if (isStartedAbortSource(syntheticSourceOf(result.details))) return "aborted";
	if (result.isError === true) return "failed";
	return "succeeded";
}

/**
 * True when the result is a structured never-invoked synthetic skip. Distinct
 * from the provider envelope's `isError`; consumers suppress failure UI for
 * these results (e.g. the Todo "update failed" warning).
 */
export function isSkippedSyntheticResult(result: ClassifiableToolResult): boolean {
	if (typeof result.details !== "object" || result.details === null || Array.isArray(result.details)) return false;
	const details = result.details as { __synthetic?: unknown; executed?: unknown };
	return details.__synthetic === true && details.executed === false;
}

/**
 * True when the result is a started-abort (execute() entered, then cut off).
 * Never present these as skipped/not-executed.
 */
export function isStartedAbortedResult(result: ClassifiableToolResult): boolean {
	return isStartedAbortSource(syntheticSourceOf(result.details));
}

/** Human-readable label for optional source display on skipped/aborted cards. */
export function toolPresentationLabel(status: ToolPresentation, source?: SyntheticResultSource | undefined): string {
	switch (status) {
		case "skipped":
			return source === "prestart_budget"
				? "skipped (budget)"
				: source === "prestart_user_cancel"
					? "skipped (cancelled)"
					: source === "prestart_system_cancel"
						? "skipped (advisory)"
						: source === "prestart_irc_cancel"
							? "skipped (interrupt)"
							: source === "prestart_resource_conflict"
								? "skipped (resource conflict)"
								: "skipped";
		case "aborted":
			return source === "started_aborted_system"
				? "aborted (advisory)"
				: source === "started_aborted_irc"
					? "aborted (interrupt)"
					: "aborted";
		case "failed":
			return "failed";
		case "succeeded":
			return "succeeded";
		case "running":
			return "running";
	}
}
