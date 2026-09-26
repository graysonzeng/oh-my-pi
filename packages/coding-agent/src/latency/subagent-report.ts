/**
 * Offline subagent baseline from existing session JSONL.
 * Consumes historical fields only. Does not infer passed, e2e, or verification
 * from tool success or normal exit — only from explicit parent-final receipts.
 */
import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";
import { ASYNC_RESULT_MESSAGE_TYPE } from "../session/async-job-delivery";
import { resolveSubagentPerformanceClass, type SubagentPerformanceClass } from "../task/review-performance";
import { computeActiveWallMs } from "./active-wall";
import {
	buildDeliveryCostBaselineReport,
	type DeliveryCostBaselineReport,
	DELIVERY_QUALITY_OUTCOME_MESSAGE_TYPE,
	formatDeliveryCostBaselineReport,
	parseDeliveryQualityOutcomeDetails,
	type DeliveryQualityOutcomeObservation,
} from "./delivery-cost-baseline";
import {
	criticalPathMsFromIntervals,
	PARENT_FINAL_VERIFICATION_MESSAGE_TYPE,
	parseParentFinalVerificationDetails,
	type ParentFinalVerificationObservation,
} from "./parent-final-verification";
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
	/** Parent start→final-verification wall; null when no explicit acceptance receipts. */
	e2eMs: PercentileSummary | null;
	/** Causal critical path (parallel children via union, not sum); null without receipts. */
	criticalPathMs: PercentileSummary | null;
	/** Parent assistant active wall through verification when known; null otherwise. */
	taskCompletionMs: PercentileSummary | null;
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
	childActiveWallByClass: {
		review: PercentileSummary;
		explore: PercentileSummary;
		worker: PercentileSummary;
		unknown: PercentileSummary;
	};
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
	parentFinalVerification: { passed: number; failed: number; unknown: number };
	overlappingChildIntervals: number;
	unmatchedToolResults: number;
	repeatedReads: { key: string; count: number }[];
	toolFailures: { tool: string; calls: number; errors: number }[];
	/** Delivery-first cost baseline; ordinary vs workflow kept separate. */
	deliveryCost: DeliveryCostBaselineReport;
}

