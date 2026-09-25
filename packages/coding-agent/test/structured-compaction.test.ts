import { describe, expect, type Mock, test, vi } from "bun:test";
import { type AgentMessage, Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { SessionEntry, SessionMessageEntry } from "@oh-my-pi/pi-agent-core/compaction";
import { DEFAULT_PRUNE_CONFIG, type PruneConfig, pruneToolOutputs } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, ImageContent, TextContent, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createOpenAIResponsesHistoryPayload } from "@oh-my-pi/pi-ai/utils";
import {
	ASSISTANT_SUMMARY_PREFIX,
	type AssistantSummaryInput,
	type AssistantSummaryOutput,
	parseAssistantSummaries,
	prepareStructuredCompaction,
	type StructuredCompactionPatch,
	type StructuredCompactionRequest,
	type SummarizeAssistantEntries,
} from "@oh-my-pi/pi-coding-agent/session/structured-compaction";

const tokenizer = new Tokenizer();

let idCounter = 0;
function nextId(): string {
	return `entry-${idCounter++}`;
}

function messageEntry(message: AgentMessage, timestamp: number): SessionMessageEntry {
	return { type: "message", id: nextId(), parentId: null, timestamp: new Date(timestamp).toISOString(), message };
}

function assistantMessage(
	content: AssistantMessage["content"],
	timestamp: number,
	extra: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		timestamp,
		provider: "mock",
		model: "mock",
		api: "mock",
		usage: {
			input: 1,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		...extra,
	};
}

function toolResultMessage(toolName: string, toolCallId: string, text: string, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
	};
}

function toolCall(id: string, name: string, args: Record<string, unknown>): AssistantMessage["content"][number] {
	return { type: "toolCall", id, name, arguments: args };
}

function compactionEntry(firstKeptEntryId: string, timestamp: number): SessionEntry {
	return {
		type: "compaction",
		id: nextId(),
		parentId: null,
		timestamp: new Date(timestamp).toISOString(),
		summary: "compacted",
		firstKeptEntryId,
		tokensBefore: 0,
	};
}

function visibleTokens(entries: readonly SessionEntry[]): number {
	let total = 0;
	for (const entry of entries) {
		if (entry.type === "message") total += tokenizer.countMessage(entry.message);
	}
	return total;
}

function structuredConfig(over: Partial<PruneConfig> = {}): PruneConfig {
	// Structured callers pass no supersedeKey / cacheWarmSuffixTokens; addressable
	// omission is forced on by prepare regardless.
	return {
		...DEFAULT_PRUNE_CONFIG,
		addressable: true,
		protectTokens: 0,
		minimumSavings: 0,
		protectedTools: [],
		...over,
	};
}

function makeRequest(
	entries: readonly SessionEntry[],
	over: {
		targetTokens?: number;
		currentTokens?: number;
		summarize?: SummarizeAssistantEntries;
		config?: PruneConfig;
		signal?: AbortSignal;
	} = {},
): {
	request: StructuredCompactionRequest;
	summarize: Mock<SummarizeAssistantEntries>;
	entries: readonly SessionEntry[];
} {
	const currentTokens = over.currentTokens ?? visibleTokens(entries);
	const summarize = vi.fn<SummarizeAssistantEntries>(over.summarize ?? (async () => []));
	return {
		entries,
		summarize,
		request: {
			entries,
			tokenizer,
			pruneConfig: over.config ?? structuredConfig(),
			targetTokens: over.targetTokens ?? currentTokens,
			currentTokens,
			signal: over.signal ?? new AbortController().signal,
			summarize,
		},
	};
}

function entryById(entries: readonly SessionEntry[], id: string): SessionMessageEntry {
	return entries.find(entry => entry.id === id) as SessionMessageEntry;
}

function asPatch(patch: StructuredCompactionPatch | undefined): StructuredCompactionPatch {
	expect(patch).toBeDefined();
	return patch!;
}

const T0 = Date.UTC(2026, 5, 10, 12, 0, 0);
// Suffix must clear the fixed 40k-token assistant protect window: ≈200k UTF-8 bytes ≈ 50k tokens.
const BIG_TAIL = "T".repeat(200_000);
// Assistant texts large enough that summarizing them yields real gain.
const DEEP_TEXT = "A".repeat(120_000); // ≈ 30k tokens
const MEDIUM_RESULT = "m".repeat(3_000);

