import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import readOmittedContentDescription from "../prompts/tools/read-omitted-content.md" with { type: "text" };
import {
	DEFAULT_OMITTED_CONTENT_MAX_BYTES,
	decodedBase64ByteLength,
	MAX_OMITTED_CONTENT_MAX_BYTES,
	OmittedContentError,
	type OmittedContentFitCheck,
	type OmittedContentPage,
	omittedContentBlockAt,
	readOmittedContentPage,
	utf8ByteLength,
} from "../session/omitted-content";
import type { ToolSession } from "./index";
import { ToolError, throwIfAborted } from "./tool-errors";

const readOmittedContentSchema = type({
	id: type("string").describe("Entry id whose omitted original content is read."),
	"block?": type("number").describe(
		"Index of the original content block to read (default 0). Text blocks paginate by UTF-8 byte offset; image blocks never paginate.",
	),
	"offset?": type("number").describe("UTF-8 byte offset into a text block; must be a character boundary (default 0)."),
	"maxBytes?": type("number").describe(
		`Maximum text bytes per page (default ${DEFAULT_OMITTED_CONTENT_MAX_BYTES}, maximum ${MAX_OMITTED_CONTENT_MAX_BYTES}).`,
	),
	"image?": type("boolean").describe(
		"Set true to receive the original image for an image block instead of its bounded description.",
	),
	"+": "reject",
});

export type ReadOmittedContentParams = typeof readOmittedContentSchema.infer;

export type ReadOmittedContentRecallKind = "text" | "image" | "description" | "deferred";

/** Structured continuation metadata mirrored alongside the visible envelope. */
export interface ReadOmittedContentRecall {
	kind: ReadOmittedContentRecallKind;
	/** Block this page read from (or would read from); never advanced by a denied image or deferred page. */
	block: number;
	/** UTF-8 byte offset this text page started at; 0 for image positions. */
	offset: number;
	/** Delivered original text bytes in this page (kind "text" only). */
	originalBytes?: number;
	/** Decoded size of the image in bytes (kinds "image" and "description"). */
	imageBytes?: number;
	/** True iff the visible envelope reports EOF (all original data delivered). */
	eof: boolean;
}

export interface ReadOmittedContentDetails {
	recall: ReadOmittedContentRecall;
}

function toOmittedContentToolError(error: unknown): ToolError {
	if (error instanceof OmittedContentError) {
		return new ToolError(`read_omitted_content: ${error.code}: ${error.message}`, {
			errorCategory:
				error.code === "invalid_param" || error.code === "invalid_id"
					? "validation"
					: error.code === "budget_exceeded"
						? undefined
						: "not_found",
		});
	}
	return new ToolError(error instanceof Error ? error.message : String(error));
}

function recallForTextPage(page: OmittedContentPage, params: ReadOmittedContentParams): ReadOmittedContentRecall {
	const first = page.content[0];
	return {
		kind: "text",
		block: params.block ?? 0,
		offset: params.offset ?? 0,
		originalBytes: first.type === "text" ? utf8ByteLength(first.text) : 0,
		eof: page.next === null,
	};
}

function recallForImagePage(page: OmittedContentPage, image: ImageContent, block: number): ReadOmittedContentRecall {
	return {
		kind: "image",
		block,
		offset: 0,
		imageBytes: decodedBase64ByteLength(page.content[0].type === "image" ? page.content[0].data : image.data),
		eof: page.next === null,
	};
}

export class ReadOmittedContentTool implements AgentTool<typeof readOmittedContentSchema, ReadOmittedContentDetails> {
	readonly name = "read_omitted_content";
	readonly label = "Read omitted content";
	readonly summary = "Page through original tool-output text or images recovered by structured compaction";
	readonly description = readOmittedContentDescription;
	readonly parameters = readOmittedContentSchema;
	readonly strict = true;
	readonly intent = "omit" as const;
	readonly approval = "read" as const;
	readonly concurrency = "shared" as const;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: ReadOmittedContentParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<ReadOmittedContentDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<ReadOmittedContentDetails>> {
		throwIfAborted(signal);
		const recall = this.session.readOmittedContent;
		if (!recall) {
			throw new ToolError("read_omitted_content: recovery is unavailable in this session", {
				errorCategory: "permission",
			});
		}
		// Dynamic real-permission check: the tool may have been removed from the
		// live tool set while the session is running. This is a precondition, not
		// the final admission — the agent loop re-admits serially at emission.
		if (!recall.authorized()) {
			throw new ToolError("read_omitted_content: not authorized in the current tool set", {
				errorCategory: "permission",
			});
		}
		const entries = recall.entries();
		if (!entries) {
			throw new ToolError("read_omitted_content: no current branch available to read from", {
				errorCategory: "not_found",
			});
		}
		const fits: OmittedContentFitCheck = content => recall.fits(content);
		let page: OmittedContentPage;
		try {
			page = readOmittedContentPage(entries, params, fits);
		} catch (error) {
			throw toOmittedContentToolError(error);
		}
		// Final admission rechecks against accepted, not-yet-merged tool results.
		if (!fits(page.content)) {
			throw new ToolError("read_omitted_content: budget_exceeded: page no longer fits the next request");
		}

		const target = omittedContentBlockAt(entries, params);
		const details: ReadOmittedContentRecall =
			target.type === "image"
				? page.content[0].type === "image"
					? recallForImagePage(page, target, params.block ?? 0)
					: {
							kind: "description",
							block: params.block ?? 0,
							offset: 0,
							imageBytes: decodedBase64ByteLength(target.data),
							eof: false,
						}
				: recallForTextPage(page, params);
		return { content: page.content, details: { recall: details } };
	}
}
