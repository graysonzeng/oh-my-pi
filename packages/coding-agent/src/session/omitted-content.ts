import type { SessionEntry } from "@oh-my-pi/pi-agent-core/compaction/entries";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { isBlobRef } from "./blob-store";

export const DEFAULT_OMITTED_CONTENT_MAX_BYTES = 8192;
export const MAX_OMITTED_CONTENT_MAX_BYTES = 32768;
export const OMITTED_CONTENT_META_PREFIX = "<omitted_content_meta>";
export const OMITTED_CONTENT_META_SUFFIX = "</omitted_content_meta>";

export interface OmittedContentCursor {
	block: number;
	offset: number;
}

export interface OmittedContentRequest {
	id: string;
	block?: number;
	/** UTF-8 byte offset, not a JavaScript string index. */
	offset?: number;
	maxBytes?: number;
	image?: boolean;
}

export interface OmittedContentPage {
	content: (TextContent | ImageContent)[];
	next: OmittedContentCursor | null;
}

/** Includes the entire next request, including the page's visible envelope. */
export type OmittedContentFitCheck = (content: readonly (TextContent | ImageContent)[]) => boolean;
export type OmittedContentErrorCode = "invalid_id" | "invalid_type" | "invalid_param" | "not_found" | "budget_exceeded";

export class OmittedContentError extends Error {
	constructor(
		readonly code: OmittedContentErrorCode,
		message: string,
	) {
		super(message);
		this.name = "OmittedContentError";
	}
}

export function utf8ByteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/** Locate a byte boundary without allocating a UTF-8 copy of the entire original. */
function textIndexAtByte(text: string, offset: number): number {
	let bytes = 0;
	let index = 0;
	while (index < text.length && bytes < offset) {
		const point = text.codePointAt(index)!;
		bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
		index += point > 0xffff ? 2 : 1;
	}
	if (bytes !== offset) {
		throw new OmittedContentError(
			"invalid_param",
			"offset must be within the text block at a UTF-8 character boundary",
		);
	}
	return index;
}

/** A bounded original substring, never a decoded/re-encoded copy. */
export function cutUtf8Prefix(text: string, maxBytes: number): string {
	let bytes = 0;
	let index = 0;
	while (index < text.length) {
		const point = text.codePointAt(index)!;
		const size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
		if (bytes + size > maxBytes) break;
		bytes += size;
		index += point > 0xffff ? 2 : 1;
	}
	return text.slice(0, index);
}

export function formatOmittedContentEnvelope(next: OmittedContentCursor | null): string {
	return `${OMITTED_CONTENT_META_PREFIX}${JSON.stringify({ next })}${OMITTED_CONTENT_META_SUFFIX}`;
}

/** Only the last, separately emitted block is authoritative; original text can contain these delimiters too. */
export function isOmittedContentEnvelopeBlock(block: TextContent | ImageContent): boolean {
	return (
		block.type === "text" &&
		block.text.startsWith(OMITTED_CONTENT_META_PREFIX) &&
		block.text.endsWith(OMITTED_CONTENT_META_SUFFIX)
	);
}

export function decodedBase64ByteLength(data: string): number {
	let characters = 0;
	for (let index = 0; index < data.length; index++) {
		const code = data.charCodeAt(index);
		if (code !== 61 && code !== 32 && code !== 9 && code !== 10 && code !== 13) characters++;
	}
	return Math.floor((characters * 3) / 4);
}