describe("parseAssistantSummaries", () => {
	const requested: AssistantSummaryInput[] = [
		{ id: "e1", text: "old" },
		{ id: "e2", text: "older" },
	];

	function body(summaries: unknown): string {
		return JSON.stringify({ summaries });
	}

	test("accepts the exact protocol and returns outputs in requested order", () => {
		const response = body([
			{ id: "e2", text: "B" },
			{ id: "e1", text: "A" },
		]);
		const outputs = parseAssistantSummaries(response, requested, tokenizer, 1024);
		expect(outputs).toEqual([
			{ id: "e1", text: "A" },
			{ id: "e2", text: "B" },
		]);
	});

	test("accepts an empty summaries array for an empty request", () => {
		const outputs = parseAssistantSummaries(JSON.stringify({ summaries: [] }), [], tokenizer, 1024);
		expect(outputs).toEqual([]);
	});

	for (const [name, response] of [
		["non-JSON", "{not json"],
		["top-level array", "[]"],
		["top-level string", '"x"'],
		["top-level null", "null"],
	] as const) {
		test(`rejects ${name}`, () => {
			expect(() => parseAssistantSummaries(response, requested, tokenizer, 1024)).toThrow();
		});
	}

	test("rejects a top level with extra fields", () => {
		expect(() =>
			parseAssistantSummaries(JSON.stringify({ summaries: [], extra: 1 }), requested, tokenizer, 1024),
		).toThrow();
	});

	test("rejects a missing top-level field", () => {
		expect(() => parseAssistantSummaries(JSON.stringify({}), requested, tokenizer, 1024)).toThrow();
	});

	test("rejects summaries that is not an array", () => {
		expect(() => parseAssistantSummaries(JSON.stringify({ summaries: "x" }), requested, tokenizer, 1024)).toThrow();
	});

	test("rejects summary entries with extra fields", () => {
		expect(() =>
			parseAssistantSummaries(body([{ id: "e1", text: "A", extra: true }]), requested, tokenizer, 1024),
		).toThrow();
	});

	test("rejects summary entries missing id or text", () => {
		expect(() => parseAssistantSummaries(body([{ id: "e1" }]), requested, tokenizer, 1024)).toThrow();
		expect(() => parseAssistantSummaries(body([{ text: "A" }]), requested, tokenizer, 1024)).toThrow();
	});

	test("rejects unknown ids", () => {
		expect(() => parseAssistantSummaries(body([{ id: "ghost", text: "A" }]), requested, tokenizer, 1024)).toThrow();
	});

	test("rejects duplicate ids", () => {
		expect(() =>
			parseAssistantSummaries(
				body([
					{ id: "e1", text: "A" },
					{ id: "e1", text: "B" },
				]),
				requested,
				tokenizer,
				1024,
			),
		).toThrow();
	});

	test("rejects missing requested ids", () => {
		expect(() => parseAssistantSummaries(body([{ id: "e1", text: "A" }]), requested, tokenizer, 1024)).toThrow();
	});

	test("rejects empty and whitespace-only text", () => {
		expect(() => parseAssistantSummaries(body([{ id: "e1", text: "" }]), [requested[0]], tokenizer, 1024)).toThrow();
		expect(() =>
			parseAssistantSummaries(body([{ id: "e1", text: "   " }]), [requested[0]], tokenizer, 1024),
		).toThrow();
	});

	test("rejects a summary over the per-entry 512-token cap", () => {
		const tooBig = "z".repeat(2_200); // ≈ 550 tokens
		expect(() =>
			parseAssistantSummaries(body([{ id: "e1", text: tooBig }]), [requested[0]], tokenizer, 1024),
		).toThrow();
	});

	test("the aggregate cap counts the whole JSON envelope, not just the text", () => {
		const text = "w".repeat(1_000); // ≈ 250 tokens
		const response = body([{ id: "e1", text }]);
		const textTokens = tokenizer.countTokens(text);
		const envelopeTokens = tokenizer.countTokens(response);
		expect(textTokens).toBeLessThan(envelopeTokens);

		// Cap just below the text size: text alone fits, the envelope does not → throw.
		expect(() => parseAssistantSummaries(response, [requested[0]], tokenizer, textTokens)).toThrow();
		// Cap at the exact envelope size → passes.
		const outputs = parseAssistantSummaries(response, [requested[0]], tokenizer, envelopeTokens);
		expect(outputs).toEqual([{ id: "e1", text }]);
	});
});

