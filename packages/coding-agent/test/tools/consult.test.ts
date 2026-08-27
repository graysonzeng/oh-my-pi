import { afterEach, describe, expect, it, vi } from "bun:test";
import { type AgentMessage, Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { completeSimple, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets/obfuscator";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ConsultTool } from "@oh-my-pi/pi-coding-agent/tools/consult";
import { resolveConsultSelection } from "@oh-my-pi/pi-coding-agent/tools/consult-model";
import { resetConsultTurn } from "@oh-my-pi/pi-coding-agent/tools/consult-state";
import { CONSULT_TOOL_RESULT_CHARS, projectConsultContext } from "@oh-my-pi/pi-coding-agent/tools/consult-transcript";

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
		agentKind?: "main" | "sub";
		active?: Model;
		consultOverride?: string;
		snapshot?: { systemPrompt: string[]; messages: AgentMessage[] };
		obfuscator?: SecretObfuscator;
		getApiKey?: (model: Model, sessionId?: string, options?: { signal?: AbortSignal }) => Promise<string | undefined>;
	} = {},
): ToolSession {
	const settings = options.settings ?? Settings.isolated();
	const models = options.models ?? [primary, advisor];
	const active = options.active ?? primary;
	const apiKey = options.apiKey === undefined && !("apiKey" in options) ? "test-key" : options.apiKey;
	const getApiKey =
		options.getApiKey ?? (async (_model: Model, _sessionId?: string, _options?: { signal?: AbortSignal }) => apiKey);
	return {
		cwd: "/tmp/consult-test",
		hasUI: false,
		skipPythonPreflight: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
		taskDepth: options.taskDepth ?? 0,
		agentKind: options.agentKind,
		getActiveModel: () => active,
		getActiveModelString: () => `${active.provider}/${active.id}`,
		getConsultModelOverride: () => options.consultOverride,
		snapshotConsultContext: options.snapshot ? () => options.snapshot! : undefined,
		getSecretObfuscator: () => options.obfuscator,
		modelRegistry: {
			getAvailable: () => models,
			getApiKey,
			resolver: () => async () => apiKey,
		} as unknown as NonNullable<ToolSession["modelRegistry"]>,
	};
}

function completeStub(
	text: string,
	stopReason: "stop" | "length" | "error" | "aborted" = "stop",
	errorMessage?: string,
) {
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
			errorMessage: errorMessage ?? (stopReason === "error" ? "upstream 500" : undefined),
			timestamp: Date.now(),
			content: text ? [{ type: "text", text }] : [],
		};
	}) as typeof completeSimple;
	return { calls, fn };
}

