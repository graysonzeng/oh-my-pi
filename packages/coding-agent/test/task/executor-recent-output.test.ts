/**
 * Event-sequence equivalence tests for `progress.recentOutput`.
 *
 * The executor defers recent-output line reconstruction from every text_delta
 * to the progress emission boundary (`emitProgressNow`). These tests drive
 * `runSubprocess` with scripted event sequences and assert that EVERY observed
 * progress snapshot's `recentOutput` is byte-identical to the reference
 * algorithm applied to the raw tail at that observation point:
 *
 *   tail.slice(-8192).split("\n").filter(l => l.trim()).slice(-8).reverse()
 *
 * covering arbitrary chunk boundaries, blank/whitespace-only lines, tail
 * truncation (partial first line), Unicode code-unit slicing, message_start
 * resets, message_update content replacement, cancellation, and the final
 * flush. Snapshot arrays must also stay immutable after later refreshes.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, TextContent } from "@oh-my-pi/pi-ai";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import type { AgentHubOverlayComponent } from "@oh-my-pi/pi-coding-agent/modes/components/agent-hub";
import type { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { copySpawnJobLiveProgress } from "@oh-my-pi/pi-coding-agent/task";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition, AgentProgress } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { HubTool } from "@oh-my-pi/pi-coding-agent/tools/hub";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

const TAIL_BYTES = 8 * 1024;

/**
 * Reference model: the pre-optimization algorithm, recomputed eagerly from the
 * same raw-tail state machine (append + cap, content replace, reset). Any
 * observed snapshot must equal `expected()` of the events delivered so far.
 */
class RecentOutputReference {
	tail = "";

	append(text: string): void {
		if (!text) return;
		this.tail += text;
		if (this.tail.length > TAIL_BYTES) {
			this.tail = this.tail.slice(-TAIL_BYTES);
		}
	}

	replace(texts: ReadonlyArray<string | null>): void {
		this.tail = "";
		for (const text of texts) {
			if (!text) continue;
			this.tail += text;
			if (this.tail.length > TAIL_BYTES) {
				this.tail = this.tail.slice(-TAIL_BYTES);
			}
		}
	}

	reset(): void {
		this.tail = "";
	}

	expected(): string[] {
		return this.tail
			.split("\n")
			.filter(line => line.trim())
			.slice(-8)
			.reverse();
	}
}

type Op =
	/** message_update text_delta chunk (arbitrary boundary). */
	| { kind: "delta"; text: string }
	/** message_update carrying full content blocks (replace path); null = non-text block. */
	| { kind: "replace"; texts: Array<string | null> }
	/** assistant message_start (resets the tail). */
	| { kind: "reset" }
	/** tool start+end pair — tool_execution_end flushes progress synchronously. */
	| { kind: "observe" };

interface Observation {
	got: string[];
	want: string[];
}

interface ScenarioResult {
	observations: Observation[];
	/** Snapshot arrays captured by reference + a deep copy taken at observation time. */
	immutability: Array<{ live: string[]; copy: string[] }>;
	exitCode: number;
	finalWant: string[];
}

// AssistantMessage requires api/provider/usage/stopReason the executor never
// reads on this path; cast documents the deliberate structural test double.
function assistantMessage(content: TextContent[]): AssistantMessage {
	return { role: "assistant", content } as AssistantMessage;
}

function deltaEvent(delta: string): AgentSessionEvent {
	// `partial` is unread by the executor's message_update handling; single
	// cast keeps the test double minimal (same rationale as assistantMessage).
	return {
		type: "message_update",
		message: assistantMessage([]),
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: assistantMessage([]) },
	} as AgentSessionEvent;
}

function replaceEvent(texts: Array<string | null>): AgentSessionEvent {
	const content = texts.map(text =>
		text === null ? ({ type: "image", data: "", mimeType: "image/png" } as unknown) : { type: "text", text },
	);
	// No assistantMessageEvent → executor takes the content-replacement path.
	return {
		type: "message_update",
		message: { role: "assistant", content },
	} as AgentSessionEvent;
}

function resetEvent(): AgentSessionEvent {
	return { type: "message_start", message: assistantMessage([]) } as AgentSessionEvent;
}