describe("prepareStructuredCompaction — no effective omission / already fits", () => {
	test("currentTokens <= targetTokens with no effective omission returns undefined and never calls the model", async () => {
		const [call, result] = [
			messageEntry(assistantMessage([toolCall("c-tail", "tail", {})], T0), T0),
			messageEntry(toolResultMessage("tail", "c-tail", BIG_TAIL, T0), T0),
		];
		const currentTokens = visibleTokens([call, result]);
		const summarize = vi.fn(async (_: readonly AssistantSummaryInput[]) => {
			throw new Error("summarize must not be called when no omission is needed");
		});
		const { request } = makeRequest([call, result], {
			config: structuredConfig({ protectTokens: 10_000_000 }), // everything protected
			currentTokens,
			targetTokens: currentTokens + 500,
			summarize: summarize as Parameters<typeof prepareStructuredCompaction>[0]["summarize"],
		});

		const patch = await prepareStructuredCompaction(request);
		expect(patch).toBeUndefined();
		expect(summarize).not.toHaveBeenCalled();
	});

	test("an already-fitting empty branch returns undefined without calling the model", async () => {
		const summarize = vi.fn(async (_: readonly AssistantSummaryInput[]) => {
			throw new Error("summarize must not be called");
		});
		const { request } = makeRequest([], {
			currentTokens: 0,
			targetTokens: 0,
			summarize: summarize as Parameters<typeof prepareStructuredCompaction>[0]["summarize"],
		});
		const patch = await prepareStructuredCompaction(request);
		expect(patch).toBeUndefined();
		expect(summarize).not.toHaveBeenCalled();
	});
});

