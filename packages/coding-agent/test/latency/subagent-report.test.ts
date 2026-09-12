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
});
