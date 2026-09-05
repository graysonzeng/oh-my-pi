import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentMessage, type StreamFn } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import { USELESS_NOTICE } from "@oh-my-pi/pi-agent-core/compaction/pruning";
import type { AssistantMessage, Model, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { CompactionMethod } from "@oh-my-pi/pi-coding-agent/session/compaction-methods";
import { SessionMaintenance, type SessionMaintenanceHost } from "@oh-my-pi/pi-coding-agent/session/session-maintenance";
import {
	SessionManager,
	SessionPersistenceIndeterminateError,
} from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, type WriteTextAtomicOptions } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

const CONTEXT_WINDOW = 300_000;
const DEFAULT_THRESHOLD_PERCENT = 50;
const SUMMARY_THRESHOLD_PERCENT = 40;
const RETRY_THRESHOLD_PERCENT = 20;
const LARGE_RESULT = "old tool output ".repeat(18_000);
const RECENT_TEXT = "recent context ".repeat(12_000);
const SUMMARY_TEXT_ONE = "assistant history one ".repeat(6_000);
const SUMMARY_TEXT_TWO = "assistant history two ".repeat(6_000);
const SMALL_RESULT = "small tool output ".repeat(500);

interface RecordedEvent {
	type: string;
	[key: string]: unknown;
}

interface SideCall {
	model: Model;
	prompt: string;
}

interface PublishGate {
	started: PromiseWithResolvers<void>;
	release: PromiseWithResolvers<void>;
	/** Pause the first atomic publish, then fail the first `failures` publishes. */
	pauseFirst: boolean;
	failures: number;
	calls: number;
	error: Error;
	corruptOnFailure: boolean;
}

/** A real file backend whose atomic publish can be paused after in-memory apply. */
class GatedFileSessionStorage extends FileSessionStorage {
	gate: PublishGate | undefined;

	override async writeTextAtomic(path: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		const gate = this.gate;
		if (gate && gate.calls === 0 && gate.pauseFirst) {
			gate.calls++;
			gate.started.resolve();
			await gate.release.promise;
			if (gate.failures > 0) {
				if (gate.corruptOnFailure) this.writeTextSync(path, "^broken\\n");
				throw gate.error;
			}
			return super.writeTextAtomic(path, content, options);
		}
		if (gate && gate.calls < gate.failures) {
			gate.calls++;
			if (gate.corruptOnFailure) this.writeTextSync(path, "^broken\\n");
			throw gate.error;
		}
		return super.writeTextAtomic(path, content, options);
	}
}

interface FixtureOptions {
	model?: Model;
	methodOrder?: CompactionMethod[];
	thresholdPercent?: number;
	providerTokens?: number;
	includeRecoveryTool?: boolean;
	delayedSummary?: boolean;
	malformedSummary?: boolean;
	abortOnStart?: boolean;
	abortAfterApply?: boolean;
	reanchorProviderOnRewrite?: boolean;
	veto?: boolean;
	defaultRoleModel?: Model;
	sessionManager?: SessionManager;
	cleanup?: () => Promise<void>;
}

interface Fixture {
	agent: Agent;
	maintenance: SessionMaintenance;
	sessionManager: SessionManager;
	settings: Settings;
	model: Model | undefined;
	events: RecordedEvent[];
	notices: string[];
	sideCalls: SideCall[];
	continueCalls: number;
	continuationCalls: Array<{ autoContinue: boolean; suppressContinuation: boolean }>;
	rebaseCalls: number;
	closeCalls: number;
	anchoredRewriteTokens: number;
	localTokens(): number;
	setModel(model: Model | undefined): void;
	releaseSummary(): void;
	cleanup(): Promise<void>;
}

let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;
const fixtures: Fixture[] = [];

function userMessage(text: string): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function assistantMessage(
	content: AssistantMessage["content"],
	model: Model,
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

function toolCall(id: string, name = "bash") {
	return { type: "toolCall" as const, id, name, arguments: { command: "printf output" } };
}

function toolResult(toolCallId: string, text: string, extra: Partial<ToolResultMessage> = {}): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
		...extra,
	};
}

function textOf(message: AgentMessage): string {
	if (message.role !== "assistant" && message.role !== "toolResult" && message.role !== "user") return "";
	if (typeof message.content === "string") return message.content;
	const block = message.content.find(candidate => candidate.type === "text");
	return block?.type === "text" ? block.text : "";
}

function branchMessage(fixture: Fixture, predicate: (message: AgentMessage) => boolean): AgentMessage {
	const entry = fixture.sessionManager
		.getBranch()
		.find(candidate => candidate.type === "message" && predicate(candidate.message));
	if (entry?.type !== "message") throw new Error("Expected branch message in fixture");
	return entry.message;
}

