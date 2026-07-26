/**
 * Thin CLI adapter for the fixed-task workflow optimization benchmark suite.
 * Uses the public runBenchmarkSuite entrypoint with the fake runtime smoke path.
 * Does not edit production profiles or open a UI.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type BenchmarkReport,
	type BenchmarkRuntime,
	type BenchmarkSuite,
	type BenchmarkVariantKind,
	buildBenchmarkReport,
	buildDefaultBenchmarkSuite,
	createFakeBenchmarkRuntime,
	renderBenchmarkReportMarkdown,
	runBenchmarkSuite,
} from "../workflow/benchmark";

export interface WorkflowBenchCommandArgs {
	flags: {
		/** fake (default) or live. */
		mode?: string;
		provider?: string;
		model?: string;
		json?: boolean;
		/** Override min repetitions (alias: reps). */
		repetitions?: number;
		/** Legacy alias for repetitions. */
		reps?: number;
		/** Suite id (currently only default is registered). */
		suite?: string;
		/** Comma-separated case ids to run. */
		case?: string;
		/** baseline | optimized | both (default both). */
		variant?: string;
		/** Directory to write scorecard.json + compare-report.md. */
		output?: string;
	};
}

export interface WorkflowBenchCommandDependencies {
	liveRuntime?: BenchmarkRuntime;
}

export interface WorkflowBenchCommandResult {
	exitCode: 0 | 1;
	report: BenchmarkReport;
}

const CASE_ALIASES: Readonly<Record<string, string>> = {
	"simple-bug-fix": "bugfix-null-deref",
};

function selectSuite(suiteId: string | undefined): BenchmarkSuite {
	const suite = buildDefaultBenchmarkSuite();
	if (!suiteId || suiteId === suite.id || suiteId === "default") {
		return suite;
	}
	throw new Error(`Unknown suite "${suiteId}". Available: default, ${suite.id}`);
}

function filterCases(suite: BenchmarkSuite, caseFilter: string | undefined): BenchmarkSuite {
	if (!caseFilter || caseFilter.trim() === "") return suite;
	const wanted = new Set(
		caseFilter
			.split(",")
			.map(s => s.trim())
			.map(id => CASE_ALIASES[id] ?? id)
			.filter(Boolean),
	);
	const cases = suite.cases.filter(c => wanted.has(c.id));
	if (cases.length === 0) {
		const available = suite.cases.map(c => c.id).join(", ");
		throw new Error(`No cases matched --case=${caseFilter}. Available: ${available}`);
	}
	return { ...suite, cases };
}

function parseVariants(raw: string | undefined): BenchmarkVariantKind[] {
	if (!raw || raw === "both" || raw === "all") {
		return ["baseline", "optimized"];
	}
	const v = raw.trim().toLowerCase();
	if (v === "baseline" || v === "optimized") {
		return [v];
	}
	throw new Error(`Invalid --variant=${raw}. Use baseline, optimized, or both.`);
}

/**
 * Run the default benchmark suite (baseline vs optimized, fake runtime).
 * Exit code 0 when quality gate passes; 1 otherwise.
 */
export async function runWorkflowBenchCommand(
	args: WorkflowBenchCommandArgs,
	dependencies: WorkflowBenchCommandDependencies = {},
): Promise<WorkflowBenchCommandResult> {
	let suite = selectSuite(args.flags.suite);
	suite = filterCases(suite, args.flags.case);
	const variants = parseVariants(args.flags.variant);
	const repsFlag = args.flags.repetitions ?? args.flags.reps;
	const minRepetitions = repsFlag && repsFlag > 0 ? repsFlag : undefined;

	const mode = args.flags.mode?.trim().toLowerCase() || "fake";
	if (mode !== "fake" && mode !== "live") throw new Error(`Invalid --mode=${args.flags.mode}. Use fake or live.`);
	if (mode === "live" && !dependencies.liveRuntime) {
		throw new Error("Live benchmark runtime was not configured at the command boundary");
	}
	const liveQualityUnknown = mode !== "live";
	const results = await runBenchmarkSuite({
		suite,
		runtime: mode === "live" ? dependencies.liveRuntime! : createFakeBenchmarkRuntime(),
		variants,
		optimizedProfileId: "grok_implementer",
		optimizedStrategyFingerprint: "workflow-bench-cli",
		minRepetitions,
		liveQualityUnknown,
	});
	const report = buildBenchmarkReport(suite, results, {
		liveQualityUnknown,
		notes:
			mode === "live"
				? [
						`Live workflow benchmark used explicit provider/model ${args.flags.provider}/${args.flags.model}.`,
						"Fixture verificationCommands and git diff scope were executed.",
					]
				: [
						"CLI path uses fake-runtime smoke only (no live agent, no real repo clone, verificationCommands not executed).",
						"Case descriptors are fixed metadata for paired measurement; live quality unknown.",
					],
	});
	const markdown = renderBenchmarkReportMarkdown(report);

	const outDir = args.flags.output;
	if (outDir) {
		await fs.mkdir(outDir, { recursive: true });
		const scorecardPath = path.join(outDir, "scorecard.json");
		const reportPath = path.join(outDir, "compare-report.md");
		const gatePath = path.join(outDir, "gate.json");
		await Bun.write(scorecardPath, `${JSON.stringify(report.scorecard, null, 2)}\n`);
		await Bun.write(reportPath, markdown);
		await Bun.write(gatePath, `${JSON.stringify(report.gate, null, 2)}\n`);
		await Bun.write(path.join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
	}

	if (args.flags.json) {
		process.stdout.write(
			`${JSON.stringify(
				{
					suiteId: suite.id,
					suiteVersion: suite.suiteVersion,
					caseCount: suite.cases.length,
					resultCount: results.length,
					liveQualityUnknown: report.liveQualityUnknown,
					scorecard: report.scorecard,
					gate: report.gate,
					comparisonRowCount: report.comparison.length,
					outputDir: outDir ?? null,
				},
				null,
				2,
			)}\n`,
		);
	} else {
		const header = [
			`workflow-bench suite=${suite.id} version=${suite.suiteVersion} cases=${suite.cases.length} results=${results.length}`,
			`mode=${mode === "live" ? "live-workflow" : "fake-runtime-smoke (not live agent quality)"}`,
			`gate.passed=${report.gate.passed} liveQualityUnknown=${report.liveQualityUnknown}`,
			`summaries=${report.scorecard.summaries.length}`,
			report.liveQualityUnknown ? "live quality unknown" : "live quality measured",
			outDir ? `wrote reports under ${outDir}` : "no --output dir (stdout summary only)",
		].join("\n");
		process.stdout.write(`${header}\n\n${markdown}\n`);
	}

	// A single-variant run is a measurement, not a paired quality gate. The report
	// remains explicitly inconclusive, while the command succeeds if execution did.
	return { exitCode: variants.length === 1 || report.gate.passed ? 0 : 1, report };
}
