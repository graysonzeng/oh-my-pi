import { describe, expect, test } from "bun:test";
import { type AgentMessage, Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { SessionEntry, SessionMessageEntry } from "@oh-my-pi/pi-agent-core/compaction";
import {
	createAddressableNotice,
	DEFAULT_PRUNE_CONFIG,
	type PruneConfig,
	pruneToolOutputs,
	readToolSupersedeKey,
} from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, ImageContent, TextContent, ToolResultMessage } from "@oh-my-pi/pi-ai";

const tokenizer = new Tokenizer();

let idCounter = 0;
function nextId(): string {
	return `entry-${idCounter++}`;
}

function messageEntry(message: AgentMessage, timestamp: number): SessionMessageEntry {
	return { type: "message", id: nextId(), parentId: null, timestamp: new Date(timestamp).toISOString(), message };
}

function assistantMessage(content: AssistantMessage["content"], timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content,
		timestamp,
		provider: "mock",
		model: "mock",
		api: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
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

/** Assistant toolCall entry + paired toolResult entry for one read. */
function readPair(path: string, text: string, timestamp: number): [SessionMessageEntry, SessionMessageEntry] {
	const callId = `call-${idCounter++}`;
	return [
		messageEntry(
			assistantMessage([{ type: "toolCall", id: callId, name: "read", arguments: { path } }], timestamp),
			timestamp,
		),
		messageEntry(toolResultMessage("read", callId, text, timestamp), timestamp),
	];
}

/** A read result whose entry id and message state are fully controlled by the caller. */
function customResult(
	content: (TextContent | ImageContent)[],
	timestamp: number,
	options: { id?: string; prunedAt?: number; omittedOriginal?: (TextContent | ImageContent)[] } = {},
): SessionMessageEntry {
	const callId = `call-${idCounter++}`;
	const id = options.id ?? nextId();
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(timestamp).toISOString(),
		message: {
			...toolResultMessage("read", callId, "", timestamp),
			content,
			...(options.prunedAt !== undefined ? { prunedAt: options.prunedAt } : {}),
			...(options.omittedOriginal !== undefined ? { omittedOriginal: options.omittedOriginal } : {}),
		},
	};
}

function resultMessage(entry: SessionEntry): ToolResultMessage {
	return (entry as SessionMessageEntry).message as ToolResultMessage;
}

function cfg(over: Partial<PruneConfig> = {}): PruneConfig {
	return { ...DEFAULT_PRUNE_CONFIG, protectedTools: [], ...over };
}

const T0 = Date.UTC(2026, 5, 10, 12, 0, 0);
const BIG_TEXT = "const value = computeSomething(12345);\n".repeat(500); // well above MIN_PRUNE_TOKENS / notice size
const VERY_BIG = "v".repeat(20_000); // ≈ 5k tokens

describe("createAddressableNotice", () => {
	test("carries the entry id and the recovery tool usage", () => {
		const notice = createAddressableNotice("entry-7", 4321);
		expect(notice).toContain("entry-7");
		expect(notice).toContain("read_omitted_content");
		expect(notice).toContain("4321");
	});
});

