import type { SingleResult } from "../task/types";
import type { ToolSession } from "../tools";
import type { WorkflowAgentRequest, WorkflowIsolationControls } from "./types";

/** Minimal isolation context needed by CLI write adapters. */
export interface CliIsolationContext {
	repoRoot: string;
	baseline: unknown;
}

export interface CliIsolatedRunOptions {
	context: CliIsolationContext;
	preferredBackend: unknown;
	agentId: string;
	mergeMode: "patch" | "branch";
	artifactsDir: string;
	buildCommitMessage?: () => undefined | ((diff: string) => Promise<string | null>);
	buildFailureResult: (err: unknown) => SingleResult;
	run: (worktree: string) => Promise<SingleResult>;
}

export interface CliIsolationMergeOutcome {
	summary: string;
	changesApplied: boolean | null;
	hadAnyChanges: boolean;
	mergedBranchForNestedPatches: boolean;
}

/**
 * Injectable isolation surface so CLI runtime modules stay free of pi-natives
 * at import time (unit tests use fakes; production wires task/isolation-runner).
 */
export interface CliIsolationDeps {
	prepareIsolationContext: (cwd: string) => Promise<CliIsolationContext>;
	runIsolatedExecution: (opts: CliIsolatedRunOptions) => Promise<SingleResult>;
	mergeIsolatedChanges: (opts: {
		result: SingleResult;
		repoRoot: string;
		mergeMode: "patch" | "branch";
	}) => Promise<CliIsolationMergeOutcome>;
	applyEligibleNestedPatches: (opts: {
		result: SingleResult;
		repoRoot: string;
		mergeMode: "patch" | "branch";
		changesApplied: boolean | null;
		mergedBranchForNestedPatches: boolean;
		commitMessage?: (diff: string) => Promise<string | null>;
	}) => Promise<string>;
	makeIsolationCommitMessage: (session: ToolSession) => () => undefined | ((diff: string) => Promise<string | null>);
	parseIsolationMode: (mode: string | undefined) => unknown;
}

export type CliWriteIsolationControls = WorkflowIsolationControls;

export interface CliWriteRunArgs {
	request: WorkflowAgentRequest;
	isolation: CliWriteIsolationControls | undefined;
	isolationRequested: boolean;
	runInWorktree: (worktree: string) => Promise<SingleResult>;
	buildFailureResult: (err: unknown) => SingleResult;
	artifactsDir: string;
}