function toolText(result: { content: Array<{ type?: string; text?: string }> }): string {
	const block = result.content[0];
	return block && typeof block.text === "string" ? block.text : "";
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

	it("stays unregistered on nested clones even at taskDepth 0", async () => {
		const names = (
			await createTools(
				makeSession({
					settings: Settings.isolated({ "consult.enabled": true, "tools.xdev": false }),
					agentKind: "sub",
				}),
			)
		).map(tool => tool.name);
		expect(names).not.toContain("consult");
	});

	it("drops consult from inherited toolNames on nested clones", async () => {
		const names = (
			await createTools(
				makeSession({
					settings: Settings.isolated({ "consult.enabled": true, "tools.xdev": false }),
					agentKind: "sub",
				}),
				["consult", "read"],
			)
		).map(tool => tool.name);
		expect(names).not.toContain("consult");
		expect(names).toContain("read");
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

	it("rejects missing credentials before same-model", async () => {
		const session = makeSession({
			settings: Settings.isolated({ "consult.enabled": true, "consult.model": "openai/gpt-4.1" }),
			models: [primary],
			active: primary,
			apiKey: undefined,
		});
		const resolved = await resolveConsultSelection(session);
		expect(resolved.ok).toBe(false);
		if (!resolved.ok) expect(resolved.error).toBe("no_credentials");
	});

	it("forwards the abort signal to getApiKey", async () => {
		const controller = new AbortController();
		let seen: AbortSignal | undefined;
		const session = makeSession({
			settings: Settings.isolated({ "consult.enabled": true, "consult.model": "openai/o3" }),
			getApiKey: async (_model, _sessionId, options) => {
				seen = options?.signal;
				return "test-key";
			},
		});
		const resolved = await resolveConsultSelection(session, controller.signal);
		expect(resolved.ok).toBe(true);
		expect(seen).toBe(controller.signal);
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

	it("fits the final redacted request into the true remaining context window", () => {
		const droppable = `droppable-marker ${Array.from({ length: 250 }, (_, index) => `unique-${index}`).join(" ")}`;
		const messages: AgentMessage[] = [
			userMessage("original task: keep AGENTS.md"),
			assistantText(droppable),
			userMessage("current task: still keep AGENTS.md"),
		];
		const model = { ...advisor, contextWindow: 2000 };
		const maxTokens = 1200;
		const projection = projectConsultContext({
			snapshot: {
				systemPrompt: ["You MUST follow AGENTS.md."],
				messages,
			},
			model,
			primaryModel: "openai/gpt-4.1",
			maxTokens,
			secretsEnabled: false,
		});
		expect("error" in projection).toBe(false);
		if ("error" in projection) return;
		expect(projection.truncatedHistory).toBe(true);
		expect(projection.userPrompt).not.toContain("droppable-marker");
		const budget = Math.max(0, (model.contextWindow ?? 0) - maxTokens);
		expect(new Tokenizer(model).checkTokenBudget([projection.systemPrompt, projection.userPrompt], budget).fits).toBe(
			true,
		);
	});

	it("refits after secret placeholders expand droppable history", () => {
		const secret = "s3cret99";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }], "consult-budget-key");
		const droppable = `droppable-marker ${Array.from({ length: 80 }, () => secret).join(" ")}`;
		const messages: AgentMessage[] = [
			userMessage("original task: keep AGENTS.md"),
			assistantText(droppable),
			userMessage("current task: still keep AGENTS.md"),
		];
		const model = { ...advisor, contextWindow: 2000 };
		const maxTokens = 1200;
		const projection = projectConsultContext({
			snapshot: {
				systemPrompt: ["You MUST follow AGENTS.md."],
				messages,
			},
			model,
			primaryModel: "openai/gpt-4.1",
			maxTokens,
			secretsEnabled: true,
			obfuscator,
		});
		expect("error" in projection).toBe(false);
		if ("error" in projection) return;
		expect(projection.truncatedHistory).toBe(true);
		expect(projection.userPrompt).not.toContain(secret);
		expect(projection.userPrompt).not.toContain("droppable-marker");
		const budget = Math.max(0, (model.contextWindow ?? 0) - maxTokens);
		expect(new Tokenizer(model).checkTokenBudget([projection.systemPrompt, projection.userPrompt], budget).fits).toBe(
			true,
		);
	});

	it("still sends pinned-only content when that alone exceeds the budget", () => {
		const pinned = "P".repeat(4000);
		const projection = projectConsultContext({
			snapshot: {
				systemPrompt: [pinned],
				messages: [userMessage(pinned), assistantText("droppable middle"), userMessage(pinned)],
			},
			model: { ...advisor, contextWindow: 1800 },
			primaryModel: "openai/gpt-4.1",
			maxTokens: 1600,
			secretsEnabled: false,
		});
		expect("error" in projection).toBe(false);
		if ("error" in projection) return;
		expect(projection.truncatedHistory).toBe(true);
		expect(projection.userPrompt).toContain(pinned);
		expect(projection.userPrompt).not.toContain("droppable middle");
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
	afterEach(() => {
		vi.restoreAllMocks();
	});

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
		const options = stub.calls[0]?.[2] as { maxTokens?: number; apiKey?: unknown } | undefined;
		expect(options?.maxTokens).toBe(333);
		expect(options?.apiKey).toBe("test-key");
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
		expect(toolText(result)).toContain("provider_error");
	});

	it("rejects same-model at execute with zero complete calls", async () => {
		const stub = completeStub("should not run");
		const session = makeSession({
			settings: Settings.isolated({ "consult.enabled": true, "consult.model": "openai/gpt-4.1" }),
			models: [primary],
			active: primary,
			snapshot: { systemPrompt: ["keep"], messages: [userMessage("task")] },
		});
		const tool = new ConsultTool(session, stub.fn);
		const result = await tool.execute("c1", {});
		expect(result.isError).toBe(true);
		expect(toolText(result)).toBe("same_model");
		expect(stub.calls).toHaveLength(0);
		expect(session.consultUsage?.turn).toBe(1);
		expect(session.consultUsage?.session).toBe(1);
	});

	it("rejects missing credentials at execute with zero complete calls", async () => {
		const stub = completeStub("should not run");
		const session = makeSession({
			settings: Settings.isolated({ "consult.enabled": true, "consult.model": "openai/o3" }),
			apiKey: undefined,
			snapshot: { systemPrompt: ["keep"], messages: [userMessage("task")] },
		});
		const tool = new ConsultTool(session, stub.fn);
		const result = await tool.execute("c1", {});
		expect(result.isError).toBe(true);
		expect(toolText(result)).toBe("no_credentials");
		expect(stub.calls).toHaveLength(0);
		expect(session.consultUsage?.turn).toBe(1);
		expect(session.consultUsage?.session).toBe(1);
	});

	it("maps credential abort to aborted and records one attempt", async () => {
		const stub = completeStub("should not run");
		const controller = new AbortController();
		controller.abort();
		const session = makeSession({
			settings: Settings.isolated({ "consult.enabled": true, "consult.model": "openai/o3" }),
			snapshot: { systemPrompt: ["keep"], messages: [userMessage("task")] },
			getApiKey: async () => {
				const error = new Error("credential lookup aborted");
				error.name = "AbortError";
				throw error;
			},
		});
		const tool = new ConsultTool(session, stub.fn);
		const result = await tool.execute("c1", {}, controller.signal);
		expect(result.isError).toBe(true);
		expect(toolText(result)).toContain("aborted");
		expect(stub.calls).toHaveLength(0);
		expect(session.consultUsage?.session).toBe(1);
	});

	it("maps credential lookup timeout to timeout without complete calls", async () => {
		const stub = completeStub("should not run");
		let credentialCalls = 0;
		const session = makeSession({
			settings: Settings.isolated({
				"consult.enabled": true,
				"consult.model": "openai/o3",
				"consult.timeoutMs": 5,
			}),
			snapshot: { systemPrompt: ["keep"], messages: [userMessage("task")] },
			getApiKey: async (_model, _sessionId, options) => {
				credentialCalls += 1;
				const pending = Promise.withResolvers<string>();
				const guard = AbortSignal.timeout(500);
				guard.addEventListener("abort", () => pending.reject(new Error("credential signal was not forwarded")), {
					once: true,
				});
				const abort = () => {
					const error = new Error("credential lookup timed out");
					error.name = "AbortError";
					pending.reject(error);
				};
				if (options?.signal?.aborted) abort();
				else options?.signal?.addEventListener("abort", abort, { once: true });
				return pending.promise;
			},
		});
		const tool = new ConsultTool(session, stub.fn);
		const result = await tool.execute("c1", {});
		expect(result.isError).toBe(true);
		expect(toolText(result)).toContain("timeout");
		expect(credentialCalls).toBe(1);
		expect(stub.calls).toHaveLength(0);
		expect(session.consultUsage?.session).toBe(1);
	});

	it("maps credential throw to provider_error without complete calls", async () => {
		const stub = completeStub("should not run");
		const session = makeSession({
			settings: Settings.isolated({ "consult.enabled": true, "consult.model": "openai/o3" }),
			snapshot: { systemPrompt: ["keep"], messages: [userMessage("task")] },
			getApiKey: async () => {
				throw new Error("vault unavailable");
			},
		});
		const tool = new ConsultTool(session, stub.fn);
		const result = await tool.execute("c1", {});
		expect(result.isError).toBe(true);
		expect(toolText(result)).toContain("provider_error");
		expect(toolText(result)).toContain("vault unavailable");
		expect(stub.calls).toHaveLength(0);
		expect(session.consultUsage?.session).toBe(1);
	});

	it("maps a thrown provider error and remains usable afterward", async () => {
		let calls = 0;
		const success = completeStub("retry ok").fn;
		const fn: typeof completeSimple = async (model, context, options) => {
			calls += 1;
			if (calls === 1) throw new Error("socket reset");
			return success(model, context, options);
		};
		const session = makeSession({
			settings: Settings.isolated({ "consult.enabled": true, "consult.model": "openai/o3" }),
			snapshot: { systemPrompt: ["keep"], messages: [userMessage("task")] },
		});
		const tool = new ConsultTool(session, fn);
		const failed = await tool.execute("c1", {});
		expect(failed.isError).toBe(true);
		expect(toolText(failed)).toContain("provider_error");
		expect(toolText(failed)).toContain("socket reset");
		expect(session.consultUsage?.session).toBe(1);
		const recovered = await tool.execute("c2", {});
		expect(recovered.isError).toBeUndefined();
		expect(toolText(recovered)).toBe("retry ok");
		expect(session.consultUsage?.session).toBe(2);
		expect(calls).toBe(2);
	});

	it("truncates long provider error messages to the consult result cap", async () => {
		const long = "E".repeat(CONSULT_TOOL_RESULT_CHARS + 80);
		const fn = (async () => {
			throw new Error(long);
		}) as typeof completeSimple;
		const session = makeSession({
			settings: Settings.isolated({ "consult.enabled": true, "consult.model": "openai/o3" }),
			snapshot: { systemPrompt: ["keep"], messages: [userMessage("task")] },
		});
		const tool = new ConsultTool(session, fn);
		const result = await tool.execute("c1", {});
		const text = toolText(result);
		expect(result.isError).toBe(true);
		expect(text.startsWith("provider_error: ")).toBe(true);
		expect(text.length).toBe("provider_error: ".length + CONSULT_TOOL_RESULT_CHARS);
		expect(text.endsWith("…")).toBe(true);
		expect(text).not.toContain(long);
	});

	it("truncates provider stopReason error messages to the consult result cap", async () => {
		const long = "E".repeat(CONSULT_TOOL_RESULT_CHARS + 80);
		const stub = completeStub("", "error", long);
		const session = makeSession({
			settings: Settings.isolated({ "consult.enabled": true, "consult.model": "openai/o3" }),
			snapshot: { systemPrompt: ["keep"], messages: [userMessage("task")] },
		});
		const tool = new ConsultTool(session, stub.fn);
		const result = await tool.execute("c1", {});
		const text = toolText(result);
		expect(result.isError).toBe(true);
		expect(text.startsWith("provider_error: ")).toBe(true);
		expect(text.length).toBe("provider_error: ".length + CONSULT_TOOL_RESULT_CHARS);
		expect(text.endsWith("…")).toBe(true);
		expect(text).not.toContain(long);
	});

	it("fails closed on inconsistent obfuscation with zero complete calls", async () => {
		const stub = completeStub("should not run");
		const obfuscator = new SecretObfuscator([{ type: "plain", content: "sk-supersecret-token" }]);
		vi.spyOn(obfuscator, "obfuscate").mockImplementation((text: string) =>
			text.includes("\n") ? `JOINED:${text}` : text,
		);
		const session = makeSession({
			settings: Settings.isolated({
				"consult.enabled": true,
				"consult.model": "openai/o3",
				"secrets.enabled": true,
			}),
			snapshot: { systemPrompt: ["keep sk-supersecret-token"], messages: [userMessage("task")] },
			obfuscator,
		});
		const tool = new ConsultTool(session, stub.fn);
		const result = await tool.execute("c1", {});
		expect(result.isError).toBe(true);
		expect(toolText(result)).toBe("redaction_unavailable");
		expect(stub.calls).toHaveLength(0);
		expect(session.consultUsage?.session).toBe(1);
	});
});
