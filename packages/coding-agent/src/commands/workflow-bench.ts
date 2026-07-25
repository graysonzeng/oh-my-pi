import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { runWorkflowBenchCommand } from "../cli/workflow-bench-cli";

export default class WorkflowBench extends Command {
	static description =
		"Run the fixed-task workflow optimization benchmark suite (baseline vs optimized, fake runtime smoke)";

	static flags = {
		json: Flags.boolean({ description: "Machine-readable scorecard JSON" }),
		reps: Flags.integer({ description: "Override min repetitions per case (still ≥ suite defaults when higher)" }),
	};

	static examples = [
		"# Run default suite with fake runtime\n  omp workflow-bench",
		"# JSON scorecard\n  omp workflow-bench --json",
	];

	async run(): Promise<void> {
		const { flags } = await this.parse(WorkflowBench);
		await runWorkflowBenchCommand({
			flags: {
				json: flags.json,
				reps: flags.reps,
			},
		});
	}
}
