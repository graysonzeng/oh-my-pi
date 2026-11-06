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
import { buildOutputValidator } from "@oh-my-pi/pi-coding-agent/tools/output-schema-validator";
import { AUTO_THINKING, clampThinkingLevelToCeiling } from "@oh-my-pi/pi-tui/thinking";

describe("bundled agent parsing", () => {
	it("caps sonic effort at high so model :max suffixes cannot raise the ceiling", () => {
		const sonic = getBundledAgent("sonic");
		expect(sonic?.thinkingLevel).toBe(Effort.High);
		expect(sonic?.maxEffort).toBe(Effort.High);

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
			{
				id: "deepseek-v4-flash",
				name: "deepseek-v4-flash",
				api: "openai-completions",
				reasoning: true,
				thinking: {
					mode: "effort",
					efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
				},
			},
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
				thinking: {
					mode: "effort",
					efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
				},
			},
		);
		if (!flashOverlay || !grokOverlay) throw new Error("expected gateway overlays for sonic candidates");
		const flash = finalizeCustomModel(flashOverlay, { useDefaults: true });
		const grok = finalizeCustomModel(grokOverlay, { useDefaults: true });
		const settings = Settings.isolated();
		const patterns = resolveAgentModelPatterns({ agentModel: sonic?.model, settings });
		const both = { getAvailable: () => [grok, flash] } as Parameters<typeof resolveModelOverride>[1];
		const first = resolveModelOverride(patterns, both, settings);
		expect(first.model?.id).toBe("deepseek-v4-flash");
		if (first.thinkingLevel === AUTO_THINKING) throw new Error("explicit suffix must resolve a concrete effort");
		expect(clampThinkingLevelToCeiling(first.model, first.thinkingLevel, sonic?.maxEffort)).toBe(Effort.High);

		const grokOnly = { getAvailable: () => [grok] } as Parameters<typeof resolveModelOverride>[1];
		const second = resolveModelOverride(patterns, grokOnly, settings);
		expect(second.model?.id).toBe("grok-4.6");
		if (second.thinkingLevel === AUTO_THINKING) throw new Error("explicit suffix must resolve a concrete effort");
		expect(clampThinkingLevelToCeiling(second.model, second.thinkingLevel, sonic?.maxEffort)).toBe(Effort.High);
	});

	it("honors the configured scout role fallback chain while capping effort at high", () => {
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
			{
				id: "deepseek-flash",
				name: "deepseek-flash",
				api: "openai-completions",
				reasoning: true,
				thinking: {
					mode: "effort",
					efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
				},
			},
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
				thinking: {
					mode: "effort",
					efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
				},
				input: ["text", "image"],
				contextWindow: 500000,
				maxTokens: 500000,
				cost: { input: 2, output: 6, cacheRead: 0.3, cacheWrite: 0 },
			},
		);
		if (!flashOverlay || !grokOverlay) throw new Error("expected gateway overlays for scout candidates");
		const flash = finalizeCustomModel(flashOverlay, { useDefaults: true });
		const grok = finalizeCustomModel(grokOverlay, { useDefaults: true });
		const settings = Settings.isolated({
			modelRoles: { smol: "gateway/deepseek-flash:max,gateway/grok-4.6:high" },
		});
		const scout = getBundledAgent("scout");
		const patterns = resolveAgentModelPatterns({ agentModel: scout?.model, settings });

		const both = { getAvailable: () => [grok, flash] } as Parameters<typeof resolveModelOverride>[1];
		const first = resolveModelOverride(patterns, both, settings);
		expect(first.model?.provider).toBe("gateway");
		expect(first.model?.id).toBe("deepseek-flash");
		expect(first.explicitThinkingLevel).toBe(true);
		if (first.thinkingLevel === AUTO_THINKING) throw new Error("explicit suffix must resolve a concrete effort");
		expect(clampThinkingLevelToCeiling(first.model, first.thinkingLevel, scout?.maxEffort)).toBe(Effort.High);

		const grokOnly = { getAvailable: () => [grok] } as Parameters<typeof resolveModelOverride>[1];
		const second = resolveModelOverride(patterns, grokOnly, settings);
		expect(second.model?.provider).toBe("gateway");
		expect(second.model?.id).toBe("grok-4.6");
		expect(second.explicitThinkingLevel).toBe(true);
		if (second.thinkingLevel === AUTO_THINKING) throw new Error("explicit suffix must resolve a concrete effort");
		expect(clampThinkingLevelToCeiling(second.model, second.thinkingLevel, scout?.maxEffort)).toBe(Effort.High);
	});

	it("accepts security-reviewer findings with optional remediation metadata", () => {
		const securityReviewer = getBundledAgent("security-reviewer");
		const findingValidator = buildOutputValidator(securityReviewer?.output).validator?.validateSection.get(
			"findings",
		);
		expect(
			findingValidator?.({
				rule_id: "command-injection",
				title: "Unsanitized command input",
				summary: "User input reaches a shell command",
				severity: "high",
				confidence: "high",
				category: "injection",
				locations: [{ path: "src/run.ts", start_line: 10 }],
				cwe: ["CWE-78"],
				evidence: [{ label: "data flow", explanation: "Input reaches exec" }],
				anchor: "run",
				remediation: "Pass arguments without a shell",
			}).success,
		).toBe(true);
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
			["reviewer", "slow", "codex/sol"],
		] as const) {
			const agent = getBundledAgent(name);
			expect(resolveAgentModelSelection({ agentModel: agent?.model, settings })).toEqual({
				patterns: [model],
				role,
			});
		}

		// sonic uses an explicit explore model list (not @smol) at :high.
		expect(resolveAgentModelSelection({ agentModel: getBundledAgent("sonic")?.model, settings })).toEqual({
			patterns: ["gateway/deepseek-v4-flash:high", "gateway/grok-4.6:high"],
			role: undefined,
		});

		expect(resolveAgentModelSelection({ agentModel: getBundledAgent("scout")?.model, settings })).toEqual({
			patterns: ["fast/hy3"],
			role: "smol",
		});
	});
});
