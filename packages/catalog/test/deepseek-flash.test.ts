import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { DEEPSEEK_CURATED_FALLBACK_MODELS } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

describe("DeepSeek V4.1 Flash curated seed", () => {
	test("ships the official deepseek-flash card with vision, Flash limits, and off-peak pricing", () => {
		expect(DEEPSEEK_CURATED_FALLBACK_MODELS).toHaveLength(1);
		const seed = DEEPSEEK_CURATED_FALLBACK_MODELS[0];
		if (!seed) throw new Error("expected deepseek-flash seed");

		expect(seed).toMatchObject({
			id: "deepseek-flash",
			name: "DeepSeek V4.1 Flash",
			provider: "deepseek",
			api: "openai-completions",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 384_000,
		});

		const model = buildModel(seed);
		expect(model.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Max],
			defaultLevel: Effort.Max,
			requiresEffort: true,
		});
		expect(model.tokenizer).toBe("deepseek-v3");
		expect(model.input).toEqual(["text", "image"]);
	});
});
