/**
 * The job tool's TUI preview must not leak the model-facing `<task-result>`
 * envelope (prompts/tools/task-summary.md): a settled task job previews the
 * inner <output>/<preview> body, while non-envelope result text (bash jobs)
 * passes through unchanged.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { type AgentProgress, copySpawnJobLiveProgress } from "@oh-my-pi/pi-coding-agent/task";
import { prompt } from "@oh-my-pi/pi-utils";
import { AsyncJobManager } from "../src/async/job-manager";
import taskSummaryTemplate from "../src/prompts/tools/task-summary.md" with { type: "text" };
import type { ToolSession } from "../src/tools";
import { hubToolRenderer } from "../src/tools/hub";
import { buildJobResult, snapshotJobs } from "../src/tools/hub/jobs";

function renderLines(resultText: string): string {
	const result = {
		content: [{ type: "text", text: "" }],
		details: {
			op: "wait" as const,
			jobs: [
				{
					id: "SpawnProbe",
					type: "task" as const,
					status: "completed" as const,
					label: "SpawnProbe",
					durationMs: 8_700,
					resultText,
				},
			],
		},
	};
	const component = hubToolRenderer.renderResult(
		result,
		{ expanded: true } as Parameters<typeof hubToolRenderer.renderResult>[1],
		theme,
	);
	return (component.render(120) as readonly string[]).join("\n");
}

describe("job renderer task-result preview", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	it("previews the envelope body, not the wrapper markup", () => {
		const summary = prompt.render(taskSummaryTemplate, {
			agentName: "sonic",
			id: "SpawnProbe",
			status: "completed",
			duration: "8.7s",
			preview: "Probe finished: spawned worker, ping ok.",
			truncated: false,
			meta: { lineCount: 3, charSize: "120 B" },
			mergeSummary: "",
		});
		const deliveryText = `${summary}\n\nSpawnProbe is now idle — message it via \`irc\` to follow up; transcript at history://SpawnProbe`;

		const output = renderLines(deliveryText);
		expect(output).toContain("Probe finished: spawned worker, ping ok.");
		expect(output).not.toContain("<task-result");
		expect(output).not.toContain("<output>");
	});

	it("previews the truncated <preview> body the same way", () => {
		const summary = prompt.render(taskSummaryTemplate, {
			agentName: "task",
			id: "BigOne",
			status: "completed",
			duration: "2m",
			preview: "first line of long output",
			truncated: true,
			mergeSummary: "",
		});

		const output = renderLines(summary);
		expect(output).toContain("first line of long output");
		expect(output).not.toContain("<task-result");
	});

	it("flattens a pretty-printed JSON body instead of previewing a lone brace", () => {
		const summary = prompt.render(taskSummaryTemplate, {
			agentName: "sonic",
			id: "EchoAlpha",
			status: "completed",
			duration: "11.6s",
			preview: '{\n  "echo": "alpha",\n  "ok": true\n}',
			truncated: false,
			mergeSummary: "",
		});

		const output = Bun.stripANSI(renderLines(summary));
		expect(output).toContain('{ "echo": "alpha", "ok": true }');
		expect(output.split("\n").some(line => line.trim() === "{")).toBe(false);
	});

	it("passes non-envelope result text through unchanged", () => {
		const output = renderLines("42 pass, 0 fail (18.4s)");
		expect(output).toContain("42 pass, 0 fail (18.4s)");
	});

	it("drops the id column when the label repeats it", () => {
		// Task jobs label themselves with their agent id; rendering both columns
		// stutters ("SpawnProbe ⟨task⟩ SpawnProbe").
		const output = Bun.stripANSI(renderLines("done"));
		const header = output.split("\n").find(line => line.includes("SpawnProbe"));
		expect(header).toBeDefined();
		expect(header!.match(/SpawnProbe/g)).toHaveLength(1);
	});

	describe("collapse and filter when turned into a result", () => {
		const jobsData = [
			{
				id: "Job1",
				type: "task" as const,
				status: "running" as const,
				label: "Job1 running",
				durationMs: 1200,
			},
			{
				id: "Job2",
				type: "task" as const,
				status: "completed" as const,
				label: "Job2 completed",
				durationMs: 3400,
				resultText: "Job2 result",
			},
			{
				id: "Job3",
				type: "task" as const,
				status: "running" as const,
				label: "Job3 running",
				durationMs: 500,
			},
		];

		it("shows all jobs when isPartial is true", () => {
			const result = {
				content: [{ type: "text" as const, text: "" }],
				details: { op: "wait" as const, jobs: jobsData },
			};
			const component = hubToolRenderer.renderResult(
				result,
				{ expanded: true, isPartial: true } as Parameters<typeof hubToolRenderer.renderResult>[1],
				theme,
				{ op: "wait", ids: [] },
			);
			const output = Bun.stripANSI((component.render(120) as readonly string[]).join("\n"));
			expect(output).toContain("Job1 running");
			expect(output).toContain("Job2 completed");
			expect(output).toContain("Job3 running");
			expect(output).toContain("waiting on 2 of 3 jobs");
		});

		it("shows only finished jobs when isPartial is false and it is a poll call", () => {
			const result = {
				content: [{ type: "text" as const, text: "" }],
				details: { op: "wait" as const, jobs: jobsData },
			};
			const component = hubToolRenderer.renderResult(
				result,
				{ expanded: true, isPartial: false } as Parameters<typeof hubToolRenderer.renderResult>[1],
				theme,
				{ op: "wait", ids: [] },
			);
			const output = Bun.stripANSI((component.render(120) as readonly string[]).join("\n"));
			expect(output).not.toContain("Job1 running");
			expect(output).toContain("Job2 completed");
			expect(output).not.toContain("Job3 running");
			expect(output).toContain("1 job settled");
		});

		it("shows nothing when isPartial is false and all jobs are running and it is a poll call", () => {
			const runningJobsOnly = [
				{
					id: "Job1",
					type: "task" as const,
					status: "running" as const,
					label: "Job1 running",
					durationMs: 1200,
				},
			];
			const result = {
				content: [{ type: "text" as const, text: "" }],
				details: { op: "wait" as const, jobs: runningJobsOnly },
			};
			const component = hubToolRenderer.renderResult(
				result,
				{ expanded: true, isPartial: false } as Parameters<typeof hubToolRenderer.renderResult>[1],
				theme,
				{ op: "wait", ids: [] },
			);
			const lines = component.render(120) as readonly string[];
			expect(lines).toHaveLength(0);
		});

		it("does not collapse running jobs when isPartial is false and list is true", () => {
			const result = {
				content: [{ type: "text" as const, text: "" }],
				details: { op: "jobs" as const, jobs: jobsData },
			};
			const component = hubToolRenderer.renderResult(
				result,
				{ expanded: true, isPartial: false } as Parameters<typeof hubToolRenderer.renderResult>[1],
				theme,
				{ op: "jobs" },
			);
			const output = Bun.stripANSI((component.render(120) as readonly string[]).join("\n"));
			expect(output).toContain("Job1 running");
			expect(output).toContain("Job2 completed");
			expect(output).toContain("Job3 running");
			expect(output).toContain("waiting on 2 of 3 jobs");
		});

		it("does not collapse running jobs when isPartial is false and cancel-only is true", () => {
			const result = {
				content: [{ type: "text" as const, text: "" }],
				details: { op: "cancel" as const, jobs: jobsData },
			};
			const component = hubToolRenderer.renderResult(
				result,
				{ expanded: true, isPartial: false } as Parameters<typeof hubToolRenderer.renderResult>[1],
				theme,
				{ op: "cancel", ids: ["Job1"] },
			);
			const output = Bun.stripANSI((component.render(120) as readonly string[]).join("\n"));
			expect(output).toContain("Job1 running");
			expect(output).toContain("Job2 completed");
			expect(output).toContain("Job3 running");
			expect(output).toContain("waiting on 2 of 3 jobs");
		});

		it("renders agent rows for running agents outside job control", () => {
			const result = {
				content: [{ type: "text" as const, text: "" }],
				details: {
					op: "jobs" as const,
					jobs: [],
					agents: [{ id: "Worker", parentId: "Main", activity: "grepping the tree", ageMs: 65_000, live: true }],
				},
			};
			const component = hubToolRenderer.renderResult(
				result,
				{ expanded: true, isPartial: false } as Parameters<typeof hubToolRenderer.renderResult>[1],
				theme,
				{ op: "jobs" },
			);
			const output = Bun.stripANSI((component.render(120) as readonly string[]).join("\n"));
			expect(output).toContain("1 running agent — no jobs");
			expect(output).toContain("Worker");
			expect(output).toContain("grepping the tree");
		});

		it("keeps a sealed bare-poll result visible when it carries an agent roster", () => {
			const result = {
				content: [{ type: "text" as const, text: "No running background jobs to wait for." }],
				details: { op: "wait" as const, jobs: [], agents: [{ id: "Worker", ageMs: 1_000, live: false }] },
			};
			const component = hubToolRenderer.renderResult(
				result,
				{ expanded: true, isPartial: false } as Parameters<typeof hubToolRenderer.renderResult>[1],
				theme,
				{ op: "wait", ids: [] },
			);
			const output = Bun.stripANSI((component.render(120) as readonly string[]).join("\n"));
			expect(output).toContain("Worker");
			// A ref claiming `running` with no turn in flight is flagged, not shown
			// as live work.
			expect(output).toContain("no turn");
		});
	});
});

function makeCopiedProgress(overrides: Partial<AgentProgress> & { id: string }): AgentProgress {
	const target: AgentProgress = {
		index: 0,
		id: overrides.id,
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "old task",
		currentTool: "grep",
		currentToolArgs: "stale-args",
		currentToolStartMs: 1,
		recentTools: [{ tool: "bash", args: "stale", endMs: 1 }],
		recentOutput: ["stale"],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
	};
	copySpawnJobLiveProgress(target, {
		...target,
		currentTool: undefined,
		currentToolArgs: undefined,
		currentToolStartMs: undefined,
		lastIntent: undefined,
		recentTools: [],
		recentOutput: [],
		...overrides,
	});
	return target;
}

async function renderRunningCopiedJob(
	progress: AgentProgress,
	width = 120,
	surface: "jobs" | "wait" = "jobs",
	isPartial?: boolean,
): Promise<string> {
	const reported = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<string>();
	const manager = new AsyncJobManager({ onJobComplete: () => {} });
	const id = manager.register(
		"task",
		progress.id,
		async ({ reportProgress }) => {
			await reportProgress("running", { progress: [{ ...progress }] });
			reported.resolve();
			return finish.promise;
		},
		{ id: progress.id },
	);
	await reported.promise;
	const session = { asyncJobManager: manager } as unknown as ToolSession;
	const jobs = snapshotJobs(session, manager.getAllJobs());
	const live = isPartial ?? surface === "wait";
	const component = hubToolRenderer.renderResult(
		{
			content: [{ type: "text", text: surface === "wait" ? "" : "Listed background jobs" }],
			details: { op: surface, jobs },
		},
		{
			expanded: false,
			isPartial: live,
		} as Parameters<typeof hubToolRenderer.renderResult>[1],
		theme,
		surface === "wait" ? { op: "wait", ids: [] } : { op: "jobs" },
	);
	const output = Bun.stripANSI((component.render(width) as readonly string[]).join("\n"));
	finish.resolve("done");
	await manager.getJob(id)?.promise;
	return output;
}

describe("job renderer running live activity", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("renders a compact activity sub-row from a detached spawn copy snapshot", async () => {
		const now = 1_700_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);
		const output = await renderRunningCopiedJob(
			makeCopiedProgress({
				id: "AuthLoader",
				currentTool: "read",
				currentToolArgs: "src/auth.ts",
				currentToolStartMs: now - 6_000,
			}),
		);
		expect(output).toContain("AuthLoader");
		expect(output).toMatch(/read: src\/auth\.ts/);
		expect(output).toContain("6.0s");
		const narrow = await renderRunningCopiedJob(
			makeCopiedProgress({
				id: "AuthLoader",
				currentTool: "read",
				currentToolArgs: "src/auth.ts",
				currentToolStartMs: now - 6_000,
			}),
			40,
		);
		expect(narrow).toContain("AuthLoader");
		expect(narrow).toMatch(/read: src\/auth\.ts/);
		expect(narrow).toContain("6.0s");
		for (const line of narrow.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
		}
	});

	it("keeps copied live activity on a live hub wait refresh", async () => {
		const now = 1_700_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);
		const output = await renderRunningCopiedJob(
			makeCopiedProgress({
				id: "AuthLoader",
				currentTool: "read",
				currentToolArgs: "src/auth.ts",
				currentToolStartMs: now - 6_000,
			}),
			120,
			"wait",
		);
		expect(output).toContain("AuthLoader");
		expect(output).toMatch(/read: src\/auth\.ts/);
		expect(output).toContain("6.0s");
		const waitNarrow = await renderRunningCopiedJob(
			makeCopiedProgress({
				id: "AuthLoader",
				currentTool: "read",
				currentToolArgs: "src/auth.ts",
				currentToolStartMs: now - 6_000,
			}),
			40,
			"wait",
		);
		expect(waitNarrow).toContain("AuthLoader");
		expect(waitNarrow).toMatch(/read: src\/auth\.ts/);
		expect(waitNarrow).toContain("6.0s");
		for (const line of waitNarrow.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
		}

		const sealed = await renderRunningCopiedJob(
			makeCopiedProgress({
				id: "AuthLoader",
				currentTool: "read",
				currentToolArgs: "src/auth.ts",
			}),
			120,
			"wait",
			false,
		);
		expect(sealed).not.toContain("AuthLoader");
		expect(sealed).not.toMatch(/read: src\/auth\.ts/);
	});

	it("omits elapsed below 5s and after currentTool is cleared", async () => {
		const now = 1_700_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);
		const shortLived = await renderRunningCopiedJob(
			makeCopiedProgress({
				id: "AuthLoader",
				currentTool: "read",
				currentToolArgs: "src/auth.ts",
				currentToolStartMs: now - 600,
			}),
		);
		expect(shortLived).toMatch(/read: src\/auth\.ts/);
		expect(shortLived).not.toContain("6.0s");
		expect(shortLived).not.toContain("0.6s");

		const afterEnd = await renderRunningCopiedJob(
			makeCopiedProgress({
				id: "AuthLoader",
				recentTools: [{ tool: "grep", args: "password", endMs: now }],
			}),
		);
		const recentLine = afterEnd.split("\n").find(line => line.includes("grep:"));
		expect(recentLine).toBeDefined();
		expect(recentLine).toMatch(/grep: password/);
		expect(recentLine).not.toContain("6.0s");
		expect(recentLine).not.toContain("0ms");
	});

	it("prefers current tool over recent tools and lastIntent over args", async () => {
		const output = await renderRunningCopiedJob(
			makeCopiedProgress({
				id: "AuthLoader",
				lastIntent: "Inspect login",
				currentTool: "read",
				currentToolArgs: "src/auth.ts",
				recentTools: [{ tool: "grep", args: "password", endMs: Date.now() }],
			}),
		);
		expect(output).toMatch(/read: Inspect login/);
		expect(output).not.toContain("password");
		expect(output).not.toContain("src/auth.ts");
		const intentNarrow = await renderRunningCopiedJob(
			makeCopiedProgress({
				id: "AuthLoader",
				lastIntent: "Inspect login",
				currentTool: "read",
				currentToolArgs: "src/auth.ts",
				recentTools: [{ tool: "grep", args: "password", endMs: Date.now() }],
			}),
			40,
		);
		expect(intentNarrow).toMatch(/read: Inspect login/);
		expect(intentNarrow).not.toContain("password");
		expect(intentNarrow).not.toContain("src/auth.ts");
		for (const line of intentNarrow.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
		}
	});

	it("falls back to the most recent completed tool after currentTool is cleared", async () => {
		const output = await renderRunningCopiedJob(
			makeCopiedProgress({
				id: "AuthLoader",
				recentTools: [{ tool: "grep", args: "password", endMs: Date.now() }],
			}),
		);
		expect(output).toMatch(/grep: password/);
		expect(output).not.toContain("stale-args");
	});

	it("sanitizes tabs and home paths and truncates the activity sub-row to width", async () => {
		const homeFile = `${os.homedir()}/secret/${"token-".repeat(20)}.ts`;
		const output = await renderRunningCopiedJob(
			makeCopiedProgress({
				id: "AuthLoader",
				currentTool: "bash",
				currentToolArgs: `\tcat ${homeFile}`,
			}),
			48,
		);
		expect(output).toContain("bash:");
		expect(output).toContain("~/secret/");
		expect(output).not.toContain("\t");
		expect(output).not.toContain(homeFile);
		for (const line of output.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(48);
		}
		const homeNarrow = await renderRunningCopiedJob(
			makeCopiedProgress({
				id: "AuthLoader",
				currentTool: "bash",
				currentToolArgs: `\tcat ${homeFile}`,
			}),
			40,
		);
		expect(homeNarrow).toContain("bash:");
		expect(homeNarrow).toContain("~/secret");
		expect(homeNarrow).not.toContain("\t");
		expect(homeNarrow).not.toContain(homeFile);
		for (const line of homeNarrow.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
		}
	});

	it("truncates a long MCP tool name on the copied hub activity sub-row", async () => {
		const longTool = `mcp__${"very-long-custom-tool-name-".repeat(8)}search`;
		const output = await renderRunningCopiedJob(
			makeCopiedProgress({
				id: "AuthLoader",
				currentTool: longTool,
				currentToolArgs: "src/auth.ts",
			}),
			48,
		);
		const activity = output.split("\n").find(line => /mcp|search|auth/.test(line) && !line.includes("AuthLoader"));
		expect(activity).toBeDefined();
		expect(activity).not.toContain(longTool);
		expect(Bun.stringWidth(activity!)).toBeLessThanOrEqual(48);
	});

	it("keeps running rows without live activity compatible and ignores live activity after settle", async () => {
		const missing = await renderRunningCopiedJob(makeCopiedProgress({ id: "AuthLoader" }));
		expect(missing).toContain("AuthLoader");
		expect(missing).not.toMatch(/\bread\b/);
		expect(missing).not.toMatch(/\bgrep\b/);
		const envelope = prompt.render(taskSummaryTemplate, {
			agentName: "task",
			id: "AuthLoader",
			status: "completed",
			duration: "8.7s",
			preview: "settled body",
			truncated: false,
			mergeSummary: "",
		});
		const component = hubToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "" }],
				details: {
					op: "wait",
					jobs: [
						{
							id: "AuthLoader",
							type: "task",
							status: "completed",
							label: "AuthLoader",
							durationMs: 8_700,
							resultText: envelope,
							liveActivity: { tool: "read", detail: "src/auth.ts" },
						},
					],
				},
			},
			{ expanded: true } as Parameters<typeof hubToolRenderer.renderResult>[1],
			theme,
		);
		const settled = Bun.stripANSI((component.render(120) as readonly string[]).join("\n"));
		expect(settled).toContain("settled body");
		expect(settled).not.toContain("<task-result>");
		expect(settled).not.toMatch(/read: src\/auth\.ts/);
	});

	it("does not draw a live activity sub-row on bash jobs or failed leftovers", () => {
		const bash = hubToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "" }],
				details: {
					op: "jobs",
					jobs: [
						{
							id: "shell-1",
							type: "bash",
							status: "running",
							label: "bun test",
							durationMs: 1_200,
						},
					],
				},
			},
			{ expanded: true, isPartial: false } as Parameters<typeof hubToolRenderer.renderResult>[1],
			theme,
			{ op: "jobs" },
		);
		const bashOut = Bun.stripANSI((bash.render(120) as readonly string[]).join("\n"));
		expect(bashOut).toContain("bun test");
		expect(bashOut).not.toMatch(/\bread\b/);
		const bashNarrow = Bun.stripANSI((bash.render(40) as readonly string[]).join("\n"));
		expect(bashNarrow).toContain("bun test");
		expect(bashNarrow).not.toMatch(/\bread\b/);
		for (const line of bashNarrow.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
		}

		const failed = hubToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "" }],
				details: {
					op: "wait",
					jobs: [
						{
							id: "AuthLoader",
							type: "task",
							status: "failed",
							label: "AuthLoader",
							durationMs: 8_700,
							errorText: "spawn failed: no credentials",
							liveActivity: { tool: "read", detail: "src/auth.ts" },
						},
					],
				},
			},
			{ expanded: true } as Parameters<typeof hubToolRenderer.renderResult>[1],
			theme,
		);
		const failedOut = Bun.stripANSI((failed.render(120) as readonly string[]).join("\n"));
		expect(failedOut).toContain("spawn failed: no credentials");
		expect(failedOut).not.toMatch(/read: src\/auth\.ts/);
		const failedNarrow = Bun.stripANSI((failed.render(40) as readonly string[]).join("\n"));
		expect(failedNarrow).toContain("spawn failed");
		expect(failedNarrow).not.toMatch(/read: src\/auth\.ts/);
		for (const line of failedNarrow.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
		}
	});

	it("keeps copied live activity in TUI details and out of model-facing content", async () => {
		const reported = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<string>();
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const progress = makeCopiedProgress({
			id: "AuthLoader",
			currentTool: "read",
			currentToolArgs: "src/auth.ts",
		});
		const id = manager.register(
			"task",
			progress.id,
			async ({ reportProgress }) => {
				await reportProgress("running", { progress: [{ ...progress }] });
				reported.resolve();
				return finish.promise;
			},
			{ id: progress.id },
		);
		await reported.promise;
		const session = { asyncJobManager: manager } as unknown as ToolSession;
		const result = buildJobResult(session, manager, "jobs", manager.getAllJobs(), []);
		const text = result.content.find(part => part.type === "text")?.text ?? "";
		expect(text).toContain("AuthLoader");
		expect(text).not.toContain("src/auth.ts");
		expect(text).not.toMatch(/\bread\b/);
		expect(result.details?.jobs?.[0]?.liveActivity).toEqual({ tool: "read", detail: "src/auth.ts" });
		finish.resolve("done");
		await manager.getJob(id)?.promise;
	});

	it("omits copied recentOutput from snapshot liveActivity and renderer gist", async () => {
		const output = await renderRunningCopiedJob(
			makeCopiedProgress({
				id: "AuthLoader",
				currentTool: "read",
				currentToolArgs: "src/auth.ts",
				recentOutput: ["thinking about the auth flow", "secret stdout line"],
			}),
		);
		expect(output).toMatch(/read: src\/auth\.ts/);
		expect(output).not.toContain("thinking about the auth flow");
		expect(output).not.toContain("secret stdout line");
		expect(output.split("\n").filter(line => /read: src\/auth\.ts/.test(line))).toHaveLength(1);

		const reported = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<string>();
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const progress = makeCopiedProgress({
			id: "AuthLoader",
			currentTool: "read",
			currentToolArgs: "src/auth.ts",
			recentOutput: ["thinking about the auth flow", "secret stdout line"],
		});
		const id = manager.register(
			"task",
			progress.id,
			async ({ reportProgress }) => {
				await reportProgress("running", { progress: [{ ...progress }] });
				reported.resolve();
				return finish.promise;
			},
			{ id: progress.id },
		);
		await reported.promise;
		const session = { asyncJobManager: manager } as unknown as ToolSession;
		const snapshot = snapshotJobs(session, manager.getAllJobs())[0];
		expect(snapshot?.liveActivity).toEqual({ tool: "read", detail: "src/auth.ts" });
		expect(JSON.stringify(snapshot)).not.toContain("thinking about the auth flow");
		expect(JSON.stringify(snapshot)).not.toContain("secret stdout line");
		finish.resolve("done");
		await manager.getJob(id)?.promise;
	});

	it("marks finished recent tools as last history on hub wait rows", async () => {
		const now = 1_700_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);
		const output = await renderRunningCopiedJob(
			makeCopiedProgress({
				id: "AuthLoader",
				recentTools: [{ tool: "grep", args: "password", endMs: now }],
			}),
		);
		const line = output.split("\n").find(row => row.includes("grep:")) ?? "";
		expect(line).toContain("last grep: password");
	});

	it("shows phase and real silence on a live hub wait refresh", async () => {
		const now = 1_700_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);
		const progress = makeCopiedProgress({ id: "AuthLoader" });
		Object.assign(progress, { activityPhase: "working", lastActivityAtMs: now - 30_000 });
		const output = await renderRunningCopiedJob(progress);
		expect(output).toContain("AuthLoader");
		expect(output).toContain("working");
		expect(output).toContain("30.0s no new events");

		// Narrow: phase + silence survive; no invented tool time or old args.
		const narrow = await renderRunningCopiedJob(progress, 40);
		expect(narrow).toContain("working");
		expect(narrow).toContain("no new events");
		for (const line of narrow.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
		}
	});

	it("surfaces real retry state on hub wait rows ahead of the tool gist", async () => {
		const now = 1_700_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);
		const output = await renderRunningCopiedJob(
			makeCopiedProgress({
				id: "AuthLoader",
				currentTool: "read",
				currentToolStartMs: now - 6_000,
				retryState: {
					attempt: 2,
					maxAttempts: 5,
					delayMs: 45_000,
					errorMessage: "429 rate limited",
					startedAtMs: now,
				},
			}),
		);
		expect(output).toContain("retry 2/5");
		expect(output).toContain("retrying in 45.0s");
		expect(output).not.toMatch(/\bread\b/);
	});

	it("drops live activity once a copied progress snapshot is terminal", async () => {
		const now = 1_700_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);
		const progress = makeCopiedProgress({
			id: "AuthLoader",
			currentTool: "read",
			currentToolArgs: "src/auth.ts",
			currentToolStartMs: now - 6_000,
		});
		progress.status = "completed";
		const output = await renderRunningCopiedJob(progress);
		expect(output).toContain("AuthLoader");
		expect(output).not.toMatch(/read: src\/auth\.ts/);
		expect(output).not.toContain("6.0s");
	});

	it("drops copied live activity from snapshotJobs once the job settles", async () => {
		const reported = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<string>();
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const progress = makeCopiedProgress({
			id: "AuthLoader",
			currentTool: "read",
			currentToolArgs: "src/auth.ts",
		});
		const id = manager.register(
			"task",
			progress.id,
			async ({ reportProgress }) => {
				await reportProgress("running", { progress: [{ ...progress }] });
				reported.resolve();
				return finish.promise;
			},
			{ id: progress.id },
		);
		await reported.promise;
		const session = { asyncJobManager: manager } as unknown as ToolSession;
		manager.watchJobs([id]);
		expect(snapshotJobs(session, manager.getAllJobs())[0]?.liveActivity).toEqual({
			tool: "read",
			detail: "src/auth.ts",
		});
		finish.resolve("settled body");
		await manager.getJob(id)?.promise;
		const settled = snapshotJobs(session, manager.getAllJobs());
		expect(settled[0]?.status).toBe("completed");
		expect(settled[0]?.liveActivity).toBeUndefined();
		expect(settled[0]?.resultText).toBe("settled body");
		const component = hubToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "" }],
				details: { op: "wait", jobs: settled },
			},
			{ expanded: true } as Parameters<typeof hubToolRenderer.renderResult>[1],
			theme,
		);
		const output = Bun.stripANSI((component.render(120) as readonly string[]).join("\n"));
		expect(output).toContain("settled body");
		expect(output).not.toMatch(/read: src\/auth\.ts/);
		const narrow = Bun.stripANSI((component.render(40) as readonly string[]).join("\n"));
		expect(narrow).toContain("settled body");
		expect(narrow).not.toMatch(/read: src\/auth\.ts/);
		for (const line of narrow.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
		}
	});
});
