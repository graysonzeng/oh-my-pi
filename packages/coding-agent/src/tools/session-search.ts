import { type } from "@oh-my-pi/omptype";
import type { AgentMessage, AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { LatencyArmSnapshotV1 } from "../latency/arms";
import sessionSearchDescription from "../prompts/tools/session-search.md" with { type: "text" };
import type { CompactionEntry, SessionEntry } from "../session/session-entries";
import { DEFAULT_MAX_BYTES, OutputSink, truncateHeadBytes } from "../session/streaming-output";
import type { ToolSession } from ".";
import { toolResult } from "./tool-result";

const sessionSearchSchema = type({
	query: type("string").describe(
		"Substring matched against assistant text, tool name, and JSON.stringify(arguments).",
	),
	"include_active?": type("boolean").describe(
		"If true, also search the post-firstKeptEntryId active segment. Default false.",
	),
	"limit?": type("number").describe("Max hits. Default 20, hard cap 50."),
});

export type SessionSearchParams = typeof sessionSearchSchema.infer;

export type SessionSearchZone = "compacted" | "active";

export interface SessionSearchHit {
	entryId: string;
	zone: SessionSearchZone;
	role: "assistant" | "toolCall" | "toolResult";
	name?: string;
	args_snippet?: string;
	text: string;
	isError?: boolean;
}

const DISABLED_TEXT = "session_search disabled by arm snapshot";
const MISSING_MANAGER_TEXT = "session_search requires sessionManager";
const INCOMPLETE_JOURNAL_TEXT = "session_search journal is incomplete: firstKeptEntryId was not found";

function currentSnapshot(session: ToolSession): LatencyArmSnapshotV1 | undefined {
	return session.getLatencyArmSnapshot?.();
}

function latestCompaction(path: SessionEntry[]): CompactionEntry | undefined {
	for (let index = path.length - 1; index >= 0; index--) {
		const entry = path[index];
		if (entry?.type === "compaction") return entry;
	}
	return undefined;
}

function assistantText(message: Extract<AgentMessage, { role: "assistant" }>): string {
	const parts: string[] = [];
	for (const part of message.content) {
		if (part.type === "text") parts.push(part.text);
	}
	return parts.join("\n");
}

function toolResultText(message: Extract<AgentMessage, { role: "toolResult" }>): string {
	const parts: string[] = [];
	for (const part of message.content) {
		if (part.type === "text") parts.push(part.text);
	}
	return parts.join("\n");
}

function matchesQuery(haystack: string, query: string): boolean {
	return haystack.includes(query);
}

export function partitionBranchForSearch(path: SessionEntry[]): {
	compacted: SessionEntry[];
	active: SessionEntry[];
	foundFirstKept: boolean;
	hasCompaction: boolean;
} {
	const compaction = latestCompaction(path);
	if (!compaction) {
		return { compacted: [], active: [...path], foundFirstKept: true, hasCompaction: false };
	}
	const pivot = path.findIndex(entry => entry.id === compaction.firstKeptEntryId);
	if (pivot < 0) {
		return { compacted: [], active: [], foundFirstKept: false, hasCompaction: true };
	}
	return {
		compacted: path.slice(0, pivot),
		active: path.slice(pivot),
		foundFirstKept: true,
		hasCompaction: true,
	};
}

export function collectSessionSearchHits(
	path: SessionEntry[],
	query: string,
	includeActive: boolean,
	limit: number,
): { hits: SessionSearchHit[]; incomplete: boolean } {
	const zones = partitionBranchForSearch(path);
	if (!zones.foundFirstKept) return { hits: [], incomplete: true };
	const hits: SessionSearchHit[] = [];
	const scan = (entries: SessionEntry[], zone: SessionSearchZone): void => {
		for (const entry of entries) {
			if (hits.length >= limit) return;
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role === "assistant") {
				const text = assistantText(message);
				if (matchesQuery(text, query)) {
					hits.push({ entryId: entry.id, zone, role: "assistant", text });
				}
				for (const part of message.content) {
					if (hits.length >= limit) return;
					if (part.type !== "toolCall") continue;
					const argsJson = JSON.stringify(part.arguments);
					if (matchesQuery(part.name, query) || matchesQuery(argsJson, query)) {
						hits.push({
							entryId: entry.id,
							zone,
							role: "toolCall",
							name: part.name,
							args_snippet: truncateHeadBytes(argsJson, 256).text,
							text: argsJson,
						});
					}
				}
				continue;
			}
			if (message.role === "toolResult") {
				const text = toolResultText(message);
				if (matchesQuery(message.toolName, query) || matchesQuery(text, query)) {
					hits.push({
						entryId: entry.id,
						zone,
						role: "toolResult",
						name: message.toolName,
						text,
						isError: message.isError,
					});
				}
			}
		}
	};
	scan(zones.compacted, "compacted");
	if (includeActive) scan(zones.active, "active");
	return { hits, incomplete: false };
}

export class SessionSearchTool implements AgentTool<typeof sessionSearchSchema> {
	readonly name = "session_search";
	readonly label = "Session Search";
	readonly description = sessionSearchDescription;
	readonly parameters = sessionSearchSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;
	readonly summary = "Search compacted session journal entries on the current branch";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): SessionSearchTool | null {
		if (currentSnapshot(session)?.arms.dsh_session_search !== true) return null;
		return new SessionSearchTool(session);
	}

	async execute(_id: string, params: SessionSearchParams): Promise<AgentToolResult> {
		if (currentSnapshot(this.session)?.arms.dsh_session_search !== true) {
			return toolResult().text(DISABLED_TEXT).error().done();
		}
		const manager = this.session.sessionManager;
		if (!manager) {
			return toolResult().text(MISSING_MANAGER_TEXT).error().done();
		}
		let path: SessionEntry[];
		try {
			path = manager.getBranch();
		} catch {
			this.session.recordDshGetBranchError?.();
			return toolResult().text("session_search getBranch failed").error().done();
		}
		const limit = Math.min(Math.max(Math.floor(params.limit ?? 20), 1), 50);
		const { hits, incomplete } = collectSessionSearchHits(path, params.query, params.include_active === true, limit);
		if (incomplete) {
			return toolResult().text(INCOMPLETE_JOURNAL_TEXT).error().done();
		}
		this.session.markLatencyArmFired?.("dsh_session_search");
		const sink = new OutputSink({ spillThreshold: DEFAULT_MAX_BYTES });
		for (const hit of hits) {
			const args = hit.args_snippet ? ` args=${hit.args_snippet}` : "";
			const err = hit.isError ? " error=true" : "";
			sink.push(
				`${hit.zone} ${hit.role} ${hit.entryId}${hit.name ? ` ${hit.name}` : ""}${args}${err}\n${hit.text}\n\n`,
			);
		}
		const dumped = await sink.dump();
		return toolResult()
			.text(dumped.output || "No matching journal entries.")
			.truncationFromSummary(dumped, { direction: "head" })
			.done();
	}
}
