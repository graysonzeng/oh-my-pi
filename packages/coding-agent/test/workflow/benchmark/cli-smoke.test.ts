import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runWorkflowBenchCommand, type WorkflowBenchCommandResult } from "../../../src/cli/workflow-bench-cli";
import WorkflowBench from "../../../src/commands/workflow-bench";

describe("workflow-bench CLI adapter", () => {
	const originalStdoutWrite = process.stdout.write.bind(process.stdout);
	let captured = "";

	function captureStdout(): void {
		captured = "";
		process.stdout.write = ((chunk: string | Uint8Array, ..._rest: unknown[]) => {
			captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
			return true;
		}) as typeof process.stdout.write;
	}

	afterEach(() => {
		process.stdout.write = originalStdoutWrite;
	});

	it("supports suite/case/variant/repetitions and writes report files; marks live quality unknown", async () => {
		const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-bench-"));
		captureStdout();
		try {
			const result = await runWorkflowBenchCommand({
				flags: {
					json: true,
					suite: "default",
					case: "bugfix-null-deref,bugfix-off-by-one",
					variant: "both",
					repetitions: 3,
					output: outDir,
				},
			});
			expect(result.exitCode).toBe(0);
		} finally {
			process.stdout.write = originalStdoutWrite;
		}

		const payload = JSON.parse(captured) as {
			caseCount: number;
			resultCount: number;
			liveQualityUnknown: boolean;
			scorecard: { liveQualityUnknown: boolean; notes: string[] };
			gate: { passed: boolean };
		};
		expect(payload.caseCount).toBe(2);
		// 2 cases × 2 variants × explicit --repetitions=3
		expect(payload.resultCount).toBe(12);
		expect(payload.liveQualityUnknown).toBe(true);
		expect(payload.scorecard.liveQualityUnknown).toBe(true);
		expect(payload.scorecard.notes.some(n => /live quality unknown/i.test(n))).toBe(true);
		expect(payload.gate.passed).toBe(true);

		const scorecardText = await Bun.file(path.join(outDir, "scorecard.json")).text();
		const md = await Bun.file(path.join(outDir, "compare-report.md")).text();
		const gateText = await Bun.file(path.join(outDir, "gate.json")).text();
		expect(scorecardText).toContain("liveQualityUnknown");
		expect(md).toContain("## Quality");
		expect(md).toContain("live quality unknown");
		expect(JSON.parse(gateText).passed).toBe(true);

		await fs.rm(outDir, { recursive: true, force: true });
	});

	it("wires presentation experiment and its single active lever into report fingerprints", async () => {
		captureStdout();
		let result: WorkflowBenchCommandResult | undefined;
		try {
			result = await runWorkflowBenchCommand({
				flags: {
					json: true,
					case: "simple-bug-fix",
					variant: "both",
					repetitions: 1,
					experiment: "presentation",
				},
			});
		} finally {
			process.stdout.write = originalStdoutWrite;
		}
		expect(result!.report.experiment).toBe("presentation");
		expect(result!.report.activeLever).toBe("workflow.presentationOptimization.enabled");
		expect(
			result!.report.scorecard.summaries.every(summary =>
				summary.runs.every(run => run.fingerprint.experiment === "presentation"),
			),
		).toBe(true);
		expect(captured).toContain('"experiment": "presentation"');
		expect(captured).toContain('"activeLever": "workflow.presentationOptimization.enabled"');
	});

	it("fails fast for an unknown CLI experiment", async () => {
		await expect(
			runWorkflowBenchCommand({ flags: { case: "simple-bug-fix", experiment: "not-an-experiment" } }),
		).rejects.toThrow(/Invalid --experiment=not-an-experiment/);
	});

	it("filters to a single variant and marks gate inconclusive", async () => {
		captureStdout();
		try {
			const result = await runWorkflowBenchCommand({
				flags: {
					json: true,
					case: "simple-bug-fix",
					variant: "baseline",
					reps: 1,
				},
			});
			expect(result.exitCode).toBe(0);
		} finally {
			process.stdout.write = originalStdoutWrite;
		}
		const payload = JSON.parse(captured) as {
			resultCount: number;
			scorecard: { summaries: unknown[]; notes: string[] };
			gate: { passed: boolean; reasons: string[] };
		};
		// 1 case × 1 variant × explicit --reps=1
		expect(payload.resultCount).toBe(1);
		expect(payload.scorecard.summaries.length).toBe(1);
		expect(payload.gate.passed).toBe(false);
		expect(payload.gate.reasons.some(r => /inconclusive/.test(r))).toBe(true);
		expect(payload.scorecard.notes.some(n => /fake-runtime smoke/i.test(n))).toBe(true);
	});

	it("marks quality as live only when a live runtime is explicitly injected", async () => {
		captureStdout();
		try {
			const result = await runWorkflowBenchCommand(
				{
					flags: {
						json: true,
						mode: "live",
						provider: "fixture-provider",
						model: "fixture-model",
						reviewerProvider: "fixture-reviewer-provider",
						reviewerModel: "fixture-reviewer-model",
						case: "simple-bug-fix",
						variant: "baseline",
					},
				},
				{
					liveRuntime: async () => ({
						passed: true,
						firstPassed: true,
						qualityScore: 1,
						scopeStatus: "adhered",
					}),
				},
			);
			expect(result.exitCode).toBe(0);
			expect(result.report.liveQualityUnknown).toBe(false);
			expect(result.report.scorecard.summaries[0]?.runs[0]?.fingerprint).toMatchObject({
				provider: "fixture-provider",
				model: "fixture-model",
			});
			expect(result.report.scorecard.summaries[0]?.runs[0]?.fingerprint.roleIdentityMap).toEqual({
				planner: { provider: "fixture-provider", model: "fixture-model" },
				plan_reviewer: { provider: "fixture-reviewer-provider", model: "fixture-reviewer-model" },
				plan_arbitrator: { provider: "fixture-reviewer-provider", model: "fixture-reviewer-model" },
				implementer: { provider: "fixture-provider", model: "fixture-model" },
				code_reviewer: { provider: "fixture-reviewer-provider", model: "fixture-reviewer-model" },
				repair: { provider: "fixture-provider", model: "fixture-model" },
			});
		} finally {
			process.stdout.write = originalStdoutWrite;
		}
		const payload = JSON.parse(captured) as { liveQualityUnknown: boolean };
		expect(payload.liveQualityUnknown).toBe(false);
	});

	it("fails live runs before repetitions when reviewer model is missing or same-family", async () => {
		await expect(
			runWorkflowBenchCommand(
				{ flags: { mode: "live", provider: "gateway", model: "gpt-5.6-luna" } },
				{ liveRuntime: async () => ({ passed: true }) },
			),
		).rejects.toThrow(/explicit --provider, --model, and --reviewer-model/);
		await expect(
			runWorkflowBenchCommand(
				{
					flags: {
						mode: "live",
						provider: "gateway",
						model: "gpt-5.6-luna",
						reviewerModel: "gpt-5.6-sol",
					},
				},
				{ liveRuntime: async () => ({ passed: true }) },
			),
		).rejects.toThrow(/reviewer model family must differ/);
	});

	it("declares reviewer provider and model live flags", () => {
		expect(Object.hasOwn(WorkflowBench.flags, "reviewer-provider")).toBe(true);
		expect(Object.hasOwn(WorkflowBench.flags, "reviewer-model")).toBe(true);
	});
});
