import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Model } from "@oh-my-pi/pi-ai/types";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { resolveWireModelId } from "@oh-my-pi/pi-catalog/model-thinking";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

describe("Portkey gateway custom models", () => {
	let tempDir: string;
	let modelsPath: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = path.join(os.tmpdir(), `pi-test-portkey-gateway-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsPath = path.join(tempDir, "models.yml");
		authStorage = await AuthStorage.create(":memory:");
	});

	afterEach(() => {
		resetSettingsForTest();
		vi.restoreAllMocks();
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

	test("gateway @modal/GLM-5-2-FP8 keeps full wire id (not devin glm-5-2)", () => {
		fs.writeFileSync(
			modelsPath,
			`providers:
  gateway:
    baseUrl: https://gateway.example.com/v1
    api: openai-completions
    apiKey: test
    authHeader: true
    headers:
      x-portkey-api-key: test
    models:
      - id: "@modal/GLM-5-2-FP8"
        name: glm-5p2 (modal)
        reasoning: true
        input: [text]
        contextWindow: 1048576
        maxTokens: 131072
        compat:
          thinkingFormat: openai
          supportsReasoningEffort: true
          reasoningEffortMap:
            minimal: none
            low: low
            medium: medium
            high: high
            xhigh: max
`,
		);
		const registry = new ModelRegistry(authStorage, modelsPath);
		const model = registry.find("gateway", "@modal/GLM-5-2-FP8");
		expect(model).toBeDefined();
		expect(resolveWireModelId(model!, Effort.High)).toBe("@modal/GLM-5-2-FP8");
		expect(resolveWireModelId(model!, undefined)).toBe("@modal/GLM-5-2-FP8");
	});

	test("gateway requestModelId sends display-name wire id for DeepSeek V4 Flash", async () => {
		fs.writeFileSync(
			modelsPath,
			`providers:
  gateway:
    baseUrl: https://gateway.example.com/v1
    api: openai-completions
    apiKey: test
    authHeader: true
    models:
      - id: deepseek-v4-flash
        name: deepseek-v4-flash
        requestModelId: DeepSeek V4 Flash
        api: openai-completions
        reasoning: true
`,
		);
		const registry = new ModelRegistry(authStorage, modelsPath);
		const model = registry.find("gateway", "deepseek-v4-flash");
		expect(model).toBeDefined();
		expect(model!.id).toBe("deepseek-v4-flash");
		expect(model!.requestModelId).toBe("DeepSeek V4 Flash");
		expect(resolveWireModelId(model!, Effort.Max)).toBe("DeepSeek V4 Flash");
		expect(resolveWireModelId(model!, undefined)).toBe("DeepSeek V4 Flash");

		const wireModelIds: unknown[] = [];
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const body =
				input instanceof Request
					? ((await input.clone().json()) as Record<string, unknown>)
					: (JSON.parse(String(init?.body)) as Record<string, unknown>);
			wireModelIds.push(body.model);
			return new Response(JSON.stringify({ error: { message: "Unauthorized" } }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			});
		});
		const result = await streamOpenAICompletions(
			model as Model<"openai-completions">,
			{
				messages: [{ role: "user", content: "hello", timestamp: 1_700_000_000_000 }],
			},
			{
				apiKey: "test",
				fetch: fetchMock as unknown as typeof fetch,
				reasoning: Effort.Max,
			},
		).result();
		expect(result.stopReason).toBe("error");
		expect(wireModelIds[0]).toBe("DeepSeek V4 Flash");
	});
});
