/**
 * Contract: `--mode json` output stays linear in conversation size, print mode
 * fails loudly when `--max-time` expires before any assistant message exists,
 * and broken stdout pipes (`EPIPE`) during teardown do not escalate into a
 * fatal error.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Settings } from "../../src/config/settings";
import { printableEvent, runPrintMode } from "../../src/modes/print-mode";
import type { AgentSession, AgentSessionEvent } from "../../src/session/agent-session";

const assistant: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "hello" }],
	api: "openai-responses",
	provider: "openai",
	model: "gpt-test",
	usage: {} as AssistantMessage["usage"],
	stopReason: "stop",
	timestamp: 1,
	providerPayload: { type: "openaiResponsesHistory", provider: "openai", dt: true, items: [{ big: "blob" }] },
};

function createPrintSession(
	options: {
		lastAssistant?: AssistantMessage;
		onPrompt?: (emit: (event: AgentSessionEvent) => void) => void | Promise<void>;
		onTextOutputCommitted?: (committed: boolean) => void;
	} = {},
): AgentSession {
	let subscriber: ((event: AgentSessionEvent) => void) | undefined;
	return {
		extensionRunner: undefined,
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			subscriber = listener;
			return () => {};
		},
		settings: Settings.isolated(),
		sessionManager: {
			getHeader: () => undefined,
			buildSessionContext: () => ({ messages: [] }),
			getEntries: () => [],
			getCwd: () => process.cwd(),
			onPersistenceError: () => () => {},
			onPersistenceNotice: () => () => {},
		},
		disableStopTimeTodoReminders: () => {},
		prepareForHeadlessAdvisorDrain: () => {},
		waitForIdle: async () => {},
		setTextOutputCommitted: (committed: boolean) => {
			options.onTextOutputCommitted?.(committed);
		},
		waitForAdvisorCatchup: async () => true,
		prompt: async () => {
			await options.onPrompt?.(event => subscriber?.(event));
		},
		getLastAssistantMessage: () => options.lastAssistant,
		dispose: async () => {},
	} as unknown as AgentSession;
}

describe("printableEvent", () => {
	it("emits only the incremental delta for message_update", () => {
		const event: AgentSessionEvent = {
			type: "message_update",
			message: assistant,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hel", partial: assistant },
		};
		const printed = JSON.parse(JSON.stringify(printableEvent(event)));
		expect(printed).toEqual({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hel" },
		});
	});

	it("drops the done-variant message snapshot from message_update", () => {
		const event: AgentSessionEvent = {
			type: "message_update",
			message: assistant,
			assistantMessageEvent: { type: "done", reason: "stop", message: assistant },
		};
		const printed = JSON.parse(JSON.stringify(printableEvent(event)));
		expect(printed).toEqual({ type: "message_update", assistantMessageEvent: { type: "done", reason: "stop" } });
	});

	it("strips args and partialResult from tool_execution_update while preserving call identity", () => {
		// Regression (BUG-02): streaming bash tool_execution_update snapshots
		// re-serialized cumulative output into NDJSON logs, causing multi-tens-of-MB bloat.
		const event: AgentSessionEvent = {
			type: "tool_execution_update",
			toolCallId: "call-1",
			toolName: "bash",
			args: { command: "pytest -vv" },
			partialResult: { content: [{ type: "text", text: "x".repeat(100_000) }] },
		};
		const printed = JSON.parse(JSON.stringify(printableEvent(event)));
		expect(printed).toEqual({
			type: "tool_execution_update",
			toolCallId: "call-1",
			toolName: "bash",
		});
	});

	it("strips providerPayload from message_end but keeps the message content", () => {
		const event: AgentSessionEvent = { type: "message_end", message: assistant };
		const printed = JSON.parse(JSON.stringify(printableEvent(event))) as {
			message: Record<string, unknown>;
		};
		expect(printed.message.providerPayload).toBeUndefined();
		expect(printed.message.content).toEqual([{ type: "text", text: "hello" }]);
		expect(printed.message.model).toBe("gpt-test");
	});

	it("strips providerPayload from every message in agent_end", () => {
		const event: AgentSessionEvent = { type: "agent_end", messages: [assistant, assistant] };
		const printed = JSON.parse(JSON.stringify(printableEvent(event))) as {
			messages: Array<Record<string, unknown>>;
		};
		expect(printed.messages).toHaveLength(2);
		for (const message of printed.messages) expect(message.providerPayload).toBeUndefined();
	});
});

describe("runPrintMode deadline and broken-pipe contracts", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("exits 1 with a stderr diagnostic when --max-time expires before any assistant message", async () => {
		const stderrLines: string[] = [];
		const committedStates: boolean[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
			stderrLines.push(String(chunk));
			return true;
		}) as never);
		const session = createPrintSession({
			lastAssistant: undefined,
			onTextOutputCommitted: committed => committedStates.push(committed),
		});

		const textExit = await runPrintMode(session, {
			mode: "text",
			messages: ["summarize"],
			deadline: Date.now() - 1,
		});
		expect(textExit).toBe(1);
		expect(stderrLines.join("")).toContain("Deadline exceeded");
		expect(stderrLines.join("")).toContain("--max-time");
		expect(committedStates).toEqual([false]);

		stderrLines.length = 0;
		const jsonExit = await runPrintMode(session, {
			mode: "json",
			messages: ["summarize"],
			deadline: Date.now() - 1,
		});
		expect(jsonExit).toBe(1);
		expect(stderrLines.join("")).toContain("Deadline exceeded");
	});

	it("keeps exit 0 for no-turn runs, tool-only stop turns, and unexpired deadlines", async () => {
		const stderrLines: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
			stderrLines.push(String(chunk));
			return true;
		}) as never);

		// No admitted agent turn (mirrors builtin-only commands)
		const noTurnExit = await runPrintMode(createPrintSession({ lastAssistant: undefined }), {
			mode: "text",
			messages: [],
			deadline: Date.now() - 1,
		});
		expect(noTurnExit).toBe(0);
		expect(stderrLines.join("")).not.toContain("Deadline exceeded");

		// Completed tool-only assistant message without text blocks
		const toolOnlyAssistant: AssistantMessage = {
			...assistant,
			content: [{ type: "toolCall", id: "call-edit", name: "edit", arguments: { path: "a.ts" } }],
			stopReason: "stop",
		};
		stderrLines.length = 0;
		const toolOnlyExit = await runPrintMode(createPrintSession({ lastAssistant: toolOnlyAssistant }), {
			mode: "text",
			messages: ["apply patch"],
			deadline: Date.now() - 1,
		});
		expect(toolOnlyExit).toBe(0);
		expect(stderrLines.join("")).not.toContain("Deadline exceeded");

		// Admitted turn without assistant message while deadline is still in the future
		stderrLines.length = 0;
		const futureDeadlineExit = await runPrintMode(createPrintSession({ lastAssistant: undefined }), {
			mode: "text",
			messages: ["work"],
			deadline: Date.now() + 60_000,
		});
		expect(futureDeadlineExit).toBe(0);
		expect(stderrLines.join("")).not.toContain("Deadline exceeded");
	});

	it("settles cleanly on stdout EPIPE and skips subsequent writes to the broken pipe", async () => {
		let writeCalls = 0;
		vi.spyOn(process.stdout, "write").mockImplementation(((_chunk: unknown, cb?: (err?: Error | null) => void) => {
			writeCalls++;
			const err = Object.assign(new Error("EPIPE: broken pipe, write"), { code: "EPIPE", syscall: "write" });
			cb?.(err);
			return false;
		}) as never);

		const session = createPrintSession({
			lastAssistant: assistant,
			onPrompt: emit => {
				emit({ type: "turn_start" });
				emit({ type: "message_start", message: assistant });
				emit({ type: "agent_end", messages: [assistant] });
			},
		});

		expect(await runPrintMode(session, { mode: "json", initialMessage: "hello" })).toBe(0);
		expect(writeCalls).toBe(1);
	});

	it("still rejects on non-EPIPE stdout write failures", async () => {
		vi.spyOn(process.stdout, "write").mockImplementation(((_chunk: unknown, cb?: (err?: Error | null) => void) => {
			const err = Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
			cb?.(err);
			return false;
		}) as never);

		const session = createPrintSession({
			lastAssistant: assistant,
			onPrompt: emit => {
				emit({ type: "turn_start" });
			},
		});

		await expect(runPrintMode(session, { mode: "json", initialMessage: "hello" })).rejects.toThrow("ENOSPC");
	});
});