describe("pruneToolOutputs — addressable mode", () => {
	test("records omittedOriginal and replaces content with the entry-id notice; savings come from that notice", () => {
		const [a1, r1] = readPair("src/a.ts", BIG_TEXT, T0);
		const [a2, r2] = readPair("src/b.ts", BIG_TEXT, T0);
		const entries: SessionEntry[] = [a1, r1, a2, r2];
		const config = cfg({ addressable: true, protectTokens: 0, minimumSavings: 1_000 });

		const origTokens1 = tokenizer.countMessage(r1.message as AgentMessage);
		const origTokens2 = tokenizer.countMessage(r2.message as AgentMessage);
		const result = pruneToolOutputs(entries, tokenizer, config);

		expect(result.prunedCount).toBe(2);
		const notice1 = createAddressableNotice(r1.id, origTokens1);
		const notice2 = createAddressableNotice(r2.id, origTokens2);
		const m1 = resultMessage(entries[1]);
		const m2 = resultMessage(entries[3]);
		expect((m1.content[0] as TextContent).text).toBe(notice1);
		expect((m2.content[0] as TextContent).text).toBe(notice2);
		expect(m1.prunedAt).toBeDefined();
		expect(m2.prunedAt).toBeDefined();
		expect(m1.omittedOriginal).toEqual([{ type: "text", text: BIG_TEXT }]);
		expect(m2.omittedOriginal).toEqual([{ type: "text", text: BIG_TEXT }]);

		// Savings are computed from the actual notice message, not a generic placeholder.
		const expected1 =
			origTokens1 - tokenizer.countMessage({ ...resultMessage(r1), content: [{ type: "text", text: notice1 }] });
		const expected2 =
			origTokens2 - tokenizer.countMessage({ ...resultMessage(r2), content: [{ type: "text", text: notice2 }] });
		expect(result.tokensSaved).toBe(expected1 + expected2);
		expect(result.tokensSaved).toBeGreaterThan(0);
	});

	test("omittedOriginal is a deep independent copy (nested providerFile is not aliased)", () => {
		const providerFile = { provider: "openai" as const, id: "file-1" };
		const imageBlock: ImageContent = {
			type: "image",
			data: "aGVsbG8=",
			mimeType: "image/png",
			providerFile,
		};
		const originalContent = [imageBlock, { type: "text" as const, text: BIG_TEXT }];
		const entry = customResult(originalContent, T0);
		const result = pruneToolOutputs(
			[entry],
			tokenizer,
			cfg({ addressable: true, protectTokens: 0, minimumSavings: 10 }),
		);

		expect(result.prunedCount).toBe(1);
		const message = resultMessage(entry);
		const omitted = message.omittedOriginal!;
		expect(omitted).toEqual(originalContent);
		expect(omitted).not.toBe(originalContent);
		expect(omitted[0]).not.toBe(imageBlock);
		expect((omitted[0] as ImageContent).providerFile).not.toBe(providerFile);
		expect((omitted[0] as ImageContent).providerFile).toEqual(providerFile);
		expect((omitted[1] as TextContent).text).toBe(BIG_TEXT);
	});

	test("skips results already pruned or already carrying omittedOriginal", () => {
		const preNotice = createAddressableNotice("old", 5000);
		const prePruned = customResult([{ type: "text", text: preNotice }], T0, {
			prunedAt: 111,
			omittedOriginal: [{ type: "text", text: "original payload" }],
		});
		const onlyOmitted = customResult([{ type: "text", text: BIG_TEXT }], T0, {
			omittedOriginal: [{ type: "text", text: "already omitted" }],
		});
		const [a2, r2] = readPair("src/b.ts", BIG_TEXT, T0);
		const entries: SessionEntry[] = [prePruned, onlyOmitted, a2, r2];
		const originalTokens = tokenizer.countMessage(r2.message);

		const result = pruneToolOutputs(
			entries,
			tokenizer,
			cfg({ addressable: true, protectTokens: 0, minimumSavings: 10 }),
		);

		expect(result.prunedCount).toBe(1);
		expect(resultMessage(prePruned).content[0]).toEqual({ type: "text", text: preNotice });
		expect(resultMessage(prePruned).prunedAt).toBe(111);
		expect(resultMessage(prePruned).omittedOriginal).toEqual([{ type: "text", text: "original payload" }]);
		expect(resultMessage(onlyOmitted).content[0]).toEqual({ type: "text", text: BIG_TEXT });
		expect(resultMessage(onlyOmitted).omittedOriginal).toEqual([{ type: "text", text: "already omitted" }]);
		expect((resultMessage(r2).content[0] as TextContent).text).toBe(createAddressableNotice(r2.id, originalTokens));
	});

	test("keeps the recent protect window intact; only older results are omitted", () => {
		const [a1, r1] = readPair("src/old.ts", VERY_BIG, T0);
		const [a2, r2] = readPair("src/recent.ts", VERY_BIG, T0);
		const entries: SessionEntry[] = [a1, r1, a2, r2];

		const result = pruneToolOutputs(
			entries,
			tokenizer,
			cfg({ addressable: true, protectTokens: 1_000, minimumSavings: 100 }),
		);

		expect(result.prunedCount).toBe(1);
		expect(resultMessage(entries[1]).prunedAt).toBeDefined();
		expect(resultMessage(entries[3]).prunedAt).toBeUndefined();
		expect(resultMessage(entries[3]).content[0]).toEqual({ type: "text", text: VERY_BIG });
		expect(resultMessage(entries[3]).omittedOriginal).toBeUndefined();
	});

	test("respects the compaction boundary: entries before keepBoundaryId are never touched", () => {
		const [a1, r1] = readPair("src/before.ts", VERY_BIG, T0);
		const [aBoundary, rBoundary] = readPair("src/boundary.ts", VERY_BIG, T0);
		const [a2, r2] = readPair("src/after.ts", VERY_BIG, T0);
		const entries: SessionEntry[] = [a1, r1, aBoundary, rBoundary, a2, r2];

		const result = pruneToolOutputs(
			entries,
			tokenizer,
			cfg({
				addressable: true,
				protectTokens: 0,
				minimumSavings: 100,
				keepBoundaryId: rBoundary.id,
			}),
		);

		expect(result.prunedCount).toBe(2);
		expect(resultMessage(entries[1]).prunedAt).toBeUndefined(); // summarized away — never touched
		expect(resultMessage(entries[3]).prunedAt).toBeDefined(); // boundary entry itself is still visible and prunable
		expect(resultMessage(entries[5]).prunedAt).toBeDefined(); // after boundary
	});
});

