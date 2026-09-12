/**
 * Unified `hub` wait: one blocking primitive racing background jobs against
 * incoming peer messages. These contracts are new to the merge — the halves
 * (pure message wait, pure job poll) are covered by the pre-existing
 * messaging/job suites.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import * as os from "node:os";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import type { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { type AgentProgress, copySpawnJobLiveProgress } from "@oh-my-pi/pi-coding-agent/task";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { type CoordinationDetails, HubTool, hubToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/hub";

const SELF_ID = "Main";

function createWaitTranscript() {
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
	return { controller: new EventController(ctx), pendingTools };
}

function renderWaitJobs(details: CoordinationDetails, isPartial: boolean): string {
	return Bun.stripANSI(
		(
			hubToolRenderer
				.renderResult(
					{ content: [{ type: "text", text: "" }], details },
					{ expanded: false, isPartial } as Parameters<typeof hubToolRenderer.renderResult>[1],
					theme,
					{ op: "wait", ids: [] },
				)
				.render(120) as readonly string[]
		).join("\n"),
	);
}

function makeSession(manager: AsyncJobManager | undefined): ToolSession {
	const stub = {
		cwd: process.cwd(),
		settings: {
			get(key: string): unknown {
				if (key === "async.pollWaitDuration") return "5m";
				if (key === "irc.timeoutMs") return 120_000;
				return undefined;
			},
		},
		agentRegistry: AgentRegistry.global(),
		asyncJobManager: manager,
		getAgentId: () => SELF_ID,
	};
	// Structurally-partial test session: HubTool only touches the fields above.
	return stub as unknown as ToolSession;
}

/** Register a job that never settles on its own; returns its id + resolver. */
function registerHangingJob(manager: AsyncJobManager, label: string): { id: string; finish: (text: string) => void } {
	const { promise, resolve } = Promise.withResolvers<string>();
	const id = manager.register("bash", label, async () => promise, { ownerId: SELF_ID });
	return { id, finish: resolve };
}

