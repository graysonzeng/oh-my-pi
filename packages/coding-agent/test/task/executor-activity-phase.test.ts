/**
 * Event-driven tests for the executor's live activity fields
 * (`AgentProgress.activityPhase` / `AgentProgress.lastActivityAtMs`).
 *
 * All scenarios run the REAL monitor path: scripted `AgentSessionEvent`s are
 * delivered through a structural `AgentSession` double into `runSubprocess`,
 * whose `processEvent` derives the phase from actual event types (verified
 * against `AssistantMessageEvent` in packages/ai/types.ts — the thinking,
 * text, toolcall and image stream sub-events, tool start/end/update,
 * assistant message_start, auto_retry transitions). No field is hand-set in a
 * fixture and asserted back; every assertion observes a snapshot emitted for
 * a real event sequence.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage, TextContent } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { TASK_SUBAGENT_PROGRESS_CHANNEL } from "@oh-my-pi/pi-coding-agent/task";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition, AgentProgress } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

// AssistantMessage requires api/provider/usage/stopReason the executor never
// reads on this path; cast documents the deliberate structural test double
// (mirrors executor-recent-output.test.ts).
function assistantMessage(content: TextContent[]): AssistantMessage {
	return { role: "assistant", content } as AssistantMessage;
}

function messageStartEvent(role: string): AgentSessionEvent {
	return { type: "message_start", message: { role, content: [] } } as unknown as AgentSessionEvent;
}

/** message_update carrying a streaming sub-event (thinking/text/toolcall deltas). */
function streamDelta(subType: string, delta: string): AgentSessionEvent {
	return {
		type: "message_update",
		message: assistantMessage([]),
		assistantMessageEvent: { type: subType, contentIndex: 0, delta, partial: assistantMessage([]) },
	} as unknown as AgentSessionEvent;
}

function messageEndEvent(role: string): AgentSessionEvent {
	return { type: "message_end", message: { role, content: [] } } as unknown as AgentSessionEvent;
}

function toolStart(toolName: string, callId: string): AgentSessionEvent {
	return { type: "tool_execution_start", toolCallId: callId, toolName, args: {} } as AgentSessionEvent;
}

function toolEnd(toolName: string, callId: string): AgentSessionEvent {
	return {
		type: "tool_execution_end",
		toolCallId: callId,
		toolName,
		result: { content: [{ type: "text", text: "ok" }] },
		isError: false,
	} as AgentSessionEvent;
}

function yieldEvents(): AgentSessionEvent[] {
	return [
		{ type: "tool_execution_start", toolCallId: "final-yield", toolName: "yield", args: {} },
		{
			type: "tool_execution_end",
			toolCallId: "final-yield",
			toolName: "yield",
			result: {
				content: [{ type: "text", text: "Result submitted." }],
				details: { status: "success", data: { ok: true } },
			},
			isError: false,
		},
	] as AgentSessionEvent[];
}

interface MockSessionControls {
	session: AgentSession;
}

/** Structural AgentSession double — same subset as executor-recent-output.test.ts. */
function createScriptedSession(
	script: (emit: (event: AgentSessionEvent) => void) => Promise<void>,
): MockSessionControls {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const emit = (event: AgentSessionEvent) => {
		for (const listener of [...listeners]) listener(event);
	};
	let aborted = false;
	const session = {
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		setActiveToolsByName: async (_toolNames: string[]) => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async () => {
			await script(emit);
		},
		waitForIdle: async () => {},
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => true,
		getLastAssistantMessage: () => undefined,
		abort: async () => {
			aborted = true;
		},
		isAborted: () => aborted,
		dispose: async () => {},
		setIrcWakeTurnObserver: () => {},
		subscribeRunState: () => () => {},
	};
	return { session: session as unknown as AgentSession };
}

const agent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

