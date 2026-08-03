import { describe, expect, it } from "bun:test";
import { Effort } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resolveAgentModelPatterns, resolveModelOverride } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getBundledAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import { AUTO_THINKING } from "@oh-my-pi/pi-coding-agent/thinking";

describe("bundled agent parsing", () => {
	it("routes reviewer to fixed gateway candidates then the session model", () => {
		const reviewer = getBundledAgent("reviewer");

		expect(reviewer).toBeDefined();
		expect(reviewer?.source).toBe("bundled");
		expect(reviewer?.model).toEqual(["gateway/gpt-5.6-sol:xhigh", "gateway/claude-opus-5:max", "@task"]);
		expect(reviewer?.thinkingLevel).toBeUndefined();
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
		expect(agent?.thinkingLevel).toBeUndefined();

		const patterns = resolveAgentModelPatterns({
			agentModel: agent?.model,
			settings,
			activeModelPattern: "gateway/deepseek-v4-flash",
		});
		expect(patterns).toEqual(["gateway/gpt-5.6-sol:xhigh", "gateway/claude-opus-5:max", "gateway/deepseek-v4-flash"]);

		// First candidate available → gpt-5.6-sol at xhigh.
		const all = { getAvailable: () => [gpt56Sol, opus5, sessionModel] } as Parameters<typeof resolveModelOverride>[1];
		const first = resolveModelOverride(patterns, all, settings);
		expect(first.model?.provider).toBe("gateway");
		expect(first.model?.id).toBe("gpt-5.6-sol");
		expect(first.thinkingLevel).toBe(Effort.XHigh);
		expect(first.explicitThinkingLevel).toBe(true);

		// Second candidate only → claude-opus-5 at max.
		const opusOnly = { getAvailable: () => [opus5] } as Parameters<typeof resolveModelOverride>[1];
		const second = resolveModelOverride(patterns, opusOnly, settings);
		expect(second.model?.provider).toBe("gateway");
		expect(second.model?.id).toBe("claude-opus-5");

		// Neither gateway candidate available → the session (main agent) model.
		const sessionOnly = { getAvailable: () => [sessionModel] } as Parameters<typeof resolveModelOverride>[1];
		const sessionResolved = resolveModelOverride(patterns, sessionOnly, settings);
		expect(sessionResolved.model?.provider).toBe("gateway");
		expect(sessionResolved.model?.id).toBe("deepseek-v4-flash");
		expect(sessionResolved.explicitThinkingLevel).toBe(false);
	});
});
