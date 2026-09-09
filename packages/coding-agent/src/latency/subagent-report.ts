/**
 * Offline subagent baseline from existing session JSONL.
 * Consumes historical fields only. Does not infer passed, e2e, or verification.
 */
import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";
import { computeActiveWallMs } from "./active-wall";
import { sha256Hex } from "./stable-serialize";

export interface CoverageCount {
	present: number;
	unknown: number;
}

export interface PercentileSummary {
	n: number;
	p50: number | null;
	p90: number | null;
}

export interface SubagentBaselineReport {
	e2eMs: null;
	criticalPathMs: null;
	taskCompletionMs: null;
	uncomputableFromHistory: string[];
	sessions: {
		parentCount: number;
		childCount: number;
		unlinkedChildCount: number;
		spawnCalls: number;
		skippedLines: number;
	};
	coverage: {
		parentChildLink: CoverageCount;
		model: CoverageCount;
		effort: CoverageCount;
		completionKind: CoverageCount;
		parentFinalVerification: CoverageCount;
		ttft: CoverageCount;
		generation: CoverageCount;
		cache: CoverageCount;
		spawnQueueMs: CoverageCount;
		requestPhaseQueueMs: CoverageCount;
	};
	taskCallMs: PercentileSummary;
	parentFileWallMs: PercentileSummary;
	parentActiveWallMs: PercentileSummary;
	childFileWallMs: PercentileSummary;
	childActiveWallMs: PercentileSummary;
	ttftMs: PercentileSummary;
	generationMs: PercentileSummary;
	spawnQueueMs: PercentileSummary;
	usage: {
		input: number | null;
		output: number | null;
		cacheRead: number | null;
		cacheWrite: number | null;
		costTotal: number | null;
	};
	models: Record<string, number>;
	spawnEfforts: Record<string, number>;
	thinkingLevels: Record<string, number>;
	completionKinds: Record<string, number>;
	parentFinalVerification: { passed: 0; failed: 0; unknown: number };
	overlappingChildIntervals: number;
	unmatchedToolResults: number;
	repeatedReads: { key: string; count: number }[];
	toolFailures: { tool: string; calls: number; errors: number }[];
}

export interface ParsedSession {
	path: string;
	stem: string;
	folder: string;
	isSubagent: boolean;
	parentPathFromLayout?: string;
	parentSessionHeader?: string;
	id?: string;
	skippedLines: number;
	firstTs: number | null;
	lastTs: number | null;
	timestampCount: number;
	assistantTimestamps: number[];
	usageRequests: UsageRequest[];
	toolCalls: ParsedToolCall[];
	toolResults: ParsedToolResult[];
	thinkingLevels: string[];
}

interface UsageRequest {
	model: string | null;
	ttftMs: number | null;
	generationMs: number | null;
	input: number | null;
	output: number | null;
	cacheRead: number | null;
	cacheWrite: number | null;
	costTotal: number | null;
}

interface SpawnSpec {
	agent: string | null;
	labels: string[];
	efforts: Array<string | null>;
}

interface ParsedToolCall {
	callId: string;
	name: string;
	ts: number | null;
	readPath?: string;
	spawn?: SpawnSpec;
}

interface SpawnResultRow {
	id: string | null;
	completionKind: string | null;
	spawnQueueMs: number | null;
	requestPhaseQueueMs: number | null;
}

interface ParsedToolResult {
	callId: string;
	name: string;
	ts: number | null;
	isError: boolean;
	spawnRows?: SpawnResultRow[];
}

const KNOWN_COMPLETION_KINDS: Record<string, true> = {
	completed: true,
	budget_stop: true,
	timeout: true,
	hard_abort: true,
};
const UNCOMPUTABLE_FROM_HISTORY = [
	"parentFinalVerification",
	"e2eCriticalPathMs",
	"taskCompletionMs",
	"providerQueueMs",
];

function asNonNegativeNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Group key for repeated-read detection: keep URLs, strip trailing line/raw selectors. */
export function normalizeReadPath(p: string): string {
	let out = p;
	for (;;) {
		const next = out.replace(/:(?:raw|conflicts|[0-9][0-9+\-,]*)$/i, "");
		if (next === out) return out;
		out = next;
	}
}

