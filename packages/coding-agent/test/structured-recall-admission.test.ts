import { afterEach, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentTool,
	type AgentToolResult,
} from "@oh-my-pi/pi-agent-core";
import { resolveBudgetReserveTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { Context, ImageContent, TextContent, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockHandler, MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	AgentSession,
	admitRecoveryToolResult,
	parseRecoveryEnvelope,
	READ_OMITTED_CONTENT_TOOL_NAME,
} from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	formatOmittedContentEnvelope,
	isOmittedContentEnvelopeBlock,
	OMITTED_CONTENT_META_PREFIX,
	OMITTED_CONTENT_META_SUFFIX,
	utf8ByteLength,
} from "@oh-my-pi/pi-coding-agent/session/omitted-content";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

/** Configured reserve; the runtime also enforces its proportional minimum. */
const RESERVE_TOKENS = 64;
const DEFAULT_CONTEXT_WINDOW = 8_000;
const READ_BYTE_WINDOW = 4_096;

const usageZero = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const PNG_IMAGE: ImageContent = { type: "image", data: "AAAA", mimeType: "image/png" };

/** A mock model that reports the image input capability the real catalog models carry. */
class ImageMockModel extends MockModel {
	override readonly input: ("text" | "image")[] = ["text", "image"];
}

interface FixtureOptions {
	contextWindow?: number;
	imageCapable?: boolean;
	orderedResultWriteback?: boolean;
	/** Explicit toolNames for createTools; undefined (and no restrictToolNames) = default set. */
	toolNames?: string[];
	restrictToolNames?: boolean;
	/** Absent `readOmittedContent` callbacks on the ToolSession (callback-free tool). */
	bindReadOmittedContent?: boolean;
	responses?: MockResponse[];
	handler?: MockHandler;
	extraTools?: AgentTool[];
}

interface Fixture {
	mock: MockModel;
	agent: Agent;
	session: AgentSession;
	sessionManager: SessionManager;
	modelRegistry: ModelRegistry;
	authStorage: AuthStorage;
	tools: AgentTool[];
	clear(): Promise<void>;
}

const fixtures: Fixture[] = [];

function userMessage(text: string): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1_752_000_000_000 };
}

function seedRecoveryTargets(
	manager: SessionManager,
	targets: Array<{ text?: string; image?: ImageContent }>,
): string[] {
	const ids: string[] = [];
	for (const [index, target] of targets.entries()) {
		const toolCallId = `call-seed-${index}`;
		manager.appendMessage(userMessage("Seed context."));
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "true" } }],
			api: "mock",
			provider: "mock",
			model: "mock-model",
			stopReason: "toolUse",
			usage: usageZero,
			timestamp: 1_752_000_000_100 + index,
		});
		ids.push(
			manager.appendMessage({
				role: "toolResult",
				toolCallId,
				toolName: "bash",
				content: [{ type: "text", text: "omitted placeholder" }],
				omittedOriginal: target.image ? [target.image] : [{ type: "text", text: target.text ?? "" }],
				isError: false,
				timestamp: 1_752_000_000_200 + index,
			}),
		);
	}
	return ids;
}

async function openFixture(options: FixtureOptions = {}): Promise<Fixture> {
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const sessionManager = SessionManager.inMemory();
	let session!: AgentSession;
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"compaction.reserveTokens": RESERVE_TOKENS,
		"modelOptimization.enabled": false,
	});
	const toolSession: ToolSession = {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => sessionManager.getSessionFile() ?? null,
		getSessionSpawns: () => null,
		settings,
		skipPythonPreflight: true,
		restrictToolNames: options.restrictToolNames ?? true,
		...(options.bindReadOmittedContent === false
			? {}
			: {
					readOmittedContent: {
						authorized: () => session.isRecoveryToolAuthorized(),
						entries: () => session.currentRecoveryEntries(),
						fits: (content: readonly (TextContent | ImageContent)[]) => session.fitsRecoveryResult(content),
					},
				}),
	};
	const tools = await createTools(toolSession, options.toolNames ?? [READ_OMITTED_CONTENT_TOOL_NAME]);
	if (options.extraTools) tools.push(...options.extraTools);
	for (const tool of tools) {
		if (tool.name === READ_OMITTED_CONTENT_TOOL_NAME) tool.concurrency = "shared";
	}
	const contextWindow = options.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
	const mock = options.imageCapable
		? new ImageMockModel({ contextWindow, maxTokens: 4_096, responses: options.responses, handler: options.handler })
		: createMockModel({ contextWindow, maxTokens: 4_096, responses: options.responses, handler: options.handler });
	const agent = new Agent({
		streamFn: mock.stream,
		initialState: { model: mock.model, systemPrompt: ["Test"], tools, messages: [] },
		toolScheduling: { maxConcurrentTools: 4, orderedResultWriteback: options.orderedResultWriteback },
	});
	session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
	agent.setToolScheduling({
		maxConcurrentTools: 4,
		orderedResultWriteback: options.orderedResultWriteback,
		resourceConflictMode: "permissive",
	});
	agent.replaceMessages(sessionManager.buildSessionContext().messages);
	const fixture: Fixture = {
		mock,
		agent,
		session,
		sessionManager,
		modelRegistry,
		authStorage,
		tools,
		async clear() {
			await session.dispose();
			authStorage.close();
		},
	};
	fixtures.push(fixture);
	return fixture;
}

