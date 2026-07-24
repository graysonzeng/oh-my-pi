/**
 * Production isolation wiring for CLI runtimes.
 * Imports task isolation (and thus pi-natives) — keep out of pure unit tests.
 */
import {
	applyEligibleNestedPatches,
	type IsolationContext,
	makeIsolationCommitMessage,
	mergeIsolatedChanges,
	prepareIsolationContext,
	runIsolatedExecution,
} from "../task/isolation-runner";
import type { TaskIsolationMode } from "../task/worktree";
import { parseIsolationMode } from "../task/worktree";
import type { CliIsolatedRunOptions, CliIsolationDeps } from "./cli-isolation";

export function createProductionCliIsolationDeps(): CliIsolationDeps {
	return {
		prepareIsolationContext,
		runIsolatedExecution: (opts: CliIsolatedRunOptions) =>
			runIsolatedExecution({
				context: opts.context as IsolationContext,
				preferredBackend: opts.preferredBackend as undefined,
				agentId: opts.agentId,
				mergeMode: opts.mergeMode,
				artifactsDir: opts.artifactsDir,
				buildCommitMessage: opts.buildCommitMessage,
				buildFailureResult: opts.buildFailureResult,
				run: opts.run,
			}),
		mergeIsolatedChanges,
		applyEligibleNestedPatches,
		makeIsolationCommitMessage,
		parseIsolationMode: (mode: string | undefined) =>
			parseIsolationMode((mode as TaskIsolationMode | undefined) ?? "auto"),
	};
}