function resolveRequest(
	entries: readonly SessionEntry[],
	request: OmittedContentRequest,
): {
	original: (TextContent | ImageContent)[];
	block: number;
	offset: number;
	maxBytes: number;
	image: boolean;
} {
	if (!request || typeof request !== "object" || Array.isArray(request)) {
		throw new OmittedContentError("invalid_param", "request must be an object");
	}
	for (const key of Object.keys(request)) {
		if (key !== "id" && key !== "block" && key !== "offset" && key !== "maxBytes" && key !== "image") {
			throw new OmittedContentError("invalid_param", "unknown request parameter");
		}
	}
	if (typeof request.id !== "string" || request.id.length === 0) {
		throw new OmittedContentError("invalid_id", "id must be a non-empty entry id");
	}
	const entry = entries.find(candidate => candidate.id === request.id);
	if (!entry) throw new OmittedContentError("not_found", "entry is not on the current branch");
	if (
		entry.type !== "message" ||
		entry.message.role !== "toolResult" ||
		!Array.isArray(entry.message.omittedOriginal) ||
		entry.message.omittedOriginal.length === 0
	) {
		throw new OmittedContentError("invalid_type", "entry has no omitted original tool-result content");
	}
	const original = entry.message.omittedOriginal;
	const block = request.block === undefined ? 0 : request.block;
	const offset = request.offset === undefined ? 0 : request.offset;
	const maxBytes = request.maxBytes === undefined ? DEFAULT_OMITTED_CONTENT_MAX_BYTES : request.maxBytes;
	const image = request.image === undefined ? false : request.image;
	if (!Number.isSafeInteger(block) || block < 0 || block >= original.length) {
		throw new OmittedContentError("invalid_param", "block must identify an original content block");
	}
	if (!Number.isSafeInteger(offset) || offset < 0) {
		throw new OmittedContentError("invalid_param", "offset must be a non-negative safe integer");
	}
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_OMITTED_CONTENT_MAX_BYTES) {
		throw new OmittedContentError(
			"invalid_param",
			`maxBytes must be an integer in [1, ${MAX_OMITTED_CONTENT_MAX_BYTES}]`,
		);
	}
	if (typeof image !== "boolean") throw new OmittedContentError("invalid_param", "image must be a boolean");
	const selected = original[block];
	if (!selected || (selected.type !== "text" && selected.type !== "image")) {
		throw new OmittedContentError("invalid_type", "original block is neither text nor an image");
	}
	if (selected.type === "text") {
		if (typeof selected.text !== "string")
			throw new OmittedContentError("invalid_type", "invalid original text block");
		textIndexAtByte(selected.text, offset);
		if (selected.text.length > 0 && offset >= utf8ByteLength(selected.text)) {
			throw new OmittedContentError("invalid_param", "offset is past the end of the text block");
		}
	} else {
		if (typeof selected.data !== "string" || typeof selected.mimeType !== "string")
			throw new OmittedContentError("invalid_type", "invalid original image block");
		if (isBlobRef(selected.data))
			throw new OmittedContentError(
				"not_found",
				"original image blob is unavailable; its stored reference is retained",
			);
		if (offset !== 0)
			throw new OmittedContentError("invalid_param", "images are not byte-paginated; offset must be 0");
	}
	return { original, block, offset, maxBytes, image };
}

export function omittedContentBlockAt(
	entries: readonly SessionEntry[],
	request: OmittedContentRequest,
): TextContent | ImageContent {
	const { original, block } = resolveRequest(entries, request);
	return original[block];
}

/** Every returned page fits. An impossible metadata-only page stops admission rather than advancing a cursor. */
export function readOmittedContentPage(
	entries: readonly SessionEntry[],
	request: OmittedContentRequest,
	fits: OmittedContentFitCheck,
): OmittedContentPage {
	const { original, block, offset, maxBytes, image } = resolveRequest(entries, request);
	const selected = original[block];
	const afterBlock = block + 1 < original.length ? { block: block + 1, offset: 0 } : null;
	const page = (data: TextContent | ImageContent, next: OmittedContentCursor | null): OmittedContentPage => ({
		content: [data, { type: "text", text: formatOmittedContentEnvelope(next) }],
		next,
	});
	if (selected.type === "image") {
		if (image) {
			// Force the preserved bytes, not a potentially changed URL or an
			// expired provider-file reference; never alias the archived block.
			const { url: _url, providerFile: _providerFile, ...originalImage } = selected;
			const result = page(originalImage, afterBlock);
			if (fits(result.content)) return result;
		}
		const result = page(
			{
				type: "text",
				text: `Omitted image block ${block} (${selected.mimeType.slice(0, 120)}, ${decodedBase64ByteLength(selected.data)} bytes). Request image: true to retrieve the intact image when the request budget permits.`,
			},
			{ block, offset: 0 },
		);
		if (fits(result.content)) return result;
		throw new OmittedContentError(
			"budget_exceeded",
			"image description and continuation do not fit the next request",
		);
	}

	const totalBytes = utf8ByteLength(selected.text);
	const start = textIndexAtByte(selected.text, offset);
	// At most maxBytes UTF-16 units are needed for maxBytes UTF-8 bytes.
	const bounded = cutUtf8Prefix(selected.text.slice(start, start + maxBytes), maxBytes);
	if (bounded.length === 0 && totalBytes > offset) {
		throw new OmittedContentError(
			"invalid_param",
			"maxBytes cannot hold the next complete UTF-8 character; increase maxBytes",
		);
	}
	const textPage = (text: string): OmittedContentPage => {
		const end = offset + utf8ByteLength(text);
		return page({ type: "text", text }, end < totalBytes ? { block, offset: end } : afterBlock);
	};
	const full = textPage(bounded);
	if (fits(full.content)) return full;
	let accepted = textPage("");
	if (!fits(accepted.content))
		throw new OmittedContentError("budget_exceeded", "continuation does not fit the next request");
	let low = 0;
	let high = utf8ByteLength(bounded);
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		const candidate = textPage(cutUtf8Prefix(bounded, mid));
		if (fits(candidate.content)) {
			low = mid;
			accepted = candidate;
		} else {
			high = mid - 1;
		}
	}
	return accepted;
}