export function sessionLayoutFromPath(filePath: string): {
	folder: string;
	stem: string;
	isSubagent: boolean;
	parentPathFromLayout?: string;
} {
	const stem = path.basename(filePath, ".jsonl");
	const parts = filePath.split(path.sep);
	const sessionsIdx = parts.lastIndexOf("sessions");
	if (sessionsIdx === -1 || sessionsIdx + 2 >= parts.length) {
		return { folder: path.basename(path.dirname(filePath)), stem, isSubagent: false };
	}
	const folder = parts[sessionsIdx + 1]!;
	const rest = parts.slice(sessionsIdx + 2);
	if (rest.length === 1) return { folder, stem, isSubagent: false };
	const parentId = rest[0]!;
	return {
		folder,
		stem,
		isSubagent: true,
		parentPathFromLayout: [...parts.slice(0, sessionsIdx + 2), `${parentId}.jsonl`].join(path.sep),
	};
}

function parseJsonlRecords(text: string): { records: Record<string, unknown>[]; skippedLines: number } {
	const encoded = new TextEncoder().encode(text.endsWith("\n") ? text : `${text}\n`);
	let buffer: Uint8Array = encoded;
	const records: Record<string, unknown>[] = [];
	let skippedLines = 0;
	while (buffer.length > 0) {
		const chunk = Bun.JSONL.parseChunk(buffer);
		for (const value of chunk.values) {
			if (isRecord(value)) records.push(value);
			else skippedLines++;
		}
		if (chunk.error) {
			const nextNewline = buffer.indexOf(0x0a, chunk.read);
			if (nextNewline === -1) {
				skippedLines++;
				break;
			}
			let nonWhitespace = false;
			for (let index = chunk.read; index < nextNewline; index++) {
				const byte = buffer[index];
				if (byte !== 0x09 && byte !== 0x0d && byte !== 0x20) {
					nonWhitespace = true;
					break;
				}
			}
			if (nonWhitespace) skippedLines++;
			buffer = buffer.subarray(nextNewline + 1);
			continue;
		}
		if (chunk.read === 0) break;
		buffer = buffer.subarray(chunk.read);
		if (chunk.done) break;
	}
	return { records, skippedLines };
}

