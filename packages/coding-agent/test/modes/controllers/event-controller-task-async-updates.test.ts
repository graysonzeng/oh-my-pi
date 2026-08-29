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
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { TaskToolDetails } from "@oh-my-pi/pi-coding-agent/task/types";
import type { BashToolDetails } from "@oh-my-pi/pi-coding-agent/tools/bash";
import type { CoordinationDetails, JobSnapshot } from "@oh-my-pi/pi-coding-agent/tools/hub";

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

	function createFixture() {
		const chatContainer = new TranscriptContainer();
		const pendingTools = new Map<string, ToolExecutionComponent>();
		const ctx = {
			isInitialized: true,
			init: vi.fn(async () => {}),
			ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
			statusLine: { invalidate: vi.fn(), markActivityStart: vi.fn(), markActivityEnd: vi.fn() },
			updateEditorTopBorder: vi.fn(),
			toolOutputExpanded: false,
			transcriptMessageComponents: new WeakMap(),
			pendingTools,
			chatContainer,
			session: { getToolByName: () => undefined, hasBuiltInTool: () => true, isStreaming: true },
			showWarning: vi.fn(),
			viewSession: { getToolByName: () => undefined, hasBuiltInTool: () => true, isStreaming: false },
			sessionManager: { getCwd: () => process.cwd() },
			setTodos: vi.fn(),
			clearPinnedError: vi.fn(),
			statusContainer: { disposeChildren: vi.fn() },
			ensureLoadingAnimation: vi.fn(),
		} as unknown as InteractiveModeContext;
		return { controller: new EventController(ctx), pendingTools, chatContainer, ctx };
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
			result: bashResult("Backgrounded as job bash-1; result will be delivered automatically."),
			isError: false,
		});

		expect(pendingTools.has("tc-bash")).toBe(false);
		expect(component.isTranscriptBlockFinalized()).toBe(true);
	});

	it("seals a foreground card orphaned before the next agent turn", async () => {
		const { controller, chatContainer, ctx } = createFixture();
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "tc-stale",
			toolName: "hub",
			args: { op: "wait", ids: ["job-stale"] },
		});
		const component = chatContainer.children.find(
			(child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent,
		);
		if (!component) throw new Error("expected stale Hub card");
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
