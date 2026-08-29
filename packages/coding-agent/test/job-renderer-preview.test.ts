/**
 * The job tool's TUI preview must not leak the model-facing `<task-result>`
 * envelope (prompts/tools/task-summary.md): a settled task job previews the
 * inner <output>/<preview> body, while non-envelope result text (bash jobs)
 * passes through unchanged.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as os from "node:os";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { copySpawnJobLiveProgress, type AgentProgress } from "@oh-my-pi/pi-coding-agent/task";
import { prompt } from "@oh-my-pi/pi-utils";
import { AsyncJobManager } from "../src/async/job-manager";
import taskSummaryTemplate from "../src/prompts/tools/task-summary.md" with { type: "text" };
import type { ToolSession } from "../src/tools";
import { hubToolRenderer } from "../src/tools/hub";
import { snapshotJobs } from "../src/tools/hub/jobs";

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

async function renderRunningCopiedJob(progress: AgentProgress, width = 120): Promise<string> {
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
	const component = hubToolRenderer.renderResult(
		{
			content: [{ type: "text", text: "Listed background jobs" }],
			details: { op: "jobs", jobs: snapshotJobs(session, manager.getAllJobs()) },
		},
		{ expanded: false, isPartial: false } as Parameters<typeof hubToolRenderer.renderResult>[1],
		theme,
		{ op: "jobs" },
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

	it("renders a compact activity sub-row from a detached spawn copy snapshot", async () => {
		const output = await renderRunningCopiedJob(
			makeCopiedProgress({
				id: "AuthLoader",
				currentTool: "read",
				currentToolArgs: "src/auth.ts",
			}),
		);
		expect(output).toContain("AuthLoader");
		expect(output).toMatch(/read: src\/auth\.ts/);
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
				currentTool: "read",
				currentToolArgs: `\t${homeFile}`,
			}),
			48,
		);
		expect(output).toContain("read:");
		expect(output).toContain("~/secret/");
		expect(output).not.toContain("\t");
		expect(output).not.toContain(homeFile);
		for (const line of output.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(48);
		}
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
});