function entryTimestamp(entry: Record<string, unknown>, message: Record<string, unknown> | undefined): number | null {
	const fromMessage = asNonNegativeNumber(message?.timestamp);
	if (fromMessage !== null) return fromMessage;
	if (typeof entry.timestamp === "string") {
		const parsed = Date.parse(entry.timestamp);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return asNonNegativeNumber(entry.timestamp);
}

function spawnLabel(task: Record<string, unknown>): string | null {
	if (typeof task.name === "string" && task.name.trim()) return task.name.trim();
	if (typeof task.id === "string" && task.id.trim()) return task.id.trim();
	return null;
}

function parseSpawnArgs(args: Record<string, unknown>): SpawnSpec {
	const labels: string[] = [];
	const efforts: Array<string | null> = [];
	if (Array.isArray(args.tasks)) {
		for (const item of args.tasks) {
			if (!isRecord(item)) continue;
			const label = spawnLabel(item);
			if (label) labels.push(label);
			efforts.push(typeof item.effort === "string" && item.effort.trim() ? item.effort.trim() : null);
		}
	} else {
		const label = spawnLabel(args);
		if (label) labels.push(label);
		efforts.push(typeof args.effort === "string" && args.effort.trim() ? args.effort.trim() : null);
	}
	return {
		agent: typeof args.agent === "string" && args.agent.trim() ? args.agent.trim() : null,
		labels,
		efforts,
	};
}

function parseSpawnRows(details: unknown): SpawnResultRow[] | undefined {
	if (!isRecord(details) || !Array.isArray(details.results)) return undefined;
	const rows: SpawnResultRow[] = [];
	for (const item of details.results) {
		if (!isRecord(item)) continue;
		let requestPhaseQueueMs: number | null = null;
		const metrics = isRecord(item.reviewMetrics) ? item.reviewMetrics : undefined;
		if (metrics && Array.isArray(metrics.requestPhases)) {
			for (const phase of metrics.requestPhases) {
				if (!isRecord(phase)) continue;
				const queueMs = asNonNegativeNumber(phase.queueMs);
				if (queueMs !== null) {
					requestPhaseQueueMs = queueMs;
					break;
				}
			}
		}
		const kind = typeof item.completionKind === "string" ? item.completionKind : null;
		rows.push({
			id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : null,
			completionKind: kind !== null && KNOWN_COMPLETION_KINDS[kind] === true ? kind : null,
			spawnQueueMs: metrics ? asNonNegativeNumber(metrics.spawnQueueMs) : null,
			requestPhaseQueueMs,
		});
	}
	return rows;
}

function touchTs(session: ParsedSession, ts: number | null): void {
	if (ts === null) return;
	session.timestampCount++;
	if (session.firstTs === null || ts < session.firstTs) session.firstTs = ts;
	if (session.lastTs === null || ts > session.lastTs) session.lastTs = ts;
}

function parseToolCall(block: Record<string, unknown>, ts: number | null): ParsedToolCall | undefined {
	if (block.type !== "toolCall") return undefined;
	const name = typeof block.name === "string" && block.name ? block.name : "?";
	const callId = typeof block.id === "string" ? block.id : "";
	const args = isRecord(block.arguments) ? block.arguments : undefined;
	const call: ParsedToolCall = { callId, name, ts };
	if (name === "read" && args && typeof args.path === "string" && args.path) {
		call.readPath = normalizeReadPath(args.path);
	}
	if (name === "task" && args) call.spawn = parseSpawnArgs(args);
	return call;
}

function parseUsageRequest(msg: Record<string, unknown>): UsageRequest {
	const durationMs = asNonNegativeNumber(msg.duration);
	const ttftMs = asNonNegativeNumber(msg.ttft);
	const usage = isRecord(msg.usage) ? msg.usage : undefined;
	const cost = usage && isRecord(usage.cost) ? asNonNegativeNumber(usage.cost.total) : null;
	return {
		model: typeof msg.model === "string" && msg.model ? msg.model : null,
		ttftMs,
		generationMs: durationMs !== null && ttftMs !== null && durationMs >= ttftMs ? durationMs - ttftMs : null,
		input: usage ? asNonNegativeNumber(usage.input) : null,
		output: usage ? asNonNegativeNumber(usage.output) : null,
		cacheRead: usage ? asNonNegativeNumber(usage.cacheRead) : null,
		cacheWrite: usage ? asNonNegativeNumber(usage.cacheWrite) : null,
		costTotal: cost,
	};
}

export function parseSessionRecords(records: readonly unknown[], filePath: string): ParsedSession {
	const layout = sessionLayoutFromPath(filePath);
	const session: ParsedSession = {
		path: filePath,
		stem: layout.stem,
		folder: layout.folder,
		isSubagent: layout.isSubagent,
		parentPathFromLayout: layout.parentPathFromLayout,
		skippedLines: 0,
		firstTs: null,
		lastTs: null,
		timestampCount: 0,
		assistantTimestamps: [],
		usageRequests: [],
		toolCalls: [],
		toolResults: [],
		thinkingLevels: [],
	};
	for (const raw of records) {
		if (!isRecord(raw)) continue;
		const type = raw.type;
		if (type === "session") {
			if (typeof raw.id === "string" && raw.id) session.id = raw.id;
			if (typeof raw.parentSession === "string" && raw.parentSession) {
				session.parentSessionHeader = raw.parentSession;
			}
			continue;
		}
		if (type === "thinking_level_change" && typeof raw.thinkingLevel === "string" && raw.thinkingLevel) {
			session.thinkingLevels.push(raw.thinkingLevel);
			continue;
		}
		if (type !== "message") continue;
		const msg = isRecord(raw.message) ? raw.message : undefined;
		if (!msg) continue;
		const ts = entryTimestamp(raw, msg);
		touchTs(session, ts);
		if (msg.role === "assistant") {
			if (ts !== null) session.assistantTimestamps.push(ts);
			session.usageRequests.push(parseUsageRequest(msg));
			if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (!isRecord(block)) continue;
					const call = parseToolCall(block, ts);
					if (call) session.toolCalls.push(call);
				}
			}
			continue;
		}
		if (msg.role === "toolResult") {
			session.toolResults.push({
				callId: typeof msg.toolCallId === "string" ? msg.toolCallId : "",
				name: typeof msg.toolName === "string" && msg.toolName ? msg.toolName : "?",
				ts,
				isError: msg.isError === true,
				spawnRows: parseSpawnRows(msg.details),
			});
		}
	}
	return session;
}

