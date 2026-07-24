import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Usage } from "@oh-my-pi/pi-ai";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { defaultWorkflowArtifactDir } from "./artifact-store";
import type { CliIsolationContext, CliIsolationDeps } from "./cli-isolation";
import type { CliProcessRequest, CliProcessRunner } from "./cli-process";
import {
	assertCliArtifactShape,
	type CliUsageLike,
	classifyCliFailure,
	createCliFailureSingleResult,
	createCliSingleResult,
	normalizeCliUsage,
	parseCliJsonArtifact,
	parseExactCliModel,
} from "./cli-runtime-result";
import { WorkflowError, WorkflowPolicyError, WorkflowSchemaError } from "./errors";
import { type PreparedWorkflowInvocation, prepareWorkflowInvocation } from "./runtime-invocation";
import { READONLY_TOOLS } from "./tool-policy";
import type { RuntimePort, WorkflowAgentRequest, WorkflowAgentResult } from "./types";

export interface ClaudeCliCommandInput {
	executable: string;
	schemaJson: string;
	model: string;
	readonly: boolean;
	tools: string[];
}

export function buildClaudeCliCommand(input: ClaudeCliCommandInput): string[] {
	return [
		input.executable,
		"--print",
		"--output-format",
		"json",
		"--json-schema",
		input.schemaJson,
		"--model",
		input.model,
		"--permission-mode",
		input.readonly ? "plan" : "dontAsk",
		"--no-session-persistence",
		"--disable-slash-commands",
		"--setting-sources",
		"user",
		"--tools",
		input.tools.join(","),
	];
}

export interface ClaudeCliRuntimeOptions {
	processRunner: CliProcessRunner;
	resolveExecutable?: (name: string) => Promise<string | null> | string | null;
	artifactRoot?: string;
	isolation?: CliIsolationDeps;
}

export class ClaudeCliRuntimeAdapter implements RuntimePort {
	readonly #processRunner: CliProcessRunner;
	readonly #resolveExecutable: (name: string) => Promise<string | null> | string | null;
	readonly #artifactRoot: string;
	readonly #isolation: CliIsolationDeps | undefined;
	readonly #resolved = new Map<string, string>();

	constructor(options: ClaudeCliRuntimeOptions) {
		this.#processRunner = options.processRunner;
		this.#resolveExecutable = options.resolveExecutable ?? (name => name);
		this.#artifactRoot = options.artifactRoot ?? defaultWorkflowArtifactDir();
		this.#isolation = options.isolation;
	}

	buildRequest(request: WorkflowAgentRequest): WorkflowAgentRequest {
		return request;
	}

	async run<TArtifact = unknown>(request: WorkflowAgentRequest): Promise<WorkflowAgentResult<TArtifact>> {
		const prepared = prepareWorkflowInvocation(request);
		if (!request.outputSchema) {
			throw new WorkflowSchemaError("CLI runtime requires outputSchema");
		}

		if (prepared.isolationRequested) {
			return this.#runIsolatedWrite(request, prepared);
		}

		if (!prepared.readonly && (request.role === "implementer" || request.role === "repair")) {
			throw new WorkflowPolicyError("cli_write_requires_isolation", {
				role: request.role,
				hint: "Claude CLI write roles must run inside an isolation worktree",
			});
		}

		const executed = await this.#runInDirectory(request, prepared, request.session.cwd);
		return {
			artifact: executed.artifact as TArtifact,
			rawResultId: executed.rawResultId,
			attemptId: request.attemptId,
			usage: executed.usage,
			changesApplied: null,
			resolvedProvider: executed.resolvedProvider,
			resolvedModel: executed.resolvedModel,
			toolCalls: executed.toolCalls,
		};
	}