/** Deep-ish copy so later executor mutations cannot leak into captured snapshots. */
function copySnapshot(progress: AgentProgress): AgentProgress {
	return {
		...progress,
		recentTools: progress.recentTools.map(tool => ({ ...tool })),
		recentOutput: [...progress.recentOutput],
	};
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	const startedAt = Date.now();
	while (!predicate()) {
		if (Date.now() - startedAt > 3_000) throw new Error(`timed out waiting for ${label}`);
		await Bun.sleep(10);
	}
}

describe("executor activity phase (real event path)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("tool end leaves the running phase; assistant stream drives model → thinking → responding", async () => {
		const snapshots: AgentProgress[] = [];
		const gate = {
			afterToolStart: Promise.withResolvers<void>(),
			afterToolEnd: Promise.withResolvers<void>(),
			afterModel: Promise.withResolvers<void>(),
			afterThinking: Promise.withResolvers<void>(),
			afterText: Promise.withResolvers<void>(),
			afterMessageEnd: Promise.withResolvers<void>(),
			afterYield: Promise.withResolvers<void>(),
		};
		const { session } = createScriptedSession(async emit => {
			emit(toolStart("read", "read-1"));
			await gate.afterToolStart.promise;
			emit(toolEnd("read", "read-1"));
			await gate.afterToolEnd.promise;
			emit(messageStartEvent("assistant"));
			await gate.afterModel.promise;
			emit(streamDelta("thinking_delta", "reasoning chunk"));
			await gate.afterThinking.promise;
			emit(streamDelta("text_delta", "visible answer"));
			await gate.afterText.promise;
			emit(messageEndEvent("assistant"));
			await gate.afterMessageEnd.promise;
			for (const event of yieldEvents()) emit(event);
			gate.afterYield.resolve();
		});
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session,
		} as CreateAgentSessionResult);

		const running = runSubprocess({
			cwd: "/tmp",
			agent,
			task: "activity phase",
			description: "activity phase",
			index: 0,
			id: `phase-${Math.random().toString(36).slice(2)}`,
			settings: Settings.isolated(),
			modelRegistry: { refresh: async () => {} } as ModelRegistry,
			enableLsp: false,
			eventBus: new EventBus(),
			onProgress: progress => snapshots.push(copySnapshot(progress)),
		});

		// Tool start → "tool" with the currentTool slot.
		await waitFor(() => snapshots.some(s => s.activityPhase === "tool"), "tool phase");
		const toolSnap = snapshots.findLast(s => s.activityPhase === "tool");
		expect(toolSnap?.currentTool).toBe("read");
		expect(toolSnap?.lastActivityAtMs).toBeGreaterThan(0);
		const toolPhaseTime = toolSnap!.lastActivityAtMs!;
		for (const earlier of snapshots) {
			if (earlier === toolSnap) break;
			if (earlier.lastActivityAtMs !== undefined) {
				expect(earlier.lastActivityAtMs).toBeLessThanOrEqual(toolPhaseTime);
			}
		}
		gate.afterToolStart.resolve();

		// Tool end → "working", currentTool cleared; recentTools keeps the read as
		// history (the old UI had no phase and stayed stuck on that history —
		// activityPhase is the live discriminator).
		await waitFor(
			() =>
				snapshots.some(
					s => s.activityPhase === "working" && s.currentTool === undefined && s.recentTools[0]?.tool === "read",
				),
			"working after tool end",
		);
		const postTool = snapshots.findLast(s => s.activityPhase === "working" && s.currentTool === undefined);
		expect(postTool?.recentTools[0]?.tool).toBe("read");
		expect(postTool?.currentTool).toBeUndefined();
		expect(postTool?.currentToolArgs).toBeUndefined();
		// The earlier snapshot is an independent by-value copy: later phases must
		// not retroactively rewrite what was already emitted.
		expect(toolSnap?.activityPhase).toBe("tool");
		gate.afterToolEnd.resolve();

		// Assistant message_start → "model" (waiting for model output).
		await waitFor(() => snapshots.some(s => s.activityPhase === "model"), "model phase");
		gate.afterModel.resolve();

		// thinking_delta → "thinking".
		await waitFor(() => snapshots.some(s => s.activityPhase === "thinking"), "thinking phase");
		gate.afterThinking.resolve();

		// text_delta → "responding".
		await waitFor(() => snapshots.some(s => s.activityPhase === "responding"), "responding phase");
		gate.afterText.resolve();

		// message_end → "working" (turn segment finished; requests counted).
		await waitFor(
			() => snapshots.some(s => s.activityPhase === "working" && s.requests === 1),
			"working after message end",
		);
		gate.afterMessageEnd.resolve();

		// Observed phase order (deduped) proves the streamed transitions.
		const observedOrder: string[] = [];
		for (const s of snapshots) {
			if (s.activityPhase && observedOrder[observedOrder.length - 1] !== s.activityPhase) {
				observedOrder.push(s.activityPhase);
			}
		}
		expect(observedOrder.join(" → ")).toContain("tool → working → model → thinking → responding → working");

		const result = await running;
		expect(result.exitCode).toBe(0);
		await gate.afterYield.promise;

		// Terminal snapshot: settled status, no running phase.
		const finalSnap = snapshots[snapshots.length - 1];
		expect(finalSnap.status).toBe("completed");
		expect(finalSnap.activityPhase).toBeUndefined();
	});

	it("copies activity fields into every snapshot surface (onProgress + progress channel)", async () => {
		const snapshots: AgentProgress[] = [];
		const busSnapshots: AgentProgress[] = [];
		const eventBus = new EventBus();
		eventBus.on(TASK_SUBAGENT_PROGRESS_CHANNEL, payload => {
			const progress = (payload as { progress?: AgentProgress }).progress;
			if (progress) busSnapshots.push(copySnapshot(progress));
		});
		const gate = {
			afterToolStart: Promise.withResolvers<void>(),
			afterToolEnd: Promise.withResolvers<void>(),
			afterThinking: Promise.withResolvers<void>(),
		};
		const { session } = createScriptedSession(async emit => {
			emit(toolStart("read", "read-1"));
			await gate.afterToolStart.promise;
			emit(toolEnd("read", "read-1"));
			await gate.afterToolEnd.promise;
			emit(streamDelta("thinking_delta", "think"));
			await gate.afterThinking.promise;
			for (const event of yieldEvents()) emit(event);
		});
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session,
		} as CreateAgentSessionResult);

		const running = runSubprocess({
			cwd: "/tmp",
			agent,
			task: "snapshot copy",
			description: "snapshot copy",
			index: 0,
			id: `copy-${Math.random().toString(36).slice(2)}`,
			settings: Settings.isolated(),
			modelRegistry: { refresh: async () => {} } as ModelRegistry,
			enableLsp: false,
			eventBus,
			onProgress: progress => snapshots.push(copySnapshot(progress)),
		});

		await waitFor(() => snapshots.some(s => s.activityPhase === "tool"), "tool phase (onProgress)");
		const toolSnap = snapshots.findLast(s => s.activityPhase === "tool")!;
		const toolPhaseTime = toolSnap.lastActivityAtMs!;
		// The eventBus surface carries the same by-value fields.
		await waitFor(() => busSnapshots.some(s => s.activityPhase === "tool"), "tool phase (channel)");
		const busTool = busSnapshots.findLast(s => s.activityPhase === "tool")!;
		expect(busTool.currentTool).toBe("read");
		expect(busTool.lastActivityAtMs).toBe(toolPhaseTime);
		gate.afterToolStart.resolve();

		await waitFor(
			() => snapshots.some(s => s.activityPhase === "working" && s.currentTool === undefined),
			"working after tool end",
		);
		const workingSnap = snapshots.findLast(s => s.activityPhase === "working" && s.currentTool === undefined)!;
		// Later events must not mutate already-emitted copies.
		expect(toolSnap.activityPhase).toBe("tool");
		expect(toolSnap.lastActivityAtMs).toBe(toolPhaseTime);
		expect(workingSnap.activityPhase).toBe("working");
		expect(workingSnap.lastActivityAtMs).toBeGreaterThanOrEqual(toolPhaseTime);
		gate.afterToolEnd.resolve();

		await waitFor(() => snapshots.some(s => s.activityPhase === "thinking"), "thinking phase");
		const thinkingSnap = snapshots.findLast(s => s.activityPhase === "thinking")!;
		expect(thinkingSnap.lastActivityAtMs).toBeGreaterThan(toolPhaseTime);
		gate.afterThinking.resolve();

		const result = await running;
		expect(result.exitCode).toBe(0);
		expect(snapshots[snapshots.length - 1].activityPhase).toBeUndefined();
	});

	it("streaming deltas keep the 150ms merge; lastActivityAtMs is event time, never emission time; silence between events", async () => {
		// This integration case deliberately exercises the executor's real 150ms
		// progress-coalescing timer against the platform clock, so deterministic
		// fake-timer control cannot substitute: the merge fires on real elapsed
		// time, and faking Date would make the event-vs-emission timestamp
		// discrimination vacuous. The quiet window is driven by the merged
		// snapshot signal itself (awaited from onProgress), not a fixed sleep.
		const snapshots: Array<{ snapshot: AgentProgress; at: number }> = [];
		const mergeSeen = Promise.withResolvers<void>();
		let tThinking = 0;
		let tText = 0;
		const { session } = createScriptedSession(async emit => {
			tThinking = Date.now();
			emit(streamDelta("thinking_delta", "deep thought"));
			// Back-to-back synchronous deltas: the second lands inside the 150ms
			// coalescing window whatever the clock granularity, so its emission
			// MUST ride the merge timer instead of flushing immediately.
			tText = Date.now();
			emit(streamDelta("text_delta", "rendered text"));
			// Await the merged snapshot signal before the next real event.
			await mergeSeen.promise;
			for (const event of yieldEvents()) emit(event);
		});
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session,
		} as CreateAgentSessionResult);

		const running = runSubprocess({
			cwd: "/tmp",
			agent,
			task: "merge window",
			description: "merge window",
			index: 0,
			id: `merge-${Math.random().toString(36).slice(2)}`,
			settings: Settings.isolated(),
			modelRegistry: { refresh: async () => {} } as ModelRegistry,
			enableLsp: false,
			eventBus: new EventBus(),
			onProgress: progress => {
				const snapshot = copySnapshot(progress);
				if (snapshot.activityPhase === "responding") mergeSeen.resolve();
				snapshots.push({ snapshot, at: Date.now() });
			},
		});

		await waitFor(() => snapshots.some(s => s.snapshot.activityPhase === "thinking"), "thinking merged snapshot");
		for (const s of snapshots.filter(s => s.snapshot.activityPhase === "thinking")) {
			// The delta's own delivery time, not the emission time.
			expect(Math.abs(s.snapshot.lastActivityAtMs! - tThinking)).toBeLessThan(100);
			expect(s.at - s.snapshot.lastActivityAtMs!).toBeGreaterThanOrEqual(0);
		}

		// text_delta must NOT flush immediately: no "responding" snapshot within
		// ~60ms of the event (it rides the existing 150ms coalescing timer).
		await waitFor(() => snapshots.some(s => s.snapshot.activityPhase === "responding"), "responding merged snapshot");
		expect(snapshots.filter(s => s.snapshot.activityPhase === "responding" && s.at < tText + 60).length).toBe(0);
		const firstResponding = snapshots.find(s => s.snapshot.activityPhase === "responding")!;
		expect(Math.abs(firstResponding.snapshot.lastActivityAtMs! - tText)).toBeLessThan(100);
		// Arrival is the merge boundary: strictly after the event that set it,
		// by the coalescing timer — never a synchronous emission.
		expect(firstResponding.at - firstResponding.snapshot.lastActivityAtMs!).toBeGreaterThanOrEqual(100);

		// Silence: once the merged emission lands, the "responding" phase is
		// never re-published by a timer-only refresh — the only snapshots after
		// it belong to the yield events' own transitions.
		expect(
			snapshots.filter(s => s.snapshot.activityPhase === "responding" && s.at > firstResponding.at + 50).length,
		).toBe(0);
		expect(firstResponding.snapshot.lastActivityAtMs).toBeLessThan(firstResponding.at);

		const result = await running;
		expect(result.exitCode).toBe(0);
	});

	it("auto_retry transitions park the phase at working and the terminal snapshot carries none", async () => {
		const snapshots: AgentProgress[] = [];
		const gate = {
			afterToolEnd: Promise.withResolvers<void>(),
			afterRetryStart: Promise.withResolvers<void>(),
			afterRetryEnd: Promise.withResolvers<void>(),
		};
		const { session } = createScriptedSession(async emit => {
			emit(toolStart("read", "read-1"));
			emit(toolEnd("read", "read-1"));
			await gate.afterToolEnd.promise;
			emit({
				type: "auto_retry_start",
				attempt: 1,
				maxAttempts: 3,
				delayMs: 5000,
				errorMessage: "429 rate limited",
			} as AgentSessionEvent);
			await gate.afterRetryStart.promise;
			emit({
				type: "auto_retry_end",
				success: false,
				attempt: 1,
				finalError: "still 429",
			} as AgentSessionEvent);
			await gate.afterRetryEnd.promise;
			for (const event of yieldEvents()) emit(event);
		});
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session,
		} as CreateAgentSessionResult);

		const running = runSubprocess({
			cwd: "/tmp",
			agent,
			task: "retry state",
			description: "retry state",
			index: 0,
			id: `retry-${Math.random().toString(36).slice(2)}`,
			settings: Settings.isolated(),
			modelRegistry: { refresh: async () => {} } as ModelRegistry,
			enableLsp: false,
			eventBus: new EventBus(),
			onProgress: progress => snapshots.push(copySnapshot(progress)),
		});

		// After the tool ended, the phase is working — not a lingering tool.
		await waitFor(
			() => snapshots.some(s => s.activityPhase === "working" && s.currentTool === undefined),
			"working after tool end",
		);
		gate.afterToolEnd.resolve();

		// auto_retry_start: retryState surfaces (display priority), phase stays
		// working — no stale tool/model phase while parked.
		await waitFor(() => snapshots.some(s => s.retryState?.errorMessage === "429 rate limited"), "retryState present");
		const retrySnap = snapshots.findLast(s => s.retryState?.errorMessage === "429 rate limited")!;
		expect(retrySnap.activityPhase).toBe("working");
		expect(retrySnap.retryState?.attempt).toBe(1);
		expect(retrySnap.retryState?.maxAttempts).toBe(3);
		gate.afterRetryStart.resolve();

		// auto_retry_end failure: retryState clears, retryFailure lands, phase
		// still working.
		await waitFor(() => snapshots.some(s => s.retryFailure?.errorMessage === "still 429"), "retryFailure present");
		const failedSnap = snapshots.findLast(s => s.retryFailure?.errorMessage === "still 429")!;
		expect(failedSnap.retryState).toBeUndefined();
		expect(failedSnap.activityPhase).toBe("working");
		gate.afterRetryEnd.resolve();

		const result = await running;
		expect(result.exitCode).toBe(0);
		const finalSnap = snapshots[snapshots.length - 1];
		expect(finalSnap.status).toBe("completed");
		expect(finalSnap.activityPhase).toBeUndefined();
		expect(finalSnap.retryFailure?.errorMessage).toBe("still 429");
	});
});
