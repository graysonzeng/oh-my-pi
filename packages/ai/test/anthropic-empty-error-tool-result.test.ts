import { describe, expect, it } from "bun:test";
import { convertAnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { AssistantMessage, Model, ModelSpec, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const baseModel: Omit<ModelSpec<"anthropic-messages">, "provider" | "baseUrl"> = {
	api: "anthropic-messages",
	id: "claude-sonnet-4-6",
	name: "Claude Sonnet 4.6",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	maxTokens: 8192,
	contextWindow: 200000,
	reasoning: false,
};

const anthropicModel: Model<"anthropic-messages"> = buildModel({
	...baseModel,
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
});

const visionModel: Model<"anthropic-messages"> = buildModel({
	...baseModel,
	input: ["text", "image"],
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
});

const user: UserMessage = {
	role: "user",
	content: "run the tool",
	timestamp: Date.now(),
};

const assistant: AssistantMessage = {
	role: "assistant",
	content: [
		{
			type: "toolCall",
			id: "toolu_empty_error",
			name: "bash",
			arguments: { command: "true" },
		},
	],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet-4-6",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "toolUse",
	timestamp: Date.now(),
};

function getToolResultBlock(
	model: Model<"anthropic-messages">,
	toolResult: ToolResultMessage,
): Record<string, unknown> {
	const params = convertAnthropicMessages([user, assistant, toolResult], model, false);
	const last = params.at(-1);
	expect(last?.role).toBe("user");
	const blocks = last?.content as unknown as Array<Record<string, unknown>>;
	expect(Array.isArray(blocks)).toBe(true);
	const block = blocks.find(b => b.type === "tool_result");
	expect(block).toBeDefined();
	return block as Record<string, unknown>;
}

describe("anthropic empty error tool_result encoding", () => {
	it("retains whitespace-only recovered bytes before the visible continuation on the wire", () => {
		const original = " \t\r\n ";
		const envelope = '<omitted_content_meta>{"next":{"block":0,"offset":5}}</omitted_content_meta>';
		const block = getToolResultBlock(visionModel, {
			role: "toolResult",
			toolCallId: "toolu_empty_error",
			toolName: "read_omitted_content",
			content: [
				{ type: "text", text: original },
				{ type: "text", text: envelope },
			],
			isError: false,
			timestamp: 1,
		});
		expect(block.content).toEqual([{ type: "text", text: `${original}\n${envelope}` }]);
	});

	it("sends only visible tool content when recoverable text and images are stored", () => {
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "toolu_empty_error",
			toolName: "bash",
			content: [{ type: "text", text: "Omitted result; read entry original-1." }],
			omittedOriginal: [
				{ type: "text", text: "stored original that must not consume the request budget" },
				{ type: "image", data: "c3RvcmVkLWltYWdl", mimeType: "image/png" },
			],
			isError: false,
			timestamp: 1,
		};

		const block = getToolResultBlock(visionModel, toolResult);
		expect(block).toEqual({
			type: "tool_result",
			tool_use_id: "toolu_empty_error",
			content: [{ type: "text", text: "Omitted result; read entry original-1." }],
			is_error: false,
		});
	});

	it("fills whitespace-only error tool results so Anthropic does not 400", () => {
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "toolu_empty_error",
			toolName: "bash",
			content: [{ type: "text", text: "\n\n\n\n\n" }],
			isError: true,
			timestamp: Date.now(),
		};

		const block = getToolResultBlock(anthropicModel, toolResult);
		expect(block.is_error).toBe(true);
		expect(block.content).toBe("Tool failed with no output.");
	});

	it("leaves successful whitespace-only tool results unchanged", () => {
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "toolu_empty_error",
			toolName: "bash",
			content: [{ type: "text", text: "   \n\t" }],
			isError: false,
			timestamp: Date.now(),
		};

		const block = getToolResultBlock(anthropicModel, toolResult);
		expect(block.is_error).toBe(false);
		expect(block.content).toBe("");
	});

	it("encodes empty successful tool results as empty string, not empty array, on image-capable models", () => {
		// Regression: vision-capable models serialize whitespace-only successful
		// tool results as `content: []` on the wire. Official Anthropic accepts it,
		// but strict Anthropic-compatible endpoints (Z.AI GLM, api.z.ai/api/anthropic)
		// reject the whole request with 400 code 1213 ("The prompt parameter was
		// not received normally"). `content: ""` is accepted by both.
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "toolu_empty_error",
			toolName: "write",
			content: [{ type: "text", text: "" }],
			isError: false,
			timestamp: Date.now(),
		};

		const block = getToolResultBlock(visionModel, toolResult);
		expect(block.is_error).toBe(false);
		expect(block.content).toBe("");
	});
});
