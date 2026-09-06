/**
 * Parallel subagent spawn: local benchmark + deterministic contract tests.
 *
 * Design: docs/superpowers/specs/2026-09-06-parallel-subagent-performance-design.md §6
 * (本地并发). Everything here runs the REAL path — TaskTool.execute →
 * runStructuredSubagent → runSubprocess → createAgentSession → AgentSession
 * agent loop — with mock provider work at the provider boundary ONLY. The
 * scheduler, executor, session, and agent loop are not mocked and no source
 * function is modified to make tests pass.
 *
 * Two modes, cleanly separated by the PARALLEL_SPAWN_BENCH env flag:
 *
 *   1. `bun test packages/coding-agent/test/task/parallel-spawn-local-bench.test.ts`
 *      Deterministic contract tests only (no repeated benchmarking): real
 *      semaphore saturation via a controllable provider-entry gate, real cap
 *      enforcement, real provider-routed delivery. Fast, full-suite-safe.
 *
 *   2. `PARALLEL_SPAWN_BENCH=1 bun run packages/coding-agent/test/task/parallel-spawn-local-bench.test.ts`
 *      The actual local benchmark: the same N identical mock tasks at caps
 *      1/2/4/7, repeated 3× per cap, emitting one JSON document with measured
 *      wall clocks, per-job spawnQueueMs (when the producer writes it),
 *      provider-entry concurrency peaks, and completion success. Env
 *      overrides: PARALLEL_SPAWN_BENCH (must be "1"), BENCH_CAPS, BENCH_TASKS,
 *      BENCH_REPEATS, BENCH_LOAD_MS.
 *
 * Scope labels: local + mock only; this never promises remote speedups.
 *
 * Timer note (deliberate real-time delay): the mock's `delayMs` IS the
 * controllable async provider workload under measurement — the bench exists
 * to observe real scheduling under real async work, so fake timers would
 * defeat the measurement. Deterministic scheduling assertions use promise
 * gates (entry/release), never sleeps.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import type { SingleResult, TaskParams } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

/** Bench mode is opt-in via env so `bun test` never runs the repeated benchmark. */
const BENCH_MODE = process.env.PARALLEL_SPAWN_BENCH === "1";

/** Mock provider identity registered per harness (isolated per batch). */
const MOCK_PROVIDER = "benchmock";
const MOCK_MODEL_ID = "worker";
/** Custom API name; stream dispatch routes here via the global api registry. */
const MOCK_API = "bench-mock-stream";
/** Source id for `unregisterCustomApis` — only entries with this source are removed. */
const BENCH_API_SOURCE = "parallel-spawn-local-bench";

/** Never touch the network: discovery/refresh fallbacks reject instantly. */
const OFFLINE_FETCH: FetchImpl = () =>
	Promise.reject(new Error("network disabled in parallel-spawn-local-bench (offline mock runs only)"));

/** Workload: every provider call waits this long before emitting its response. */
const DEFAULT_LOAD_MS = 120;
/**
 * Provider calls per child run: 1 initial + up to MAX_YIELD_RETRIES(3)
 * yield-reminder turns. The subagent loop sends exactly these turns for a
 * plain-text mock answer (no async work, no yield tool call), so the total is
 * deterministic: `tasks * CALLS_PER_WORKER` provider entries per batch.
 */
const CALLS_PER_WORKER = 4;

/**
 * Provider-boundary concurrency observer. Counts in-flight mock streams
 * (entry → stream settled), so `peak` is the real concurrent provider
 * utilization the agent loops produced — observed from the outside, not a
 * copy of any scheduler state.
 */
class ProviderConcurrencyWatch {
	#inFlight = 0;
	#peak = 0;
	#entries = 0;

	get peak(): number {
		return this.#peak;
	}

	get entries(): number {
		return this.#entries;
	}

