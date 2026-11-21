import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { cfgAdvisorEnabled } from "@oh-my-pi/pi-coding-agent/advisor/settings";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { parseModelPattern } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as sdk from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgRetryModelFallback } from "@oh-my-pi/pi-coding-agent/session/settings";
import * as discovery from "@oh-my-pi/pi-coding-agent/task/discovery";
import {
	runStructuredSubagent,
	type StructuredSubagentRequest,
} from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BudgetLedger, createWorkflowBudgetPort } from "@oh-my-pi/pi-coding-agent/workflow/budget-ledger";
import { ProviderIdentityCollector } from "@oh-my-pi/pi-coding-agent/workflow/identity-receipt";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir, setInteractiveHost } from "@oh-my-pi/pi-utils";

const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
const realCreateAgentSession = sdk.createAgentSession;

let savedEnv: Record<string, string | undefined> = {};
let savedInteractiveHost: boolean;
let tempRoot: string;
let runCounter = 0;
const cleanups: Array<() => Promise<void>> = [];

function restoreEnvValue(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
		return;
	}
	process.env[key] = value;
	Bun.env[key] = value;
}

interface HarnessOptions {
	models: Model[];
	authenticatedProviders?: string[];
	agent?: Partial<AgentDefinition>;
	settings?: Record<string, unknown>;
	parentActiveModel?: string;
	sessionFile?: boolean;
	emitBeforeSubagentSpawn?: ToolSession["emitBeforeSubagentSpawn"];
}

async function createHarness(options: HarnessOptions) {
	const run = ++runCounter;
	const sourceId = `strict-identity-wiring-${run}`;
	const agentId = `StrictWire${run}`;
	const cwd = path.join(tempRoot, `work-${run}`);
	await fs.mkdir(cwd, { recursive: true });
	const authStorage = await AuthStorage.create(":memory:");
	for (const provider of options.authenticatedProviders ?? ["mock"]) {
		authStorage.keys.setRuntime(provider, "test-key");
	}
	registerMockApi(sourceId);
	cleanups.push(async () => {
		await AgentRegistry.global().get(agentId)?.session?.dispose();
		AgentRegistry.global().unregister(agentId);
		unregisterCustomApis(sourceId);
		authStorage.close();
	});

	const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
	const origFind = modelRegistry.find.bind(modelRegistry);
	vi.spyOn(modelRegistry, "find").mockImplementation(
		(provider, id) =>
			options.models.find(candidate => candidate.provider === provider && candidate.id === id) ??
			origFind(provider, id),
	);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(() => options.models);
	vi.spyOn(modelRegistry, "getAll").mockImplementation(() => options.models);
	vi.spyOn(modelRegistry, "awaitBackgroundRefresh").mockResolvedValue(undefined);

	const agent: AgentDefinition = {
		name: "worker",
		description: "Strict identity test worker",
		systemPrompt: "Complete the assigned task.",
		source: "bundled",
		tools: ["read"],
		...options.agent,
	};
	vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
		agents: [agent],
		projectAgentsDir: null,
	});

	const forwardedCreateOptions: Array<sdk.CreateAgentSessionOptions | undefined> = [];
	vi.spyOn(sdk, "createAgentSession").mockImplementation(createOptions => {
		forwardedCreateOptions.push(createOptions);
		return realCreateAgentSession(createOptions);
	});

	const settings = Settings.isolated({
		"task.maxRecursionDepth": 2,
		"task.isolation.enabled": false,
		"task.agentIdleTtlMs": 0,
		"async.enabled": false,
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.reminders": false,
		...options.settings,
	});

	const sessionFilePath = options.sessionFile ? path.join(cwd, "parent.jsonl") : null;
	const session = {
		cwd,
		hasUI: false,
		settings,
		authStorage,
		modelRegistry,
		restrictToolNames: true,
		enableMCP: false,
		enableLsp: false,
		enableIrc: false,
		getSessionFile: () => sessionFilePath,
		getSessionSpawns: () => "*",
		getSessionAgents: () => [],
		getActiveModelString: () => options.parentActiveModel,
		getModelString: () => options.parentActiveModel,
		emitBeforeSubagentSpawn: options.emitBeforeSubagentSpawn,
	} as unknown as ToolSession;

	return { agentId, cwd, session, settings, forwardedCreateOptions };
}