export function parseSessionJsonl(text: string, filePath: string): ParsedSession {
	const { records, skippedLines } = parseJsonlRecords(text);
	const session = parseSessionRecords(records, filePath);
	session.skippedLines = skippedLines;
	return session;
}

function emptyCoverage(): CoverageCount {
	return { present: 0, unknown: 0 };
}

function cover(count: CoverageCount, present: boolean): void {
	if (present) count.present++;
	else count.unknown++;
}

function bump(map: Record<string, number>, key: string): void {
	map[key] = (map[key] ?? 0) + 1;
}

function addPresent(sum: number | null, value: number | null): number | null {
	if (value === null) return sum;
	return (sum ?? 0) + value;
}

function percentile(sorted: number[], p: number): number | null {
	if (sorted.length === 0) return null;
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

function summarizeMs(values: number[]): PercentileSummary {
	const sorted = values.slice().sort((a, b) => a - b);
	if (sorted.length === 0) return { n: 0, p50: null, p90: null };
	return { n: sorted.length, p50: percentile(sorted, 0.5), p90: percentile(sorted, 0.9) };
}

function fileWallMs(session: ParsedSession): number | null {
	if (session.timestampCount < 2 || session.firstTs === null || session.lastTs === null) return null;
	if (session.lastTs < session.firstTs) return null;
	return session.lastTs - session.firstTs;
}

function parentOf(
	child: ParsedSession,
	byPath: Map<string, ParsedSession>,
	byId: Map<string, ParsedSession>,
): ParsedSession | undefined {
	if (child.parentPathFromLayout) {
		const fromLayout = byPath.get(child.parentPathFromLayout);
		if (fromLayout) return fromLayout;
	}
	if (child.parentSessionHeader) {
		return byPath.get(child.parentSessionHeader) ?? byId.get(child.parentSessionHeader);
	}
	return undefined;
}

interface PairedCall {
	call: ParsedToolCall;
	result: ParsedToolResult;
}

function pairCalls(session: ParsedSession): {
	pairs: PairedCall[];
	unmatchedResults: number;
	unmatchedCalls: ParsedToolCall[];
} {
	const pending = new Map<string, ParsedToolCall[]>();
	const unmatchedCalls: ParsedToolCall[] = [];
	for (const call of session.toolCalls) {
		if (!call.callId) {
			unmatchedCalls.push(call);
			continue;
		}
		const queue = pending.get(call.callId);
		if (queue) queue.push(call);
		else pending.set(call.callId, [call]);
	}
	const pairs: PairedCall[] = [];
	let unmatchedResults = 0;
	for (const result of session.toolResults) {
		if (!result.callId) {
			unmatchedResults++;
			continue;
		}
		const queue = pending.get(result.callId);
		const call = queue?.shift();
		if (!call) {
			unmatchedResults++;
			continue;
		}
		pairs.push({ call, result });
	}
	for (const queue of pending.values()) unmatchedCalls.push(...queue);
	return { pairs, unmatchedResults, unmatchedCalls };
}

function spawnRowsOf(call: ParsedToolCall, result: ParsedToolResult | undefined): SpawnResultRow[] {
	if (result?.spawnRows && result.spawnRows.length > 0) return result.spawnRows;
	if (call.spawn && call.spawn.labels.length > 0) {
		return call.spawn.labels.map(id => ({
			id,
			completionKind: null,
			spawnQueueMs: null,
			requestPhaseQueueMs: null,
		}));
	}
	return [{ id: null, completionKind: null, spawnQueueMs: null, requestPhaseQueueMs: null }];
}

export function buildSubagentBaselineReport(sessions: readonly ParsedSession[]): SubagentBaselineReport {
	const byPath = new Map<string, ParsedSession>();
	const byId = new Map<string, ParsedSession>();
	const parents: ParsedSession[] = [];
	const children: ParsedSession[] = [];
	for (const session of sessions) {
		byPath.set(session.path, session);
		if (session.id) byId.set(session.id, session);
		if (session.isSubagent) children.push(session);
		else parents.push(session);
	}

	const coverage = {
		parentChildLink: emptyCoverage(),
		model: emptyCoverage(),
		effort: emptyCoverage(),
		completionKind: emptyCoverage(),
		parentFinalVerification: emptyCoverage(),
		ttft: emptyCoverage(),
		generation: emptyCoverage(),
		cache: emptyCoverage(),
		spawnQueueMs: emptyCoverage(),
		requestPhaseQueueMs: emptyCoverage(),
	};
	const taskCallSamples: number[] = [];
	const parentFileWallSamples: number[] = [];
	const parentActiveWallSamples: number[] = [];
	const childFileWallSamples: number[] = [];
	const childActiveWallSamples: number[] = [];
	const ttftSamples: number[] = [];
	const generationSamples: number[] = [];
	const spawnQueueSamples: number[] = [];
	const models: Record<string, number> = {};
	const spawnEfforts: Record<string, number> = {};
	const thinkingLevels: Record<string, number> = {};
	const completionKinds: Record<string, number> = {};
	const readCountsByScope = new Map<string, Map<string, number>>();
	const toolCallCounts = new Map<string, number>();
	const toolErrors = new Map<string, number>();
	let unmatchedToolResults = 0;
	let spawnCalls = 0;
	let overlappingChildIntervals = 0;
	let skippedLines = 0;
	let usageInput: number | null = null;
	let usageOutput: number | null = null;
	let usageCacheRead: number | null = null;
	let usageCacheWrite: number | null = null;
	let usageCost: number | null = null;

	const childrenByParent = new Map<string, ParsedSession[]>();
	let unlinkedChildCount = 0;
	for (const child of children) {
		const parent = parentOf(child, byPath, byId);
		if (!parent) {
			unlinkedChildCount++;
			cover(coverage.parentChildLink, false);
			continue;
		}
		cover(coverage.parentChildLink, true);
		const list = childrenByParent.get(parent.path);
		if (list) list.push(child);
		else childrenByParent.set(parent.path, [child]);
	}

	for (const session of sessions) {
		skippedLines += session.skippedLines;
		for (const level of session.thinkingLevels) bump(thinkingLevels, level);
		for (const request of session.usageRequests) {
			cover(coverage.model, request.model !== null);
			if (request.model) bump(models, request.model);
			cover(coverage.ttft, request.ttftMs !== null);
			cover(coverage.generation, request.generationMs !== null);
			cover(coverage.cache, request.cacheRead !== null && request.cacheWrite !== null);
			if (request.ttftMs !== null) ttftSamples.push(request.ttftMs);
			if (request.generationMs !== null) generationSamples.push(request.generationMs);
			usageInput = addPresent(usageInput, request.input);
			usageOutput = addPresent(usageOutput, request.output);
			usageCacheRead = addPresent(usageCacheRead, request.cacheRead);
			usageCacheWrite = addPresent(usageCacheWrite, request.cacheWrite);
			usageCost = addPresent(usageCost, request.costTotal);
		}
		const scope = parentOf(session, byPath, byId)?.path ?? session.path;
		for (const call of session.toolCalls) {
			toolCallCounts.set(call.name, (toolCallCounts.get(call.name) ?? 0) + 1);
			if (call.readPath) {
				let counts = readCountsByScope.get(scope);
				if (!counts) {
					counts = new Map();
					readCountsByScope.set(scope, counts);
				}
				counts.set(call.readPath, (counts.get(call.readPath) ?? 0) + 1);
			}
		}
		for (const result of session.toolResults) {
			if (result.isError) toolErrors.set(result.name, (toolErrors.get(result.name) ?? 0) + 1);
		}
	}

	for (const parent of parents) {
		const fileWall = fileWallMs(parent);
		if (fileWall !== null) parentFileWallSamples.push(fileWall);
		const activeWall = computeActiveWallMs(parent.assistantTimestamps);
		if (activeWall !== undefined) parentActiveWallSamples.push(activeWall);
		cover(coverage.parentFinalVerification, false);

		const kids = childrenByParent.get(parent.path) ?? [];
		const intervals: Array<{ start: number; end: number }> = [];
		for (const child of kids) {
			const childFile = fileWallMs(child);
			if (childFile !== null) {
				childFileWallSamples.push(childFile);
				if (child.firstTs !== null && child.lastTs !== null) {
					intervals.push({ start: child.firstTs, end: child.lastTs });
				}
			}
			const childActive = computeActiveWallMs(child.assistantTimestamps);
			if (childActive !== undefined) childActiveWallSamples.push(childActive);
		}
		for (let i = 0; i < intervals.length; i++) {
			for (let j = i + 1; j < intervals.length; j++) {
				if (intervals[i]!.start < intervals[j]!.end && intervals[j]!.start < intervals[i]!.end) {
					overlappingChildIntervals++;
				}
			}
		}
	}

	for (const session of sessions) {
		const { pairs, unmatchedResults, unmatchedCalls } = pairCalls(session);
		unmatchedToolResults += unmatchedResults;
		const recordSpawn = (call: ParsedToolCall, result: ParsedToolResult | undefined): void => {
			spawnCalls++;
			if (result && call.ts !== null && result.ts !== null && result.ts >= call.ts) {
				taskCallSamples.push(result.ts - call.ts);
			}
			if (call.spawn) {
				for (const effort of call.spawn.efforts) {
					cover(coverage.effort, effort !== null);
					if (effort) bump(spawnEfforts, effort);
				}
			}
			for (const row of spawnRowsOf(call, result)) {
				cover(coverage.completionKind, row.completionKind !== null);
				if (row.completionKind) bump(completionKinds, row.completionKind);
				else bump(completionKinds, "unknown");
				cover(coverage.spawnQueueMs, row.spawnQueueMs !== null);
				if (row.spawnQueueMs !== null) spawnQueueSamples.push(row.spawnQueueMs);
				cover(coverage.requestPhaseQueueMs, row.requestPhaseQueueMs !== null);
			}
		};
		for (const pair of pairs) {
			if (pair.call.spawn) recordSpawn(pair.call, pair.result);
		}
		for (const call of unmatchedCalls) {
			if (call.spawn) recordSpawn(call, undefined);
		}
	}

	const repeatedReads: { key: string; count: number }[] = [];
	for (const [scope, counts] of readCountsByScope) {
		for (const [normPath, count] of counts) {
			if (count < 2) continue;
			repeatedReads.push({ key: sha256Hex(`${scope}\0${normPath}`), count });
		}
	}
	repeatedReads.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
	const toolFailures = [...toolErrors.entries()]
		.map(([tool, errors]) => ({ tool, calls: toolCallCounts.get(tool) ?? 0, errors }))
		.sort((a, b) => a.tool.localeCompare(b.tool));

	return {
		e2eMs: null,
		criticalPathMs: null,
		taskCompletionMs: null,
		uncomputableFromHistory: [...UNCOMPUTABLE_FROM_HISTORY],
		sessions: {
			parentCount: parents.length,
			childCount: children.length,
			unlinkedChildCount,
			spawnCalls,
			skippedLines,
		},
		coverage,
		taskCallMs: summarizeMs(taskCallSamples),
		parentFileWallMs: summarizeMs(parentFileWallSamples),
		parentActiveWallMs: summarizeMs(parentActiveWallSamples),
		childFileWallMs: summarizeMs(childFileWallSamples),
		childActiveWallMs: summarizeMs(childActiveWallSamples),
		ttftMs: summarizeMs(ttftSamples),
		generationMs: summarizeMs(generationSamples),
		spawnQueueMs: summarizeMs(spawnQueueSamples),
		usage: {
			input: usageInput,
			output: usageOutput,
			cacheRead: usageCacheRead,
			cacheWrite: usageCacheWrite,
			costTotal: usageCost,
		},
		models,
		spawnEfforts,
		thinkingLevels,
		completionKinds,
		parentFinalVerification: { passed: 0, failed: 0, unknown: parents.length },
		overlappingChildIntervals,
		unmatchedToolResults,
		repeatedReads,
		toolFailures,
	};
}

function fmtPct(summary: PercentileSummary): string {
	if (summary.n === 0) return "n=0 p50=null p90=null";
	return `n=${summary.n} p50=${summary.p50} p90=${summary.p90}`;
}

function fmtCover(count: CoverageCount): string {
	return `present=${count.present} unknown=${count.unknown}`;
}

export function formatSubagentBaselineReport(report: SubagentBaselineReport): string {
	const lines = [
		"subagent baseline (offline, no upload, no conversation bodies)",
		`sessions: parents=${report.sessions.parentCount} children=${report.sessions.childCount} unlinked=${report.sessions.unlinkedChildCount} spawns=${report.sessions.spawnCalls} skippedLines=${report.sessions.skippedLines}`,
		"uncomputable from history:",
		...report.uncomputableFromHistory.map(field => `  - ${field}`),
		"missing timings stay null; completionKind is never inferred from exit/stop; concurrent children are not summed as e2e",
		"coverage:",
		`  parentChildLink          ${fmtCover(report.coverage.parentChildLink)}`,
		`  model                    ${fmtCover(report.coverage.model)}`,
		`  effort                   ${fmtCover(report.coverage.effort)}`,
		`  completionKind           ${fmtCover(report.coverage.completionKind)}`,
		`  parentFinalVerification  ${fmtCover(report.coverage.parentFinalVerification)}`,
		`  ttft                     ${fmtCover(report.coverage.ttft)}`,
		`  generation               ${fmtCover(report.coverage.generation)}`,
		`  cache                    ${fmtCover(report.coverage.cache)}`,
		`  spawnQueueMs             ${fmtCover(report.coverage.spawnQueueMs)}`,
		`  requestPhaseQueueMs      ${fmtCover(report.coverage.requestPhaseQueueMs)}`,
		"timings (timeouts included; null when n=0; taskCallMs is toolCall→result, not parent blocked wait):",
		`  taskCallMs               ${fmtPct(report.taskCallMs)}`,
		`  parentFileWallMs         ${fmtPct(report.parentFileWallMs)}`,
		`  parentActiveWallMs       ${fmtPct(report.parentActiveWallMs)}`,
		`  childFileWallMs          ${fmtPct(report.childFileWallMs)}`,
		`  childActiveWallMs        ${fmtPct(report.childActiveWallMs)}`,
		`  ttftMs                   ${fmtPct(report.ttftMs)}`,
		`  generationMs             ${fmtPct(report.generationMs)}`,
		`  spawnQueueMs             ${fmtPct(report.spawnQueueMs)}`,
		`  e2eMs                    ${report.e2eMs}`,
		`  criticalPathMs           ${report.criticalPathMs}`,
		`  taskCompletionMs         ${report.taskCompletionMs}`,
		`completionKind: ${JSON.stringify(report.completionKinds)}`,
		`parentFinalVerification: ${JSON.stringify(report.parentFinalVerification)}`,
		`models: ${JSON.stringify(report.models)}`,
		`spawnEfforts: ${JSON.stringify(report.spawnEfforts)}`,
		`overlappingChildIntervals: ${report.overlappingChildIntervals}`,
		`unmatchedToolResults: ${report.unmatchedToolResults}`,
		`repeatedReads: ${JSON.stringify(report.repeatedReads)}`,
		`toolFailures: ${JSON.stringify(report.toolFailures)}`,
		`usage: ${JSON.stringify(report.usage)}`,
	];
	return lines.join("\n");
}