function syncAgentTranscript(fixture: Fixture): void {
	fixture.agent.replaceMessages(fixture.sessionManager.buildSessionContext().messages);
}

/** Data text of a recall page: every content block except the visible cursor envelope. */
function pageData(result: AgentToolResult | ToolResultMessage): string {
	const content = result.content as readonly (TextContent | ImageContent)[];
	const last = content.at(-1);
	const data = content.length > 1 && last && isOmittedContentEnvelopeBlock(last) ? content.slice(0, -1) : content;
	return data
		.filter((block): block is TextContent => block.type === "text")
		.map(block => block.text)
		.join("");
}

function pageEnvelope(result: AgentToolResult | ToolResultMessage): TextContent {
	const last = result.content[result.content.length - 1];
	if (last.type !== "text" || !isOmittedContentEnvelopeBlock(last)) {
		throw new Error("expected a visible omitted-content envelope as the last block");
	}
	return last as TextContent;
}

function recallResultsIn(context: Context): ToolResultMessage[] {
	return context.messages.filter(
		(message): message is ToolResultMessage =>
			message.role === "toolResult" && message.toolName === READ_OMITTED_CONTENT_TOOL_NAME,
	);
}

function recallResultsInTranscript(fixture: Fixture): ToolResultMessage[] {
	return fixture.agent.state.messages.filter(
		(message): message is ToolResultMessage =>
			message.role === "toolResult" && message.toolName === READ_OMITTED_CONTENT_TOOL_NAME,
	);
}

function fitBudgetFor(contextWindow: number): number {
	return (
		contextWindow -
		resolveBudgetReserveTokens(contextWindow, { enabled: false, reserveTokens: RESERVE_TOKENS, keepRecentTokens: 0 })
	);
}

/** The live provider-context estimate the admission machinery anchors on. */
function anchoredTokens(fixture: Fixture, contextWindow: number): number {
	return fixture.session.getContextUsage({ contextWindow })?.tokens ?? 0;
}

/** Count the sent request, not the assistant response appended afterwards. */
function lastRequestTokens(fixture: Fixture, contextWindow: number): number {
	const tokenizer = fixture.agent.tokenizer;
	const request = fixture.mock.calls.at(-1);
	if (!request) throw new Error("Expected a provider request");
	return (
		anchoredTokens(fixture, contextWindow) -
		tokenizer.countMessages(fixture.agent.state.messages) +
		tokenizer.countMessages(request.context.messages)
	);
}

/**
 * Wrap the serialized final admission with one microtask before the real
 * bound callback so two concurrent recall admissions are in flight together —
 * the second one deterministically observes the first result already accepted
 * into the pending batch.
 */
function raceAdmissions(fixture: Fixture): void {
	const realAdmit = fixture.agent.admitToolResult;
	if (!realAdmit) throw new Error("expected the session to wire admitToolResult");
	fixture.agent.admitToolResult = async (admission, signal) => {
		await Promise.resolve();
		return realAdmit(admission, signal);
	};
}

/** Capture the EXECUTE-time result (pre-admission) of every recall page. */
function captureExecutePages(fixture: Fixture): Map<string, { data: string; hasImage: boolean }> {
	const captured = new Map<string, { data: string; hasImage: boolean }>();
	const realAfter = fixture.agent.afterToolCall;
	if (!realAfter) throw new Error("expected the session to wire afterToolCall");
	fixture.agent.afterToolCall = async (ctx, signal) => {
		if (ctx.toolCall.name === READ_OMITTED_CONTENT_TOOL_NAME) {
			captured.set(ctx.toolCall.id, {
				data: pageData(ctx.result),
				hasImage: ctx.result.content.some(block => block.type === "image"),
			});
		}
		return realAfter(ctx, signal);
	};
	return captured;
}

function readToolCall(id: string, entryId: string, extra: Record<string, unknown> = {}): MockResponse {
	return {
		content: [{ type: "toolCall", id, name: READ_OMITTED_CONTENT_TOOL_NAME, arguments: { id: entryId, ...extra } }],
	};
}

