import { describe, expect, it } from "bun:test";
import { Effort } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	resolveAgentModelPatterns,
	resolveAgentModelSelection,
	resolveModelOverride,
} from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getBundledAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import { AUTO_THINKING } from "@oh-my-pi/pi-coding-agent/thinking";

describe("bundled agent parsing", () => {
	it("routes reviewer to fixed gateway candidates then the session model", () => {
		const reviewer = getBundledAgent("reviewer");

		expect(reviewer).toBeDefined();
		expect(reviewer?.source).toBe("bundled");
		expect(reviewer?.model).toEqual(["gateway/gpt-5.6-sol", "gateway/claude-opus-5", "@task"]);
		expect(reviewer?.thinkingLevel).toBe(Effort.Medium);
		expect(reviewer?.maxEffort).toBe(Effort.XHigh);
	});

	it("routes scout to deepseek-v4-flash max then grok-4.6 xhigh", () => {
		const scout = getBundledAgent("scout");

		expect(scout).toBeDefined();
		expect(scout?.source).toBe("bundled");
		expect(scout?.model).toEqual(["gateway/deepseek-v4-flash:max", "gateway/grok-4.6:xhigh"]);
		expect(scout?.thinkingLevel).toBe(Effort.Max);
		expect(scout?.maxEffort).toBe(Effort.Max);
	});

	it("resolves scout to deepseek-v4-flash:max first, then grok-4.6:xhigh", () => {
		const flash = buildModel({
			id: "deepseek-v4-flash",
			name: "DeepSeek V4 Flash",
			api: "openai-completions",
			provider: "gateway",
			baseUrl: "https://gateway.example.com/v1",
			reasoning: true,
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.High, Effort.Max] },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 32768,
		});
		const grok = buildModel({
			id: "grok-4.6",
			name: "Grok 4.6",
			api: "openai-completions",
			provider: "gateway",
			baseUrl: "https://gateway.example.com/v1",
			reasoning: true,
			thinking: { mode: "effort", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh] },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 500000,
			maxTokens: 500000,
		});
		const settings = Settings.isolated();
		const scout = getBundledAgent("scout");
		const patterns = resolveAgentModelPatterns({ agentModel: scout?.model, settings });
		expect(patterns).toEqual(["gateway/deepseek-v4-flash:max", "gateway/grok-4.6:xhigh"]);

		const both = { getAvailable: () => [grok, flash] } as Parameters<typeof resolveModelOverride>[1];
		const first = resolveModelOverride(patterns, both, settings);
		expect(first.model?.id).toBe("deepseek-v4-flash");
		expect(first.explicitThinkingLevel).toBe(true);
		expect(first.thinkingLevel).toBe(Effort.Max);

		const grokOnly = { getAvailable: () => [grok] } as Parameters<typeof resolveModelOverride>[1];
		const second = resolveModelOverride(patterns, grokOnly, settings);
		expect(second.model?.id).toBe("grok-4.6");
		expect(second.explicitThinkingLevel).toBe(true);
		expect(second.thinkingLevel).toBe(Effort.XHigh);
	});

	it("defaults the task agent to the auto thinking selector", () => {
		const task = getBundledAgent("task");

		expect(task).toBeDefined();
		expect(task?.model).toEqual(["@task"]);
		expect(task?.thinkingLevel).toBe(AUTO_THINKING);
	});

	it("resolves reviewer through the fixed candidates, then the session model", () => {
		const gpt56Sol = buildModel({
			id: "gpt-5.6-sol",
			name: "GPT-5.6 Sol",
			api: "openai-codex-responses",
			provider: "gateway",
			baseUrl: "https://gateway.example.com/v1",
			reasoning: true,
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh] },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1050000,
			maxTokens: 128000,
		});
		const opus5 = buildModel({
			id: "claude-opus-5",
			name: "Claude Opus 5",
			api: "anthropic-messages",
			provider: "gateway",
			baseUrl: "https://gateway.example.com/v1",
			reasoning: true,
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh] },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 128000,
		});
		const sessionModel = buildModel({
			id: "deepseek-v4-flash",
			name: "DeepSeek V4 Flash",
			api: "openai-completions",
			provider: "gateway",
			baseUrl: "https://gateway.example.com/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 32768,
		});
		const settings = Settings.isolated();
		const agent = getBundledAgent("reviewer");
		expect(agent?.thinkingLevel).toBe(Effort.Medium);

		const patterns = resolveAgentModelPatterns({
			agentModel: agent?.model,
			settings,
			activeModelPattern: "gateway/deepseek-v4-flash",
		});
		expect(patterns).toEqual(["gateway/gpt-5.6-sol", "gateway/claude-opus-5", "gateway/deepseek-v4-flash"]);

		// First available candidate resolves without overriding the agent's medium default.
		const all = { getAvailable: () => [gpt56Sol, opus5, sessionModel] } as Parameters<typeof resolveModelOverride>[1];
		const first = resolveModelOverride(patterns, all, settings);
		expect(first.model?.provider).toBe("gateway");
		expect(first.model?.id).toBe("gpt-5.6-sol");
		expect(first.explicitThinkingLevel).toBe(false);

		// Second candidate also preserves the agent-level policy.
		const opusOnly = { getAvailable: () => [opus5] } as Parameters<typeof resolveModelOverride>[1];
		const second = resolveModelOverride(patterns, opusOnly, settings);
		expect(second.model?.provider).toBe("gateway");
		expect(second.model?.id).toBe("claude-opus-5");
		expect(second.explicitThinkingLevel).toBe(false);

		// Neither gateway candidate available → the session (main agent) model.
		const sessionOnly = { getAvailable: () => [sessionModel] } as Parameters<typeof resolveModelOverride>[1];
		const sessionResolved = resolveModelOverride(patterns, sessionOnly, settings);
		expect(sessionResolved.model?.provider).toBe("gateway");
		expect(sessionResolved.model?.id).toBe("deepseek-v4-flash");
		expect(sessionResolved.explicitThinkingLevel).toBe(false);
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
				designer: "anthropic/opus",
			},
		});

		for (const [name, role, model] of [
			["task", "task", "anthropic/sonnet"],
			["sonic", "smol", "fast/hy3"],
			["designer", "designer", "anthropic/opus"],
		] as const) {
			const agent = getBundledAgent(name);
			expect(resolveAgentModelSelection({ agentModel: agent?.model, settings })).toEqual({
				patterns: [model],
				role,
			});
		}

		expect(resolveAgentModelSelection({ agentModel: getBundledAgent("scout")?.model, settings })).toEqual({
			patterns: ["gateway/deepseek-v4-flash:max", "gateway/grok-4.6:xhigh"],
			role: undefined,
		});
	});
});