describe("prepareStructuredCompaction — prune-only path", () => {
	function bigBranch(): SessionEntry[] {
		return [
			messageEntry(assistantMessage([toolCall("c1", "read", { path: "src/a.ts" })], T0), T0),
			messageEntry(toolResultMessage("read", "c1", "x".repeat(150_000), T0), T0),
			messageEntry(assistantMessage([toolCall("c2", "grep", { pattern: "foo" })], T0), T0),
			messageEntry(toolResultMessage("grep", "c2", "y".repeat(150_000), T0), T0),
		];
	}

	test("returns a patch when omission alone reaches the target total; model never called", async () => {
		const entries = bigBranch();
		const currentTokens = visibleTokens(entries);
		const predicted = pruneToolOutputs(
			JSON.parse(JSON.stringify(entries)),
			tokenizer,
			structuredConfig(),
		).tokensSaved;
		const summarize = vi.fn(async (_: readonly AssistantSummaryInput[]) => {
			throw new Error("summarize must not be called when omission already reaches the target");
		});
		const { request } = makeRequest(entries, {
			currentTokens,
			targetTokens: currentTokens - predicted,
			summarize: summarize as Parameters<typeof prepareStructuredCompaction>[0]["summarize"],
		});

		const patch = asPatch(await prepareStructuredCompaction(request));
		expect(patch.kind).toBe("structured");
		expect(patch.estimatedTokensSaved).toBe(predicted);
		expect(summarize).not.toHaveBeenCalled();
		// Tool-call-only assistants are not summarizable; only the two results were rewritten.
		expect(patch.rewrite.replacements.map(replacement => replacement.id)).toEqual([entries[1].id, entries[3].id]);
		for (const replacement of patch.rewrite.replacements) {
			const message = replacement.message as ToolResultMessage;
			expect(message.omittedOriginal).toBeDefined();
			expect((message.content[0] as TextContent).text).toContain("read_omitted_content");
			expect(message.prunedAt).toBeDefined();
		}
	});

	test("returns undefined when omission cannot reach the target and no assistant is eligible", async () => {
		const entries = bigBranch();
		const currentTokens = visibleTokens(entries);
		const predicted = pruneToolOutputs(
			JSON.parse(JSON.stringify(entries)),
			tokenizer,
			structuredConfig(),
		).tokensSaved;
		const summarize = vi.fn(async (_: readonly AssistantSummaryInput[]) => {
			throw new Error("summarize must not be called without eligible assistants");
		});
		const { request } = makeRequest(entries, {
			currentTokens,
			targetTokens: currentTokens - predicted - 1,
			summarize: summarize as Parameters<typeof prepareStructuredCompaction>[0]["summarize"],
		});

		const patch = await prepareStructuredCompaction(request);
		expect(patch).toBeUndefined();
		expect(summarize).not.toHaveBeenCalled();
	});

	test("does not include results already pruned before this prepare call", async () => {
		const prePrunedId = "pre-pruned";
		const prePruned: SessionMessageEntry = {
			type: "message",
			id: prePrunedId,
			parentId: null,
			timestamp: new Date(T0).toISOString(),
			message: {
				...toolResultMessage("read", "c-old", "stale", T0),
				content: [{ type: "text", text: "[Output truncated - 100 tokens]" }],
				prunedAt: 111,
				omittedOriginal: [{ type: "text", text: "old payload" }],
			},
		};
		const entries: SessionEntry[] = [
			prePruned,
			messageEntry(assistantMessage([toolCall("c1", "read", { path: "src/a.ts" })], T0), T0),
			messageEntry(toolResultMessage("read", "c1", "x".repeat(150_000), T0), T0),
		];
		const currentTokens = visibleTokens(entries);
		const predicted = pruneToolOutputs(
			JSON.parse(JSON.stringify(entries)),
			tokenizer,
			structuredConfig(),
		).tokensSaved;
		const summarize = vi.fn(async (_: readonly AssistantSummaryInput[]) => []);
		const { request } = makeRequest(entries, {
			currentTokens,
			targetTokens: currentTokens - predicted,
			summarize: summarize as Parameters<typeof prepareStructuredCompaction>[0]["summarize"],
		});

		const patch = asPatch(await prepareStructuredCompaction(request));
		const ids = patch.rewrite.replacements.map(replacement => replacement.id);
		expect(ids).not.toContain(prePrunedId);
		expect(ids).toEqual([entries[2].id]);
	});
});

