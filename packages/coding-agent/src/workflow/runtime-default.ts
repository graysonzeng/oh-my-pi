/**
 * Production wiring for the embedded workflow runtime.
 * Multi-model is via provider models + ModelProfile strategies, not vendor CLIs.
 * Pure unit tests may import this file with an injected embeddedRunner.
 * Do not touch worker host / __omp_worker_* paths — those stay independent.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runStructuredSubagent } from "../task/structured-subagent";
import { defaultWorkflowArtifactDir } from "./artifact-store";
import { RuntimeAdapter, type StructuredRunner, type StructuredRunnerRequest } from "./runtime-adapter";

async function preservePatchArtifact(
	patchPath: string | undefined,
	workflowId: string,
	attemptId: string,
): Promise<string | undefined> {
	if (!patchPath) return undefined;
	try {
		const text = await Bun.file(patchPath).text();
		const destDir = path.join(defaultWorkflowArtifactDir(), workflowId, "patches");
		await fs.mkdir(destDir, { recursive: true });
		const dest = path.join(destDir, `${attemptId}.patch`);
		await Bun.write(dest, text);
		return dest;
	} catch {
		return patchPath;
	}
}

const productionRunner: StructuredRunner = async (request: StructuredRunnerRequest) => {
	const isolationRequested = request.isolation?.requested === true;
	// Ensure processToolResult + transformTools from prepare land on the live session
	// before createTools / agent loop consume them.
	const baseOpt = request.session.workflowToolOptimization;
	const session =
		request.processToolResult || request.transformTools
			? {
					...request.session,
					workflowToolOptimization: {
						processResult: request.processToolResult ?? baseOpt?.processResult ?? ((_t, o) => o),
						toolAliases: baseOpt?.toolAliases,
						argumentAliases: baseOpt?.argumentAliases,
						maxConcurrentTools: baseOpt?.maxConcurrentTools,
						remainingToolCalls: baseOpt?.remainingToolCalls,
						resourceConflictMode: baseOpt?.resourceConflictMode,
						transformTools: request.transformTools ?? baseOpt?.transformTools,
						optimizationReceipts: baseOpt?.optimizationReceipts,
						lastOptimizationReceipt: baseOpt?.lastOptimizationReceipt,
					},
				}
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
			resolvedModel: result.result.resolvedModel,
			toolCalls: result.result.toolCalls,
		},
		changesApplied: result.changesApplied,
		mergeSummary: result.mergeSummary,
	};
};

export interface DefaultRuntimeDependencies {
	/** Override for tests; production uses runStructuredSubagent. */
	embeddedRunner?: StructuredRunner;
}

/** Embedded multi-model runtime (RuntimeAdapter → structured-subagent). */
export function createDefaultRuntimeAdapter(dependencies: DefaultRuntimeDependencies = {}): RuntimeAdapter {
	const embeddedRunner = dependencies.embeddedRunner ?? productionRunner;
	return new RuntimeAdapter(embeddedRunner);
}
