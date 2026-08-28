import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolCall } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const sharedAuthStorage = createInMemoryAuthStorage();
sharedAuthStorage.setRuntimeApiKey("anthropic", "test-key");
const sharedModelRegistry = new ModelRegistry(sharedAuthStorage);

afterAll(() => {
	sharedAuthStorage.close();
});

describe("AgentSession goal false-completion continuation", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let promptSpy: { mock: { calls: unknown[] } };

	function textAssistant(text: string, tools: ToolCall[] = []): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text }, ...tools],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 50,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 60,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
	}

	function emitStop(msg: AssistantMessage): void {
		session.agent.emitExternalEvent({ type: "message_end", message: msg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [msg] });
	}

	function activateGoal(overrides?: { lastDecision?: "continue" | "candidate_complete"; turnId?: string }): void {
		const now = Date.now();
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id: "goal-1",
				objective: "Ship the release",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: now,
				updatedAt: now,
				hostGate: {
					goalRevision: 1,
					pendingVerification: false,
					consecutiveContinueCount: 0,
					lastDecision: overrides?.lastDecision,
					turnId: overrides?.turnId,
				},
			},
		});
	}

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-goal-false-completion-");
		sessionManager = SessionManager.inMemory(tempDir.path());
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"goal.enabled": true,
				"goal.hostGate.enabled": true,
			}),
			modelRegistry: sharedModelRegistry,
		});
		promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue();
	});

	afterEach(async () => {
		await session.dispose();
		try {
			await tempDir.remove();
		} catch {}
		vi.restoreAllMocks();
	});

	it("queues a hidden next-turn after a text-only completion claim", async () => {
		activateGoal();
		emitStop(textAssistant("all green"));
		await session.waitForIdle();
		expect(session.getGoalModeState()?.goal.status).toBe("active");
		expect(session.getGoalModeState()?.goal.hostGate?.lastEvidence).toBe("false_completion");
		expect(session.getGoalModeState()?.goal.hostGate?.lastNextStep).toContain("Do not claim completion");
		expect(promptSpy).toHaveBeenCalled();
	});

	it("still runs D3 when the settle turn has tool calls but no shipped verification", async () => {
		activateGoal();
		const call: ToolCall = { type: "toolCall", id: "c1", name: "bash", arguments: { command: "echo hi" } };
		const msg = textAssistant("all green", [call]);
		session.agent.emitExternalEvent({ type: "message_end", message: msg });
		session.agent.emitExternalEvent({
			type: "message_end",
			message: {
				role: "toolResult",
				toolCallId: "c1",
				toolName: "bash",
				content: [{ type: "text", text: "hi" }],
				isError: false,
				timestamp: Date.now(),
			},
		});
		session.agent.emitExternalEvent({ type: "agent_end", messages: [msg] });
		await session.waitForIdle();
		expect(session.getGoalModeState()?.goal.hostGate?.lastEvidence).toBe("false_completion");
		expect(promptSpy).toHaveBeenCalled();
	});

	it("does not run D3 after a candidate_complete nomination on this turn", async () => {
		activateGoal({ lastDecision: "candidate_complete", turnId: "turn-0" });
		emitStop(textAssistant("all green"));
		await session.waitForIdle();
		expect(session.getGoalModeState()?.goal.hostGate?.lastEvidence).not.toBe("false_completion");
		expect(promptSpy).not.toHaveBeenCalled();
	});

	it("can disable D3 with goal.hostGate.falseCompletion=false", async () => {
		session.settings.override("goal.hostGate.falseCompletion", false);
		activateGoal();
		emitStop(textAssistant("all green"));
		await session.waitForIdle();
		expect(session.getGoalModeState()?.goal.hostGate?.lastEvidence).not.toBe("false_completion");
		expect(promptSpy.mock.calls.length).toBe(0);
	});
});
