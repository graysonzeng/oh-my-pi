/**
 * Contracts: final async `task` snapshots vs. the tool call's own lifecycle.
 *
 * A `task` call with background jobs streams `tool_execution_update` frames
 * whose `details.async.state` can settle ("completed"/"failed") at any time
 * relative to the call's `tool_execution_end` (mixed blocking+async calls run
 * their jobs while the call is still executing).
 *
 * 1. A final async frame arriving BEFORE the call's end is a partial frame:
 *    the block stays tracked so `tool_execution_end` still delivers the
 *    terminal result (previously the block was dropped from tracking and the
 *    real result never rendered — the "disappearing task call").
 * 2. A final async frame arriving AFTER an end that parked the block as
 *    background ("running") finalizes and untracks it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";
import { type BashToolDetails, formatBackgroundNotice } from "@oh-my-pi/pi-tui/tools/bash";
import type { CoordinationDetails, JobSnapshot } from "@oh-my-pi/pi-tui/tools/wait";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

function taskResult(asyncState: "running" | "completed" | "failed" | undefined, text: string) {
	const details: TaskToolDetails = {
		projectAgentsDir: null,
		results: [],
		totalDurationMs: 5,
		...(asyncState ? { async: { state: asyncState, jobId: "Job1", type: "task" as const } } : {}),
	};
	return { content: [{ type: "text" as const, text }], details };
}

function bashResult(text: string) {
	const details: BashToolDetails = {
		async: { state: "running", jobId: "bash-1", type: "bash" },
	};
	return { content: [{ type: "text" as const, text }], details };
}

function hubWaitResult(jobs: JobSnapshot[], text = "") {
	const details: CoordinationDetails = { op: "wait", jobs };
	return { content: [{ type: "text" as const, text }], details };
}

function visible(component: { render: (width: number) => readonly string[] }): string {
	return Bun.stripANSI(component.render(120).join("\n"));
}

describe("EventController async update finalization", () => {
	const sealed: ToolExecutionComponent[] = [];

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	afterEach(() => {
		for (const component of sealed.splice(0)) component.seal();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	function createFixture(isStreaming = false) {
		const pendingTools = new Map<string, ToolExecutionComponent>();
		const ctx = createInteractiveModeContext({
			pendingTools,
			session: { isStreaming: true },
			viewSession: { isStreaming },
		});
		return { controller: new EventController(ctx), pendingTools, chatContainer: ctx.chatContainer, ctx };
	}

	async function startTask(controller: EventController, pendingTools: Map<string, ToolExecutionComponent>) {
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "tc-task",
			toolName: "task",
			args: { context: "ctx", tasks: [{ agent: "task", task: "work" }] },
		});
		const component = pendingTools.get("tc-task")!;
		sealed.push(component);
		return component;
	}

	it("keeps the block tracked when a final async frame precedes tool_execution_end", async () => {
		const { controller, pendingTools } = createFixture();
		const component = await startTask(controller, pendingTools);

		// The job settled while the call is still executing (mixed call).
		await controller.handleEvent({
			type: "tool_execution_update",
			toolCallId: "tc-task",
			toolName: "task",
			args: {},
			partialResult: taskResult("completed", "Background task Job1 complete."),
		});
		expect(pendingTools.get("tc-task")).toBe(component);
		expect(component.isTranscriptBlockFinalized()).toBe(false);

		// The call's own result still lands and finalizes the block.
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "tc-task",
			toolName: "task",
			result: taskResult("completed", "Inline results + spawned listing."),
			isError: false,
		});
		expect(pendingTools.has("tc-task")).toBe(false);
		expect(component.isTranscriptBlockFinalized()).toBe(true);
	});

	it("finalizes a parked background block when its jobs settle after the end", async () => {
		const { controller, pendingTools } = createFixture();
		const component = await startTask(controller, pendingTools);

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "tc-task",
			toolName: "task",
			result: taskResult("running", "Spawned agent `Job1` (job `Job1`)."),
			isError: false,
		});
		// Background: kept tracked so later job frames can update it.
		expect(pendingTools.get("tc-task")).toBe(component);
		expect(component.isTranscriptBlockFinalized()).toBe(true);

		await controller.handleEvent({
			type: "tool_execution_update",
			toolCallId: "tc-task",
			toolName: "task",
			args: {},
			partialResult: taskResult("completed", "Background task Job1 complete."),
		});
		expect(pendingTools.has("tc-task")).toBe(false);
		expect(component.isTranscriptBlockFinalized()).toBe(true);
	});

	for (const arrival of ["early", "replay"] as const) {
		for (const state of ["completed", "failed"] as const) {
			it(`renders the ${state} outcome after a ${arrival} background task result`, async () => {
				const { controller, pendingTools, chatContainer, ctx } = createFixture(true);
				ctx.eventController = controller;
				const helpers = new UiHelpers(ctx);
				ctx.addMessageToChat = helpers.addMessageToChat.bind(helpers);
				const running = taskResult("running", "Spawned background worker.");
				if (arrival === "early") {
					await controller.handleEvent({
						type: "tool_execution_end",
						toolCallId: "tc-task",
						toolName: "task",
						result: running,
						isError: false,
					});
					await controller.handleEvent({
						type: "tool_execution_start",
						toolCallId: "tc-task",
						toolName: "task",
						args: { tasks: [{ task: "work" }] },
					});
				} else {
					const result: ToolResultMessage = {
						role: "toolResult",
						toolCallId: "tc-task",
						toolName: "task",
						...running,
						isError: false,
						timestamp: 2,
					};
					ctx.viewSession.agent.getPendingToolResults = () => [result];
					controller.resetTranscriptAnchors();
					const assistant: AssistantMessage = {
						role: "assistant",
						content: [
							{ type: "toolCall", id: "tc-task", name: "task", arguments: { tasks: [{ task: "work" }] } },
						],
						api: "anthropic-messages",
						provider: "anthropic",
						model: "test",
						stopReason: "toolUse",
						timestamp: 1,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					};
					helpers.renderSessionContext({ messages: [assistant] } as SessionContext);
					controller.restorePendingToolResults();
					ctx.viewSession.agent.getPendingToolResults = () => [];
				}
				const component = chatContainer.children.find(
					(child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent,
				)!;
				sealed.push(component);
				component.setExpanded(true);
				await controller.handleEvent({ type: "agent_start" });
				const outcome =
					state === "completed" ? "Worker produced the final report." : "Worker failed to read its input.";
				await controller.handleEvent({
					type: "tool_execution_update",
					toolCallId: "tc-task",
					toolName: "task",
					args: {},
					partialResult: taskResult(state, outcome),
				});
				expect(Bun.stripANSI(chatContainer.render(120).join("\n"))).toContain(outcome);
				expect(pendingTools.has("tc-task")).toBe(false);
				expect(component.isTranscriptBlockFinalized()).toBe(true);
			});
		}
	}

	it("finalizes a backgrounded Bash block without tracking later job updates", async () => {
		const { controller, pendingTools } = createFixture();
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "tc-bash",
			toolName: "bash",
			args: { command: "sleep 30" },
		});
		const component = pendingTools.get("tc-bash")!;
		sealed.push(component);

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "tc-bash",
			toolName: "bash",
			result: bashResult(formatBackgroundNotice("bash-1")),
			isError: false,
		});

		expect(pendingTools.has("tc-bash")).toBe(false);
		expect(component.isTranscriptBlockFinalized()).toBe(true);
	});

	it("settles an early wait result while another reported job remains running", async () => {
		const { controller, pendingTools, chatContainer } = createFixture();
		const details: CoordinationDetails = {
			op: "wait",
			jobs: [
				{ id: "Job1", type: "task", status: "completed", label: "Finished work", durationMs: 5 },
				{ id: "Job2", type: "task", status: "running", label: "Background work", durationMs: 5 },
			],
		};
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "tc-wait",
			toolName: "wait",
			result: { content: [{ type: "text", text: "Job1 finished; Job2 is still running." }], details },
			isError: false,
		});
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "tc-wait",
			toolName: "wait",
			args: {},
		});
		const component = chatContainer.children.find(
			(child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent,
		)!;
		sealed.push(component);
		component.setExpanded(true);
		expect(Bun.stripANSI(chatContainer.render(120).join("\n"))).toContain("Job1 Finished work");
		expect(pendingTools.has("tc-wait")).toBe(false);
		expect(component.isTranscriptBlockFinalized()).toBe(true);
	});

	it("seals a foreground card orphaned before the next agent turn", async () => {
		const { controller, chatContainer, ctx } = createFixture();
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "tc-stale",
			toolName: "wait",
			args: {},
		});
		const component = chatContainer.children.find(
			(child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent,
		);
		if (!component) throw new Error("expected stale wait card");
		sealed.push(component);
		// Model a dropped live completion: the timeline still owns the card but
		// its pending-map entry is gone, so agent_end cannot find it.
		ctx.pendingTools.delete("tc-stale");
		const later = new ToolExecutionComponent("bash", { command: "echo done" }, {}, undefined, ctx.ui, process.cwd());
		sealed.push(later);
		later.updateResult({ content: [{ type: "text", text: "done" }] });
		chatContainer.addChild(later);

		expect(component.isTranscriptBlockFinalized()).toBe(false);
		expect(chatContainer.peekFinalizedBatch(80, 0)).toBeUndefined();
		await controller.handleEvent({ type: "agent_start" });

		expect(component.isTranscriptBlockFinalized()).toBe(true);
		expect(chatContainer.peekFinalizedBatch(80, 0)?.rows).toBeDefined();
	});

	it("keeps a parked task card available across the next agent turn", async () => {
		const { controller, pendingTools } = createFixture();
		const component = await startTask(controller, pendingTools);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "tc-task",
			toolName: "task",
			result: taskResult("running", "Spawned agent `Job1` (job `Job1`)."),
			isError: false,
		});

		await controller.handleEvent({ type: "agent_start" });

		expect(pendingTools.get("tc-task")).toBe(component);
	});

	it("renders hub wait live activity on tool_execution_update and drops it after settle", async () => {
		const { controller, pendingTools } = createFixture();
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "tc-wait",
			toolName: "hub",
			args: { op: "wait", ids: ["AuthLoader"] },
		});
		const component = pendingTools.get("tc-wait")!;
		sealed.push(component);

		await controller.handleEvent({
			type: "tool_execution_update",
			toolCallId: "tc-wait",
			toolName: "hub",
			args: { op: "wait", ids: ["AuthLoader"] },
			partialResult: hubWaitResult([
				{
					id: "AuthLoader",
					type: "task",
					status: "running",
					label: "AuthLoader",
					durationMs: 8_700,
					liveActivity: { tool: "read", detail: "src/auth.ts", elapsedMs: 6_000 },
				},
			]),
		});
		const live = visible(component);
		expect(live).toContain("AuthLoader");
		expect(live).toMatch(/read: src\/auth\.ts/);
		expect(live).toContain("6.0s");
		const liveNarrow = Bun.stripANSI(component.render(40).join("\n"));
		expect(liveNarrow).toContain("AuthLoader");
		expect(liveNarrow).toMatch(/read: src\/auth\.ts/);
		expect(liveNarrow).toContain("6.0s");
		for (const line of liveNarrow.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
		}

		await controller.handleEvent({
			type: "tool_execution_update",
			toolCallId: "tc-wait",
			toolName: "hub",
			args: { op: "wait", ids: ["AuthLoader"] },
			partialResult: hubWaitResult([
				{
					id: "AuthLoader",
					type: "task",
					status: "running",
					label: "AuthLoader",
					durationMs: 9_200,
					liveActivity: { tool: "grep", detail: "password" },
				},
			]),
		});
		const switched = visible(component);
		expect(switched).toMatch(/grep: password/);
		expect(switched).not.toContain("src/auth.ts");
		expect(switched).not.toContain("6.0s");
		const switchedNarrow = Bun.stripANSI(component.render(40).join("\n"));
		expect(switchedNarrow).toMatch(/grep: password/);
		expect(switchedNarrow).not.toContain("src/auth.ts");
		expect(switchedNarrow).not.toContain("6.0s");
		for (const line of switchedNarrow.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
		}

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "tc-wait",
			toolName: "hub",
			result: hubWaitResult(
				[
					{
						id: "AuthLoader",
						type: "task",
						status: "completed",
						label: "AuthLoader",
						durationMs: 10_000,
						resultText: "settled body",
					},
				],
				"settled body",
			),
			isError: false,
		});
		const settled = visible(component);
		expect(settled).toContain("settled body");
		expect(settled).not.toMatch(/read: src\/auth\.ts/);
		expect(settled).not.toMatch(/grep: password/);
		const settledNarrow = Bun.stripANSI(component.render(40).join("\n"));
		expect(settledNarrow).toContain("settled body");
		expect(settledNarrow).not.toMatch(/read: src\/auth\.ts/);
		expect(settledNarrow).not.toMatch(/grep: password/);
		for (const line of settledNarrow.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
		}
		expect(pendingTools.has("tc-wait")).toBe(false);
	});

	it("truncates hub wait live activity to the parent transcript viewport", async () => {
		const { controller, pendingTools } = createFixture();
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "tc-wait-narrow",
			toolName: "hub",
			args: { op: "wait", ids: ["AuthLoader"] },
		});
		const component = pendingTools.get("tc-wait-narrow")!;
		sealed.push(component);
		const longTool = `mcp__${"very-long-custom-tool-name-".repeat(8)}search`;
		await controller.handleEvent({
			type: "tool_execution_update",
			toolCallId: "tc-wait-narrow",
			toolName: "hub",
			args: { op: "wait", ids: ["AuthLoader"] },
			partialResult: hubWaitResult([
				{
					id: "AuthLoader",
					type: "task",
					status: "running",
					label: "AuthLoader",
					durationMs: 8_700,
					liveActivity: { tool: longTool, detail: "src/auth.ts" },
				},
			]),
		});
		const lines = component.render(48).map(line => Bun.stripANSI(line));
		const activity = lines.find(line => /mcp|search|auth/.test(line) && !line.includes("AuthLoader"));
		expect(activity).toBeDefined();
		expect(activity).not.toContain(longTool);
		expect(Bun.stringWidth(activity!)).toBeLessThanOrEqual(48);
		for (const line of lines) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(48);
		}
		const mcpNarrow = component.render(40).map(line => Bun.stripANSI(line));
		const mcpActivity = mcpNarrow.find(line => /mcp|search|auth/.test(line) && !line.includes("AuthLoader"));
		expect(mcpActivity).toBeDefined();
		expect(mcpActivity).not.toContain(longTool);
		expect(Bun.stringWidth(mcpActivity!)).toBeLessThanOrEqual(40);
		for (const line of mcpNarrow) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
		}
	});

	it("shortens home paths in hub wait live activity on the parent transcript", async () => {
		const { controller, pendingTools } = createFixture();
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "tc-wait-home",
			toolName: "hub",
			args: { op: "wait", ids: ["AuthLoader"] },
		});
		const component = pendingTools.get("tc-wait-home")!;
		sealed.push(component);
		const homeFile = `${os.homedir()}/secret/token.ts`;
		await controller.handleEvent({
			type: "tool_execution_update",
			toolCallId: "tc-wait-home",
			toolName: "hub",
			args: { op: "wait", ids: ["AuthLoader"] },
			partialResult: hubWaitResult([
				{
					id: "AuthLoader",
					type: "task",
					status: "running",
					label: "AuthLoader",
					durationMs: 8_700,
					liveActivity: { tool: "bash", detail: `\tcat ${homeFile}` },
				},
			]),
		});
		const live = visible(component);
		expect(live).toContain("bash:");
		expect(live).toContain("~/secret/token.ts");
		expect(live).not.toContain("\t");
		expect(live).not.toContain(homeFile);
		const narrow = Bun.stripANSI(component.render(40).join("\n"));
		expect(narrow).toContain("bash:");
		expect(narrow).toContain("~/secret");
		expect(narrow).not.toContain("\t");
		expect(narrow).not.toContain(homeFile);
		for (const line of narrow.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
		}
	});
});