function doneResponse(): MockResponse {
	return { content: ["done"] };
}

/** A recovery page that is its own envelope-shaped original: only the LAST block is the cursor. */
const ENVELOPE_SHAPED = `${OMITTED_CONTENT_META_PREFIX}${JSON.stringify({ next: { block: 9, offset: 777 } })}${OMITTED_CONTENT_META_SUFFIX}`;
const ENVELOPE_EOF_SHAPED = `${OMITTED_CONTENT_META_PREFIX}${JSON.stringify({ next: null })}${OMITTED_CONTENT_META_SUFFIX}`;
const WHITESPACE_TEXT = "\n\t  \u00a0\u2003  \n\r\n";
const UNICODE_FRAGMENT = "𝔘𝔫𝔦𝔠𝔬𝔡𝔢 代码 🎉";

afterEach(async () => {
	for (const fixture of fixtures.splice(0)) {
		await fixture.clear();
	}
});

describe("read_omitted_content final admission", () => {
	it("ordered writeback: two concurrent text pages that each fit alone shorten the later page to fit the shared request", async () => {
		const contextWindow = DEFAULT_CONTEXT_WINDOW;
		const fixture = await openFixture({ contextWindow, orderedResultWriteback: true });
		const used = anchoredTokens(fixture, contextWindow);
		const remaining = fitBudgetFor(contextWindow) - used;
		expect(remaining).toBeGreaterThan(4_000);
		// Each page ≈ 0.6 × remaining tokens; two pages ≈ 1.2 × remaining → each
		// alone fits, the pair cannot.
		const maxBytes = Math.floor(4 * (0.6 * remaining - 300));
		expect(maxBytes).toBeGreaterThan(0);
		const textA = "A".repeat(maxBytes + 512);
		const textB = "B".repeat(maxBytes + 512);
		const [idA, idB] = seedRecoveryTargets(fixture.sessionManager, [{ text: textA }, { text: textB }]);
		syncAgentTranscript(fixture);
		raceAdmissions(fixture);
		const executePages = captureExecutePages(fixture);
		fixture.mock.push({
			content: [
				{ type: "toolCall", id: "call-a", name: READ_OMITTED_CONTENT_TOOL_NAME, arguments: { id: idA, maxBytes } },
				{ type: "toolCall", id: "call-b", name: READ_OMITTED_CONTENT_TOOL_NAME, arguments: { id: idB, maxBytes } },
			],
		});
		fixture.mock.push(doneResponse());

		await fixture.agent.prompt("recover");

		// The race wrapper adds a microtask; the final provider request is still
		// the one carrying both admitted pages (call 0) then the plain "done" turn.
		expect(fixture.mock.calls.length).toBe(2);
		const results = recallResultsIn(fixture.mock.calls[1].context);
		expect(results.map(result => result.toolCallId)).toEqual(["call-a", "call-b"]);

		// Page A (head-of-line) shipped at full execute size; page B was shortened
		// by the final admission because the pair no longer fit together.
		const executeA = executePages.get("call-a");
		const executeB = executePages.get("call-b");
		expect(executeA).toBeDefined();
		expect(executeB).toBeDefined();
		expect(utf8ByteLength(executeA!.data)).toBe(maxBytes);
		expect(utf8ByteLength(executeB!.data)).toBe(maxBytes);
		const finalA = pageData(results[0]!);
		const finalB = pageData(results[1]!);
		expect(finalA).toBe(textA.slice(0, maxBytes));
		expect(utf8ByteLength(finalB)).toBeGreaterThan(0);
		expect(utf8ByteLength(finalB)).toBeLessThan(maxBytes);
		expect(textB.startsWith(finalB)).toBe(true);

		// Each page's envelope advances by exactly the bytes actually delivered.
		const envelopeB = pageEnvelope(results[1]!);
		const parsedB = parseRecoveryEnvelope(results[1]!.content);
		expect(parsedB).toEqual({ block: 0, offset: utf8ByteLength(finalB) });
		expect(envelopeB.text).toBe(
			`${OMITTED_CONTENT_META_PREFIX}${JSON.stringify({ next: parsedB })}${OMITTED_CONTENT_META_SUFFIX}`,
		);
		expect(parseRecoveryEnvelope(results[0]!.content)).toEqual({ block: 0, offset: utf8ByteLength(finalA) });

		// The final provider request stayed within the model's window.
		expect(lastRequestTokens(fixture, contextWindow)).toBeLessThanOrEqual(fitBudgetFor(contextWindow));
		for (const message of fixture.mock.calls[1].context.messages) {
			for (const block of Array.isArray(message.content) ? message.content : []) {
				expect(block).not.toMatchObject({ type: "image" });
			}
		}
	});

	it("unordered writeback: the later-admitted concurrent page is shortened; execute size is captured before admission shrinks it", async () => {
		const contextWindow = DEFAULT_CONTEXT_WINDOW;
		const fixture = await openFixture({ contextWindow, orderedResultWriteback: false });
		const used = anchoredTokens(fixture, contextWindow);
		const remaining = fitBudgetFor(contextWindow) - used;
		expect(remaining).toBeGreaterThan(4_000);
		const maxBytes = Math.floor(4 * (0.6 * remaining - 300));
		const textA = "a".repeat(maxBytes + 512);
		const textB = "b".repeat(maxBytes + 512);
		const [idA, idB] = seedRecoveryTargets(fixture.sessionManager, [{ text: textA }, { text: textB }]);
		syncAgentTranscript(fixture);
		raceAdmissions(fixture);
		const executePages = captureExecutePages(fixture);
		fixture.mock.push({
			content: [
				{ type: "toolCall", id: "call-a", name: READ_OMITTED_CONTENT_TOOL_NAME, arguments: { id: idA, maxBytes } },
				{ type: "toolCall", id: "call-b", name: READ_OMITTED_CONTENT_TOOL_NAME, arguments: { id: idB, maxBytes } },
			],
		});
		fixture.mock.push(doneResponse());

		await fixture.agent.prompt("recover");

		expect(fixture.mock.calls.length).toBe(2);
		const results = recallResultsIn(fixture.mock.calls[1].context);
		expect(results.length).toBe(2);
		// Both pages executed at full size...
		expect(utf8ByteLength(executePages.get("call-a")!.data)).toBe(maxBytes);
		expect(utf8ByteLength(executePages.get("call-b")!.data)).toBe(maxBytes);
		// ...but exactly one shipped at full size; the later-admitted one was
		// shortened by the serialized final admission.
		const finalPages = Object.fromEntries(
			results.map(result => [result.toolCallId, pageData(result)] as const),
		) as Record<string, string>;
		const fullIds: string[] = [];
		const shortIds: string[] = [];
		for (const id of ["call-a", "call-b"]) {
			if (utf8ByteLength(finalPages[id]!) === maxBytes) fullIds.push(id);
			else shortIds.push(id);
		}
		expect(fullIds.length).toBe(1);
		expect(shortIds.length).toBe(1);
		const shortText = finalPages[shortIds[0]!]!;
		expect(utf8ByteLength(shortText)).toBeGreaterThan(0);
		const shortOriginal = shortIds[0] === "call-a" ? textA : textB;
		expect(shortOriginal.startsWith(shortText)).toBe(true);
		// The shortened page's cursor registers the delivered bytes exactly.
		const shortResult = results.find(result => result.toolCallId === shortIds[0])!;
		expect(parseRecoveryEnvelope(shortResult.content)).toEqual({ block: 0, offset: utf8ByteLength(shortText) });
		expect(lastRequestTokens(fixture, contextWindow)).toBeLessThanOrEqual(fitBudgetFor(contextWindow));
	});

	it("denies a page that only fails together with an accepted text page: image stays at its undelivered position", async () => {
		const contextWindow = DEFAULT_CONTEXT_WINDOW;
		const fixture = await openFixture({ contextWindow, imageCapable: true, orderedResultWriteback: true });
		const used = anchoredTokens(fixture, contextWindow);
		const remaining = fitBudgetFor(contextWindow) - used;
		expect(remaining).toBeGreaterThan(4_000);
		// The text page must fit alone but, together with the image page's fixed
		// ~1200-token charge, bust the same request.
		const maxBytes = Math.floor(4 * (remaining - 420));
		expect(maxBytes).toBeGreaterThan(0);
		expect(maxBytes).toBeLessThanOrEqual(32_768);
		const text = "T".repeat(maxBytes + 512);
		const [textId, imageId] = seedRecoveryTargets(fixture.sessionManager, [{ text }, { image: PNG_IMAGE }]);
		syncAgentTranscript(fixture);
		raceAdmissions(fixture);
		const executePages = captureExecutePages(fixture);
		fixture.mock.push({
			content: [
				{
					type: "toolCall",
					id: "call-text",
					name: READ_OMITTED_CONTENT_TOOL_NAME,
					arguments: { id: textId, maxBytes },
				},
				{
					type: "toolCall",
					id: "call-image",
					name: READ_OMITTED_CONTENT_TOOL_NAME,
					arguments: { id: imageId, image: true },
				},
			],
		});
		fixture.mock.push(doneResponse());

		await fixture.agent.prompt("recover");

		expect(fixture.mock.calls.length).toBe(2);
		const results = recallResultsIn(fixture.mock.calls[1].context);
		expect(results.map(result => result.toolCallId)).toEqual(["call-text", "call-image"]);

		// The image page executed as a REAL image page...
		const executeImage = executePages.get("call-image")!;
		expect(executeImage.hasImage).toBe(true);
		expect(executePages.get("call-text")!.data).toBe(text.slice(0, maxBytes));

		// ...but the serialized final admission denied it: bounded description at
		// the SAME undelivered position, no image bytes in the next request.
		const imageResult = results[1]!;
		expect(imageResult.content.some(block => block.type === "image")).toBe(false);
		const imageText = pageData(imageResult);
		expect(imageText).toContain("image omitted");
		expect(imageText).toContain("image/png");
		expect(parseRecoveryEnvelope(imageResult.content)).toEqual({ block: 0, offset: 0 });
		for (const message of fixture.mock.calls[1].context.messages) {
			for (const block of Array.isArray(message.content) ? message.content : []) {
				expect(block).not.toMatchObject({ type: "image" });
			}
		}
		// The denied page is reflected in the persisted transcript as kind "description".
		const transcriptImage = recallResultsInTranscript(fixture).find(result => result.toolCallId === "call-image")!;
		expect(transcriptImage.details).toMatchObject({
			recall: { kind: "description", block: 0, offset: 0, eof: false },
		});
		expect(lastRequestTokens(fixture, contextWindow)).toBeLessThanOrEqual(fitBudgetFor(contextWindow));
	});

	it("reassembles a full Unicode/whitespace/envelope-shaped original by following only the visible last envelope across pages", async () => {
		const contextWindow = 60_000;
		let handler: (context: Context) => MockResponse;
		const fixture = await openFixture({ contextWindow, handler: context => handler(context) });
		const original = [
			ENVELOPE_SHAPED,
			WHITESPACE_TEXT,
			UNICODE_FRAGMENT.repeat(500),
			ENVELOPE_EOF_SHAPED,
			"\ntail\r\n",
		].join("");
		expect(utf8ByteLength(original)).toBeGreaterThan(2 * READ_BYTE_WINDOW);
		const [id] = seedRecoveryTargets(fixture.sessionManager, [{ text: original }]);
		syncAgentTranscript(fixture);

		let calls = 0;
		handler = context => {
			calls++;
			const previous = [...context.messages]
				.reverse()
				.find(
					(message): message is ToolResultMessage =>
						message.role === "toolResult" && message.toolName === READ_OMITTED_CONTENT_TOOL_NAME,
				);
			if (!previous) {
				return {
					content: [
						{
							type: "toolCall",
							id: "call-uo-1",
							name: READ_OMITTED_CONTENT_TOOL_NAME,
							arguments: { id, maxBytes: READ_BYTE_WINDOW },
						},
					],
				};
			}
			const next = parseRecoveryEnvelope(previous.content);
			if (next === "eof") return doneResponse();
			if (next === undefined || calls > 100) {
				throw new Error("unexpected recovery cursor state");
			}
			return {
				content: [
					{
						type: "toolCall",
						id: `call-uo-${calls}`,
						name: READ_OMITTED_CONTENT_TOOL_NAME,
						arguments: { id, block: next.block, offset: next.offset, maxBytes: READ_BYTE_WINDOW },
					},
				],
			};
		};

		await fixture.agent.prompt("recover");

		const delivered = recallResultsInTranscript(fixture);
		expect(delivered.length).toBeGreaterThanOrEqual(4);
		const pieces = delivered.map(result => pageData(result));
		// Every visible envelope is a real `<omitted_content_meta>` block as the LAST block.
		for (const result of delivered) pageEnvelope(result);
		const joined = pieces.join("");
		let difference = 0;
		while (difference < Math.min(joined.length, original.length) && joined[difference] === original[difference])
			difference++;
		expect(
			joined === original,
			JSON.stringify({
				difference,
				actualLength: joined.length,
				expectedLength: original.length,
				actual: Array.from(joined.slice(difference, difference + 20)).map(char => char.codePointAt(0)),
				expected: Array.from(original.slice(difference, difference + 20)).map(char => char.codePointAt(0)),
			}),
		).toBe(true);
		expect(pieces.join("")).toContain(ENVELOPE_SHAPED);
		expect(pieces.join("")).toContain(WHITESPACE_TEXT);
		// Byte-transparency of the reassembly: delivered bytes sum to the original.
		expect(pieces.reduce((sum, piece) => sum + utf8ByteLength(piece), 0)).toBe(utf8ByteLength(original));
		expect(lastRequestTokens(fixture, contextWindow)).toBeLessThanOrEqual(fitBudgetFor(contextWindow));
	});
});

