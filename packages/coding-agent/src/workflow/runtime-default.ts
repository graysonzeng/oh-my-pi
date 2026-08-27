/**
 * Production wiring for the embedded workflow runtime.
 * Multi-model is via provider models + ModelProfile strategies, not vendor CLIs.
 * Pure unit tests may import this file with an injected embeddedRunner.
 * Do not touch worker host / __omp_worker_* paths — those stay independent.
 */
import * as path from "node:path";
import { mergeIsolatedChanges } from "../task/isolation-runner";
import { runStructuredSubagent } from "../task/structured-subagent";
import type { SingleResult } from "../task/types";
import { defaultWorkflowArtifactDir } from "./artifact-store";
import { EmbeddedWorkflowAvailabilityPort } from "./availability-adapter";
import { WorkflowCancelledError } from "./errors";
import { RuntimeAdapter, type StructuredRunner, type StructuredRunnerRequest } from "./runtime-adapter";
import type { CapturedChangesMerger, WorkflowAvailabilityPort } from "./types";

async function preservePatchArtifact(
	patchPath: string | undefined,
	workflowId: string,
	attemptId: string,
): Promise<string | undefined> {
	if (!patchPath) return undefined;
	try {
		const text = await Bun.file(patchPath).text();
		const destDir = path.join(defaultWorkflowArtifactDir(), workflowId, "patches");
		// Unique name per invocation so schema retries / profile fallbacks do not overwrite recovery patches.
		const dest = path.join(destDir, `${attemptId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.patch`);
		await Bun.write(dest, text);
		return dest;
	} catch {
		return patchPath;
	}
}

/**
 * Forward workflow tool-optimization fields onto the child session, preserving
 * catalog presentation maps (schemas / allowlist / skill bodies) that the
 * model wire stubs and the read tool's xd:// expand depend on. Exporting the
 * pure merge keeps the production runner thin and unit-testable.
 */
export function prepareWorkflowRunnerSession(
	session: StructuredRunnerRequest["session"],
): StructuredRunnerRequest["session"] {
	const baseOpt = session.workflowToolOptimization;
	return {
		...session,
		workflowToolOptimization: {
			processResult: baseOpt?.processResult ?? ((_t, o) => o),
			toolAliases: baseOpt?.toolAliases,
			argumentAliases: baseOpt?.argumentAliases,
			maxConcurrentTools: baseOpt?.maxConcurrentTools,
			remainingToolCalls: baseOpt?.remainingToolCalls,
			remainingStageTimeMs: baseOpt?.remainingStageTimeMs,
			resourceConflictMode: baseOpt?.resourceConflictMode,
			transformTools: baseOpt?.transformTools,
			optimizationReceipts: baseOpt?.optimizationReceipts,
			lastOptimizationReceipt: baseOpt?.lastOptimizationReceipt,
			// Catalog presentation maps must survive the child handoff or the
			// advertised xd://tools/{name} / xd://skills/{name} locators cannot resolve.
			presentationAllowedTools: baseOpt?.presentationAllowedTools,
			presentationToolSchemas: baseOpt?.presentationToolSchemas,
			presentationSkillBodies: baseOpt?.presentationSkillBodies,
		},
	};
}

