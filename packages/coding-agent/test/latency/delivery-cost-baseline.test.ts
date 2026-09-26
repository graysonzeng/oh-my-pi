import { describe, expect, it } from "bun:test";
import {
	buildDeliveryCostBaselineReport,
	formatDeliveryCostBaselineReport,
} from "../../src/latency/delivery-cost-baseline";
import { buildSubagentBaselineReport, parseSessionJsonl } from "../../src/latency/subagent-report";

const PARENT = "/tmp/sessions/demo/sess1.jsonl";
const CHILD_A = "/tmp/sessions/demo/sess1/Worker.jsonl";
const CHILD_B = "/tmp/sessions/demo/sess1/Scout.jsonl";
const PARENT2 = "/tmp/sessions/demo/sess2.jsonl";

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
			model: opts.model ?? "gateway/grok-4.6",
			stopReason: "stop",
			ttft: opts.ttft ?? 10,
			duration: opts.duration ?? 40,
			usage: opts.usage,
		},
	};
}

function toolResult(opts: {
	callId: string;
	ts: number;
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
			toolName: "task",
			content: [{ type: "text", text: "done" }],
			isError: false,
			timestamp: opts.ts,
			details: opts.details,
		},
	};
}

function taskCall(opts: {
	callId: string;
	ts: number;
	tasks: Record<string, unknown>[];
}): unknown {
	return assistantMsg({
		ts: opts.ts,
		usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, cost: { total: 0.05 } },
		content: [
			{
				type: "toolCall",
				id: opts.callId,
				name: "task",
				arguments: { agent: "task", tasks: opts.tasks },
			},
		],
	});
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

function parentFinal(opts: {
	status: "passed" | "failed";
	source: string;
	verifiedAtMs: number;
}): unknown {
	return {
		type: "custom",
		id: `pfv-${opts.verifiedAtMs}`,
		parentId: null,
		timestamp: "2026-09-09T10:00:00.000Z",
		customType: "parent_final_verification",
		data: {
			status: opts.status,
			source: opts.source,
			verifiedAtMs: opts.verifiedAtMs,
		},
	};
}

