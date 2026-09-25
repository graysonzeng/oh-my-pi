import { describe, expect, it } from "bun:test";
import {
	buildSubagentBaselineReport,
	formatSubagentBaselineReport,
	parseSessionJsonl,
} from "../../src/latency/subagent-report";

const SECRET = "LEAK_TOKEN_9f3a_sk-secret";
const PARENT = "/tmp/sessions/demo/sess1.jsonl";
const CHILD_A = "/tmp/sessions/demo/sess1/Worker.jsonl";
const CHILD_B = "/tmp/sessions/demo/sess1/Reviewer.jsonl";

function line(value: unknown): string {
	return JSON.stringify(value);
}

function sessionHeader(id: string, extra: Record<string, unknown> = {}): unknown {
	return { type: "session", version: 3, id, timestamp: "2026-09-09T10:00:00.000Z", cwd: "/tmp/demo", ...extra };
}

function userMsg(ts: number, text: string): unknown {
	return {
		type: "message",
		id: `u-${ts}`,
		parentId: null,
		timestamp: "2026-09-09T10:00:00.000Z",
		message: { role: "user", content: [{ type: "text", text }], timestamp: ts },
	};
}

function assistantMsg(opts: {
	ts: number;
	model?: string;
	ttft?: number;
	duration?: number;
	usage?: Record<string, unknown>;
	content?: unknown[];
	stopReason?: string;
}): unknown {
	return {
		type: "message",
		id: `a-${opts.ts}`,
		parentId: null,
		timestamp: "2026-09-09T10:00:00.000Z",
		message: {
			role: "assistant",
			content: opts.content ?? [{ type: "text", text: "ok" }],
			timestamp: opts.ts,
			model: opts.model,
			stopReason: opts.stopReason ?? "stop",
			ttft: opts.ttft,
			duration: opts.duration,
			usage: opts.usage,
		},
	};
}

function toolResult(opts: {
	callId: string;
	ts: number;
	name?: string;
	text?: string;
	isError?: boolean;
	details?: unknown;
}): unknown {
	return {
		type: "message",
		id: `r-${opts.ts}`,
		parentId: null,
		timestamp: "2026-09-09T10:00:00.000Z",
		message: {
			role: "toolResult",
			toolCallId: opts.callId,
			toolName: opts.name ?? "task",
			content: [{ type: "text", text: opts.text ?? "done" }],
			isError: opts.isError === true,
			timestamp: opts.ts,
			details: opts.details,
		},
	};
}

function taskCall(opts: {
	callId: string;
	ts: number;
	agent?: string;
	tasks?: Record<string, unknown>[];
	effort?: string;
	name?: string;
}): unknown {
	return assistantMsg({
		ts: opts.ts,
		model: "gateway/grok-4.6",
		ttft: 20,
		duration: 80,
		usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 2, cost: { total: 0.01 } },
		content: [
			{
				type: "toolCall",
				id: opts.callId,
				name: "task",
				arguments: {
					agent: opts.agent ?? "task",
					effort: opts.effort,
					name: opts.name,
					tasks: opts.tasks,
				},
			},
		],
	});
}

function hubCall(opts: { callId: string; ts: number; ids?: string[] }): unknown {
	return assistantMsg({
		ts: opts.ts,
		model: "gateway/grok-4.6",
		ttft: 20,
		duration: 80,
		usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 2, cost: { total: 0.01 } },
		content: [
			{
				type: "toolCall",
				id: opts.callId,
				name: "hub",
				arguments: { op: "wait", ids: opts.ids ?? ["Worker"] },
			},
		],
	});
}

function customAsyncResult(opts: {
	ts: number;
	content: string | Array<{ type: string; text?: string }>;
	details?: unknown;
}): unknown {
	return {
		type: "custom_message",
		id: `async-${opts.ts}`,
		parentId: null,
		timestamp: "2026-09-09T10:00:00.000Z",
		customType: "async-result",
		content: opts.content,
		details: opts.details,
		display: true,
	};
}

function sessionInit(opts: { agent?: string; performanceClass?: "review" | "explore" | "worker" }): unknown {
	return {
		type: "session_init",
		id: "init",
		parentId: null,
		timestamp: "2026-09-09T10:00:00.000Z",
		systemPrompt: "sys",
		task: "do work",
		tools: [],
		agent: opts.agent,
		performanceClass: opts.performanceClass,
	};
}

describe("parseSessionJsonl", () => {
	it("skips malformed lines and still parses neighbors so a torn tail cannot drop the session", () => {
		const text = [
			line(sessionHeader("sess1")),
			"{ this is not valid json",
			line(userMsg(1000, "hello")),
			line(
				assistantMsg({
					ts: 2000,
					model: "gateway/grok-4.6",
					ttft: 40,
					duration: 100,
					usage: { input: 3, output: 1, cacheRead: 8, cacheWrite: 1, cost: { total: 0.2 } },
				}),
			),
			"",
		].join("\n");
		const parsed = parseSessionJsonl(text, PARENT);
		expect(parsed.skippedLines).toBe(1);
		expect(parsed.usageRequests).toHaveLength(1);
		expect(parsed.usageRequests[0]?.ttftMs).toBe(40);
		expect(parsed.usageRequests[0]?.generationMs).toBe(60);
	});
});

