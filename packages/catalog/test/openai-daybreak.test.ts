import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { OPENAI_CURATED_FALLBACK_MODELS } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { Api, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { applyGeneratedModelPolicies } from "../scripts/generated-policies";

const DAYBREAK_EFFORTS = [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max];

describe("OpenAI Daybreak, GPT-5.6, and GPT-6 models", () => {
	test("curates the documented aliases, Cyber snapshot, and GPT-6 Astra with standard API pricing", () => {
		const byId = Object.fromEntries(OPENAI_CURATED_FALLBACK_MODELS.map(model => [model.id, model]));
		expect(Object.keys(byId)).toEqual([
			"daybreak-blue-latest",
			"daybreak-red-latest",
			"gpt-5.6-cyber",
			"gpt-6-astra",
		]);
		expect(byId["daybreak-blue-latest"]).toMatchObject({
			name: "Daybreak Blue",
			cost: {
				input: 5,
				output: 30,
				cacheRead: 0.5,
				cacheWrite: 6.25,
				longContext: {
					inputThreshold: 272_000,
					input: 10,
					output: 45,
					cacheRead: 1,
					cacheWrite: 12.5,
				},
			},
			contextWindow: 1_050_000,
			maxTokens: 128_000,
		});
		for (const id of ["daybreak-red-latest", "gpt-5.6-cyber"]) {
			expect(byId[id]).toMatchObject({
				cost: { input: 12.5, output: 75, cacheRead: 1.25, cacheWrite: 15.625 },
				contextWindow: 400_000,
				maxTokens: 128_000,
			});
		}
		expect(byId["gpt-6-astra"]).toMatchObject({
			name: "GPT-6 Astra",
			cost: {
				input: 10,
				output: 50,
				cacheRead: 1,
				cacheWrite: 12.5,
				longContext: {
					inputThreshold: 272_000,
					input: 20,
					output: 75,
					cacheRead: 2,
					cacheWrite: 25,
				},
			},
			contextWindow: 1_050_000,
			maxTokens: 128_000,
			thinking: { requiresEffort: true },
		});
	});

	test("bakes off support and long-context pricing onto every first-party GPT-5.6 alias", () => {
		const longContextCosts = {
			"daybreak-blue-latest": { input: 10, output: 45, cacheRead: 1, cacheWrite: 12.5 },
			"gpt-5.6": { input: 10, output: 45, cacheRead: 1, cacheWrite: 12.5 },
			"gpt-5.6-luna": { input: 0.4, output: 1.8, cacheRead: 0.04, cacheWrite: 0.5 },
			"gpt-5.6-luna-pro": { input: 0.4, output: 1.8, cacheRead: 0.04, cacheWrite: 0.5 },
			"gpt-5.6-sol": { input: 10, output: 45, cacheRead: 1, cacheWrite: 12.5 },
			"gpt-5.6-sol-pro": { input: 10, output: 45, cacheRead: 1, cacheWrite: 12.5 },
			"gpt-5.6-terra": { input: 4, output: 18, cacheRead: 0.4, cacheWrite: 5 },
			"gpt-5.6-terra-pro": { input: 4, output: 18, cacheRead: 0.4, cacheWrite: 5 },
		} as const;
		for (const [id, longContext] of Object.entries(longContextCosts)) {
			const model = getBundledModel<"openai-responses">("openai", id);
			expect(model.compat.reasoningDisableMode).toBe("none-effort");
			expect(model.cost.longContext).toEqual({ inputThreshold: 272_000, ...longContext });
		}
		for (const id of ["daybreak-red-latest", "gpt-5.6-cyber"]) {
			const model = getBundledModel<"openai-responses">("openai", id);
			expect(model.compat.reasoningDisableMode).toBe("none-effort");
			expect(model.cost.longContext).toBeUndefined();
		}
	});

	test("exposes off and every GPT-5.6 wire effort on all Daybreak IDs", () => {
		const generated: ModelSpec<Api>[] = OPENAI_CURATED_FALLBACK_MODELS.filter(
			model => model.id !== "gpt-6-astra",
		).map(model => ({
			...model,
			cost: { ...model.cost },
		}));
		applyGeneratedModelPolicies(generated);

		for (const spec of generated) {
			const model = buildModel(spec);
			expect(getSupportedEfforts(model)).toEqual(DAYBREAK_EFFORTS);
			expect(model.thinking?.requiresEffort).not.toBe(true);
			expect(model.compat).toMatchObject({
				supportsPromptCacheBreakpoints: true,
				supportsSamplingParams: false,
				reasoningDisableMode: "none-effort",
			});
			expect(model.applyPatchToolType).toBe("freeform");
			expect(model.supportsComputerUse).toBe(true);
		}
	});

	test("bakes GPT-6 Astra as a first-party Responses model with mandatory reasoning", () => {
		const generated: ModelSpec<Api>[] = OPENAI_CURATED_FALLBACK_MODELS.filter(
			model => model.id === "gpt-6-astra",
		).map(model => ({
			...model,
			cost: { ...model.cost },
		}));
		applyGeneratedModelPolicies(generated);

		const spec = generated[0];
		expect(spec).toBeDefined();
		const model = buildModel(spec as ModelSpec<"openai-responses">);
		expect(getSupportedEfforts(model)).toEqual(DAYBREAK_EFFORTS);
		expect(model.thinking?.requiresEffort).toBe(true);
		expect(model.compat.reasoningDisableMode).not.toBe("none-effort");
		expect(model.cost.longContext).toEqual({
			inputThreshold: 272_000,
			input: 20,
			output: 75,
			cacheRead: 2,
			cacheWrite: 25,
		});
		expect(model.applyPatchToolType).toBe("freeform");
		expect(model.supportsComputerUse).toBe(true);

		const bundled = getBundledModel<"openai-responses">("openai", "gpt-6-astra");
		expect(bundled.thinking?.requiresEffort).toBe(true);
		expect(bundled.applyPatchToolType).toBe("freeform");
		expect(bundled.cost.longContext).toEqual({
			inputThreshold: 272_000,
			input: 20,
			output: 75,
			cacheRead: 2,
			cacheWrite: 25,
		});
	});
});
