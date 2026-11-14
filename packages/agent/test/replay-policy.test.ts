import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { normalizeMessagesForProvider } from "../src/agent-loop";
import { filterProviderReplayMessages } from "../src/replay-policy";

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const source: AssistantMessage = {
	role: "assistant",
	content: [
		{ type: "thinking", thinking: "private reasoning", thinkingSignature: "signed-reasoning" },
		{ type: "text", text: "portable answer", textSignature: "provider-text-id" },
		{
			type: "toolCall",
			id: "call-1",
			name: "read",
			arguments: { path: "README.md" },
			thoughtSignature: "gemini-thought-signature",
			customWireName: "provider-read",
		},
		{ type: "redactedThinking", data: "encrypted-provider-state" },
	],
	api: "openai-responses",
	provider: "openai",
	model: "gpt-5",
	responseId: "response-1",
	providerPayload: { type: "openaiResponsesHistory", items: [{ id: "opaque-item" }] },
	usage,
	stopReason: "toolUse",
	timestamp: 1,
};

const exactOwner = {
	provider: "openai",
	id: "gpt-5",
	api: "openai-responses",
} satisfies Pick<Model, "provider" | "id" | "api">;
const foreignApi = {
	provider: "openai",
	id: "gpt-5",
	api: "openai-completions",
} satisfies Pick<Model, "provider" | "id" | "api">;

describe("provider replay ownership", () => {
	it("replays exact-owner state byte-for-byte and restores it after a foreign provider view", () => {
		const exact = filterProviderReplayMessages([source], exactOwner);
		expect(exact[0]).toBe(source);

		const foreign = filterProviderReplayMessages([source], foreignApi);
		expect(foreign).toHaveLength(1);
		const foreignAssistant = foreign[0];
		expect(foreignAssistant?.role).toBe("assistant");
		if (foreignAssistant?.role !== "assistant") throw new Error("expected assistant replay");
		expect(foreignAssistant.providerPayload).toBeUndefined();
		expect(foreignAssistant.responseId).toBeUndefined();
		expect(
			foreignAssistant.content.some(block => block.type === "thinking" || block.type === "redactedThinking"),
		).toBe(false);
		const text = foreignAssistant.content.find(block => block.type === "text");
		expect(text).toEqual({ type: "text", text: "portable answer" });
		const toolCall = foreignAssistant.content.find(block => block.type === "toolCall");
		expect(toolCall).toEqual({ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } });

		// Provider views never mutate the persisted SSOT, so switching back restores native replay.
		expect(source.providerPayload).toEqual({ type: "openaiResponsesHistory", items: [{ id: "opaque-item" }] });
		expect(filterProviderReplayMessages([source], exactOwner)[0]).toBe(source);
	});

	it("applies owner filtering at the agent-loop provider request boundary", () => {
		const target = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!target) throw new Error("expected bundled Anthropic model");
		const normalized = normalizeMessagesForProvider([source], target);
		expect(normalized).toHaveLength(1);
		const replay = normalized[0];
		if (replay?.role !== "assistant") throw new Error("expected assistant replay");
		expect(replay.providerPayload).toBeUndefined();
		expect(replay.content.some(block => block.type === "thinking" || block.type === "redactedThinking")).toBe(false);
	});

	it("drops terminal provider refusals for every owner", () => {
		const refusal: AssistantMessage = {
			...source,
			content: [{ type: "text", text: "refused" }],
			stopReason: "error",
			stopDetails: { type: "refusal" },
		};
		expect(filterProviderReplayMessages([refusal], exactOwner)).toEqual([]);
	});
});