describe("buildSubagentBaselineReport", () => {
	it("omits conversation, session_init task, and tool bodies from JSON so sampling cannot leak secrets", () => {
		const parent = parseSessionJsonl(
			[
				line(sessionHeader("sess1")),
				line({
					type: "session_init",
					id: "init",
					parentId: null,
					timestamp: "2026-09-09T10:00:00.000Z",
					systemPrompt: `prompt ${SECRET}`,
					task: `do ${SECRET}`,
					tools: ["read"],
					agent: "task",
					resolvedModel: "gateway/grok-4.6",
				}),
				line(userMsg(1000, `please ${SECRET}`)),
				line(
					taskCall({
						callId: "c1",
						ts: 2000,
						tasks: [{ name: "Worker", agent: "task", task: `steal ${SECRET}`, effort: "hi" }],
					}),
				),
				line(toolResult({ callId: "c1", ts: 5000, text: `report ${SECRET}` })),
			].join("\n"),
			PARENT,
		);
		const child = parseSessionJsonl(
			[
				line(sessionHeader("child1", { parentSession: PARENT })),
				line({
					type: "session_init",
					id: "cinit",
					parentId: null,
					timestamp: "2026-09-09T10:00:00.000Z",
					systemPrompt: SECRET,
					task: SECRET,
					tools: ["read"],
					agent: "task",
				}),
				line(userMsg(2100, SECRET)),
				line(
					assistantMsg({
						ts: 3000,
						model: "gateway/grok-4.6",
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
						content: [{ type: "text", text: SECRET }],
					}),
				),
			].join("\n"),
			CHILD_A,
		);
		const report = buildSubagentBaselineReport([parent, child]);
		const json = JSON.stringify(report);
		const human = formatSubagentBaselineReport(report);
		expect(json).not.toContain(SECRET);
		expect(human).not.toContain(SECRET);
		expect(json).not.toContain("please ");
		expect(report.sessions.parentCount).toBe(1);
		expect(report.sessions.childCount).toBe(1);
	});

	it("falls back to <task-result completionKind> in toolResult text when details.results is empty", () => {
		const parent = parseSessionJsonl(
			[
				line(sessionHeader("sess1")),
				line(userMsg(1000, "go")),
				line(taskCall({ callId: "c1", ts: 2000, tasks: [{ name: "Worker" }] })),
				line(
					toolResult({
						callId: "c1",
						ts: 4000,
						text: `<task-result id="Worker" status="budget_stop" completionKind="budget_stop" duration="1s">partial</task-result>`,
						details: { results: [] },
					}),
				),
			].join("\n"),
			PARENT,
		);
		const report = buildSubagentBaselineReport([parent]);
		expect(report.completionKinds.budget_stop).toBe(1);
		expect(report.coverage.completionKind).toEqual({ present: 1, unknown: 0 });
		expect(report.spawnQueueMs).toEqual({ n: 0, p50: null, p90: null });
	});

	it("keeps missing timings and completion as null/unknown instead of 0 or passed on old records", () => {
		const parent = parseSessionJsonl(
			[
				line({ type: "session", id: "old", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" }),
				line(userMsg(1000, "go")),
				line(
					assistantMsg({
						ts: 2000,
						content: [{ type: "toolCall", id: "c1", name: "task", arguments: { tasks: [{ name: "Worker" }] } }],
					}),
				),
				line(
					toolResult({
						callId: "c1",
						ts: 4000,
						details: { results: [{ id: "Worker", exitCode: 0, aborted: false }] },
					}),
				),
			].join("\n"),
			PARENT,
		);
		const child = parseSessionJsonl(
			[
				line({ type: "session", id: "old-child", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" }),
				line(userMsg(2100, "work")),
				line(assistantMsg({ ts: 3000, stopReason: "stop" })),
			].join("\n"),
			CHILD_A,
		);
		const report = buildSubagentBaselineReport([parent, child]);
		expect(report.ttftMs).toEqual({ n: 0, p50: null, p90: null });
		expect(report.generationMs).toEqual({ n: 0, p50: null, p90: null });
		expect(report.spawnQueueMs).toEqual({ n: 0, p50: null, p90: null });
		expect(report.coverage.ttft.unknown).toBeGreaterThan(0);
		expect(report.coverage.completionKind.unknown).toBeGreaterThan(0);
		expect(report.completionKinds.unknown).toBeGreaterThan(0);
		expect(report.completionKinds.passed).toBeUndefined();
		expect(report.completionKinds.completed).toBeUndefined();
		expect(report.parentFinalVerification).toEqual({ passed: 0, failed: 0, unknown: 1 });
		expect(report.e2eMs).toBeNull();
		expect(report.criticalPathMs).toBeNull();
		expect(report.taskCompletionMs).toBeNull();
	});

	it("treats explicit cacheRead 0 as present and missing usage as unknown", () => {
		const parent = parseSessionJsonl(
			[
				line(sessionHeader("sess1")),
				line(userMsg(1000, "a")),
				line(
					assistantMsg({
						ts: 2000,
						model: "gateway/grok-4.6",
						ttft: 10,
						duration: 30,
						usage: { input: 4, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
					}),
				),
				line(assistantMsg({ ts: 3000, model: "gateway/grok-4.6" })),
			].join("\n"),
			PARENT,
		);
		const report = buildSubagentBaselineReport([parent]);
		expect(report.coverage.cache.present).toBe(1);
		expect(report.coverage.cache.unknown).toBe(1);
		expect(report.coverage.ttft.present).toBe(1);
		expect(report.coverage.ttft.unknown).toBe(1);
		expect(report.usage.cacheRead).toBe(0);
		expect(report.ttftMs.n).toBe(1);
		expect(report.ttftMs.p50).toBe(10);
	});

	it("does not sum overlapping child file walls as e2e and leaves critical path unknown", () => {
		const parent = parseSessionJsonl(
			[
				line(sessionHeader("sess1")),
				line(userMsg(0, "delegate")),
				line(
					taskCall({
						callId: "batch",
						ts: 1000,
						tasks: [
							{ name: "Worker", agent: "task", effort: "med" },
							{ name: "Reviewer", agent: "reviewer", effort: "hi" },
						],
					}),
				),
				line(
					toolResult({
						callId: "batch",
						ts: 11000,
						details: {
							results: [
								{ id: "Worker", completionKind: "completed", reviewMetrics: { spawnQueueMs: 40 } },
								{ id: "Reviewer", completionKind: "timeout", reviewMetrics: { spawnQueueMs: 10 } },
							],
						},
					}),
				),
			].join("\n"),
			PARENT,
		);
		const childA = parseSessionJsonl(
			[
				line(sessionHeader("a")),
				line(userMsg(1000, "a")),
				line(
					assistantMsg({
						ts: 9000,
						model: "gateway/grok-4.6",
						ttft: 50,
						duration: 150,
						usage: { input: 2, output: 2, cacheRead: 5, cacheWrite: 1, cost: { total: 0.1 } },
					}),
				),
			].join("\n"),
			CHILD_A,
		);
		const childB = parseSessionJsonl(
			[
				line(sessionHeader("b")),
				line(userMsg(2000, "b")),
				line(
					assistantMsg({
						ts: 10000,
						model: "gateway/grok-4.6",
						ttft: 70,
						duration: 170,
						usage: { input: 2, output: 2, cacheRead: 5, cacheWrite: 1, cost: { total: 0.1 } },
					}),
				),
			].join("\n"),
			CHILD_B,
		);
		const report = buildSubagentBaselineReport([parent, childA, childB]);
		expect(report.taskCallMs.p50).toBe(10000);
		expect(report.childFileWallMs.n).toBe(2);
		expect(report.overlappingChildIntervals).toBe(1);
		expect(report.e2eMs).toBeNull();
		expect(report.criticalPathMs).toBeNull();
		expect(report.completionKinds.completed).toBe(1);
		expect(report.completionKinds.timeout).toBe(1);
		expect(report.ttftMs.n).toBe(3);
		expect(report.spawnQueueMs.n).toBe(2);
		expect(report.spawnEfforts.med).toBe(1);
		expect(report.spawnEfforts.hi).toBe(1);
		expect(report.uncomputableFromHistory).toEqual(
			expect.arrayContaining([
				"parentFinalVerification",
				"e2eCriticalPathMs",
				"taskCompletionMs",
				"providerQueueMs",
			]),
		);
	});

	it("keeps timeout requests in TTFT samples and still refuses passed", () => {
		const parent = parseSessionJsonl(
			[
				line(sessionHeader("sess1")),
				line(taskCall({ callId: "c1", ts: 1000, tasks: [{ name: "Worker" }] })),
				line(
					toolResult({
						callId: "c1",
						ts: 4000,
						details: { results: [{ id: "Worker", completionKind: "timeout" }] },
					}),
				),
			].join("\n"),
			PARENT,
		);
		const child = parseSessionJsonl(
			[
				line(sessionHeader("a")),
				line(
					assistantMsg({
						ts: 2000,
						model: "x",
						ttft: 55,
						duration: 255,
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
					}),
				),
			].join("\n"),
			CHILD_A,
		);
		const report = buildSubagentBaselineReport([parent, child]);
		expect(report.ttftMs.n).toBe(2);
		expect(report.ttftMs.p50).toBe(20);
		expect(report.completionKinds.timeout).toBe(1);
		expect(report.completionKinds.passed).toBeUndefined();
	});

	it("pairs duplicate toolCall ids FIFO and leaves extra results unmatched", () => {
		const parent = parseSessionJsonl(
			[
				line(sessionHeader("sess1")),
				line(
					taskCall({
						callId: "dup",
						ts: 1000,
						tasks: [{ name: "Worker", effort: "lo" }],
					}),
				),
				line(
					toolResult({
						callId: "dup",
						ts: 2000,
						details: {
							results: [{ id: "Worker", completionKind: "completed", reviewMetrics: { spawnQueueMs: 5 } }],
						},
					}),
				),
				line(
					toolResult({
						callId: "dup",
						ts: 3000,
						details: {
							results: [{ id: "Worker", completionKind: "hard_abort", reviewMetrics: { spawnQueueMs: 999 } }],
						},
					}),
				),
			].join("\n"),
			PARENT,
		);
		const report = buildSubagentBaselineReport([parent]);
		expect(report.spawnQueueMs).toEqual({ n: 1, p50: 5, p90: 5 });
		expect(report.completionKinds.completed).toBe(1);
		expect(report.completionKinds.hard_abort).toBeUndefined();
		expect(report.unmatchedToolResults).toBe(1);
	});

	it("does not treat a later successful bash as parent final verification", () => {
		const parent = parseSessionJsonl(
			[
				line(sessionHeader("sess1")),
				line(userMsg(1000, "go")),
				line(taskCall({ callId: "c1", ts: 2000, tasks: [{ name: "Worker" }] })),
				line(
					toolResult({
						callId: "c1",
						ts: 3000,
						details: { results: [{ id: "Worker", completionKind: "completed" }] },
					}),
				),
				line(
					assistantMsg({
						ts: 4000,
						model: "gateway/grok-4.6",
						ttft: 15,
						duration: 40,
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
						content: [{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "bun test" } }],
					}),
				),
				line(toolResult({ callId: "b1", ts: 5000, name: "bash", text: "all tests passed", isError: false })),
			].join("\n"),
			PARENT,
		);
		const report = buildSubagentBaselineReport([parent]);
		expect(report.parentFinalVerification).toEqual({ passed: 0, failed: 0, unknown: 1 });
		expect(report.coverage.parentFinalVerification).toEqual({ present: 0, unknown: 1 });
	});

	it("distinguishes file wall from active wall so park gaps are not task time", () => {
		const t0 = 1_700_000_000_000;
		const tenMin = 10 * 60 * 1000;
		const parent = parseSessionJsonl(
			[
				line(sessionHeader("sess1")),
				line(
					assistantMsg({
						ts: t0,
						model: "m",
						ttft: 1,
						duration: 2,
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
					}),
				),
				line(
					assistantMsg({
						ts: t0 + tenMin,
						model: "m",
						ttft: 1,
						duration: 2,
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
					}),
				),
				line(
					assistantMsg({
						ts: t0 + 2 * tenMin + 1,
						model: "m",
						ttft: 1,
						duration: 2,
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
					}),
				),
				line(
					assistantMsg({
						ts: t0 + 2 * tenMin + 1 + 4000,
						model: "m",
						ttft: 1,
						duration: 2,
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
					}),
				),
			].join("\n"),
			PARENT,
		);
		const report = buildSubagentBaselineReport([parent]);
		expect(report.parentFileWallMs.p50).toBe(2 * tenMin + 1 + 4000);
		expect(report.parentActiveWallMs.p50).toBe(tenMin + 4000);
		expect(report.taskCompletionMs).toBeNull();
	});

	it("counts spawnQueueMs when present and never promotes it to provider queue", () => {
		const parent = parseSessionJsonl(
			[
				line(sessionHeader("sess1")),
				line(taskCall({ callId: "c1", ts: 1000, tasks: [{ name: "Worker" }] })),
				line(
					toolResult({
						callId: "c1",
						ts: 2000,
						details: {
							results: [
								{
									id: "Worker",
									completionKind: "completed",
									reviewMetrics: {
										spawnQueueMs: 12,
										requestPhases: [{ index: 0, startedAtMs: 1, durationMs: 20 }],
									},
								},
							],
						},
					}),
				),
			].join("\n"),
			PARENT,
		);
		const report = buildSubagentBaselineReport([parent]);
		expect(report.spawnQueueMs.p50).toBe(12);
		expect(report.coverage.requestPhaseQueueMs).toEqual({ present: 0, unknown: 1 });
		expect(report.uncomputableFromHistory).toContain("providerQueueMs");
	});

	it("hashes repeated-read paths per parent so credential URLs cannot leak and projects do not mix", () => {
		const secretUrl = "https://user:SECRET_URL_TOKEN@example.com/private.ts";
		const parent = parseSessionJsonl(
			[
				line(sessionHeader("sess1")),
				line(
					assistantMsg({
						ts: 1000,
						model: "m",
						ttft: 1,
						duration: 2,
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
						content: [
							{ type: "toolCall", id: "r1", name: "read", arguments: { path: `${secretUrl}:10-20` } },
							{ type: "toolCall", id: "r2", name: "read", arguments: { path: `${secretUrl}:raw` } },
							{ type: "toolCall", id: "e1", name: "edit", arguments: { path: secretUrl } },
						],
					}),
				),
				line(toolResult({ callId: "r1", ts: 1100, name: "read", text: "file body" })),
				line(toolResult({ callId: "r2", ts: 1200, name: "read", text: "file body" })),
				line(toolResult({ callId: "e1", ts: 1300, name: "edit", text: "hash mismatch", isError: true })),
			].join("\n"),
			PARENT,
		);
		const otherParent = parseSessionJsonl(
			[
				line(sessionHeader("sess2")),
				line(
					assistantMsg({
						ts: 1000,
						model: "m",
						ttft: 1,
						duration: 2,
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
						content: [
							{ type: "toolCall", id: "o1", name: "read", arguments: { path: "src/a.ts" } },
							{ type: "toolCall", id: "o2", name: "read", arguments: { path: "src/a.ts:5" } },
						],
					}),
				),
			].join("\n"),
			"/tmp/sessions/other/sess2.jsonl",
		);
		const sameRel = parseSessionJsonl(
			[
				line(sessionHeader("sess3")),
				line(
					assistantMsg({
						ts: 1000,
						model: "m",
						ttft: 1,
						duration: 2,
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
						content: [
							{ type: "toolCall", id: "s1", name: "read", arguments: { path: "src/a.ts" } },
							{ type: "toolCall", id: "s2", name: "read", arguments: { path: "src/a.ts" } },
						],
					}),
				),
			].join("\n"),
			"/tmp/sessions/demo/sess3.jsonl",
		);
		const report = buildSubagentBaselineReport([parent, otherParent, sameRel]);
		const json = JSON.stringify(report);
		expect(json).not.toContain("SECRET_URL_TOKEN");
		expect(json).not.toContain("example.com");
		expect(json).not.toContain("src/a.ts");
		expect(json).not.toContain("file body");
		expect(json).not.toContain("hash mismatch");
		expect(report.repeatedReads).toHaveLength(3);
		expect(report.repeatedReads.every(row => row.count === 2)).toBe(true);
		expect(new Set(report.repeatedReads.map(row => row.key)).size).toBe(3);
		expect(report.toolFailures).toEqual([{ tool: "edit", calls: 1, errors: 1 }]);
	});

	it("counts a task call with no result as spawn unknown instead of dropping coverage", () => {
		const parent = parseSessionJsonl(
			[
				line(sessionHeader("sess1")),
				line(taskCall({ callId: "orphan", ts: 1000, tasks: [{ name: "Worker", effort: "med" }] })),
			].join("\n"),
			PARENT,
		);
		const report = buildSubagentBaselineReport([parent]);
		expect(report.sessions.spawnCalls).toBe(1);
		expect(report.completionKinds.unknown).toBe(1);
		expect(report.coverage.completionKind).toEqual({ present: 0, unknown: 1 });
		expect(report.coverage.spawnQueueMs).toEqual({ present: 0, unknown: 1 });
		expect(report.spawnEfforts.med).toBe(1);
		expect(report.taskCallMs.n).toBe(0);
	});

	it("counts unmatched tool results on linked children instead of only unlinked transcripts", () => {
		const parent = parseSessionJsonl([line(sessionHeader("sess1")), line(userMsg(1000, "go"))].join("\n"), PARENT);
		const child = parseSessionJsonl(
			[
				line(sessionHeader("child1")),
				line(toolResult({ callId: "ghost", ts: 2000, name: "read", text: "stray" })),
			].join("\n"),
			CHILD_A,
		);
		const report = buildSubagentBaselineReport([parent, child]);
		expect(report.sessions.childCount).toBe(1);
		expect(report.sessions.unlinkedChildCount).toBe(0);
		expect(report.unmatchedToolResults).toBe(1);
		expect(JSON.stringify(report)).not.toContain("stray");
	});

	it("attributes hub <task-result> completionKind to the original task spawn, not the hub call", () => {
		const parent = parseSessionJsonl(
			[
				line(sessionHeader("sess1")),
				line(taskCall({ callId: "c1", ts: 2000, tasks: [{ name: "AstraSolPiReview" }] })),
				line(
					toolResult({
						callId: "c1",
						ts: 2010,
						text: "Spawned agent `AstraSolPiReview` (job `AstraSolPiReview`).",
						details: { results: [], async: { state: "running", jobId: "AstraSolPiReview", type: "task" } },
					}),
				),
				line(hubCall({ callId: "h1", ts: 3000, ids: ["AstraSolPiReview"] })),
				line(
					toolResult({
						callId: "h1",
						ts: 8000,
						name: "hub",
						text: `## Completed (1)\n\n### AstraSolPiReview [task] — completed\n\`\`\`\n<task-result id="AstraSolPiReview" agent="subagent-astra" status="completed" duration="5s">ok</task-result>\n\`\`\``,
					}),
				),
			].join("\n"),
			PARENT,
		);
		const report = buildSubagentBaselineReport([parent]);
		expect(report.sessions.spawnCalls).toBe(1);
		expect(report.completionKinds.completed).toBe(1);
		expect(report.coverage.completionKind).toEqual({ present: 1, unknown: 0 });
		expect(report.coverage.spawnQueueMs).toEqual({ present: 0, unknown: 1 });
		expect(report.spawnQueueMs).toEqual({ n: 0, p50: null, p90: null });
	});

	it("recovers completionKind and spawnQueueMs from async-result custom_message details", () => {
		const parent = parseSessionJsonl(
			[
				line(sessionHeader("sess1")),
				line(taskCall({ callId: "c1", ts: 2000, tasks: [{ name: "Worker" }] })),
				line(toolResult({ callId: "c1", ts: 2010, details: { results: [] } })),
				line(
					customAsyncResult({
						ts: 5000,
						content: `<task-result id="Worker" status="budget_stop" duration="2s">partial</task-result>`,
						details: {
							jobs: [
								{
									jobId: "Worker",
									agentUrlId: "Worker",
									completionKind: "budget_stop",
									spawnQueueMs: 42,
								},
							],
						},
					}),
				),
			].join("\n"),
			PARENT,
		);
		const report = buildSubagentBaselineReport([parent]);
		expect(report.completionKinds.budget_stop).toBe(1);
		expect(report.coverage.completionKind).toEqual({ present: 1, unknown: 0 });
		expect(report.spawnQueueMs).toEqual({ n: 1, p50: 42, p90: 42 });
		expect(report.coverage.spawnQueueMs).toEqual({ present: 1, unknown: 0 });
	});

	it("parses async-result content as either a string or text blocks", () => {
		const stringParent = parseSessionJsonl(
			[
				line(sessionHeader("sess1")),
				line(taskCall({ callId: "c1", ts: 2000, tasks: [{ name: "Worker" }] })),
				line(toolResult({ callId: "c1", ts: 2010, details: { results: [] } })),
				line(
					customAsyncResult({
						ts: 5000,
						content: `<task-result id="Worker" status="completed" completionKind="completed">ok</task-result>`,
					}),
				),
			].join("\n"),
			PARENT,
		);
		const blockParent = parseSessionJsonl(
			[
				line(sessionHeader("sess2")),
				line(taskCall({ callId: "c1", ts: 2000, tasks: [{ name: "Worker" }] })),
				line(toolResult({ callId: "c1", ts: 2010, details: { results: [] } })),
				line(
					customAsyncResult({
						ts: 5000,
						content: [
							{
								type: "text",
								text: `<task-result id="Worker" status="timeout" completionKind="timeout">late</task-result>`,
							},
						],
					}),
				),
			].join("\n"),
			"/tmp/sessions/demo/sess2.jsonl",
		);
		expect(buildSubagentBaselineReport([stringParent]).completionKinds.completed).toBe(1);
		expect(buildSubagentBaselineReport([blockParent]).completionKinds.timeout).toBe(1);
		expect(buildSubagentBaselineReport([stringParent]).coverage.spawnQueueMs).toEqual({ present: 0, unknown: 1 });
	});

	it("lets structured completionKind win over IRC and fills remaining rows per id", () => {
		const parent = parseSessionJsonl(
			[
				line(sessionHeader("sess1")),
				line(
					taskCall({
						callId: "batch",
						ts: 1000,
						tasks: [{ name: "Worker" }, { name: "Reviewer" }],
					}),
				),
				line(
					toolResult({
						callId: "batch",
						ts: 4000,
						text: `<task-result id="Worker" status="timeout" completionKind="timeout">nope</task-result>\n<task-result id="Reviewer" status="budget_stop" completionKind="budget_stop">partial</task-result>`,
						details: {
							results: [
								{ id: "Worker", completionKind: "completed", reviewMetrics: { spawnQueueMs: 9 } },
								{ id: "Reviewer" },
							],
						},
					}),
				),
			].join("\n"),
			PARENT,
		);
		const report = buildSubagentBaselineReport([parent]);
		expect(report.completionKinds.completed).toBe(1);
		expect(report.completionKinds.budget_stop).toBe(1);
		expect(report.completionKinds.timeout).toBeUndefined();
		expect(report.coverage.completionKind).toEqual({ present: 2, unknown: 0 });
		expect(report.spawnQueueMs).toEqual({ n: 1, p50: 9, p90: 9 });
		expect(report.coverage.spawnQueueMs).toEqual({ present: 1, unknown: 1 });
	});

	it("keeps IRC terminal B when structured only reported A, and rejects a stranger id", async () => {
		const parent = parseSessionJsonl(
			[
				line(sessionHeader("sess1")),
				line(
					taskCall({
						callId: "batch",
						ts: 1000,
						tasks: [{ name: "Worker" }, { name: "Reviewer" }],
					}),
				),
				line(
					toolResult({
						callId: "batch",
						ts: 4000,
						text: `<task-result id="Worker" status="completed" completionKind="completed">ok</task-result>\n<task-result id="Reviewer" status="budget_stop" completionKind="budget_stop">partial</task-result>`,
						details: {
							results: [{ id: "Worker", completionKind: "completed", reviewMetrics: { spawnQueueMs: 9 } }],
						},
					}),
				),
			].join("\n"),
			PARENT,
		);
		const report = buildSubagentBaselineReport([parent]);
		expect(report.completionKinds.completed).toBe(1);
		expect(report.completionKinds.budget_stop).toBe(1);
		expect(report.coverage.completionKind).toEqual({ present: 2, unknown: 0 });
	});

	it("never assigns mismatched explicit IDs and keeps missing batch members in the denominator", () => {
		const parent = parseSessionJsonl(
			[
				line(sessionHeader("sess1")),
				line(
					taskCall({
						callId: "batch",
						ts: 1000,
						tasks: [
							{ name: "Worker", effort: "lo" },
							{ name: "Reviewer", effort: "hi" },
						],
					}),
				),
				line(
					toolResult({
						callId: "batch",
						ts: 4000,
						text: `<task-result id="Stranger" status="completed" completionKind="completed">other</task-result>`,
						details: {
							results: [{ id: "Worker", completionKind: "completed", reviewMetrics: { spawnQueueMs: 4 } }],
						},
					}),
				),
			].join("\n"),
			PARENT,
		);
		const report = buildSubagentBaselineReport([parent]);
		expect(report.sessions.spawnCalls).toBe(1);
		expect(report.completionKinds.completed).toBe(1);
		expect(report.coverage.completionKind).toEqual({ present: 1, unknown: 1 });
		expect(report.coverage.spawnQueueMs).toEqual({ present: 1, unknown: 1 });
		expect(report.spawnEfforts.lo).toBe(1);
		expect(report.spawnEfforts.hi).toBe(1);
	});

	it("does not double-count a spawn observed on both hub wait and async-result", () => {
		const parent = parseSessionJsonl(
			[
				line(sessionHeader("sess1")),
				line(taskCall({ callId: "c1", ts: 2000, tasks: [{ name: "Worker" }] })),
				line(toolResult({ callId: "c1", ts: 2010, details: { results: [] } })),
				line(hubCall({ callId: "h1", ts: 3000 })),
				line(
					toolResult({
						callId: "h1",
						ts: 4000,
						name: "hub",
						text: `<task-result id="Worker" status="completed" completionKind="completed">ok</task-result>`,
					}),
				),
				line(
					customAsyncResult({
						ts: 4100,
						content: `<task-result id="Worker" status="completed" completionKind="completed">ok</task-result>`,
						details: { jobs: [{ jobId: "Worker", completionKind: "completed", spawnQueueMs: 7 }] },
					}),
				),
			].join("\n"),
			PARENT,
		);
		const report = buildSubagentBaselineReport([parent]);
		expect(report.sessions.spawnCalls).toBe(1);
		expect(report.completionKinds.completed).toBe(1);
		expect(report.coverage.completionKind).toEqual({ present: 1, unknown: 0 });
		expect(report.spawnQueueMs).toEqual({ n: 1, p50: 7, p90: 7 });
	});

	it("buckets childActiveWall by session_init performance class and leaves unknown when class is absent", () => {
		const t0 = 1_700_000_000_000;
		const parent = parseSessionJsonl([line(sessionHeader("sess1")), line(userMsg(t0, "go"))].join("\n"), PARENT);
		const reviewChild = parseSessionJsonl(
			[
				line(sessionHeader("review-child")),
				line(sessionInit({ agent: "subagent-astra", performanceClass: "review" })),
				line(
					assistantMsg({
						ts: t0,
						model: "m",
						ttft: 1,
						duration: 2,
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
					}),
				),
				line(
					assistantMsg({
						ts: t0 + 4000,
						model: "m",
						ttft: 1,
						duration: 2,
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
					}),
				),
			].join("\n"),
			CHILD_B,
		);
		const unknownChild = parseSessionJsonl(
			[
				line(sessionHeader("filename-worker")),
				line(
					assistantMsg({
						ts: t0,
						model: "m",
						ttft: 1,
						duration: 2,
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
					}),
				),
				line(
					assistantMsg({
						ts: t0 + 1000,
						model: "m",
						ttft: 1,
						duration: 2,
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
					}),
				),
			].join("\n"),
			CHILD_A,
		);
		const report = buildSubagentBaselineReport([parent, reviewChild, unknownChild]);
		expect(report.childActiveWallMs.n).toBe(2);
		expect(report.childActiveWallByClass.review.n).toBe(1);
		expect(report.childActiveWallByClass.review.p50).toBe(4000);
		expect(report.childActiveWallByClass.worker.n).toBe(0);
		expect(report.childActiveWallByClass.unknown.n).toBe(1);
		expect(report.childActiveWallByClass.unknown.p50).toBe(1000);
		expect(report.parentFinalVerification).toEqual({ passed: 0, failed: 0, unknown: 1 });
		expect(report.e2eMs).toBeNull();
	});

	it("classifies childActiveWall from session_init agent via the performance-class resolver", () => {
		const t0 = 1_700_000_000_000;
		const parent = parseSessionJsonl([line(sessionHeader("sess1"))].join("\n"), PARENT);
		const child = parseSessionJsonl(
			[
				line(sessionHeader("scout-child")),
				line(sessionInit({ agent: "scout" })),
				line(
					assistantMsg({
						ts: t0,
						model: "m",
						ttft: 1,
						duration: 2,
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
					}),
				),
				line(
					assistantMsg({
						ts: t0 + 2500,
						model: "m",
						ttft: 1,
						duration: 2,
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
					}),
				),
			].join("\n"),
			CHILD_A,
		);
		const report = buildSubagentBaselineReport([parent, child]);
		expect(report.childActiveWallByClass.explore).toEqual({ n: 1, p50: 2500, p90: 2500 });
		expect(report.childActiveWallByClass.unknown.n).toBe(0);
	});

	it("matches a suffixed job id to the spawn via agentUrlId without inventing a second spawn", () => {
		const parent = parseSessionJsonl(
			[
				line(sessionHeader("sess1")),
				line(taskCall({ callId: "c1", ts: 2000, name: "Foo-t1", tasks: [{ name: "Foo-t1" }] })),
				line(toolResult({ callId: "c1", ts: 2010, details: { results: [] } })),
				line(
					customAsyncResult({
						ts: 5000,
						content: "done",
						details: {
							jobs: [
								{
									jobId: "Foo-t1-2",
									agentUrlId: "Foo-t1",
									completionKind: "completed",
									spawnQueueMs: 3,
								},
							],
						},
					}),
				),
			].join("\n"),
			PARENT,
		);
		const report = buildSubagentBaselineReport([parent]);
		expect(report.sessions.spawnCalls).toBe(1);
		expect(report.completionKinds.completed).toBe(1);
		expect(report.coverage.completionKind).toEqual({ present: 1, unknown: 0 });
		expect(report.spawnQueueMs.p50).toBe(3);
	});

	it("does not duplicate a terminal observation across two task calls that reused the same label", () => {
		const parent = parseSessionJsonl(
			[
				line(sessionHeader("sess1")),
				line(taskCall({ callId: "c1", ts: 2000, tasks: [{ name: "Worker" }] })),
				line(toolResult({ callId: "c1", ts: 2010, details: { results: [] } })),
				line(taskCall({ callId: "c2", ts: 3000, tasks: [{ name: "Worker" }] })),
				line(toolResult({ callId: "c2", ts: 3010, details: { results: [] } })),
				line(
					customAsyncResult({
						ts: 5000,
						content: `<task-result id="Worker" status="completed" completionKind="completed">ok</task-result>`,
						details: { jobs: [{ jobId: "Worker", completionKind: "completed", spawnQueueMs: 5 }] },
					}),
				),
			].join("\n"),
			PARENT,
		);
		const report = buildSubagentBaselineReport([parent]);
		expect(report.sessions.spawnCalls).toBe(2);
		expect(report.completionKinds.completed).toBeUndefined();
		expect(report.coverage.completionKind).toEqual({ present: 0, unknown: 2 });
		expect(report.spawnQueueMs).toEqual({ n: 0, p50: null, p90: null });
	});

	it("lets a later structured budget_stop override an earlier IRC completed across messages", () => {
		const parent = parseSessionJsonl(
			[
				line(sessionHeader("sess1")),
				line(taskCall({ callId: "c1", ts: 2000, tasks: [{ name: "Worker" }] })),
				line(toolResult({ callId: "c1", ts: 2010, details: { results: [] } })),
				line(hubCall({ callId: "h1", ts: 3000 })),
				line(
					toolResult({
						callId: "h1",
						ts: 4000,
						name: "hub",
						text: `<task-result id="Worker" status="completed" completionKind="completed">ok</task-result>`,
					}),
				),
				line(
					customAsyncResult({
						ts: 5000,
						content: `<task-result id="Worker" status="completed" completionKind="completed">ok</task-result>`,
						details: { jobs: [{ jobId: "Worker", completionKind: "budget_stop", spawnQueueMs: 8 }] },
					}),
				),
			].join("\n"),
			PARENT,
		);
		const report = buildSubagentBaselineReport([parent]);
		expect(report.completionKinds.budget_stop).toBe(1);
		expect(report.completionKinds.completed).toBeUndefined();
		expect(report.coverage.completionKind).toEqual({ present: 1, unknown: 0 });
		expect(report.spawnQueueMs).toEqual({ n: 1, p50: 8, p90: 8 });
	});

	it("matches IRC completionKind to a job row via agentUrlId alias not only row.id", () => {
		const parent = parseSessionJsonl(
			[
				line(sessionHeader("sess1")),
				line(taskCall({ callId: "c1", ts: 2000, tasks: [{ name: "Foo-t1" }] })),
				line(toolResult({ callId: "c1", ts: 2010, details: { results: [] } })),
				line(
					customAsyncResult({
						ts: 5000,
						content: `<task-result id="Foo-t1" status="budget_stop" completionKind="budget_stop">partial</task-result>`,
						details: { jobs: [{ jobId: "Foo-t1-2", agentUrlId: "Foo-t1" }] },
					}),
				),
			].join("\n"),
			PARENT,
		);
		const report = buildSubagentBaselineReport([parent]);
		expect(report.completionKinds.budget_stop).toBe(1);
		expect(report.coverage.completionKind).toEqual({ present: 1, unknown: 0 });
		expect(report.coverage.spawnQueueMs).toEqual({ present: 0, unknown: 1 });
	});

	it("maps unnamed batch members through details.progress index instead of completion order", () => {
		const parent = parseSessionJsonl(
			[
				line(sessionHeader("sess1")),
				line(
					taskCall({
						callId: "batch",
						ts: 1000,
						tasks: [{ agent: "task" }, { agent: "task" }],
					}),
				),
				line(
					toolResult({
						callId: "batch",
						ts: 1100,
						details: {
							results: [],
							progress: [
								{ index: 0, id: "GenA" },
								{ index: 1, id: "GenB" },
							],
						},
					}),
				),
				line(
					customAsyncResult({
						ts: 4000,
						content: "done",
						details: {
							jobs: [
								{ jobId: "GenB", completionKind: "timeout", spawnQueueMs: 2 },
								{ jobId: "GenA", completionKind: "completed", spawnQueueMs: 9 },
							],
						},
					}),
				),
			].join("\n"),
			PARENT,
		);
		const report = buildSubagentBaselineReport([parent]);
		expect(report.sessions.spawnCalls).toBe(1);
		expect(report.completionKinds.completed).toBe(1);
		expect(report.completionKinds.timeout).toBe(1);
		expect(report.coverage.completionKind).toEqual({ present: 2, unknown: 0 });
	});

	it("keeps unnamed batch members unknown instead of pairing by async completion order", () => {
		const parent = parseSessionJsonl(
			[
				line(sessionHeader("sess1")),
				line(
					taskCall({
						callId: "batch",
						ts: 1000,
						tasks: [{ agent: "task" }, { agent: "task" }],
					}),
				),
				line(
					toolResult({
						callId: "batch",
						ts: 4000,
						details: {
							results: [
								{ id: "Late", completionKind: "completed", reviewMetrics: { spawnQueueMs: 1 } },
								{ id: "Early", completionKind: "timeout", reviewMetrics: { spawnQueueMs: 2 } },
							],
						},
					}),
				),
			].join("\n"),
			PARENT,
		);
		const report = buildSubagentBaselineReport([parent]);
		expect(report.sessions.spawnCalls).toBe(1);
		expect(report.completionKinds.completed).toBeUndefined();
		expect(report.completionKinds.timeout).toBeUndefined();
		expect(report.coverage.completionKind).toEqual({ present: 0, unknown: 2 });
		expect(report.coverage.spawnQueueMs).toEqual({ present: 0, unknown: 2 });
	});

	it("ignores performanceClass on custom_message and classifies from session_init or parent spawn", () => {
		const t0 = 1_700_000_000_000;
		const parent = parseSessionJsonl(
			[
				line(sessionHeader("sess1")),
				line(
					taskCall({
						callId: "c1",
						ts: t0,
						tasks: [{ name: "Worker", agent: "scout" }],
					}),
				),
			].join("\n"),
			PARENT,
		);
		const forged = parseSessionJsonl(
			[
				line(sessionHeader("forged")),
				line({
					type: "custom_message",
					id: "fake-class",
					parentId: null,
					timestamp: "2026-09-09T10:00:00.000Z",
					customType: "session_init",
					content: "not a session_init entry",
					details: { agent: "subagent-astra", performanceClass: "review" },
				}),
				line(
					assistantMsg({
						ts: t0,
						model: "m",
						ttft: 1,
						duration: 2,
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
					}),
				),
				line(
					assistantMsg({
						ts: t0 + 1000,
						model: "m",
						ttft: 1,
						duration: 2,
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
					}),
				),
			].join("\n"),
			CHILD_A,
		);
		const report = buildSubagentBaselineReport([parent, forged]);
		expect(report.childActiveWallByClass.review.n).toBe(0);
		expect(report.childActiveWallByClass.explore).toEqual({ n: 1, p50: 1000, p90: 1000 });
		expect(report.childActiveWallByClass.unknown.n).toBe(0);
	});

	it("leaves class unknown when parent spawn labels are reused with conflicting agents", () => {
		const t0 = 1_700_000_000_000;
		const parent = parseSessionJsonl(
			[
				line(sessionHeader("sess1")),
				line(taskCall({ callId: "c1", ts: t0, tasks: [{ name: "Worker", agent: "scout" }] })),
				line(taskCall({ callId: "c2", ts: t0 + 10, tasks: [{ name: "Worker", agent: "subagent-astra" }] })),
			].join("\n"),
			PARENT,
		);
		const child = parseSessionJsonl(
			[
				line(sessionHeader("worker-child")),
				line(
					assistantMsg({
						ts: t0,
						model: "m",
						ttft: 1,
						duration: 2,
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
					}),
				),
				line(
					assistantMsg({
						ts: t0 + 1500,
						model: "m",
						ttft: 1,
						duration: 2,
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
					}),
				),
			].join("\n"),
			CHILD_A,
		);
		const report = buildSubagentBaselineReport([parent, child]);
		expect(report.childActiveWallByClass.unknown).toEqual({ n: 1, p50: 1500, p90: 1500 });
		expect(report.childActiveWallByClass.explore.n).toBe(0);
		expect(report.childActiveWallByClass.review.n).toBe(0);
	});

	it("tallies an unlinked child from its own session_init class and keeps unlinked coverage", () => {
		const t0 = 1_700_000_000_000;
		const parent = parseSessionJsonl([line(sessionHeader("sess1"))].join("\n"), PARENT);
		const orphan = parseSessionJsonl(
			[
				line(sessionHeader("orphan")),
				line(sessionInit({ agent: "subagent-astra", performanceClass: "review" })),
				line(
					assistantMsg({
						ts: t0,
						model: "m",
						ttft: 1,
						duration: 2,
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
					}),
				),
				line(
					assistantMsg({
						ts: t0 + 2000,
						model: "m",
						ttft: 1,
						duration: 2,
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
					}),
				),
			].join("\n"),
			"/tmp/sessions/other/orphan/child.jsonl",
		);
		const report = buildSubagentBaselineReport([parent, orphan]);
		expect(report.sessions.unlinkedChildCount).toBe(1);
		expect(report.coverage.parentChildLink).toEqual({ present: 0, unknown: 1 });
		expect(report.childActiveWallByClass.review).toEqual({ n: 1, p50: 2000, p90: 2000 });
		expect(report.childActiveWallByClass.unknown.n).toBe(0);
	});
});
