import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	decodedBase64ByteLength,
	formatOmittedContentEnvelope,
	isOmittedContentEnvelopeBlock,
	MAX_OMITTED_CONTENT_MAX_BYTES,
	OMITTED_CONTENT_META_PREFIX,
	OMITTED_CONTENT_META_SUFFIX,
	OmittedContentError,
	type OmittedContentFitCheck,
	readOmittedContentPage,
	utf8ByteLength,
} from "@oh-my-pi/pi-coding-agent/session/omitted-content";
import type { SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { wrapToolWithMetaNotice } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { ReadOmittedContentTool } from "@oh-my-pi/pi-coding-agent/tools/read-omitted-content";
import { ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";

const OMITTED_ID = "omitted-bash-1";

afterEach(() => vi.restoreAllMocks());

function toolResultEntry(id: string, omittedOriginal: (TextContent | ImageContent)[]): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId: "root",
		timestamp: "2026-09-05T00:00:00.000Z",
		message: {
			role: "toolResult",
			toolCallId: `call_${id}`,
			toolName: "bash",
			content: [{ type: "text", text: "omitted placeholder" }],
			omittedOriginal,
			isError: false,
			timestamp: 1_752_000_000_000,
		},
	};
}

function userEntry(id: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId: "root",
		timestamp: "2026-09-05T00:00:00.000Z",
		message: {
			role: "user",
			content: [{ type: "text", text: "keep my words" }],
			timestamp: 1_752_000_000_000,
		},
	};
}

const PNG_IMAGE: ImageContent = { type: "image", data: "AAAA", mimeType: "image/png" };

function dataText(content: readonly (TextContent | ImageContent)[]): string {
	return content
		.slice(0, -1)
		.filter((block): block is TextContent => block.type === "text")
		.map(block => block.text)
		.join("");
}

function envelopeText(content: readonly (TextContent | ImageContent)[]): string {
	const last = content[content.length - 1];
	expect(last.type).toBe("text");
	expect(isOmittedContentEnvelopeBlock(last)).toBe(true);
	return (last as TextContent).text;
}

function envelopeNext(content: readonly (TextContent | ImageContent)[]): { block: number; offset: number } | null {
	const json = envelopeText(content).slice(OMITTED_CONTENT_META_PREFIX.length, -OMITTED_CONTENT_META_SUFFIX.length);
	return JSON.parse(json).next as { block: number; offset: number } | null;
}

function readAll(entries: readonly SessionMessageEntry[], id: string, maxBytes: number): string {
	const parts: string[] = [];
	let cursor: { block: number; offset: number } = { block: 0, offset: 0 };
	for (let guard = 0; guard < 1_000; guard++) {
		const page = readOmittedContentPage(entries, { id, ...cursor, maxBytes }, () => true);
		expect(page.next).toEqual(envelopeNext(page.content));
		parts.push(dataText(page.content));
		if (page.next === null) return parts.join("");
		cursor = page.next;
	}
	throw new Error("pagination never reached EOF");
}

function fitsWithinChars(limit: number): OmittedContentFitCheck {
	return content => {
		let chars = 0;
		for (const block of content) {
			chars += block.type === "text" ? block.text.length : block.data.length;
		}
		return chars <= limit;
	};
}

function stubSession(recall?: ToolSession["readOmittedContent"]): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({}),
		...(recall === undefined ? {} : { readOmittedContent: recall }),
	};
}

