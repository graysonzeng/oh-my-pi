import { describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { DEFAULT_MODEL_OPTIMIZATION_PROFILES } from "../../src/model-optimization/default-profiles";
import { buildResolvedModelOptimization } from "../../src/model-optimization/runtime-policy";
import {
	buildOrdinaryTaskPolicy,
	buildWorkflowTaskPolicy,
	capabilityDecisionSnapshot,
	compileOrdinaryAdaptedPolicy,
	compileWorkflowAdaptedPolicy,
	deriveModelFacts,
	deriveShadowFactsFromIdentity,
	receiptCapabilityCore,
	sameCapabilityDecisions,
	shadowCompileForModel,
} from "../../src/model-policy/adapters";

function requiredModel(provider: string, id: string) {
	const model = getBundledModel(provider as "openai", id);
	if (!model) throw new Error(`Missing bundled test model ${provider}/${id}`);
	return model;
}

describe("deriveModelFacts", () => {
	it("derives conservative unknowns for OpenAI-compatible branding", () => {
		const facts = deriveModelFacts({
			id: "custom-proxy-model",
			provider: "custom",
			api: "openai-completions",
			reasoning: false,
			contextWindow: null,
			// No thinking/compat claims → no invented capabilities
		});
		expect(facts.reasoning.mode).toBe("none");
		expect(facts.tools.parallelCalls).toBeNull();
		expect(facts.tools.strictArguments).toBeNull();
		expect(facts.tools.streamingShape).toBe("unknown");
		expect(facts.structuredOutput.tier).toBe("unknown");
		expect(facts.cache.mode).toBe("unknown");
		expect(facts.context.nativeStatefulContinuation).toBeNull();
	});

	it("uses explicit descriptor decision and catalog thinking when present", () => {
		const model = requiredModel("openai", "gpt-5");
		const facts = deriveModelFacts(model, { descriptorPlacement: "provider_schema" });
		expect(facts.identity.provider).toBe(model.provider);
		expect(facts.identity.model).toBe(model.id);
		expect(facts.identity.api).toBe(model.api);
		expect(facts.tools.descriptorPlacement).toBe("provider_schema");
		if (model.reasoning) {
			expect(facts.reasoning.mode).not.toBe("none");
		}
		// Never invent parallel without proof
		expect(facts.tools.parallelCalls).toBeNull();
	});

	it("marks gemini family descriptor as system_inline without override", () => {
		const facts = deriveModelFacts({
			id: "gemini-2.5-pro",
			provider: "google",
			api: "google-generative-ai",
			reasoning: true,
			contextWindow: 1_000_000,
		});
		expect(facts.tools.descriptorPlacement).toBe("system_inline");
	});

	it("adds documented capabilities only for first-party Moonshot K3", () => {
		const facts = deriveModelFacts(requiredModel("moonshot", "kimi-k3"));

		expect(facts.reasoning.mode).toBe("native_opaque");
		expect(facts.reasoning.replay).toBe("reasoning_content");
		expect(facts.tools.transport).toBe("native");
		expect(facts.tools.parallelCalls).toBe(true);
		expect(facts.structuredOutput).toEqual({ tier: "native_json_schema", constraints: ["MFJS"] });
		expect(facts.context.nativeStatefulContinuation).toBe(false);
		expect(facts.cache).toEqual({ mode: "exact_prefix", ordering: [], usageObservable: true });
	});

	it("keeps K3 facts conservative outside the first-party Moonshot route", () => {
		const routes = [
			{
				id: "kimi-k3",
				provider: "kimi-code",
				api: "openai-completions",
				baseUrl: "https://api.kimi.com/coding/v1",
				reasoning: true,
				contextWindow: 1_048_576,
			},
			{
				id: "moonshotai/kimi-k3",
				provider: "openrouter",
				api: "openrouter",
				baseUrl: "https://openrouter.ai/api/v1",
				reasoning: true,
				contextWindow: 1_048_576,
			},
			{
				id: "kimi-k3",
				provider: "moonshot",
				api: "openai-completions",
				baseUrl: "https://proxy.example/v1/api.moonshot.ai",
				reasoning: true,
				contextWindow: 1_048_576,
			},
		] as const;

		for (const model of routes) {
			const facts = deriveModelFacts(model);
			expect(facts.tools.parallelCalls).toBeNull();
			expect(facts.structuredOutput.tier).toBe("unknown");
			expect(facts.context.nativeStatefulContinuation).toBeNull();
			expect(facts.cache.mode).toBe("unknown");
		}
	});

	it("preserves explicit facts over the first-party K3 fill", () => {
		const facts = deriveModelFacts(
			{
				id: "kimi-k3",
				provider: "moonshot",
				api: "openai-completions",
				baseUrl: "https://api.moonshot.cn/v1",
				reasoning: false,
				contextWindow: 1_048_576,
				supportsTools: false,
				compat: { supportsStrictMode: false },
			},
			{
				facts: {
					structuredOutput: { tier: "valid_json", constraints: ["catalog_constraint"] },
					context: { nativeStatefulContinuation: true },
					cache: { mode: "explicit", ordering: ["messages"], usageObservable: false },
				},
			},
		);

		expect(facts.reasoning).toEqual({
			mode: "none",
			replay: "none",
			effortControl: "none",
			supportedEfforts: [],
			incompatibleParams: [],
		});
		expect(facts.tools.transport).toBe("text");
		expect(facts.tools.parallelCalls).toBeNull();
		expect(facts.tools.strictArguments).toBe(false);
		expect(facts.structuredOutput).toEqual({ tier: "valid_json", constraints: ["catalog_constraint"] });
		expect(facts.context.nativeStatefulContinuation).toBe(true);
		expect(facts.cache).toEqual({ mode: "explicit", ordering: ["messages"], usageObservable: false });
	});
});

describe("ordinary/workflow adapter parity", () => {
	it("produces matching capability decisions for the same model facts", () => {
		const model = requiredModel("openai", "gpt-5");
		const ordinary = compileOrdinaryAdaptedPolicy({ model });
		const workflow = compileWorkflowAdaptedPolicy({
			model,
			task: {
				role: "implementer",
				assignment: "implement safely",
				allowedToolIds: ["read", "edit", "bash"],
			},
		});

		expect(sameCapabilityDecisions(ordinary.compiledPolicy, workflow.compiledPolicy)).toBe(true);
		expect(capabilityDecisionSnapshot(ordinary.compiledPolicy).hardGuards.length).toBeGreaterThan(0);
		// Unknown structured tier → text_repair, not invented native schema
		expect(ordinary.compiledPolicy.output.tier).toBe("text_repair");
		// Parallel unproven → serial
		expect(ordinary.compiledPolicy.tools.parallelCalls).toBe(false);
		expect(ordinary.compiledPolicy.tools.maxConcurrentTools).toBe(1);
	});

	it("keeps receipts deterministic for identical inputs", () => {
		const model = requiredModel("anthropic", "claude-sonnet-4-5");
		const a = shadowCompileForModel(model, { role: "ordinary" });
		const b = shadowCompileForModel(model, { role: "ordinary" });
		expect(receiptCapabilityCore(a.receipt)).toEqual(receiptCapabilityCore(b.receipt));
		expect(a.receipt.modelFactsFingerprint).toBe(b.receipt.modelFactsFingerprint);
		expect(a.receipt.taskPolicyFingerprint).toBe(b.receipt.taskPolicyFingerprint);
	});

	it("uses conservative shadow facts when only profile identity is available", () => {
		const facts = deriveShadowFactsFromIdentity({ provider: "xai", model: "grok-*" });
		expect(facts.reasoning.mode).toBe("unknown");
		expect(facts.tools.transport).toBe("unknown");
		const adapted = compileWorkflowAdaptedPolicy({
			modelFacts: facts,
			task: { role: "planner", assignment: "plan" },
		});
		// Unknown reasoning → no wire params invented
		expect(Object.keys(adapted.compiledPolicy.reasoningAndSampling.wireParameters)).toEqual([]);
		expect(adapted.compiledPolicy.output.tier).toBe("text_repair");
		expect(adapted.compiledPolicy.tools.parallelCalls).toBe(false);
	});

	it("does not expand workflow tool intent beyond the role allowlist", () => {
		const taskInput = {
			role: "implementer" as const,
			assignment: "implement",
			allowedToolIds: ["read", "edit"],
		};
		const task = buildWorkflowTaskPolicy(taskInput);
		expect(task.toolIntent.semanticToolIds).toEqual(["read", "edit"]);
		// Compiler filters semantic tools to allowlist
		const adapted = compileWorkflowAdaptedPolicy({
			profileIdentity: { provider: "openai", model: "gpt-5" },
			task: taskInput,
			semanticTools: [
				{
					id: "read",
					description: "read",
					parametersSchema: { type: "object" },
					permission: "readonly",
				},
				{
					id: "edit",
					description: "edit",
					parametersSchema: { type: "object" },
					permission: "write",
				},
				{
					id: "bash",
					description: "bash",
					parametersSchema: { type: "object" },
					permission: "admin",
				},
			],
		});
		const ids = adapted.compiledPolicy.tools.descriptors.map(d => d.id).sort();
		expect(ids).toEqual(["edit", "read"]);
		expect(ids).not.toContain("bash");
	});

	it("feature-off gates keep hard guards while disabling lever elevation", () => {
		const model = requiredModel("openai", "gpt-5");
		const adapted = compileOrdinaryAdaptedPolicy({
			model,
			featureGates: {
				compilerShadow: false,
				compilerActive: false,
				toolSurface: false,
				structuredOutput: false,
				contextCache: false,
				runtimeCompletionGate: false,
			},
		});
		expect(adapted.compiledPolicy.guards.hard.length).toBeGreaterThan(0);
		expect(adapted.receipt.leverGates["compiler.active"]).toBe(false);
	});
});

describe("GLM/DeepSeek baseline profiles", () => {
	it("do not inherit explicit-grok or step-by-step overlays", () => {
		const glm = buildResolvedModelOptimization(DEFAULT_MODEL_OPTIMIZATION_PROFILES.glm);
		const deepseek = buildResolvedModelOptimization(DEFAULT_MODEL_OPTIMIZATION_PROFILES.deepseek);
		expect(glm.profile?.promptStrategy).toBeUndefined();
		expect(deepseek.profile?.promptStrategy).toBeUndefined();
		expect(glm.promptBlock).toBeUndefined();
		expect(deepseek.promptBlock).toBeUndefined();
		// Still keep tool/context baselines
		expect(glm.toolScheduling).toBeDefined();
		expect(deepseek.contextStrategy).toBeDefined();
	});
});

describe("task adapters", () => {
	it("builds ordinary interactive_coding policy without provider facts", () => {
		const task = buildOrdinaryTaskPolicy({ goal: "fix a bug" });
		expect(task.role).toBe("interactive_coding");
		expect(task.promptContract.goal).toBe("fix a bug");
		expect(task.outputContract.kind).toBe("natural_text");
	});
});