const productionRunner: StructuredRunner = async (request: StructuredRunnerRequest) => {
	const isolationRequested = request.isolation?.requested === true;
	// Ensure processToolResult + transformTools from prepare land on the live session
	// before createTools / agent loop consume them.
	const session =
		request.processToolResult || request.transformTools
			? prepareWorkflowRunnerSession(request.session)
			: request.session;

	// Argument/tool aliases + catalog transform: prepareWorkflowInvocation installs
	// session.workflowToolOptimization; createTools applies
	// wrapAgentToolWithWorkflowAliases and applyWorkflowTransformTools so model-facing
	// parameters use wire names and catalog mode drops non-essential schemas.
	const result = await runStructuredSubagent({
		session,
		invocationKind: request.invocationKind,
		assignment: request.assignment,
		context: request.context,
		agent: request.agent,
		model: request.model,
		thinkingLevel: request.thinkingLevel,
		outputSchema: request.outputSchema,
		schemaMode: request.schemaMode,
		isolation: request.isolation,
		maxRuntimeMs: request.maxRuntimeMs,
		signal: request.signal,
		retainArtifacts: isolationRequested || request.retainArtifacts === true,
		allowedTools: request.allowedTools,
		onResponse: request.onResponse,
		strictModelIdentity: request.strictModelIdentity,
	});

	let patchPath = result.result.patchPath;
	if (isolationRequested && patchPath && request.workflowId && request.attemptId) {
		patchPath = (await preservePatchArtifact(patchPath, request.workflowId, request.attemptId)) ?? patchPath;
	}

	return {
		result: {
			id: result.result.id,
			structuredOutput: result.result.structuredOutput,
			// Expose raw model text for deterministic schema repair on the adapter path.
			rawOutput: result.result.output,
			patchPath,
			branchName: result.result.branchName,
			usage: result.result.usage,
			exitCode: result.result.exitCode,
			error: result.result.error,
			aborted: result.result.aborted,
			abortReason: result.result.abortReason,
			resolvedModel: result.result.resolvedModel,
			toolCalls: result.result.toolCalls,
			completionKind: result.result.completionKind,
		},
		changesApplied: result.changesApplied,
		mergeSummary: result.mergeSummary,
	};
};

const productionCapturedChangesMerger: CapturedChangesMerger = async request => {
	if (request.signal?.aborted) {
		throw new WorkflowCancelledError("Captured changes merge cancelled");
	}

	const patchTexts: string[] = [];
	for (const patch of request.patches) {
		if (request.signal?.aborted) {
			throw new WorkflowCancelledError("Captured changes merge cancelled");
		}
		const text = await Bun.file(patch.patchPath).text();
		patchTexts.push(text.length === 0 || text.endsWith("\n") ? text : `${text}\n`);
	}

	if (request.signal?.aborted) {
		throw new WorkflowCancelledError("Captured changes merge cancelled");
	}
	await Bun.write(request.outputPatchPath, patchTexts.join(""));

	if (request.signal?.aborted) {
		throw new WorkflowCancelledError("Captured changes merge cancelled");
	}
	const result: SingleResult = {
		index: 0,
		id: `${request.workflowId}:${request.attemptId}`,
		agent: "workflow",
		agentSource: "bundled",
		task: "Merge captured workflow changes",
		exitCode: 0,
		output: "",
		stderr: "",
		truncated: false,
		durationMs: 0,
		tokens: 0,
		requests: 0,
		patchPath: request.outputPatchPath,
		completionKind: "completed",
	};
	const outcome = await mergeIsolatedChanges({
		result,
		repoRoot: request.cwd,
		mergeMode: "patch",
	});
	return {
		patchPath: request.outputPatchPath,
		changesApplied: outcome.changesApplied === true,
		summary: outcome.summary,
	};
};

export interface DefaultRuntimeDependencies {
	/** Override for tests; production uses runStructuredSubagent. */
	embeddedRunner?: StructuredRunner;
	/** Override the atomic captured-change merge seam in tests. */
	mergeCapturedChanges?: CapturedChangesMerger;
}

/** Embedded multi-model runtime (RuntimeAdapter → structured-subagent). */
export function createDefaultRuntimeAdapter(dependencies: DefaultRuntimeDependencies = {}): RuntimeAdapter {
	const embeddedRunner = dependencies.embeddedRunner ?? productionRunner;
	return new RuntimeAdapter(embeddedRunner, dependencies.mergeCapturedChanges ?? productionCapturedChangesMerger);
}

/**
 * Dedicated availability probe port (not RuntimePort.run).
 * Shares the same embedded runner as the production adapter.
 */
export function createDefaultAvailabilityPort(
	_dependencies: DefaultRuntimeDependencies = {},
): WorkflowAvailabilityPort {
	return new EmbeddedWorkflowAvailabilityPort();
}
