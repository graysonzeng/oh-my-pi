/**
 * C6: tool-free final completion must not enqueue yield reminders; requireYieldTool
 * stays false for ordinary workers. Complements executor-wall-clock coverage.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { createSessionDefaults } from "../helpers/session-defaults";

const baseAgent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

const baseOptions = {
	cwd: "/tmp",
	agent: baseAgent,
	task: "finish now",
	index: 0,
	id: "c6-tool-free",
	modelRegistry: {
		refresh: async () => {},
		awaitBackgroundRefresh: async () => {},
	} as unknown as ModelRegistry,
	enableLsp: false,
	keepAlive: false,
};

describe("C6 tool-free final without yield reminders", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("worker completes on tool-free stop without yield-reminder text", async () => {
		const settings = Settings.isolated();
		const prompts: string[] = [];
		const captured: CreateAgentSessionOptions[] = [];
		const session: Partial<AgentSession> = {
			...createSessionDefaults(),
			setIrcWakeTurnObserver: () => {},
			subscribeRunState: () => () => {},
			state: { messages: [] } as never,
			agent: { state: { systemPrompt: ["test"] } } as never,
			extensionRunner: undefined as never,
			sessionManager: {
				appendSessionInit: () => {},
			} as never,
			getActiveToolNames: () => ["read", "yield"],
			getEnabledToolNames: () => ["read", "yield"],
			setActiveToolsByName: async () => {},
			subscribe: () => () => {},
			prompt: async (text: string) => {
				prompts.push(typeof text === "string" ? text : String(text));
				return true;
			},
			waitForIdle: async () => {},
			prepareForHeadlessAdvisorDrain: () => {},
			waitForAdvisorCatchup: async () => true,
			getLastAssistantMessage: () =>
				({
					role: "assistant",
					content: [{ type: "text", text: '{"ok":true}' }],
					stopReason: "stop",
				}) as never,
			hasPendingAsyncWork: () => false,
			abort: async () => {},
			dispose: async () => {},
		};
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (options) captured.push(options);
			return {
				session: session as AgentSession,
				extensionsResult: {} as unknown as LoadExtensionsResult,
				setToolUIContext: () => {},
				eventBus: new EventBus(),
			} satisfies CreateAgentSessionResult;
		});

		const result = await runSubprocess({
			...baseOptions,
			settings,
			performanceClass: "worker",
		});

		expect(captured[0]?.requireYieldTool).toBe(false);
		expect(result.aborted).toBe(false);
		expect(result.exitCode).toBe(0);
		expect(result.completionKind).toBe("completed");
		const reminderish = prompts.filter(
			p => /exited without calling yield/i.test(p) || /Submit the findings/i.test(p) || /yield reminder/i.test(p),
		);
		expect(reminderish).toHaveLength(0);
	});
});
