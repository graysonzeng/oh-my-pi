import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runWorkflowBenchCommand } from "../../../src/cli/workflow-bench-cli";

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
		// 2 cases × 2 variants × 3 reps
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
		// 1 case × 1 variant × max(case.reps=3, min=1) = 3
		expect(payload.resultCount).toBe(3);
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
		} finally {
			process.stdout.write = originalStdoutWrite;
		}
		const payload = JSON.parse(captured) as { liveQualityUnknown: boolean };
		expect(payload.liveQualityUnknown).toBe(false);
	});
});
