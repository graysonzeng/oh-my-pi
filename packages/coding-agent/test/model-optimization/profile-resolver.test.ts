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

	it("preserves the built-in Luna candidate through partial profile overrides", () => {
		const merged = mergeModelOptimizationProfiles({ luna: { toolStrategy: { maxConcurrentTools: 3 } } });
		const luna = merged.find(profile => profile.id === "luna");
		expect(luna?.contextBudgetCandidate).toEqual({
			version: 1,
			targetUtilization: 0.7,
			keepRecentN: 8,
			maxToolCalls: 8,
		});
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

	it("keeps context optimization default-on with the wired quality stop", () => {
		expect(Settings.isolated().get("modelOptimization.enabled")).toBe(true);
		expect(Settings.isolated().get("latency.arms.readDedupe")).toBe(true);
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

	it("resolves gateway production models without user overlay", () => {
		const cases: Array<{ id: string; provider: string; expected: string }> = [
			{ id: "gpt-5.6-luna", provider: "gateway", expected: "luna" },
			{ id: "gateway/gpt-5.6-luna", provider: "gateway", expected: "luna" },
			{ id: "gpt-5.6-terra", provider: "gateway", expected: "terra" },
			{ id: "gpt-5.6-sol", provider: "gateway", expected: "sol" },
			{ id: "gpt-5.6-sol-pro", provider: "gateway", expected: "sol" },
			{ id: "gateway/gpt-5.6-sol", provider: "gateway", expected: "sol" },
			{ id: "grok-4.6", provider: "gateway", expected: "grok" },
			{ id: "gateway/grok-4.6", provider: "custom", expected: "grok" },
		];

		for (const { id, provider, expected } of cases) {
			const model = {
				id,
				provider,
				name: id,
				api: "openai-completions" as const,
				baseUrl: "http://example.invalid",
				reasoning: false,
				input: ["text"] as const,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 8_192,
			};
			const result = resolveModelOptimizationProfile({
				model: model as never,
				profiles: Object.values(DEFAULT_MODEL_OPTIMIZATION_PROFILES),
				availableModels: [model as never],
			});
			expect(result.profile?.id).toBe(expected);
			expect(result.ambiguous).toBeFalsy();
			expect(result.profile?.toolStrategy?.resultSummarization?.enabled).toBe(false);
			expect(result.profile?.toolStrategy?.outputTruncation?.enabled).toBe(true);
		}
	});

	it("does not match unrelated ids containing sol as a substring", () => {
		const model = {
			id: "console",
			provider: "gateway",
			name: "console",
			api: "openai-completions" as const,
			baseUrl: "http://example.invalid",
			reasoning: false,
			input: ["text"] as const,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8_192,
		};
		const result = resolveModelOptimizationProfile({
			model: model as never,
			profiles: Object.values(DEFAULT_MODEL_OPTIMIZATION_PROFILES),
			availableModels: [model as never],
		});
		expect(result.profile).toBeUndefined();
		expect(result.ambiguous).toBeFalsy();
	});
});
