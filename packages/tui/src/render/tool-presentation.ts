/**
 * Presentation classifier for tool results rendered in the transcript.
 * Prefer this over a local `isError` shortcut: a never-invoked synthetic skip
 * and a started abort are not the same card as a failed execute().
 */

export type ToolPresentation = "running" | "succeeded" | "failed" | "aborted" | "skipped";

/** Minimal structured input the classifier needs; adapters pass the full result. */
export interface ClassifiableToolResult {
	details?: unknown;
	isError?: boolean;
}

/**
 * Started-abort source family. `execute()` was entered for every member, so
 * these are never never-invoked placeholders.
 */
const STARTED_ABORT_SOURCES: Record<string, true> = {
	started_aborted_user: true,
	started_aborted_system: true,
	started_aborted_irc: true,
	started_aborted_external: true,
};

function syntheticSourceOf(details: unknown): string | undefined {
	if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
	const record = details as { __synthetic?: unknown; source?: unknown };
	if (record.__synthetic !== true) return undefined;
	return typeof record.source === "string" ? record.source : undefined;
}

/** Classify a tool result's presentation status. */
export function classifyToolPresentation(result: ClassifiableToolResult): ToolPresentation {
	if (typeof result.details === "object" && result.details !== null && !Array.isArray(result.details)) {
		const details = result.details as { __synthetic?: unknown; executed?: unknown };
		if (details.__synthetic === true && details.executed === false) return "skipped";
	}
	const source = syntheticSourceOf(result.details);
	if (source !== undefined && STARTED_ABORT_SOURCES[source] === true) return "aborted";
	if (result.isError === true) return "failed";
	return "succeeded";
}