function appendLargeBranch(fixture: Fixture, includeUselessFlag = false): void {
	fixture.sessionManager.appendMessage(userMessage("first question"));
	fixture.sessionManager.appendMessage(assistantMessage([toolCall("large-call")], fixture.model!));
	fixture.sessionManager.appendMessage(
		toolResult("large-call", LARGE_RESULT, includeUselessFlag ? { useless: true } : undefined),
	);
	fixture.sessionManager.appendMessage(userMessage("recent request"));
	fixture.sessionManager.appendMessage(assistantMessage([toolCall("protected-recent-call")], fixture.model!));
	fixture.sessionManager.appendMessage(toolResult("protected-recent-call", RECENT_TEXT));
	fixture.sessionManager.appendMessage(assistantMessage([{ type: "text", text: "recent answer" }], fixture.model!));
	fixture.agent.replaceMessages(fixture.sessionManager.buildSessionContext().messages);
}

function appendSummaryBranch(fixture: Fixture): void {
	fixture.sessionManager.appendMessage(
		assistantMessage([{ type: "text", text: SUMMARY_TEXT_ONE }, toolCall("summary-call-1", "read")], fixture.model!),
	);
	fixture.sessionManager.appendMessage(toolResult("summary-call-1", SMALL_RESULT));
	fixture.sessionManager.appendMessage(
		assistantMessage([{ type: "text", text: SUMMARY_TEXT_TWO }, toolCall("summary-call-2", "grep")], fixture.model!),
	);
	fixture.sessionManager.appendMessage(toolResult("summary-call-2", SMALL_RESULT));
	fixture.sessionManager.appendMessage(userMessage(RECENT_TEXT));
	fixture.sessionManager.appendMessage(assistantMessage([{ type: "text", text: "recent answer" }], fixture.model!));
	fixture.agent.replaceMessages(fixture.sessionManager.buildSessionContext().messages);
}

function appendFailedAssistant(fixture: Fixture, stopReason: "error" | "length"): void {
	fixture.sessionManager.appendMessage(
		assistantMessage([{ type: "text", text: "failed turn" }], fixture.model!, stopReason),
	);
	fixture.agent.replaceMessages(fixture.sessionManager.buildSessionContext().messages);
}

function parseSummaryIds(prompt: string): string[] {
	const marker = prompt.lastIndexOf('{"entries":');
	if (marker < 0) return [];
	try {
		const request = JSON.parse(prompt.slice(marker)) as { entries?: Array<{ id?: unknown }> };
		return (request.entries ?? []).flatMap(entry => (typeof entry.id === "string" ? [entry.id] : []));
	} catch {
		return [];
	}
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
	for (let turn = 0; turn < 200; turn++) {
		if (predicate()) return;
		await Promise.resolve();
	}
	throw new Error(message);
}

