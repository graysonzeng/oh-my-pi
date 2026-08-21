import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const CUMULATIVE_REASONING = [
	"The user wants",
	"The user wants me to fix",
	"The user wants me to fix why clicking to show spend data shows unavailable.",
] as const;

function buildTestModel(id: string, provider: string): Model<"openai-completions"> {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://gateway.example/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
	} satisfies ModelSpec<"openai-completions">);
}

function sseResponse(reasoningSnapshots: readonly string[]): Response {
	const chunks: Array<Record<string, unknown>> = reasoningSnapshots.map(reasoning => ({
		id: "chatcmpl-grok-test",
		model: "grok-4.6",
		choices: [{ index: 0, delta: { reasoning_content: reasoning }, finish_reason: null }],
	}));
	chunks.push({
		id: "chatcmpl-grok-test",
		model: "grok-4.6",
		choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
	});
	const body = `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

async function collectThinking(model: Model<"openai-completions">, snapshots: readonly string[]): Promise<string> {
	const context: Context = {
		systemPrompt: [],
		messages: [{ role: "user", content: "Fix the issue.", timestamp: Date.now() }],
	};
	const stream = streamOpenAICompletions(model, context, {
		apiKey: "test-key",
		fetch: async () => sseResponse(snapshots),
	});
	let thinking = "";
	for await (const event of stream) {
		if (event.type === "thinking_delta") thinking += event.delta;
	}
	return thinking;
}

describe("gateway Grok cumulative reasoning", () => {
	it("emits only the new suffix of cumulative reasoning snapshots", async () => {
		const model = buildTestModel("grok-4.6", "gateway");

		expect(model.compat.reasoningDeltasMayBeCumulative).toBe(true);
		expect(await collectThinking(model, CUMULATIVE_REASONING)).toBe(CUMULATIVE_REASONING[2]);
	});

	it("does not enable cumulative handling for unrelated gateways", async () => {
		const model = buildTestModel("ordinary-model", "test-gateway");

		expect(model.compat.reasoningDeltasMayBeCumulative).toBe(false);
		expect(await collectThinking(model, ["first ", "second"])).toBe("first second");
	});
});
