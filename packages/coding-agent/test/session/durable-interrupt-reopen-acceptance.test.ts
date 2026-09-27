/**
 * W4 ordinary-session durable interrupt → reopen acceptance.
 *
 * Failure modes if this regresses:
 * - real side-effect write is lost or re-executed after SessionManager.open
 * - unfinished todo work disappears on reopen
 * - retry budget (settings.maxRetries) is ignored after reopen (unbounded continue)
 *
 * Not R7 workflow SQLite/merge recovery. Offline; mock model only.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { convertToLlm } from "../../src/session/messages";
import { SessionManager } from "../../src/session/session-manager";
import { type RecoveryCompactionResult, TurnRecovery, type TurnRecoveryHost } from "../../src/session/turn-recovery";
import type { ToolSession } from "../../src/tools";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "../../src/tools/todo";
import { WriteTool } from "../../src/tools/write";

describe("W4 durable interrupt reopen acceptance (ordinary session)", () => {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model");

	let authTemp: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const workspaces: TempDir[] = [];

	beforeAll(async () => {
		authTemp = TempDir.createSync("@omp-w4-reopen-auth-");
		authStorage = await AuthStorage.create(authTemp.join("auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, authTemp.join("models.yml"), {
			settings: Settings.isolated(),
		});
	});

	afterAll(() => {
		authStorage.close();
		authTemp.removeSync();
	});

	afterEach(() => {
		while (workspaces.length > 0) {
			workspaces.pop()?.removeSync();
		}
	});

	it("real write survives crash-like stop; reopen continues without duplicate write; todos + retry budget retained", async () => {
		const workspace = TempDir.createSync("@omp-w4-reopen-ws-");
		workspaces.push(workspace);
		const cwd = workspace.path();
		const artifactPath = "side-effect.txt";
		const artifactAbs = path.join(cwd, artifactPath);
		const artifactBody = "w4-durable-side-effect-v1\n";

		let writeExecutions = 0;
		const toolSession: ToolSession = {
			cwd,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getArtifactsDir: () => path.join(cwd, "artifacts"),
			allocateOutputArtifact: async toolType => {
				const id = String(writeExecutions + 1);
				return { id, path: path.join(cwd, "artifacts", `${id}.${toolType}.log`) };
			},
			settings: Settings.isolated({
				"compaction.enabled": false,
				"retry.enabled": true,
				"retry.maxRetries": 1,
				"retry.baseDelayMs": 0,
			}),
			enableLsp: false,
		};
		const baseWrite = new WriteTool(toolSession);
		const writeTool = new Proxy(baseWrite as unknown as AgentTool, {
			get(target, prop, receiver) {
				if (prop === "execute") {
					return async (toolCallId: string, args: unknown, signal?: AbortSignal, onUpdate?: never) => {
						writeExecutions += 1;
						return baseWrite.execute(toolCallId, args as never, signal, onUpdate);
					};
				}
				return Reflect.get(target, prop, receiver);
			},
		});

		const mock = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							id: "call-write-1",
							name: "write",
							arguments: { path: artifactPath, content: artifactBody },
						},
					],
					stopReason: "toolUse",
				},
				{
					content: [{ type: "toolCall", id: "call-next", name: "write", arguments: { path: "x", content: "y" } }],
					stopReason: "error",
					errorMessage: "stream stall: idle timeout",
				},
			],
		});

		const sessionManager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		const sessionFile = sessionManager.getSessionFile();
		expect(sessionFile).toBeTruthy();

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["W4 durable reopen"],
				tools: [writeTool],
				messages: [],
			},
			convertToLlm,
			streamFn: mock.stream,
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": true,
			"retry.maxRetries": 1,
			"retry.baseDelayMs": 0,
			"todo.enabled": true,
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry: new Map([["write", writeTool]]),
		});
		session.subscribe(() => {});

		// Unfinished work that must survive reopen.
		session.setTodoPhases([
			{
				name: "delivery",
				tasks: [
					{ content: "write artifact", status: "completed" },
					{ content: "finish remaining verify", status: "pending" },
				],
			},
		]);

		await session.prompt("write the side-effect file then continue");
		await session.waitForIdle();

		expect(writeExecutions).toBe(1);
		expect(await Bun.file(artifactAbs).text()).toBe(artifactBody);

		const failedAssistant = session.agent.state.messages.findLast(m => m.role === "assistant");
		expect(failedAssistant?.role).toBe("assistant");
		if (failedAssistant?.role !== "assistant") throw new Error("expected assistant");
		expect(failedAssistant.stopReason).toBe("error");

		const todosBefore = session.getTodoPhases();
		expect(todosBefore[0]?.tasks.find(t => t.content === "finish remaining verify")?.status).toBe("pending");
		expect(settings.get("retry.maxRetries")).toBe(1);

		await sessionManager.flush();
		await session.dispose();
		await sessionManager.close();

		// Crash-like reopen from durable JSONL (not in-memory restoreState).
		const reopenedManager = await SessionManager.open(sessionFile!, path.join(cwd, "sessions"));
		const reopenedMessages = reopenedManager.buildSessionContext().messages;
		const reopenedAgent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["W4 durable reopen"],
				tools: [writeTool],
				messages: reopenedMessages,
			},
			convertToLlm,
			streamFn: mock.stream,
		});
		const reopened = new AgentSession({
			agent: reopenedAgent,
			sessionManager: reopenedManager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"retry.enabled": true,
				"retry.maxRetries": 1,
				"retry.baseDelayMs": 0,
				"todo.enabled": true,
			}),
			modelRegistry,
			toolRegistry: new Map([["write", writeTool]]),
		});
		reopened.subscribe(() => {});

		// Artifact intact; write not re-executed by reopen alone.
		expect(await Bun.file(artifactAbs).text()).toBe(artifactBody);
		expect(writeExecutions).toBe(1);

		const todosAfter = reopened.getTodoPhases();
		expect(todosAfter[0]?.tasks.find(t => t.content === "finish remaining verify")?.status).toBe("pending");
		expect(todosAfter[0]?.tasks.find(t => t.content === "write artifact")?.status).toBe("completed");
		const todoEntries = reopenedManager
			.getBranch()
			.filter(e => e.type === "custom" && e.customType === USER_TODO_EDIT_CUSTOM_TYPE);
		expect(todoEntries.length).toBeGreaterThanOrEqual(1);

		// Retry budget retained via settings: first preserved-turn recovery schedules;
		// second identical stall without progress exhausts maxRetries=1.
		const host = createRecoveryHost(reopened, modelRegistry, settings);
		const recovery = new TurnRecovery(host);
		const scheduled: string[] = [];
		host.scheduleAgentContinue = options => scheduled.push(options.source);
		try {
			const stall = failedAssistant;
			expect(
				await recovery.handleRetryableError(stall, { preserveFailedTurn: true, allowModelFallback: false }),
			).toBe(true);
			expect(
				await recovery.handleRetryableError(stall, { preserveFailedTurn: true, allowModelFallback: false }),
			).toBe(false);
			expect(scheduled).toEqual(["automatic-retry"]);
		} finally {
			recovery.resolveRetry();
		}

		// Still a single real write on disk.
		expect(writeExecutions).toBe(1);
		expect(await Bun.file(artifactAbs).text()).toBe(artifactBody);

		await reopened.dispose();
		await reopenedManager.close();
	});
});

function createRecoveryHost(session: AgentSession, modelRegistry: ModelRegistry, settings: Settings): TurnRecoveryHost {
	return {
		agent: session.agent,
		sessionManager: session.sessionManager,
		persistedAssistantEntryId: () => undefined,
		settings,
		modelRegistry,
		configWarnings: [],
		model: () => session.model,
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
		sessionId: () => session.sessionId,
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
