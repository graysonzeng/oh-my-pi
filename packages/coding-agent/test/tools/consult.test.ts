import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { completeSimple, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets/obfuscator";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ConsultTool } from "@oh-my-pi/pi-coding-agent/tools/consult";
import { resolveConsultSelection } from "@oh-my-pi/pi-coding-agent/tools/consult-model";
import { resetConsultTurn } from "@oh-my-pi/pi-coding-agent/tools/consult-state";
import { projectConsultContext } from "@oh-my-pi/pi-coding-agent/tools/consult-transcript";

const primary: Model<"openai-responses"> = buildModel({
	id: "gpt-4.1",
	name: "GPT-4.1",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 },
	contextWindow: 128000,
	maxTokens: 4096,
});

const advisor: Model<"openai-responses"> = {
	...primary,
	id: "o3",
	name: "o3",
};

function userMessage(text: string, timestamp = 1): AgentMessage {
	return { role: "user", content: text, timestamp };
}

function assistantText(text: string, timestamp = 2): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: primary.api,
		provider: primary.provider,
		model: primary.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

function makeSession(
	options: {
		settings?: Settings;
		models?: Model[];
		apiKey?: string | undefined;
		taskDepth?: number;
		active?: Model;
		consultOverride?: string;
		snapshot?: { systemPrompt: string[]; messages: AgentMessage[] };
		obfuscator?: SecretObfuscator;
	} = {},
): ToolSession {
	const settings = options.settings ?? Settings.isolated();
	const models = options.models ?? [primary, advisor];
	const active = options.active ?? primary;
	const apiKey = options.apiKey === undefined && !("apiKey" in options) ? "test-key" : options.apiKey;
	return {
		cwd: "/tmp/consult-test",
		hasUI: false,
		skipPythonPreflight: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
		taskDepth: options.taskDepth ?? 0,
		getActiveModel: () => active,
		getActiveModelString: () => `${active.provider}/${active.id}`,
		getConsultModelOverride: () => options.consultOverride,
		snapshotConsultContext: options.snapshot ? () => options.snapshot! : undefined,
		getSecretObfuscator: () => options.obfuscator,
		modelRegistry: {
			getAvailable: () => models,
			getApiKey: async () => apiKey,
			resolver: () => async () => apiKey,
		} as unknown as NonNullable<ToolSession["modelRegistry"]>,
	};
}

function completeStub(text: string, stopReason: "stop" | "length" | "error" | "aborted" = "stop") {
	const calls: unknown[][] = [];
	const fn = (async (...args: unknown[]) => {
		calls.push(args);
		return {
			role: "assistant",
			api: advisor.api,
			provider: advisor.provider,
			model: advisor.id,
			usage: {
				input: 10,
				output: 4,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 14,
				cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
			},
			stopReason,
			errorMessage: stopReason === "error" ? "upstream 500" : undefined,
			timestamp: Date.now(),
			content: text ? [{ type: "text", text }] : [],
		};
	}) as typeof completeSimple;
	return { calls, fn };
}

describe("consult tool gating", () => {
	it("stays unregistered until consult.enabled is on", async () => {
		const names = (await createTools(makeSession({ settings: Settings.isolated({ "tools.xdev": false }) }))).map(
			tool => tool.name,
		);
		expect(names).not.toContain("consult");
	});

	it("registers when enabled on a top-level session", async () => {
		const names = (
			await createTools(
				makeSession({ settings: Settings.isolated({ "consult.enabled": true, "tools.xdev": false }) }),
			)
		).map(tool => tool.name);
		expect(names).toContain("consult");
	});

	it("stays top-level when xdev mounting is active", async () => {
		const names = (await createTools(makeSession({ settings: Settings.isolated({ "consult.enabled": true }) }))).map(
			tool => tool.name,
		);
		expect(names).toContain("consult");
	});

	it("stays unregistered in subagents even when enabled", async () => {
		const names = (
			await createTools(
				makeSession({
					settings: Settings.isolated({ "consult.enabled": true, "tools.xdev": false }),
					taskDepth: 1,
				}),
			)
		).map(tool => tool.name);
		expect(names).not.toContain("consult");
	});
});

describe("resolveConsultSelection", () => {
	it("rejects the primary model unless allowSameModel is on", async () => {
		const session = makeSession({
			settings: Settings.isolated({ "consult.enabled": true, "consult.model": "openai/gpt-4.1" }),
			models: [primary],
			active: primary,
		});
		const resolved = await resolveConsultSelection(session);
		expect(resolved.ok).toBe(false);
		if (!resolved.ok) expect(resolved.error).toBe("same_model");
	});

	it("returns no_credentials when the resolved model has no key", async () => {
		const session = makeSession({
			settings: Settings.isolated({ "consult.enabled": true, "consult.model": "openai/o3" }),
			apiKey: undefined,
			active: primary,
			models: [primary, advisor],
		});
		const resolved = await resolveConsultSelection(session);
		expect(resolved.ok).toBe(false);
		if (!resolved.ok) expect(resolved.error).toBe("no_credentials");
	});
});