describe("prepareStructuredCompaction — assistant summaries", () => {
	/** Two old assistant turns (each a text + toolCall) with paired results, plus a huge tail. */
	function summaryBranch(): SessionEntry[] {
		const c1 = toolCall("call-1", "read", { path: "src/a.ts" });
		const c2 = toolCall("call-2", "grep", { pattern: "foo" });
		return [
			messageEntry(assistantMessage([{ type: "text", text: DEEP_TEXT }, c1], T0), T0),
			messageEntry(toolResultMessage("read", "call-1", MEDIUM_RESULT, T0), T0),
			messageEntry(assistantMessage([{ type: "text", text: DEEP_TEXT }, c2], T0), T0),
			messageEntry(toolResultMessage("grep", "call-2", MEDIUM_RESULT, T0), T0),
			messageEntry(toolResultMessage("tail", "call-tail", BIG_TAIL, T0), T0),
		];
	}

	test("summarizes at least two assistant messages with tool pairing; summary sits at the first text position and tool calls keep their spots", async () => {
		const entries = summaryBranch();
		const originalJson = JSON.stringify(entries);
		const currentTokens = visibleTokens(entries);
		const predicted = pruneToolOutputs(
			JSON.parse(JSON.stringify(entries)),
			tokenizer,
			structuredConfig(),
		).tokensSaved;
		// Omission alone falls one token short; summaries must bridge the gap.
		const targetTokens = currentTokens - predicted - 1;
		const summarize = vi.fn(
			async (inputs: readonly AssistantSummaryInput[]): Promise<readonly AssistantSummaryOutput[]> =>
				inputs.map(input => ({ id: input.id, text: `done:${input.id}` })),
		);
		const { request } = makeRequest(entries, {
			currentTokens,
			targetTokens,
			summarize: summarize as Parameters<typeof prepareStructuredCompaction>[0]["summarize"],
		});

		const patch = asPatch(await prepareStructuredCompaction(request));

		// Both old assistants were submitted, in order, with their plain text.
		expect(summarize).toHaveBeenCalledTimes(1);
		const submitted = summarize.mock.calls[0]?.[0] as readonly AssistantSummaryInput[];
		expect(submitted.map(input => input.id)).toEqual([entries[0].id, entries[2].id]);
		expect(submitted[0]?.text).toBe(DEEP_TEXT);
		expect(submitted[1]?.text).toBe(DEEP_TEXT);

		// The postponed target now fits.
		expect(currentTokens - patch.estimatedTokensSaved).toBeLessThanOrEqual(targetTokens);

		// Replacements cover the two pruned results and the two summarized assistants, in branch order.
		expect(patch.rewrite.replacements.map(replacement => replacement.id)).toEqual([
			entries[0].id,
			entries[1].id,
			entries[2].id,
			entries[3].id,
			entries[4].id,
		]);

		// First assistant: [summary, toolCall] — summary replaces the first text block;
		// the tool call is byte-identical (id, name, arguments preserved).
		const messageA = patch.rewrite.replacements[0]!.message as AssistantMessage;
		expect(messageA.content).toHaveLength(2);
		expect(messageA.content[0]).toEqual({ type: "text", text: `${ASSISTANT_SUMMARY_PREFIX}done:${entries[0].id}` });
		expect(messageA.content[1]).toEqual(toolCall("call-1", "read", { path: "src/a.ts" }));
		// Second assistant: same shape, with its own tool call.
		const messageB = patch.rewrite.replacements[2]!.message as AssistantMessage;
		expect(messageB.content).toHaveLength(2);
		expect(messageB.content[0] as TextContent).toEqual({
			type: "text",
			text: `${ASSISTANT_SUMMARY_PREFIX}done:${entries[2].id}`,
		});
		expect(messageB.content[1]).toEqual(toolCall("call-2", "grep", { pattern: "foo" }));

		// Assistant identity fields survive; only content is rewritten.
		expect(messageA.api).toBe("mock");
		expect(messageA.provider).toBe("mock");
		expect(messageA.model).toBe("mock");
		expect(messageA.stopReason).toBe("stop");
		expect(messageA.usage).toEqual(((entries[0] as SessionMessageEntry).message as AssistantMessage).usage);

		// The paired results are recoverably omitted, toolCallId pairing intact.
		const resultA = patch.rewrite.replacements[1]!.message as ToolResultMessage;
		expect(resultA.toolCallId).toBe("call-1");
		expect(resultA.omittedOriginal).toEqual([{ type: "text", text: MEDIUM_RESULT }]);
		expect((resultA.content[0] as TextContent).text).toContain("read_omitted_content");

		// The pristine prefix is an exact copy of the original branch (immutable snapshot),
		// and the caller's entries were never mutated.
		expect(JSON.stringify(patch.rewrite.prefix)).toBe(originalJson);
		expect(JSON.stringify(entries)).toBe(originalJson);
	});

	test("gain is measured from the real new message sizes (fresh count after invalidation)", async () => {
		const entries = summaryBranch();
		const currentTokens = visibleTokens(entries);
		const predicted = pruneToolOutputs(
			JSON.parse(JSON.stringify(entries)),
			tokenizer,
			structuredConfig(),
		).tokensSaved;
		const targetTokens = currentTokens - predicted - 1;
		const summarize = vi.fn(
			async (inputs: readonly AssistantSummaryInput[]): Promise<readonly AssistantSummaryOutput[]> =>
				inputs.map(input => ({ id: input.id, text: `done:${input.id}` })),
		);
		const { request } = makeRequest(entries, {
			currentTokens,
			targetTokens,
			summarize: summarize as Parameters<typeof prepareStructuredCompaction>[0]["summarize"],
		});

		const patch = asPatch(await prepareStructuredCompaction(request));

		// Independently rebuild the expected rewritten messages on FRESH clones and
		// measure their true token counts; the exposed savings must match.
		const clone = JSON.parse(JSON.stringify(entries)) as SessionEntry[];
		let expectedSummaryGain = 0;
		for (const input of summarize.mock.calls[0]![0] as readonly AssistantSummaryInput[]) {
			const original = (entryById(clone, input.id).message as AssistantMessage).content;
			expect(original[0]).toEqual({ type: "text", text: DEEP_TEXT });
			const originalMessage = entryById(clone, input.id).message as AssistantMessage;
			const originalTokens = tokenizer.countMessage(originalMessage);
			const rewritten = JSON.parse(JSON.stringify(originalMessage)) as AssistantMessage;
			let inserted = false;
			rewritten.content = rewritten.content.flatMap<AssistantMessage["content"][number]>(block => {
				if (block.type !== "text") return [block];
				if (inserted) return [];
				inserted = true;
				return [{ type: "text", text: `${ASSISTANT_SUMMARY_PREFIX}done:${input.id}` }];
			});
			expectedSummaryGain += originalTokens - tokenizer.countMessage(rewritten);
		}
		expect(expectedSummaryGain).toBeGreaterThan(0);
		expect(patch.estimatedTokensSaved).toBe(predicted + expectedSummaryGain);
	});

	test("tool calls keep their original positions when the message starts with one", async () => {
		const c0 = toolCall("call-0", "bash", { command: "ls" });
		const c1 = toolCall("call-1", "read", { path: "src/a.ts" });
		const entries: SessionEntry[] = [
			messageEntry(assistantMessage([c0, { type: "text", text: DEEP_TEXT }, c1], T0), T0),
			messageEntry(toolResultMessage("tail", "call-tail", BIG_TAIL, T0), T0),
		];
		const currentTokens = visibleTokens(entries);
		// Omission only; target requests more than the tail alone can save.
		const summarize = vi.fn(
			async (inputs: readonly AssistantSummaryInput[]): Promise<readonly AssistantSummaryOutput[]> =>
				inputs.map(input => ({ id: input.id, text: "s" })),
		);
		const { request } = makeRequest(entries, {
			currentTokens,
			targetTokens: 1000,
			summarize: summarize as Parameters<typeof prepareStructuredCompaction>[0]["summarize"],
		});

		const patch = asPatch(await prepareStructuredCompaction(request));
		const message = patch.rewrite.replacements.find(replacement => replacement.id === entries[0].id)!
			.message as AssistantMessage;
		// The leading tool call must stay FIRST; the summary replaces only the text block in place.
		expect(message.content.map(block => block.type)).toEqual(["toolCall", "text", "toolCall"]);
		expect(message.content[0]).toEqual(c0);
		expect(message.content[1]).toEqual({ type: "text", text: `${ASSISTANT_SUMMARY_PREFIX}s` });
		expect(message.content[2]).toEqual(c1);
	});

	test("rejects insufficient total gain after summaries (returns undefined)", async () => {
		const entries: SessionEntry[] = [
			messageEntry(assistantMessage([{ type: "text", text: "prior turn text" }], T0), T0),
			messageEntry(toolResultMessage("tail", "call-tail", BIG_TAIL, T0), T0),
		];
		const currentTokens = visibleTokens(entries);
		const predicted = pruneToolOutputs(
			JSON.parse(JSON.stringify(entries)),
			tokenizer,
			structuredConfig(),
		).tokensSaved;
		// Summaries are still requested, but the tiny summary cannot bridge the 100-token gap.
		const summarize = vi.fn(
			async (inputs: readonly AssistantSummaryInput[]): Promise<readonly AssistantSummaryOutput[]> =>
				inputs.map(input => ({ id: input.id, text: "ok" })),
		);
		const { request } = makeRequest(entries, {
			currentTokens,
			targetTokens: currentTokens - predicted - 100,
			summarize: summarize as Parameters<typeof prepareStructuredCompaction>[0]["summarize"],
		});

		const patch = await prepareStructuredCompaction(request);
		expect(patch).toBeUndefined();
		expect(summarize).toHaveBeenCalledTimes(1);
	});
});