function toolPair(idx: number): AgentSessionEvent[] {
	return [
		{ type: "tool_execution_start", toolCallId: `obs-${idx}`, toolName: "read", args: {} },
		{
			type: "tool_execution_end",
			toolCallId: `obs-${idx}`,
			toolName: "read",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		},
	] as AgentSessionEvent[];
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
	/** Resolves once prompt() has emitted every scripted event. */
	emitted: Promise<void>;
}

function createScriptedSession(
	script: (emit: (event: AgentSessionEvent) => void) => Promise<void>,
): MockSessionControls {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const emit = (event: AgentSessionEvent) => {
		for (const listener of [...listeners]) listener(event);
	};
	const emittedGate = Promise.withResolvers<void>();
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
			emittedGate.resolve();
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
	// AgentSession is a concrete class; the executor consumes only this
	// structural subset. Deliberate documented test-double escape hatch,
	// mirroring test/task/executor-pass-through.test.ts.
	return { session: session as unknown as AgentSession, emitted: emittedGate.promise };
}

const agent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

async function runScenario(ops: Op[], options?: { abortAfterOps?: boolean }): Promise<ScenarioResult> {
	const ref = new RecentOutputReference();
	const observations: Observation[] = [];
	const immutability: Array<{ live: string[]; copy: string[] }> = [];
	const abortController = new AbortController();

	const { session } = createScriptedSession(async emit => {
		for (const op of ops) {
			// Reference state advances BEFORE delivery: processEvent is synchronous,
			// so any onProgress fired during emit() observes exactly this state.
			switch (op.kind) {
				case "delta":
					ref.append(op.text);
					emit(deltaEvent(op.text));
					break;
				case "replace":
					ref.replace(op.texts);
					emit(replaceEvent(op.texts));
					break;
				case "reset":
					ref.reset();
					emit(resetEvent());
					break;
				case "observe":
					for (const event of toolPair(observations.length)) emit(event);
					break;
			}
		}
		if (options?.abortAfterOps) {
			abortController.abort();
			return;
		}
		for (const event of yieldEvents()) emit(event);
	});

	vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({ session } as CreateAgentSessionResult);

	const result = await runSubprocess({
		cwd: "/tmp",
		agent,
		task: "equivalence scenario",
		description: "recent-output equivalence",
		index: 0,
		id: `recent-output-${Math.random().toString(36).slice(2)}`,
		settings: Settings.isolated(),
		modelRegistry: { refresh: async () => {} } as ModelRegistry,
		enableLsp: false,
		signal: abortController.signal,
		eventBus: new EventBus(),
		onProgress: (progress: AgentProgress) => {
			observations.push({ got: [...progress.recentOutput], want: ref.expected() });
			immutability.push({ live: progress.recentOutput, copy: [...progress.recentOutput] });
		},
	});

	return { observations, immutability, exitCode: result.exitCode, finalWant: ref.expected() };
}

function expectAllMatch(result: ScenarioResult, minObservations: number): void {
	expect(result.observations.length).toBeGreaterThanOrEqual(minObservations);
	for (const [index, obs] of result.observations.entries()) {
		// Index in message aids debugging without a custom matcher.
		expect({ index, lines: obs.got }).toEqual({ index, lines: obs.want });
	}
	// Final flush (finalizeRunResult → scheduleProgress(true)) sees full-stream state.
	const last = result.observations[result.observations.length - 1];
	expect(last.got).toEqual(result.finalWant);
	// Older snapshots must never be mutated by later refreshes.
	for (const snap of result.immutability) {
		expect(snap.live).toEqual(snap.copy);
	}
}