export interface ParsedSession {
	path: string;
	stem: string;
	folder: string;
	isSubagent: boolean;
	parentPathFromLayout?: string;
	parentSessionHeader?: string;
	id?: string;
	agent?: string;
	performanceClass?: SubagentPerformanceClass;
	skippedLines: number;
	firstTs: number | null;
	lastTs: number | null;
	timestampCount: number;
	assistantTimestamps: number[];
	usageRequests: UsageRequest[];
	toolCalls: ParsedToolCall[];
	toolResults: ParsedToolResult[];
	thinkingLevels: string[];
	spawnObservations: SpawnResultRow[];
	parentFinalVerifications: ParentFinalVerificationObservation[];
	/** Optional quality-defect receipts; absent ⇒ unknown, never zero-filled. */
	qualityOutcomes?: DeliveryQualityOutcomeObservation[];
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

interface SpawnMember {
	id: string | null;
	effort: string | null;
	agent: string | null;
	shadowReview: "code" | "off" | null;
}

interface SpawnSpec {
	agent: string | null;
	shadowReview: "code" | "off" | null;
	labels: string[];
	efforts: Array<string | null>;
	members: SpawnMember[];
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
	aliases: string[];
	completionKind: string | null;
	completionKindSource: "own" | "structured" | "irc" | null;
	spawnQueueMs: number | null;
	requestPhaseQueueMs: number | null;
	taskToolCallId: string | null;
}

interface ParsedToolResult {
	callId: string;
	name: string;
	ts: number | null;
	isError: boolean;
	spawnRows?: SpawnResultRow[];
	progressIdentities: Array<{ index: number; id: string }>;
}

const KNOWN_COMPLETION_KINDS: Record<string, true> = {
	completed: true,
	budget_stop: true,
	timeout: true,
	hard_abort: true,
};
/** Always listed: provider queue is never produced into session history today. */
const ALWAYS_UNCOMPUTABLE_FROM_HISTORY = ["providerQueueMs"] as const;
function asNonNegativeNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function knownCompletionKind(value: unknown): string | null {
	return typeof value === "string" && KNOWN_COMPLETION_KINDS[value] === true ? value : null;
}

function trimmedId(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseShadowReview(value: unknown): "code" | "off" | null {
	return value === "code" || value === "off" ? value : null;
}

function emptyRow(id: string | null = null): SpawnResultRow {
	return {
		id,
		aliases: [],
		completionKind: null,
		completionKindSource: null,
		spawnQueueMs: null,
		requestPhaseQueueMs: null,
		taskToolCallId: null,
	};
}

function rowIds(row: SpawnResultRow): string[] {
	const ids: string[] = [];
	if (row.id) ids.push(row.id);
	for (const alias of row.aliases) {
		if (alias && alias !== row.id) ids.push(alias);
	}
	return ids;
}

function firstRequestPhaseQueueMs(metrics: Record<string, unknown> | undefined): number | null {
	if (!metrics || !Array.isArray(metrics.requestPhases)) return null;
	for (const phase of metrics.requestPhases) {
		if (!isRecord(phase)) continue;
		const queueMs = asNonNegativeNumber(phase.queueMs);
		if (queueMs !== null) return queueMs;
	}
	return null;
}

function metricsFromUnknown(value: unknown): {
	spawnQueueMs: number | null;
	requestPhaseQueueMs: number | null;
} {
	if (typeof value === "number") {
		return { spawnQueueMs: asNonNegativeNumber(value), requestPhaseQueueMs: null };
	}
	if (!isRecord(value)) {
		return { spawnQueueMs: null, requestPhaseQueueMs: null };
	}
	return {
		spawnQueueMs: asNonNegativeNumber(value.spawnQueueMs),
		requestPhaseQueueMs: firstRequestPhaseQueueMs(value),
	};
}

function rowFromRecord(item: Record<string, unknown>): SpawnResultRow {
	const id = trimmedId(item.id) ?? trimmedId(item.jobId);
	const aliases: string[] = [];
	for (const key of ["jobId", "agentUrlId", "agentId", "label"] as const) {
		const alias = trimmedId(item[key]);
		if (alias && alias !== id && !aliases.includes(alias)) aliases.push(alias);
	}
	const fromReview = isRecord(item.reviewMetrics) ? metricsFromUnknown(item.reviewMetrics) : undefined;
	const spawnQueueMs = fromReview?.spawnQueueMs ?? asNonNegativeNumber(item.spawnQueueMs);
	const requestPhaseQueueMs = fromReview?.requestPhaseQueueMs ?? asNonNegativeNumber(item.requestPhaseQueueMs);
	const completionKind = knownCompletionKind(item.completionKind);
	return {
		id,
		aliases,
		completionKind,
		completionKindSource: completionKind ? "structured" : null,
		spawnQueueMs,
		requestPhaseQueueMs,
		taskToolCallId: trimmedId(item.taskToolCallId),
	};
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
	const defaultAgent = typeof args.agent === "string" && args.agent.trim() ? args.agent.trim() : null;
	const defaultShadow = parseShadowReview(args.shadowReview);
	const defaultEffort = typeof args.effort === "string" && args.effort.trim() ? args.effort.trim() : null;
	const members: SpawnMember[] = [];
	const labels: string[] = [];
	const efforts: Array<string | null> = [];
	const pushMember = (item: Record<string, unknown>): void => {
		const id = spawnLabel(item);
		const effort = typeof item.effort === "string" && item.effort.trim() ? item.effort.trim() : defaultEffort;
		const agent = typeof item.agent === "string" && item.agent.trim() ? item.agent.trim() : defaultAgent;
		const shadowReview = parseShadowReview(item.shadowReview) ?? defaultShadow;
		members.push({ id, effort, agent, shadowReview });
		if (id) labels.push(id);
		efforts.push(effort);
	};
	if (Array.isArray(args.tasks)) {
		for (const item of args.tasks) {
			if (isRecord(item)) pushMember(item);
		}
	} else {
		pushMember(args);
	}
	return { agent: defaultAgent, shadowReview: defaultShadow, labels, efforts, members };
}

function parseSpawnRows(details: unknown): SpawnResultRow[] | undefined {
	if (!isRecord(details) || !Array.isArray(details.results)) return undefined;
	const rows: SpawnResultRow[] = [];
	for (const item of details.results) {
		if (isRecord(item)) rows.push(rowFromRecord(item));
	}
	return rows;
}

function parseJobLikeRows(jobs: unknown): SpawnResultRow[] {
	if (!Array.isArray(jobs)) return [];
	const rows: SpawnResultRow[] = [];
	for (const item of jobs) {
		if (!isRecord(item)) continue;
		const row = rowFromRecord(item);
		const resultText =
			(typeof item.resultText === "string" ? item.resultText : "") +
			(typeof item.errorText === "string" ? `\n${item.errorText}` : "");
		if (row.completionKind === null && resultText) {
			const irc = parseTaskResultTags(resultText);
			const ids = rowIds(row);
			const matched =
				ids.length > 0
					? irc.find(candidate => candidate.id !== null && ids.includes(candidate.id))
					: irc.length === 1
						? irc[0]
						: undefined;
			if (matched?.completionKind) {
				row.completionKind = matched.completionKind;
				row.completionKindSource = "irc";
			}
			if (!row.id && matched?.id) row.id = matched.id;
			if (matched?.id && row.id && matched.id !== row.id && !row.aliases.includes(matched.id)) {
				row.aliases.push(matched.id);
			}
		}
		rows.push(row);
	}
	return rows;
}

/** Pull `id` / `completionKind` (or known `status`) from `<task-result ...>` IRC envelopes in tool text. */
function parseTaskResultTags(text: string): SpawnResultRow[] {
	const rows: SpawnResultRow[] = [];
	const tagRe = /<task-result\b([^>]*)>/gi;
	let match: RegExpExecArray | null;
	while ((match = tagRe.exec(text)) !== null) {
		const attrs = match[1] ?? "";
		const attr = (name: string): string | null => {
			const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i").exec(attrs);
			return m?.[1]?.trim() ? m[1].trim() : null;
		};
		const id = attr("id");
		const kindAttr = attr("completionKind");
		const statusAttr = attr("status");
		const rawKind =
			kindAttr ?? (statusAttr !== null && KNOWN_COMPLETION_KINDS[statusAttr] === true ? statusAttr : null);
		const completionKind = rawKind !== null && KNOWN_COMPLETION_KINDS[rawKind] === true ? rawKind : null;
		rows.push({
			id,
			aliases: [],
			completionKind,
			completionKindSource: completionKind ? "irc" : null,
			spawnQueueMs: null,
			requestPhaseQueueMs: null,
			taskToolCallId: null,
		});
	}
	return rows;
}

function parseProgressIdentities(details: unknown): Array<{ index: number; id: string }> {
	if (!isRecord(details) || !Array.isArray(details.progress)) return [];
	const rows: Array<{ index: number; id: string }> = [];
	for (const item of details.progress) {
		if (!isRecord(item)) continue;
		const index = item.index;
		const id = trimmedId(item.id);
		if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || !id) continue;
		rows.push({ index, id });
	}
	return rows;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!isRecord(block) || block.type !== "text") continue;
		if (typeof block.text === "string" && block.text) parts.push(block.text);
	}
	return parts.join("\n");
}

