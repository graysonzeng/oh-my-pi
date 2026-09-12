import { describe, expect, it } from "bun:test";
import { Effort } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { buildCustomModelOverlay, finalizeCustomModel } from "@oh-my-pi/pi-coding-agent/config/custom-models";
import {
	resolveAgentModelPatterns,
	resolveAgentModelSelection,
	resolveModelOverride,
} from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getBundledAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import { AUTO_THINKING } from "@oh-my-pi/pi-coding-agent/thinking";

describe("bundled agent parsing", () => {
	it("lets reviewer inherit thinking effort from its model role", () => {
		const reviewer = getBundledAgent("reviewer");

		expect(reviewer).toBeDefined();
		expect(reviewer?.source).toBe("bundled");
		expect(reviewer?.model).toEqual(["@slow"]);
		expect(reviewer?.thinkingLevel).toBeUndefined();
	});

	it("routes scout to deepseek-flash max then grok-4.6 high", () => {
		const scout = getBundledAgent("scout");
		const scoutPath = ["gateway/deepseek-flash:max", "gateway/grok-4.6:high"];

		expect(scout).toBeDefined();
		expect(scout?.source).toBe("bundled");
		expect(scout?.model).toEqual(scoutPath);
		expect(scout?.thinkingLevel).toBe(Effort.Medium);
		expect(scout?.maxEffort).toBe(Effort.Medium);
		expect(scout?.readSummarize).toBe(true);
		expect(getBundledAgent("librarian")).toBeUndefined();
	});

	it("resolves scout to deepseek-flash:max first, then grok-4.6:high", () => {
		const flashOverlay = buildCustomModelOverlay(
			"gateway",
			"https://gateway.example.com/v1",
			"openai-completions",
			undefined,
			undefined,
			true,
			undefined,
			undefined,
			undefined,
			{ id: "deepseek-flash", name: "deepseek-flash", api: "openai-completions" },
		);
		const grokOverlay = buildCustomModelOverlay(
			"gateway",
			"https://gateway.example.com/v1",
			"openai-completions",
			undefined,
			undefined,
			true,
			undefined,
			undefined,
			undefined,
			{
				id: "grok-4.6",
				name: "grok-4.6",
				api: "openai-completions",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 500000,
				maxTokens: 500000,
				cost: { input: 2, output: 6, cacheRead: 0.3, cacheWrite: 0 },
			},
		);
		if (!flashOverlay || !grokOverlay) throw new Error("expected gateway overlays for scout candidates");
		const flash = finalizeCustomModel(flashOverlay, { useDefaults: true });
		const grok = finalizeCustomModel(grokOverlay, { useDefaults: true });
		const settings = Settings.isolated();
		const scout = getBundledAgent("scout");
		const patterns = resolveAgentModelPatterns({ agentModel: scout?.model, settings });
		expect(patterns).toEqual(["gateway/deepseek-flash:max", "gateway/grok-4.6:high"]);

		const both = { getAvailable: () => [grok, flash] } as Parameters<typeof resolveModelOverride>[1];
		const first = resolveModelOverride(patterns, both, settings);
		expect(first.model?.provider).toBe("gateway");
		expect(first.model?.id).toBe("deepseek-flash");
		expect(first.explicitThinkingLevel).toBe(true);
		expect(first.thinkingLevel).toBe(Effort.Max);

		const grokOnly = { getAvailable: () => [grok] } as Parameters<typeof resolveModelOverride>[1];
		const second = resolveModelOverride(patterns, grokOnly, settings);
		expect(second.model?.provider).toBe("gateway");
		expect(second.model?.id).toBe("grok-4.6");
		expect(second.explicitThinkingLevel).toBe(true);
		expect(second.thinkingLevel).toBe(Effort.High);
	});

	it("defaults the task agent to the auto thinking selector", () => {
		const task = getBundledAgent("task");

		expect(task).toBeDefined();
		expect(task?.model).toEqual(["@task"]);
		expect(task?.thinkingLevel).toBe(AUTO_THINKING);
	});

	// Issue #4761: with `modelRoles.slow: ...:xhigh`, the role's explicit effort
	// suffix must survive agent-pattern expansion and model resolution for the
	// bundled agents routed at that role. The executor prefers an explicit
	// resolved suffix over the agent-definition default (task/executor.ts), so
	// the resolved level below is what the subagent runs at.
	it("resolves the configured slow-role effort suffix for reviewer", () => {
		const gpt55 = buildModel({
			id: "gpt-5.5",
			name: "GPT-5.5 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api/codex",
			reasoning: true,
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh] },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 272000,
			maxTokens: 128000,
		});
		const settings = Settings.isolated({
			modelRoles: { slow: "openai-codex/gpt-5.5:xhigh" },
		});
		const registry = { getAvailable: () => [gpt55] } as Parameters<typeof resolveModelOverride>[1];

		const agent = getBundledAgent("reviewer");
		expect(agent?.thinkingLevel).toBeUndefined();
		const patterns = resolveAgentModelPatterns({ agentModel: agent?.model, settings });
		const resolved = resolveModelOverride(patterns, registry, settings);
		expect(resolved.model?.provider).toBe("openai-codex");
		expect(resolved.model?.id).toBe("gpt-5.5");
		expect(resolved.thinkingLevel).toBe(Effort.XHigh);
		expect(resolved.explicitThinkingLevel).toBe(true);
	});

	// The alias is expanded before it reaches the executor, so the role identity
	// only survives as the `role` half of the selection. A subagent's inherited
	// `retry.fallbackChains` entry is keyed off it — lose it and every bundled
	// agent silently retries on the `default` role's chain.
	it("keeps the role identity of every alias-routed bundled agent through expansion", () => {
		const settings = Settings.isolated({
			modelRoles: {
				default: "anthropic/opus",
				task: "anthropic/sonnet",
				smol: "fast/hy3",
				slow: "codex/sol",
			},
		});

		for (const [name, role, model] of [
			["task", "task", "anthropic/sonnet"],
			["sonic", "smol", "fast/hy3"],
			["reviewer", "slow", "codex/sol"],
		] as const) {
			const agent = getBundledAgent(name);
			expect(resolveAgentModelSelection({ agentModel: agent?.model, settings })).toEqual({
				patterns: [model],
				role,
			});
		}

		expect(resolveAgentModelSelection({ agentModel: getBundledAgent("scout")?.model, settings })).toEqual({
			patterns: ["gateway/deepseek-flash:max", "gateway/grok-4.6:high"],
			role: undefined,
		});
	});
});