/** Deterministic PRNG (mulberry32) for the property-style scenario. */
function mulberry32(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

describe("recentOutput event-sequence equivalence (deferred reconstruction)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("matches the reference across arbitrary chunk boundaries and blank lines", async () => {
		const corpus = "first line\n\n  \nsecond line\nthird\t line \n\n\nfourth\npartial trailing";
		const sizes = [1, 3, 7, 2, 11, 5, 1, 13, 4];
		const ops: Op[] = [];
		let offset = 0;
		let sizeIdx = 0;
		while (offset < corpus.length) {
			const size = sizes[sizeIdx % sizes.length];
			sizeIdx++;
			ops.push({ kind: "delta", text: corpus.slice(offset, offset + size) });
			offset += size;
			ops.push({ kind: "observe" });
		}
		const result = await runScenario(ops);
		expect(result.exitCode).toBe(0);
		expectAllMatch(result, corpus.length / 13);
		// Sanity: the scenario actually produced visible lines.
		const last = result.observations[result.observations.length - 1];
		expect(last.got[0]).toBe("partial trailing");
		expect(last.got).toContain("third\t line ");
	});

	it("preserves partial-first-line semantics across tail truncation", async () => {
		const ops: Op[] = [];
		// One line far longer than the cap: recentOutput[0] must be the code-unit
		// suffix of the tail, not the whole line.
		ops.push({ kind: "delta", text: `HEAD-${"x".repeat(9000)}` });
		ops.push({ kind: "observe" });
		// Then structured lines pushing the cut point through line boundaries.
		for (let i = 0; i < 40; i++) {
			ops.push({ kind: "delta", text: `line-${i}-${"y".repeat(97)}\n` });
			if (i % 7 === 0) ops.push({ kind: "observe" });
		}
		ops.push({ kind: "observe" });
		const result = await runScenario(ops);
		expect(result.exitCode).toBe(0);
		expectAllMatch(result, 6);
	});

	it("slices by UTF-16 code units across astral characters at the cap", async () => {
		const ops: Op[] = [];
		// Surrogate pairs (𝄞 = 2 code units) so the -8192 cut can land mid-pair.
		ops.push({ kind: "delta", text: "𝄞".repeat(4000) });
		ops.push({ kind: "observe" });
		ops.push({ kind: "delta", text: `\né-ü-𝄞 mixed ${"𝄞".repeat(150)}\n` });
		ops.push({ kind: "delta", text: "z".repeat(300) });
		ops.push({ kind: "observe" });
		const result = await runScenario(ops);
		expect(result.exitCode).toBe(0);
		expectAllMatch(result, 2);
	});

	it("handles exact 8192-code-unit cap boundaries and lone surrogates", async () => {
		const ops: Op[] = [];
		// Fill the tail to exactly the cap: 16 x (511 chars + "\n") = 8192 units.
		const line = "L".repeat(511);
		for (let i = 0; i < 16; i++) ops.push({ kind: "delta", text: `${line}\n` });
		ops.push({ kind: "observe" }); // tail.length === 8192 — no truncation yet
		ops.push({ kind: "delta", text: "x" }); // 8193 — cut exactly one leading unit
		ops.push({ kind: "observe" });
		// A high surrogate split from its low half across chunk boundaries, then
		// an unpaired high surrogate that stays lone in the tail.
		ops.push({ kind: "delta", text: "\uD83D" });
		ops.push({ kind: "observe" });
		ops.push({ kind: "delta", text: "\uDE00 paired-now\n" });
		ops.push({ kind: "delta", text: "lone-tail \uD800" });
		ops.push({ kind: "observe" });
		// Land the cap cut mid-pair: 64 astral pairs then 8191 filler units leave
		// exactly one unit (a lone low surrogate) of the emoji run in the tail.
		ops.push({ kind: "delta", text: "😀".repeat(64) });
		ops.push({ kind: "delta", text: "z".repeat(TAIL_BYTES - 1) });
		ops.push({ kind: "observe" });
		const result = await runScenario(ops);
		expect(result.exitCode).toBe(0);
		expectAllMatch(result, 5);
	});

	it("resets on assistant message_start and replaces on content updates", async () => {
		const ops: Op[] = [
			{ kind: "delta", text: "old stream line\nmore old\n" },
			{ kind: "observe" },
			{ kind: "reset" },
			{ kind: "observe" },
			{ kind: "delta", text: "fresh after reset\n" },
			{ kind: "observe" },
			{ kind: "replace", texts: ["replaced A\n", null, "", "replaced B\npartial C"] },
			{ kind: "observe" },
			{ kind: "delta", text: " extended" },
			{ kind: "observe" },
			{ kind: "replace", texts: [null, ""] },
			{ kind: "observe" },
			{ kind: "delta", text: "after empty replace" },
			{ kind: "observe" },
		];
		const result = await runScenario(ops);
		expect(result.exitCode).toBe(0);
		expectAllMatch(result, 7);
		// The reset actually cleared: post-reset observation saw [].
		const emptyObserved = result.observations.some(obs => obs.want.length === 0 && obs.got.length === 0);
		expect(emptyObserved).toBe(true);
	});

	it("handles whitespace-only trailing segments (unrepresentable last line)", async () => {
		const ops: Op[] = [
			{ kind: "delta", text: "line1\n   " },
			{ kind: "observe" },
			{ kind: "delta", text: "\t " },
			{ kind: "observe" },
			{ kind: "delta", text: "x" },
			{ kind: "observe" },
			{ kind: "delta", text: "\n\n \n" },
			{ kind: "observe" },
		];
		const result = await runScenario(ops);
		expect(result.exitCode).toBe(0);
		expectAllMatch(result, 4);
		const last = result.observations[result.observations.length - 1];
		expect(last.got).toEqual(["   \t x", "line1"]);
	});

	it("final flush on cancellation reflects the full delivered stream", async () => {
		const ops: Op[] = [
			{ kind: "delta", text: "work in progress\nsecond line" },
			{ kind: "observe" },
			{ kind: "delta", text: " grows without another observe boundary\ntail line" },
		];
		const result = await runScenario(ops, { abortAfterOps: true });
		expect(result.exitCode).not.toBe(0);
		expectAllMatch(result, 2);
		const last = result.observations[result.observations.length - 1];
		expect(last.got[0]).toBe("tail line");
	});

	it("property: seeded random chunk/reset/replace sequences match at every emission", async () => {
		const rand = mulberry32(0x5eed);
		const alphabet = ["a", "b", " ", "\t", "\n", "é", "𝄞", "0", "\n\n", "word ", "line\n"];
		const ops: Op[] = [];
		for (let i = 0; i < 400; i++) {
			const roll = rand();
			if (roll < 0.02) {
				ops.push({ kind: "reset" });
			} else if (roll < 0.05) {
				const texts: Array<string | null> = [];
				const blocks = 1 + Math.floor(rand() * 3);
				for (let b = 0; b < blocks; b++) {
					texts.push(
						rand() < 0.2
							? null
							: alphabet[Math.floor(rand() * alphabet.length)].repeat(1 + Math.floor(rand() * 40)),
					);
				}
				ops.push({ kind: "replace", texts });
			} else {
				let chunk = "";
				const pieces = 1 + Math.floor(rand() * 24);
				for (let p = 0; p < pieces; p++) {
					chunk += alphabet[Math.floor(rand() * alphabet.length)];
				}
				ops.push({ kind: "delta", text: chunk });
			}
			if (i % 17 === 0) ops.push({ kind: "observe" });
		}
		ops.push({ kind: "observe" });
		const result = await runScenario(ops);
		expect(result.exitCode).toBe(0);
		expectAllMatch(result, 20);
	});
});