function toolResultTextContent(msg: Record<string, unknown>): string {
	return textFromContent(msg.content);
}

function kindSourceRank(source: SpawnResultRow["completionKindSource"]): number {
	if (source === "own") return 3;
	if (source === "structured") return 2;
	if (source === "irc") return 1;
	return 0;
}

function mergeRow(base: SpawnResultRow, extra: SpawnResultRow): SpawnResultRow {
	const aliases = [...base.aliases];
	for (const alias of extra.aliases) {
		if (alias && alias !== base.id && !aliases.includes(alias)) aliases.push(alias);
	}
	if (extra.id && extra.id !== base.id && !aliases.includes(extra.id) && base.id) aliases.push(extra.id);
	const takeExtraKind =
		extra.completionKind !== null &&
		kindSourceRank(extra.completionKindSource) > kindSourceRank(base.completionKindSource);
	return {
		id: base.id ?? extra.id,
		aliases,
		completionKind: takeExtraKind ? extra.completionKind : (base.completionKind ?? extra.completionKind),
		completionKindSource: takeExtraKind
			? extra.completionKindSource
			: base.completionKind !== null
				? base.completionKindSource
				: extra.completionKindSource,
		spawnQueueMs: base.spawnQueueMs ?? extra.spawnQueueMs,
		requestPhaseQueueMs: base.requestPhaseQueueMs ?? extra.requestPhaseQueueMs,
		taskToolCallId: base.taskToolCallId ?? extra.taskToolCallId,
	};
}