	async #resolveBin(request: WorkflowAgentRequest): Promise<string> {
		const configured = request.profile.runtime?.executable?.trim() || "claude";
		const cached = this.#resolved.get(configured);
		if (cached) return cached;
		if (path.isAbsolute(configured)) {
			if (!(await Bun.file(configured).exists())) {
				throw new WorkflowError(`Claude CLI executable not found: ${configured}`, "configuration", {
					executable: configured,
				});
			}
			this.#resolved.set(configured, configured);
			return configured;
		}
		const resolved = await this.#resolveExecutable(configured);
		if (!resolved) {
			throw new WorkflowError(`Claude CLI executable not found: ${configured}`, "configuration", {
				executable: configured,
			});
		}
		this.#resolved.set(configured, resolved);
		return resolved;
	}

	async #runInDirectory(
		request: WorkflowAgentRequest,
		prepared: PreparedWorkflowInvocation,
		cwd: string,
	): Promise<{
		artifact: unknown;
		rawResultId: string;
		usage?: Usage;
		resolvedProvider?: string;
		resolvedModel?: string;
		toolCalls?: number;
		durationMs: number;
		stdout: string;
		stderr: string;
		exitCode: number;
	}> {
		const executable = await this.#resolveBin(request);
		const model = parseExactCliModel(request.profile.modelPattern);
		const tools = prepared.readonly ? [...READONLY_TOOLS] : (prepared.allowedTools ?? [...READONLY_TOOLS]);
		const schemaJson = JSON.stringify(request.outputSchema);
		const command = buildClaudeCliCommand({
			executable,
			schemaJson,
			model,
			readonly: prepared.readonly,
			tools,
		});

		if (command.some(arg => arg.includes("dangerously-skip") || arg.includes("dangerously-bypass"))) {
			throw new WorkflowPolicyError("cli_dangerous_flag_forbidden", { command });
		}

		const prompt = [prepared.assignment, prepared.context].filter(Boolean).join("\n\n");
		const processRequest: CliProcessRequest = {
			command,
			cwd,
			stdin: prompt,
			signal: request.signal,
			timeoutMs: request.profile.maxRuntimeMs,
		};

		logger.debug("claude_cli_runtime_start", {
			workflowId: request.workflowId,
			attemptId: request.attemptId,
			role: request.role,
			profileId: request.profile.id,
			model,
			readonly: prepared.readonly,
			executable: path.basename(executable),
		});

		const processResult = await this.#processRunner(processRequest);
		const envelope = parseCliJsonArtifact(processResult.stdout || "{}", "Claude CLI envelope") as Record<
			string,
			unknown
		>;
		const status =
			typeof envelope.status === "number"
				? envelope.status
				: typeof envelope.http_status === "number"
					? envelope.http_status
					: undefined;

		if (processResult.exitCode !== 0 || envelope.is_error === true) {
			throw classifyCliFailure({
				exitCode: processResult.exitCode,
				status,
				stderr: processResult.stderr,
				stdout: processResult.stdout,
				message:
					typeof envelope.error === "string"
						? envelope.error
						: envelope.error && typeof envelope.error === "object" && "message" in envelope.error
							? String((envelope.error as { message: unknown }).message)
							: undefined,
			});
		}

		const structured =
			envelope.structured_output ??
			envelope.structuredOutput ??
			(typeof envelope.result === "object" ? envelope.result : undefined);
		if (structured === undefined) {
			throw new WorkflowSchemaError("Claude CLI envelope missing structured_output");
		}
		assertCliArtifactShape(structured, request.outputSchema);

		const usage = normalizeCliUsage(
			(envelope.usage as CliUsageLike | undefined) ??
				((envelope as { message?: { usage?: CliUsageLike } }).message?.usage as CliUsageLike | undefined),
		);
		const resolvedModel =
			(typeof envelope.model === "string" && envelope.model) ||
			(typeof (envelope as { message?: { model?: string } }).message?.model === "string"
				? (envelope as { message: { model: string } }).message.model
				: model);
		const sessionId =
			(typeof envelope.session_id === "string" && envelope.session_id) ||
			(typeof envelope.sessionId === "string" && envelope.sessionId) ||
			`claude-${request.attemptId}`;
		const toolCalls = typeof envelope.tool_calls === "number" ? envelope.tool_calls : undefined;

		return {
			artifact: structured,
			rawResultId: sessionId,
			usage,
			resolvedProvider: "claude-cli",
			resolvedModel,
			toolCalls,
			durationMs: processResult.durationMs,
			stdout: processResult.stdout,
			stderr: processResult.stderr,
			exitCode: processResult.exitCode,
		};
	}

	async #runIsolatedWrite<TArtifact>(
		request: WorkflowAgentRequest,
		prepared: PreparedWorkflowInvocation,
	): Promise<WorkflowAgentResult<TArtifact>> {
		const isolation = this.#isolation;
		if (!isolation) {
			throw new WorkflowError("Claude CLI write isolation is not configured", "configuration");
		}

		const artifactsDir = path.join(this.#artifactRoot, request.workflowId, "isolation", request.attemptId);
		await fs.mkdir(artifactsDir, { recursive: true });

		let context: CliIsolationContext;
		try {
			context = await isolation.prepareIsolationContext(request.session.cwd);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new WorkflowError(`Isolated Claude CLI requires a git repository. ${message}`, "configuration", {
				cause: error,
			});
		}

		const isolationMode = request.session.settings?.get?.("task.isolation.mode" as never) as string | undefined;
		const singleResult = await isolation.runIsolatedExecution({
			context,
			preferredBackend: isolation.parseIsolationMode(isolationMode),
			agentId: request.attemptId,
			mergeMode: prepared.isolation?.merge ?? "patch",
			artifactsDir,
			buildCommitMessage: isolation.makeIsolationCommitMessage(request.session),
			buildFailureResult: error => createCliFailureSingleResult(request, error),
			run: async worktree => {
				const executed = await this.#runInDirectory(request, prepared, worktree);
				return createCliSingleResult({
					request,
					id: executed.rawResultId,
					exitCode: executed.exitCode,
					output: executed.stdout,
					stderr: executed.stderr,
					durationMs: executed.durationMs,
					artifact: executed.artifact,
					usage: executed.usage,
					resolvedModel: executed.resolvedModel
						? `${executed.resolvedProvider ?? "claude-cli"}/${executed.resolvedModel}`
						: undefined,
					toolCalls: executed.toolCalls,
				});
			},
		});

		if (singleResult.error || singleResult.aborted || singleResult.exitCode !== 0) {
			if (singleResult.aborted) {
				throw new WorkflowError(singleResult.error ?? "Claude CLI cancelled", "cancelled");
			}
			throw classifyCliFailure({
				exitCode: singleResult.exitCode,
				stderr: singleResult.stderr,
				message: singleResult.error,
			});
		}

		let changesApplied: boolean | null = null;
		let mergeSummary = "";
		const mergeMode = prepared.isolation?.merge ?? "patch";
		const applyChanges = prepared.isolation?.apply !== false;

		if (applyChanges) {
			const outcome = await isolation.mergeIsolatedChanges({
				result: singleResult,
				repoRoot: context.repoRoot,
				mergeMode,
			});
			mergeSummary = outcome.summary;
			changesApplied = outcome.changesApplied;
			if (outcome.changesApplied !== false) {
				mergeSummary += await isolation.applyEligibleNestedPatches({
					result: singleResult,
					repoRoot: context.repoRoot,
					mergeMode,
					changesApplied: outcome.changesApplied,
					mergedBranchForNestedPatches: outcome.mergedBranchForNestedPatches,
					commitMessage: isolation.makeIsolationCommitMessage(request.session)(),
				});
			}
			if (changesApplied === false) {
				throw new WorkflowPolicyError("isolation_changes_not_applied", {
					patchPath: singleResult.patchPath,
					branchName: singleResult.branchName,
					mergeSummary,
				});
			}
		} else {
			changesApplied = null;
		}

		if (mergeMode === "patch" && !singleResult.patchPath) {
			throw new WorkflowPolicyError("cli_write_missing_patch_evidence", {
				attemptId: request.attemptId,
			});
		}

		const durablePatch = await preservePatchArtifact(
			singleResult.patchPath,
			request.workflowId,
			request.attemptId,
			this.#artifactRoot,
		);

		const artifact = singleResult.structuredOutput?.data;
		if (artifact === undefined) {
			throw new WorkflowSchemaError("Claude CLI isolated run produced no structured artifact");
		}
		assertCliArtifactShape(artifact, request.outputSchema);

		const resolved = parseProviderModel(singleResult.resolvedModel);
		return {
			artifact: artifact as TArtifact,
			rawResultId: singleResult.id,
			attemptId: request.attemptId,
			patchPath: durablePatch ?? singleResult.patchPath,
			branchName: singleResult.branchName,
			usage: singleResult.usage,
			changesApplied,
			resolvedProvider: resolved?.provider ?? "claude-cli",
			resolvedModel: resolved?.model ?? parseExactCliModel(request.profile.modelPattern),
			toolCalls: singleResult.toolCalls,
		};
	}
}

async function preservePatchArtifact(
	patchPath: string | undefined,
	workflowId: string,
	attemptId: string,
	artifactRoot: string,
): Promise<string | undefined> {
	if (!patchPath) return undefined;
	try {
		const text = await Bun.file(patchPath).text();
		const destDir = path.join(artifactRoot, workflowId, "patches");
		await fs.mkdir(destDir, { recursive: true });
		const dest = path.join(destDir, `${attemptId}.patch`);
		await Bun.write(dest, text);
		return dest;
	} catch {
		return patchPath;
	}
}

function parseProviderModel(value: string | undefined): { provider: string; model: string } | undefined {
	if (!value) return undefined;
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) return undefined;
	return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}