describe("delivery cost baseline", () => {
	it("separates ordinary vs workflow and reports costPerAccepted without zero-filling unknowns", () => {
		const ordinaryParent = parseSessionJsonl(
			[
				line(sessionHeader("ord1")),
				line(userMsg(0, "go")),
				line(taskCall({ callId: "c1", ts: 1000, tasks: [{ name: "Worker", agent: "task" }] })),
				line(
					toolResult({
						callId: "c1",
						ts: 3000,
						details: { results: [{ id: "Worker", completionKind: "completed" }] },
					}),
				),
				line(parentFinal({ status: "passed", source: "extension", verifiedAtMs: 4000 })),
			].join("\n"),
			PARENT,
		);
		const ordinaryChild = parseSessionJsonl(
			[
				line(sessionHeader("ochild", { parentSession: PARENT })),
				line(sessionInit({ agent: "task", performanceClass: "worker" })),
				line(userMsg(1100, "work")),
				line(
					assistantMsg({
						ts: 2500,
						usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 0, cost: { total: 0.2 } },
					}),
				),
			].join("\n"),
			CHILD_A,
		);

		const workflowParent = parseSessionJsonl(
			[
				line(sessionHeader("wf1")),
				line(userMsg(0, "go")),
				line(taskCall({ callId: "c1", ts: 1000, tasks: [{ name: "Worker", agent: "task" }] })),
				line(
					toolResult({
						callId: "c1",
						ts: 2000,
						details: { results: [{ id: "Worker", completionKind: "timeout" }] },
					}),
				),
				line(parentFinal({ status: "failed", source: "workflow", verifiedAtMs: 2500 })),
				line(taskCall({ callId: "c2", ts: 3000, tasks: [{ name: "Worker", agent: "task" }] })),
				line(
					toolResult({
						callId: "c2",
						ts: 5000,
						details: { results: [{ id: "Worker", completionKind: "completed" }] },
					}),
				),
				line(parentFinal({ status: "passed", source: "workflow", verifiedAtMs: 6000 })),
			].join("\n"),
			PARENT2,
		);
		const workflowChild = parseSessionJsonl(
			[
				line(sessionHeader("wchild", { parentSession: PARENT2 })),
				line(sessionInit({ agent: "task", performanceClass: "worker" })),
				line(userMsg(1100, "work")),
				line(
					assistantMsg({
						ts: 1800,
						usage: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } },
					}),
				),
			].join("\n"),
			"/tmp/sessions/demo/sess2/Worker.jsonl",
		);

		const report = buildDeliveryCostBaselineReport([
			ordinaryParent,
			ordinaryChild,
			workflowParent,
			workflowChild,
		]);

		expect(report.ordinary.taskCount).toBe(1);
		expect(report.workflow.taskCount).toBe(1);
		expect(report.ordinary.acceptedTaskCount).toBe(1);
		expect(report.workflow.acceptedTaskCount).toBe(1);

		// ordinary: parent 0.05 + child 0.2 = 0.25; one accepted → 0.25
		expect(report.ordinary.totalAttemptCost).toBeCloseTo(0.25);
		expect(report.ordinary.costPerAcceptedTask).toBeCloseTo(0.25);
		expect(report.ordinary.firstPassRate).toBe(1);
		expect(report.ordinary.falseAccept).toBe("unknown");
		expect(report.ordinary.missedDefects).toBe("unknown");

		// workflow first delivery failed → firstPassRate 0; still accepted after repair
		expect(report.workflow.firstPassRate).toBe(0);
		const wfTask = report.tasks.find(t => t.cohort === "workflow");
		expect(wfTask?.firstDeliveryAccepted).toBe(false);
		expect(wfTask?.cyclesAfterFirstDelivery.verify).toBe(1);
		expect(wfTask?.attemptCostByKind.timeout).toBeCloseTo(0.1);

		const human = formatDeliveryCostBaselineReport(report);
		expect(human).toContain("ordinary ≠ workflow");
		expect(human).toContain("ordinary:");
		expect(human).toContain("workflow:");
		expect(human).not.toContain("/tmp/sessions");
	});

	it("keeps missing cost and cycle signals as null/unknown rather than 0", () => {
		const parent = parseSessionJsonl(
			[
				line(sessionHeader("bare")),
				line(userMsg(0, "go")),
				line(
					assistantMsg({
						ts: 1000,
						content: [{ type: "toolCall", id: "c1", name: "task", arguments: { tasks: [{ name: "Worker" }] } }],
					}),
				),
				line(toolResult({ callId: "c1", ts: 2000, details: { results: [{ id: "Worker" }] } })),
			].join("\n"),
			PARENT,
		);
		const report = buildDeliveryCostBaselineReport([parent]);
		expect(report.unknownCohort.taskCount).toBe(1);
		expect(report.unknownCohort.acceptedTaskCount).toBe(0);
		expect(report.unknownCohort.costPerAcceptedTask).toBeNull();
		expect(report.unknownCohort.totalAttemptCost).toBeNull();
		expect(report.unknownCohort.firstPassRate).toBeNull();
		expect(report.unknownCohort.falseAccept).toBe("unknown");
		expect(report.unknownCohort.missedDefects).toBe("unknown");
		const task = report.tasks[0]!;
		expect(task.firstDeliveryAccepted).toBe("unknown");
		expect(task.usage.costTotal).toBeNull();
		expect(task.attemptCostByKind.timeout).toBeNull();
		expect(task.attemptCostByKind.cancelled).toBeNull();
	});

	it("leaves costPerAcceptedTask null when any accepted task lacks priced cost", () => {
		const parent = parseSessionJsonl(
			[
				line(sessionHeader("sess-partial")),
				line(userMsg(0, "go")),
				line(parentFinal({ status: "passed", source: "workflow", verifiedAtMs: 2000 })),
				line(
					assistantMsg({
						ts: 1500,
						usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 1.0 } },
					}),
				),
			].join("\n"),
			PARENT,
		);
		const sibling = parseSessionJsonl(
			[
				line(sessionHeader("sess-partial-2")),
				line(userMsg(0, "go")),
				line(parentFinal({ status: "passed", source: "workflow", verifiedAtMs: 2000 })),
				// No priced usage — missing cost must not understate the cohort ratio.
			].join("\n"),
			"/tmp/sessions/demo/sess-partial-2.jsonl",
		);
		const report = buildDeliveryCostBaselineReport([parent, sibling]);
		expect(report.workflow.acceptedTaskCount).toBe(2);
		expect(report.workflow.totalAttemptCost).toBe(1.0);
		expect(report.workflow.coverage.attemptCost.unknown).toBeGreaterThan(0);
		expect(report.workflow.costPerAcceptedTask).toBeNull();
	});

	it("classifies mixed ordinary+workflow receipts as unknown cohort", () => {
		const parent = parseSessionJsonl(
			[
				line(sessionHeader("mixed")),
				line(userMsg(0, "go")),
				line(parentFinal({ status: "passed", source: "extension", verifiedAtMs: 1000 })),
				line(parentFinal({ status: "passed", source: "workflow", verifiedAtMs: 2000 })),
			].join("\n"),
			PARENT,
		);
		const report = buildDeliveryCostBaselineReport([parent]);
		expect(report.tasks[0]?.cohort).toBe("unknown");
		expect(report.unknownCohort.taskCount).toBe(1);
		expect(report.ordinary.taskCount).toBe(0);
		expect(report.workflow.taskCount).toBe(0);
	});

	it("attributes timeout/cancelled attempt cost and reports parent wait vs child union time", () => {
		const parent = parseSessionJsonl(
			[
				line(sessionHeader("sess1")),
				line(userMsg(0, "delegate")),
				line(
					taskCall({
						callId: "batch",
						ts: 1000,
						tasks: [
							{ name: "Worker", agent: "task" },
							{ name: "Scout", agent: "explore" },
						],
					}),
				),
				line(
					toolResult({
						callId: "batch",
						ts: 4000,
						details: {
							results: [
								{ id: "Worker", completionKind: "hard_abort" },
								{ id: "Scout", completionKind: "timeout" },
							],
						},
					}),
				),
				line(parentFinal({ status: "failed", source: "extension", verifiedAtMs: 5000 })),
			].join("\n"),
			PARENT,
		);
		const worker = parseSessionJsonl(
			[
				line(sessionHeader("w", { parentSession: PARENT })),
				line(sessionInit({ agent: "task", performanceClass: "worker" })),
				line(userMsg(1100, "w")),
				line(
					assistantMsg({
						ts: 3000,
						usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.3 } },
					}),
				),
			].join("\n"),
			CHILD_A,
		);
		const scout = parseSessionJsonl(
			[
				line(sessionHeader("s", { parentSession: PARENT })),
				line(sessionInit({ agent: "explore", performanceClass: "explore" })),
				line(userMsg(1200, "s")),
				line(
					assistantMsg({
						ts: 3500,
						usage: { input: 8, output: 1, cacheRead: 4, cacheWrite: 0, cost: { total: 0.15 } },
					}),
				),
			].join("\n"),
			CHILD_B,
		);
		const report = buildDeliveryCostBaselineReport([parent, worker, scout]);
		const task = report.tasks[0]!;
		expect(task.parentWaitMs).toBe(3000);
		// overlapping children 1100→3000 and 1200→3500 ⇒ union 2400, not 1900+2300
		expect(task.childTaskMs).toBe(2400);
		// integrate: last task result (4000) → parent-final (5000)
		expect(task.parentIntegrateMs).toBe(1000);
		expect(task.attemptCostByKind.cancelled).toBeCloseTo(0.3);
		expect(task.attemptCostByKind.timeout).toBeCloseTo(0.15);
		expect(report.ordinary.acceptedTaskCount).toBe(0);
		expect(report.ordinary.costPerAcceptedTask).toBeNull();
		expect(report.ordinary.totalAttemptCost).toBeCloseTo(0.05 + 0.3 + 0.15);
	});

	it("records explicit quality outcomes and leaves them unknown when absent", () => {
		const withOutcome = parseSessionJsonl(
			[
				line(sessionHeader("q1")),
				line(userMsg(0, "go")),
				line(parentFinal({ status: "passed", source: "extension", verifiedAtMs: 1000 })),
				line({
					type: "custom",
					customType: "delivery_quality_outcome",
					data: { falseAccept: true, missedDefect: false },
				}),
			].join("\n"),
			PARENT,
		);
		const report = buildDeliveryCostBaselineReport([withOutcome]);
		expect(report.ordinary.falseAccept).toBe(1);
		expect(report.ordinary.missedDefects).toBe(0);
		expect(report.tasks[0]?.falseAccept).toBe(true);
		expect(report.tasks[0]?.missedDefect).toBe(false);
	});

	it("wires into SubagentBaselineReport without leaking paths", () => {
		const parent = parseSessionJsonl(
			[
				line(sessionHeader("sess1")),
				line(userMsg(0, "go")),
				line(parentFinal({ status: "passed", source: "workflow", verifiedAtMs: 1000 })),
			].join("\n"),
			PARENT,
		);
		const report = buildSubagentBaselineReport([parent]);
		expect(report.deliveryCost.workflow.taskCount).toBe(1);
		expect(report.deliveryCost.workflow.acceptedTaskCount).toBe(1);
		const human = JSON.stringify(report.deliveryCost) + formatDeliveryCostBaselineReport(report.deliveryCost);
		expect(human).not.toContain("/tmp/sessions");
	});

	it("counts post-first-delivery investigate/fix cycles from later child classes", () => {
		const parent = parseSessionJsonl(
			[
				line(sessionHeader("sess1")),
				line(userMsg(0, "go")),
				line(taskCall({ callId: "c1", ts: 1000, tasks: [{ name: "Worker" }] })),
				line(
					toolResult({
						callId: "c1",
						ts: 2000,
						details: { results: [{ id: "Worker", completionKind: "completed" }] },
					}),
				),
				line(parentFinal({ status: "failed", source: "workflow", verifiedAtMs: 2500 })),
				line(taskCall({ callId: "c2", ts: 3000, tasks: [{ name: "Scout" }, { name: "Worker2" }] })),
				line(
					toolResult({
						callId: "c2",
						ts: 6000,
						details: {
							results: [
								{ id: "Scout", completionKind: "completed" },
								{ id: "Worker2", completionKind: "completed" },
							],
						},
					}),
				),
				line(parentFinal({ status: "passed", source: "workflow", verifiedAtMs: 7000 })),
			].join("\n"),
			PARENT,
		);
		const firstWorker = parseSessionJsonl(
			[
				line(sessionHeader("w1", { parentSession: PARENT })),
				line(sessionInit({ performanceClass: "worker" })),
				line(userMsg(1100, "a")),
				line(assistantMsg({ ts: 1800, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } })),
			].join("\n"),
			CHILD_A,
		);
		const scout = parseSessionJsonl(
			[
				line(sessionHeader("s1", { parentSession: PARENT })),
				line(sessionInit({ performanceClass: "explore" })),
				line(userMsg(3100, "b")),
				line(assistantMsg({ ts: 4000, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } })),
			].join("\n"),
			CHILD_B,
		);
		const secondWorker = parseSessionJsonl(
			[
				line(sessionHeader("w2", { parentSession: PARENT })),
				line(sessionInit({ performanceClass: "worker" })),
				line(userMsg(3200, "c")),
				line(assistantMsg({ ts: 5000, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } })),
			].join("\n"),
			"/tmp/sessions/demo/sess1/Worker2.jsonl",
		);
		const report = buildDeliveryCostBaselineReport([parent, firstWorker, scout, secondWorker]);
		const task = report.tasks[0]!;
		expect(task.firstDeliveryAccepted).toBe(false);
		expect(task.cyclesAfterFirstDelivery).toEqual({ investigate: 1, fix: 1, verify: 1 });
		expect(task.accepted).toBe(true);
	});
});
