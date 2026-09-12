import { describe, expect, test } from "bun:test";
import { buildModel } from "../src/build";
import { getBundledModelReferenceIndex } from "../src/identity/bundled";
import { buildModelReferenceIndex, inheritReferenceThinking, resolveModelReference } from "../src/identity/reference";
import type { Model, ModelSpec, Provider } from "../src/types";

describe("Portkey gateway model references", () => {
	test("@modal ids do not fuzzy-match bundled catalog entries", () => {
		const index = getBundledModelReferenceIndex();
		expect(resolveModelReference("@modal/GLM-5-2-FP8", index)).toBeUndefined();
	});

	test("strips compiled discovery and collapse markers for proxy recovery", () => {
		const index = getBundledModelReferenceIndex();
		for (const id of [
			"claude-opus-4-6-fp8",
			"claude-opus-4-6-search",
			"claude-opus-4-6-thinking",
			"claude-opus-4-6-free",
		]) {
			expect(resolveModelReference(id, index)?.id).toBe("claude-opus-4-6");
		}
	});

	test("cross-provider references do not inherit wire routing thinking", () => {
		const index = getBundledModelReferenceIndex();
		const kiloGigaPotato = resolveModelReference("giga-potato", index);
		expect(kiloGigaPotato?.provider).toBe("kilo");
		expect(kiloGigaPotato?.thinking?.effortRouting).toBeDefined();
		expect(inheritReferenceThinking(undefined, kiloGigaPotato, "gateway")).toBeUndefined();
	});
});

describe("generic proxy metadata references", () => {
	const referenceModel = (overrides: {
		id: string;
		provider: Provider;
		contextWindow: number;
		maxTokens: number;
		cost?: Model<"openai-completions">["cost"];
	}): Model<"openai-completions"> =>
		buildModel({
			id: overrides.id,
			name: overrides.id,
			api: "openai-completions",
			provider: overrides.provider,
			baseUrl: "https://example.invalid/v1",
			reasoning: false,
			input: ["text"],
			cost: overrides.cost ?? { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 0.1 },
			contextWindow: overrides.contextWindow,
			maxTokens: overrides.maxTokens,
		});

	test("prefers larger context window over provider identity", () => {
		const firstParty = referenceModel({
			id: "reference-fixture",
			provider: "zai",
			contextWindow: 8_000,
			maxTokens: 4_000,
		});
		const relay = referenceModel({
			id: "reference-fixture",
			provider: "openrouter",
			contextWindow: 1_000_000,
			maxTokens: 4_000,
		});
		const index = buildModelReferenceIndex([firstParty, relay]);
		expect(resolveModelReference("reference-fixture", index)?.provider).toBe("openrouter");
	});

	test("prefers complete cache pricing when limits match", () => {
		const unpaid = referenceModel({
			id: "kimi-k3",
			provider: "moonshot",
			contextWindow: 128_000,
			maxTokens: 32_000,
			cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		});
		const pricedRelay = referenceModel({
			id: "kimi-k3",
			provider: "openrouter",
			contextWindow: 128_000,
			maxTokens: 32_000,
		});
		const index = buildModelReferenceIndex([unpaid, pricedRelay]);
		expect(resolveModelReference("kimi-k3", index)?.provider).toBe("openrouter");
	});

	test("prefers openai over a relay when limits and cache pricing match", () => {
		const openai = referenceModel({
			id: "gpt-5.6-sol",
			provider: "openai",
			contextWindow: 272_000,
			maxTokens: 128_000,
		});
		const relay = referenceModel({
			id: "gpt-5.6-sol",
			provider: "openrouter",
			contextWindow: 272_000,
			maxTokens: 128_000,
		});
		const index = buildModelReferenceIndex([relay, openai]);
		expect(resolveModelReference("gpt-5.6-sol", index)?.provider).toBe("openai");
		expect(resolveModelReference("gpt-5.6-sol", index)?.contextWindow).toBe(272_000);
	});

	test("does not let zero-cost xai-oauth outrank a paid Grok reference", () => {
		const oauth = referenceModel({
			id: "grok-4.6",
			provider: "xai-oauth",
			contextWindow: 2_000_000,
			maxTokens: 2_000_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		const xai = referenceModel({
			id: "grok-4.6",
			provider: "xai",
			contextWindow: 128_000,
			maxTokens: 32_000,
		});
		const index = buildModelReferenceIndex([oauth, xai]);
		expect(resolveModelReference("grok-4.6", index)?.provider).toBe("xai");
	});
});

describe("Vercel AI Gateway cache compat", () => {
	test("resolves Chat Completions caching controls only for the Vercel endpoint", () => {
		const model = buildModel({
			id: "anthropic/claude-sonnet-4.6",
			name: "Claude Sonnet 4.6",
			api: "openai-completions",
			provider: "vercel-ai-gateway",
			baseUrl: "https://ai-gateway.vercel.sh/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 16_384,
			compat: {
				vercelGatewayRouting: {
					only: ["anthropic"],
					order: ["anthropic", "bedrock"],
					caching: "auto",
				},
			},
		} satisfies ModelSpec<"openai-completions">);

		expect(model.compat.isVercelGatewayHost).toBe(true);
		expect(model.compat.vercelGatewayRouting).toEqual({
			only: ["anthropic"],
			order: ["anthropic", "bedrock"],
			caching: "auto",
		});
	});
});

test("resolves Responses cache controls only for the Vercel endpoint", () => {
	const routing = { caching: "auto" as const, cacheAnchorItems: 1, cacheTtl: "1h" as const };
	const vercel = buildModel({
		id: "anthropic/claude-sonnet-4.6",
		name: "Claude Sonnet 4.6",
		api: "openai-responses",
		provider: "vercel-ai-gateway",
		baseUrl: "https://ai-gateway.vercel.sh/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 16_384,
		compat: { vercelGatewayRouting: routing },
	} satisfies ModelSpec<"openai-responses">);
	const direct = buildModel({
		id: "anthropic/claude-sonnet-4.6",
		name: "Claude Sonnet 4.6",
		api: "openai-responses",
		provider: "custom",
		baseUrl: "https://api.example.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 16_384,
		compat: { vercelGatewayRouting: routing },
	} satisfies ModelSpec<"openai-responses">);

	expect(vercel.compat.isVercelGatewayHost).toBe(true);
	expect(vercel.compat.vercelGatewayRouting).toEqual(routing);
	expect(direct.compat.isVercelGatewayHost).toBe(false);
});