describe("executor live-tool progress snapshots", () => {
	beforeAll(async () => {
		await initTheme();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("publishes current-tool args and start timestamp, then clears them on tool end", async () => {
		const snapshots: AgentProgress[] = [];
		const eventBus = new EventBus();
		resetSettingsForTest();
		const tempDir = TempDir.createSync("@pi-executor-hud-");
		let authStorage: AuthStorage | undefined;
		let parentSession: AgentSession | undefined;
		let mode: InteractiveMode | undefined;
		try {
			await Settings.init({
				inMemory: true,
				cwd: tempDir.path(),
				overrides: { "startup.quiet": true },
			});
			authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
			const modelRegistry = new ModelRegistry(authStorage);
			const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
			parentSession = new AgentSession({
				agent: new Agent({
					initialState: {
						model,
						systemPrompt: ["Test"],
						tools: [],
						messages: [],
					},
				}),
				sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
				settings: Settings.isolated({ "startup.quiet": true }),
				modelRegistry,
			});
			mode = new InteractiveMode(parentSession, "test", undefined, undefined, undefined, undefined, eventBus);
			const hudMode = mode;
			await hudMode.init({ suppressWelcomeIntro: true });
			vi.spyOn(hudMode.ui, "requestRender").mockImplementation(() => {});

			const afterStart = Promise.withResolvers<void>();
			const afterEnd = Promise.withResolvers<void>();
			const afterGrep = Promise.withResolvers<void>();
			const { session } = createScriptedSession(async emit => {
				emit({
					type: "tool_execution_start",
					toolCallId: "read-1",
					toolName: "read",
					args: { file_path: "src/auth.ts" },
				} as AgentSessionEvent);
				await afterStart.promise;
				emit({
					type: "tool_execution_end",
					toolCallId: "read-1",
					toolName: "read",
					result: { content: [{ type: "text", text: "ok" }] },
					isError: false,
				} as AgentSessionEvent);
				await afterEnd.promise;
				emit({
					type: "tool_execution_start",
					toolCallId: "grep-1",
					toolName: "grep",
					args: { pattern: "password" },
				} as AgentSessionEvent);
				await afterGrep.promise;
				emit({
					type: "tool_execution_end",
					toolCallId: "grep-1",
					toolName: "grep",
					result: { content: [{ type: "text", text: "ok" }] },
					isError: false,
				} as AgentSessionEvent);
				for (const event of yieldEvents()) emit(event);
			});
			vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({ session } as CreateAgentSessionResult);
			const running = runSubprocess({
				cwd: "/tmp",
				agent,
				task: "live tool fields",
				description: "live tool fields",
				index: 0,
				id: "AuthLoader",
				detached: true,
				settings: Settings.isolated(),
				modelRegistry: { refresh: async () => {} } as ModelRegistry,
				enableLsp: false,
				eventBus,
				onProgress: progress => {
					snapshots.push({
						...progress,
						recentTools: progress.recentTools.map(tool => ({ ...tool })),
					});
				},
			});
			const waitFor = async (predicate: () => boolean, label: string) => {
				const startedAt = Date.now();
				while (!predicate()) {
					if (Date.now() - startedAt > 2_000) throw new Error(`timed out waiting for ${label}`);
					await Bun.sleep(10);
				}
			};
			const waitForHud = async (predicate: (hud: string) => boolean, label: string) => {
				const startedAt = Date.now();
				while (true) {
					const hud = Bun.stripANSI(hudMode.subagentContainer.render(120).join("\n"));
					if (predicate(hud)) return hud;
					if (Date.now() - startedAt > 2_000) throw new Error(`timed out waiting for ${label}: ${hud}`);
					await Bun.sleep(20);
				}
			};
			await waitFor(() => snapshots.some(progress => progress.currentTool === "read"), "current-tool snapshot");
			const live = snapshots.findLast(progress => progress.currentTool === "read");
			expect(live?.currentToolArgs).toBe("src/auth.ts");
			expect(live?.currentToolStartMs).toBeGreaterThan(0);
			const liveHud = await waitForHud(
				hud => hud.includes("AuthLoader") && /read: src\/auth\.ts/.test(hud),
				"live HUD read gist",
			);
			expect(liveHud).toContain("AuthLoader");
			expect(liveHud).toMatch(/read: src\/auth\.ts/);
			const liveNarrow = Bun.stripANSI(hudMode.subagentContainer.render(40).join("\n"));
			expect(liveNarrow).toContain("AuthLoader");
			expect(liveNarrow).toMatch(/read: src\/auth\.ts/);
			for (const line of liveNarrow.split("\n")) {
				expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
			}
			afterStart.resolve();
			await waitFor(
				() => snapshots.some(progress => progress.recentTools[0]?.tool === "read" && !progress.currentTool),
				"recent-tool snapshot",
			);
			const ended = snapshots.findLast(
				progress => progress.recentTools[0]?.tool === "read" && !progress.currentTool,
			);
			expect(ended?.currentTool).toBeUndefined();
			expect(ended?.currentToolArgs).toBeUndefined();
			expect(ended?.currentToolStartMs).toBeUndefined();
			expect(ended?.recentTools[0]?.args).toBe("src/auth.ts");
			const endedHud = await waitForHud(
				hud => /read: src\/auth\.ts/.test(hud) && !hud.includes("6.0s"),
				"recent HUD read gist",
			);
			expect(endedHud).toMatch(/read: src\/auth\.ts/);
			expect(endedHud).not.toContain("6.0s");
			afterEnd.resolve();
			await waitFor(() => snapshots.some(progress => progress.currentTool === "grep"), "grep snapshot");
			const grep = snapshots.findLast(progress => progress.currentTool === "grep");
			expect(grep?.currentToolArgs).toBe("password");
			const grepHud = await waitForHud(
				hud => /grep: password/.test(hud) && !hud.includes("src/auth.ts"),
				"live HUD grep gist",
			);
			expect(grepHud).toMatch(/grep: password/);
			expect(grepHud).not.toContain("src/auth.ts");
			const grepNarrow = Bun.stripANSI(hudMode.subagentContainer.render(40).join("\n"));
			expect(grepNarrow).toMatch(/grep: password/);
			expect(grepNarrow).not.toContain("src/auth.ts");
			for (const line of grepNarrow.split("\n")) {
				expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
			}
			afterGrep.resolve();
			const result = await running;
			expect(result.exitCode).toBe(0);
			await waitForHud(hud => !hud.includes("AuthLoader"), "cleared HUD");
		} finally {
			mode?.stop();
			await parentSession?.dispose();
			authStorage?.close();
			tempDir.removeSync();
			resetSettingsForTest();
		}
	});

	it("feeds the same executor snapshot to HUD, hub wait, and Agent Hub", async () => {
		const eventBus = new EventBus();
		resetSettingsForTest();
		const tempDir = TempDir.createSync("@pi-executor-dual-");
		let authStorage: AuthStorage | undefined;
		let parentSession: AgentSession | undefined;
		let mode: InteractiveMode | undefined;
		let hub: AgentHubOverlayComponent | undefined;
		const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		const colsDesc = Object.getOwnPropertyDescriptor(process.stdout, "columns");
		Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => 24, set: () => {} });
		Object.defineProperty(process.stdout, "columns", { configurable: true, get: () => 140, set: () => {} });
		try {
			await Settings.init({
				inMemory: true,
				cwd: tempDir.path(),
				overrides: { "startup.quiet": true },
			});
			authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
			const modelRegistry = new ModelRegistry(authStorage);
			const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
			parentSession = new AgentSession({
				agent: new Agent({
					initialState: {
						model,
						systemPrompt: ["Test"],
						tools: [],
						messages: [],
					},
				}),
				sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
				settings: Settings.isolated({ "startup.quiet": true }),
				modelRegistry,
			});
			mode = new InteractiveMode(parentSession, "test", undefined, undefined, undefined, undefined, eventBus);
			const hudMode = mode;
			await hudMode.init({ suppressWelcomeIntro: true });
			vi.spyOn(hudMode.ui, "requestRender").mockImplementation(() => {});
			vi.spyOn(hudMode.ui, "showOverlay").mockImplementation(component => {
				hub = component as AgentHubOverlayComponent;
				return { hide: () => {}, setHidden: () => {}, isHidden: () => false };
			});

			AgentRegistry.resetGlobalForTests();
			IrcBus.resetGlobalForTests();
			const registry = AgentRegistry.global();
			registry.register({ id: "Main", displayName: "main", kind: "main", session: null });
			registry.register({
				id: "AuthLoader",
				displayName: "Auth Loader",
				kind: "sub",
				parentId: "Main",
				session: null,
			});

			const jobProgress: AgentProgress = {
				index: 0,
				id: "AuthLoader",
				agent: "task",
				agentSource: "bundled",
				status: "running",
				task: "live tool fields",
				recentTools: [],
				recentOutput: [],
				toolCount: 0,
				requests: 0,
				tokens: 0,
				cost: 0,
				durationMs: 0,
			};
			const hang = Promise.withResolvers<string>();
			const reported = Promise.withResolvers<(text: string, details?: Record<string, unknown>) => Promise<void>>();
			const manager = new AsyncJobManager({ onJobComplete: () => {} });
			manager.register(
				"task",
				"AuthLoader",
				async ({ reportProgress }) => {
					reported.resolve(reportProgress);
					return hang.promise;
				},
				{ id: "AuthLoader", ownerId: "Main" },
			);
			const reportProgress = await reported.promise;

			const pendingTools = new Map<string, ToolExecutionComponent>();
			const controller = new EventController({
				isInitialized: true,
				init: vi.fn(async () => {}),
				ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
				statusLine: { invalidate: vi.fn(), markActivityStart: vi.fn(), markActivityEnd: vi.fn() },
				updateEditorTopBorder: vi.fn(),
				toolOutputExpanded: false,
				transcriptMessageComponents: new WeakMap(),
				pendingTools,
				chatContainer: new TranscriptContainer(),
				session: { getToolByName: () => undefined, hasBuiltInTool: () => true, isStreaming: true },
				showWarning: vi.fn(),
				viewSession: { getToolByName: () => undefined, hasBuiltInTool: () => true, isStreaming: false },
				sessionManager: { getCwd: () => process.cwd() },
				setTodos: vi.fn(),
				clearPinnedError: vi.fn(),
				statusContainer: { disposeChildren: vi.fn() },
				ensureLoadingAnimation: vi.fn(),
			} as unknown as InteractiveModeContext);
			await controller.handleEvent({
				type: "tool_execution_start",
				toolCallId: "call_dual",
				toolName: "hub",
				args: { op: "wait", ids: ["AuthLoader"] },
			});
			const card = pendingTools.get("call_dual");
			if (!card) throw new Error("expected hub wait card");

			const abort = new AbortController();
			const firstWait = Promise.withResolvers<void>();
			const grepWait = Promise.withResolvers<void>();
			const pendingWait = new HubTool({
				cwd: process.cwd(),
				settings: {
					get(key: string): unknown {
						if (key === "async.pollWaitDuration") return "5m";
						if (key === "irc.timeoutMs") return 120_000;
						return undefined;
					},
				},
				agentRegistry: registry,
				asyncJobManager: manager,
				getAgentId: () => "Main",
			} as unknown as ToolSession).execute(
				"call_dual",
				{ op: "wait", ids: ["AuthLoader"] },
				abort.signal,
				update => {
					void controller.handleEvent({
						type: "tool_execution_update",
						toolCallId: "call_dual",
						toolName: "hub",
						args: { op: "wait", ids: ["AuthLoader"] },
						partialResult: update,
					});
					const tool =
						update.details && "jobs" in update.details ? update.details.jobs?.[0]?.liveActivity?.tool : undefined;
					if (tool === "read") firstWait.resolve();
					if (tool === "grep") grepWait.resolve();
				},
			);

			const afterStart = Promise.withResolvers<void>();
			const afterEnd = Promise.withResolvers<void>();
			const afterGrep = Promise.withResolvers<void>();
			const { session } = createScriptedSession(async emit => {
				emit({
					type: "tool_execution_start",
					toolCallId: "read-1",
					toolName: "read",
					args: { file_path: "src/auth.ts" },
					intent: "Inspect login",
				} as AgentSessionEvent);
				await afterStart.promise;
				emit({
					type: "tool_execution_end",
					toolCallId: "read-1",
					toolName: "read",
					result: { content: [{ type: "text", text: "ok" }] },
					isError: false,
				} as AgentSessionEvent);
				await afterEnd.promise;
				emit({
					type: "tool_execution_start",
					toolCallId: "grep-1",
					toolName: "grep",
					args: { pattern: "password" },
				} as AgentSessionEvent);
				await afterGrep.promise;
				emit({
					type: "tool_execution_end",
					toolCallId: "grep-1",
					toolName: "grep",
					result: { content: [{ type: "text", text: "ok" }] },
					isError: false,
				} as AgentSessionEvent);
				for (const event of yieldEvents()) emit(event);
			});
			vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({ session } as CreateAgentSessionResult);
			const running = runSubprocess({
				cwd: "/tmp",
				agent,
				task: "live tool fields",
				description: "Refactor the auth flow",
				index: 0,
				id: "AuthLoader",
				detached: true,
				settings: Settings.isolated(),
				modelRegistry: { refresh: async () => {} } as ModelRegistry,
				enableLsp: false,
				eventBus,
				onProgress: async progress => {
					copySpawnJobLiveProgress(jobProgress, progress);
					jobProgress.id = "AuthLoader";
					await reportProgress("running", { progress: [{ ...jobProgress }] });
				},
			});

			const waitForHud = async (predicate: (hud: string) => boolean, label: string) => {
				const startedAt = Date.now();
				while (true) {
					const hud = Bun.stripANSI(hudMode.subagentContainer.render(120).join("\n"));
					if (predicate(hud)) return hud;
					if (Date.now() - startedAt > 2_000) throw new Error(`timed out waiting for ${label}: ${hud}`);
					await Bun.sleep(20);
				}
			};

			await firstWait.promise;
			const liveHud = await waitForHud(
				hud => hud.includes("AuthLoader") && /read: Inspect login/.test(hud),
				"live HUD read gist",
			);
			expect(liveHud).toMatch(/read: Inspect login/);
			expect(liveHud).not.toContain("src/auth.ts");
			expect(Bun.stripANSI(card.render(120).join("\n"))).toMatch(/read: Inspect login/);
			expect(Bun.stripANSI(card.render(120).join("\n"))).not.toContain("src/auth.ts");
			const dualHudNarrow = Bun.stripANSI(hudMode.subagentContainer.render(40).join("\n"));
			expect(dualHudNarrow).toMatch(/read: Inspect login/);
			expect(dualHudNarrow).not.toContain("src/auth.ts");
			for (const line of dualHudNarrow.split("\n")) {
				expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
			}
			const dualWaitNarrow = Bun.stripANSI(card.render(40).join("\n"));
			expect(dualWaitNarrow).toMatch(/read: Inspect login/);
			expect(dualWaitNarrow).not.toContain("src/auth.ts");
			for (const line of dualWaitNarrow.split("\n")) {
				expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
			}
			hudMode.showAgentHub();
			if (!hub) throw new Error("expected Agent Hub overlay");
			hub.handleInput("\t");
			const liveHub = Bun.stripANSI(hub.render(140).join("\n"));
			expect(liveHub).toContain("Current");
			expect(liveHub).toContain("read · src/auth.ts");

			afterStart.resolve();
			await waitForHud(hud => /read: Inspect login/.test(hud) && !hud.includes("6.0s"), "recent HUD");
			afterEnd.resolve();
			await grepWait.promise;
			const grepHud = await waitForHud(
				hud => /grep: Inspect login/.test(hud) && !hud.includes("src/auth.ts"),
				"grep HUD",
			);
			expect(grepHud).toMatch(/grep: Inspect login/);
			expect(grepHud).not.toContain("password");
			expect(Bun.stripANSI(card.render(120).join("\n"))).toMatch(/grep: Inspect login/);
			const grepHudNarrow = Bun.stripANSI(hudMode.subagentContainer.render(40).join("\n"));
			expect(grepHudNarrow).toMatch(/grep: Inspect login/);
			expect(grepHudNarrow).not.toContain("password");
			for (const line of grepHudNarrow.split("\n")) {
				expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
			}
			const grepWaitNarrow = Bun.stripANSI(card.render(40).join("\n"));
			expect(grepWaitNarrow).toMatch(/grep: Inspect login/);
			expect(grepWaitNarrow).not.toContain("password");
			for (const line of grepWaitNarrow.split("\n")) {
				expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
			}
			const grepHub = Bun.stripANSI(hub.render(140).join("\n"));
			expect(grepHub).toContain("grep · password");
			expect(grepHub).not.toContain("src/auth.ts");
			afterGrep.resolve();
			const result = await running;
			expect(result.exitCode).toBe(0);
			await waitForHud(hud => !hud.includes("AuthLoader"), "cleared HUD");
			hang.resolve("done");
			const settledWait = await pendingWait;
			await controller.handleEvent({
				type: "tool_execution_end",
				toolCallId: "call_dual",
				toolName: "hub",
				result: settledWait,
				isError: false,
			});
			const settledCard = Bun.stripANSI(card.render(120).join("\n"));
			expect(settledCard).toContain("done");
			expect(settledCard).not.toMatch(/grep: password/);
			expect(settledCard).not.toContain("src/auth.ts");
			const settledNarrow = Bun.stripANSI(card.render(40).join("\n"));
			expect(settledNarrow).toContain("done");
			expect(settledNarrow).not.toMatch(/grep: password/);
			expect(settledNarrow).not.toContain("src/auth.ts");
			for (const line of settledNarrow.split("\n")) {
				expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
			}
			const settledHudNarrow = Bun.stripANSI(hudMode.subagentContainer.render(40).join("\n"));
			expect(settledHudNarrow).not.toContain("AuthLoader");
			expect(settledHudNarrow).not.toMatch(/grep: password/);
			for (const line of settledHudNarrow.split("\n")) {
				expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
			}
			const settledHub = Bun.stripANSI(hub.render(140).join("\n"));
			expect(settledHub).toContain("AuthLoader");
			expect(settledHub).toContain("Task");
			expect(settledHub).toContain("Refactor the auth flow");
			card.seal();
			await manager.getJob("AuthLoader")?.promise;
		} finally {
			hub?.dispose();
			mode?.stop();
			await parentSession?.dispose();
			authStorage?.close();
			tempDir.removeSync();
			resetSettingsForTest();
			AgentRegistry.resetGlobalForTests();
			IrcBus.resetGlobalForTests();
			if (rowsDesc) Object.defineProperty(process.stdout, "rows", rowsDesc);
			else Object.defineProperty(process.stdout, "rows", { configurable: true, value: undefined, writable: true });
			if (colsDesc) Object.defineProperty(process.stdout, "columns", colsDesc);
			else
				Object.defineProperty(process.stdout, "columns", { configurable: true, value: undefined, writable: true });
		}
	});
});
