/**
 * Owner-routed async job delivery: formatting and batch-message assembly for
 * `async-result` follow-ups.
 *
 * Each {@link AgentSession} registers a delivery sink for its own agent id
 * (`AsyncJobManager.registerDeliverySink`) and enqueues formatted entries on
 * its yield queue; the queue's idle flush injects them as a follow-up turn.
 * This replaces the old single hardwired `onJobComplete` closure that routed
 * every completion — regardless of owner — into the first top-level session.
 */
import { isRecord, prompt } from "@oh-my-pi/pi-utils";
import type { AsyncJob, AsyncJobType } from "../async";
import asyncResultTemplate from "../prompts/tools/async-result.md" with { type: "text" };
import type { StructuredSubagentOutput } from "@oh-my-pi/pi-tui/tools/task";
import type { SubagentCompletionKind } from "../task/types";
import type { CustomMessage } from "./messages";
import type { OutputMeta } from "@oh-my-pi/pi-tui/tools/output-meta";
import { truncateMiddle } from "@oh-my-pi/pi-tui/tools/streaming-output";

/**
 * `customType` of the injected async-result follow-up message. The task
 * executor's run monitor matches on it to invalidate a previously recorded
 * yield: a result injected after the yield supersedes that yield's payload.
 */
export const ASYNC_RESULT_MESSAGE_TYPE = "async-result";

/** Result payloads longer than this spill to an artifact with an inline preview. */
export const ASYNC_INLINE_RESULT_MAX_CHARS = 12_000;
export const ASYNC_PREVIEW_MAX_CHARS = 4_000;

export interface AsyncResultEntry {
	jobId: string;
	result: string;
	job: AsyncJob | undefined;
	durationMs: number | undefined;
	/**
	 * Owning session's async-delivery generation at enqueue time. A session
	 * transition (`/new`, switch, handoff) bumps the generation, so an entry
	 * whose generation no longer matches belongs to a replaced transcript and
	 * is dropped at flush — even after its job id has been reused, which clears
	 * the manager's per-id suppression marker.
	 */
	epoch: number;
}

type AsyncResultJobDetails = {
	jobId: string;
	type?: AsyncJobType;
	label?: string;
	durationMs?: number;
	/** Source capture metadata belongs to this job, not to the enclosing delivery report. */
	meta?: OutputMeta;
	/** Full structured payload (source/mode/status/data/error), when the job used an output schema. */
	schema?: StructuredSubagentOutput;
	/** Artifact handle; may differ from jobId after collision suffixing. */
	agentUrlId?: string;
	completionKind?: SubagentCompletionKind;
	spawnQueueMs?: number;
	requestPhaseQueueMs?: number;
	/** Originating parent `task` tool call id, when the job recorded one. */
	taskToolCallId?: string;
};

export type AsyncResultDetails = {
	jobs: AsyncResultJobDetails[];
	meta?: OutputMeta;
};

/**
 * Compact, size-capped JSON block for the delivery text, used only for
 * schema-invalid/error results (valid results point to `agent://<jobId>`
 * instead, since the sidecar's `<output>` block already carries the full
 * JSON — no need to duplicate it here).
 */
export function renderStructuredJson(structured: StructuredSubagentOutput): string | undefined {
	if (!Object.hasOwn(structured, "data")) return undefined;
	let serialized: string;
	try {
		serialized = JSON.stringify(structured.data, null, 2) ?? "null";
	} catch {
		return undefined;
	}
	return truncateMiddle(serialized, { maxBytes: ASYNC_PREVIEW_MAX_CHARS }).content;
}

/**
 * Headline for the delivery's "Structured output:" line. `unavailable` means
 * no payload was ever validated (the run failed before yielding, or the
 * schema itself was unusable) — never a schema verdict, so it must not read
 * as "schema unavailable"/"schema invalid".
 */
export function structuredStatusLabel(status: StructuredSubagentOutput["status"]): string {
	return status === "unavailable" ? "unavailable" : `schema ${status}`;
}

function asNonNegativeNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function knownCompletionKind(value: unknown): SubagentCompletionKind | undefined {
	if (value === "completed" || value === "budget_stop" || value === "timeout" || value === "hard_abort") {
		return value;
	}
	return undefined;
}

function firstRequestPhaseQueueMs(metrics: unknown): number | undefined {
	if (!isRecord(metrics) || !Array.isArray(metrics.requestPhases)) return undefined;
	for (const phase of metrics.requestPhases) {
		if (!isRecord(phase)) continue;
		const queueMs = asNonNegativeNumber(phase.queueMs);
		if (queueMs !== undefined) return queueMs;
	}
	return undefined;
}