	/** Wrap one stream invocation; decrements when the stream settles. */
	wrap<T extends { result(): Promise<unknown> }>(make: () => T): T {
		this.#entries++;
		this.#inFlight++;
		if (this.#inFlight > this.#peak) this.#peak = this.#inFlight;
		const stream = make();
		void stream
			.result()
			.catch(() => {})
			.finally(() => {
				this.#inFlight--;
			});
		return stream;
	}
}

/** One spawned task's outcome as observed through the public TaskTool result. */
interface JobOutcome {
	/** TaskTool public result id. */
	id: string;
	/** result.durationMs — monitor wall clock for the whole child run. */
	durationMs: number;
	/** Provider requests attributed to this child (≥1 proves a real loop). */
	requests: number;
	/** result.exitCode === 0 && !result.aborted && !result.error. */
	ok: boolean;
	exitCode: number;
	aborted: boolean;
	error?: string;
	completionKind?: SingleResult["completionKind"];
	/**
	 * reviewMetrics.spawnQueueMs — the real task-semaphore queue wait
	 * (`invokedAt` → `acquiredAt`). Never synthesized in this file.
	 */
	spawnQueueMs?: number;
}

/** One whole batch of concurrent task calls. */
interface BatchResult {
	cap: number;
	tasks: number;
	loadMs: number;
	/** wall clock of Promise.all over the task calls. */
	elapsedMs: number;
	/** observed concurrent provider streams (peak). */
	providerPeak: number;
	/** total provider entries observed in the batch. */
	providerEntries: number;
	jobs: JobOutcome[];
	/** every job produced a SingleResult. */
	allDelivered: boolean;
	/** every job completed ok (exitCode 0 / not aborted / no error). */
	allOk: boolean;
	spawnQueueMsPresent: boolean;
	spawnQueueMsSamples: number[];
}

/**
 * Controllable provider-entry gate for the deterministic tests. `onEntry`
 * runs before each provider response; awaiting inside it holds that entry in
 * flight across the real async path. The live watch is handed in so tests can
 * assert provider-entry counts while the gate is held.
 */
interface EntryGate {
	onEntry(watch: ProviderConcurrencyWatch): Promise<void> | void;
}

interface BatchOptions {
	cap: number;
	tasks: number;
	loadMs?: number;
	/** Prefix for spawn names so repeated batches allocate non-colliding agent ids. */
	namePrefix?: string;
	/** Optional provider-entry gate injected into the mock handler. */
	gate?: EntryGate;
}

/** Build the parent ToolSession the real TaskTool executes against. */
function createParentToolSession(options: {
	cwd: string;
	settings: Settings;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
}): ToolSession {
	return {
		cwd: options.cwd,
		hasUI: false,
		settings: options.settings,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getAgentId: () => "Main",
		// Restricted child: exactly the yield tool, no MCP/IRC/LSP auto-wiring.
		restrictToolNames: true,
		enableLsp: false,
		enableIrc: false,
		authStorage: options.authStorage,
		modelRegistry: options.modelRegistry,
		skills: [],
		rules: [],
		contextFiles: [],
	} as unknown as ToolSession;
}

function createSettings(cap: number): Settings {
	return Settings.isolated({
		"task.maxConcurrency": cap,
		// Deterministic runs: no wall-clock kill, no park timers, no auto-retry,
		// no compaction/model-optimization churn, sync (non-async) fan-out.
		"task.maxRuntimeMs": 0,
		"task.agentIdleTtlMs": 0,
		"task.enableLsp": false,
		"task.queuedStartupTimeoutMs": 60_000,
		"compaction.enabled": false,
		"modelOptimization.enabled": false,
		"retry.enabled": false,
		"async.enabled": false,
		"tools.approvalMode": "yolo" as const,
	});
}

/** One repeatable batch: fresh settings/registry/mock, N concurrent task calls. */
async function runBatch(options: BatchOptions): Promise<BatchResult> {
	const { cap, tasks } = options;
	const loadMs = options.loadMs ?? DEFAULT_LOAD_MS;
	const namePrefix = options.namePrefix ?? "0";
	const dir = TempDir.createSync("@parallel-spawn-local-bench-");
	const settings = createSettings(cap);
	const authStorage = await AuthStorage.create(":memory:");
	const modelRegistry = new ModelRegistry(authStorage, dir.join("models.yml"), { fetch: OFFLINE_FETCH });
	authStorage.setRuntimeApiKey(MOCK_PROVIDER, "test-key");

	const watch = new ProviderConcurrencyWatch();
	// The custom API streams through this mock; the gate controls the first
	// provider entries so tests can prove real semaphore saturation.
	const mock = createMockModel({
		handler: async () => {
			await options.gate?.onEntry(watch);
			// `delayMs` is the measured async provider workload (see header note).
			return { content: ["done"], stopReason: "stop" as const, delayMs: loadMs, usage: { totalTokens: 64 } };
		},
	});
	// `streamSimple` makes registerProvider register the custom API in the
	// global api registry; the child's `stream()` dispatch then reaches the
	// mock through the watch (provider-boundary concurrency observation).
	modelRegistry.registerProvider(
		MOCK_PROVIDER,
		{
			api: MOCK_API,
			streamSimple: (model, context, options_) => watch.wrap(() => mock.stream(model, context, options_)),
			apiKey: "test-key",
			baseUrl: "mock://",
			models: [
				{
					id: MOCK_MODEL_ID,
					name: "Bench Worker",
					api: MOCK_API,
					reasoning: false,
					input: ["text"],
					supportsTools: true,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 200_000,
					maxTokens: 8_192,
				},
			],
		},
		BENCH_API_SOURCE,
	);
	const resolved = modelRegistry.find(MOCK_PROVIDER, MOCK_MODEL_ID);
	if (!resolved) throw new Error("Expected benchmock/worker to resolve after registerProvider");
	const toolSession = createParentToolSession({ cwd: dir.path(), settings, authStorage, modelRegistry });
	const tool = await TaskTool.create(toolSession);

	const startedAt = Date.now();
	try {
		const results = await Promise.all(
			Array.from({ length: tasks }, async (_, index) => {
				const result = await tool.execute(`bench-call-${namePrefix}-${index}`, {
					agent: "task",
					name: `bench-${namePrefix}-${index}`,
					// Explicit model pattern: resolution hits the benchmock provider in
					// the registry, so child sessions stream through the mock API.
					model: `${MOCK_PROVIDER}/${MOCK_MODEL_ID}`,
					task: "Return the string bench-ok.",
				} as TaskParams);
				const details = result.details as { results?: SingleResult[] } | undefined;
				const single = details?.results?.[0];
				if (!single) {
					throw new Error(`task call ${index} produced no SingleResult`);
				}
				return single;
			}),
		);
		const jobs: JobOutcome[] = results.map(result => {
			const reviewMetrics = (result.reviewMetrics ?? undefined) as { spawnQueueMs?: number } | undefined;
			const spawnQueueMs = reviewMetrics?.spawnQueueMs;
			return {
				id: result.id,
				durationMs: result.durationMs,
				requests: result.requests,
				ok: result.exitCode === 0 && !result.aborted && !result.error,
				exitCode: result.exitCode,
				aborted: result.aborted ?? false,
				error: result.error,
				completionKind: result.completionKind,
				...(typeof spawnQueueMs === "number" ? { spawnQueueMs } : {}),
			};
		});
		const spawnQueueMsSamples = jobs
			.map(job => job.spawnQueueMs)
			.filter((value): value is number => typeof value === "number");
		return {
			cap,
			tasks,
			loadMs,
			elapsedMs: Date.now() - startedAt,
			providerPeak: watch.peak,
			providerEntries: watch.entries,
			jobs,
			allDelivered: jobs.length === tasks,
			allOk: jobs.every(job => job.ok),
			spawnQueueMsPresent: spawnQueueMsSamples.length > 0,
			spawnQueueMsSamples,
		};
	} finally {
		await authStorage.close();
		await dir.remove();
	}
}

// ---------------------------------------------------------------------------
// Deterministic contract tests (the normal `bun test` suite path).
// ---------------------------------------------------------------------------
if (!BENCH_MODE) {
	describe("parallel task spawn: real scheduling contracts (local mock provider)", () => {
		afterEach(() => {
			AgentRegistry.resetGlobalForTests();
			AgentLifecycleManager.resetGlobalForTests();
		});

		afterAll(() => {
			unregisterCustomApis(BENCH_API_SOURCE);
		});

		it(
			"cap 1: a provider-gated first spawn forces the second to queue on the real semaphore; both deliver",
			async () => {
				const firstEntry = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				let liveWatch: ProviderConcurrencyWatch | undefined;
				let entries = 0;
				const batchPromise = runBatch({
					cap: 1,
					tasks: 2,
					loadMs: 10,
					gate: {
						onEntry: async watch => {
							liveWatch = watch;
							entries++;
							if (entries === 1) {
								firstEntry.resolve();
								await release.promise;
							}
						},
					},
				});
				// Wait until the first child's first provider call is in flight (gate held).
				await firstEntry.promise;
				// While the first spawn holds the only permit, the second must not have
				// reached the provider at all — it is blocked on the real semaphore.
				expect(liveWatch?.entries).toBe(1);
				release.resolve();
				const batch = await batchPromise;

				expect(batch.allDelivered).toBe(true);
				expect(batch.allOk).toBe(true);
				// 2 workers × 4 provider calls (1 reply + 3 yield reminders).
				expect(batch.providerEntries).toBe(CALLS_PER_WORKER * 2);
				// Sequential cap: provider concurrency can never exceed 1.
				expect(batch.providerPeak).toBe(1);
				for (const job of batch.jobs) {
					expect(job.requests).toBeGreaterThanOrEqual(1);
					expect(job.ok).toBe(true);
				}
				// The queued job (second spawn) really waited on the task semaphore.
				expect(batch.spawnQueueMsPresent).toBe(true);
				expect(batch.spawnQueueMsSamples.filter(value => value > 0).length).toBeGreaterThanOrEqual(1);
			},
			{ timeout: 60_000 },
		);

		it(
			"cap 2: two gated first-entries prove real provider concurrency ≤ cap and all four tasks deliver",
			async () => {
				const twoEntered = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				let liveWatch: ProviderConcurrencyWatch | undefined;
				let entries = 0;
				const batchPromise = runBatch({
					cap: 2,
					tasks: 4,
					loadMs: 10,
					gate: {
						onEntry: async watch => {
							liveWatch = watch;
							entries++;
							if (entries <= 2) {
								if (entries === 2) twoEntered.resolve();
								await release.promise;
							}
						},
					},
				});
				// Both spawns acquired their permits and entered the mock provider at
				// the same time; the remaining two spawns must still be queued behind
				// the real task semaphore.
				await twoEntered.promise;
				expect(liveWatch?.entries).toBe(2);
				release.resolve();
				const batch = await batchPromise;

				expect(batch.allDelivered).toBe(true);
				expect(batch.allOk).toBe(true);
				expect(batch.providerEntries).toBe(CALLS_PER_WORKER * 4);
				// Provider utilization peaked at exactly the two concurrently-held entries.
				expect(batch.providerPeak).toBe(2);
				// The two spawns that queued behind the held permits really waited.
				expect(batch.spawnQueueMsPresent).toBe(true);
				expect(batch.spawnQueueMsSamples.filter(value => value > 0).length).toBeGreaterThanOrEqual(2);
			},
			{ timeout: 60_000 },
		);
	});
}

// ---------------------------------------------------------------------------
// Benchmark mode:
// `PARALLEL_SPAWN_BENCH=1 bun run packages/coding-agent/test/task/parallel-spawn-local-bench.test.ts`
// Same N identical mock tasks at caps 1/2/4/7, 3 repeats each, one JSON doc.
// ---------------------------------------------------------------------------
interface BenchCapResult {
	cap: number;
	repeats: BatchResult[];
	elapsedMsPerRepeat: number[];
	providerPeakPerRepeat: number[];
	providerEntriesPerRepeat: number[];
	allOkPerRepeat: boolean[];
	allDeliveredPerRepeat: boolean[];
	spawnQueueMsPresent: boolean;
	spawnQueueMsMax: number | undefined;
	spawnQueueMsMean: number | undefined;
	/** Aggregate wall clock (ms) across the repeats of this cap. */
	totalElapsedMs: number;
	/** Per-repeat per-job evidence (id/ok/exitCode/error/durationMs/requests/spawnQueueMs). */
	jobBriefsPerRepeat: JobBrief[][];
}

/** Compact per-job evidence kept in the JSON for the verification record. */
interface JobBrief {
	id: string;
	ok: boolean;
	exitCode: number;
	error?: string;
	durationMs: number;
	requests: number;
	spawnQueueMs?: number;
}

function jobBrief(job: JobOutcome): JobBrief {
	return {
		id: job.id,
		ok: job.ok,
		exitCode: job.exitCode,
		error: job.error,
		durationMs: job.durationMs,
		requests: job.requests,
		...(job.spawnQueueMs !== undefined ? { spawnQueueMs: job.spawnQueueMs } : {}),
	};
}

async function runBench(options: { caps: number[]; tasks: number; repeats: number; loadMs: number }): Promise<unknown> {
	const { caps, tasks, repeats, loadMs } = options;
	const capResults: BenchCapResult[] = [];
	for (const cap of caps) {
		const repeatResults: BatchResult[] = [];
		for (let repeat = 0; repeat < repeats; repeat++) {
			// Each repeat is an independent measurement: fresh global registry and
			// lifecycle owner plus unique spawn names, so no keep-alive session
			// from a previous repeat can collide with a new generation.
			AgentRegistry.resetGlobalForTests();
			AgentLifecycleManager.resetGlobalForTests();
			repeatResults.push(await runBatch({ cap, tasks, loadMs, namePrefix: String(repeat) }));
		}
		const samples = repeatResults.flatMap(result => result.spawnQueueMsSamples);
		capResults.push({
			cap,
			repeats: repeatResults,
			elapsedMsPerRepeat: repeatResults.map(result => result.elapsedMs),
			providerPeakPerRepeat: repeatResults.map(result => result.providerPeak),
			providerEntriesPerRepeat: repeatResults.map(result => result.providerEntries),
			allOkPerRepeat: repeatResults.map(result => result.allOk),
			allDeliveredPerRepeat: repeatResults.map(result => result.allDelivered),
			spawnQueueMsPresent: samples.length > 0,
			spawnQueueMsMax: samples.length > 0 ? Math.max(...samples) : undefined,
			spawnQueueMsMean:
				samples.length > 0
					? Math.round(samples.reduce((sum, value) => sum + value, 0) / samples.length)
					: undefined,
			totalElapsedMs: repeatResults.reduce((sum, result) => sum + result.elapsedMs, 0),
			jobBriefsPerRepeat: repeatResults.map(result => result.jobs.map(jobBrief)),
		});
	}
	return {
		kind: "parallel-spawn-local-bench",
		design: "docs/superpowers/specs/2026-09-06-parallel-subagent-performance-design.md §6",
		scope: "local only; mock provider (benchmock/worker via bench-mock-stream custom api); real TaskTool -> structured executor -> AgentSession -> agent loop; scheduler/executor/session/loop untouched; provider boundary mocked with controlled delay; no network",
		tasksPerRepeat: tasks,
		repeatsPerCap: repeats,
		loadMs,
		caps: capResults.map(({ repeats: _repeats, ...summary }) => summary),
		commands: {
			test: "bun test packages/coding-agent/test/task/parallel-spawn-local-bench.test.ts",
			bench: "PARALLEL_SPAWN_BENCH=1 bun run packages/coding-agent/test/task/parallel-spawn-local-bench.test.ts",
			envOverrides: "BENCH_CAPS (comma list), BENCH_TASKS, BENCH_REPEATS, BENCH_LOAD_MS",
		},
	};
}

if (BENCH_MODE) {
	const caps = (process.env.BENCH_CAPS ?? "1,2,4,7")
		.split(",")
		.map(value => Number.parseInt(value.trim(), 10))
		.filter(value => Number.isInteger(value) && value > 0);
	const tasks = Number.parseInt(process.env.BENCH_TASKS ?? "7", 10) || 7;
	const repeats = Number.parseInt(process.env.BENCH_REPEATS ?? "3", 10) || 3;
	const loadMs = Number.parseInt(process.env.BENCH_LOAD_MS ?? String(DEFAULT_LOAD_MS), 10) || DEFAULT_LOAD_MS;
	try {
		const output = await runBench({ caps, tasks, repeats, loadMs });
		if (process.env.BENCH_QUIET === "1") {
			process.stdout.write(JSON.stringify(output));
		} else {
			console.log(JSON.stringify(output, null, 2));
		}
	} finally {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		unregisterCustomApis(BENCH_API_SOURCE);
	}
}
