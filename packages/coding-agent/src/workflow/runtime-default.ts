/**
 * Production wiring for RuntimeAdapter.
 * Isolated from pure workflow modules so unit tests never load task/natives.
 * AGENTS.md forbids await import() — this file uses a top-level import instead.
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
		// If source already gone, return original path so fail-closed verify can report it.
		return patchPath;
	}
}

const productionRunner: StructuredRunner = async (request: StructuredRunnerRequest) => {
	const isolationRequested = request.isolation?.requested === true;
	const result = await runStructuredSubagent({
		session: request.session,
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
		// Keep isolation patches for workflow verification even after successful apply/cleanup.
		retainArtifacts: isolationRequested || request.retainArtifacts === true,
		allowedTools: request.allowedTools,
	});

	let patchPath = result.result.patchPath;
	// Durable copy so verifier can read after isolation temp cleanup.
	if (isolationRequested && patchPath && request.workflowId && request.attemptId) {
		patchPath = (await preservePatchArtifact(patchPath, request.workflowId, request.attemptId)) ?? patchPath;
	}

	return {
		result: {
			id: result.result.id,
			structuredOutput: result.result.structuredOutput,
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

export function createDefaultRuntimeAdapter(): RuntimeAdapter {
	return new RuntimeAdapter(productionRunner);
}