describe("strict-identity callback and executor wiring", () => {
	beforeEach(async () => {
		savedInteractiveHost = setInteractiveHost(false);
		savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-strict-identity-wiring-"));
		const home = path.join(tempRoot, "home");
		await fs.mkdir(home, { recursive: true });
		restoreEnvValue("HOME", home);
		vi.spyOn(os, "homedir").mockReturnValue(home);
		setAgentDir(path.join(home, ".omp", "agent"));
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(async () => {
		await AgentLifecycleManager.global().dispose();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		vi.restoreAllMocks();
		for (const cleanup of cleanups.splice(0)) await cleanup();
		for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
		__resetDirsFromEnvForTests();
		AgentStorage.close();
		closeModelCache();
		setInteractiveHost(savedInteractiveHost);
		await removeWithRetries(tempRoot);
	});

	it("forwards onResponse, onPayload, budgetGuard, and providerChargeKeys end-to-end", async () => {
		const primary = createMockModel({
			id: "strict-primary",
			handler: async (context, options) => {
				await options?.onPayload?.({ messages: context.messages }, primary, options.signal);
				return {
					content: ["Attested answer."],
					responseHeaders: { "x-omp-resolved-model": "mock/strict-primary" },
					usage: { input: 100, output: 50, cost: { input: 0.01, output: 0.02, total: 0.03 } },
				};
			},
		});
		const { agentId, session, forwardedCreateOptions } = await createHarness({ models: [primary] });

		const collector = new ProviderIdentityCollector();
		const ledger = new BudgetLedger({ limitUsd: 1, maxRequests: 5 });
		const budgetGuard = createWorkflowBudgetPort(ledger).bind({
			workflowId: "wf-wire",
			attemptId: "att-1",
			invocationId: "inv-1",
			profileId: "strict-profile",
			maxRequests: 5,
			maxCostUsd: 1,
		});
		const providerChargeKeys: string[] = [];
		const payloadModels: Array<string | undefined> = [];
		let ordinal = 0;
		const onPayload: NonNullable<SimpleStreamOptions["onPayload"]> = (_payload, model) => {
			ordinal += 1;
			payloadModels.push(model?.id);
			const key = budgetGuard.beforeProviderRequest({ ordinal });
			if (key) providerChargeKeys.push(key);
			return undefined;
		};

		const execution = await runStructuredSubagent({
			session,
			invocationKind: "task",
			assignment: "Return an attested answer.",
			agent: "worker",
			model: "mock/strict-primary",
			structured: false,
			strictModelIdentity: true,
			onResponse: collector.onResponse,
			onPayload,
			budgetGuard,
			providerChargeKeys,
			identity: { id: agentId },
			keepAlive: false,
		});

		expect(execution.result.exitCode).toBe(0);
		expect(execution.result.output).toBe("Attested answer.");
		expect(execution.result.providerRequests).toBe(1);
		expect(payloadModels).toEqual(["strict-primary"]);
		expect(providerChargeKeys).toEqual([]);
		expect(collector.attestedIdentity()).toEqual({
			provider: "mock",
			model: "strict-primary",
			checkpoint: null,
			provenance: "gateway_attestation",
		});
		expect(ledger.snapshot().providerRequests).toBe(1);
		expect(ledger.snapshot().costUsd).toBeCloseTo(0.03, 6);

		const forwarded = forwardedCreateOptions[0];
		expect(forwarded?.onResponse).toBe(collector.onResponse);
		expect(forwarded?.onPayload).toBe(onPayload);
		expect(forwarded?.disableModelFallback).toBe(true);
		expect(forwarded?.disableServerSideFallback).toBe(true);
		expect(forwarded?.prewalk).toBeUndefined();
	});

	it("suppresses advisor, prewalk, fallback, and spawn-hook replacement under strictModelIdentity", async () => {
		const primary = createMockModel({
			id: "strict-primary",
			handler: () => ({
				content: ["Primary answer."],
				responseHeaders: { "x-omp-resolved-model": "mock/strict-primary" },
			}),
		});
		const advisor = createMockModel({ id: "advisor-model", handler: () => ({ content: ["advisor"] }) });
		const prewalkTarget = createMockModel({ id: "prewalk-model", handler: () => ({ content: ["prewalk"] }) });
		const fallback = createMockModel({ id: "fallback-model", handler: () => ({ content: ["fallback"] }) });
		const hijack = createMockModel({ id: "hijack-model", handler: () => ({ content: ["hijack"] }) });

		const { agentId, session, forwardedCreateOptions } = await createHarness({
			models: [primary, advisor, prewalkTarget, fallback, hijack],
			agent: {
				advisor: "mock/advisor-model",
				prewalk: "mock/prewalk-model",
				model: ["mock/fallback-model"],
			},
			settings: {
				"task.agentAdvisor": { worker: "mock/advisor-model" },
				"task.agentPrewalk": { worker: "mock/prewalk-model" },
				"retry.modelFallback": true,
				"retry.fallbackChains": { default: ["mock/fallback-model"] },
				modelRoles: {
					default: "mock/fallback-model",
					advisor: "mock/advisor-model",
					smol: "mock/prewalk-model",
				},
			},
			parentActiveModel: "mock/fallback-model",
			emitBeforeSubagentSpawn: async () => ({ model: "mock/hijack-model", note: "hijack" }),
		});

		const collector = new ProviderIdentityCollector();
		const execution = await runStructuredSubagent({
			session,
			invocationKind: "task",
			assignment: "Stay pinned to strict-primary.",
			agent: "worker",
			model: "mock/strict-primary",
			structured: false,
			strictModelIdentity: true,
			onResponse: collector.onResponse,
			identity: { id: agentId },
			keepAlive: false,
		});

		expect(execution.result.exitCode).toBe(0);
		expect(primary.calls).toHaveLength(1);
		expect(advisor.calls).toHaveLength(0);
		expect(prewalkTarget.calls).toHaveLength(0);
		expect(fallback.calls).toHaveLength(0);
		expect(hijack.calls).toHaveLength(0);
		expect(collector.attestedIdentity()).toEqual({
			provider: "mock",
			model: "strict-primary",
			checkpoint: null,
			provenance: "gateway_attestation",
		});

		const forwarded = forwardedCreateOptions[0];
		expect(forwarded?.model?.id).toBe("strict-primary");
		expect(forwarded?.prewalk).toBeUndefined();
		expect(forwarded?.disableModelFallback).toBe(true);
		expect(forwarded?.disableServerSideFallback).toBe(true);
		const forwardedSettings = forwarded?.settings;
		expect(forwardedSettings).toBeDefined();
		if (forwardedSettings) {
			expect(cfgAdvisorEnabled.get(forwardedSettings)).toBe(false);
			expect(cfgRetryModelFallback.get(forwardedSettings)).toBe(false);
		}
		expect(() => forwarded?.assertDispatchModel?.(primary)).not.toThrow();
		expect(() => forwarded?.assertDispatchModel?.(fallback)).toThrow(/Strict model identity refused dispatch model/);
	});

	it("fails closed under strictModelIdentity when requested model lacks credentials or is missing", async () => {
		const unauth = createMockModel({
			provider: "mock-unauth",
			id: "strict-unauth",
			handler: () => ({ content: ["should not run"] }),
		});
		const parentFallback = createMockModel({
			provider: "mock",
			id: "parent-fallback",
			handler: () => ({ content: ["fallback ran"] }),
		});

		const unauthHarness = await createHarness({
			models: [unauth, parentFallback],
			authenticatedProviders: ["mock"],
			parentActiveModel: "mock/parent-fallback",
		});
		const unauthResult = await runStructuredSubagent({
			session: unauthHarness.session,
			invocationKind: "task",
			assignment: "Must fail without credentials.",
			agent: "worker",
			model: "mock-unauth/strict-unauth",
			structured: false,
			strictModelIdentity: true,
			identity: { id: unauthHarness.agentId },
			keepAlive: false,
		});
		expect(unauthResult.result.exitCode).not.toBe(0);
		expect(unauthResult.result.error).toMatch(/Strict model identity has no working credentials/);
		expect(parentFallback.calls).toHaveLength(0);

		const missingHarness = await createHarness({
			models: [parentFallback],
			authenticatedProviders: ["mock"],
			parentActiveModel: "mock/parent-fallback",
		});
		const missingResult = await runStructuredSubagent({
			session: missingHarness.session,
			invocationKind: "task",
			assignment: "Must fail when unresolved.",
			agent: "worker",
			model: "mock/does-not-exist",
			structured: false,
			strictModelIdentity: true,
			identity: { id: missingHarness.agentId },
			keepAlive: false,
		});
		expect(missingResult.result.exitCode).not.toBe(0);
		expect(missingResult.result.error).toMatch(/Strict model identity could not resolve requested model/);
		expect(parentFallback.calls).toHaveLength(0);
	});

	it("stops follow-up yield reminders when shared budgetGuard exhausts and propagates onPayload throws", async () => {
		const primary = createMockModel({
			id: "strict-budget",
			handler: async (context, options) => {
				await options?.onPayload?.({ messages: context.messages }, primary, options.signal);
				return {
					content: ["Prose without calling yield."],
					usage: { input: 200, output: 100, cost: { input: 0.2, output: 0.3, total: 0.5 } },
				};
			},
		});
		const { agentId, session } = await createHarness({ models: [primary] });

		const ledger = new BudgetLedger({ limitUsd: 0.25, maxRequests: 5 });
		const budgetGuard = createWorkflowBudgetPort(ledger).bind({
			workflowId: "wf-budget",
			attemptId: "att-1",
			invocationId: "inv-1",
			profileId: "strict-profile",
			maxRequests: 5,
			maxCostUsd: 0.25,
		});
		const providerChargeKeys: string[] = [];
		let ordinal = 0;
		const execution = await runStructuredSubagent({
			session,
			invocationKind: "task",
			assignment: "Yield structured result.",
			agent: "worker",
			model: "mock/strict-budget",
			structured: true,
			strictModelIdentity: true,
			budgetGuard,
			providerChargeKeys,
			onPayload: () => {
				ordinal += 1;
				const key = budgetGuard.beforeProviderRequest({ ordinal });
				if (key) providerChargeKeys.push(key);
				return undefined;
			},
			identity: { id: agentId },
			keepAlive: false,
		});

		// Turn 1 settles $0.50 > $0.25 limit, so allowsModelCall() turns false and suppresses yield reminder turns.
		expect(primary.calls).toHaveLength(1);
		expect(budgetGuard.allowsModelCall()).toBe(false);
		expect(execution.result.aborted).toBe(true);
		expect(execution.result.exitCode).toBe(1);
		expect(execution.result.abortReason).toMatch(/Soft request budget exceeded/i);

		// A pre-send throw from onPayload must propagate out of createAgentSession instead of being swallowed.
		const blockedModel = createMockModel({
			id: "strict-blocked",
			handler: async (context, options) => {
				await options?.onPayload?.({ messages: context.messages }, blockedModel, options.signal);
				return { content: ["Should never return"] };
			},
		});
		const blockedHarness = await createHarness({ models: [blockedModel] });
		const zeroBudget = createWorkflowBudgetPort(new BudgetLedger({ limitUsd: 1, maxRequests: 0 })).bind({
			workflowId: "wf-blocked",
			attemptId: "att-1",
			invocationId: "inv-1",
			profileId: "strict-profile",
			maxRequests: 0,
			maxCostUsd: 1,
		});
		const blockedExecution = await runStructuredSubagent({
			session: blockedHarness.session,
			invocationKind: "task",
			assignment: "Blocked before send.",
			agent: "worker",
			model: "mock/strict-blocked",
			structured: false,
			strictModelIdentity: true,
			budgetGuard: zeroBudget,
			onPayload: () => {
				zeroBudget.beforeProviderRequest({ ordinal: 1 });
				return undefined;
			},
			identity: { id: blockedHarness.agentId },
			keepAlive: false,
		});
		expect(blockedExecution.result.exitCode).not.toBe(0);
		expect(blockedExecution.result.error).toMatch(/budget/i);
	});

	it("keeps onResponse and onPayload launch-only and omits them on warm revive", async () => {
		const primary = createMockModel({
			id: "strict-revive",
			handler: () => ({
				content: ["Launch answer."],
				responseHeaders: { "x-omp-resolved-model": "mock/strict-revive" },
			}),
		});
		const { agentId, session, forwardedCreateOptions } = await createHarness({
			models: [primary],
			sessionFile: true,
		});

		const onResponse: NonNullable<StructuredSubagentRequest["onResponse"]> = () => {};
		const onPayload: NonNullable<StructuredSubagentRequest["onPayload"]> = () => undefined;

		const execution = await runStructuredSubagent({
			session,
			invocationKind: "task",
			assignment: "Keep alive for warm revive check.",
			agent: "worker",
			model: "mock/strict-revive",
			structured: false,
			strictModelIdentity: true,
			onResponse,
			onPayload,
			identity: { id: agentId },
			keepAlive: true,
		});
		expect(execution.result.exitCode).toBe(0);
		expect(forwardedCreateOptions).toHaveLength(1);
		expect(forwardedCreateOptions[0]?.onResponse).toBe(onResponse);
		expect(forwardedCreateOptions[0]?.onPayload).toBe(onPayload);

		await AgentLifecycleManager.global().park(agentId);
		await AgentLifecycleManager.global().ensureLive(agentId);

		expect(forwardedCreateOptions).toHaveLength(2);
		expect(forwardedCreateOptions[1]?.onResponse).toBeUndefined();
		expect(forwardedCreateOptions[1]?.onPayload).toBeUndefined();
		expect(forwardedCreateOptions[1]?.disableModelFallback).toBe(true);
		expect(forwardedCreateOptions[1]?.disableServerSideFallback).toBe(true);
	}, 30_000);

	it("settles the latest charge key without drifting subsequent turns after transport retries", async () => {
		const notePath = path.join(tempRoot, "retry-note.txt");
		await fs.writeFile(notePath, "retry-content", "utf8");

		let turn = 0;
		const retryModel = createMockModel({
			id: "strict-retry",
			handler: async (context, options) => {
				turn += 1;
				if (turn === 1) {
					await options?.onPayload?.({ messages: context.messages, attempt: 1 }, retryModel, options.signal);
					await options?.onPayload?.({ messages: context.messages, attempt: 2 }, retryModel, options.signal);
					return {
						toolCalls: [{ id: "read-1", name: "read", arguments: { path: notePath } }],
						usage: { input: 100, output: 20, cost: { input: 0.01, output: 0.02, total: 0.03 } },
					};
				}
				await options?.onPayload?.({ messages: context.messages, attempt: 1 }, retryModel, options.signal);
				return {
					content: ["Recovered after retry."],
					usage: { input: 120, output: 30, cost: { input: 0.02, output: 0.02, total: 0.04 } },
				};
			},
		});
		const { agentId, session } = await createHarness({ models: [retryModel] });

		const ledger = new BudgetLedger({ limitUsd: 1, maxRequests: 10 });
		const budgetGuard = createWorkflowBudgetPort(ledger).bind({
			workflowId: "wf-retry-charge",
			attemptId: "att-1",
			invocationId: "inv-1",
			profileId: "strict-profile",
			maxRequests: 10,
			maxCostUsd: 1,
		});
		const providerChargeKeys: string[] = [];
		let ordinal = 0;

		const execution = await runStructuredSubagent({
			session,
			invocationKind: "task",
			assignment: `Read ${notePath} and finish.`,
			agent: "worker",
			model: "mock/strict-retry",
			structured: false,
			strictModelIdentity: true,
			budgetGuard,
			providerChargeKeys,
			onPayload: () => {
				ordinal += 1;
				const key = budgetGuard.beforeProviderRequest({ ordinal });
				if (key) providerChargeKeys.push(key);
				return undefined;
			},
			identity: { id: agentId },
			keepAlive: false,
		});

		expect(execution.result.exitCode).toBe(0);
		expect(execution.result.output).toBe("Recovered after retry.");
		expect(ordinal).toBe(3);
		expect(providerChargeKeys).toEqual([]);
		const snap = ledger.snapshot();
		expect(snap.providerRequests).toBe(3);
		expect(snap.knownCostLowerBoundUsd).toBeCloseTo(0.07, 6);
		const providerCharges = (snap.charges ?? []).filter(c => c.unit === "provider");
		expect(providerCharges[0]?.unknown).toBe(true);
		expect(providerCharges[1]?.costUsd).toBeCloseTo(0.03, 6);
		expect(providerCharges[2]?.costUsd).toBeCloseTo(0.04, 6);
	});

	it("fires host onPayload and onResponse only for primary agent turns, not side-channel calls", async () => {
		const primary = createMockModel({
			id: "strict-isolation",
			handler: async (context, options) => {
				await options?.onPayload?.({ messages: context.messages }, primary, options.signal);
				return {
					content: ["Ok."],
					responseHeaders: { "x-omp-resolved-model": "mock/strict-isolation" },
				};
			},
		});
		const cwd = path.join(tempRoot, "side-channel-work");
		await fs.mkdir(cwd, { recursive: true });
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("mock", "test-key");
		const sourceId = `side-channel-isolation-${++runCounter}`;
		registerMockApi(sourceId);
		const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
		vi.spyOn(modelRegistry, "find").mockImplementation((provider, id) =>
			provider === primary.provider && id === primary.id ? primary : undefined,
		);
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([primary]);
		vi.spyOn(modelRegistry, "getAll").mockReturnValue([primary]);
		vi.spyOn(modelRegistry, "awaitBackgroundRefresh").mockResolvedValue(undefined);

		let hostPayloadCalls = 0;
		let hostResponseCalls = 0;
		const { session } = await realCreateAgentSession({
			cwd,
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false, "todo.reminders": false }),
			model: primary,
			sessionManager: SessionManager.inMemory(cwd),
			enableMCP: false,
			enableLsp: false,
			hasUI: false,
			onPayload: () => {
				hostPayloadCalls += 1;
				return undefined;
			},
			onResponse: () => {
				hostResponseCalls += 1;
			},
		});
		try {
			await session.runEphemeralTurn({ promptText: "Side question." });
			expect(hostPayloadCalls).toBe(0);
			expect(hostResponseCalls).toBe(0);

			await session.prompt("Primary prompt.");
			expect(hostPayloadCalls).toBe(1);
			expect(hostResponseCalls).toBe(1);
		} finally {
			await session.dispose();
			unregisterCustomApis(sourceId);
			authStorage.close();
		}
	});

	it("rejects @upstream routing mismatch and enforces exactOnly without perCallModelGrants under strictModelIdentity", async () => {
		const bundled = getBundledModel("openrouter", "z-ai/glm-4.7");
		if (!bundled) throw new Error("Expected bundled openrouter/z-ai/glm-4.7");
		const capturedRequests: Array<Record<string, unknown>> = [];
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(req) {
				const body = (await req.json()) as Record<string, unknown>;
				capturedRequests.push(body);
				const sse = [
					'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_route_1","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Routed."}]}}',
					'data: {"type":"response.completed","response":{"id":"resp_route_1","status":"completed","model":"z-ai/glm-4.7","usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4,"input_tokens_details":{"cached_tokens":0}}}}',
					"",
				].join("\n\n");
				return new Response(sse, {
					status: 200,
					headers: {
						"content-type": "text/event-stream",
						"x-omp-resolved-model": "openrouter/z-ai/glm-4.7",
					},
				});
			},
		});
		cleanups.push(async () => {
			await server.stop(true);
		});
		const baseOpenRouter: Model = {
			...bundled,
			baseUrl: server.url.toString().replace(/\/$/, ""),
		};
		const cerebras = parseModelPattern("openrouter/z-ai/glm-4.7@cerebras", [baseOpenRouter]).model;
		const together = parseModelPattern("openrouter/z-ai/glm-4.7@together", [baseOpenRouter]).model;
		if (!cerebras || !together) throw new Error("Expected routed models");

		const routingHarness = await createHarness({
			models: [baseOpenRouter],
			authenticatedProviders: ["openrouter"],
		});
		const routedExec = await runStructuredSubagent({
			session: routingHarness.session,
			invocationKind: "task",
			assignment: "Check @upstream validation.",
			agent: "worker",
			model: "openrouter/z-ai/glm-4.7@cerebras",
			structured: false,
			strictModelIdentity: true,
			identity: { id: routingHarness.agentId },
			keepAlive: false,
		});
		expect(routedExec.result.error).toBeUndefined();
		expect(routedExec.result.exitCode).toBe(0);
		const assertDispatchModel = routingHarness.forwardedCreateOptions[0]?.assertDispatchModel;
		expect(() => assertDispatchModel?.(cerebras)).not.toThrow();
		expect(() => assertDispatchModel?.(together)).toThrow(/Strict model identity refused dispatch model/);
		expect(() => assertDispatchModel?.(baseOpenRouter)).toThrow(/Strict model identity refused dispatch model/);

		// Without perCallModelGrants, bare/fuzzy model selectors must still fail closed under exactOnly.
		const bareIdTarget = createMockModel({
			id: "strict-role-target",
			handler: () => ({ content: ["Should not run"] }),
		});
		const bareHarness = await createHarness({
			models: [bareIdTarget],
		});
		const bareExec = await runStructuredSubagent({
			session: bareHarness.session,
			invocationKind: "task",
			assignment: "Must reject bare id without exactOnly escape.",
			agent: "worker",
			model: "strict-role-target",
			structured: false,
			strictModelIdentity: true,
			identity: { id: bareHarness.agentId },
			keepAlive: false,
		});
		expect(bareExec.result.exitCode).not.toBe(0);
		expect(bareExec.result.error).toMatch(
			/Strict model identity could not resolve requested model: strict-role-target/,
		);
		expect(bareIdTarget.calls).toHaveLength(0);
	});

	it("preserves frozen errors thrown out of runSubagent instead of masking with TypeError", async () => {
		const primary = createMockModel({
			id: "strict-frozen",
			handler: () => ({ content: ["unused"] }),
		});
		const { agentId, session } = await createHarness({ models: [primary] });
		(session as { asyncJobManager?: unknown }).asyncJobManager = {
			cancelAndReapOwnerJobs: async () => {
				throw Object.freeze(new Error("frozen failure sentinel"));
			},
		};

		await expect(
			runStructuredSubagent({
				session,
				invocationKind: "task",
				assignment: "Trigger frozen failure.",
				agent: "worker",
				model: "mock/strict-frozen",
				structured: false,
				strictModelIdentity: true,
				identity: { id: agentId },
				keepAlive: false,
			}),
		).rejects.toThrow(/frozen failure sentinel/);
	});
});
