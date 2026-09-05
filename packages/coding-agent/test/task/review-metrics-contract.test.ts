import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AssistantMessageEvent, Context, Model, SimpleStreamOptions, Usage } from "@oh-my-pi/pi-ai";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { type ExecutorOptions, runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type {
	AgentDefinition,
	SingleResult,
	SubagentRequestPhase,
	SubagentToolPhase,
} from "@oh-my-pi/pi-coding-agent/task/types";
import { TempDir } from "@oh-my-pi/pi-utils";

const TEST_USAGE: Usage = {
	input: 10,
	output: 20,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 30,
	reasoningTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const baseAgent: AgentDefinition = {
	name: "MetricsVerifier",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
	tools: ["bash", "yield"],
};

const PROVIDER = "benchmock";
const MODEL_PATTERN = "benchmock/worker";
const API = "bench-mock-stream";
const SOURCE = "pi-metrics-contract";

interface ProviderTiming {
	duration?: number;
	ttft?: number;
}

function yieldResponse(): MockResponse {
	return {
		content: [
			{
				type: "toolCall",
				id: "call_yield_terminal",
				name: "yield",
				arguments: { result: { data: { report: "done" } } },
			},
		],
	};
}

function applyTiming(event: AssistantMessageEvent, timing: ProviderTiming | undefined): AssistantMessageEvent {
	if (!timing) return event;
	if (event.type === "done") {
		const message = { ...event.message };
		if (timing.duration !== undefined) message.duration = timing.duration;
		if (timing.ttft !== undefined) message.ttft = timing.ttft;
		else delete message.ttft;
		return { ...event, message };
	}
	if (event.type === "error") {
		const error = { ...event.error };
		if (timing.duration !== undefined) error.duration = timing.duration;
		if (timing.ttft !== undefined) error.ttft = timing.ttft;
		else delete error.ttft;
		return { ...event, error };
	}
	return event;
}

function timedStream(mock: MockModel, timings: ProviderTiming[]) {
	return (_model: Model, context: Context, options?: SimpleStreamOptions) => {
		const inner = mock.stream(_model, context, options);
		const outer = new AssistantMessageEventStream();
		const timing = timings[Math.min(Math.max(mock.calls.length - 1, 0), Math.max(timings.length - 1, 0))];
		void (async () => {
			try {
				for await (const event of inner) {
					outer.push(applyTiming(event, timing));
					if (outer.done) return;
				}
				if (!outer.done) {
					try {
						outer.end(await inner.result());
					} catch (err) {
						outer.fail(err);
					}
				}
			} catch (err) {
				if (!outer.done) outer.fail(err);
			}
		})();
		return outer;
	};
}

function createSettings(): Settings {
	return Settings.isolated({
		"task.maxConcurrency": 4,
		"task.maxRuntimeMs": 0,
		"task.agentIdleTtlMs": 0,
		"task.enableLsp": false,
		"compaction.enabled": false,
		"modelOptimization.enabled": false,
		"retry.enabled": false,
		"async.enabled": false,
		"tools.approvalMode": "yolo" as const,
	});
}

interface RunOutcome {
	result: SingleResult;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
}

function baseOptions(id: string, overrides: Partial<ExecutorOptions> = {}): ExecutorOptions {
	return {
		cwd: "/tmp",
		agent: baseAgent,
		task: "verify the metrics producer contract",
		index: 0,
		id,
		description: "verify the metrics producer contract",
		modelOverride: [MODEL_PATTERN],
		enableLsp: false,
		enableIrc: false,
		enableMCP: false,
		restrictToolNames: true,
		...overrides,
	};
}

function toolPhasesOf(result: { reviewMetrics?: { toolPhases: SubagentToolPhase[] } }): SubagentToolPhase[] {
	return result.reviewMetrics?.toolPhases ?? [];
}

function requestPhasesOf(result: {
	reviewMetrics?: { requestPhases: SubagentRequestPhase[] };
}): SubagentRequestPhase[] {
	return result.reviewMetrics?.requestPhases ?? [];
}

describe("runSubprocess reviewMetrics contract (real SDK session path)", () => {
	let tempDir: TempDir;
	let lastAuthStorage: AuthStorage | undefined;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		AsyncJobManager.resetForTests();
		tempDir = TempDir.createSync("@pi-metrics-contract-");
	});

	afterEach(async () => {
		unregisterCustomApis(SOURCE);
		await lastAuthStorage?.close();
		lastAuthStorage = undefined;
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		AsyncJobManager.resetForTests();
		await tempDir[Symbol.dispose]();
	});

	async function runContract(
		id: string,
		responses: MockResponse[],
		extra: Partial<ExecutorOptions> = {},
		timings: ProviderTiming[] = [],
	): Promise<RunOutcome> {
		const authStorage = await AuthStorage.create(":memory:");
		lastAuthStorage = authStorage;
		authStorage.setRuntimeApiKey(PROVIDER, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"), {
			fetch: () => Promise.reject(new Error("network disabled in metrics contract test")),
		});
		const mock = createMockModel({ responses });
		modelRegistry.registerProvider(
			PROVIDER,
			{
				api: API,
				streamSimple: timings.length > 0 ? timedStream(mock, timings) : mock.stream,
				apiKey: "test-key",
				baseUrl: "mock://",
				models: [
					{
						id: "worker",
						name: "Bench Worker",
						api: API,
						reasoning: false,
						input: ["text"],
						supportsTools: true,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 200_000,
						maxTokens: 8_192,
					},
				],
			},
			SOURCE,
		);
		const resolved = modelRegistry.find(PROVIDER, "worker");
		if (!resolved) throw new Error("Expected benchmock/worker to resolve after registerProvider");
		const result = await runSubprocess(
			baseOptions(id, {
				settings: createSettings(),
				modelRegistry,
				cwd: tempDir.path(),
				...extra,
			}),
		);
		return { result, authStorage, modelRegistry };
	}

	it("concurrent same-name tools pair by real toolCallId with provider timing on the turn", async () => {
		const { result } = await runContract(
			"MetricsOverlap",
			[
				{
					content: [
						{ type: "toolCall", id: "bash-slow", name: "bash", arguments: { command: "sleep 0.35" } },
						{ type: "toolCall", id: "bash-fast", name: "bash", arguments: { command: "true" } },
					],
					usage: TEST_USAGE,
				},
				yieldResponse(),
			],
			{},
			[{ duration: 1500, ttft: 300 }, {}],
		);

		expect(result.exitCode).toBe(0);
		expect(result.error).toBeUndefined();
		const phases = toolPhasesOf(result);
		const slow = phases.find(phase => phase.toolCallId === "bash-slow");
		const fast = phases.find(phase => phase.toolCallId === "bash-fast");
		expect(slow).toBeDefined();
		expect(fast).toBeDefined();
		expect(slow?.unmatched).toBeUndefined();
		expect(fast?.unmatched).toBeUndefined();
		expect(slow?.durationMs).toBeTypeOf("number");
		expect(fast?.durationMs).toBeTypeOf("number");
		expect((slow?.durationMs ?? 0) > (fast?.durationMs ?? 0)).toBe(true);

		const phasesByRequest = requestPhasesOf(result);
		const timed = phasesByRequest.find(phase => phase.ttftMs === 300);
		expect(timed).toBeDefined();
		expect(timed?.generationMs).toBe(1200);
		expect(timed?.durationMs).toBeTypeOf("number");
		expect(timed?.generationMs).not.toBe(timed?.durationMs);
		expect(timed?.contextTokens).toBe(TEST_USAGE.totalTokens);
		expect(timed?.contextBytes).toBeUndefined();
		expect(timed?.queueMs).toBeUndefined();
		const yieldTurn = phasesByRequest.find(phase => phase.ttftMs === undefined && phase.durationMs !== undefined);
		expect(yieldTurn?.generationMs).toBeUndefined();
	});

	it("provider timing derivation and omission matrix on real messages", async () => {
		const cases: Array<{ duration?: number; ttft?: number; expectTtft?: number; expectGeneration?: number }> = [
			{ duration: 1500, ttft: 300, expectTtft: 300, expectGeneration: 1200 },
			{ duration: 500, ttft: 900, expectTtft: 900, expectGeneration: undefined },
			{ duration: 800, ttft: -5, expectTtft: undefined, expectGeneration: undefined },
			{ duration: 800, ttft: Number.NaN, expectTtft: undefined, expectGeneration: undefined },
			{ duration: 900, ttft: undefined, expectTtft: undefined, expectGeneration: undefined },
		];
		for (const [index, item] of cases.entries()) {
			const { result } = await runContract(
				`MetricsTiming${index}`,
				[{ content: ["ok"], usage: TEST_USAGE }, yieldResponse()],
				{},
				[{ duration: item.duration, ttft: item.ttft }, {}],
			);
			const timed = requestPhasesOf(result).find(phase => phase.contextTokens === TEST_USAGE.totalTokens);
			expect(timed).toBeDefined();
			expect(timed?.ttftMs).toBe(item.expectTtft);
			expect(timed?.generationMs).toBe(item.expectGeneration);
			expect(timed?.contextTokens).toBe(TEST_USAGE.totalTokens);
			expect(timed?.contextBytes).toBeUndefined();
			expect(JSON.stringify(timed)).not.toContain("contextBytes");
		}
	});

	it("real cancellation: aborts the run and records the interrupted tool without a fake duration", async () => {
		const controller = new AbortController();
		let cancelled = false;
		const { result } = await runContract(
			"MetricsCancel",
			[
				{ content: [{ type: "toolCall", id: "cancel-slow", name: "bash", arguments: { command: "sleep 60" } }] },
				yieldResponse(),
			],
			{
				signal: controller.signal,
				onProgress: progress => {
					if (!cancelled && progress.currentTool === "bash") {
						cancelled = true;
						queueMicrotask(() => controller.abort());
					}
				},
			},
		);

		expect(result.aborted).toBe(true);
		expect(result.abortReason).toBeTruthy();
		const phases = toolPhasesOf(result);
		const cancelledTool =
			phases.find(phase => phase.toolCallId === "cancel-slow") ?? phases.find(phase => phase.name === "bash");
		expect(cancelledTool).toBeDefined();
		const serialized = JSON.parse(JSON.stringify(cancelledTool)) as Record<string, unknown>;
		if (cancelledTool?.unmatched === true) {
			expect(cancelledTool.durationMs).toBeUndefined();
			expect(serialized).not.toHaveProperty("durationMs");
		} else {
			expect(cancelledTool?.unmatched).toBeUndefined();
			expect(cancelledTool?.durationMs).toBeTypeOf("number");
			expect(Number.isFinite(cancelledTool?.durationMs)).toBe(true);
			expect(serialized).toHaveProperty("durationMs");
		}
	});

	it("abnormal empty toolCallId from the real dispatcher is unmatched without durationMs", async () => {
		const { result } = await runContract("MetricsEmptyId", [
			{ content: [{ type: "toolCall", id: "", name: "bash", arguments: { command: "true" } }] },
			yieldResponse(),
		]);
		const reads = toolPhasesOf(result).filter(phase => phase.name === "bash" && phase.unmatched === true);
		expect(reads.length).toBeGreaterThan(0);
		for (const phase of reads) {
			expect(phase.toolCallId).toBeUndefined();
			expect(phase.durationMs).toBeUndefined();
			expect(JSON.stringify(phase)).not.toContain("durationMs");
		}
	});

	it("spawnQueueMs writes the semaphore epochs on the top level only, never per request phase", async () => {
		const queued = await runContract("MetricsSpawnQueued", [yieldResponse()], {
			invokedAt: 1_000,
			acquiredAt: 1_750,
		});
		expect(queued.result.reviewMetrics?.spawnQueueMs).toBe(750);
		for (const phase of requestPhasesOf(queued.result)) {
			expect(phase.queueMs).toBeUndefined();
		}

		const plain = await runContract("MetricsSpawnNotQueued", [yieldResponse()]);
		expect(plain.result.reviewMetrics?.spawnQueueMs).toBeUndefined();
	});
});