describe("pruneToolOutputs — addressable disables superseded/useless bypass", () => {
	test("useless-flagged results do not bypass the protect window in addressable mode", () => {
		const callId = `call-${idCounter++}`;
		const useless = messageEntry({ ...toolResultMessage("grep", callId, VERY_BIG, T0), useless: true }, T0);

		const addressableRun = pruneToolOutputs(
			[useless],
			tokenizer,
			cfg({ addressable: true, protectTokens: 5_000, minimumSavings: 100, pruneUseless: true }),
		);
		expect(addressableRun.prunedCount).toBe(0);

		const legacyRun = pruneToolOutputs(
			[useless],
			tokenizer,
			cfg({ addressable: false, protectTokens: 5_000, minimumSavings: 100, pruneUseless: true }),
		);
		expect(legacyRun.prunedCount).toBe(1);
	});

	test("superseded results do not bypass the protect window in addressable mode", () => {
		const [a1, r1] = readPair("src/same.ts", VERY_BIG, T0);
		const [a2, r2] = readPair("src/same.ts", VERY_BIG, T0);
		const entries: SessionEntry[] = [a1, r1, a2, r2];

		const addressableRun = pruneToolOutputs(
			[...entries],
			tokenizer,
			cfg({
				addressable: true,
				protectTokens: 10_000,
				minimumSavings: 100,
				supersedeKey: readToolSupersedeKey,
			}),
		);
		expect(addressableRun.prunedCount).toBe(0);

		const legacyRun = pruneToolOutputs(
			[...entries],
			tokenizer,
			cfg({ addressable: false, protectTokens: 10_000, minimumSavings: 100, supersedeKey: readToolSupersedeKey }),
		);
		expect(legacyRun.prunedCount).toBe(1);
	});
});

describe("pruneToolOutputs — addressable no-gain candidates are skipped", () => {
	test("a candidate whose notice costs as much as its content is skipped", () => {
		// Long id inflates the notice beyond the small content → zero savings.
		const longId = "k".repeat(600);
		const longEntry = customResult([{ type: "text", text: "y".repeat(300) }], T0, { id: longId });
		const [a1, r1] = readPair("src/normal.ts", "y".repeat(300), T0);
		void a1;

		const longRun = pruneToolOutputs(
			[longEntry, r1],
			tokenizer,
			cfg({ addressable: true, protectTokens: 0, minimumSavings: 10 }),
		);
		expect(longRun.prunedCount).toBe(1); // only the normal-id result is pruned
		expect(resultMessage(longEntry).prunedAt).toBeUndefined();
		expect(resultMessage(r1).prunedAt).toBeDefined();
	});
});

describe("pruneToolOutputs — default non-addressable behavior is unchanged", () => {
	test("plain truncated notice, prunedAt set, no omittedOriginal", () => {
		const [a1, r1] = readPair("src/a.ts", BIG_TEXT, T0);
		const entries: SessionEntry[] = [a1, r1];
		const origTokens = tokenizer.countMessage(r1.message as AgentMessage);
		const result = pruneToolOutputs(entries, tokenizer, cfg({ protectTokens: 0, minimumSavings: 100 }));

		expect(result.prunedCount).toBe(1);
		const message = resultMessage(entries[1]);
		const notice = `[Output truncated - ${origTokens} tokens]`;
		expect((message.content[0] as TextContent).text).toBe(notice);
		expect(message.prunedAt).toBeDefined();
		expect(message.omittedOriginal).toBeUndefined();
		expect(result.tokensSaved).toBe(Math.max(0, origTokens - Math.ceil(notice.length / 4)));
	});
});

describe("pruneToolOutputs — addressable honors protected tools", () => {
	test("results from protected tools are never omitted", () => {
		const [a1, r1] = readPair("src/plan.md", VERY_BIG, T0);
		const entries: SessionEntry[] = [a1, r1];
		const result = pruneToolOutputs(
			entries,
			tokenizer,
			cfg({ addressable: true, protectTokens: 0, minimumSavings: 100, protectedTools: ["read"] }),
		);
		expect(result.prunedCount).toBe(0);
		expect(resultMessage(entries[1]).prunedAt).toBeUndefined();
	});
});
