import { describe, expect, it } from "bun:test";
import {
	generateSummary,
	REQUIRED_CHECKPOINT_SUMMARY_HEADINGS,
	validateCheckpointSummaryStructure,
} from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

function completeSummary(): string {
	return REQUIRED_CHECKPOINT_SUMMARY_HEADINGS.map(h => `${h}\nNone`).join("\n\n");
}

function makeModel(): Model {
	return buildModel({
		id: "gpt-5",
		name: "GPT-5",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_000,
	});
}

function assistantText(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5",
		stopReason: "stop",
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

describe("validateCheckpointSummaryStructure", () => {
	it("accepts summaries with every required heading (None allowed)", () => {
		expect(() => validateCheckpointSummaryStructure(completeSummary())).not.toThrow();
	});

	it("throws a clear summarization error when a heading is missing", () => {
		const incomplete = completeSummary().replace("## Verification\nNone\n\n", "");
		expect(() => validateCheckpointSummaryStructure(incomplete)).toThrow(
			/Summarization failed: checkpoint summary missing required heading\(s\): ## Verification/,
		);
	});
});

describe("generateSummary default schema enforcement", () => {
	it("rejects incomplete local default summaries", async () => {
		await expect(
			generateSummary(
				[{ role: "user", content: "hi", timestamp: Date.now() }],
				makeModel(),
				4_000,
				"test-key",
				undefined,
				undefined,
				undefined,
				{
					completeImpl: async () => assistantText("## Goal\nNone\n\n## Next Steps\n1. continue"),
				},
			),
		).rejects.toThrow(/missing required heading/);
	});

	it("accepts complete local default summaries", async () => {
		const summary = await generateSummary(
			[{ role: "user", content: "hi", timestamp: Date.now() }],
			makeModel(),
			4_000,
			"test-key",
			undefined,
			undefined,
			undefined,
			{
				completeImpl: async () => assistantText(completeSummary()),
			},
		);
		expect(summary).toContain("## Artifact & Source Pointers");
	});

	it("does not enforce default schema under promptOverride", async () => {
		const summary = await generateSummary(
			[{ role: "user", content: "hi", timestamp: Date.now() }],
			makeModel(),
			4_000,
			"test-key",
			undefined,
			undefined,
			undefined,
			{
				promptOverride: "Write free-form notes only.",
				completeImpl: async () => assistantText("free form, no headings"),
			},
		);
		expect(summary).toBe("free form, no headings");
	});

	it("validates remote default summaries too", async () => {
		await expect(
			generateSummary(
				[{ role: "user", content: "hi", timestamp: Date.now() }],
				makeModel(),
				4_000,
				"test-key",
				undefined,
				undefined,
				undefined,
				{
					remoteEndpoint: "https://example.test/compact",
					fetch: (async () =>
						new Response(JSON.stringify({ summary: "## Goal\nOnly goal" }), {
							status: 200,
							headers: { "content-type": "application/json" },
						})) as unknown as typeof fetch,
				},
			),
		).rejects.toThrow(/missing required heading/);
	});
});
