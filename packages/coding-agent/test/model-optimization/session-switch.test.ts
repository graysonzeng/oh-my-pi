import { afterAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { shouldInlineToolDescriptors } from "../../src/config/inline-tool-descriptors-mode";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import {
	buildOrdinaryDecisionReceipt,
	buildResolvedModelOptimization,
	DEFAULT_MODEL_OPTIMIZATION_PROFILES,
	ORDINARY_DECISION_RECEIPT_KIND,
} from "../../src/model-optimization";
import type { ModelOptimizationProfile, ResolvedModelOptimization } from "../../src/model-optimization/types";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";

const tempDir = TempDir.createSync("@pi-model-optimization-");
const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
authStorage.setRuntimeApiKey("anthropic", "test-key");
authStorage.setRuntimeApiKey("openai", "test-key");
authStorage.setRuntimeApiKey("google", "test-key");
const modelRegistry = new ModelRegistry(authStorage);

afterAll(() => {
	authStorage.close();
	tempDir.removeSync();
});

function requiredModel(provider: "anthropic" | "openai" | "google", id: string) {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Missing bundled test model ${provider}/${id}`);
	return model;
}

const claudeProfile: ModelOptimizationProfile = {
	id: "claude-normal",
	modelPattern: "claude-*",
	promptStrategy: { kind: "concise", systemPromptTemplate: "concise-claude" },
	toolStrategy: { maxConcurrentTools: 2, resourceConflictMode: "serialize" },
	contextStrategy: { targetUtilization: 0.75 },
};

const gptProfile: ModelOptimizationProfile = {
	id: "gpt-normal",
	modelPattern: "gpt-5*",
	promptStrategy: { kind: "structured", systemPromptTemplate: "structured-gpt" },
	toolStrategy: { maxConcurrentTools: 4, resourceConflictMode: "conservative" },
	contextStrategy: { targetUtilization: 0.65 },
};

const summarizationOnlyProfile: ModelOptimizationProfile = {
	id: "summarize-only",
	modelPattern: "claude-*",
	toolStrategy: {
		outputTruncation: { enabled: false, rules: [] },
		resultSummarization: { enabled: true, summarizerKeys: ["bash", "*"] },
	},
};

function createDispatchSession() {
	const claude = requiredModel("anthropic", "claude-sonnet-4-5");
	const gpt = requiredModel("openai", "gpt-5");
	const prompts: string[] = [];
	const mock = createMockModel({ responses: [{ content: ["ok"] }, { content: ["ok"] }] });
	const runtime: { resolved: ResolvedModelOptimization } = { resolved: {} };
	const agent = new Agent({
		initialState: { model: claude, systemPrompt: ["base"], tools: [], messages: [] },
		streamFn: (model, context, options) => {
			prompts.push(context.systemPrompt?.join("\n") ?? "");
			return mock.stream(model, context, options);
		},
	});
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry,
		reconcileModelOptimization: async model =>
			buildResolvedModelOptimization(model.provider === "anthropic" ? claudeProfile : gptProfile),
		applyModelOptimization: resolved => {
			runtime.resolved = resolved;
		},
		rebuildSystemPrompt: async () => ({
			systemPrompt: runtime.resolved.promptBlock ? ["base", runtime.resolved.promptBlock] : ["base"],
		}),
	});
	return { session, gpt, prompts };
}

function createCandidateSession(profile: ModelOptimizationProfile, settings: Record<string, unknown> = {}) {
	const model = requiredModel("anthropic", "claude-sonnet-4-5");
	const mock = createMockModel({ responses: [{ content: ["ok"] }] });
	const runtime: { resolved: ResolvedModelOptimization } = { resolved: {} };
	const agent = new Agent({
		initialState: { model, systemPrompt: ["base"], tools: [], messages: [] },
		streamFn: (activeModel, context, options) => mock.stream(activeModel, context, options),
	});
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({
			"compaction.enabled": false,
			"modelOptimization.enabled": true,
			"latency.arms.contextBudgetTuning": false,
			...settings,
		}),
		modelRegistry,
		reconcileModelOptimization: async () => buildResolvedModelOptimization(profile),
		applyModelOptimization: resolved => {
			runtime.resolved = resolved;
		},
	});
	return { session, runtime };
}

describe("ordinary-session model optimization lifecycle", () => {
	it("reconciles the active model before yield-queue idle prompt dispatch", async () => {
		const { session, gpt, prompts } = createDispatchSession();
		try {
			await session.ensureModelOptimization();
			session.agent.setModel(gpt);
			session.yieldQueue.register<string>("model-optimization-test", {
				skipIdleFlush: true,
				build: entries => ({
					role: "custom",
					customType: "model-optimization-test",
					content: entries.join(","),
					display: false,
					attribution: "agent",
					timestamp: Date.now(),
				}),
			});
			session.yieldQueue.enqueue("model-optimization-test", "idle");

			await session.yieldQueue.flush("idle");
			await session.waitForIdle();

			expect(prompts).toHaveLength(1);
			expect(prompts[0]).toContain("structured-gpt");
			expect(prompts[0]).not.toContain("concise-claude");
		} finally {
			await session.dispose();
		}
	});

	it("reconciles the active model before an agent-initiated prompt dispatch", async () => {
		const { session, gpt, prompts } = createDispatchSession();
		try {
			await session.ensureModelOptimization();
			session.agent.setModel(gpt);

			const started = await session.sendCustomMessage(
				{
					customType: "model-optimization-test",
					content: "agent initiated",
					display: false,
					attribution: "agent",
				},
				{ triggerTurn: true },
			);

			expect(started).toBe(true);
			expect(prompts).toHaveLength(1);
			expect(prompts[0]).toContain("structured-gpt");
			expect(prompts[0]).not.toContain("concise-claude");
		} finally {
			await session.dispose();
		}
	});

	it("replaces A -> B -> A prompt, scheduling, and context policy without stale state", async () => {
		const claude = requiredModel("anthropic", "claude-sonnet-4-5");
		const gpt = requiredModel("openai", "gpt-5");
		const runtime: { resolved: ResolvedModelOptimization } = { resolved: {} };
		const agent = new Agent({
			initialState: { model: claude, systemPrompt: ["base"], tools: [], messages: [] },
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
			reconcileModelOptimization: async model => {
				if (model.provider === "anthropic") return buildResolvedModelOptimization(claudeProfile);
				if (model.provider === "openai") return buildResolvedModelOptimization(gptProfile);
				return {};
			},
			applyModelOptimization: resolved => {
				runtime.resolved = resolved;
			},
			rebuildSystemPrompt: async () => ({
				systemPrompt: runtime.resolved.promptBlock ? ["base", runtime.resolved.promptBlock] : ["base"],
			}),
		});

		try {
			await session.ensureModelOptimization();
			expect(session.activeModelOptimizationProfileId).toBe("claude-normal");
			expect(session.agent.getToolScheduling()?.maxConcurrentTools).toBe(2);
			expect(session.modelOptimizationContextStrategy?.targetUtilization).toBe(0.75);
			expect(session.agent.state.systemPrompt.join("\n")).toContain("concise-claude");

			await session.setModelTemporary(gpt);
			expect(session.activeModelOptimizationProfileId).toBe("gpt-normal");
			expect(session.agent.getToolScheduling()?.maxConcurrentTools).toBe(4);
			expect(session.modelOptimizationContextStrategy?.targetUtilization).toBe(0.65);
			expect(session.agent.state.systemPrompt.join("\n")).toContain("structured-gpt");
			expect(session.agent.state.systemPrompt.join("\n")).not.toContain("concise-claude");

			await session.setModelTemporary(claude);
			const prompt = session.agent.state.systemPrompt.join("\n");
			expect(session.activeModelOptimizationProfileId).toBe("claude-normal");
			expect(session.agent.getToolScheduling()?.maxConcurrentTools).toBe(2);
			expect(session.modelOptimizationContextStrategy?.targetUtilization).toBe(0.75);
			expect(prompt.match(/concise-claude/g) ?? []).toHaveLength(1);
			expect(prompt).not.toContain("structured-gpt");
		} finally {
			await session.dispose();
		}
	});

	it("clears the prior optimization when reconcile fails", async () => {
		const claude = requiredModel("anthropic", "claude-sonnet-4-5");
		const gpt = requiredModel("openai", "gpt-5");
		const runtime: { resolved: ResolvedModelOptimization } = { resolved: {} };
		const agent = new Agent({
			initialState: { model: claude, systemPrompt: ["base"], tools: [], messages: [] },
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
			reconcileModelOptimization: async model => {
				if (model.provider === "openai") throw new Error("test reconcile failure");
				return buildResolvedModelOptimization(claudeProfile);
			},
			applyModelOptimization: resolved => {
				runtime.resolved = resolved;
			},
			rebuildSystemPrompt: async () => ({
				systemPrompt: runtime.resolved.promptBlock ? ["base", runtime.resolved.promptBlock] : ["base"],
			}),
		});

		try {
			await session.ensureModelOptimization();
			await session.setModelTemporary(gpt);

			expect(session.activeModelOptimizationProfileId).toBeUndefined();
			expect(session.agent.getToolScheduling()).toBeUndefined();
			expect(session.modelOptimizationContextStrategy).toBeUndefined();
			expect(runtime.resolved).toEqual({});
			expect(session.agent.state.systemPrompt).toEqual(["base"]);
		} finally {
			await session.dispose();
		}
	});
});

describe("context-budget candidate arm", () => {
	const lunaProfile = DEFAULT_MODEL_OPTIMIZATION_PROFILES.luna;
	const claudeDefaultProfile = DEFAULT_MODEL_OPTIMIZATION_PROFILES.claude;

	it("keeps Luna on its base context strategy when the tuning arm is off", async () => {
		const { session, runtime } = createCandidateSession(lunaProfile);
		try {
			await session.ensureModelOptimization();
			expect(session.modelOptimizationContextStrategy?.targetUtilization).toBe(0.75);
			expect(session.modelOptimizationContextStrategy?.eviction?.keepRecentN).toBe(10);
			expect(session.modelOptimizationContextStrategy?.toolHistory?.maxToolCalls).toBe(10);
			expect(runtime.resolved.contextBudgetTuning?.applied).toBe(false);
			expect(runtime.resolved.contextBudgetTuning?.version).toBe(1);
		} finally {
			await session.dispose();
		}
	});

	it("applies only the Luna v1 candidate when both frozen context arms are on", async () => {
		const { session, runtime } = createCandidateSession(lunaProfile, {
			"latency.arms.contextBudgetTuning": true,
		});
		try {
			await session.ensureModelOptimization();
			expect(session.modelOptimizationContextStrategy?.targetUtilization).toBe(0.7);
			expect(session.modelOptimizationContextStrategy?.eviction?.keepRecentN).toBe(8);
			expect(session.modelOptimizationContextStrategy?.toolHistory?.maxToolCalls).toBe(8);
			expect(runtime.resolved.contextBudgetTuning).toMatchObject({
				applied: true,
				version: 1,
				targetUtilization: 0.7,
				keepRecentN: 8,
				maxToolCalls: 8,
			});
			const receipt = buildOrdinaryDecisionReceipt({
				resolved: runtime.resolved,
				descriptorPlacement: "provider_schema",
			});
			expect(receipt.applied.contextBudgetTuning).toBe(true);
			expect(receipt.contextBudgetTuning).toMatchObject({ applied: true, version: 1, targetUtilization: 0.7 });
		} finally {
			await session.dispose();
		}
	});

	it("fails open for a missing main gate and for profiles without a candidate", async () => {
		const gated = createCandidateSession(lunaProfile, {
			"modelOptimization.enabled": false,
			"latency.arms.contextBudgetTuning": true,
		});
		const noCandidate = createCandidateSession(claudeDefaultProfile, {
			"latency.arms.contextBudgetTuning": true,
		});
		try {
			await gated.session.ensureModelOptimization();
			await noCandidate.session.ensureModelOptimization();
			expect(gated.runtime.resolved.contextBudgetTuning?.applied).toBe(false);
			expect(gated.session.modelOptimizationContextStrategy?.targetUtilization).toBe(0.75);
			expect(noCandidate.runtime.resolved.contextBudgetTuning?.applied).toBe(false);
			expect(noCandidate.runtime.resolved.contextBudgetTuning?.version).toBeUndefined();
			expect(noCandidate.session.modelOptimizationContextStrategy?.targetUtilization).toBe(0.75);
			expect(noCandidate.session.modelOptimizationContextStrategy?.eviction?.keepRecentN).toBe(12);
		} finally {
			await gated.session.dispose();
			await noCandidate.session.dispose();
		}
	});

	it("keeps the candidate decision frozen after live settings change", async () => {
		const { session, runtime } = createCandidateSession(lunaProfile, {
			"latency.arms.contextBudgetTuning": true,
		});
		try {
			await session.ensureModelOptimization();
			session.settings.set("modelOptimization.enabled", false);
			session.settings.set("latency.arms.contextBudgetTuning", false);
			await session.ensureModelOptimization();
			expect(runtime.resolved.contextBudgetTuning?.applied).toBe(true);
			expect(session.modelOptimizationContextStrategy?.targetUtilization).toBe(0.7);
			expect(session.modelOptimizationContextStrategy?.eviction?.keepRecentN).toBe(8);
		} finally {
			await session.dispose();
		}
	});
});

describe("Gemini descriptor placement refresh", () => {
	it("auto mode flips Gemini ↔ non-Gemini and keeps system/provider prune aligned", async () => {
		const claude = requiredModel("anthropic", "claude-sonnet-4-5");
		const gemini = requiredModel("google", "gemini-2.5-flash");
		const runtime: { resolved: ResolvedModelOptimization } = { resolved: {} };
		const mode: "auto" | "on" | "off" = "auto";
		let lastInlineInPrompt: boolean | undefined;
		const agent = new Agent({
			initialState: { model: claude, systemPrompt: ["base"], tools: [], messages: [] },
			// Boolean freeze would regress mid-session; session rebinds a live getter.
			pruneToolDescriptions: false,
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ inlineToolDescriptors: mode }),
			modelRegistry,
			pruneToolDescriptions: shouldInlineToolDescriptors(mode, claude.id),
			resolveInlineToolDescriptors: modelId => shouldInlineToolDescriptors(mode, modelId),
			reconcileModelOptimization: async model =>
				buildResolvedModelOptimization(model.provider === "anthropic" ? claudeProfile : gptProfile),
			applyModelOptimization: resolved => {
				runtime.resolved = resolved;
			},
			rebuildSystemPrompt: async () => {
				lastInlineInPrompt = session.inlineToolDescriptors;
				const mark = lastInlineInPrompt ? "inline-on" : "inline-off";
				return {
					systemPrompt: runtime.resolved.promptBlock
						? ["base", mark, runtime.resolved.promptBlock]
						: ["base", mark],
				};
			},
		});

		try {
			expect(session.inlineToolDescriptors).toBe(false);
			expect(session.descriptorPlacement).toBe("provider_schema");
			expect(session.agent.getPruneToolDescriptions()).toBe(false);

			await session.setModelTemporary(gemini);
			expect(session.inlineToolDescriptors).toBe(true);
			expect(session.descriptorPlacement).toBe("system_inline");
			expect(session.agent.getPruneToolDescriptions()).toBe(true);
			expect(lastInlineInPrompt).toBe(true);
			expect(session.agent.state.systemPrompt.join("\n")).toContain("inline-on");

			await session.setModelTemporary(claude);
			expect(session.inlineToolDescriptors).toBe(false);
			expect(session.descriptorPlacement).toBe("provider_schema");
			expect(session.agent.getPruneToolDescriptions()).toBe(false);
			expect(lastInlineInPrompt).toBe(false);
			expect(session.agent.state.systemPrompt.join("\n")).toContain("inline-off");
		} finally {
			await session.dispose();
		}
	});

	it("explicit on/off stays fixed across model switches", async () => {
		const claude = requiredModel("anthropic", "claude-sonnet-4-5");
		const gemini = requiredModel("google", "gemini-2.5-flash");

		for (const mode of ["on", "off"] as const) {
			const expected = mode === "on";
			const agent = new Agent({
				initialState: { model: claude, systemPrompt: ["base"], tools: [], messages: [] },
			});
			const session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated({ inlineToolDescriptors: mode }),
				modelRegistry,
				pruneToolDescriptions: expected,
				resolveInlineToolDescriptors: modelId => shouldInlineToolDescriptors(mode, modelId),
				rebuildSystemPrompt: async () => ({
					systemPrompt: ["base", session.inlineToolDescriptors ? "inline-on" : "inline-off"],
				}),
			});
			try {
				expect(session.inlineToolDescriptors).toBe(expected);
				await session.setModelTemporary(gemini);
				expect(session.inlineToolDescriptors).toBe(expected);
				expect(session.agent.getPruneToolDescriptions()).toBe(expected);
				await session.setModelTemporary(claude);
				expect(session.inlineToolDescriptors).toBe(expected);
				expect(session.agent.getPruneToolDescriptions()).toBe(expected);
			} finally {
				await session.dispose();
			}
		}
	});
});

describe("ordinary decision receipt + summarization-only gate", () => {
	it("buildOrdinaryDecisionReceipt records model/profile/descriptor/context", () => {
		const resolved = buildResolvedModelOptimization(claudeProfile);
		const receipt = buildOrdinaryDecisionReceipt({
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			resolved,
			descriptorPlacement: "provider_schema",
			toolCallId: "tc1",
			tool: "bash",
			toolTransform: "truncate",
			originalBytes: 1000,
			visibleBytes: 100,
			recoveryUri: "artifact://x",
		});
		expect(receipt.kind).toBe(ORDINARY_DECISION_RECEIPT_KIND);
		expect(receipt.schemaVersion).toBe(1);
		expect(receipt.profileId).toBe("claude-normal");
		expect(receipt.applied.promptBlock).toBe(true);
		expect(receipt.applied.toolScheduling).toBe(true);
		expect(receipt.applied.contextStrategy).toBe(true);
		expect(receipt.applied.descriptorPlacement).toBe("provider_schema");
		expect(receipt.contextDecision?.providerViewOnly).toBe(true);
		expect(receipt.recoveryUri).toBe("artifact://x");
	});

	it("summarization-only profile still enters ordinary tool processing", () => {
		const resolved = buildResolvedModelOptimization(summarizationOnlyProfile);
		expect(resolved.profile?.toolStrategy?.outputTruncation?.enabled).toBe(false);
		expect(resolved.profile?.toolStrategy?.resultSummarization?.enabled).toBe(true);
		// Gate contract: either lever is enough (mirrors #optimizeOrdinaryToolResult).
		const tool = resolved.profile?.toolStrategy;
		const truncationOn = tool?.outputTruncation?.enabled === true;
		const summarizationOn = tool?.resultSummarization?.enabled === true;
		expect(truncationOn || summarizationOn).toBe(true);
	});

	it("feature-off baseline returns empty resolved policy", async () => {
		const claude = requiredModel("anthropic", "claude-sonnet-4-5");
		const agent = new Agent({
			initialState: { model: claude, systemPrompt: ["base"], tools: [], messages: [] },
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "modelOptimization.enabled": false }),
			modelRegistry,
			// No reconcile callback mirrors feature-off / workflow skip path.
		});
		try {
			await session.ensureModelOptimization();
			expect(session.activeModelOptimizationProfileId).toBeUndefined();
			expect(session.modelOptimizationContextStrategy).toBeUndefined();
			expect(session.agent.getToolScheduling()).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});
});