async function makeFixture(options: FixtureOptions = {}): Promise<Fixture> {
	let currentModel: Model | undefined = options.model ?? getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!currentModel) throw new Error("Expected bundled Anthropic model");
	if (currentModel.contextWindow !== CONTEXT_WINDOW) {
		currentModel = { ...currentModel, contextWindow: CONTEXT_WINDOW, maxTokens: 32_000 };
	}
	const settings = Settings.isolated({
		"compaction.enabled": true,
		"compaction.asyncEnabled": true,
		"compaction.thresholdPercent": options.thresholdPercent ?? DEFAULT_THRESHOLD_PERCENT,
		"compaction.keepRecentTokens": 1,
		"compaction.autoContinue": false,
		...(options.methodOrder ? { "compaction.methodOrder": options.methodOrder } : {}),
	});
	if (options.defaultRoleModel)
		settings.setModelRole("default", `${options.defaultRoleModel.provider}/${options.defaultRoleModel.id}`);

	let providerTokens = options.providerTokens ?? 160_000;
	let maintenance!: SessionMaintenance;
	let fixture!: Fixture;
	let abortOnStart = options.abortOnStart === true;
	let abortAfterApply = options.abortAfterApply === true;
	const delayedStreams: Array<{ stream: AssistantMessageEventStream; model: Model; response: string }> = [];
	const events: RecordedEvent[] = [];
	const notices: string[] = [];
	const sideCalls: SideCall[] = [];
	let continueCalls = 0;
	const continuationCalls: Array<{ autoContinue: boolean; suppressContinuation: boolean }> = [];
	let rebaseCalls = 0;
	let closeCalls = 0;
	let anchoredRewriteTokens = 0;
	const sessionManager = options.sessionManager ?? SessionManager.inMemory();

	const toolSession: ToolSession = {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => sessionManager.getSessionFile() ?? null,
		getSessionSpawns: () => null,
		settings,
		restrictToolNames: true,
		readOmittedContent: {
			authorized: () => fixture.agent.state.tools.some(tool => tool.name === "read_omitted_content"),
			entries: () => fixture.sessionManager.getBranch(),
			fits: () => true,
		},
	};
	const tools = await createTools(toolSession, options.includeRecoveryTool === false ? [] : ["read_omitted_content"]);
	const agent = new Agent({
		initialState: {
			model: currentModel,
			systemPrompt: ["Test"],
			tools,
			messages: [],
		},
	});

	const sideStreamFn: StreamFn = (requestModel, context, streamOptions) => {
		const prompt = context.messages
			.flatMap(message =>
				Array.isArray(message.content) ? message.content : [{ type: "text" as const, text: message.content }],
			)
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map(block => block.text)
			.join("\n");
		const ids = parseSummaryIds(prompt);
		const response = options.malformedSummary
			? "not-json"
			: JSON.stringify({ summaries: ids.map(id => ({ id, text: `summary for ${id}` })) });
		const stream = new AssistantMessageEventStream();
		sideCalls.push({ model: requestModel, prompt });
		if (options.delayedSummary) {
			delayedStreams.push({ stream, model: requestModel, response });
			streamOptions?.signal?.addEventListener("abort", () => {
				if (!stream.done)
					stream.push({ type: "error", reason: "aborted", error: assistantMessage([], requestModel, "aborted") });
			});
		} else {
			queueMicrotask(() => {
				if (!stream.done) {
					stream.push({
						type: "text_delta",
						contentIndex: 0,
						delta: response,
						partial: assistantMessage([], requestModel),
					});
					stream.push({
						type: "done",
						reason: "stop",
						message: assistantMessage([{ type: "text", text: response }], requestModel),
					});
				}
			});
		}
		return stream;
	};

	const host = {
		agent,
		sessionManager,
		settings,
		modelRegistry,
		extensionRunner: options.veto
			? {
					hasHandlers: (type: string) => type === "session_before_compact",
					emit: async () => ({ cancel: true }),
				}
			: undefined,
		sideStreamFn,
		providerSessionState: new Map(),
		preferWebsockets: undefined,
		model: () => currentModel,
		thinkingLevel: () => undefined,
		isDisposed: () => false,
		isStreaming: () => false,
		isGeneratingHandoff: () => false,
		promptGeneration: () => 0,
		sessionId: () => sessionManager.getSessionId(),
		messages: () => agent.state.messages,
		baseSystemPrompt: () => ["Test"],
		goalModeState: () => undefined,
		planReferencePath: () => "",
		nonMessageTokenSource: () => ({}),
		memoryBackendSession: () => undefined,
		emitSessionEvent: async (event: RecordedEvent) => {
			events.push(event);
			if (abortOnStart && event.type === "auto_compaction_start") {
				abortOnStart = false;
				maintenance.abortCompaction("test abort before application");
			}
		},
		emitNotice: (_level: string, message: string) => notices.push(message),
		schedulePostPromptTask: () => {},
		scheduleAgentContinue: () => {
			continueCalls++;
		},
		scheduleCompactionContinuation: (value: { autoContinue: boolean; suppressContinuation: boolean }) => {
			continuationCalls.push(value);
			return false;
		},
		persistTurnMessagesForMidRunCompaction: async () => false,
		findLastAssistantMessage: () => {
			for (let index = agent.state.messages.length - 1; index >= 0; index--) {
				const message = agent.state.messages[index];
				if (message?.role === "assistant") return message;
			}
			return undefined;
		},
		disconnectFromAgent: () => {},
		reconnectToAgent: () => {},
		drainStrandedQueuedMessages: () => {},
		buildDisplaySessionContext: () => sessionManager.buildSessionContext(),
		convertToLlmForSideRequest: (messages: AgentMessage[]) => messages as never,
		obfuscateTextForProvider: (text: string | undefined) => text,
		obfuscatePreparationForProvider: <T>(preparation: T) => preparation,
		closeCodexProviderSessionsForHistoryRewrite: () => {
			closeCalls++;
		},
		resetCodexProviderAfterCompaction: () => {},
		resetPlanReference: () => {},
		syncTodoPhasesFromBranch: () => {},
		resetAdvisorRuntimes: () => {},
		rebaseAfterCompaction: () => {
			rebaseCalls++;
		},
		recordAnchoredHistoryRewrite: (tokens: number) => {
			anchoredRewriteTokens += tokens;
			if (options.reanchorProviderOnRewrite !== false) providerTokens = Math.max(0, providerTokens - tokens);
			if (abortAfterApply) {
				abortAfterApply = false;
				maintenance.abortCompaction("test abort after application");
			}
		},
		getContextBreakdown: () => undefined,
		getContextUsage: () => ({ tokens: providerTokens }),
		shake: async () => ({ modified: false, tokensRemoved: 0 }),
		dropImages: async () => ({ removed: 0 }),
		generateHandoffDocument: async () => undefined,
		removeAssistantMessageFromActiveContext: (message: AssistantMessage) => {
			const index = agent.state.messages.indexOf(message);
			if (index >= 0) agent.state.messages.splice(index, 1);
		},
		dropPersistedAssistantTurn: async () => undefined,
		runRecoveryCompactionWithRollback: async () => {
			throw new Error("Unexpected recovery host call");
		},
		parseRetryAfterMsFromError: () => undefined,
		setModelTemporary: async (model: Model) => {
			currentModel = model;
		},
		abort: async () => {},
		abortHandoff: () => {},
	} as unknown as SessionMaintenanceHost;
	maintenance = new SessionMaintenance(host);
	fixture = {
		agent,
		maintenance,
		sessionManager,
		settings,
		get model() {
			return currentModel;
		},
		events,
		notices,
		sideCalls,
		get continueCalls() {
			return continueCalls;
		},
		continuationCalls,
		get rebaseCalls() {
			return rebaseCalls;
		},
		get closeCalls() {
			return closeCalls;
		},
		get anchoredRewriteTokens() {
			return anchoredRewriteTokens;
		},
		localTokens: () => agent.tokenizer.countMessages(agent.state.messages),
		setModel: (model: Model | undefined) => {
			currentModel = model;
		},
		releaseSummary: () => {
			for (const delayed of delayedStreams.splice(0)) {
				if (!delayed.stream.done) {
					delayed.stream.push({
						type: "text_delta",
						contentIndex: 0,
						delta: delayed.response,
						partial: assistantMessage([], delayed.model),
					});
					delayed.stream.push({
						type: "done",
						reason: "stop",
						message: assistantMessage([{ type: "text", text: delayed.response }], delayed.model),
					});
				}
			}
		},
		cleanup: options.cleanup ?? (async () => {}),
	};
	fixtures.push(fixture);
	return fixture;
}