function writeRow(target: SpawnResultRow, next: SpawnResultRow): void {
	target.id = next.id;
	target.aliases = next.aliases;
	target.completionKind = next.completionKind;
	target.completionKindSource = next.completionKindSource;
	target.spawnQueueMs = next.spawnQueueMs;
	target.requestPhaseQueueMs = next.requestPhaseQueueMs;
	target.taskToolCallId = next.taskToolCallId;
}

function structuredRowsFromDetails(details: unknown): SpawnResultRow[] {
	const fromResults = parseSpawnRows(details) ?? [];
	const fromJobs = isRecord(details) && Array.isArray(details.jobs) ? parseJobLikeRows(details.jobs) : [];
	if (fromResults.length === 0) return fromJobs;
	if (fromJobs.length === 0) return fromResults;
	const merged = fromResults.map(row => ({ ...row, aliases: [...row.aliases] }));
	for (const jobRow of fromJobs) {
		const match = merged.find(row => rowsShareIdentity(row, jobRow));
		if (match) writeRow(match, mergeRow(match, jobRow));
		else merged.push(jobRow);
	}
	return merged;
}

function rowsShareIdentity(a: SpawnResultRow, b: SpawnResultRow): boolean {
	const aIds = rowIds(a);
	const bIds = rowIds(b);
	if (aIds.length === 0 || bIds.length === 0) return false;
	return aIds.some(id => bIds.includes(id));
}

/**
 * Structured terminal data wins. Fill missing kinds per row from IRC.
 * Never assign an IRC row with a different explicit id. Never invent queue
 * from IRC duration. Explicit aliases (agentUrlId/agentId/label/jobId) match
 * IRC ids, not only row.id.
 */
