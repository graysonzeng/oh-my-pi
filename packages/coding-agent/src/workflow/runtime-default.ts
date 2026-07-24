/**
 * Production wiring for workflow runtimes (embedded + CLI).
 * Pure unit tests may import this file when isolation is injected/faked —
 * isolation-runner (pi-natives) is NOT imported here.
 * AGENTS.md forbids await import() — isolation production deps live in
 * `cli-isolation-production.ts` and are wired by the tools package.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $which } from "@oh-my-pi/pi-utils/which";
import { runStructuredSubagent } from "../task/structured-subagent";
import { defaultWorkflowArtifactDir } from "./artifact-store";
import { ClaudeCliRuntimeAdapter } from "./claude-cli-runtime";
import type { CliIsolationDeps } from "./cli-isolation";
import { type CliProcessRunner, runCliProcess } from "./cli-process";
import { CodexCliRuntimeAdapter } from "./codex-cli-runtime";
import { RuntimeAdapter, type StructuredRunner, type StructuredRunnerRequest } from "./runtime-adapter";
import { WorkflowRuntimeDispatcher } from "./runtime-dispatcher";

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
	processRunner?: CliProcessRunner;
	resolveExecutable?: (name: string) => Promise<string | null> | string | null;
	embeddedRunner?: StructuredRunner;
	artifactRoot?: string;
	/** Write-path isolation; production should pass createProductionCliIsolationDeps(). */
	isolation?: CliIsolationDeps;
}

const whichCache = new Map<string, string | null>();

async function defaultResolveExecutable(name: string): Promise<string | null> {
	if (whichCache.has(name)) return whichCache.get(name) ?? null;
	if (path.isAbsolute(name)) {
		const exists = await Bun.file(name).exists();
		const value = exists ? name : null;
		whichCache.set(name, value);
		return value;
	}
	const resolved = $which(name);
	whichCache.set(name, resolved);
	return resolved;
}

/**
 * Mixed runtime dispatcher (embedded + Codex CLI + Claude CLI).
 * Built-in defaults remain embedded until live smoke is authorized.
 * For CLI write roles, pass `isolation` (see createProductionCliIsolationDeps).
 */
export function createDefaultRuntimeAdapter(dependencies: DefaultRuntimeDependencies = {}): WorkflowRuntimeDispatcher {
	const processRunner = dependencies.processRunner ?? runCliProcess;
	const resolveExecutable = dependencies.resolveExecutable ?? defaultResolveExecutable;
	const embeddedRunner = dependencies.embeddedRunner ?? productionRunner;
	const artifactRoot = dependencies.artifactRoot;
	const isolation = dependencies.isolation;

	return new WorkflowRuntimeDispatcher({
		embedded: new RuntimeAdapter(embeddedRunner),
		codexCli: new CodexCliRuntimeAdapter({ processRunner, resolveExecutable, artifactRoot, isolation }),
		claudeCli: new ClaudeCliRuntimeAdapter({ processRunner, resolveExecutable, artifactRoot, isolation }),
	});
}