describe("readOmittedContentPage", () => {
	it("does not deliver an unresolved image blob reference as image bytes", () => {
		const reference = `blob:sha256:${"a".repeat(64)}`;
		const entries = [toolResultEntry(OMITTED_ID, [{ type: "image", data: reference, mimeType: "image/png" }])];
		const fits = vi.fn(() => true);
		expect(() => readOmittedContentPage(entries, { id: OMITTED_ID, image: true }, fits)).toThrow(/unavailable/);
		expect(fits).not.toHaveBeenCalled();
	});

	it("reassembles multibyte UTF-8 text byte-for-byte using only the visible envelope cursor", () => {
		const original = ["ASCII ", "ééé", "中文内容", "😀😀", "𝄞 clef", "0123456789".repeat(20)].join("");
		const entries = [toolResultEntry(OMITTED_ID, [{ type: "text", text: original }])];
		const reassembled = readAll(entries, OMITTED_ID, 13);
		expect(reassembled).toBe(original);
		expect(utf8ByteLength(reassembled)).toBe(utf8ByteLength(original));
	});

	it("rejects a byte cap smaller than the next character without delivering or advancing it", () => {
		const entries = [toolResultEntry(OMITTED_ID, [{ type: "text", text: "😀tail" }])];
		expect(() => readOmittedContentPage(entries, { id: OMITTED_ID, maxBytes: 1 }, () => true)).toThrow(/maxBytes/);
		const page = readOmittedContentPage(entries, { id: OMITTED_ID, maxBytes: 4 }, () => true);
		expect(dataText(page.content)).toBe("😀");
		expect(envelopeNext(page.content)).toEqual({ block: 0, offset: 4 });
	});

	it("preserves original text that looks exactly like a metadata envelope", () => {
		const original = formatOmittedContentEnvelope({ block: 8, offset: 99 });
		const page = readOmittedContentPage(
			[toolResultEntry(OMITTED_ID, [{ type: "text", text: original }])],
			{ id: OMITTED_ID },
			() => true,
		);
		expect(dataText(page.content)).toBe(original);
		expect(envelopeNext(page.content)).toBeNull();
	});

	it("advances across an empty original block without losing later content", () => {
		const entries = [
			toolResultEntry(OMITTED_ID, [
				{ type: "text", text: "" },
				{ type: "text", text: "tail" },
			]),
		];
		const first = readOmittedContentPage(entries, { id: OMITTED_ID }, () => true);
		expect(dataText(first.content)).toBe("");
		expect(envelopeNext(first.content)).toEqual({ block: 1, offset: 0 });
		const last = readOmittedContentPage(entries, { id: OMITTED_ID, ...first.next }, () => true);
		expect(dataText(last.content)).toBe("tail");
		expect(envelopeNext(last.content)).toBeNull();
	});

	it("reports decoded image size correctly with base64 padding", () => {
		expect(decodedBase64ByteLength("YQ==")).toBe(1);
		expect(decodedBase64ByteLength("YWI=")).toBe(2);
	});

	it("advances the cursor only over delivered bytes when a page ends mid-block", () => {
		const original = "abcdefghij";
		const entries = [toolResultEntry(OMITTED_ID, [{ type: "text", text: original }])];
		const first = readOmittedContentPage(entries, { id: OMITTED_ID, maxBytes: 6, offset: 0 }, () => true);
		expect(dataText(first.content)).toBe("abcdef");
		expect(first.next).toEqual({ block: 0, offset: 6 });
		const second = readOmittedContentPage(entries, { id: OMITTED_ID, ...first.next }, () => true);
		expect(dataText(second.content)).toBe("ghij");
		expect(second.next).toBeNull();
	});

	it("emits an exact metadata envelope as the last content block, mirroring page.next", () => {
		const entries = [toolResultEntry(OMITTED_ID, [{ type: "text", text: "hello" }])];
		const page = readOmittedContentPage(entries, { id: OMITTED_ID, maxBytes: 3 }, () => true);
		expect(envelopeText(page.content)).toBe(formatOmittedContentEnvelope(page.next));
		expect(envelopeNext(page.content)).toEqual(page.next);
		expect(page.content[page.content.length - 1].type).toBe("text");
		expect(page.content.length).toBe(2); // one original block + envelope
	});

	it("counts the metadata envelope in the budget and shortens text only as far as fits", () => {
		const original = "x".repeat(200);
		const entries = [toolResultEntry(OMITTED_ID, [{ type: "text", text: original }])];
		const page = readOmittedContentPage(entries, { id: OMITTED_ID, maxBytes: 200 }, fitsWithinChars(100));
		const delivered = dataText(page.content);
		const envelopeChars = envelopeText(page.content).length;
		expect(delivered.length).toBeGreaterThan(0);
		expect(delivered.length).toBeLessThan(200);
		expect(delivered.length + envelopeChars).toBeLessThanOrEqual(100);
		expect(page.next).toEqual({ block: 0, offset: delivered.length });
		// Continuing from the delivered cursor reads exactly the remaining text.
		const rest = readOmittedContentPage(entries, { id: OMITTED_ID, ...page.next, maxBytes: 200 }, () => true);
		expect(delivered + dataText(rest.content)).toBe(original);
	});

	it("keeps the cursor at the same image position when the image is described, never EOF", () => {
		const entries = [toolResultEntry(OMITTED_ID, [PNG_IMAGE])];
		const page = readOmittedContentPage(entries, { id: OMITTED_ID, block: 0 }, () => true);
		const description = dataText(page.content);
		expect(description).toContain("image/png");
		expect(description).toContain("3 bytes");
		expect(page.next).toEqual({ block: 0, offset: 0 });
		expect(envelopeNext(page.content)).toEqual({ block: 0, offset: 0 });
	});

	it("delivers the intact image only when image=true and the full page fits", () => {
		const entries = [toolResultEntry(OMITTED_ID, [PNG_IMAGE])];
		const denied = readOmittedContentPage(entries, { id: OMITTED_ID, block: 0, image: true }, content =>
			content.every(block => block.type === "text"),
		);
		expect(denied.content[0].type).toBe("text");
		expect(denied.next).toEqual({ block: 0, offset: 0 });

		const accepted = readOmittedContentPage(entries, { id: OMITTED_ID, block: 0, image: true }, () => true);
		expect(accepted.content[0]).toEqual(PNG_IMAGE);
		expect(accepted.next).toBeNull();
		expect(envelopeNext(accepted.content)).toBeNull();
	});

	it("returns preserved image bytes without following old URLs or aliasing archive metadata", () => {
		const image: ImageContent = {
			...PNG_IMAGE,
			url: "https://example.invalid/changed.png",
			providerFile: { provider: "anthropic", id: "expired-file" },
		};
		const entries = [toolResultEntry(OMITTED_ID, [image])];
		const page = readOmittedContentPage(entries, { id: OMITTED_ID, image: true }, () => true);
		expect(page.content[0]).toEqual(PNG_IMAGE);
		expect(page.content[0]).not.toBe(image);
		expect(image.url).toBe("https://example.invalid/changed.png");
		expect(envelopeNext(page.content)).toBeNull();
	});

	it("advances past an image to the next block, and EOF only after the last original block", () => {
		const entries = [toolResultEntry(OMITTED_ID, [PNG_IMAGE, { type: "text", text: "tail" }])];
		const imagePage = readOmittedContentPage(entries, { id: OMITTED_ID, block: 0, image: true }, () => true);
		expect(imagePage.next).toEqual({ block: 1, offset: 0 });
		const tailPage = readOmittedContentPage(entries, { id: OMITTED_ID, ...imagePage.next }, () => true);
		expect(dataText(tailPage.content)).toBe("tail");
		expect(tailPage.next).toBeNull();
	});

	it("rejects invalid ids, entry types and missing original content", () => {
		const entries = [
			toolResultEntry(OMITTED_ID, [{ type: "text", text: "hello" }]),
			toolResultEntry("no-original", [{ type: "text", text: "hello" }]),
			userEntry("user-1"),
		];
		// no-original entry loses its omittedOriginal before the read.
		(entries[1] as SessionMessageEntry).message = {
			role: "toolResult",
			toolCallId: "call_no-original",
			toolName: "bash",
			content: [{ type: "text", text: "plain" }],
			isError: false,
			timestamp: 1_752_000_000_000,
		};
		const cases: Array<{ request: Parameters<typeof readOmittedContentPage>[1]; code: OmittedContentError["code"] }> =
			[
				{ request: { id: "" }, code: "invalid_id" },
				{ request: { id: "missing" }, code: "not_found" },
				{ request: { id: "user-1" }, code: "invalid_type" },
				{ request: { id: "no-original" }, code: "invalid_type" },
			];
		for (const { request, code } of cases) {
			let thrown: unknown;
			try {
				readOmittedContentPage(entries, request, () => true);
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(OmittedContentError);
			expect((thrown as OmittedContentError).code).toBe(code);
		}
	});

	it("rejects invalid pagination parameters strictly", () => {
		const entries = [
			toolResultEntry(OMITTED_ID, [{ type: "text", text: "a😀b" }]),
			toolResultEntry("img", [PNG_IMAGE]),
		];
		const cases: Array<{ request: Parameters<typeof readOmittedContentPage>[1]; reason: string }> = [
			{ request: { id: OMITTED_ID, offset: 2 }, reason: "offset inside a 4-byte character" },
			{ request: { id: OMITTED_ID, offset: 6 }, reason: "offset past the end of the text block" },
			{ request: { id: OMITTED_ID, offset: -1 }, reason: "negative offset" },
			{ request: { id: OMITTED_ID, offset: 1.5 }, reason: "non-integer offset" },
			{ request: { id: OMITTED_ID, block: 1 }, reason: "block out of range" },
			{ request: { id: OMITTED_ID, block: -1 }, reason: "negative block" },
			{ request: { id: OMITTED_ID, block: 0.5 }, reason: "non-integer block" },
			{ request: { id: OMITTED_ID, maxBytes: 0 }, reason: "zero maxBytes" },
			{ request: { id: OMITTED_ID, maxBytes: -5 }, reason: "negative maxBytes" },
			{ request: { id: OMITTED_ID, maxBytes: MAX_OMITTED_CONTENT_MAX_BYTES + 1 }, reason: "maxBytes above the cap" },
			{ request: { id: OMITTED_ID, maxBytes: 12.5 }, reason: "non-integer maxBytes" },
			{ request: { id: "img", offset: 1 }, reason: "image blocks are never byte-paginated" },
		];
		for (const { request } of cases) {
			let thrown: unknown;
			try {
				readOmittedContentPage(entries, request, () => true);
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(OmittedContentError);
			expect((thrown as OmittedContentError).code).toBe("invalid_param");
		}
	});
});

describe("ReadOmittedContentTool", () => {
	it("does not spill or merge a bounded original page when generic output limits are lower", async () => {
		const original = "retained original line\n".repeat(80);
		const entry = toolResultEntry(OMITTED_ID, [{ type: "text", text: original }]);
		const tool = wrapToolWithMetaNotice(
			new ReadOmittedContentTool(
				stubSession({
					authorized: () => true,
					entries: () => [entry],
					fits: () => true,
				}),
			),
		);
		const manager = SessionManager.inMemory();
		const spill = vi.spyOn(manager, "saveArtifact").mockResolvedValue("unexpected-spill");
		const context = {
			sessionManager: manager,
			settings: Settings.isolated({ "tools.artifactSpillThreshold": 128 }),
			// Minimal AgentToolContext: only settings + sessionManager are used
			// by this test; no other context capability is invoked.
		} as unknown as AgentToolContext;
		const result = await tool.execute("recall-wrapped", { id: OMITTED_ID }, undefined, undefined, context);
		expect(dataText(result.content)).toBe(original);
		expect(envelopeNext(result.content)).toBeNull();
		expect(spill).not.toHaveBeenCalled();
	});

	it("returns the page content with details.recall mirroring the envelope", async () => {
		const entry = toolResultEntry(OMITTED_ID, [{ type: "text", text: "hello" }]);
		const tool = new ReadOmittedContentTool(
			stubSession({
				authorized: () => true,
				entries: () => [entry],
				fits: () => true,
			}),
		);
		const result = await tool.execute("call-1", { id: OMITTED_ID });
		expect(dataText(result.content)).toBe("hello");
		expect(result.content[result.content.length - 1].type).toBe("text");
		expect(envelopeNext(result.content)).toBeNull();
		expect(result.details?.recall).toEqual({
			kind: "text",
			block: 0,
			offset: 0,
			originalBytes: 5,
			eof: true,
		});
	});

	it("returns image and description recall kinds for image blocks", async () => {
		// A large-enough payload so a size-capped fits accepts the bounded
		// description page but rejects the intact-image page.
		const original: ImageContent = { type: "image", data: "A".repeat(200), mimeType: "image/png" };
		const entry = toolResultEntry(OMITTED_ID, [original]);
		const tool = new ReadOmittedContentTool(
			stubSession({
				authorized: () => true,
				entries: () => [entry],
				fits: () => true,
			}),
		);
		const image = await tool.execute("call-1", { id: OMITTED_ID, block: 0, image: true });
		expect(image.content[0]).toEqual(original);
		expect(image.details?.recall).toEqual({ kind: "image", block: 0, offset: 0, imageBytes: 150, eof: true });

		const toolDenied = new ReadOmittedContentTool(
			stubSession({
				authorized: () => true,
				entries: () => [entry],
				fits: fitsWithinChars(250),
			}),
		);
		const described = await toolDenied.execute("call-2", { id: OMITTED_ID, block: 0, image: true });
		expect(described.content[0].type).toBe("text");
		expect(described.details?.recall).toEqual({
			kind: "description",
			block: 0,
			offset: 0,
			imageBytes: 150,
			eof: false,
		});
	});

	it("rejects a page when even its continuation cannot fit rather than returning an unbounded fallback", async () => {
		const entry = toolResultEntry(OMITTED_ID, [{ type: "text", text: "hello" }]);
		const tool = new ReadOmittedContentTool(
			stubSession({
				authorized: () => true,
				entries: () => [entry],
				fits: () => false,
			}),
		);
		await expect(tool.execute("call-1", { id: OMITTED_ID })).rejects.toThrow(/budget_exceeded/);
	});

	it("enforces live authorization and current-branch availability at execute time", async () => {
		const entry = toolResultEntry(OMITTED_ID, [{ type: "text", text: "hello" }]);
		const notAuthorized = new ReadOmittedContentTool(
			stubSession({
				authorized: () => false,
				entries: () => [entry],
				fits: () => true,
			}),
		);
		await expect(notAuthorized.execute("call-1", { id: OMITTED_ID })).rejects.toThrow(/not authorized/);

		const noBranch = new ReadOmittedContentTool(
			stubSession({
				authorized: () => true,
				entries: () => undefined,
				fits: () => true,
			}),
		);
		await expect(noBranch.execute("call-2", { id: OMITTED_ID })).rejects.toThrow(/no current branch/);

		const unavailable = new ReadOmittedContentTool(stubSession());
		await expect(unavailable.execute("call-3", { id: OMITTED_ID })).rejects.toThrow(ToolError);
	});

	it("converts invalid requests into ToolError via existing conventions", async () => {
		const entry = toolResultEntry(OMITTED_ID, [{ type: "text", text: "hello" }]);
		const tool = new ReadOmittedContentTool(
			stubSession({
				authorized: () => true,
				entries: () => [entry],
				fits: () => true,
			}),
		);
		await expect(tool.execute("call-1", { id: "not-there" })).rejects.toThrow(/not_found/);
		await expect(tool.execute("call-2", { id: OMITTED_ID, offset: 99 })).rejects.toThrow(/invalid_param/);
	});
});

describe("tool registration and tool sets", () => {
	it("does not advertise recovery when an embedding cannot serve original content", async () => {
		const tools = await createTools(stubSession());
		expect(tools.map(tool => tool.name)).not.toContain("read_omitted_content");
	});

	it("includes read_omitted_content in the default tool set", async () => {
		const tools = await createTools(stubSession({ authorized: () => true, entries: () => [], fits: () => true }));
		const names = tools.map(tool => tool.name);
		expect(names).toContain("read_omitted_content");
		expect(tools.find(tool => tool.name === "read_omitted_content")).toBeInstanceOf(ReadOmittedContentTool);
	});

	it("does not widen an explicit tool subset with read_omitted_content", async () => {
		const tools = await createTools(stubSession(), ["read"]);
		expect(tools.map(tool => tool.name)).not.toContain("read_omitted_content");
	});

	it("includes read_omitted_content when an explicit subset names it", async () => {
		const tools = await createTools(stubSession({ authorized: () => true, entries: () => [], fits: () => true }), [
			"read_omitted_content",
		]);
		expect(tools.map(tool => tool.name)).toContain("read_omitted_content");
	});
});