describe("prepareStructuredCompaction — eligible assistant windows", () => {
	function tailBranch(assistant: AssistantMessage, extra: SessionEntry[] = []): SessionEntry[] {
		return [
			messageEntry(assistant, T0),
			...extra,
			messageEntry(toolResultMessage("tail", "call-tail", BIG_TAIL, T0), T0),
		];
	}

	async function inputsFor(
		assistant: AssistantMessage,
		extra: SessionEntry[] = [],
	): Promise<readonly AssistantSummaryInput[]> {
		const entries = tailBranch(assistant, extra);
		const currentTokens = visibleTokens(entries);
		const predicted = pruneToolOutputs(
			JSON.parse(JSON.stringify(entries)),
			tokenizer,
			structuredConfig(),
		).tokensSaved;
		const summarize = vi.fn(
			async (inputs: readonly AssistantSummaryInput[]): Promise<readonly AssistantSummaryOutput[]> =>
				inputs.map(input => ({ id: input.id, text: "s" })),
		);
		const { request } = makeRequest(entries, {
			currentTokens,
			targetTokens: currentTokens - predicted - 1,
			summarize: summarize as Parameters<typeof prepareStructuredCompaction>[0]["summarize"],
		});
		await prepareStructuredCompaction(request);
		return summarize.mock.calls[0]?.[0] ?? [];
	}

	test("provider-signed messages (providerPayload) are skipped whole", async () => {
		const inputs = await inputsFor(
			assistantMessage([{ type: "text", text: DEEP_TEXT }], T0, {
				providerPayload: createOpenAIResponsesHistoryPayload("openai", []),
			}),
		);
		expect(inputs).toEqual([]);
	});

	test("signed text blocks are skipped whole", async () => {
		const inputs = await inputsFor(assistantMessage([{ type: "text", text: DEEP_TEXT, textSignature: "sig-1" }], T0));
		expect(inputs).toEqual([]);
	});

	test("thinking blocks make the whole message ineligible", async () => {
		const inputs = await inputsFor(
			assistantMessage(
				[
					{ type: "thinking", thinking: "reasoning..." },
					{ type: "text", text: DEEP_TEXT },
				],
				T0,
			),
		);
		expect(inputs).toEqual([]);
	});

	test("image blocks make the whole message ineligible", async () => {
		const image: ImageContent = { type: "image", data: "aGk=", mimeType: "image/png" };
		const inputs = await inputsFor(assistantMessage([image, { type: "text", text: DEEP_TEXT }], T0));
		expect(inputs).toEqual([]);
	});

	test("tool-call-only messages carry no text and are not submitted", async () => {
		const inputs = await inputsFor(assistantMessage([toolCall("call-1", "read", { path: "a" })], T0));
		expect(inputs).toEqual([]);
	});

	test("assistant messages inside the recent protect window are not submitted", async () => {
		// A single recent turn: suffix (0 tokens) is far below the 40k-token window.
		const entries = [messageEntry(assistantMessage([{ type: "text", text: "recent turn text" }], T0), T0)];
		const currentTokens = visibleTokens(entries);
		const summarize = vi.fn(
			async (inputs: readonly AssistantSummaryInput[]): Promise<readonly AssistantSummaryOutput[]> =>
				inputs.map(input => ({ id: input.id, text: "s" })),
		);
		const { request } = makeRequest(entries, {
			currentTokens,
			targetTokens: 0,
			summarize: summarize as Parameters<typeof prepareStructuredCompaction>[0]["summarize"],
		});
		const patch = await prepareStructuredCompaction(request);
		expect(patch).toBeUndefined();
		expect(summarize).not.toHaveBeenCalled();
	});

	test("the helper inherits the latest compaction boundary on its own (no keepBoundaryId in config)", async () => {
		const beforeBoundary = messageEntry(assistantMessage([{ type: "text", text: DEEP_TEXT }], T0), T0);
		const afterBoundary = messageEntry(assistantMessage([{ type: "text", text: DEEP_TEXT }], T0), T0);
		const entries: SessionEntry[] = [
			beforeBoundary,
			compactionEntry(afterBoundary.id, T0),
			afterBoundary,
			messageEntry(toolResultMessage("tail", "call-tail", BIG_TAIL, T0), T0),
		];
		const currentTokens = visibleTokens(entries);
		const predicted = pruneToolOutputs(
			JSON.parse(JSON.stringify(entries)),
			tokenizer,
			structuredConfig(),
		).tokensSaved;
		const summarize = vi.fn(
			async (inputs: readonly AssistantSummaryInput[]): Promise<readonly AssistantSummaryOutput[]> =>
				inputs.map(input => ({ id: input.id, text: "s" })),
		);
		const { request } = makeRequest(entries, {
			// No keepBoundaryId: the latest compaction entry supplies the boundary.
			currentTokens,
			targetTokens: currentTokens - predicted - 1,
			summarize: summarize as Parameters<typeof prepareStructuredCompaction>[0]["summarize"],
		});

		const patch = asPatch(await prepareStructuredCompaction(request));
		const submitted = summarize.mock.calls[0]?.[0] as readonly AssistantSummaryInput[];
		expect(submitted.map(input => input.id)).toEqual([afterBoundary.id]);
		const replacementIds = patch.rewrite.replacements.map(replacement => replacement.id);
		expect(replacementIds).not.toContain(beforeBoundary.id);
		expect(replacementIds).toContain(afterBoundary.id);
		expect(replacementIds).toContain(entries[3].id);
	});
});

