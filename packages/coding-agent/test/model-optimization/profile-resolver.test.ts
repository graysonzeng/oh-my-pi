import { describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "../../src/config/settings";
import {
	buildResolvedModelOptimization,
	DEFAULT_MODEL_OPTIMIZATION_PROFILES,
	mergeModelOptimizationProfiles,
	resolveModelOptimizationProfile,
} from "../../src/model-optimization";
import type { ModelOptimizationProfile } from "../../src/model-optimization/types";
import { applySessionToolOutput } from "../../src/workflow/tool-optimization";

function requiredModel(provider: "anthropic" | "deepseek" | "openai", id: string) {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Missing bundled test model ${provider}/${id}`);
	return model;
}

describe("ordinary-session model optimization resolver", () => {
	it("matches built-in model families without selecting workflow role profiles", () => {
		const cases = [
			[requiredModel("anthropic", "claude-sonnet-4-5"), "claude"],
			[requiredModel("openai", "gpt-5"), "gpt-5"],
			[requiredModel("deepseek", "deepseek-v4-pro"), "deepseek"],
		] as const;

		for (const [model, expectedId] of cases) {
			const result = resolveModelOptimizationProfile({
				model,
				profiles: Object.values(DEFAULT_MODEL_OPTIMIZATION_PROFILES),
				availableModels: [model],
			});
			expect(result.profile?.id).toBe(expectedId);
			expect(result.profile?.id).not.toMatch(/planner|implementer|reviewer/);
		}
	});

	it("fails closed on an equal-priority ambiguity", () => {
		const model = requiredModel("openai", "gpt-5");
		const profiles: ModelOptimizationProfile[] = [
			{ id: "first", modelPattern: "gpt-5*" },
			{ id: "second", modelPattern: "openai/gpt-5*" },
		];

		const result = resolveModelOptimizationProfile({ model, profiles, availableModels: [model] });

		expect(result.profile).toBeUndefined();
		expect(result.ambiguous).toBe(true);
		expect(result.candidateIds).toEqual(["first", "second"]);
	});

	it("does not reuse a result across different profile configurations", () => {
		const model = requiredModel("openai", "gpt-5");
		const first = resolveModelOptimizationProfile({
			model,
			profiles: [{ id: "first", modelPattern: "gpt-5*" }],
			availableModels: [model],
		});
		const second = resolveModelOptimizationProfile({
			model,
			profiles: [{ id: "second", modelPattern: "gpt-5*" }],
			availableModels: [model],
		});

		expect(first.profile?.id).toBe("first");
		expect(second.profile?.id).toBe("second");
	});

	it("keeps the feature opt-in and strips workflow-only fields from user profiles", () => {
		expect(Settings.isolated().get("modelOptimization.enabled")).toBe(false);
		const profiles = mergeModelOptimizationProfiles({
			custom: {
				id: "custom",
				modelPattern: "gpt-5*",
				toolAliases: { bash: "run_command" },
				outputStrategy: { schemaEnhancement: { enabled: true } },
				roles: ["implementer"],
			} as unknown as ModelOptimizationProfile,
		});
		const custom = profiles.find(profile => profile.id === "custom");

		expect(custom).toEqual({
			id: "custom",
			modelPattern: "gpt-5*",
			priority: undefined,
			promptStrategy: undefined,
			toolStrategy: undefined,
			contextStrategy: undefined,
		});
	});

	it("keeps ordinary-session tool output byte-identical without a recovery channel", () => {
		const resolved = buildResolvedModelOptimization(DEFAULT_MODEL_OPTIMIZATION_PROFILES["gpt-5"]);
		const output = `${"line\n".repeat(500)}ERROR: keep all output\n`;

		expect("toolOptimization" in resolved).toBe(false);
		expect(applySessionToolOutput({}, "bash", output, { exitCode: 1 })).toBe(output);
	});

	it("built-in profiles keep deterministic truncation with summarizer disabled", () => {
		const resolved = buildResolvedModelOptimization(DEFAULT_MODEL_OPTIMIZATION_PROFILES.claude);
		expect(resolved.profile?.toolStrategy?.resultSummarization?.enabled).toBe(false);
		expect(resolved.profile?.toolStrategy?.outputTruncation?.enabled).toBe(true);
		expect(resolved.contextStrategy?.eviction?.preserveUserTurns).toBe(true);
		expect(resolved.contextStrategy?.eviction?.evictPersisted).toBe(false);
	});

	it("GLM and DeepSeek built-ins have no Grok prompt inheritance", () => {
		const glm = buildResolvedModelOptimization(DEFAULT_MODEL_OPTIMIZATION_PROFILES.glm);
		const deepseek = buildResolvedModelOptimization(DEFAULT_MODEL_OPTIMIZATION_PROFILES.deepseek);
		expect(DEFAULT_MODEL_OPTIMIZATION_PROFILES.glm.promptStrategy).toBeUndefined();
		expect(DEFAULT_MODEL_OPTIMIZATION_PROFILES.deepseek.promptStrategy).toBeUndefined();
		expect(glm.promptBlock).toBeUndefined();
		expect(deepseek.promptBlock).toBeUndefined();
	});
});