/** Minimal identity/metrics from `latestDetails.results` for persistent async delivery. */
export function settledTaskDeliveryFields(job: {
	id?: string;
	agentId?: string;
	label?: string;
	latestDetails?: Record<string, unknown>;
}): {
	completionKind?: SubagentCompletionKind;
	spawnQueueMs?: number;
	requestPhaseQueueMs?: number;
} {
	const results = job.latestDetails?.results;
	if (!Array.isArray(results)) return {};
	const jobKeys = new Set<string>();
	if (job.id) jobKeys.add(job.id);
	if (job.agentId) jobKeys.add(job.agentId);
	if (job.label) jobKeys.add(job.label);
	let matched: Record<string, unknown> | undefined;
	let only: Record<string, unknown> | undefined;
	let recordCount = 0;
	for (const item of results) {
		if (!isRecord(item)) continue;
		recordCount++;
		only ??= item;
		if (jobKeys.size > 0 && resultRowTrueIds(item).some(id => jobKeys.has(id))) {
			matched = item;
			break;
		}
	}
	if (!matched && recordCount === 1 && only && resultRowTrueIds(only).length === 0) {
		matched = only;
	}
	if (!matched) return {};
	const metrics = matched.reviewMetrics;
	const spawnQueueMs = isRecord(metrics) ? asNonNegativeNumber(metrics.spawnQueueMs) : undefined;
	const requestPhaseQueueMs = firstRequestPhaseQueueMs(metrics);
	return {
		completionKind: knownCompletionKind(matched.completionKind),
		...(spawnQueueMs !== undefined ? { spawnQueueMs } : {}),
		...(requestPhaseQueueMs !== undefined ? { requestPhaseQueueMs } : {}),
	};
}

function resultRowTrueIds(item: Record<string, unknown>): string[] {
	const ids: string[] = [];
	for (const key of ["id", "jobId", "agentId", "agentUrlId"] as const) {
		const value = item[key];
		if (typeof value === "string" && value.trim() && !ids.includes(value.trim())) ids.push(value.trim());
	}
	return ids;
}

export function taskToolCallIdFromJob(
	job: Pick<AsyncJob, "taskToolCallId" | "latestDetails"> | undefined,
): string | undefined {
	if (!job) return undefined;
	if (typeof job.taskToolCallId === "string" && job.taskToolCallId.trim()) return job.taskToolCallId.trim();
	const details = job.latestDetails;
	if (!isRecord(details)) return undefined;
	if (
		isRecord(details.async) &&
		typeof details.async.taskToolCallId === "string" &&
		details.async.taskToolCallId.trim()
	) {
		return details.async.taskToolCallId.trim();
	}
	if (!Array.isArray(details.progress)) return undefined;
	for (const item of details.progress) {
		if (!isRecord(item) || typeof item.taskToolCallId !== "string" || !item.taskToolCallId.trim()) continue;
		return item.taskToolCallId.trim();
	}
	return undefined;
}

export function buildAsyncResultBatchMessage(entries: AsyncResultEntry[]): CustomMessage<AsyncResultDetails> | null {
	if (entries.length === 0) return null;
	const jobs = entries.map(entry => {
		const structured = entry.job?.structured;
		const hasStructuredData = structured ? Object.hasOwn(structured, "data") : false;
		const structuredJson = structured && structured.status !== "valid" ? renderStructuredJson(structured) : undefined;
		return {
			jobId: entry.jobId,
			// The job manager disambiguates a requested job id when it collides
			// with another live job (e.g. a task job reusing a vibe turn's job
			// id), suffixing `jobId` — but the task's artifacts are still
			// written under its own agent id (`AsyncJob.agentId`). Build the
			// advertised `agent://` URL from that, or the delivery would point
			// at an id with no backing `<id>.md`/`.json` on disk.
			agentUrlId: entry.job?.agentId ?? entry.jobId,
			result: entry.result,
			type: entry.job?.type,
			label: entry.job?.label,
			durationMs: entry.durationMs,
			meta: entry.job?.latestDetails?.meta,
			structured,
			structuredJson,
			hasStructuredData,
			schemaStatus: structured?.status,
			schemaStatusLabel: structured ? structuredStatusLabel(structured.status) : undefined,
			schemaError: structured?.error,
			schemaValid: structured?.status === "valid",
		};
	});
	const details: AsyncResultDetails = {
		meta: { source: { type: "report", value: "background job delivery" } },
		jobs: jobs.map((job, index) => {
			const entry = entries[index]!;
			const settled = settledTaskDeliveryFields({
				id: entry.job?.id ?? entry.jobId,
				agentId: entry.job?.agentId,
				label: entry.job?.label ?? job.label,
				latestDetails: entry.job?.latestDetails,
			});
			const agentUrlId = entry.job?.agentId ?? entry.jobId;
			const taskToolCallId = taskToolCallIdFromJob(entry.job);
			return {
				jobId: job.jobId,
				type: job.type,
				label: job.label,
				durationMs: job.durationMs,
				...(job.meta ? { meta: job.meta } : {}),
				...(job.structured ? { schema: job.structured } : {}),
				...(agentUrlId ? { agentUrlId } : {}),
				...(settled.completionKind ? { completionKind: settled.completionKind } : {}),
				...(settled.spawnQueueMs !== undefined ? { spawnQueueMs: settled.spawnQueueMs } : {}),
				...(settled.requestPhaseQueueMs !== undefined ? { requestPhaseQueueMs: settled.requestPhaseQueueMs } : {}),
				...(taskToolCallId ? { taskToolCallId } : {}),
			};
		}),
	};
	const text = prompt.render(asyncResultTemplate, {
		multiple: jobs.length > 1,
		jobs,
	});
	const images = entries.flatMap(entry => entry.job?.latestDetails?.images ?? []);
	return {
		role: "custom",
		customType: ASYNC_RESULT_MESSAGE_TYPE,
		content: images.length > 0 ? [{ type: "text", text }, ...images] : text,
		display: true,
		attribution: "agent",
		details,
		timestamp: Date.now(),
	};
}
