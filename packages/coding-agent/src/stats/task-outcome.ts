/**
 * Per-task final status extraction for quality/cost reporting (plan P2-G).
 *
 * Async `task` toolResults often persist `details.results: []` at schedule time.
 * Terminal status is recovered from later `async-result` custom messages
 * (`details.jobs[].finalStatus`) and from live `details.progress[].status`.
 * This module is the coding-agent owner for that contract so `omp stats` /
 * `scripts/model-routing-roles.py` can report success rate per role.
 *
 * When the same job appears in multiple sources, prefer
 * `async-result.finalStatus` > `results` > `progress` (see {@link mergeTaskOutcomes}).
 */

export type TaskFinalStatus = "success" | "failed" | "aborted";

export type TaskOutcomeSource = "async-result" | "results" | "progress";

export interface TaskOutcomeRow {
	id: string;
	agent: string;
	finalStatus: TaskFinalStatus;
	source: TaskOutcomeSource;
}

const SOURCE_PRIORITY: Record<TaskOutcomeSource, number> = {
	"async-result": 3,
	results: 2,
	progress: 1,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStatus(value: unknown): TaskFinalStatus | undefined {
	if (value === "success" || value === "failed" || value === "aborted") return value;
	if (value === "completed") return "success";
	return undefined;
}

function rowIds(item: Record<string, unknown>): string[] {
	const ids: string[] = [];
	for (const key of ["id", "jobId", "agentId", "agentUrlId"] as const) {
		const value = item[key];
		if (typeof value === "string" && value.trim() && !ids.includes(value.trim())) ids.push(value.trim());
	}
	return ids;
}

function finalStatusFromRow(item: Record<string, unknown>): TaskFinalStatus | undefined {
	const direct = asStatus(item.finalStatus);
	if (direct) return direct;
	if (item.aborted === true) return "aborted";
	const status = asStatus(item.status);
	if (status) return status;
	if (typeof item.exitCode === "number") {
		return item.exitCode === 0 && item.error === undefined ? "success" : "failed";
	}
	return undefined;
}

function agentFromRow(item: Record<string, unknown>, fallback = "?"): string {
	return typeof item.agent === "string" && item.agent.trim() ? item.agent.trim() : fallback;
}

/**
 * Deduplicate outcome rows by job id (`id` / `jobId` / `agentUrlId`), keeping the
 * highest-priority source: async-result > results > progress.
 */
export function mergeTaskOutcomes(rows: readonly TaskOutcomeRow[]): TaskOutcomeRow[] {
	const byId = new Map<string, TaskOutcomeRow>();
	for (const row of rows) {
		const existing = byId.get(row.id);
		if (!existing || SOURCE_PRIORITY[row.source] > SOURCE_PRIORITY[existing.source]) {
			byId.set(row.id, row);
		}
	}
	return [...byId.values()];
}

/** Collect terminal outcomes from a `task` toolResult details blob. */
export function taskOutcomesFromToolDetails(details: unknown): TaskOutcomeRow[] {
	if (!isRecord(details)) return [];
	const rows: TaskOutcomeRow[] = [];
	const push = (item: Record<string, unknown>, source: "results" | "progress"): void => {
		const finalStatus = finalStatusFromRow(item);
		if (!finalStatus) return;
		const ids = rowIds(item);
		const id = ids[0] ?? `${source}:${rows.length}`;
		rows.push({ id, agent: agentFromRow(item), finalStatus, source });
	};
	if (Array.isArray(details.results)) {
		for (const item of details.results) {
			if (isRecord(item)) push(item, "results");
		}
	}
	if (Array.isArray(details.progress)) {
		for (const item of details.progress) {
			if (isRecord(item)) push(item, "progress");
		}
	}
	// results > progress when the same job id appears in both.
	return mergeTaskOutcomes(rows);
}

/** Collect terminal outcomes from an `async-result` custom message details blob. */
export function taskOutcomesFromAsyncResultDetails(details: unknown): TaskOutcomeRow[] {
	if (!isRecord(details) || !Array.isArray(details.jobs)) return [];
	const rows: TaskOutcomeRow[] = [];
	for (const item of details.jobs) {
		if (!isRecord(item)) continue;
		const finalStatus = finalStatusFromRow(item);
		if (!finalStatus) continue;
		const id =
			(typeof item.agentUrlId === "string" && item.agentUrlId.trim()) ||
			(typeof item.jobId === "string" && item.jobId.trim()) ||
			`async:${rows.length}`;
		rows.push({
			id,
			agent: agentFromRow(item, typeof item.type === "string" ? item.type : "?"),
			finalStatus,
			source: "async-result",
		});
	}
	return rows;
}

/** Aggregate success rate by agent/role for reporting. */
export function successRateByAgent(
	rows: readonly TaskOutcomeRow[],
): Record<string, { total: number; success: number; rate: number }> {
	const agg: Record<string, { total: number; success: number }> = {};
	for (const row of rows) {
		const bucket = (agg[row.agent] ??= { total: 0, success: 0 });
		bucket.total += 1;
		if (row.finalStatus === "success") bucket.success += 1;
	}
	const out: Record<string, { total: number; success: number; rate: number }> = {};
	for (const [agent, bucket] of Object.entries(agg)) {
		out[agent] = {
			total: bucket.total,
			success: bucket.success,
			rate: bucket.total === 0 ? 0 : bucket.success / bucket.total,
		};
	}
	return out;
}
