/**
 * Thin CLI adapter for the fixed-task workflow optimization benchmark suite.
 * Uses the public runBenchmarkSuite entrypoint with the fake runtime smoke path.
 * Does not edit production profiles or open a UI.
 */

import {
	buildDefaultBenchmarkSuite,
	buildScorecard,
	createFakeBenchmarkRuntime,
	evaluateBenchmarkQualityGate,
	runBenchmarkSuite,
} from "../workflow/benchmark";

export interface WorkflowBenchCommandArgs {
	flags: {
		json?: boolean;
		reps?: number;
	};
}

/**
 * Run the default benchmark suite (baseline vs optimized, fake runtime).
 * Exit code 0 when quality gate passes; 1 otherwise.
 */
export async function runWorkflowBenchCommand(args: WorkflowBenchCommandArgs): Promise<void> {
	const suite = buildDefaultBenchmarkSuite();
	const minRepetitions = args.flags.reps && args.flags.reps > 0 ? args.flags.reps : undefined;
	const results = await runBenchmarkSuite({
		suite,
		runtime: createFakeBenchmarkRuntime(),
		optimizedProfileId: "grok_implementer",
		optimizedStrategyFingerprint: "workflow-bench-cli",
		minRepetitions,
	});
	const scorecard = buildScorecard(suite, results);
	const gate = evaluateBenchmarkQualityGate(scorecard);

	if (args.flags.json) {
		process.stdout.write(
			`${JSON.stringify(
				{
					suiteId: suite.id,
					caseCount: suite.cases.length,
					resultCount: results.length,
					scorecard,
					gate,
				},
				null,
				2,
			)}\n`,
		);
	} else {
		process.stdout.write(
			`${[
				`workflow-bench suite=${suite.id} cases=${suite.cases.length} results=${results.length}`,
				`gate.passed=${gate.passed} liveQualityUnknown=${scorecard.liveQualityUnknown}`,
				`summaries=${scorecard.summaries.length}`,
			].join("\n")}\n`,
		);
	}

	if (!gate.passed) {
		process.exitCode = 1;
	}
}
