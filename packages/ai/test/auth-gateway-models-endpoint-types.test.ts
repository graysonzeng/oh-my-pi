import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import type { Api, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

interface ModelsListEntry {
	id: string;
	object: string;
	owned_by: string;
	api: string;
	supported_endpoint_types: string[];
}

interface ModelsListBody {
	object: string;
	data: ModelsListEntry[];
}

function stubModel(partial: Pick<Model<Api>, "id" | "provider" | "api">): Model<Api> {
	return buildModel({
		id: partial.id,
		name: partial.id,
		api: partial.api,
		provider: partial.provider,
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8192,
	});
}

async function bootWithModels(models: Model<Api>[]) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-models-endpoint-types-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	const byId = new Map(models.map(m => [m.id, m]));
	const handle = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: ["t"],
		storage,
		resolveModel: id => byId.get(id),
		listModels: () => byId.values(),
		version: "test",
	});
	return {
		url: handle.url,
		close: async () => {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		},
	};
}

describe("auth-gateway GET /v1/models supported_endpoint_types", () => {
	it("advertises anthropic/openai tags from Model.api and leaves unrelated APIs empty", async () => {
		const models = [
			stubModel({ id: "claude-sonnet-4", provider: "anthropic", api: "anthropic-messages" }),
			stubModel({ id: "gpt-5.2", provider: "openai", api: "openai-completions" }),
			stubModel({ id: "gemini-2.5-pro", provider: "google", api: "google-generative-ai" }),
			stubModel({ id: "gpt-5.2-codex", provider: "openai-codex", api: "openai-codex-responses" }),
		];
		const gw = await bootWithModels(models);
		try {
			const res = await fetch(`${gw.url}/v1/models`, {
				headers: { Authorization: "Bearer t" },
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as ModelsListBody;
			expect(body.object).toBe("list");

			const byId = new Map(body.data.map(entry => [entry.id, entry]));

			const claude = byId.get("claude-sonnet-4");
			expect(claude).toBeDefined();
			expect(claude?.object).toBe("model");
			expect(claude?.owned_by).toBe("anthropic");
			expect(claude?.api).toBe("anthropic-messages");
			expect(claude?.supported_endpoint_types).toEqual(["anthropic"]);

			const gpt = byId.get("gpt-5.2");
			expect(gpt).toBeDefined();
			expect(gpt?.object).toBe("model");
			expect(gpt?.owned_by).toBe("openai");
			expect(gpt?.api).toBe("openai-completions");
			expect(gpt?.supported_endpoint_types).toEqual(["openai"]);

			// Unrelated / non-chat-gateway-native APIs: no anthropic/openai claim.
			// Responses-family and Google are still reachable via gateway translation,
			// but proxy discovery would mis-map invented tags — stay empty.
			const gemini = byId.get("gemini-2.5-pro");
			expect(gemini?.api).toBe("google-generative-ai");
			expect(gemini?.supported_endpoint_types).toEqual([]);

			const codex = byId.get("gpt-5.2-codex");
			expect(codex?.api).toBe("openai-codex-responses");
			expect(codex?.supported_endpoint_types).toEqual([]);
		} finally {
			await gw.close();
		}
	});

	it("tags openrouter and ollama-chat as openai chat-compatible", async () => {
		const models = [
			stubModel({ id: "openrouter/auto", provider: "openrouter", api: "openrouter" }),
			stubModel({ id: "llama3.2", provider: "ollama", api: "ollama-chat" }),
		];
		const gw = await bootWithModels(models);
		try {
			const res = await fetch(`${gw.url}/v1/models`, {
				headers: { Authorization: "Bearer t" },
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as ModelsListBody;
			const byId = new Map(body.data.map(entry => [entry.id, entry]));
			expect(byId.get("openrouter/auto")?.supported_endpoint_types).toEqual(["openai"]);
			expect(byId.get("llama3.2")?.supported_endpoint_types).toEqual(["openai"]);
		} finally {
			await gw.close();
		}
	});
});