function resolveSpawnRows(details: unknown, contentText: string): SpawnResultRow[] | undefined {
	const fromStructured = structuredRowsFromDetails(details);
	const fromIrc = contentText ? parseTaskResultTags(contentText) : [];
	if (fromStructured.length === 0) {
		return fromIrc.length > 0 ? fromIrc : undefined;
	}
	if (fromIrc.length === 0) return fromStructured;

	const usedIrc = new Set<number>();
	const filled = fromStructured.map(row => {
		if (row.completionKind !== null && row.spawnQueueMs !== null && row.requestPhaseQueueMs !== null) {
			return row;
		}
		const ids = rowIds(row);
		if (ids.length === 0) return row;
		const index = fromIrc.findIndex(
			(candidate, ircIndex) => !usedIrc.has(ircIndex) && candidate.id !== null && ids.includes(candidate.id),
		);
		if (index === -1) return row;
		usedIrc.add(index);
		return mergeRow(row, fromIrc[index]!);
	});

	for (let index = 0; index < fromIrc.length; index++) {
		if (usedIrc.has(index)) continue;
		const row = fromIrc[index];
		if (!row?.id) continue;
		if (filled.some(existing => rowsShareIdentity(existing, row))) continue;
		usedIrc.add(index);
		filled.push(row);
	}

	const unusedAnonymous = fromIrc
		.map((row, index) => ({ row, index }))
		.filter(entry => !usedIrc.has(entry.index) && !entry.row.id);
	if (fromIrc.some((row, index) => !usedIrc.has(index) && Boolean(row.id))) return filled;

	let anonCursor = 0;
	return filled.map(row => {
		if (row.id || row.completionKind !== null) return row;
		const next = unusedAnonymous[anonCursor++];
		if (!next) return row;
		usedIrc.add(next.index);
		return mergeRow(row, next.row);
	});
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

function collectParentFinalVerification(
	session: ParsedSession,
	customType: unknown,
	details: unknown,
	ts: number | null,
): void {
	if (customType !== PARENT_FINAL_VERIFICATION_MESSAGE_TYPE) return;
	const parsed = parseParentFinalVerificationDetails(details);
	if (!parsed) return;
	session.parentFinalVerifications.push({
		status: parsed.status,
		source: parsed.source,
		ts: parsed.verifiedAtMs ?? ts,
	});
}

function collectDeliveryQualityOutcome(
	session: ParsedSession,
	customType: unknown,
	details: unknown,
	ts: number | null,
): void {
	if (customType !== DELIVERY_QUALITY_OUTCOME_MESSAGE_TYPE) return;
	const parsed = parseDeliveryQualityOutcomeDetails(details);
	if (!parsed) return;
	session.qualityOutcomes ??= [];
	session.qualityOutcomes.push({
		falseAccept: parsed.falseAccept,
		missedDefect: parsed.missedDefect,
		ts,
	});
}

function collectTerminalObservations(
	session: ParsedSession,
	customType: unknown,
	content: unknown,
	details: unknown,
	ts: number | null = null,
): void {
	collectParentFinalVerification(session, customType, details, ts);
	collectDeliveryQualityOutcome(session, customType, details, ts);
	const type = typeof customType === "string" ? customType : "";
	const text = textFromContent(content);
	const hasJobs = isRecord(details) && Array.isArray(details.jobs);
	const hasResults = isRecord(details) && Array.isArray(details.results);
	if (type !== ASYNC_RESULT_MESSAGE_TYPE && !text.includes("<task-result") && !hasJobs && !hasResults) {
		return;
	}
	const rows = resolveSpawnRows(details, text);
	if (!rows) return;
	for (const row of rows) {
		if (row.id || row.completionKind !== null || row.spawnQueueMs !== null) {
			session.spawnObservations.push(row);
		}
	}
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
		spawnObservations: [],
		parentFinalVerifications: [],
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
		if (type === "session_init") {
			if (typeof raw.agent === "string" && raw.agent.trim()) session.agent = raw.agent.trim();
			if (
				raw.performanceClass === "review" ||
				raw.performanceClass === "explore" ||
				raw.performanceClass === "worker"
			) {
				session.performanceClass = raw.performanceClass;
			}
			continue;
		}
		if (type === "thinking_level_change" && typeof raw.thinkingLevel === "string" && raw.thinkingLevel) {
			session.thinkingLevels.push(raw.thinkingLevel);
			continue;
		}
		if (type === "custom") {
			const ts = entryTimestamp(raw, undefined);
			touchTs(session, ts);
			collectParentFinalVerification(session, raw.customType, raw.data, ts);
			collectDeliveryQualityOutcome(session, raw.customType, raw.data, ts);
			continue;
		}
		if (type === "custom_message") {
			const ts = entryTimestamp(raw, undefined);
			touchTs(session, ts);
			collectTerminalObservations(session, raw.customType, raw.content, raw.details, ts);
			continue;
		}
		if (type !== "message") continue;
		const msg = isRecord(raw.message) ? raw.message : undefined;
		if (!msg) continue;
		if (msg.role === "custom") {
			const ts = entryTimestamp(raw, msg);
			touchTs(session, ts);
			collectTerminalObservations(session, msg.customType, msg.content, msg.details, ts);
			continue;
		}
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
			const name = typeof msg.toolName === "string" && msg.toolName ? msg.toolName : "?";
			const spawnRows = resolveSpawnRows(msg.details, toolResultTextContent(msg));
			session.toolResults.push({
				callId: typeof msg.toolCallId === "string" ? msg.toolCallId : "",
				name,
				ts,
				isError: msg.isError === true,
				spawnRows,
				progressIdentities: name === "task" ? parseProgressIdentities(msg.details) : [],
			});
			if (name === "hub" && spawnRows) {
				for (const row of spawnRows) {
					if (row.id || row.completionKind !== null || row.spawnQueueMs !== null) {
						session.spawnObservations.push(row);
					}
				}
			}
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

interface SpawnSlot extends SpawnResultRow {
	agent: string | null;
	shadowReview: "code" | "off" | null;
	effort: string | null;
	callId: string;
}

function slotsFromCall(call: ParsedToolCall): SpawnSlot[] {
	const spawn = call.spawn;
	if (!spawn) {
		return [{ ...emptyRow(null), agent: null, shadowReview: null, effort: null, callId: call.callId }];
	}
	if (spawn.members.length > 0) {
		return spawn.members.map(member => ({
			...emptyRow(member.id),
			agent: member.agent,
			shadowReview: member.shadowReview,
			effort: member.effort,
			callId: call.callId,
		}));
	}
	return [
		{
			...emptyRow(null),
			agent: spawn.agent,
			shadowReview: spawn.shadowReview,
			effort: spawn.efforts[0] ?? null,
			callId: call.callId,
		},
	];
}

function applyObservation(slot: SpawnSlot, obs: SpawnResultRow, own = false): void {
	const incoming =
		own && obs.completionKindSource === "structured" ? { ...obs, completionKindSource: "own" as const } : obs;
	writeRow(slot, mergeRow(slot, incoming));
}

function applyProgressIdentity(slots: SpawnSlot[], progress: Array<{ index: number; id: string }>): void {
	const used: Record<number, true> = {};
	for (const row of progress) {
		if (used[row.index] || row.index >= slots.length) continue;
		const slot = slots[row.index];
		if (!slot) continue;
		used[row.index] = true;
		if (!slot.id) slot.id = row.id;
		else if (row.id !== slot.id && !slot.aliases.includes(row.id)) slot.aliases.push(row.id);
	}
}

function overlaySameCall(slots: SpawnSlot[], rows: SpawnResultRow[]): void {
	const used: Record<number, true> = {};
	for (const slot of slots) {
		const index = rows.findIndex((obs, i) => !used[i] && rowsShareIdentity(slot, obs));
		if (index === -1) continue;
		used[index] = true;
		applyObservation(slot, rows[index]!, true);
	}
	const unmatchedObs = rows.filter((_, i) => !used[i]);
	const unmatchedSlots = slots.filter(
		slot => slot.completionKind === null || slot.spawnQueueMs === null || slot.requestPhaseQueueMs === null,
	);
	const leftoverExplicit =
		unmatchedObs.some(obs => rowIds(obs).length > 0) && unmatchedSlots.some(slot => rowIds(slot).length > 0);
	if (leftoverExplicit) return;
	if (unmatchedObs.length === 1 && unmatchedSlots.length === 1) {
		const obs = unmatchedObs[0]!;
		const slot = unmatchedSlots[0]!;
		const obsIds = rowIds(obs);
		const slotIds = rowIds(slot);
		if (obsIds.length > 0 && slotIds.length > 0 && !obsIds.some(id => slotIds.includes(id))) return;
		applyObservation(slot, obs, true);
	}
}

function observationFits(slot: SpawnSlot, obs: SpawnResultRow): boolean {
	if (obs.taskToolCallId && (!slot.callId || slot.callId !== obs.taskToolCallId)) return false;
	const obsIds = rowIds(obs);
	const slotIds = rowIds(slot);
	if (obsIds.length > 0) return slotIds.length > 0 && rowsShareIdentity(slot, obs);
	return Boolean(obs.taskToolCallId) && slotIds.length === 0;
}

function assignSessionObservations(slots: SpawnSlot[], observations: SpawnResultRow[]): void {
	for (const obs of observations) {
		const candidates = slots.filter(slot => observationFits(slot, obs));
		if (candidates.length !== 1) continue;
		applyObservation(candidates[0]!, obs);
	}
}

function slotsForCall(call: ParsedToolCall, result: ParsedToolResult | undefined): SpawnSlot[] {
	const slots = slotsFromCall(call);
	if (result && result.progressIdentities.length > 0) applyProgressIdentity(slots, result.progressIdentities);
	if (result?.spawnRows) overlaySameCall(slots, result.spawnRows);
	return slots;
}

function spawnIdentityFromParent(
	parent: ParsedSession,
	child: ParsedSession,
): { agent: string | null; shadowReview: "code" | "off" | null } | undefined {
	const keys = [child.id, child.stem].filter((value): value is string => Boolean(value));
	if (keys.length === 0) return undefined;
	const matches: Array<{ agent: string | null; shadowReview: "code" | "off" | null }> = [];
	for (const call of parent.toolCalls) {
		if (!call.spawn) continue;
		for (const member of call.spawn.members) {
			if (!member.id || !keys.includes(member.id)) continue;
			matches.push({
				agent: member.agent ?? call.spawn.agent,
				shadowReview: member.shadowReview ?? call.spawn.shadowReview,
			});
		}
	}
	const first = matches[0];
	if (!first) return undefined;
	for (const match of matches) {
		if (match.agent !== first.agent || match.shadowReview !== first.shadowReview) return undefined;
	}
	return first;
}

function resolveChildClass(
	child: ParsedSession,
	parent: ParsedSession | undefined,
): SubagentPerformanceClass | "unknown" {
	if (child.performanceClass) return child.performanceClass;
	if (child.agent) return resolveSubagentPerformanceClass({ agentName: child.agent });
	if (!parent) return "unknown";
	const ident = spawnIdentityFromParent(parent, child);
	if (!ident?.agent) return "unknown";
	return resolveSubagentPerformanceClass({
		agentName: ident.agent,
		spawnShadowReview: ident.shadowReview === "code" || ident.shadowReview === "off" ? ident.shadowReview : undefined,
	});
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
	const childActiveByClass: Record<SubagentPerformanceClass | "unknown", number[]> = {
		review: [],
		explore: [],
		worker: [],
		unknown: [],
	};
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

	const e2eSamples: number[] = [];
	const criticalPathSamples: number[] = [];
	const taskCompletionSamples: number[] = [];
	let parentFinalPassed = 0;
	let parentFinalFailed = 0;
	let parentFinalUnknown = 0;

	for (const parent of parents) {
		const fileWall = fileWallMs(parent);
		if (fileWall !== null) parentFileWallSamples.push(fileWall);
		const activeWall = computeActiveWallMs(parent.assistantTimestamps);
		if (activeWall !== undefined) parentActiveWallSamples.push(activeWall);

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
			if (childActive !== undefined) {
				childActiveWallSamples.push(childActive);
				childActiveByClass[resolveChildClass(child, parent)].push(childActive);
			}
		}
		for (let i = 0; i < intervals.length; i++) {
			for (let j = i + 1; j < intervals.length; j++) {
				if (intervals[i]!.start < intervals[j]!.end && intervals[j]!.start < intervals[i]!.end) {
					overlappingChildIntervals++;
				}
			}
		}

		const verification = parent.parentFinalVerifications[parent.parentFinalVerifications.length - 1];
		if (!verification) {
			parentFinalUnknown++;
			cover(coverage.parentFinalVerification, false);
			continue;
		}
		cover(coverage.parentFinalVerification, true);
		if (verification.status === "passed") parentFinalPassed++;
		else parentFinalFailed++;

		const startTs = parent.firstTs;
		const verifyTs = verification.ts;
		if (startTs !== null && verifyTs !== null && verifyTs >= startTs) {
			e2eSamples.push(verifyTs - startTs);
			const pathMs = criticalPathMsFromIntervals({
				startTs,
				verifyTs,
				childIntervals: intervals,
			});
			if (pathMs !== null) criticalPathSamples.push(pathMs);
		}
		// Without a verification timestamp, there is no boundary separating
		// accepted work from later activity. Keep its duration unknown.
		if (verifyTs !== null) {
			const assistantsThroughVerify = parent.assistantTimestamps.filter(ts => ts <= verifyTs);
			const completionActive = computeActiveWallMs(assistantsThroughVerify);
			if (completionActive !== undefined) taskCompletionSamples.push(completionActive);
		}
	}
	for (const child of children) {
		if (parentOf(child, byPath, byId)) continue;
		const childFile = fileWallMs(child);
		if (childFile !== null) childFileWallSamples.push(childFile);
		const childActive = computeActiveWallMs(child.assistantTimestamps);
		if (childActive !== undefined) {
			childActiveWallSamples.push(childActive);
			childActiveByClass[resolveChildClass(child, undefined)].push(childActive);
		}
	}

	for (const session of sessions) {
		const { pairs, unmatchedResults, unmatchedCalls } = pairCalls(session);
		unmatchedToolResults += unmatchedResults;
		const spawnSlots: SpawnSlot[] = [];
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
			spawnSlots.push(...slotsForCall(call, result));
		};
		for (const pair of pairs) {
			if (pair.call.spawn) recordSpawn(pair.call, pair.result);
		}
		for (const call of unmatchedCalls) {
			if (call.spawn) recordSpawn(call, undefined);
		}
		assignSessionObservations(spawnSlots, session.spawnObservations);
		for (const row of spawnSlots) {
			cover(coverage.completionKind, row.completionKind !== null);
			if (row.completionKind) bump(completionKinds, row.completionKind);
			else bump(completionKinds, "unknown");
			cover(coverage.spawnQueueMs, row.spawnQueueMs !== null);
			if (row.spawnQueueMs !== null) spawnQueueSamples.push(row.spawnQueueMs);
			cover(coverage.requestPhaseQueueMs, row.requestPhaseQueueMs !== null);
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

	const e2eMs = e2eSamples.length > 0 ? summarizeMs(e2eSamples) : null;
	const criticalPathMs = criticalPathSamples.length > 0 ? summarizeMs(criticalPathSamples) : null;
	const taskCompletionMs = taskCompletionSamples.length > 0 ? summarizeMs(taskCompletionSamples) : null;
	const uncomputableFromHistory: string[] = [];
	if (parents.length === 0 || parentFinalUnknown === parents.length) {
		uncomputableFromHistory.push("parentFinalVerification");
	}
	if (e2eMs === null || criticalPathMs === null) uncomputableFromHistory.push("e2eCriticalPathMs");
	if (taskCompletionMs === null) uncomputableFromHistory.push("taskCompletionMs");
	uncomputableFromHistory.push(...ALWAYS_UNCOMPUTABLE_FROM_HISTORY);
	return {
		e2eMs,
		criticalPathMs,
		taskCompletionMs,
		uncomputableFromHistory,
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
		childActiveWallByClass: {
			review: summarizeMs(childActiveByClass.review),
			explore: summarizeMs(childActiveByClass.explore),
			worker: summarizeMs(childActiveByClass.worker),
			unknown: summarizeMs(childActiveByClass.unknown),
		},
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
		parentFinalVerification: {
			passed: parentFinalPassed,
			failed: parentFinalFailed,
			unknown: parentFinalUnknown,
		},
		overlappingChildIntervals,
		unmatchedToolResults,
		repeatedReads,
		toolFailures,
		deliveryCost: buildDeliveryCostBaselineReport(sessions),
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
		`    review                 ${fmtPct(report.childActiveWallByClass.review)}`,
		`    explore                ${fmtPct(report.childActiveWallByClass.explore)}`,
		`    worker                 ${fmtPct(report.childActiveWallByClass.worker)}`,
		`    unknown                ${fmtPct(report.childActiveWallByClass.unknown)}`,
		`  ttftMs                   ${fmtPct(report.ttftMs)}`,
		`  generationMs             ${fmtPct(report.generationMs)}`,
		`  spawnQueueMs             ${fmtPct(report.spawnQueueMs)}`,
		`  e2eMs                    ${report.e2eMs ? fmtPct(report.e2eMs) : "null"}`,
		`  criticalPathMs           ${report.criticalPathMs ? fmtPct(report.criticalPathMs) : "null"}`,
		`  taskCompletionMs         ${report.taskCompletionMs ? fmtPct(report.taskCompletionMs) : "null"}`,
		`completionKind: ${JSON.stringify(report.completionKinds)}`,
		`parentFinalVerification: ${JSON.stringify(report.parentFinalVerification)}`,
		`models: ${JSON.stringify(report.models)}`,
		`spawnEfforts: ${JSON.stringify(report.spawnEfforts)}`,
		`overlappingChildIntervals: ${report.overlappingChildIntervals}`,
		`unmatchedToolResults: ${report.unmatchedToolResults}`,
		`repeatedReads: ${JSON.stringify(report.repeatedReads)}`,
		`toolFailures: ${JSON.stringify(report.toolFailures)}`,
		`usage: ${JSON.stringify(report.usage)}`,
		formatDeliveryCostBaselineReport(report.deliveryCost),
	];
	return lines.join("\n");
}