describe("projectConsultContext", () => {
	it("keeps system/project constraints after dropping middle history", () => {
		const filler = "x".repeat(400);
		const messages: AgentMessage[] = [userMessage("original task: keep AGENTS.md")];
		for (let i = 0; i < 40; i++) {
			messages.push(assistantText(`${filler} middle ${i}`));
		}
		messages.push(userMessage("current task: still keep AGENTS.md"));
		const projection = projectConsultContext({
			snapshot: {
				systemPrompt: ["You MUST follow AGENTS.md.", "Project constraint: no secrets."],
				messages,
			},
			model: { ...advisor, contextWindow: 1800 },
			primaryModel: "openai/gpt-4.1",
			maxTokens: 1600,
			secretsEnabled: false,
		});
		expect("error" in projection).toBe(false);
		if ("error" in projection) return;
		expect(projection.userPrompt).toContain("You MUST follow AGENTS.md.");
		expect(projection.userPrompt).toContain("Project constraint: no secrets.");
		expect(projection.userPrompt).toContain("original task: keep AGENTS.md");
		expect(projection.userPrompt).toContain("current task: still keep AGENTS.md");
		expect(projection.truncatedHistory).toBe(true);
	});

	it("fails closed when secrets are enabled without an obfuscator", () => {
		const projection = projectConsultContext({
			snapshot: { systemPrompt: ["keep"], messages: [userMessage("task")] },
			model: advisor,
			primaryModel: "openai/gpt-4.1",
			maxTokens: 2048,
			secretsEnabled: true,
		});
		expect(projection).toEqual({ error: "redaction_unavailable" });
	});

	it("redacts secrets through the shared obfuscator", () => {
		const obfuscator = new SecretObfuscator([{ type: "plain", content: "sk-supersecret-token" }], "consult-test-key");
		const projection = projectConsultContext({
			snapshot: {
				systemPrompt: ["token sk-supersecret-token must stay local"],
				messages: [userMessage("use sk-supersecret-token")],
			},
			model: advisor,
			primaryModel: "openai/gpt-4.1",
			maxTokens: 2048,
			secretsEnabled: true,
			obfuscator,
		});
		expect("error" in projection).toBe(false);
		if ("error" in projection) return;
		expect(projection.userPrompt).not.toContain("sk-supersecret-token");
		expect(projection.systemPrompt).not.toContain("sk-supersecret-token");
	});

	it("stubs prior consult payloads so the advisor cannot re-read itself", () => {
		const callId = "consult-1";
		const messages: AgentMessage[] = [
			userMessage("ship the feature"),
			{
				role: "assistant",
				content: [{ type: "toolCall", id: callId, name: "consult", arguments: { focus: "secret prior advice" } }],
				api: primary.api,
				provider: primary.provider,
				model: primary.id,
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: callId,
				toolName: "consult",
				content: [{ type: "text", text: "PRIOR ADVICE BODY THAT MUST BE STUBBED" }],
				isError: false,
				timestamp: 3,
			},
		];
		const projection = projectConsultContext({
			snapshot: { systemPrompt: ["keep"], messages },
			model: advisor,
			primaryModel: "openai/gpt-4.1",
			maxTokens: 2048,
			secretsEnabled: false,
		});
		expect("error" in projection).toBe(false);
		if ("error" in projection) return;
		expect(projection.userPrompt).not.toContain("PRIOR ADVICE BODY THAT MUST BE STUBBED");
		expect(projection.userPrompt).toContain("omitted, see prior turn");
	});
});

describe("ConsultTool.execute", () => {
	it("returns max_uses_exceeded without calling the model", async () => {
		const stub = completeStub("should not run");
		const session = makeSession({
			settings: Settings.isolated({
				"consult.enabled": true,
				"consult.model": "openai/o3",
				"consult.maxUsesPerTurn": 1,
			}),
			snapshot: { systemPrompt: ["keep"], messages: [userMessage("task")] },
		});
		const tool = new ConsultTool(session, stub.fn);
		await tool.execute("c1", { focus: "first" });
		const blocked = await tool.execute("c2", { focus: "second" });
		expect(blocked.isError).toBe(true);
		expect(blocked.content[0]).toEqual({ type: "text", text: "max_uses_exceeded" });
		expect(stub.calls).toHaveLength(1);
	});

	it("resets the per-turn quota without clearing session usage", async () => {
		const stub = completeStub("ok");
		const session = makeSession({
			settings: Settings.isolated({
				"consult.enabled": true,
				"consult.model": "openai/o3",
				"consult.maxUsesPerTurn": 1,
			}),
			snapshot: { systemPrompt: ["keep"], messages: [userMessage("task")] },
		});
		const tool = new ConsultTool(session, stub.fn);
		await tool.execute("c1", {});
		resetConsultTurn(session);
		const second = await tool.execute("c2", {});
		expect(second.isError).toBeUndefined();
		expect(session.consultUsage?.turn).toBe(1);
		expect(session.consultUsage?.session).toBe(2);
	});

	it("passes consult.maxTokens into the oneshot", async () => {
		const stub = completeStub("Verdict: proceed.");
		const session = makeSession({
			settings: Settings.isolated({
				"consult.enabled": true,
				"consult.model": "openai/o3",
				"consult.maxTokens": 333,
			}),
			snapshot: { systemPrompt: ["keep"], messages: [userMessage("task")] },
		});
		const tool = new ConsultTool(session, stub.fn);
		const result = await tool.execute("c1", { focus: "Should I rewrite?" });
		expect(result.isError).toBeUndefined();
		expect(result.details?.maxTokens).toBe(333);
		expect(result.details?.model).toBe("openai/o3");
		const options = stub.calls[0]?.[2] as { maxTokens?: number } | undefined;
		expect(options?.maxTokens).toBe(333);
	});

	it("maps provider failures to isError without throwing", async () => {
		const stub = completeStub("", "error");
		const session = makeSession({
			settings: Settings.isolated({ "consult.enabled": true, "consult.model": "openai/o3" }),
			snapshot: { systemPrompt: ["keep"], messages: [userMessage("task")] },
		});
		const tool = new ConsultTool(session, stub.fn);
		const result = await tool.execute("c1", {});
		expect(result.isError).toBe(true);
		expect(String(result.content[0] && "text" in result.content[0] ? result.content[0].text : "")).toContain(
			"provider_error",
		);
	});
});
