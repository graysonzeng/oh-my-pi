/**
 * History S4 — thinking-loop / stream-interrupt as replayable failure cases.
 *
 * Calibrates existing TurnRecovery boundaries. Does NOT disable loop detection
 * or shorten timeouts. Completed tool artifacts must remain in context when
 * preserved-turn recovery continues.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { THINKING_LOOP_ERROR_MARKER } from "@oh-my-pi/pi-ai/utils/thinking-loop";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Model, Usage } from "@oh-my-pi/pi-catalog/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	type RecoveryCompactionResult,
	TurnRecovery,
	type TurnRecoveryHost,
} from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
import { TempDir } from "@oh-my-pi/pi-utils";

const USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function makeMessage(content: AssistantMessage["content"], model: Model, errorMessage: string): AssistantMessage {
	const message: AssistantMessage = {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { ...USAGE },
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	};
	message.errorId = AIError.classifyMessage(message);
	return message;
}

function toolResult(toolCallId: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text: "artifact://0 written; tests green" }],
		isError: false,
		timestamp: Date.now(),
	};
}

function createHost(model: Model, modelRegistry: ModelRegistry, messages: readonly AgentMessage[]): TurnRecoveryHost {
	const settings = Settings.isolated({ "retry.enabled": true, "retry.baseDelayMs": 0, "retry.maxRetries": 1 });
	const agentState = { messages: [...messages] };
	return {
		agent: {
			state: agentState,
			replaceMessages(next: AgentMessage[]) {
				agentState.messages = next;
			},
			appendMessage(message: AgentMessage) {
				agentState.messages.push(message);
			},
		} as never,
		sessionManager: {
			getLastModelChangeRole: () => undefined,
			getBranch: () => [],
			appendCustomMessageEntry: () => {},
		} as never,
		persistedAssistantEntryId: () => undefined,
		settings,
		modelRegistry,
		configWarnings: [],
		model: () => model,
		contextFitsModel: () => true,
		textOutputCommitted: () => true,
		thinkingLevel: () => undefined,
		configuredThinkingLevel: () => undefined,
		setThinkingLevel: () => {},
		thinkingLevelCeiling: () => undefined,
		isDisposed: () => false,
		isStreaming: () => false,
		isCompacting: () => false,
		abortInProgress: () => false,
		streamingEditAbortTriggered: () => false,
		promptGeneration: () => 0,
		promptSequence: () => 0,
		sessionId: () => "s4-fixtures",
		emitSessionEvent: async () => {},
		scheduleAgentContinue: () => {},
		waitForSessionMessagePersistence: async () => {},
		appendSessionMessage: () => {},
		sessionMessageAlreadyPersisted: () => false,
		setModelWithProviderSessionReset: async () => {},
		resolveActiveEditMode: () => "hashline",
		syncAfterModelChange: async () => {},
		resetCurrentResponsesProviderSession: () => {},
		maybeAutoRedeemReset: async () => false,
		runAutoCompaction: async () =>
			({ deferredHandoff: false, continuationScheduled: false }) as RecoveryCompactionResult,
		shakeForRequestBodyReadTimeout: async () => false,
		withBashBranchTransition: async <T>(operation: () => T | Promise<T>): Promise<T> => operation(),
	};
}

describe("S4 thinking-loop / stream-interrupt replayable fixtures", () => {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model");

	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-s4-loop-stream-");
		authStorage = await AuthStorage.create(tempDir.join("testauth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"), {
			settings: Settings.isolated(),
		});
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	it("redirects a thinking loop and stops when the retry budget is exhausted", async () => {
		const message = makeMessage([], model, THINKING_LOOP_ERROR_MARKER);
		message.errorId = AIError.create(AIError.Flag.ThinkingLoop);
		const host = createHost(model, modelRegistry, [message]);
		const scheduled: string[] = [];
		host.scheduleAgentContinue = options => scheduled.push(options.source);
		const recovery = new TurnRecovery(host);
		try {
			expect(await recovery.handleRetryableError(message, { allowModelFallback: false })).toBe(true);
			expect(host.agent.state.messages.some(m => m.role === "assistant")).toBe(false);
			expect(host.agent.state.messages.some(m => m.role === "custom" && !m.display)).toBe(true);
			expect(await recovery.handleRetryableError(message, { allowModelFallback: false })).toBe(false);
			expect(scheduled).toEqual(["automatic-retry"]);
		} finally {
			recovery.resolveRetry();
		}
	});

	it("stream-stall recovery preserves completed tool artifacts for continuation", async () => {
		const message = makeMessage(
			[{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "echo done" } }],
			model,
			"stream stall: idle timeout",
		);
		const result = toolResult("call-1");
		const host = createHost(model, modelRegistry, [message, result]);
		const scheduled: string[] = [];
		host.scheduleAgentContinue = options => scheduled.push(options.source);
		const recovery = new TurnRecovery(host);
		try {
			expect(recovery.isRetryableError(message)).toBe(false);
			expect(recovery.classifyResolvedInterruptedToolTurn(message)).toBe("stream-stall");
			expect(
				await recovery.handleRetryableError(message, { preserveFailedTurn: true, allowModelFallback: false }),
			).toBe(true);
			expect(scheduled).toEqual(["automatic-retry"]);
			expect(host.agent.state.messages).toEqual([message, result]);
		} finally {
			recovery.resolveRetry();
		}
	});

	it("does not continue stream-stall when tool calls are unresolved (no artifact to preserve)", () => {
		const message = makeMessage(
			[{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "echo done" } }],
			model,
			"stream stall: idle timeout",
		);
		const recovery = new TurnRecovery(createHost(model, modelRegistry, [message]));
		expect(recovery.classifyResolvedInterruptedToolTurn(message)).toBeUndefined();
	});

	it("preserves committed text and tool artifacts when continuing after stream-stall", async () => {
		const message = makeMessage(
			[
				{ type: "text", text: "Partial visible answer" },
				{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "echo done" } },
			],
			model,
			"stream stall: idle timeout",
		);
		const result = toolResult("call-1");
		const host = createHost(model, modelRegistry, [message, result]);
		const scheduled: string[] = [];
		host.scheduleAgentContinue = options => scheduled.push(options.source);
		const recovery = new TurnRecovery(host);
		try {
			// Committed text forbids discard/replay, but not a preserved-turn continuation.
			expect(recovery.isRetryableError(message)).toBe(false);
			expect(
				await recovery.handleRetryableError(message, { preserveFailedTurn: true, allowModelFallback: false }),
			).toBe(true);
			expect(scheduled).toEqual(["automatic-retry"]);
			expect(host.agent.state.messages).toEqual([message, result]);
		} finally {
			recovery.resolveRetry();
		}
	});
});