async function armSpeculation(fixture: Fixture): Promise<void> {
	fixture.maintenance.maybeStartSpeculativeCompaction(115_000, CONTEXT_WINDOW);
	await waitUntil(() => fixture.sideCalls.length > 0, "structured speculation did not call its summary model");
	await waitUntil(
		() => fixture.maintenance.speculationState === "running",
		"structured speculation did not remain in flight",
	);
	fixture.releaseSummary();
	await waitUntil(() => fixture.maintenance.speculationState === "armed", "structured speculation did not arm");
}

function largeResult(fixture: Fixture): ToolResultMessage {
	const message = branchMessage(
		fixture,
		candidate => candidate.role === "toolResult" && candidate.toolCallId === "large-call",
	);
	if (message.role !== "toolResult") throw new Error("Expected large tool result");
	return message;
}

beforeAll(async () => {
	authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("anthropic", "test-anthropic-key");
	authStorage.setRuntimeApiKey("openai", "test-openai-key");
	modelRegistry = new ModelRegistry(authStorage);
});

afterEach(async () => {
	for (const fixture of fixtures.splice(0)) {
		fixture.maintenance.abortCompaction();
		await fixture.cleanup();
	}
	vi.restoreAllMocks();
});

afterAll(() => authStorage.close());

describe("structured maintenance integration", () => {
	it("checkCompaction enters structured first, protecting deep results from stale/ordinary prune", async () => {
		const fixture = await makeFixture({ providerTokens: 160_000 });
		appendLargeBranch(fixture, true);
		expect(fixture.settings.getGroup("compaction").methodOrder[0]).toBe("structured");
		expect(fixture.localTokens()).toBeLessThan(160_000);
		const completedTurn = assistantMessage([{ type: "text", text: "turn complete" }], fixture.model!);
		completedTurn.usage = { ...completedTurn.usage, input: 159_999, output: 1, totalTokens: 160_000 };

		const deferredCheck = await fixture.maintenance.checkCompaction(completedTurn, true, false, false);
		expect(deferredCheck.historyRewritten).toBeUndefined();
		expect(largeResult(fixture).content).toEqual([{ type: "text", text: LARGE_RESULT }]);
		await waitUntil(
			() => fixture.maintenance.speculationState === "armed",
			"default structured candidate did not arm",
		);
		const check = await fixture.maintenance.checkCompaction(completedTurn, true, false, false);

		expect(check.historyRewritten).toBe(true);
		const result = largeResult(fixture);
		expect(result.omittedOriginal).toEqual([{ type: "text", text: LARGE_RESULT }]);
		expect(textOf(result)).toContain("read_omitted_content");
		expect(textOf(result)).not.toBe(USELESS_NOTICE);
		expect(fixture.anchoredRewriteTokens).toBeGreaterThan(20_000);
		expect(fixture.rebaseCalls).toBe(1);
		expect(fixture.closeCalls).toBe(1);
		expect(fixture.events.map(event => event.type)).toEqual(["auto_compaction_start", "auto_compaction_end"]);
		expect(fixture.events[1]).toMatchObject({ type: "auto_compaction_end", action: "structured", aborted: false });
	});

	it("keeps explicit old order and missing recovery permission on the old compaction route", async () => {
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "legacy summary",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));

		const explicit = await makeFixture({ methodOrder: ["soft", "structured"], includeRecoveryTool: true });
		appendLargeBranch(explicit);
		await explicit.maintenance.runAutoCompaction("threshold", false, false, false, { triggerContextTokens: 160_000 });
		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(largeResult(explicit).omittedOriginal).toBeUndefined();

		const unauthorized = await makeFixture({ methodOrder: ["structured", "soft"], includeRecoveryTool: false });
		appendLargeBranch(unauthorized);
		await unauthorized.maintenance.runAutoCompaction("threshold", false, false, false, {
			triggerContextTokens: 160_000,
		});
		expect(compactSpy).toHaveBeenCalledTimes(2);
		expect(largeResult(unauthorized).omittedOriginal).toBeUndefined();
	});

	it("rewrites two old assistant messages through the real summary callback while preserving tool pairing", async () => {
		const fixture = await makeFixture({
			methodOrder: ["structured"],
			thresholdPercent: SUMMARY_THRESHOLD_PERCENT,
			providerTokens: 115_000,
		});
		appendSummaryBranch(fixture);

		const result = await fixture.maintenance.runAutoCompaction("threshold", false, false, false, {
			triggerContextTokens: 115_000,
		});

		expect(result.historyRewritten).toBe(true);
		expect(fixture.sideCalls).toHaveLength(1);
		const assistants = fixture.agent.state.messages.filter(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		expect(
			assistants.filter(message => textOf(message).startsWith("[Summarized historical assistant message]")).length,
		).toBe(2);
		const calls = assistants.flatMap(message => message.content.filter(block => block.type === "toolCall"));
		const results = fixture.agent.state.messages.filter(
			(message): message is ToolResultMessage => message.role === "toolResult",
		);
		expect(calls.map(call => call.id)).toEqual(["summary-call-1", "summary-call-2"]);
		expect(results.map(message => message.toolCallId)).toEqual(["summary-call-1", "summary-call-2"]);
		expect(fixture.events).toEqual([
			expect.objectContaining({ type: "auto_compaction_start", action: "structured" }),
			expect.objectContaining({ type: "auto_compaction_end", action: "structured", aborted: false }),
		]);
	});

	it("uses compactionModel first and the current model first when no compactionModel is configured", async () => {
		const baseCurrent = getBundledModel("anthropic", "claude-sonnet-4-5");
		const configuredTarget = getBundledModel("openai", "gpt-5");
		if (!baseCurrent || !configuredTarget) throw new Error("Expected bundled model candidates");
		const configuredCurrent = buildModel({
			...baseCurrent,
			contextWindow: CONTEXT_WINDOW,
			compactionModel: `${configuredTarget.provider}/${configuredTarget.id}`,
			compat: baseCurrent.compatConfig,
		});
		const configured = await makeFixture({
			model: configuredCurrent,
			methodOrder: ["structured"],
			thresholdPercent: SUMMARY_THRESHOLD_PERCENT,
			providerTokens: 115_000,
		});
		appendSummaryBranch(configured);
		await configured.maintenance.runAutoCompaction("threshold", false, false, false, {
			triggerContextTokens: 115_000,
		});
		expect(configured.sideCalls[0]?.model.provider).toBe(configuredTarget.provider);
		expect(configured.sideCalls[0]?.model.id).toBe(configuredTarget.id);

		const currentFirst = await makeFixture({
			methodOrder: ["structured"],
			thresholdPercent: SUMMARY_THRESHOLD_PERCENT,
			providerTokens: 115_000,
			defaultRoleModel: configuredTarget,
		});
		appendSummaryBranch(currentFirst);
		await currentFirst.maintenance.runAutoCompaction("threshold", false, false, false, {
			triggerContextTokens: 115_000,
		});
		expect(currentFirst.sideCalls[0]?.model.provider).toBe("anthropic");
		expect(currentFirst.sideCalls[0]?.model.id).toBe("claude-sonnet-4-5");
	});

	it("returns without a rewrite when strict summary parsing fails, when a caller aborts, or when a hook vetoes", async () => {
		const malformed = await makeFixture({
			methodOrder: ["structured"],
			thresholdPercent: SUMMARY_THRESHOLD_PERCENT,
			providerTokens: 115_000,
			malformedSummary: true,
		});
		appendSummaryBranch(malformed);
		const malformedBefore = JSON.stringify(malformed.sessionManager.getBranch());
		const malformedResult = await malformed.maintenance.runAutoCompaction("threshold", false, false, false, {
			triggerContextTokens: 115_000,
		});
		expect(malformedResult.historyRewritten).toBeUndefined();
		expect(JSON.stringify(malformed.sessionManager.getBranch())).toBe(malformedBefore);
		expect(malformed.events.at(-1)).toMatchObject({ type: "auto_compaction_end", aborted: false });

		const aborted = await makeFixture({
			methodOrder: ["structured"],
			thresholdPercent: SUMMARY_THRESHOLD_PERCENT,
			providerTokens: 115_000,
			delayedSummary: true,
		});
		appendSummaryBranch(aborted);
		const abortedBefore = JSON.stringify(aborted.sessionManager.getBranch());
		const abortRun = aborted.maintenance.runAutoCompaction("threshold", false, false, false, {
			triggerContextTokens: 115_000,
		});
		await waitUntil(() => aborted.sideCalls.length === 1, "abort fixture did not start summary");
		aborted.maintenance.abortCompaction("test cancellation");
		const abortedResult = await abortRun;
		expect(abortedResult.historyRewritten).toBeUndefined();
		expect(JSON.stringify(aborted.sessionManager.getBranch())).toBe(abortedBefore);
		expect(aborted.events.at(-1)).toMatchObject({ type: "auto_compaction_end", aborted: true });

		const veto = await makeFixture({ methodOrder: ["structured"], providerTokens: 160_000, veto: true });
		appendLargeBranch(veto);
		const vetoBefore = JSON.stringify(veto.sessionManager.getBranch());
		const vetoResult = await veto.maintenance.runAutoCompaction("threshold", false, false, false, {
			triggerContextTokens: 160_000,
		});
		expect(vetoResult.historyRewritten).toBeUndefined();
		expect(JSON.stringify(veto.sessionManager.getBranch())).toBe(vetoBefore);
		expect(veto.events.at(-1)).toMatchObject({ type: "auto_compaction_end", action: "structured", aborted: true });
	});

	it("does not block the main checkCompaction turn and consumes an armed result without another summary request", async () => {
		const fixture = await makeFixture({
			methodOrder: ["structured"],
			thresholdPercent: SUMMARY_THRESHOLD_PERCENT,
			providerTokens: 115_000,
			delayedSummary: true,
		});
		appendSummaryBranch(fixture);
		const check = await fixture.maintenance.checkCompaction(
			assistantMessage([{ type: "text", text: "turn complete" }], fixture.model!),
			true,
			false,
			false,
		);
		expect(check.historyRewritten).toBeUndefined();
		expect(fixture.maintenance.speculationState).toBe("running");
		await waitUntil(() => fixture.sideCalls.length === 1, "main check did not start structured speculation");
		fixture.releaseSummary();
		await waitUntil(() => fixture.maintenance.speculationState === "armed", "structured speculation did not arm");

		const committed = await fixture.maintenance.runAutoCompaction("threshold", false, false, false, {
			triggerContextTokens: 115_000,
		});
		expect(committed.historyRewritten).toBe(true);
		expect(fixture.sideCalls).toHaveLength(1);
		expect(fixture.rebaseCalls).toBe(1);
	});

	it("invalidates an armed patch for same-ID content, metadata, model, budget, or permission changes while retaining ordinary appends", async () => {
		const mutations: Array<{ name: string; apply: (fixture: Fixture) => void }> = [
			{
				name: "content",
				apply: fixture => {
					const assistant = branchMessage(fixture, message => message.role === "assistant") as AssistantMessage;
					const first = assistant.content.find(block => block.type === "text");
					if (first?.type !== "text") throw new Error("Expected assistant text");
					first.text = `${first.text} changed`;
				},
			},
			{
				name: "metadata",
				apply: fixture => {
					const assistant = branchMessage(fixture, message => message.role === "assistant") as AssistantMessage & {
						metadata?: unknown;
					};
					assistant.metadata = { changed: true };
				},
			},
			{
				name: "model",
				apply: fixture => fixture.setModel(undefined),
			},
			{
				name: "budget",
				apply: fixture => fixture.settings.override("compaction.thresholdTokens", 299_000),
			},
			{
				name: "permission",
				apply: fixture => fixture.agent.setTools([]),
			},
		];

		for (const mutation of mutations) {
			const fixture = await makeFixture({
				methodOrder: ["structured"],
				thresholdPercent: SUMMARY_THRESHOLD_PERCENT,
				providerTokens: 115_000,
			});
			appendSummaryBranch(fixture);
			await armSpeculation(fixture);
			mutation.apply(fixture);
			const changedState = JSON.stringify(fixture.sessionManager.getBranch());
			const result = await fixture.maintenance.runAutoCompaction("threshold", false, false, false, {
				triggerContextTokens: 115_000,
			});
			expect(result.historyRewritten, mutation.name).toBeUndefined();
			expect(JSON.stringify(fixture.sessionManager.getBranch()), mutation.name).toBe(changedState);
			expect(fixture.rebaseCalls, mutation.name).toBe(0);
		}

		const appended = await makeFixture({
			methodOrder: ["structured"],
			thresholdPercent: SUMMARY_THRESHOLD_PERCENT,
			providerTokens: 115_000,
		});
		appendSummaryBranch(appended);
		await armSpeculation(appended);
		const appendedId = appended.sessionManager.appendMessage(userMessage("ordinary append after arm"));
		const result = await appended.maintenance.runAutoCompaction("threshold", false, false, false, {
			triggerContextTokens: 115_000,
		});
		expect(result.historyRewritten).toBe(true);
		expect(appended.sessionManager.getBranch().some(entry => entry.id === appendedId)).toBe(true);
		expect(
			textOf(
				branchMessage(appended, message => message.role === "user" && textOf(message).includes("ordinary append")),
			),
		).toContain("ordinary append");
	});

	it("separates threshold recovery-band progress from retry-fit progress and excludes a failed assistant", async () => {
		const threshold = await makeFixture({
			methodOrder: ["structured"],
			providerTokens: 160_000,
			reanchorProviderOnRewrite: false,
		});
		appendLargeBranch(threshold);
		const thresholdResult = await threshold.maintenance.runAutoCompaction("threshold", false, false, false, {
			triggerContextTokens: 160_000,
		});
		expect(thresholdResult.historyRewritten).toBe(true);
		expect(thresholdResult.automaticContinuationBlocked).toBe(true);
		expect(threshold.continuationCalls[0]?.autoContinue).toBe(false);
		expect(threshold.continueCalls).toBe(0);
		expect(threshold.anchoredRewriteTokens).toBeGreaterThan(20_000);

		for (const stopReason of ["error", "length"] as const) {
			const retry = await makeFixture({
				methodOrder: ["structured"],
				thresholdPercent: RETRY_THRESHOLD_PERCENT,
				providerTokens: 230_000,
			});
			appendLargeBranch(retry);
			appendFailedAssistant(retry, stopReason);
			const result = await retry.maintenance.runAutoCompaction(
				stopReason === "error" ? "overflow" : "incomplete",
				true,
				false,
				false,
				{ triggerContextTokens: 230_000 },
			);
			expect(result.historyRewritten).toBe(true);
			expect(result.automaticContinuationBlocked).toBeUndefined();
			expect(result.continuationScheduled).toBe(true);
			expect(retry.continueCalls).toBe(1);
			expect(
				retry.agent.state.messages.some(
					message => message.role === "assistant" && message.stopReason === stopReason,
				),
			).toBe(false);
			expect(retry.anchoredRewriteTokens).toBeGreaterThan(20_000);
		}
	});

	it("lets manual structured compaction commit without auto events, and reports no-op from the real auto entry", async () => {
		const manual = await makeFixture({ methodOrder: ["structured"], providerTokens: 160_000 });
		appendLargeBranch(manual);
		const manualResult = await manual.maintenance.compact();
		expect(manualResult.details).toEqual({ kind: "structured" });
		expect(largeResult(manual).omittedOriginal).toBeDefined();
		expect(manual.events).toHaveLength(0);
		expect(manual.rebaseCalls).toBe(1);

		const noop = await makeFixture({ methodOrder: ["structured"], providerTokens: 160_000 });
		noop.sessionManager.appendMessage(userMessage("too small to compact"));
		noop.agent.replaceMessages(noop.sessionManager.buildSessionContext().messages);
		const noopResult = await noop.maintenance.runAutoCompaction("threshold", false, false, false, {
			triggerContextTokens: 160_000,
		});
		expect(noopResult.historyRewritten).toBeUndefined();
		expect(noop.rebaseCalls).toBe(0);
		expect(noop.events).toEqual([
			expect.objectContaining({ type: "auto_compaction_start", action: "structured" }),
			expect.objectContaining({ type: "auto_compaction_end", action: "structured", skipped: true }),
		]);
	});

	it("aborts before application and keeps a committed post-apply abort distinct from cancellation", async () => {
		const before = await makeFixture({ methodOrder: ["structured"], providerTokens: 160_000, abortOnStart: true });
		appendLargeBranch(before);
		const beforeResult = await before.maintenance.runAutoCompaction("threshold", false, false, false, {
			triggerContextTokens: 160_000,
		});
		expect(beforeResult.historyRewritten).toBeUndefined();
		expect(before.rebaseCalls).toBe(0);
		expect(before.closeCalls).toBe(0);
		expect(largeResult(before).omittedOriginal).toBeUndefined();
		expect(before.events.at(-1)).toMatchObject({ type: "auto_compaction_end", aborted: true });

		const after = await makeFixture({ methodOrder: ["structured"], providerTokens: 160_000, abortAfterApply: true });
		appendLargeBranch(after);
		const afterResult = await after.maintenance.runAutoCompaction("threshold", false, false, false, {
			triggerContextTokens: 160_000,
		});
		expect(afterResult.historyRewritten).toBe(true);
		expect(largeResult(after).omittedOriginal).toBeDefined();
		expect(after.rebaseCalls).toBe(1);
		expect(after.closeCalls).toBe(1);
		expect(after.continueCalls).toBe(0);
		expect(after.continuationCalls).toHaveLength(0);
		expect(after.events.at(-1)).toMatchObject({ type: "auto_compaction_end", action: "structured", aborted: true });
	});

	it("keeps persistent history and fresh reload synchronized when abort arrives during publish", async () => {
		const tempDir = TempDir.createSync("@pi-structured-lifecycle-");
		const storage = new GatedFileSessionStorage();
		const gate: PublishGate = {
			started: Promise.withResolvers<void>(),
			release: Promise.withResolvers<void>(),
			pauseFirst: true,
			failures: 0,
			calls: 0,
			error: new Error("publish failure"),
			corruptOnFailure: false,
		};
		const manager = SessionManager.create(tempDir.path(), tempDir.path(), storage);
		const fixture = await makeFixture({
			sessionManager: manager,
			methodOrder: ["structured"],
			providerTokens: 160_000,
			abortAfterApply: true,
			cleanup: async () => {
				gate.release.resolve();
				await manager.close().catch(() => undefined);
				tempDir.removeSync();
			},
		});
		appendLargeBranch(fixture);
		await manager.ensureOnDisk();
		await manager.flush();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persistent session file");

		storage.gate = gate;
		const run = fixture.maintenance.runAutoCompaction("threshold", false, false, false, {
			triggerContextTokens: 160_000,
		});
		await gate.started.promise;
		fixture.maintenance.abortCompaction("abort after in-memory apply");
		gate.release.resolve();
		const result = await run;
		expect(result.historyRewritten).toBe(true);
		expect(fixture.rebaseCalls).toBe(1);
		expect(fixture.closeCalls).toBe(1);
		expect(fixture.continueCalls).toBe(0);
		expect(fixture.continuationCalls).toHaveLength(0);
		expect(fixture.events.at(-1)).toMatchObject({ type: "auto_compaction_end", aborted: true });
		expect(fixture.notices).toHaveLength(0);
		expect(textOf(largeResult(fixture))).toContain("read_omitted_content");

		await manager.flush();
		const jsonl = await storage.readText(sessionFile);
		expect(jsonl).toContain("read_omitted_content");
		expect(jsonl).toContain(LARGE_RESULT);
		const fresh = await SessionManager.open(sessionFile, tempDir.path(), storage);
		try {
			const reloaded = fresh
				.getBranch()
				.find(
					entry =>
						entry.type === "message" &&
						entry.message.role === "toolResult" &&
						entry.message.toolCallId === "large-call",
				);
			expect(
				reloaded?.type === "message" && reloaded.message.role === "toolResult"
					? reloaded.message.omittedOriginal
					: undefined,
			).toEqual([{ type: "text", text: LARGE_RESULT }]);
		} finally {
			await fresh.close();
		}
	});

	it("does not reset provider state for a publish failure repaired successfully or for an indeterminate latch", async () => {
		const repaired = await makeFixture({ methodOrder: ["structured"], providerTokens: 160_000 });
		appendLargeBranch(repaired);
		const originalRewrite = repaired.sessionManager.rewriteMessageEntriesAtomically.bind(repaired.sessionManager);
		let calls = 0;
		vi.spyOn(repaired.sessionManager, "rewriteMessageEntriesAtomically").mockImplementation(
			async (rewrite, validate) => {
				calls++;
				if (calls === 1) throw new Error("simulated publish failure");
				return originalRewrite(rewrite, validate);
			},
		);
		const repairedResult = await repaired.maintenance.runAutoCompaction("threshold", false, false, false, {
			triggerContextTokens: 160_000,
		});
		expect(repairedResult.historyRewritten).toBeUndefined();
		expect(repaired.rebaseCalls).toBe(0);
		expect(repaired.closeCalls).toBe(0);
		expect(largeResult(repaired).omittedOriginal).toBeUndefined();
		expect(repaired.continueCalls).toBe(0);

		const tempDir = TempDir.createSync("@pi-structured-indeterminate-");
		const storage = new GatedFileSessionStorage();
		const manager = SessionManager.create(tempDir.path(), tempDir.path(), storage);
		const indeterminate = await makeFixture({
			methodOrder: ["structured"],
			providerTokens: 160_000,
			sessionManager: manager,
			cleanup: async () => {
				await manager.close().catch(() => undefined);
				await tempDir.remove();
			},
		});
		appendLargeBranch(indeterminate);
		await manager.ensureOnDisk();
		await manager.flush();
		const gate: PublishGate = {
			started: Promise.withResolvers<void>(),
			release: Promise.withResolvers<void>(),
			pauseFirst: true,
			failures: 2,
			calls: 0,
			error: new Error("indeterminate publish"),
			corruptOnFailure: true,
		};
		storage.gate = gate;
		const failing = indeterminate.maintenance.runAutoCompaction("threshold", false, false, false, {
			triggerContextTokens: 160_000,
		});
		try {
			await gate.started.promise;
			gate.release.resolve();
			await expect(failing).rejects.toBeInstanceOf(SessionPersistenceIndeterminateError);
			expect(indeterminate.rebaseCalls).toBe(0);
			expect(indeterminate.closeCalls).toBe(0);
			expect(indeterminate.continueCalls).toBe(0);
			expect(
				indeterminate.events.some(
					event => event.type === "auto_compaction_end" && !event.aborted && !event.errorMessage,
				),
			).toBe(false);
		} finally {
			gate.release.resolve();
			storage.gate = undefined;
			await manager.recoverPersistenceFromCurrentState();
		}
	});
});