describe("read_omitted_content capability guards", () => {
	it("a text-only model never ships image bytes: the page degrades to a bounded description at the same position", async () => {
		const contextWindow = DEFAULT_CONTEXT_WINDOW;
		const fixture = await openFixture({ contextWindow });
		expect(fixture.mock.model.input).toEqual(["text"]);
		const [imageId] = seedRecoveryTargets(fixture.sessionManager, [{ image: PNG_IMAGE }]);
		syncAgentTranscript(fixture);
		fixture.mock.push(readToolCall("call-img", imageId, { image: true }));
		fixture.mock.push(doneResponse());

		await fixture.agent.prompt("recover");

		expect(fixture.mock.calls.length).toBe(2);
		const results = recallResultsIn(fixture.mock.calls[1].context);
		expect(results.length).toBe(1);
		const imageText = pageData(results[0]!);
		expect(imageText).toContain("Omitted image block 0");
		expect(imageText).toContain("image/png");
		expect(parseRecoveryEnvelope(results[0]!.content)).toEqual({ block: 0, offset: 0 });
		for (const message of fixture.mock.calls[1].context.messages) {
			for (const block of Array.isArray(message.content) ? message.content : []) {
				expect(block).not.toMatchObject({ type: "image" });
			}
		}
		const transcript = recallResultsInTranscript(fixture)[0]!;
		expect(transcript.details).toMatchObject({ recall: { kind: "description", offset: 0, eof: false } });
	});

	it("dynamically revoked tool refuses recall mid-run: permission error, no original data surfaces", async () => {
		const fixture = await openFixture({ contextWindow: DEFAULT_CONTEXT_WINDOW });
		const secret = `SECRET-${"x".repeat(1_000)}`;
		const [id] = seedRecoveryTargets(fixture.sessionManager, [{ text: secret }]);
		syncAgentTranscript(fixture);
		const off = fixture.agent.subscribe(event => {
			if (event.type === "tool_execution_start" && event.toolCallId === "call-revoke") {
				// Revocation can arrive after a synchronous tool body has completed;
				// final admission must also consult the live permission set.
				fixture.agent.state.tools = fixture.agent.state.tools.filter(
					tool => tool.name !== READ_OMITTED_CONTENT_TOOL_NAME,
				);
			}
		});
		try {
			fixture.mock.push({
				content: [{ type: "toolCall", id: "call-revoke", name: READ_OMITTED_CONTENT_TOOL_NAME, arguments: { id } }],
			});
			fixture.mock.push(doneResponse());

			await fixture.agent.prompt("recover");

			expect(fixture.mock.calls.length).toBe(2);
			expect(fixture.session.isRecoveryToolAuthorized()).toBe(false);
			const results = recallResultsIn(fixture.mock.calls[1].context);
			expect(results.length).toBe(1);
			expect(results[0]!.isError).toBe(true);
			expect(pageData(results[0]!)).toContain("not authorized in the current tool set");
			const requestText = JSON.stringify(fixture.mock.calls[1].context.messages);
			expect(requestText).not.toContain(secret);
		} finally {
			off();
		}
	});

	it("an entry id from another branch is never readable: error result, no cross-branch leak", async () => {
		const fixture = await openFixture({ contextWindow: DEFAULT_CONTEXT_WINDOW });
		const branchSecret = `BRANCH-${"y".repeat(500)}`;
		const sideSecret = `SIDE-${"z".repeat(500)}`;
		const [branchId] = seedRecoveryTargets(fixture.sessionManager, [{ text: branchSecret }]);
		// A side child under the FIRST seeded message: exists in the store but is
		// not on the current leaf path — the recall tool must refuse it.
		const root = fixture.sessionManager.getBranch()[0]!;
		const sideId = fixture.sessionManager.appendMessageToBranch(
			{
				role: "toolResult",
				toolCallId: "call-side",
				toolName: "bash",
				content: [{ type: "text", text: "omitted placeholder" }],
				omittedOriginal: [{ type: "text", text: sideSecret }],
				isError: false,
				timestamp: 1_752_000_000_300,
			},
			root.id,
		);
		expect(sideId).not.toBe(branchId);
		syncAgentTranscript(fixture);
		fixture.mock.push(readToolCall("call-side-read", sideId));
		fixture.mock.push(doneResponse());

		await fixture.agent.prompt("recover");

		expect(fixture.mock.calls.length).toBe(2);
		const results = recallResultsIn(fixture.mock.calls[1].context);
		expect(results.length).toBe(1);
		expect(results[0]!.isError).toBe(true);
		expect(pageData(results[0]!)).toContain("entry is not on the current branch");
		const requestText = JSON.stringify(fixture.mock.calls[1].context.messages);
		expect(requestText).not.toContain(sideSecret);
	});

	it("createTools binding: no callbacks makes the tool unavailable; bound default set and explicit subsets construct it", async () => {
		const settings = Settings.isolated({});

		// Callback-free ToolSession: the factory returns null, so even an explicit
		// request never materializes the tool.
		const bareSession: ToolSession = {
			cwd: process.cwd(),
			hasUI: false,
			settings,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			skipPythonPreflight: true,
		};
		const bareTools = await createTools(bareSession, ["read_omitted_content"]);
		expect(bareTools.some(tool => tool.name === READ_OMITTED_CONTENT_TOOL_NAME)).toBe(false);

		const boundCallbacks = {
			authorized: () => true,
			entries: () => [],
			fits: () => true,
		};
		const boundSession: ToolSession = {
			cwd: process.cwd(),
			hasUI: false,
			settings,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			skipPythonPreflight: true,
			readOmittedContent: boundCallbacks,
		};
		// Bound default set: the tool is part of the built-in default surface.
		const defaultTools = await createTools(boundSession);
		expect(defaultTools.some(tool => tool.name === READ_OMITTED_CONTENT_TOOL_NAME)).toBe(true);
		// Bound explicit subset naming it: constructed.
		const subsetTools = await createTools({ ...boundSession, restrictToolNames: true }, ["read_omitted_content"]);
		expect(subsetTools.map(tool => tool.name)).toEqual(["read_omitted_content"]);
		// Bound explicit subset NOT naming it: absent.
		const emptyTools = await createTools({ ...boundSession, restrictToolNames: true }, []);
		expect(emptyTools.length).toBe(0);

		// And the callback-free surface really refuses recall on the wire.
		const fixture = await openFixture({
			contextWindow: DEFAULT_CONTEXT_WINDOW,
			bindReadOmittedContent: false,
			toolNames: ["read_omitted_content"],
			restrictToolNames: true,
		});
		expect(fixture.session.isRecoveryToolAuthorized()).toBe(false);
		const [id] = seedRecoveryTargets(fixture.sessionManager, [{ text: "never-readable" }]);
		syncAgentTranscript(fixture);
		fixture.mock.push(readToolCall("call-ghost", id));
		fixture.mock.push(doneResponse());
		await fixture.agent.prompt("recover");
		expect(fixture.mock.calls.length).toBe(2);
		const results = recallResultsIn(fixture.mock.calls[1].context);
		expect(results.length).toBe(1);
		expect(results[0]!.isError).toBe(true);
		expect(pageData(results[0]!)).toContain("not authorized in the current tool set");
		expect(JSON.stringify(fixture.mock.calls[1].context.messages)).not.toContain("never-readable");
	});
});