describe("hub unified wait", () => {
	beforeAll(async () => {
		await initTheme();
	});
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});
	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		vi.useRealTimers();
		resetSettingsForTest();
	});

	test("an incoming message settles the wait while watched jobs keep running", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null });
		registry.register({ id: "Peer", displayName: "task", kind: "sub", parentId: SELF_ID, session: null });

		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const job = registerHangingJob(manager, "sleep forever");
		const tool = new HubTool(makeSession(manager));

		// The bus waiter is parked synchronously before execute()'s first
		// suspension, so the send below cannot race the park.
		const pending = tool.execute("call_1", { op: "wait" });
		await IrcBus.global().send({ from: "Peer", to: SELF_ID, body: "shared file is yours" });

		const result = await pending;
		const details = result.details as CoordinationDetails;
		expect(result.isError).not.toBe(true);
		expect(details.op).toBe("wait");
		expect(details.waited?.from).toBe("Peer");
		expect(details.waited?.body).toBe("shared file is yours");
		// The job was not consumed by the message win.
		expect(manager.getJob(job.id)?.status).toBe("running");

		manager.cancel(job.id);
	});

	test("a settling job returns the snapshot exactly like the old poll", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null });
		registry.register({ id: "Peer", displayName: "task", kind: "sub", parentId: SELF_ID, session: null });

		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const job = registerHangingJob(manager, "quick job");
		const tool = new HubTool(makeSession(manager));

		const pending = tool.execute("call_2", { op: "wait", ids: [job.id] });
		job.finish("done output");

		const result = await pending;
		const details = result.details as CoordinationDetails;
		expect(details.op).toBe("wait");
		expect(details.jobs?.map(j => j.status)).toEqual(["completed"]);
		expect(details.jobs?.[0]?.resultText).toBe("done output");
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("## Completed (1)");
	});
	test("wait window expiry while jobs run tells the caller not to poll", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null });
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const job = registerHangingJob(manager, "sleep forever");
		const result = await new HubTool(makeSession(manager)).execute("call_window", {
			op: "wait",
			ids: [job.id],
			timeoutMs: 40,
		});
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("## Still Running");
		expect(text).toContain("Results auto-deliver; do not poll");
		expect(result.useless).toBe(true);
		manager.cancel(job.id);
	});

	test("bare wait with no jobs and no running peers returns immediately", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null });
		registry.register({ id: "Sleeper", displayName: "task", kind: "sub", session: null, status: "idle" });

		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const tool = new HubTool(makeSession(manager));

		// A regression to a blocking message wait fails via the test timeout.
		const result = await tool.execute("call_3", { op: "wait" });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("No running background jobs to wait for.");
		expect(result.useless).toBe(true);
	});

	test("bare wait ignores a detached ref whose running status is stale", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null });
		registry.register({
			id: "Zombie",
			displayName: "stale task",
			kind: "sub",
			parentId: SELF_ID,
			session: null,
			status: "running",
		});

		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		// `timeoutMs: 0` would block forever if the stale ref still opened the
		// message-wait gate; the test times out instead of asserting.
		const result = await new HubTool(makeSession(manager)).execute("call_4", { op: "wait", timeoutMs: 0 });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("No running background jobs to wait for.");
		// The stale ref is reported (not silently dropped): it is the only handle
		// the caller has for clearing it with `hub cancel`.
		expect(text).toContain("Zombie");
		expect(text).toContain("no turn in flight");
	});

	test("bare wait returns a message already queued on the bus", async () => {
		const registry = AgentRegistry.global();
		// A recipient whose live hand-off throws is the only way a message
		// reaches the mailbox: `IrcBus.send` buffers solely from that catch.
		registry.register({
			id: SELF_ID,
			displayName: "main",
			kind: "main",
			session: {
				deliverIrcMessage: () => Promise.reject(new Error("session disposed")),
			},
		} as unknown as Parameters<AgentRegistry["register"]>[0]);
		// Idle peer: nothing is running, so the liveness gate would otherwise
		// short-circuit the wait before the mailbox is ever consulted.
		registry.register({ id: "Peer", displayName: "task", kind: "sub", session: null, status: "idle" });

		const firstReceipt = await IrcBus.global().send({ from: "Peer", to: SELF_ID, body: "picked up the lock" });
		const secondReceipt = await IrcBus.global().send({ from: "Peer", to: SELF_ID, body: "starting the edit" });
		expect(firstReceipt.outcome).toBe("failed");
		expect(secondReceipt.outcome).toBe("failed");
		expect(IrcBus.global().unreadCount(SELF_ID)).toBe(2);

		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const result = await new HubTool(makeSession(manager)).execute("call_5", { op: "wait" });
		const details = result.details as CoordinationDetails;

		expect(details.op).toBe("wait");
		expect(details.waited?.from).toBe("Peer");
		expect(details.waited?.body).toBe("picked up the lock");
		// Consumed exactly one message, not merely peeked or drained the backlog.
		expect(IrcBus.global().unreadCount(SELF_ID)).toBe(1);
		expect(
			IrcBus.global()
				.inbox(SELF_ID)
				.map(message => message.body),
		).toEqual(["starting the edit"]);
	});

	test("wait onUpdate snapshots copied current-tool activity for running task jobs", async () => {
		vi.useFakeTimers();
		const registry = AgentRegistry.global();
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null });
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const now = Date.now();
		const stale: AgentProgress = {
			index: 0,
			id: "AuthLoader",
			agent: "task",
			agentSource: "bundled",
			status: "running",
			task: "old",
			currentTool: "grep",
			currentToolArgs: "stale-args",
			currentToolStartMs: 1,
			recentTools: [{ tool: "bash", args: "stale", endMs: 1 }],
			recentOutput: [],
			toolCount: 0,
			requests: 0,
			tokens: 0,
			cost: 0,
			durationMs: 0,
		};
		copySpawnJobLiveProgress(stale, {
			...stale,
			currentTool: "read",
			currentToolArgs: "src/auth.ts",
			currentToolStartMs: now - 6_000,
			recentTools: [],
		});
		const hang = Promise.withResolvers<string>();
		const reported = Promise.withResolvers<(text: string, details?: Record<string, unknown>) => Promise<void>>();
		manager.register(
			"task",
			"AuthLoader",
			async ({ reportProgress }) => {
				await reportProgress("running", { progress: [{ ...stale }] });
				reported.resolve(reportProgress);
				return hang.promise;
			},
			{ id: "AuthLoader", ownerId: SELF_ID },
		);
		const reportProgress = await reported.promise;
		const abort = new AbortController();
		const firstUpdate = Promise.withResolvers<CoordinationDetails>();
		const secondUpdate = Promise.withResolvers<CoordinationDetails>();
		const { controller, pendingTools } = createWaitTranscript();
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "call_live",
			toolName: "hub",
			args: { op: "wait", ids: ["AuthLoader"] },
		});
		const card = pendingTools.get("call_live");
		if (!card) throw new Error("expected hub wait card");
		const pending = new HubTool(makeSession(manager)).execute(
			"call_live",
			{ op: "wait", ids: ["AuthLoader"] },
			abort.signal,
			update => {
				void controller.handleEvent({
					type: "tool_execution_update",
					toolCallId: "call_live",
					toolName: "hub",
					args: { op: "wait", ids: ["AuthLoader"] },
					partialResult: update,
				});
				if (!update.details || !("jobs" in update.details)) return;
				const tool = update.details.jobs?.[0]?.liveActivity?.tool;
				if (tool === "read") firstUpdate.resolve(update.details);
				if (tool === "grep") secondUpdate.resolve(update.details);
			},
		);
		const firstDetails = await firstUpdate.promise;
		const snapshot = firstDetails.jobs?.[0];
		expect(snapshot?.id).toBe("AuthLoader");
		expect(snapshot?.liveActivity?.tool).toBe("read");
		expect(snapshot?.liveActivity?.detail).toBe("src/auth.ts");
		expect(snapshot?.liveActivity?.elapsedMs).toBeGreaterThan(5000);
		const firstOut = renderWaitJobs(firstDetails, true);
		expect(firstOut).toContain("AuthLoader");
		expect(firstOut).toMatch(/read: src\/auth\.ts/);
		expect(firstOut).toContain("6.0s");
		const firstCard = Bun.stripANSI(card.render(120).join("\n"));
		expect(firstCard).toContain("AuthLoader");
		expect(firstCard).toMatch(/read: src\/auth\.ts/);
		expect(firstCard).toContain("6.0s");
		const firstNarrow = Bun.stripANSI(card.render(40).join("\n"));
		expect(firstNarrow).toContain("AuthLoader");
		expect(firstNarrow).toMatch(/read: src\/auth\.ts/);
		expect(firstNarrow).toContain("6.0s");
		for (const line of firstNarrow.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
		}
		copySpawnJobLiveProgress(stale, {
			...stale,
			currentTool: "grep",
			currentToolArgs: "password",
			currentToolStartMs: now - 600,
			recentTools: [{ tool: "read", args: "src/auth.ts", endMs: now }],
		});
		await reportProgress("running", { progress: [{ ...stale }] });
		vi.advanceTimersByTime(500);
		const secondDetails = await secondUpdate.promise;
		const switched = secondDetails.jobs?.[0];
		expect(switched?.liveActivity?.tool).toBe("grep");
		expect(switched?.liveActivity?.detail).toBe("password");
		expect(switched?.liveActivity?.elapsedMs).toBeUndefined();
		const switchedOut = renderWaitJobs(secondDetails, true);
		expect(switchedOut).toMatch(/grep: password/);
		expect(switchedOut).not.toContain("src/auth.ts");
		expect(switchedOut).not.toContain("6.0s");
		const switchedCard = Bun.stripANSI(card.render(120).join("\n"));
		expect(switchedCard).toMatch(/grep: password/);
		expect(switchedCard).not.toContain("src/auth.ts");
		expect(switchedCard).not.toContain("6.0s");
		const switchedNarrow = Bun.stripANSI(card.render(40).join("\n"));
		expect(switchedNarrow).toMatch(/grep: password/);
		expect(switchedNarrow).not.toContain("src/auth.ts");
		expect(switchedNarrow).not.toContain("6.0s");
		for (const line of switchedNarrow.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
		}
		abort.abort();
		const result = await pending;
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "call_live",
			toolName: "hub",
			result,
			isError: false,
		});
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).not.toContain("src/auth.ts");
		expect(Bun.stripANSI(card.render(120).join("\n"))).not.toMatch(/read: src\/auth\.ts/);
		const abortedNarrow = Bun.stripANSI(card.render(40).join("\n"));
		expect(abortedNarrow).not.toMatch(/read: src\/auth\.ts/);
		for (const line of abortedNarrow.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
		}
		card.seal();
		hang.resolve("done");
		await manager.getJob("AuthLoader")?.promise;
	});

	test("wait onUpdate prefers lastIntent over copied current-tool args", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null });
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const now = Date.now();
		const stale: AgentProgress = {
			index: 0,
			id: "AuthLoader",
			agent: "task",
			agentSource: "bundled",
			status: "running",
			task: "old",
			currentTool: "grep",
			currentToolArgs: "stale-args",
			currentToolStartMs: 1,
			recentTools: [{ tool: "bash", args: "stale", endMs: 1 }],
			recentOutput: [],
			toolCount: 0,
			requests: 0,
			tokens: 0,
			cost: 0,
			durationMs: 0,
		};
		copySpawnJobLiveProgress(stale, {
			...stale,
			lastIntent: "Inspect login",
			currentTool: "read",
			currentToolArgs: "src/auth.ts",
			currentToolStartMs: now,
			recentTools: [{ tool: "grep", args: "password", endMs: now }],
		});
		const hang = Promise.withResolvers<string>();
		const ready = Promise.withResolvers<void>();
		manager.register(
			"task",
			"AuthLoader",
			async ({ reportProgress }) => {
				await reportProgress("running", { progress: [{ ...stale }] });
				ready.resolve();
				return hang.promise;
			},
			{ id: "AuthLoader", ownerId: SELF_ID },
		);
		await ready.promise;
		const { controller, pendingTools } = createWaitTranscript();
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "call_intent",
			toolName: "hub",
			args: { op: "wait", ids: ["AuthLoader"] },
		});
		const card = pendingTools.get("call_intent");
		if (!card) throw new Error("expected hub wait card");
		const abort = new AbortController();
		const firstUpdate = Promise.withResolvers<CoordinationDetails>();
		const pending = new HubTool(makeSession(manager)).execute(
			"call_intent",
			{ op: "wait", ids: ["AuthLoader"] },
			abort.signal,
			update => {
				void controller.handleEvent({
					type: "tool_execution_update",
					toolCallId: "call_intent",
					toolName: "hub",
					args: { op: "wait", ids: ["AuthLoader"] },
					partialResult: update,
				});
				if (update.details && "jobs" in update.details && update.details.jobs?.[0]?.liveActivity?.tool === "read") {
					firstUpdate.resolve(update.details);
				}
			},
		);
		const details = await firstUpdate.promise;
		expect(details.jobs?.[0]?.liveActivity).toEqual({ tool: "read", detail: "Inspect login" });
		const live = Bun.stripANSI(card.render(120).join("\n"));
		expect(live).toMatch(/read: Inspect login/);
		expect(live).not.toContain("src/auth.ts");
		expect(live).not.toContain("password");
		const narrow = Bun.stripANSI(card.render(40).join("\n"));
		expect(narrow).toMatch(/read: Inspect login/);
		expect(narrow).not.toContain("src/auth.ts");
		expect(narrow).not.toContain("password");
		for (const line of narrow.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
		}
		abort.abort();
		await pending;
		card.seal();
		hang.resolve("done");
		await manager.getJob("AuthLoader")?.promise;
	});

	test("wait onUpdate grows current-tool elapsed across 500ms refresh ticks", async () => {
		vi.useFakeTimers();
		const registry = AgentRegistry.global();
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null });
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const now = Date.now();
		const stale: AgentProgress = {
			index: 0,
			id: "AuthLoader",
			agent: "task",
			agentSource: "bundled",
			status: "running",
			task: "old",
			currentTool: "grep",
			currentToolArgs: "stale-args",
			currentToolStartMs: 1,
			recentTools: [{ tool: "bash", args: "stale", endMs: 1 }],
			recentOutput: [],
			toolCount: 0,
			requests: 0,
			tokens: 0,
			cost: 0,
			durationMs: 0,
		};
		copySpawnJobLiveProgress(stale, {
			...stale,
			currentTool: "read",
			currentToolArgs: "src/auth.ts",
			currentToolStartMs: now - 6_000,
			recentTools: [],
		});
		const hang = Promise.withResolvers<string>();
		const ready = Promise.withResolvers<void>();
		manager.register(
			"task",
			"AuthLoader",
			async ({ reportProgress }) => {
				await reportProgress("running", { progress: [{ ...stale }] });
				ready.resolve();
				return hang.promise;
			},
			{ id: "AuthLoader", ownerId: SELF_ID },
		);
		await ready.promise;
		const { controller, pendingTools } = createWaitTranscript();
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "call_elapsed",
			toolName: "hub",
			args: { op: "wait", ids: ["AuthLoader"] },
		});
		const card = pendingTools.get("call_elapsed");
		if (!card) throw new Error("expected hub wait card");
		const abort = new AbortController();
		const firstElapsed = Promise.withResolvers<number>();
		const grownElapsed = Promise.withResolvers<number>();
		let firstMs: number | undefined;
		const pending = new HubTool(makeSession(manager)).execute(
			"call_elapsed",
			{ op: "wait", ids: ["AuthLoader"] },
			abort.signal,
			update => {
				void controller.handleEvent({
					type: "tool_execution_update",
					toolCallId: "call_elapsed",
					toolName: "hub",
					args: { op: "wait", ids: ["AuthLoader"] },
					partialResult: update,
				});
				const elapsed =
					update.details && "jobs" in update.details
						? update.details.jobs?.[0]?.liveActivity?.elapsedMs
						: undefined;
				if (typeof elapsed !== "number") return;
				if (firstMs === undefined) {
					firstMs = elapsed;
					firstElapsed.resolve(elapsed);
					return;
				}
				if (elapsed > firstMs) grownElapsed.resolve(elapsed);
			},
		);
		expect(await firstElapsed.promise).toBeGreaterThan(5000);
		expect(Bun.stripANSI(card.render(120).join("\n"))).toContain("6.0s");
		expect(Bun.stripANSI(card.render(40).join("\n"))).toContain("6.0s");
		vi.advanceTimersByTime(1000);
		expect(await grownElapsed.promise).toBeGreaterThan(firstMs ?? 0);
		expect(Bun.stripANSI(card.render(120).join("\n"))).toContain("7.0s");
		const narrow = Bun.stripANSI(card.render(40).join("\n"));
		expect(narrow).toContain("7.0s");
		for (const line of narrow.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
		}
		abort.abort();
		await pending;
		card.seal();
		hang.resolve("done");
		await manager.getJob("AuthLoader")?.promise;
	});

	test("wait onUpdate compact gist excludes recentOutput and thinking text", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null });
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const now = Date.now();
		const stale: AgentProgress = {
			index: 0,
			id: "AuthLoader",
			agent: "task",
			agentSource: "bundled",
			status: "running",
			task: "old",
			currentTool: "grep",
			currentToolArgs: "stale-args",
			currentToolStartMs: 1,
			recentTools: [{ tool: "bash", args: "stale", endMs: 1 }],
			recentOutput: ["thinking about the auth flow", "secret stdout line"],
			toolCount: 0,
			requests: 0,
			tokens: 0,
			cost: 0,
			durationMs: 0,
		};
		copySpawnJobLiveProgress(stale, {
			...stale,
			currentTool: "read",
			currentToolArgs: "src/auth.ts",
			currentToolStartMs: now,
			recentTools: [],
			recentOutput: ["thinking about the auth flow", "secret stdout line"],
		});
		const hang = Promise.withResolvers<string>();
		const ready = Promise.withResolvers<void>();
		manager.register(
			"task",
			"AuthLoader",
			async ({ reportProgress }) => {
				await reportProgress("running", { progress: [{ ...stale }] });
				ready.resolve();
				return hang.promise;
			},
			{ id: "AuthLoader", ownerId: SELF_ID },
		);
		await ready.promise;
		const { controller, pendingTools } = createWaitTranscript();
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "call_compact",
			toolName: "hub",
			args: { op: "wait", ids: ["AuthLoader"] },
		});
		const card = pendingTools.get("call_compact");
		if (!card) throw new Error("expected hub wait card");
		const abort = new AbortController();
		const firstUpdate = Promise.withResolvers<void>();
		const pending = new HubTool(makeSession(manager)).execute(
			"call_compact",
			{ op: "wait", ids: ["AuthLoader"] },
			abort.signal,
			update => {
				void controller.handleEvent({
					type: "tool_execution_update",
					toolCallId: "call_compact",
					toolName: "hub",
					args: { op: "wait", ids: ["AuthLoader"] },
					partialResult: update,
				});
				if (update.details && "jobs" in update.details && update.details.jobs?.[0]?.liveActivity?.tool === "read") {
					firstUpdate.resolve();
				}
			},
		);
		await firstUpdate.promise;
		const live = Bun.stripANSI(card.render(120).join("\n"));
		expect(live).toMatch(/read: src\/auth\.ts/);
		expect(live).not.toContain("thinking about the auth flow");
		expect(live).not.toContain("secret stdout line");
		expect(live.split("\n").filter(line => /read: src\/auth\.ts/.test(line))).toHaveLength(1);
		const narrow = Bun.stripANSI(card.render(40).join("\n"));
		expect(narrow).toMatch(/read: src\/auth\.ts/);
		expect(narrow).not.toContain("thinking about the auth flow");
		expect(narrow).not.toContain("secret stdout line");
		for (const line of narrow.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
		}
		abort.abort();
		await pending;
		card.seal();
		hang.resolve("done");
		await manager.getJob("AuthLoader")?.promise;
	});

	test("wait onUpdate keeps running rows without inventing thinking or activity text", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null });
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const stale: AgentProgress = {
			index: 0,
			id: "AuthLoader",
			agent: "task",
			agentSource: "bundled",
			status: "running",
			task: "old",
			currentTool: "grep",
			currentToolArgs: "stale-args",
			currentToolStartMs: 1,
			recentTools: [{ tool: "bash", args: "stale", endMs: 1 }],
			recentOutput: ["thinking about the auth flow"],
			toolCount: 0,
			requests: 0,
			tokens: 0,
			cost: 0,
			durationMs: 0,
		};
		copySpawnJobLiveProgress(stale, {
			...stale,
			currentTool: undefined,
			currentToolArgs: undefined,
			currentToolStartMs: undefined,
			lastIntent: undefined,
			recentTools: [],
			recentOutput: ["thinking about the auth flow"],
		});
		const hang = Promise.withResolvers<string>();
		const ready = Promise.withResolvers<void>();
		manager.register(
			"task",
			"AuthLoader",
			async ({ reportProgress }) => {
				await reportProgress("running", { progress: [{ ...stale }] });
				ready.resolve();
				return hang.promise;
			},
			{ id: "AuthLoader", ownerId: SELF_ID },
		);
		await ready.promise;
		const { controller, pendingTools } = createWaitTranscript();
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "call_idle",
			toolName: "hub",
			args: { op: "wait", ids: ["AuthLoader"] },
		});
		const card = pendingTools.get("call_idle");
		if (!card) throw new Error("expected hub wait card");
		const abort = new AbortController();
		const firstUpdate = Promise.withResolvers<CoordinationDetails>();
		const pending = new HubTool(makeSession(manager)).execute(
			"call_idle",
			{ op: "wait", ids: ["AuthLoader"] },
			abort.signal,
			update => {
				void controller.handleEvent({
					type: "tool_execution_update",
					toolCallId: "call_idle",
					toolName: "hub",
					args: { op: "wait", ids: ["AuthLoader"] },
					partialResult: update,
				});
				if (update.details && "jobs" in update.details && update.details.jobs?.[0]?.id === "AuthLoader") {
					firstUpdate.resolve(update.details);
				}
			},
		);
		const details = await firstUpdate.promise;
		expect(details.jobs?.[0]?.liveActivity).toBeUndefined();
		const live = Bun.stripANSI(card.render(120).join("\n"));
		expect(live).toContain("AuthLoader");
		expect(live).not.toMatch(/\bread\b/);
		expect(live).not.toMatch(/\bgrep\b/);
		expect(live).not.toContain("thinking");
		expect(live).not.toContain("no activity");
		expect(live).not.toContain("thinking about the auth flow");
		const narrow = Bun.stripANSI(card.render(40).join("\n"));
		expect(narrow).toContain("AuthLoader");
		expect(narrow).not.toMatch(/\bread\b/);
		expect(narrow).not.toMatch(/\bgrep\b/);
		expect(narrow).not.toContain("thinking");
		expect(narrow).not.toContain("no activity");
		expect(narrow).not.toContain("thinking about the auth flow");
		for (const line of narrow.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
		}
		abort.abort();
		await pending;
		card.seal();
		hang.resolve("done");
		await manager.getJob("AuthLoader")?.promise;
	});

	test("wait onUpdate renders one compact gist per running job", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null });
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const now = Date.now();
		const makeProgress = (id: string, tool: string, args: string): AgentProgress => {
			const stale: AgentProgress = {
				index: 0,
				id,
				agent: "task",
				agentSource: "bundled",
				status: "running",
				task: "old",
				currentTool: "grep",
				currentToolArgs: "stale-args",
				currentToolStartMs: 1,
				recentTools: [{ tool: "bash", args: "stale", endMs: 1 }],
				recentOutput: [],
				toolCount: 0,
				requests: 0,
				tokens: 0,
				cost: 0,
				durationMs: 0,
			};
			copySpawnJobLiveProgress(stale, {
				...stale,
				currentTool: tool,
				currentToolArgs: args,
				currentToolStartMs: now,
				recentTools: [],
			});
			return stale;
		};
		const auth = makeProgress("AuthLoader", "read", "src/auth.ts");
		const schema = makeProgress("SchemaMigrator", "grep", "password");
		const hangAuth = Promise.withResolvers<string>();
		const hangSchema = Promise.withResolvers<string>();
		const readyAuth = Promise.withResolvers<void>();
		const readySchema = Promise.withResolvers<void>();
		manager.register(
			"task",
			"AuthLoader",
			async ({ reportProgress }) => {
				await reportProgress("running", { progress: [{ ...auth }] });
				readyAuth.resolve();
				return hangAuth.promise;
			},
			{ id: "AuthLoader", ownerId: SELF_ID },
		);
		manager.register(
			"task",
			"SchemaMigrator",
			async ({ reportProgress }) => {
				await reportProgress("running", { progress: [{ ...schema }] });
				readySchema.resolve();
				return hangSchema.promise;
			},
			{ id: "SchemaMigrator", ownerId: SELF_ID },
		);
		await readyAuth.promise;
		await readySchema.promise;
		const { controller, pendingTools } = createWaitTranscript();
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "call_multi",
			toolName: "hub",
			args: { op: "wait", ids: ["AuthLoader", "SchemaMigrator"] },
		});
		const card = pendingTools.get("call_multi");
		if (!card) throw new Error("expected hub wait card");
		const abort = new AbortController();
		const firstUpdate = Promise.withResolvers<void>();
		const pending = new HubTool(makeSession(manager)).execute(
			"call_multi",
			{ op: "wait", ids: ["AuthLoader", "SchemaMigrator"] },
			abort.signal,
			update => {
				void controller.handleEvent({
					type: "tool_execution_update",
					toolCallId: "call_multi",
					toolName: "hub",
					args: { op: "wait", ids: ["AuthLoader", "SchemaMigrator"] },
					partialResult: update,
				});
				const jobs = update.details && "jobs" in update.details ? update.details.jobs : undefined;
				if (
					jobs?.some(job => job.id === "AuthLoader" && job.liveActivity?.tool === "read") &&
					jobs?.some(job => job.id === "SchemaMigrator" && job.liveActivity?.tool === "grep")
				) {
					firstUpdate.resolve();
				}
			},
		);
		await firstUpdate.promise;
		const lines = card.render(120).map(line => Bun.stripANSI(line));
		const authGist = lines.filter(line => /read: src\/auth\.ts/.test(line));
		const schemaGist = lines.filter(line => /grep: password/.test(line));
		expect(authGist).toHaveLength(1);
		expect(schemaGist).toHaveLength(1);
		expect(lines.filter(line => /AuthLoader/.test(line))).toHaveLength(1);
		expect(lines.filter(line => /SchemaMigrator/.test(line))).toHaveLength(1);
		expect(lines.join("\n")).not.toMatch(/read: src\/auth\.ts[\s\S]*read: src\/auth\.ts/);
		const narrow = Bun.stripANSI(card.render(40).join("\n"));
		expect(narrow.split("\n").filter(line => /read: src\/auth\.ts/.test(line))).toHaveLength(1);
		expect(narrow.split("\n").filter(line => /grep: password/.test(line))).toHaveLength(1);
		expect(narrow).toContain("AuthLoader");
		expect(narrow).toContain("SchemaMigrator");
		for (const line of narrow.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
		}
		abort.abort();
		await pending;
		card.seal();
		hangAuth.resolve("done");
		hangSchema.resolve("done");
		await manager.getJob("AuthLoader")?.promise;
		await manager.getJob("SchemaMigrator")?.promise;
	});

	test("wait onUpdate keeps one compact gist per job across 15 concurrent jobs", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null });
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const now = Date.now();
		const hangs: Array<ReturnType<typeof Promise.withResolvers<string>>> = [];
		const ids = Array.from({ length: 15 }, (_, index) => `Worker${index}`);
		for (const [index, id] of ids.entries()) {
			const stale: AgentProgress = {
				index,
				id,
				agent: "task",
				agentSource: "bundled",
				status: "running",
				task: "old",
				currentTool: "grep",
				currentToolArgs: "stale-args",
				currentToolStartMs: 1,
				recentTools: [{ tool: "bash", args: "stale", endMs: 1 }],
				recentOutput: ["thinking about the auth flow"],
				toolCount: 0,
				requests: 0,
				tokens: 0,
				cost: 0,
				durationMs: 0,
			};
			copySpawnJobLiveProgress(stale, {
				...stale,
				currentTool: "read",
				currentToolArgs: `src/file-${index}.ts`,
				currentToolStartMs: now,
				recentTools: [],
				recentOutput: ["thinking about the auth flow"],
			});
			const hang = Promise.withResolvers<string>();
			const ready = Promise.withResolvers<void>();
			hangs.push(hang);
			manager.register(
				"task",
				id,
				async ({ reportProgress }) => {
					await reportProgress("running", { progress: [{ ...stale }] });
					ready.resolve();
					return hang.promise;
				},
				{ id, ownerId: SELF_ID },
			);
			await ready.promise;
		}
		const { controller, pendingTools } = createWaitTranscript();
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "call_crowd",
			toolName: "hub",
			args: { op: "wait", ids },
		});
		const card = pendingTools.get("call_crowd");
		if (!card) throw new Error("expected hub wait card");
		const abort = new AbortController();
		const firstUpdate = Promise.withResolvers<CoordinationDetails>();
		const pending = new HubTool(makeSession(manager)).execute(
			"call_crowd",
			{ op: "wait", ids },
			abort.signal,
			update => {
				void controller.handleEvent({
					type: "tool_execution_update",
					toolCallId: "call_crowd",
					toolName: "hub",
					args: { op: "wait", ids },
					partialResult: update,
				});
				const jobs = update.details && "jobs" in update.details ? update.details.jobs : undefined;
				if (jobs?.length === 15 && jobs.every(job => job.liveActivity?.tool === "read")) {
					firstUpdate.resolve(update.details as CoordinationDetails);
				}
			},
		);
		const details = await firstUpdate.promise;
		expect(details.jobs).toHaveLength(15);
		for (const [index, job] of (details.jobs ?? []).entries()) {
			expect(job.id).toBe(`Worker${index}`);
			expect(job.liveActivity).toEqual({ tool: "read", detail: `src/file-${index}.ts` });
		}
		const live = Bun.stripANSI(card.render(120).join("\n"));
		expect(live).toContain("waiting on 15 jobs");
		const gistLines = live.split("\n").filter(line => /read: src\/file-\d+\.ts/.test(line));
		expect(gistLines).toHaveLength(8);
		for (let index = 0; index < 8; index++) {
			expect(live).toContain(`Worker${index}`);
			expect(live).toContain(`src/file-${index}.ts`);
			expect(live.split("\n").filter(line => line.includes(`src/file-${index}.ts`))).toHaveLength(1);
		}
		for (let index = 8; index < 15; index++) {
			expect(live).not.toContain(`Worker${index}`);
			expect(live).not.toContain(`src/file-${index}.ts`);
		}
		expect(live).toContain("7 more jobs");
		expect(live).not.toContain("thinking about the auth flow");
		expect(live).not.toContain("thinking");
		const narrow = Bun.stripANSI(card.render(40).join("\n"));
		expect(narrow.split("\n").filter(line => /read: src\/file-\d+/.test(line))).toHaveLength(8);
		expect(narrow).toContain("7 more jobs");
		expect(narrow).toContain("Worker0");
		expect(narrow).not.toContain("Worker8");
		for (const line of narrow.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
		}
		abort.abort();
		await pending;
		card.seal();
		for (const hang of hangs) hang.resolve("done");
		await Promise.all(ids.map(id => manager.getJob(id)?.promise));
	});

	test("wait onUpdate does not draw a live gist on running bash jobs", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null });
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const hang = registerHangingJob(manager, "bun test");
		const { controller, pendingTools } = createWaitTranscript();
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "call_bash",
			toolName: "hub",
			args: { op: "wait", ids: [hang.id] },
		});
		const card = pendingTools.get("call_bash");
		if (!card) throw new Error("expected hub wait card");
		const abort = new AbortController();
		const firstUpdate = Promise.withResolvers<void>();
		const pending = new HubTool(makeSession(manager)).execute(
			"call_bash",
			{ op: "wait", ids: [hang.id] },
			abort.signal,
			update => {
				void controller.handleEvent({
					type: "tool_execution_update",
					toolCallId: "call_bash",
					toolName: "hub",
					args: { op: "wait", ids: [hang.id] },
					partialResult: update,
				});
				const jobs = update.details && "jobs" in update.details ? update.details.jobs : undefined;
				if (jobs?.[0]?.id === hang.id && jobs[0].status === "running") firstUpdate.resolve();
			},
		);
		await firstUpdate.promise;
		const live = Bun.stripANSI(card.render(120).join("\n"));
		expect(live).toContain("bun test");
		expect(live).not.toMatch(/\bread\b/);
		expect(live).not.toMatch(/\bgrep\b/);
		expect(live).not.toMatch(/liveActivity/);
		const narrow = Bun.stripANSI(card.render(40).join("\n"));
		expect(narrow).toContain("bun test");
		expect(narrow).not.toMatch(/\bread\b/);
		expect(narrow).not.toMatch(/\bgrep\b/);
		expect(narrow).not.toMatch(/liveActivity/);
		for (const line of narrow.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
		}
		abort.abort();
		await pending;
		card.seal();
		hang.finish("done");
		await manager.getJob(hang.id)?.promise;
	});

	test("wait onUpdate draws a live gist only on the task job in a mixed wait", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null });
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const now = Date.now();
		const stale: AgentProgress = {
			index: 0,
			id: "AuthLoader",
			agent: "task",
			agentSource: "bundled",
			status: "running",
			task: "old",
			currentTool: "grep",
			currentToolArgs: "stale-args",
			currentToolStartMs: 1,
			recentTools: [{ tool: "bash", args: "stale", endMs: 1 }],
			recentOutput: [],
			toolCount: 0,
			requests: 0,
			tokens: 0,
			cost: 0,
			durationMs: 0,
		};
		copySpawnJobLiveProgress(stale, {
			...stale,
			currentTool: "read",
			currentToolArgs: "src/auth.ts",
			currentToolStartMs: now,
			recentTools: [],
		});
		const hangAuth = Promise.withResolvers<string>();
		const readyAuth = Promise.withResolvers<void>();
		manager.register(
			"task",
			"AuthLoader",
			async ({ reportProgress }) => {
				await reportProgress("running", { progress: [{ ...stale }] });
				readyAuth.resolve();
				return hangAuth.promise;
			},
			{ id: "AuthLoader", ownerId: SELF_ID },
		);
		const hangBash = registerHangingJob(manager, "bun test");
		await readyAuth.promise;
		const { controller, pendingTools } = createWaitTranscript();
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "call_mixed",
			toolName: "hub",
			args: { op: "wait", ids: ["AuthLoader", hangBash.id] },
		});
		const card = pendingTools.get("call_mixed");
		if (!card) throw new Error("expected hub wait card");
		const abort = new AbortController();
		const firstUpdate = Promise.withResolvers<void>();
		const pending = new HubTool(makeSession(manager)).execute(
			"call_mixed",
			{ op: "wait", ids: ["AuthLoader", hangBash.id] },
			abort.signal,
			update => {
				void controller.handleEvent({
					type: "tool_execution_update",
					toolCallId: "call_mixed",
					toolName: "hub",
					args: { op: "wait", ids: ["AuthLoader", hangBash.id] },
					partialResult: update,
				});
				const jobs = update.details && "jobs" in update.details ? update.details.jobs : undefined;
				if (
					jobs?.some(job => job.id === "AuthLoader" && job.liveActivity?.tool === "read") &&
					jobs?.some(job => job.id === hangBash.id && job.status === "running" && !job.liveActivity)
				) {
					firstUpdate.resolve();
				}
			},
		);
		await firstUpdate.promise;
		const live = Bun.stripANSI(card.render(120).join("\n"));
		expect(live).toMatch(/read: src\/auth\.ts/);
		expect(live).toContain("bun test");
		expect(live.split("\n").filter(line => /read: src\/auth\.ts/.test(line))).toHaveLength(1);
		expect(live.split("\n").filter(line => line.includes("bun test")).length).toBeGreaterThan(0);
		const mixedNarrow = Bun.stripANSI(card.render(40).join("\n"));
		expect(mixedNarrow.split("\n").filter(line => /read: src\/auth\.ts/.test(line))).toHaveLength(1);
		expect(mixedNarrow).toContain("bun test");
		for (const line of mixedNarrow.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
		}
		abort.abort();
		await pending;
		card.seal();
		hangAuth.resolve("done");
		hangBash.finish("done");
		await manager.getJob("AuthLoader")?.promise;
		await manager.getJob(hangBash.id)?.promise;
	});

	test("wait onUpdate truncates copied live activity to the parent transcript viewport", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null });
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const longTool = `mcp__${"very-long-custom-tool-name-".repeat(8)}search`;
		const stale: AgentProgress = {
			index: 0,
			id: "AuthLoader",
			agent: "task",
			agentSource: "bundled",
			status: "running",
			task: "old",
			currentTool: "grep",
			currentToolArgs: "stale-args",
			currentToolStartMs: 1,
			recentTools: [{ tool: "bash", args: "stale", endMs: 1 }],
			recentOutput: [],
			toolCount: 0,
			requests: 0,
			tokens: 0,
			cost: 0,
			durationMs: 0,
		};
		copySpawnJobLiveProgress(stale, {
			...stale,
			currentTool: longTool,
			currentToolArgs: "src/auth.ts",
			currentToolStartMs: Date.now(),
			recentTools: [],
		});
		const hang = Promise.withResolvers<string>();
		const ready = Promise.withResolvers<void>();
		manager.register(
			"task",
			"AuthLoader",
			async ({ reportProgress }) => {
				await reportProgress("running", { progress: [{ ...stale }] });
				ready.resolve();
				return hang.promise;
			},
			{ id: "AuthLoader", ownerId: SELF_ID },
		);
		await ready.promise;
		const { controller, pendingTools } = createWaitTranscript();
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "call_narrow",
			toolName: "hub",
			args: { op: "wait", ids: ["AuthLoader"] },
		});
		const card = pendingTools.get("call_narrow");
		if (!card) throw new Error("expected hub wait card");
		const abort = new AbortController();
		const firstUpdate = Promise.withResolvers<void>();
		const pending = new HubTool(makeSession(manager)).execute(
			"call_narrow",
			{ op: "wait", ids: ["AuthLoader"] },
			abort.signal,
			update => {
				void controller.handleEvent({
					type: "tool_execution_update",
					toolCallId: "call_narrow",
					toolName: "hub",
					args: { op: "wait", ids: ["AuthLoader"] },
					partialResult: update,
				});
				if (
					update.details &&
					"jobs" in update.details &&
					update.details.jobs?.[0]?.liveActivity?.tool === longTool
				) {
					firstUpdate.resolve();
				}
			},
		);
		await firstUpdate.promise;
		const lines = card.render(48).map(line => Bun.stripANSI(line));
		const activity = lines.find(line => /mcp|search|auth/.test(line) && !line.includes("AuthLoader"));
		expect(activity).toBeDefined();
		expect(activity).not.toContain(longTool);
		expect(Bun.stringWidth(activity!)).toBeLessThanOrEqual(48);
		for (const line of lines) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(48);
		}
		const mcpNarrow = card.render(40).map(line => Bun.stripANSI(line));
		const mcpActivity = mcpNarrow.find(line => /mcp|search|auth/.test(line) && !line.includes("AuthLoader"));
		expect(mcpActivity).toBeDefined();
		expect(mcpActivity).not.toContain(longTool);
		expect(Bun.stringWidth(mcpActivity!)).toBeLessThanOrEqual(40);
		for (const line of mcpNarrow) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
		}
		abort.abort();
		await pending;
		card.seal();
		hang.resolve("done");
		await manager.getJob("AuthLoader")?.promise;
	});

	test("wait onUpdate shortens copied home paths on the parent transcript card", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null });
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const homeFile = `${os.homedir()}/secret/token.ts`;
		const stale: AgentProgress = {
			index: 0,
			id: "AuthLoader",
			agent: "task",
			agentSource: "bundled",
			status: "running",
			task: "old",
			currentTool: "grep",
			currentToolArgs: "stale-args",
			currentToolStartMs: 1,
			recentTools: [{ tool: "bash", args: "stale", endMs: 1 }],
			recentOutput: [],
			toolCount: 0,
			requests: 0,
			tokens: 0,
			cost: 0,
			durationMs: 0,
		};
		copySpawnJobLiveProgress(stale, {
			...stale,
			currentTool: "bash",
			currentToolArgs: `\tcat ${homeFile}`,
			currentToolStartMs: Date.now(),
			recentTools: [],
		});
		const hang = Promise.withResolvers<string>();
		const ready = Promise.withResolvers<void>();
		manager.register(
			"task",
			"AuthLoader",
			async ({ reportProgress }) => {
				await reportProgress("running", { progress: [{ ...stale }] });
				ready.resolve();
				return hang.promise;
			},
			{ id: "AuthLoader", ownerId: SELF_ID },
		);
		await ready.promise;
		const { controller, pendingTools } = createWaitTranscript();
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "call_home",
			toolName: "hub",
			args: { op: "wait", ids: ["AuthLoader"] },
		});
		const card = pendingTools.get("call_home");
		if (!card) throw new Error("expected hub wait card");
		const abort = new AbortController();
		const firstUpdate = Promise.withResolvers<void>();
		const pending = new HubTool(makeSession(manager)).execute(
			"call_home",
			{ op: "wait", ids: ["AuthLoader"] },
			abort.signal,
			update => {
				void controller.handleEvent({
					type: "tool_execution_update",
					toolCallId: "call_home",
					toolName: "hub",
					args: { op: "wait", ids: ["AuthLoader"] },
					partialResult: update,
				});
				if (update.details && "jobs" in update.details && update.details.jobs?.[0]?.liveActivity?.tool === "bash") {
					firstUpdate.resolve();
				}
			},
		);
		await firstUpdate.promise;
		const live = Bun.stripANSI(card.render(120).join("\n"));
		expect(live).toContain("bash:");
		expect(live).toContain("~/secret/token.ts");
		expect(live).not.toContain("\t");
		expect(live).not.toContain(homeFile);
		const narrow = Bun.stripANSI(card.render(40).join("\n"));
		expect(narrow).toContain("bash:");
		expect(narrow).toContain("~/secret");
		expect(narrow).not.toContain("\t");
		expect(narrow).not.toContain(homeFile);
		for (const line of narrow.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
		}
		abort.abort();
		await pending;
		card.seal();
		hang.resolve("done");
		await manager.getJob("AuthLoader")?.promise;
	});

	test("wait final snapshot drops copied live activity after success and failure", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null });
		const now = Date.now();
		const stale: AgentProgress = {
			index: 0,
			id: "AuthLoader",
			agent: "task",
			agentSource: "bundled",
			status: "running",
			task: "old",
			currentTool: "grep",
			currentToolArgs: "stale-args",
			currentToolStartMs: 1,
			recentTools: [{ tool: "bash", args: "stale", endMs: 1 }],
			recentOutput: [],
			toolCount: 0,
			requests: 0,
			tokens: 0,
			cost: 0,
			durationMs: 0,
		};
		copySpawnJobLiveProgress(stale, {
			...stale,
			currentTool: "read",
			currentToolArgs: "src/auth.ts",
			currentToolStartMs: now - 6_000,
			recentTools: [],
		});

		const succeed = Promise.withResolvers<string>();
		const succeedReady = Promise.withResolvers<void>();
		const successManager = new AsyncJobManager({ onJobComplete: () => {} });
		successManager.register(
			"task",
			"AuthLoader",
			async ({ reportProgress }) => {
				await reportProgress("running", { progress: [{ ...stale }] });
				succeedReady.resolve();
				return succeed.promise;
			},
			{ id: "AuthLoader", ownerId: SELF_ID },
		);
		await succeedReady.promise;
		const successLive = Promise.withResolvers<CoordinationDetails>();
		const successTranscript = createWaitTranscript();
		await successTranscript.controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "call_settle_ok",
			toolName: "hub",
			args: { op: "wait", ids: ["AuthLoader"] },
		});
		const successCard = successTranscript.pendingTools.get("call_settle_ok");
		if (!successCard) throw new Error("expected success wait card");
		const successPending = new HubTool(makeSession(successManager)).execute(
			"call_settle_ok",
			{ op: "wait", ids: ["AuthLoader"] },
			undefined,
			update => {
				void successTranscript.controller.handleEvent({
					type: "tool_execution_update",
					toolCallId: "call_settle_ok",
					toolName: "hub",
					args: { op: "wait", ids: ["AuthLoader"] },
					partialResult: update,
				});
				if (!update.details || !("jobs" in update.details)) return;
				if (update.details.jobs?.[0]?.liveActivity?.tool === "read") successLive.resolve(update.details);
			},
		);
		expect((await successLive.promise).jobs?.[0]?.liveActivity?.detail).toBe("src/auth.ts");
		expect(Bun.stripANSI(successCard.render(120).join("\n"))).toMatch(/read: src\/auth\.ts/);
		succeed.resolve("settled body");
		const success = await successPending;
		await successTranscript.controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "call_settle_ok",
			toolName: "hub",
			result: success,
			isError: false,
		});
		const successDetails = success.details as CoordinationDetails;
		expect(successDetails.jobs?.[0]?.status).toBe("completed");
		expect(successDetails.jobs?.[0]?.liveActivity).toBeUndefined();
		expect(successDetails.jobs?.[0]?.resultText).toBe("settled body");
		const successText = success.content[0]?.type === "text" ? success.content[0].text : "";
		expect(successText).toContain("settled body");
		expect(successText).not.toContain("src/auth.ts");
		const successOut = Bun.stripANSI(
			(
				hubToolRenderer
					.renderResult(
						success,
						{ expanded: true, isPartial: false } as Parameters<typeof hubToolRenderer.renderResult>[1],
						theme,
						{ op: "wait", ids: ["AuthLoader"] },
					)
					.render(120) as readonly string[]
			).join("\n"),
		);
		expect(successOut).toContain("settled body");
		expect(successOut).not.toMatch(/read: src\/auth\.ts/);
		const successCardOut = Bun.stripANSI(successCard.render(120).join("\n"));
		expect(successCardOut).toContain("settled body");
		expect(successCardOut).not.toMatch(/read: src\/auth\.ts/);
		const successNarrow = Bun.stripANSI(successCard.render(40).join("\n"));
		expect(successNarrow).toContain("settled body");
		expect(successNarrow).not.toMatch(/read: src\/auth\.ts/);
		for (const line of successNarrow.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
		}
		successCard.seal();

		const fail = Promise.withResolvers<string>();
		const failReady = Promise.withResolvers<void>();
		const failManager = new AsyncJobManager({ onJobComplete: () => {} });
		failManager.register(
			"task",
			"AuthLoader",
			async ({ reportProgress }) => {
				await reportProgress("running", { progress: [{ ...stale }] });
				failReady.resolve();
				return fail.promise;
			},
			{ id: "AuthLoader", ownerId: SELF_ID },
		);
		await failReady.promise;
		const failLive = Promise.withResolvers<CoordinationDetails>();
		const failTranscript = createWaitTranscript();
		await failTranscript.controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "call_settle_err",
			toolName: "hub",
			args: { op: "wait", ids: ["AuthLoader"] },
		});
		const failCard = failTranscript.pendingTools.get("call_settle_err");
		if (!failCard) throw new Error("expected fail wait card");
		const failPending = new HubTool(makeSession(failManager)).execute(
			"call_settle_err",
			{ op: "wait", ids: ["AuthLoader"] },
			undefined,
			update => {
				void failTranscript.controller.handleEvent({
					type: "tool_execution_update",
					toolCallId: "call_settle_err",
					toolName: "hub",
					args: { op: "wait", ids: ["AuthLoader"] },
					partialResult: update,
				});
				if (!update.details || !("jobs" in update.details)) return;
				if (update.details.jobs?.[0]?.liveActivity?.tool === "read") failLive.resolve(update.details);
			},
		);
		expect((await failLive.promise).jobs?.[0]?.liveActivity?.detail).toBe("src/auth.ts");
		expect(Bun.stripANSI(failCard.render(120).join("\n"))).toMatch(/read: src\/auth\.ts/);
		fail.reject(new Error("spawn failed: no credentials"));
		const failed = await failPending;
		await failTranscript.controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "call_settle_err",
			toolName: "hub",
			result: failed,
			isError: true,
		});
		const failedDetails = failed.details as CoordinationDetails;
		expect(failedDetails.jobs?.[0]?.status).toBe("failed");
		expect(failedDetails.jobs?.[0]?.liveActivity).toBeUndefined();
		expect(failedDetails.jobs?.[0]?.errorText).toBe("spawn failed: no credentials");
		const failedText = failed.content[0]?.type === "text" ? failed.content[0].text : "";
		expect(failedText).toContain("spawn failed: no credentials");
		expect(failedText).not.toContain("src/auth.ts");
		const failedOut = Bun.stripANSI(
			(
				hubToolRenderer
					.renderResult(
						failed,
						{ expanded: true, isPartial: false } as Parameters<typeof hubToolRenderer.renderResult>[1],
						theme,
						{ op: "wait", ids: ["AuthLoader"] },
					)
					.render(120) as readonly string[]
			).join("\n"),
		);
		expect(failedOut).toContain("spawn failed: no credentials");
		expect(failedOut).not.toMatch(/read: src\/auth\.ts/);
		const failCardOut = Bun.stripANSI(failCard.render(120).join("\n"));
		expect(failCardOut).toContain("spawn failed: no credentials");
		expect(failCardOut).not.toMatch(/read: src\/auth\.ts/);
		const failNarrow = Bun.stripANSI(failCard.render(40).join("\n"));
		expect(failNarrow).toContain("spawn failed");
		expect(failNarrow).not.toMatch(/read: src\/auth\.ts/);
		for (const line of failNarrow.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
		}
		failCard.seal();
	});

	test("jobs snapshot includes copied current-tool activity without model-facing gist", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null });
		const now = Date.now();
		const stale: AgentProgress = {
			index: 0,
			id: "AuthLoader",
			agent: "task",
			agentSource: "bundled",
			status: "running",
			task: "old",
			currentTool: "grep",
			currentToolArgs: "stale-args",
			currentToolStartMs: 1,
			recentTools: [{ tool: "bash", args: "stale", endMs: 1 }],
			recentOutput: [],
			toolCount: 0,
			requests: 0,
			tokens: 0,
			cost: 0,
			durationMs: 0,
		};
		copySpawnJobLiveProgress(stale, {
			...stale,
			currentTool: "read",
			currentToolArgs: "src/auth.ts",
			currentToolStartMs: now - 6_000,
			recentTools: [],
		});
		const hang = Promise.withResolvers<string>();
		const ready = Promise.withResolvers<void>();
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		manager.register(
			"task",
			"AuthLoader",
			async ({ reportProgress }) => {
				await reportProgress("running", { progress: [{ ...stale }] });
				ready.resolve();
				return hang.promise;
			},
			{ id: "AuthLoader", ownerId: SELF_ID },
		);
		await ready.promise;
		const { controller, pendingTools } = createWaitTranscript();
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "call_jobs",
			toolName: "hub",
			args: { op: "jobs" },
		});
		const card = pendingTools.get("call_jobs");
		if (!card) throw new Error("expected hub jobs card");
		const result = await new HubTool(makeSession(manager)).execute("call_jobs", { op: "jobs" });
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "call_jobs",
			toolName: "hub",
			result,
			isError: false,
		});
		const details = result.details as CoordinationDetails;
		expect(details.op).toBe("jobs");
		expect(details.jobs?.[0]?.id).toBe("AuthLoader");
		expect(details.jobs?.[0]?.status).toBe("running");
		expect(details.jobs?.[0]?.liveActivity?.tool).toBe("read");
		expect(details.jobs?.[0]?.liveActivity?.detail).toBe("src/auth.ts");
		expect(details.jobs?.[0]?.liveActivity?.elapsedMs).toBeGreaterThan(5000);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("AuthLoader");
		expect(text).not.toContain("src/auth.ts");
		expect(text).not.toMatch(/\bread\b/);
		const output = Bun.stripANSI(
			(
				hubToolRenderer
					.renderResult(
						result,
						{ expanded: false, isPartial: false } as Parameters<typeof hubToolRenderer.renderResult>[1],
						theme,
						{ op: "jobs" },
					)
					.render(120) as readonly string[]
			).join("\n"),
		);
		expect(output).toContain("AuthLoader");
		expect(output).toMatch(/read: src\/auth\.ts/);
		expect(output).toContain("6.0s");
		const cardOut = Bun.stripANSI(card.render(120).join("\n"));
		expect(cardOut).toContain("AuthLoader");
		expect(cardOut).toMatch(/read: src\/auth\.ts/);
		expect(cardOut).toContain("6.0s");
		const narrow = Bun.stripANSI(card.render(40).join("\n"));
		expect(narrow).toContain("AuthLoader");
		expect(narrow).toMatch(/read: src\/auth\.ts/);
		expect(narrow).toContain("6.0s");
		for (const line of narrow.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
		}
		card.seal();
		hang.resolve("done");
		await manager.getJob("AuthLoader")?.promise;
	});

	test("jobs snapshot prefers lastIntent over copied current-tool args", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null });
		const now = Date.now();
		const stale: AgentProgress = {
			index: 0,
			id: "AuthLoader",
			agent: "task",
			agentSource: "bundled",
			status: "running",
			task: "old",
			currentTool: "grep",
			currentToolArgs: "stale-args",
			currentToolStartMs: 1,
			recentTools: [{ tool: "bash", args: "stale", endMs: 1 }],
			recentOutput: [],
			toolCount: 0,
			requests: 0,
			tokens: 0,
			cost: 0,
			durationMs: 0,
		};
		copySpawnJobLiveProgress(stale, {
			...stale,
			lastIntent: "Inspect login",
			currentTool: "read",
			currentToolArgs: "src/auth.ts",
			currentToolStartMs: now,
			recentTools: [{ tool: "grep", args: "password", endMs: now }],
		});
		const hang = Promise.withResolvers<string>();
		const ready = Promise.withResolvers<void>();
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		manager.register(
			"task",
			"AuthLoader",
			async ({ reportProgress }) => {
				await reportProgress("running", { progress: [{ ...stale }] });
				ready.resolve();
				return hang.promise;
			},
			{ id: "AuthLoader", ownerId: SELF_ID },
		);
		await ready.promise;
		const { controller, pendingTools } = createWaitTranscript();
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "call_jobs_intent",
			toolName: "hub",
			args: { op: "jobs" },
		});
		const card = pendingTools.get("call_jobs_intent");
		if (!card) throw new Error("expected hub jobs card");
		const result = await new HubTool(makeSession(manager)).execute("call_jobs_intent", { op: "jobs" });
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "call_jobs_intent",
			toolName: "hub",
			result,
			isError: false,
		});
		const details = result.details as CoordinationDetails;
		expect(details.jobs?.[0]?.liveActivity).toEqual({ tool: "read", detail: "Inspect login" });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("AuthLoader");
		expect(text).not.toContain("Inspect login");
		expect(text).not.toContain("src/auth.ts");
		const live = Bun.stripANSI(card.render(120).join("\n"));
		expect(live).toMatch(/read: Inspect login/);
		expect(live).not.toContain("src/auth.ts");
		expect(live).not.toContain("password");
		const narrow = Bun.stripANSI(card.render(40).join("\n"));
		expect(narrow).toMatch(/read: Inspect login/);
		expect(narrow).not.toContain("src/auth.ts");
		expect(narrow).not.toContain("password");
		for (const line of narrow.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
		}
		card.seal();
		hang.resolve("done");
		await manager.getJob("AuthLoader")?.promise;
	});

	test("jobs snapshot keeps one compact gist per job across 15 concurrent jobs", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null });
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const now = Date.now();
		const hangs: Array<ReturnType<typeof Promise.withResolvers<string>>> = [];
		const ids = Array.from({ length: 15 }, (_, index) => `Worker${index}`);
		for (const [index, id] of ids.entries()) {
			const stale: AgentProgress = {
				index,
				id,
				agent: "task",
				agentSource: "bundled",
				status: "running",
				task: "old",
				currentTool: "grep",
				currentToolArgs: "stale-args",
				currentToolStartMs: 1,
				recentTools: [{ tool: "bash", args: "stale", endMs: 1 }],
				recentOutput: ["thinking about the auth flow"],
				toolCount: 0,
				requests: 0,
				tokens: 0,
				cost: 0,
				durationMs: 0,
			};
			copySpawnJobLiveProgress(stale, {
				...stale,
				currentTool: "read",
				currentToolArgs: `src/file-${index}.ts`,
				currentToolStartMs: now,
				recentTools: [],
				recentOutput: ["thinking about the auth flow"],
			});
			const hang = Promise.withResolvers<string>();
			const ready = Promise.withResolvers<void>();
			hangs.push(hang);
			manager.register(
				"task",
				id,
				async ({ reportProgress }) => {
					await reportProgress("running", { progress: [{ ...stale }] });
					ready.resolve();
					return hang.promise;
				},
				{ id, ownerId: SELF_ID },
			);
			await ready.promise;
		}
		const { controller, pendingTools } = createWaitTranscript();
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "call_jobs_crowd",
			toolName: "hub",
			args: { op: "jobs" },
		});
		const card = pendingTools.get("call_jobs_crowd");
		if (!card) throw new Error("expected hub jobs card");
		const result = await new HubTool(makeSession(manager)).execute("call_jobs_crowd", { op: "jobs" });
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "call_jobs_crowd",
			toolName: "hub",
			result,
			isError: false,
		});
		const details = result.details as CoordinationDetails;
		expect(details.op).toBe("jobs");
		expect(details.jobs).toHaveLength(15);
		for (const [index, job] of (details.jobs ?? []).entries()) {
			expect(job.id).toBe(`Worker${index}`);
			expect(job.status).toBe("running");
			expect(job.liveActivity).toEqual({ tool: "read", detail: `src/file-${index}.ts` });
		}
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("Worker0");
		expect(text).not.toContain("src/file-");
		expect(text).not.toMatch(/\bread\b/);
		const live = Bun.stripANSI(card.render(120).join("\n"));
		const gistLines = live.split("\n").filter(line => /read: src\/file-\d+\.ts/.test(line));
		expect(gistLines).toHaveLength(8);
		for (let index = 0; index < 8; index++) {
			expect(live).toContain(`Worker${index}`);
			expect(live).toContain(`src/file-${index}.ts`);
			expect(live.split("\n").filter(line => line.includes(`src/file-${index}.ts`))).toHaveLength(1);
		}
		for (let index = 8; index < 15; index++) {
			expect(live).not.toContain(`Worker${index}`);
			expect(live).not.toContain(`src/file-${index}.ts`);
		}
		expect(live).toContain("7 more jobs");
		expect(live).not.toContain("thinking about the auth flow");
		expect(live).not.toContain("thinking");
		const narrow = Bun.stripANSI(card.render(40).join("\n"));
		expect(narrow.split("\n").filter(line => /read: src\/file-\d+/.test(line))).toHaveLength(8);
		expect(narrow).toContain("7 more jobs");
		expect(narrow).toContain("Worker0");
		expect(narrow).not.toContain("Worker8");
		for (const line of narrow.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
		}
		card.seal();
		for (const hang of hangs) hang.resolve("done");
		await Promise.all(ids.map(id => manager.getJob(id)?.promise));
	});
});
