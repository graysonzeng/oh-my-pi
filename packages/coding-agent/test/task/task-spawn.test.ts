/**
 * Contracts: task tool spawn routing (rework-contracts.md §3).
 *
 * 1. With an AsyncJobManager wired, `execute` returns immediately (agent id +
 *    job id) while the job body is still gated; job completion delivers a
 *    result carrying the irc follow-up / `history://<id>` hint.
 * 2. The session-scoped spawn semaphore (task.maxConcurrency) serializes job
 *    bodies: with concurrency 1 the second body does not start until the
 *    first releases.
 *
 * Param validation (missing agent / missing task) is covered by
 * test/task/task-schema.test.ts.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { type AsyncJob, AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { renderSubagentHudLines } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { SessionObserverRegistry } from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import {
	__classifyAcquireAbortReasonForTests,
	__exerciseTimeoutMetricSettleRaceForTests,
	__getTaskTimeoutMetricsForTests,
	__getTaskTimeoutOnceKeyCountForTests,
	__makeQueuedTimeoutReasonForTests,
	__resetTaskTimeoutMetricsForTests,
	TaskTool,
} from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { AgentOutputManager } from "@oh-my-pi/pi-coding-agent/task/output-manager";
import * as structuredSubagent from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition, AgentProgress, SingleResult, TaskParams } from "@oh-my-pi/pi-coding-agent/task/types";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { hubToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/hub";
import { snapshotJobs } from "@oh-my-pi/pi-coding-agent/tools/hub/jobs";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

function createSession(options: {
	manager?: AsyncJobManager;
	settings?: Record<string, unknown>;
	eventBus?: EventBus;
}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated(options.settings ?? {}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		asyncJobManager: options.manager,
		eventBus: options.eventBus,
	} as unknown as ToolSession;
}

function getFirstText(result: { content: Array<{ type: string; text?: string }> }): string {
	const content = result.content.find(part => part.type === "text");
	return content?.type === "text" ? (content.text ?? "") : "";
}

function makeResult(id: string, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "task prompt",
		assignment: "Do the thing.",
		exitCode: 0,
		output: "All done.",
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
		...overrides,
	};
}

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
}

function deferred(): Deferred {
	const { promise, resolve } = Promise.withResolvers<void>();
	return { promise, resolve };
}

async function pollUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("pollUntil timed out");
		await Bun.sleep(5);
	}
}

describe("task spawn routing", () => {
	const managers: AsyncJobManager[] = [];

	function createManager(): AsyncJobManager {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		return manager;
	}

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) {
			await manager.dispose({ timeoutMs: 1000 });
		}
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("returns immediately on spawn and delivers the follow-up hint when the job completes", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [{ ...taskAgent, model: ["anthropic/claude-sonnet-4"] }],
			projectAgentsDir: null,
		});
		const gate = deferred();
		const runSpy = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			await gate.promise;
			return makeResult(options.id ?? "?");
		});

		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({ manager, settings: { "task.agentModelOverrides": { task: "openai/gpt-4.1-mini" } } }),
		);

		const result = await tool.execute("tc-spawn", {
			agent: "task",
			name: "Spawnling",
			task: "Do the thing.",
		} as TaskParams);

		// Tool returned while the job body is still gated on the deferred.
		const text = getFirstText(result);
		expect(text).toContain("Spawned agent `Spawnling`");
		const jobId = result.details?.async?.jobId;
		expect(jobId).toBeTruthy();
		expect(text).toContain(`job \`${jobId}\``);
		const job = manager.getJob(jobId!);
		expect(job?.status).toBe("running");
		expect(job?.resultText).toBeUndefined();

		gate.resolve();
		await job!.promise;

		expect(job!.status).toBe("completed");
		expect(job!.resultText).toContain("Spawnling is now idle");
		expect(job!.resultText).toContain("message it via `hub` to follow up");
		expect(job!.resultText).toContain("history://Spawnling");
		expect(runSpy).toHaveBeenCalledTimes(1);
		expect(runSpy.mock.calls[0]?.[0].modelOverride).toEqual(["openai/gpt-4.1-mini"]);
	});

	it("caps review/Gate agents at 30 minutes regardless of task.maxRuntimeMs", async () => {
		const reviewer: AgentDefinition = {
			name: "reviewer",
			description: "Reviewer",
			systemPrompt: "Review.",
			source: "bundled",
		};
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [reviewer],
			projectAgentsDir: null,
		});
		const policySpy = vi.spyOn(structuredSubagent, "resolveEffectiveSubagentPolicy");
		const runSpy = vi
			.spyOn(executorModule, "runSubprocess")
			.mockResolvedValue(makeResult("Reviewer", { agent: "reviewer" }));
		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager, settings: { "task.maxRuntimeMs": 3_600_000 } }));
		const result = await tool.execute("tc-review-cap", {
			agent: "reviewer",
			name: "Reviewer",
			task: "Review the change.",
		} as TaskParams);
		const jobId = result.details?.async?.jobId;
		expect(jobId).toBeTruthy();
		await manager.getJob(jobId!)!.promise;
		expect(runSpy.mock.calls[0]?.[0].maxRuntimeMs).toBe(1_800_000);
		expect(
			policySpy.mock.calls.some(
				([request]) => request.agent === "reviewer" && !Object.hasOwn(request, "maxRuntimeMs"),
			),
		).toBe(true);
	});

	it("keeps a stricter reviewer maxRuntimeMs below the 30-minute ceiling", async () => {
		const reviewer: AgentDefinition = {
			name: "reviewer",
			description: "Reviewer",
			systemPrompt: "Review.",
			source: "bundled",
		};
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [reviewer],
			projectAgentsDir: null,
		});
		const policySpy = vi.spyOn(structuredSubagent, "resolveEffectiveSubagentPolicy");
		const runSpy = vi
			.spyOn(executorModule, "runSubprocess")
			.mockResolvedValue(makeResult("Reviewer", { agent: "reviewer" }));
		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager, settings: { "task.maxRuntimeMs": 300_000 } }));
		const result = await tool.execute("tc-review-stricter", {
			agent: "reviewer",
			name: "Reviewer",
			task: "Review the change.",
		} as TaskParams);
		const jobId = result.details?.async?.jobId;
		expect(jobId).toBeTruthy();
		await manager.getJob(jobId!)!.promise;
		expect(runSpy.mock.calls[0]?.[0].maxRuntimeMs).toBe(300_000);
		expect(
			policySpy.mock.calls.some(
				([request]) => request.agent === "reviewer" && !Object.hasOwn(request, "maxRuntimeMs"),
			),
		).toBe(true);
	});

	it("leaves reviewer runtime unlimited when task.maxRuntimeMs is 0", async () => {
		const reviewer: AgentDefinition = {
			name: "reviewer",
			description: "Reviewer",
			systemPrompt: "Review.",
			source: "bundled",
		};
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [reviewer],
			projectAgentsDir: null,
		});
		const policySpy = vi.spyOn(structuredSubagent, "resolveEffectiveSubagentPolicy");
		const runSpy = vi
			.spyOn(executorModule, "runSubprocess")
			.mockResolvedValue(makeResult("Reviewer", { agent: "reviewer" }));
		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager, settings: { "task.maxRuntimeMs": 0 } }));
		const result = await tool.execute("tc-review-unlimited", {
			agent: "reviewer",
			name: "Reviewer",
			task: "Review the change.",
		} as TaskParams);
		const jobId = result.details?.async?.jobId;
		expect(jobId).toBeTruthy();
		await manager.getJob(jobId!)!.promise;
		expect(runSpy.mock.calls[0]?.[0].maxRuntimeMs).toBe(0);
		expect(
			policySpy.mock.calls.some(
				([request]) => request.agent === "reviewer" && !Object.hasOwn(request, "maxRuntimeMs"),
			),
		).toBe(true);
	});

	it("applies the explore ceiling to a TaskTool sonic spawn without a request cap", async () => {
		const sonic: AgentDefinition = {
			name: "sonic",
			description: "Fast bounded worker",
			systemPrompt: "Inspect quickly.",
			source: "bundled",
		};
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [sonic], projectAgentsDir: null });
		const policySpy = vi.spyOn(structuredSubagent, "resolveEffectiveSubagentPolicy");
		const runSpy = vi
			.spyOn(executorModule, "runSubprocess")
			.mockResolvedValue(makeResult("Sonic", { agent: "sonic" }));
		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager, settings: { "task.maxRuntimeMs": 3_600_000 } }));
		const result = await tool.execute("tc-sonic-cap", {
			agent: "sonic",
			name: "Sonic",
			task: "Inspect the bounded target.",
		} as TaskParams);
		const jobId = result.details?.async?.jobId;
		if (!jobId) throw new Error("Expected sonic async job");
		await manager.getJob(jobId)!.promise;
		expect(runSpy.mock.calls[0]?.[0].maxRuntimeMs).toBe(600_000);
		expect(runSpy.mock.calls[0]?.[0].performanceClass).toBe("explore");
		expect(
			policySpy.mock.calls.some(([request]) => request.agent === "sonic" && !Object.hasOwn(request, "maxRuntimeMs")),
		).toBe(true);
	});

	it("surfaces budget_stop on the parent-facing task summary", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(
			makeResult("YieldedScout", {
				completionKind: "budget_stop",
				aborted: false,
				exitCode: 1,
				output: "partial review report",
				stderr: "soft request budget exceeded",
			}),
		);
		const tool = await TaskTool.create(createSession({ settings: { "async.enabled": false } }));
		const result = await tool.execute("tc-budget-stop-summary", {
			agent: "task",
			name: "YieldedScout",
			task: "Do the thing.",
		} as TaskParams);
		const text = getFirstText(result);
		expect(text).toContain('completionKind="budget_stop"');
		expect(text).toContain('status="budget_stop"');
		expect(text).toContain("partial review report");
		expect(text).toContain("soft request budget exceeded");
		expect(text).not.toMatch(/status="completed"/);
	});

	for (const kind of ["completed", "timeout"] as const) {
		it(`delivers ${kind === "timeout" ? "timed-out" : "incomplete"} review reports to the parent async job`, async () => {
			vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
			const reason = kind === "timeout" ? "runtime limit exceeded" : "required terminal verdict missing";
			vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options =>
				makeResult(options.id ?? "ReviewReport", {
					completionKind: kind,
					exitCode: 1,
					aborted: kind === "timeout",
					abortReason: kind === "timeout" ? reason : undefined,
					stderr: reason,
					output: "Checked authentication; authorization remains unreviewed.",
				}),
			);
			const manager = createManager();
			const tool = await TaskTool.create(createSession({ manager }));
			const spawned = await tool.execute("tc-review-report", {
				agent: "task",
				name: "ReviewReport",
				task: "Review authentication.",
			} as TaskParams);
			const job = manager.getJob(spawned.details!.async!.jobId)!;
			await job.promise;
			const delivered = job.resultText ?? job.errorText ?? "";
			expect(delivered).toContain(reason);
			expect(delivered).toContain("authorization remains unreviewed");
			expect(delivered).not.toContain('status="completed"');
		});
	}

	for (const lifecycleFirst of [true, false]) {
		it(`delivers failed review content when lifecycle arrives ${lifecycleFirst ? "before" : "after"} consumption`, async () => {
			vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
			const bus = new EventBus();
			const observers = new SessionObserverRegistry();
			observers.subscribeToEventBus(bus);
			const delivered = Promise.withResolvers<string>();
			let deliveries = 0;
			const manager = new AsyncJobManager({
				onJobComplete: (_id, text) => {
					deliveries++;
					delivered.resolve(text);
				},
			});
			managers.push(manager);
			const emitTerminal = () =>
				bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
					id: "ReviewRace",
					agent: "task",
					status: "failed",
					completionKind: "completed",
					index: 0,
				});
			vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
				if (lifecycleFirst) emitTerminal();
				return makeResult(options.id ?? "ReviewRace", {
					exitCode: 1,
					stderr: "required terminal verdict missing",
					output: "SALVAGE: authorization not reviewed",
				});
			});
			try {
				const tool = await TaskTool.create(createSession({ manager, eventBus: bus }));
				const spawned = await tool.execute("tc-review-race", {
					agent: "task",
					name: "ReviewRace",
					task: "Review authorization.",
				} as TaskParams);
				const text = await delivered.promise;
				await manager.getJob(spawned.details!.async!.jobId)!.promise;
				if (!lifecycleFirst) emitTerminal();
				expect(text).toContain("SALVAGE: authorization not reviewed");
				expect(text).toContain("required terminal verdict missing");
				expect(text).not.toContain('status="completed"');
				expect(deliveries).toBe(1);
			} finally {
				observers.dispose();
			}
		});
	}

	it("bounds concurrent job bodies with the session spawn semaphore", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const started: string[] = [];
		const gates = new Map<string, Deferred>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			started.push(id);
			const gate = deferred();
			gates.set(id, gate);
			await gate.promise;
			return makeResult(id);
		});

		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager, settings: { "task.maxConcurrency": 1 } }));

		const first = await tool.execute("tc-1", { agent: "task", name: "First", task: "Work A." } as TaskParams);
		const second = await tool.execute("tc-2", { agent: "task", name: "Second", task: "Work B." } as TaskParams);
		const firstJob = manager.getJob(first.details!.async!.jobId)!;
		const secondJob = manager.getJob(second.details!.async!.jobId)!;

		// First job body reaches the executor; second stays parked at the
		// semaphore — still flagged queued becausekRunning never ran.
		await pollUntil(() => started.length >= 1);
		expect(started).toEqual(["First"]);
		expect(secondJob.queued).toBe(true);

		// Releasing the first body lets the second one start.
		gates.get(started[0]!)!.resolve();
		await firstJob.promise;
		await pollUntil(() => started.length === 2);
		expect(started).toEqual(["First", "Second"]);

		gates.get("Second")!.resolve();
		await secondJob.promise;
		expect(firstJob.status).toBe("completed");
		expect(secondJob.status).toBe("completed");
	});

	it("settles a cancelled spawn while it is queued behind the semaphore", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const started: string[] = [];
		const gates = new Map<string, Deferred>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			started.push(id);
			const gate = deferred();
			gates.set(id, gate);
			await gate.promise;
			return makeResult(id);
		});

		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager, settings: { "task.maxConcurrency": 1 } }));

		const first = await tool.execute("tc-1", { agent: "task", name: "First", task: "Work A." } as TaskParams);
		const second = await tool.execute("tc-2", { agent: "task", name: "Second", task: "Work B." } as TaskParams);
		const firstJob = manager.getJob(first.details!.async!.jobId)!;
		const secondJob = manager.getJob(second.details!.async!.jobId)!;

		await pollUntil(() => started.length === 1);
		expect(started).toEqual(["First"]);
		expect(secondJob.queued).toBe(true);

		expect(manager.cancel(secondJob.id)).toBe(true);
		const queuedResult = await Promise.race([
			secondJob.promise.then(() => "settled" as const),
			Bun.sleep(75).then(() => "timeout" as const),
		]);

		gates.get("First")!.resolve();
		await firstJob.promise;
		await secondJob.promise;

		expect(queuedResult).toBe("settled");
		expect(started).toEqual(["First"]);
		expect(secondJob.status).toBe("cancelled");
	});

	it("keeps the concurrency cap intact when a queued spawn is cancelled (no permit leak)", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const started: string[] = [];
		const gates = new Map<string, Deferred>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			started.push(id);
			const gate = deferred();
			gates.set(id, gate);
			await gate.promise;
			return makeResult(id);
		});

		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager, settings: { "task.maxConcurrency": 1 } }));

		// A holds the only permit, gated inside the executor.
		const first = await tool.execute("tc-1", { agent: "task", name: "First", task: "Work A." } as TaskParams);
		const firstJob = manager.getJob(first.details!.async!.jobId)!;
		await pollUntil(() => started.length === 1);

		// B parks at the semaphore, then is cancelled while queued. Its
		// teardown must NOT release a permit it never acquired.
		const second = await tool.execute("tc-2", { agent: "task", name: "Second", task: "Work B." } as TaskParams);
		const secondJob = manager.getJob(second.details!.async!.jobId)!;
		expect(secondJob.queued).toBe(true);
		expect(manager.cancel(secondJob.id)).toBe(true);
		await secondJob.promise;
		expect(secondJob.status).toBe("cancelled");

		// C must stay parked while A still holds the cap. A phantom release
		// from B's cancellation would admit C here, running 2 bodies at cap 1.
		const third = await tool.execute("tc-3", { agent: "task", name: "Third", task: "Work C." } as TaskParams);
		const thirdJob = manager.getJob(third.details!.async!.jobId)!;
		await Bun.sleep(50);
		expect(started).toEqual(["First"]);
		expect(thirdJob.queued).toBe(true);

		// A finishing admits C — the cap still cycles normally.
		gates.get("First")!.resolve();
		await firstJob.promise;
		await pollUntil(() => started.length === 2);
		expect(started).toEqual(["First", "Third"]);

		// D queued behind running C stays serialized: if B's teardown had
		// double-released, two permits would be free and D would start now.
		const fourth = await tool.execute("tc-4", { agent: "task", name: "Fourth", task: "Work D." } as TaskParams);
		const fourthJob = manager.getJob(fourth.details!.async!.jobId)!;
		await Bun.sleep(50);
		expect(started).toEqual(["First", "Third"]);
		expect(fourthJob.queued).toBe(true);

		gates.get("Third")!.resolve();
		await thirdJob.promise;
		await pollUntil(() => started.length === 3);
		gates.get("Fourth")!.resolve();
		await fourthJob.promise;

		expect(started).toEqual(["First", "Third", "Fourth"]);
		expect(firstJob.status).toBe("completed");
		expect(thirdJob.status).toBe("completed");
		expect(fourthJob.status).toBe("completed");
	});

	it("fails a spawn that waits too long for a semaphore permit (queued startup timeout)", async () => {
		__resetTaskTimeoutMetricsForTests();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const started: string[] = [];
		const gates = new Map<string, Deferred>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			started.push(id);
			const gate = deferred();
			gates.set(id, gate);
			await gate.promise;
			return makeResult(id);
		});

		const manager = createManager();
		const session = createSession({
			manager,
			settings: {
				"task.maxConcurrency": 1,
				"task.queuedStartupTimeoutMs": 40,
				// Keep runtime unlimited so only the queue guard can fire.
				"task.maxRuntimeMs": 0,
			},
		});
		const tool = await TaskTool.create(session);

		const first = await tool.execute("tc-hold", {
			agent: "task",
			name: "Holder",
			task: "Hold the only permit.",
		} as TaskParams);
		const firstJob = manager.getJob(first.details!.async!.jobId)!;
		await pollUntil(() => started.length === 1);
		expect(started).toEqual(["Holder"]);

		const second = await tool.execute("tc-queued", {
			agent: "task",
			name: "Queued",
			task: "Wait behind holder.",
		} as TaskParams);
		const secondJob = manager.getJob(second.details!.async!.jobId)!;
		expect(secondJob.queued).toBe(true);

		await secondJob.promise;
		expect(secondJob.status).toBe("failed");
		expect(secondJob.errorText ?? "").toContain("queued startup timeout");
		expect(secondJob.errorText ?? "").toContain("task.queuedStartupTimeoutMs=40");
		expect(started).toEqual(["Holder"]);
		expect(__getTaskTimeoutMetricsForTests().queued_timeout_triggered).toBe(1);

		// A later job with the same agent name must get a fresh per-job metric key.
		session.agentOutputManager = new AgentOutputManager(session.getArtifactsDir ?? (() => null));
		const repeated = await tool.execute("tc-queued-repeat", {
			agent: "task",
			name: "Queued",
			task: "Wait behind holder again.",
		} as TaskParams);
		const repeatedJob = manager.getJob(repeated.details!.async!.jobId)!;
		await repeatedJob.promise;
		expect(repeatedJob.status).toBe("failed");
		expect(__getTaskTimeoutMetricsForTests().queued_timeout_triggered).toBe(2);

		// Permit must not leak: after holder finishes, a third spawn can acquire.
		const third = await tool.execute("tc-after", {
			agent: "task",
			name: "After",
			task: "Should start after holder releases.",
		} as TaskParams);
		const thirdJob = manager.getJob(third.details!.async!.jobId)!;
		// Still held by Holder until we release it.
		await Bun.sleep(20);
		expect(started).toEqual(["Holder"]);
		expect(thirdJob.queued).toBe(true);

		gates.get("Holder")!.resolve();
		await firstJob.promise;
		await pollUntil(() => started.includes("After"));
		expect(started).toEqual(["Holder", "After"]);
		gates.get("After")!.resolve();
		await thirdJob.promise;
		expect(thirdJob.status).toBe("completed");
		expect(__getTaskTimeoutMetricsForTests().queued_timeout_triggered).toBe(2);
	});

	it("keeps cancel as first cause when timeout timer fires after cancel (same-tick race)", async () => {
		__resetTaskTimeoutMetricsForTests();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const started: string[] = [];
		const gates = new Map<string, Deferred>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			started.push(id);
			const gate = deferred();
			gates.set(id, gate);
			await gate.promise;
			return makeResult(id);
		});

		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({
				manager,
				settings: {
					"task.maxConcurrency": 1,
					// Long enough that cancel can win; short enough to still fire in-test.
					"task.queuedStartupTimeoutMs": 80,
					"task.maxRuntimeMs": 0,
				},
			}),
		);

		const first = await tool.execute("tc-hold-cancel", {
			agent: "task",
			name: "Holder",
			task: "Hold the only permit.",
		} as TaskParams);
		const firstJob = manager.getJob(first.details!.async!.jobId)!;
		await pollUntil(() => started.length === 1);

		const second = await tool.execute("tc-queued-cancel", {
			agent: "task",
			name: "Queued",
			task: "Wait behind holder, then cancel.",
		} as TaskParams);
		const secondJob = manager.getJob(second.details!.async!.jobId)!;
		expect(secondJob.queued).toBe(true);

		// Cancel wins first-cause before the queued-startup timer.
		expect(manager.cancel(secondJob.id)).toBe(true);
		await secondJob.promise;
		// Allow any late timer tick; clearTimeout + first-cause must still keep cancel attribution.
		await Bun.sleep(120);

		expect(secondJob.status).toBe("cancelled");
		expect(secondJob.errorText ?? "").not.toContain("queued startup timeout");
		expect(started).toEqual(["Holder"]);
		expect(__getTaskTimeoutMetricsForTests().queued_timeout_triggered).toBe(0);
		// F8: cancel-then-late-timer must not leave orphan once-keys.
		expect(__getTaskTimeoutOnceKeyCountForTests()).toBe(0);

		gates.get("Holder")!.resolve();
		await firstJob.promise;
	});

	it("F8: settleOnce always clears once-keys even after a late record", () => {
		__resetTaskTimeoutMetricsForTests();
		const result = __exerciseTimeoutMetricSettleRaceForTests("race-job");
		expect(result.keysAfterLateRecord).toBe(1);
		expect(result.keysAfterReentryClear).toBe(0);
		expect(__getTaskTimeoutOnceKeyCountForTests()).toBe(0);
	});

	it("classifies cancel-then-timeout by combinedSignal.reason only (no secondary OR)", () => {
		const cancel = new AbortController();
		const queued = new AbortController();
		const combined = AbortSignal.any([cancel.signal, queued.signal]);
		cancel.abort(new Error("user-cancel"));
		queued.abort(__makeQueuedTimeoutReasonForTests(80));

		// Production must trust AbortSignal.any first-cause only.
		expect(__classifyAcquireAbortReasonForTests(combined.reason)).toBe("aborted");
		// Secondary timeout reason is present but must not rewrite first-cause.
		expect(__classifyAcquireAbortReasonForTests(queued.signal.reason)).toBe("queued_timeout");
	});

	it("classifies timeout-then-cancel by combinedSignal.reason only", () => {
		const cancel = new AbortController();
		const queued = new AbortController();
		const combined = AbortSignal.any([cancel.signal, queued.signal]);
		queued.abort(__makeQueuedTimeoutReasonForTests(40));
		cancel.abort(new Error("user-cancel"));

		expect(__classifyAcquireAbortReasonForTests(combined.reason)).toBe("queued_timeout");
	});

	it("keeps queued timeout as first cause when timeout beats a later cancel", async () => {
		__resetTaskTimeoutMetricsForTests();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const started: string[] = [];
		const gates = new Map<string, Deferred>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			started.push(id);
			const gate = deferred();
			gates.set(id, gate);
			await gate.promise;
			return makeResult(id);
		});

		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({
				manager,
				settings: {
					"task.maxConcurrency": 1,
					"task.queuedStartupTimeoutMs": 40,
					"task.maxRuntimeMs": 0,
				},
			}),
		);

		const first = await tool.execute("tc-hold-timeout-first", {
			agent: "task",
			name: "Holder",
			task: "Hold the only permit.",
		} as TaskParams);
		const firstJob = manager.getJob(first.details!.async!.jobId)!;
		await pollUntil(() => started.length === 1);

		const second = await tool.execute("tc-queued-timeout-first", {
			agent: "task",
			name: "Queued",
			task: "Wait behind holder until timeout.",
		} as TaskParams);
		const secondJob = manager.getJob(second.details!.async!.jobId)!;
		expect(secondJob.queued).toBe(true);

		await secondJob.promise;
		// Timeout already settled the job; a late cancel must not rewrite attribution.
		expect(manager.cancel(secondJob.id)).toBe(false);
		expect(secondJob.status).toBe("failed");
		expect(secondJob.errorText ?? "").toContain("queued startup timeout");
		expect(started).toEqual(["Holder"]);
		expect(__getTaskTimeoutMetricsForTests().queued_timeout_triggered).toBe(1);

		gates.get("Holder")!.resolve();
		await firstJob.promise;
	});

	for (const maxConcurrency of [0, 0.5]) {
		it(`runs spawn job bodies unbounded when task.maxConcurrency is ${maxConcurrency}`, async () => {
			vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
				agents: [taskAgent],
				projectAgentsDir: null,
			});
			const started: string[] = [];
			const gates = new Map<string, Deferred>();
			vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
				const id = options.id ?? "?";
				started.push(id);
				const gate = deferred();
				gates.set(id, gate);
				await gate.promise;
				return makeResult(id);
			});

			const manager = createManager();
			const tool = await TaskTool.create(
				createSession({ manager, settings: { "task.maxConcurrency": maxConcurrency } }),
			);

			const first = await tool.execute("tc-1", { agent: "task", name: "First", task: "Work A." } as TaskParams);
			const second = await tool.execute("tc-2", { agent: "task", name: "Second", task: "Work B." } as TaskParams);
			const third = await tool.execute("tc-3", { agent: "task", name: "Third", task: "Work C." } as TaskParams);

			// All three job bodies clear the spawn semaphore in parallel — none stays queued.
			await pollUntil(() => started.length === 3);
			expect(started.sort()).toEqual(["First", "Second", "Third"]);

			for (const id of ["First", "Second", "Third"]) gates.get(id)!.resolve();
			await Promise.all([
				manager.getJob(first.details!.async!.jobId)!.promise,
				manager.getJob(second.details!.async!.jobId)!.promise,
				manager.getJob(third.details!.async!.jobId)!.promise,
			]);
		});
	}

	it("re-reads task.maxConcurrency on each spawn so a mid-session change applies on the next acquire", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const started: string[] = [];
		const gates = new Map<string, Deferred>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			started.push(id);
			const gate = deferred();
			gates.set(id, gate);
			await gate.promise;
			return makeResult(id);
		});

		const manager = createManager();
		const settings = Settings.isolated({ "task.maxConcurrency": 4 });
		const tool = await TaskTool.create({
			cwd: "/tmp",
			hasUI: false,
			settings,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			asyncJobManager: manager,
		} as unknown as ToolSession);

		// Prime the semaphore at the initial high cap.
		const first = await tool.execute("tc-1", { agent: "task", name: "First", task: "Work A." } as TaskParams);
		await pollUntil(() => started.length === 1);

		// Tighten the cap mid-session. The next spawn MUST see the new ceiling.
		settings.override("task.maxConcurrency", 1);
		const second = await tool.execute("tc-2", { agent: "task", name: "Second", task: "Work B." } as TaskParams);
		const secondJob = manager.getJob(second.details!.async!.jobId)!;

		// First is still running (and holding the only slot under the new cap),
		// so Second is parked at the semaphore — queued, not running.
		expect(started).toEqual(["First"]);
		expect(secondJob.queued).toBe(true);

		// Releasing First admits Second.
		gates.get("First")!.resolve();
		await manager.getJob(first.details!.async!.jobId)!.promise;
		await pollUntil(() => started.length === 2);
		expect(started).toEqual(["First", "Second"]);

		gates.get("Second")!.resolve();
		await secondJob.promise;
	});

	it("applies a lowered maxConcurrency to work already queued in the semaphore", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const started: string[] = [];
		const gates = new Map<string, Deferred>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			started.push(id);
			const gate = deferred();
			gates.set(id, gate);
			await gate.promise;
			return makeResult(id);
		});

		const manager = createManager();
		const settings = Settings.isolated({ "task.maxConcurrency": 4 });
		const tool = await TaskTool.create({
			cwd: "/tmp",
			hasUI: false,
			settings,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			asyncJobManager: manager,
		} as unknown as ToolSession);

		const jobs: AsyncJob[] = [];
		for (const id of ["First", "Second", "Third", "Fourth", "Fifth"]) {
			const result = await tool.execute(`tc-${id}`, { agent: "task", name: id, task: `Work ${id}.` } as TaskParams);
			jobs.push(manager.getJob(result.details!.async!.jobId)!);
		}
		const fifthJob = jobs[4]!;

		await pollUntil(() => started.length === 4);
		expect([...started].sort()).toEqual(["First", "Fourth", "Second", "Third"]);
		expect(fifthJob.queued).toBe(true);

		settings.override("task.maxConcurrency", 1);
		gates.get("First")!.resolve();
		await jobs[0]!.promise;
		await Promise.resolve();
		expect([...started].sort()).toEqual(["First", "Fourth", "Second", "Third"]);
		expect(fifthJob.queued).toBe(true);

		for (const id of ["Second", "Third", "Fourth"]) gates.get(id)!.resolve();
		await pollUntil(() => started.length === 5);
		expect([...started].sort()).toEqual(["Fifth", "First", "Fourth", "Second", "Third"]);

		gates.get("Fifth")!.resolve();
		await Promise.all(jobs.map(job => job.promise));
	});

	it("copies executor current-tool args and start timestamp onto the job snapshot", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const now = 1_700_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);
		const started = Promise.withResolvers<void>();
		const switchTools = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			expect(options.detached).toBe(true);
			const emit = (progress: AgentProgress) => {
				options.onProgress?.(progress);
				options.eventBus?.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
					index: options.index ?? 0,
					agent: options.agent.name,
					agentSource: options.agent.source,
					task: options.task,
					parentToolCallId: options.parentToolCallId,
					detached: options.detached,
					assignment: options.assignment,
					progress,
					sessionFile: options.sessionFile,
				});
			};
			emit({
				index: 0,
				id: options.id,
				agent: "task",
				agentSource: "bundled",
				status: "running",
				task: options.task,
				lastIntent: "Inspect login",
				currentTool: "read",
				currentToolArgs: "src/auth.ts",
				currentToolStartMs: now - 6_000,
				recentTools: [],
				recentOutput: [],
				toolCount: 1,
				requests: 0,
				tokens: 0,
				cost: 0,
				durationMs: 6_000,
			});
			started.resolve();
			await switchTools.promise;
			emit({
				index: 0,
				id: options.id,
				agent: "task",
				agentSource: "bundled",
				status: "running",
				task: options.task,
				currentTool: undefined,
				currentToolArgs: undefined,
				currentToolStartMs: undefined,
				recentTools: [{ tool: "grep", args: "password", endMs: now }],
				recentOutput: [],
				toolCount: 1,
				requests: 0,
				tokens: 0,
				cost: 0,
				durationMs: 6_000,
			});
			await finish.promise;
			return makeResult(options.id);
		});
		const manager = createManager();
		const eventBus = new EventBus();
		const observers = new SessionObserverRegistry();
		observers.subscribeToEventBus(eventBus);
		const session = createSession({ manager, eventBus });
		const tool = await TaskTool.create(session);
		const result = await tool.execute("tc-live-copy", {
			agent: "task",
			name: "AuthLoader",
			task: "Refactor the auth flow.",
		} as TaskParams);
		const jobId = result.details?.async?.jobId;
		expect(jobId).toBe("AuthLoader");
		await started.promise;
		await pollUntil(() => snapshotJobs(session, manager.getAllJobs())[0]?.liveActivity?.tool === "read");
		const running = snapshotJobs(session, manager.getAllJobs());
		expect(running[0]?.liveActivity).toEqual({
			tool: "read",
			detail: "Inspect login",
			elapsedMs: 6_000,
		});
		const runningOut = Bun.stripANSI(
			(
				hubToolRenderer
					.renderResult(
						{ content: [{ type: "text", text: "" }], details: { op: "wait", jobs: running } },
						{ expanded: false, isPartial: true } as Parameters<typeof hubToolRenderer.renderResult>[1],
						theme,
						{ op: "wait", ids: [] },
					)
					.render(120) as readonly string[]
			).join("\n"),
		);
		expect(runningOut).toMatch(/read: Inspect login/);
		expect(runningOut).not.toContain("src/auth.ts");
		expect(runningOut).toContain("6.0s");
		const runningHud = Bun.stripANSI(renderSubagentHudLines(observers.getSessions(), 120).join("\n"));
		expect(runningHud).toContain("AuthLoader");
		expect(runningHud).toMatch(/read: Inspect login/);
		expect(runningHud).not.toContain("src/auth.ts");
		expect(runningHud).toContain("6.0s");
		const runningWaitNarrow = Bun.stripANSI(
			(
				hubToolRenderer
					.renderResult(
						{ content: [{ type: "text", text: "" }], details: { op: "wait", jobs: running } },
						{ expanded: false, isPartial: true } as Parameters<typeof hubToolRenderer.renderResult>[1],
						theme,
						{ op: "wait", ids: [] },
					)
					.render(40) as readonly string[]
			).join("\n"),
		);
		expect(runningWaitNarrow).toMatch(/read: Inspect login/);
		expect(runningWaitNarrow).not.toContain("src/auth.ts");
		expect(runningWaitNarrow).toContain("6.0s");
		for (const line of runningWaitNarrow.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
		}
		const runningHudNarrow = Bun.stripANSI(renderSubagentHudLines(observers.getSessions(), 40).join("\n"));
		expect(runningHudNarrow).toContain("AuthLoader");
		expect(runningHudNarrow).toMatch(/read: Inspect login/);
		expect(runningHudNarrow).not.toContain("src/auth.ts");
		expect(runningHudNarrow).toContain("6.0s");
		for (const line of runningHudNarrow.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
		}
		switchTools.resolve();
		await pollUntil(() => snapshotJobs(session, manager.getAllJobs())[0]?.liveActivity?.tool === "grep");
		const recent = snapshotJobs(session, manager.getAllJobs());
		expect(recent[0]?.liveActivity).toEqual({
			tool: "grep",
			detail: "password",
		});
		const recentOut = Bun.stripANSI(
			(
				hubToolRenderer
					.renderResult(
						{ content: [{ type: "text", text: "" }], details: { op: "wait", jobs: recent } },
						{ expanded: false, isPartial: true } as Parameters<typeof hubToolRenderer.renderResult>[1],
						theme,
						{ op: "wait", ids: [] },
					)
					.render(120) as readonly string[]
			).join("\n"),
		);
		expect(recentOut).toMatch(/grep: password/);
		expect(recentOut).not.toContain("src/auth.ts");
		expect(recentOut).not.toContain("6.0s");
		const recentHud = Bun.stripANSI(renderSubagentHudLines(observers.getSessions(), 120).join("\n"));
		expect(recentHud).toMatch(/grep: password/);
		expect(recentHud).not.toContain("src/auth.ts");
		expect(recentHud).not.toContain("6.0s");
		const recentWaitNarrow = Bun.stripANSI(
			(
				hubToolRenderer
					.renderResult(
						{ content: [{ type: "text", text: "" }], details: { op: "wait", jobs: recent } },
						{ expanded: false, isPartial: true } as Parameters<typeof hubToolRenderer.renderResult>[1],
						theme,
						{ op: "wait", ids: [] },
					)
					.render(40) as readonly string[]
			).join("\n"),
		);
		expect(recentWaitNarrow).toMatch(/grep: password/);
		expect(recentWaitNarrow).not.toContain("src/auth.ts");
		expect(recentWaitNarrow).not.toContain("6.0s");
		for (const line of recentWaitNarrow.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
		}
		const recentHudNarrow = Bun.stripANSI(renderSubagentHudLines(observers.getSessions(), 40).join("\n"));
		expect(recentHudNarrow).toMatch(/grep: password/);
		expect(recentHudNarrow).not.toContain("src/auth.ts");
		expect(recentHudNarrow).not.toContain("6.0s");
		for (const line of recentHudNarrow.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
		}
		finish.resolve();
		await manager.getJob(jobId!)?.promise;
	});
});
