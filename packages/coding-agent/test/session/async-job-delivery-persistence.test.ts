/**
 * Persisted async/hub delivery → reopen → subagent report.
 * Memory-only job.latestDetails is not the contract: JSONL must recover
 * completionKind and spawnQueueMs when produced, and IRC duration must not
 * become a queue sample.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { buildSubagentBaselineReport, parseSessionJsonl } from "../../src/latency/subagent-report";
import { buildAsyncResultBatchMessage, type AsyncResultEntry } from "../../src/session/async-job-delivery";
import type { AsyncJob } from "../../src/async/job-manager";
import type { ToolSession } from "../../src/tools";
import { snapshotJobs } from "../../src/async/job-control";
import { emptyReviewMetrics } from "../../src/task/review-performance";

function jobWithSettledResult(opts: {
	id: string;
	agentId?: string;
	completionKind: "completed" | "budget_stop" | "timeout" | "hard_abort";
	spawnQueueMs?: number;
	requestPhaseQueueMs?: number;
	resultText?: string;
}): AsyncJob {
	return {
		id: opts.id,
		agentId: opts.agentId ?? opts.id,
		type: "task",
		status: "completed",
		startTime: Date.now() - 50,
		label: opts.agentId ?? opts.id,
		abortController: new AbortController(),
		promise: Promise.resolve(),
		resultText:
			opts.resultText ??
			`<task-result id="${opts.agentId ?? opts.id}" status="${opts.completionKind}">ok</task-result>`,
		latestDetails: {
			results: [
				{
					id: opts.agentId ?? opts.id,
					completionKind: opts.completionKind,
					reviewMetrics: {
						...emptyReviewMetrics(),
						...(opts.spawnQueueMs !== undefined ? { spawnQueueMs: opts.spawnQueueMs } : {}),
						...(opts.requestPhaseQueueMs !== undefined
							? {
									requestPhases: [
										{
											index: 0,
											startedAtMs: 1,
											durationMs: 10,
											queueMs: opts.requestPhaseQueueMs,
										},
									],
								}
							: {}),
					},
				},
			],
		},
	};
}

function sessionJsonl(entries: unknown[]): string {
	return entries.map(entry => JSON.stringify(entry)).join("\n");
}

describe("async/hub delivery persistence", () => {
	it("recovers completionKind and spawnQueueMs after writing async-result JSONL to disk", async () => {
		using tempDir = TempDir.createSync("async-delivery-persist-");
		const job = jobWithSettledResult({ id: "MetricsWorker", completionKind: "budget_stop", spawnQueueMs: 42 });
		const entry: AsyncResultEntry = {
			jobId: job.id,
			result: job.resultText ?? "ok",
			job,
			durationMs: 50,
			epoch: 0,
		};
		const message = buildAsyncResultBatchMessage([entry]);
		expect(message?.details?.jobs[0]?.completionKind).toBe("budget_stop");
		expect(message?.details?.jobs[0]?.spawnQueueMs).toBe(42);

		const file = path.join(tempDir.path(), "sessions", "demo", "sess1.jsonl");
		await Bun.write(
			file,
			sessionJsonl([
				{ type: "session", version: 3, id: "sess1", timestamp: "2026-09-09T10:00:00.000Z", cwd: "/tmp" },
				{
					type: "message",
					id: "a1",
					parentId: null,
					timestamp: "2026-09-09T10:00:00.000Z",
					message: {
						role: "assistant",
						timestamp: 1000,
						content: [
							{
								type: "toolCall",
								id: "c1",
								name: "task",
								arguments: { agent: "task", tasks: [{ name: "MetricsWorker" }] },
							},
						],
					},
				},
				{
					type: "message",
					id: "r1",
					parentId: "a1",
					timestamp: "2026-09-09T10:00:00.000Z",
					message: {
						role: "toolResult",
						toolCallId: "c1",
						toolName: "task",
						content: [{ type: "text", text: "Spawned agent `MetricsWorker`." }],
						timestamp: 1010,
						details: { results: [], async: { state: "running", jobId: "MetricsWorker", type: "task" } },
					},
				},
				{
					type: "custom_message",
					id: "async1",
					parentId: "r1",
					timestamp: "2026-09-09T10:00:00.000Z",
					customType: message?.customType,
					content: message?.content,
					details: message?.details,
					display: true,
				},
			]),
		);
		const text = await Bun.file(file).text();
		const report = buildSubagentBaselineReport([parseSessionJsonl(text, file)]);
		expect(report.completionKinds.budget_stop).toBe(1);
		expect(report.coverage.completionKind).toEqual({ present: 1, unknown: 0 });
		expect(report.spawnQueueMs).toEqual({ n: 1, p50: 42, p90: 42 });
	});

	it("recovers hub-consumed completionKind and spawnQueueMs from persisted job snapshot details", async () => {
		using tempDir = TempDir.createSync("hub-delivery-persist-");
		const job = jobWithSettledResult({
			id: "Worker",
			completionKind: "completed",
			spawnQueueMs: 18,
			requestPhaseQueueMs: 7,
		});
		const snapshot = snapshotJobs({} as ToolSession, [job]);
		expect(snapshot[0]?.completionKind).toBe("completed");
		expect(snapshot[0]?.spawnQueueMs).toBe(18);
		expect(snapshot[0]?.requestPhaseQueueMs).toBe(7);

		const file = path.join(tempDir.path(), "sessions", "demo", "sess1.jsonl");
		await Bun.write(
			file,
			sessionJsonl([
				{ type: "session", version: 3, id: "sess1", timestamp: "2026-09-09T10:00:00.000Z", cwd: "/tmp" },
				{
					type: "message",
					id: "a1",
					parentId: null,
					timestamp: "2026-09-09T10:00:00.000Z",
					message: {
						role: "assistant",
						timestamp: 1000,
						content: [
							{
								type: "toolCall",
								id: "c1",
								name: "task",
								arguments: { agent: "task", tasks: [{ name: "Worker" }] },
							},
						],
					},
				},
				{
					type: "message",
					id: "r1",
					parentId: "a1",
					timestamp: "2026-09-09T10:00:00.000Z",
					message: {
						role: "toolResult",
						toolCallId: "c1",
						toolName: "task",
						content: [{ type: "text", text: "Spawned." }],
						timestamp: 1010,
						details: { results: [] },
					},
				},
				{
					type: "message",
					id: "a2",
					parentId: "r1",
					timestamp: "2026-09-09T10:00:00.000Z",
					message: {
						role: "assistant",
						timestamp: 2000,
						content: [{ type: "toolCall", id: "h1", name: "hub", arguments: { op: "wait", ids: ["Worker"] } }],
					},
				},
				{
					type: "message",
					id: "h1",
					parentId: "a2",
					timestamp: "2026-09-09T10:00:00.000Z",
					message: {
						role: "toolResult",
						toolCallId: "h1",
						toolName: "hub",
						content: [{ type: "text", text: job.resultText }],
						timestamp: 3000,
						details: { op: "wait", jobs: snapshot },
					},
				},
			]),
		);
		const text = await Bun.file(file).text();
		const report = buildSubagentBaselineReport([parseSessionJsonl(text, file)]);
		expect(report.sessions.spawnCalls).toBe(1);
		expect(report.completionKinds.completed).toBe(1);
		expect(report.coverage.completionKind).toEqual({ present: 1, unknown: 0 });
		expect(report.spawnQueueMs).toEqual({ n: 1, p50: 18, p90: 18 });
		expect(report.coverage.requestPhaseQueueMs).toEqual({ present: 1, unknown: 0 });
	});

	it("keeps IRC-only duration unknown for spawnQueueMs", async () => {
		using tempDir = TempDir.createSync("irc-queue-unknown-");
		const file = path.join(tempDir.path(), "sessions", "demo", "sess1.jsonl");
		await Bun.write(
			file,
			sessionJsonl([
				{ type: "session", version: 3, id: "sess1", timestamp: "2026-09-09T10:00:00.000Z", cwd: "/tmp" },
				{
					type: "message",
					id: "a1",
					parentId: null,
					timestamp: "2026-09-09T10:00:00.000Z",
					message: {
						role: "assistant",
						timestamp: 1000,
						content: [
							{
								type: "toolCall",
								id: "c1",
								name: "task",
								arguments: { agent: "task", tasks: [{ name: "Worker" }] },
							},
						],
					},
				},
				{
					type: "message",
					id: "r1",
					parentId: "a1",
					timestamp: "2026-09-09T10:00:00.000Z",
					message: {
						role: "toolResult",
						toolCallId: "c1",
						toolName: "task",
						content: [{ type: "text", text: "Spawned." }],
						timestamp: 1010,
						details: { results: [] },
					},
				},
				{
					type: "message",
					id: "a2",
					parentId: "r1",
					timestamp: "2026-09-09T10:00:00.000Z",
					message: {
						role: "assistant",
						timestamp: 2000,
						content: [{ type: "toolCall", id: "h1", name: "hub", arguments: { op: "wait" } }],
					},
				},
				{
					type: "message",
					id: "h1",
					parentId: "a2",
					timestamp: "2026-09-09T10:00:00.000Z",
					message: {
						role: "toolResult",
						toolCallId: "h1",
						toolName: "hub",
						content: [
							{
								type: "text",
								text: `<task-result id="Worker" status="completed" duration="9s">ok</task-result>`,
							},
						],
						timestamp: 3000,
					},
				},
			]),
		);
		const text = await Bun.file(file).text();
		const report = buildSubagentBaselineReport([parseSessionJsonl(text, file)]);
		expect(report.completionKinds.completed).toBe(1);
		expect(report.coverage.spawnQueueMs).toEqual({ present: 0, unknown: 1 });
		expect(report.spawnQueueMs).toEqual({ n: 0, p50: null, p90: null });
	});

	it("does not leak a sole mismatched result into another job's delivery or hub snapshot", () => {
		const failedA: AsyncJob = {
			id: "FailedA",
			agentId: "FailedA",
			type: "task",
			status: "failed",
			startTime: Date.now() - 50,
			label: "FailedA",
			abortController: new AbortController(),
			promise: Promise.resolve(),
			resultText: "FailedA crashed",
			latestDetails: {
				results: [
					{
						id: "CompletedB",
						completionKind: "completed",
						reviewMetrics: { ...emptyReviewMetrics(), spawnQueueMs: 77 },
					},
				],
			},
		};
		const message = buildAsyncResultBatchMessage([
			{ jobId: failedA.id, result: "FailedA crashed", job: failedA, durationMs: 50, epoch: 0 },
		]);
		expect(message?.details?.jobs[0]?.completionKind).toBeUndefined();
		expect(message?.details?.jobs[0]?.spawnQueueMs).toBeUndefined();

		const snapshot = snapshotJobs({} as ToolSession, [failedA]);
		expect(snapshot[0]?.completionKind).toBeUndefined();
		expect(snapshot[0]?.spawnQueueMs).toBeUndefined();
	});

	it("still accepts a legacy anonymous sole result when the row has no explicit id", () => {
		const job: AsyncJob = {
			id: "Worker",
			agentId: "Worker",
			type: "task",
			status: "completed",
			startTime: Date.now() - 50,
			label: "Worker",
			abortController: new AbortController(),
			promise: Promise.resolve(),
			latestDetails: {
				results: [
					{
						completionKind: "timeout",
						reviewMetrics: { ...emptyReviewMetrics(), spawnQueueMs: 4 },
					},
				],
			},
		};
		const message = buildAsyncResultBatchMessage([
			{ jobId: job.id, result: "timed out", job, durationMs: 10, epoch: 0 },
		]);
		expect(message?.details?.jobs[0]?.completionKind).toBe("timeout");
		expect(message?.details?.jobs[0]?.spawnQueueMs).toBe(4);
		expect(snapshotJobs({} as ToolSession, [job])[0]?.completionKind).toBe("timeout");
	});

	it("persists taskToolCallId on delivery and hub output so reused labels stay distinct", async () => {
		using tempDir = TempDir.createSync("async-delivery-call-id-");
		const job = jobWithSettledResult({ id: "Worker", completionKind: "completed", spawnQueueMs: 11 });
		job.taskToolCallId = "c2";
		const message = buildAsyncResultBatchMessage([
			{ jobId: job.id, result: job.resultText ?? "ok", job, durationMs: 20, epoch: 0 },
		]);
		expect(message?.details?.jobs[0]?.taskToolCallId).toBe("c2");
		expect(snapshotJobs({} as ToolSession, [job])[0]?.taskToolCallId).toBe("c2");

		const file = path.join(tempDir.path(), "sessions", "demo", "sess1.jsonl");
		await Bun.write(
			file,
			sessionJsonl([
				{ type: "session", version: 3, id: "sess1", timestamp: "2026-09-09T10:00:00.000Z", cwd: "/tmp" },
				{
					type: "message",
					id: "a1",
					parentId: null,
					timestamp: "2026-09-09T10:00:00.000Z",
					message: {
						role: "assistant",
						timestamp: 1000,
						content: [
							{
								type: "toolCall",
								id: "c1",
								name: "task",
								arguments: { agent: "task", tasks: [{ name: "Worker" }] },
							},
						],
					},
				},
				{
					type: "message",
					id: "r1",
					parentId: "a1",
					timestamp: "2026-09-09T10:00:00.000Z",
					message: {
						role: "toolResult",
						toolCallId: "c1",
						toolName: "task",
						content: [{ type: "text", text: "Spawned." }],
						timestamp: 1010,
						details: { results: [] },
					},
				},
				{
					type: "message",
					id: "a2",
					parentId: "r1",
					timestamp: "2026-09-09T10:00:00.000Z",
					message: {
						role: "assistant",
						timestamp: 2000,
						content: [
							{
								type: "toolCall",
								id: "c2",
								name: "task",
								arguments: { agent: "task", tasks: [{ name: "Worker" }] },
							},
						],
					},
				},
				{
					type: "message",
					id: "r2",
					parentId: "a2",
					timestamp: "2026-09-09T10:00:00.000Z",
					message: {
						role: "toolResult",
						toolCallId: "c2",
						toolName: "task",
						content: [{ type: "text", text: "Spawned." }],
						timestamp: 2010,
						details: { results: [] },
					},
				},
				{
					type: "custom_message",
					id: "async1",
					parentId: "r2",
					timestamp: "2026-09-09T10:00:00.000Z",
					customType: message?.customType,
					content: message?.content,
					details: message?.details,
					display: true,
				},
			]),
		);
		const text = await Bun.file(file).text();
		const report = buildSubagentBaselineReport([parseSessionJsonl(text, file)]);
		expect(report.sessions.spawnCalls).toBe(2);
		expect(report.completionKinds.completed).toBe(1);
		expect(report.coverage.completionKind).toEqual({ present: 1, unknown: 1 });
		expect(report.spawnQueueMs).toEqual({ n: 1, p50: 11, p90: 11 });
	});
});