describe("read_omitted_content budget-stop terminal admission", () => {
	it("stops before the next provider request when even the envelope cannot fit, preserving queues and real same-batch results", async () => {
		const contextWindow = DEFAULT_CONTEXT_WINDOW;
		const bigWorkOutput = "W".repeat(40_000);
		const workSchema = type({ value: type("string") });
		const workTool: AgentTool<typeof workSchema, { value: string }> = {
			name: "test_work",
			label: "Test work",
			description: "Test work tool",
			parameters: workSchema,
			concurrency: "shared",
			async execute(_id, params) {
				await Bun.sleep(40);
				return { content: [{ type: "text", text: bigWorkOutput }], details: { value: params.value } };
			},
		};
		const fixture = await openFixture({
			contextWindow,
			orderedResultWriteback: true,
			toolNames: ["read_omitted_content"],
			restrictToolNames: true,
			extraTools: [workTool],
		});
		const [id] = seedRecoveryTargets(fixture.sessionManager, [{ text: "R".repeat(9_000) }]);
		syncAgentTranscript(fixture);
		raceAdmissions(fixture);
		// Queue steering + follow-up AFTER the first provider request is in flight
		// (inside the recall final admission): the terminal stop must neither
		// consume them nor dispatch a request carrying them.
		const realAdmit = fixture.agent.admitToolResult;
		if (!realAdmit) throw new Error("expected the session to wire admitToolResult");
		const steerText = "steer-queue-marker-1";
		const followText = "followup-queue-marker-2";
		fixture.agent.admitToolResult = async (admission, signal) => {
			if (admission.toolCall.name === READ_OMITTED_CONTENT_TOOL_NAME) {
				fixture.agent.steer({ role: "user", content: [{ type: "text", text: steerText }], timestamp: Date.now() });
				fixture.agent.followUp({
					role: "user",
					content: [{ type: "text", text: followText }],
					timestamp: Date.now(),
				});
			}
			return realAdmit(admission, signal);
		};
		const events: AgentEvent[] = [];
		const off = fixture.agent.subscribe(event => events.push(event));
		try {
			fixture.mock.push({
				content: [
					{ type: "toolCall", id: "call-work", name: "test_work", arguments: { value: "go" } },
					{
						type: "toolCall",
						id: "call-recall",
						name: READ_OMITTED_CONTENT_TOOL_NAME,
						arguments: { id, maxBytes: 8192 },
					},
				],
			});
			fixture.mock.push(doneResponse());

			await fixture.agent.prompt("recover");

			// Only the initial provider request; the terminal admission suppressed everything after it.
			expect(fixture.mock.calls.length).toBe(1);
			// The big ordinary result really executed and stayed in the transcript.
			const workResult = fixture.agent.state.messages.find(
				(message): message is ToolResultMessage =>
					message.role === "toolResult" && message.toolName === "test_work",
			);
			expect(workResult).toBeDefined();
			expect(workResult!.isError).toBe(false);
			expect(pageData(workResult!)).toBe(bigWorkOutput);
			// The un-fit recall record got the truthful budget-stop receipt.
			const recallResult = fixture.agent.state.messages.find(
				(message): message is ToolResultMessage =>
					message.role === "toolResult" && message.toolName === READ_OMITTED_CONTENT_TOOL_NAME,
			);
			expect(recallResult).toBeDefined();
			expect(recallResult!.isError).toBe(true);
			expect(pageData(recallResult!)).toContain("Tool result withheld");
			expect(recallResult!.details).toMatchObject({ __admissionBudgetStop: true });
			// Original data never reached the wire.
			expect(JSON.stringify(fixture.mock.calls[0].context.messages)).not.toContain("R".repeat(64));

			// Steering + follow-up were queued mid-run and never consumed: they are
			// absent from every provider context and still queued afterwards.
			expect(fixture.agent.hasQueuedMessages()).toBe(true);
			for (const call of fixture.mock.calls) {
				expect(JSON.stringify(call.context.messages)).not.toContain(steerText);
				expect(JSON.stringify(call.context.messages)).not.toContain(followText);
			}
			expect(JSON.stringify(fixture.agent.state.messages)).not.toContain(steerText);
			expect(JSON.stringify(fixture.agent.state.messages)).not.toContain(followText);

			// Every tool record is settled with exactly one truthful end event.
			const ends = events.filter(event => event.type === "tool_execution_end");
			expect(ends.map(event => (event as { toolCallId: string }).toolCallId).sort()).toEqual([
				"call-recall",
				"call-work",
			]);
			const workEnd = ends.find(event => (event as { toolCallId: string }).toolCallId === "call-work") as Extract<
				AgentEvent,
				{ type: "tool_execution_end" }
			>;
			expect(workEnd.isError).toBe(false);
			expect(pageData(workEnd.result)).toBe(bigWorkOutput);
			const recallEnd = ends.find(
				event => (event as { toolCallId: string }).toolCallId === "call-recall",
			) as Extract<AgentEvent, { type: "tool_execution_end" }>;
			expect(recallEnd.isError).toBe(true);
			expect(pageData(recallEnd.result)).toContain("Tool result withheld");
			// The receipt end event never claims the tool did not execute; its wording
			// is a withheld-delivery notice, and the worked tool kept its real result.
			expect(pageData(recallEnd.result)).not.toContain("not executed");
			expect(pageData(recallEnd.result)).not.toContain("skipped");

			// Both toolResult messages (real + receipt) hit message_end.
			const toolResultEnds = events.filter(
				event => event.type === "message_end" && (event as { message: AgentMessage }).message.role === "toolResult",
			);
			expect(toolResultEnds.length).toBe(2);
			// All started tool calls are closed out of the pending set.
			expect(fixture.agent.state.pendingToolCalls.size).toBe(0);
		} finally {
			off();
		}
	});
});

it("advances over a leading four-byte code point when a shorter Unicode page fits", () => {
	const result: AgentToolResult = {
		content: [
			{ type: "text", text: "😀ab" },
			{ type: "text", text: formatOmittedContentEnvelope(null) },
		],
		details: { recall: { kind: "text", block: 0, offset: 0, originalBytes: 6, eof: true } },
	};
	const admitted = admitRecoveryToolResult(
		result,
		content => ({
			tokens: content[0]?.type === "text" ? utf8ByteLength(content[0].text) : 0,
			images: 0,
		}),
		{ remainingTokens: 4, remainingImages: 0 },
	);
	if (!admitted || typeof admitted === "symbol") throw new Error("Expected a shortened page");
	expect(admitted.content[0]).toEqual({ type: "text", text: "😀" });
	expect(parseRecoveryEnvelope(admitted.content)).toEqual({ block: 0, offset: 4 });
});
