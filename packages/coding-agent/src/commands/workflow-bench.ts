import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { runWorkflowBenchCommand } from "../cli/workflow-bench-cli";
import { createLiveWorkflowBenchmarkRuntime } from "../workflow/benchmark/live-runtime";

export default class WorkflowBench extends Command {
	static description =
		"Run the fixed-task workflow optimization benchmark suite (baseline vs optimized, fake runtime smoke)";

	static flags = {
		mode: Flags.string({ description: "fake (default) | live (credentialed workflow run)" }),
		provider: Flags.string({ description: "Live mode provider id (required with --mode live)" }),
		"reviewer-provider": Flags.string({
			description: "Live mode reviewer provider id (defaults to --provider)",
		}),
		"reviewer-model": Flags.string({
			description: "Live mode reviewer model id (required; must be a different model family)",
		}),
		model: Flags.string({ description: "Live mode model id (required with --mode live)" }),
		json: Flags.boolean({ description: "Machine-readable scorecard JSON" }),
		reps: Flags.integer({
			description: "Override min repetitions per case (still ≥ suite defaults when higher)",
		}),
		repetitions: Flags.integer({
			description: "Alias for --reps: min repetitions per case",
		}),
		suite: Flags.string({
			description: "Suite id (default: per-model-opt-default)",
		}),
		case: Flags.string({
			description: "Comma-separated case ids to run (default: all)",
		}),
		variant: Flags.string({
			description: "baseline | optimized | both (default: both)",
		}),
		experiment: Flags.string({
			description: "Experiment: profile-strategy (default) | presentation",
		}),
		output: Flags.string({
			char: "o",
			description: "Directory to write scorecard.json, compare-report.md, gate.json",
		}),
	};

	static examples = [
		"# Run default suite with fake runtime\n  omp workflow-bench",
		"# JSON scorecard\n  omp workflow-bench --json",
		"# One case, 3 reps, write reports\n  omp workflow-bench --case=bugfix-null-deref --repetitions=3 --output=./bench-out",
		"# Optimized only\n  omp workflow-bench --variant=optimized --json",
	];

	async run(): Promise<void> {
		const { flags } = await this.parse(WorkflowBench);
		const mode = flags.mode?.trim().toLowerCase() || "fake";
		if (mode === "live" && (!flags.provider || !flags.model || !flags["reviewer-model"])) {
			throw new Error("--mode live requires explicit --provider, --model, and --reviewer-model flags");
		}
		const liveRuntime =
			mode === "live"
				? createLiveWorkflowBenchmarkRuntime({
						provider: flags.provider!,
						model: flags.model!,
						reviewerProvider: flags["reviewer-provider"],
						reviewerModel: flags["reviewer-model"]!,
					})
				: undefined;
		const result = await runWorkflowBenchCommand(
			{
				flags: {
					mode: flags.mode,
					provider: flags.provider,
					reviewerProvider: flags["reviewer-provider"],
					reviewerModel: flags["reviewer-model"],
					model: flags.model,
					json: flags.json,
					reps: flags.reps,
					repetitions: flags.repetitions,
					suite: flags.suite,
					case: flags.case,
					variant: flags.variant,
					experiment: flags.experiment,
					output: flags.output,
				},
			},
			{ liveRuntime },
		);
		if (result.exitCode !== 0) process.exitCode = result.exitCode;
	}
}