describe("prepareStructuredCompaction — abort and protocol failures", () => {
	function abortableBranch(): SessionEntry[] {
		return [
			messageEntry(assistantMessage([{ type: "text", text: DEEP_TEXT }], T0), T0),
			messageEntry(toolResultMessage("tail", "call-tail", BIG_TAIL, T0), T0),
		];
	}

	test("an already-aborted signal rejects before any work", async () => {
		const controller = new AbortController();
		controller.abort();
		const { request } = makeRequest(abortableBranch(), { signal: controller.signal });
		await expect(prepareStructuredCompaction(request)).rejects.toMatchObject({ name: "AbortError" });
	});

	test("abort during the summarize call rejects instead of producing a patch", async () => {
		const controller = new AbortController();
		const summarize = vi.fn((_inputs: readonly AssistantSummaryInput[], signal: AbortSignal) => {
			return new Promise<readonly AssistantSummaryOutput[]>((_, reject) => {
				signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
			});
		});
		const { request } = makeRequest(abortableBranch(), {
			targetTokens: 0,
			summarize: summarize as Parameters<typeof prepareStructuredCompaction>[0]["summarize"],
			signal: controller.signal,
		});
		const promise = prepareStructuredCompaction(request);
		controller.abort();
		await expect(promise).rejects.toMatchObject({ name: "AbortError" });
	});

	test("a summary for an unknown id rejects the whole preparation", async () => {
		const { request } = makeRequest(abortableBranch(), {
			targetTokens: 0,
			summarize: (async () => [{ id: "ghost", text: "x" }]) as Parameters<
				typeof prepareStructuredCompaction
			>[0]["summarize"],
		});
		await expect(prepareStructuredCompaction(request)).rejects.toThrow(/not requested/);
	});

	test("duplicate summary ids reject the whole preparation", async () => {
		const entries = abortableBranch();
		const summarize = (async (inputs: readonly AssistantSummaryInput[]) => [
			{ id: inputs[0]!.id, text: "1" },
			{ id: inputs[0]!.id, text: "2" },
		]) as Parameters<typeof prepareStructuredCompaction>[0]["summarize"];
		const { request } = makeRequest([...entries], { targetTokens: 0, summarize });
		await expect(prepareStructuredCompaction(request)).rejects.toThrow(/duplicate/);
	});

	test("empty summary text rejects the whole preparation", async () => {
		const entries = abortableBranch();
		const summarize = (async (inputs: readonly AssistantSummaryInput[]) => [
			{ id: inputs[0]!.id, text: "   " },
		]) as Parameters<typeof prepareStructuredCompaction>[0]["summarize"];
		const { request } = makeRequest([...entries], { targetTokens: 0, summarize });
		await expect(prepareStructuredCompaction(request)).rejects.toThrow(/invalid text/);
	});

	test("summary text over the 512-token cap rejects the whole preparation", async () => {
		const entries = abortableBranch();
		const summarize = (async (inputs: readonly AssistantSummaryInput[]) => [
			{ id: inputs[0]!.id, text: "z".repeat(3_000) },
		]) as Parameters<typeof prepareStructuredCompaction>[0]["summarize"];
		const { request } = makeRequest([...entries], { targetTokens: 0, summarize });
		await expect(prepareStructuredCompaction(request)).rejects.toThrow(/invalid text/);
	});
});
