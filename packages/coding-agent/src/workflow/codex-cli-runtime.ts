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
import { redactSecretsInText } from "./secret-redact";
import type { RuntimePort, WorkflowAgentRequest, WorkflowAgentResult } from "./types";

export interface CodexCliCommandInput {
	executable: string;
	schemaPath: string;
	resultPath: string;
	model: string;
	readonly: boolean;
	cwd: string;
	profile?: string;
}

export function buildCodexCliCommand(input: CodexCliCommandInput): string[] {
	const command = [
		input.executable,
		"exec",
		"--ephemeral",
		"--color",
		"never",
		"--json",
		"--output-schema",
		input.schemaPath,
		"--output-last-message",
		input.resultPath,
		"--model",
		input.model,
		"--sandbox",
		input.readonly ? "read-only" : "workspace-write",
		"--cd",
		input.cwd,
	];
	if (input.profile) command.push("--profile", input.profile);
	command.push("-");
	return command;
}

export interface CodexCliRuntimeOptions {
	processRunner: CliProcessRunner;
	resolveExecutable?: (name: string) => Promise<string | null> | string | null;
	artifactRoot?: string;
	/** Required for write-capable runs; injected by production wiring. */
	isolation?: CliIsolationDeps;
}

interface CodexJsonlHints {
	usage?: Usage;
	resolvedModel?: string;
	resolvedProvider?: string;
	status?: number;
	toolCalls?: number;
	errorMessage?: string;
}

function parseCodexJsonl(stdout: string): CodexJsonlHints {
	const hints: CodexJsonlHints = {};
	const lines = stdout
		.split("\n")
		.map(l => l.trim())
		.filter(Boolean);
	for (const line of lines) {
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (event.usage && typeof event.usage === "object") {
			hints.usage = normalizeCliUsage(event.usage as CliUsageLike) ?? hints.usage;
		}
		if (event.model && typeof event.model === "string") {
			hints.resolvedModel = event.model;
		}
		if (event.provider && typeof event.provider === "string") {
			hints.resolvedProvider = event.provider;
		}
		const response = event.response;
		if (response && typeof response === "object") {
			const resp = response as Record<string, unknown>;
			if (resp.model && typeof resp.model === "string") hints.resolvedModel = resp.model;
			if (resp.usage && typeof resp.usage === "object") {
				hints.usage = normalizeCliUsage(resp.usage as CliUsageLike) ?? hints.usage;
			}
		}
		if (typeof event.status === "number") hints.status = event.status;
		if (typeof event.http_status === "number") hints.status = event.http_status;
		if (typeof event.tool_calls === "number") hints.toolCalls = event.tool_calls;
		if (String(event.type ?? event.event ?? "").includes("error") || event.error) {
			const err = event.error;
			if (typeof err === "string") hints.errorMessage = err;
			else if (err && typeof err === "object" && "message" in err) {
				hints.errorMessage = String((err as { message: unknown }).message);
			}
			if (err && typeof err === "object" && "status" in err) {
				const status = Number((err as { status: unknown }).status);
				if (Number.isFinite(status)) hints.status = status;
			}
		}
	}
	return hints;
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

export class CodexCliRuntimeAdapter implements RuntimePort {
	readonly #processRunner: CliProcessRunner;
	readonly #resolveExecutable: (name: string) => Promise<string | null> | string | null;
	readonly #artifactRoot: string;
	readonly #isolation: CliIsolationDeps | undefined;
	readonly #resolved = new Map<string, string>();

	constructor(options: CodexCliRuntimeOptions) {
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
				hint: "Codex CLI write roles must run inside an isolation worktree",
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
		const configured = request.profile.runtime?.executable?.trim() || "codex";
		const cached = this.#resolved.get(configured);
		if (cached) return cached;
		if (path.isAbsolute(configured)) {
			if (!(await Bun.file(configured).exists())) {
				throw new WorkflowError(`Codex CLI executable not found: ${configured}`, "configuration", {
					executable: configured,
				});
			}
			this.#resolved.set(configured, configured);
			return configured;
		}
		const resolved = await this.#resolveExecutable(configured);
		if (!resolved) {
			throw new WorkflowError(`Codex CLI executable not found: ${configured}`, "configuration", {
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
		const workDir = path.join(this.#artifactRoot, request.workflowId, "cli", request.attemptId);
		await fs.mkdir(workDir, { recursive: true });
		const schemaPath = path.join(workDir, "schema.json");
		const resultPath = path.join(workDir, "result.json");
		await Bun.write(schemaPath, JSON.stringify(request.outputSchema));
		await Bun.write(resultPath, "");

		const command = buildCodexCliCommand({
			executable,
			schemaPath,
			resultPath,
			model,
			readonly: prepared.readonly,
			cwd,
			profile: request.profile.runtime?.profile,
		});

		if (command.some(arg => arg.includes("dangerously-bypass") || arg.includes("dangerously-skip"))) {
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

		logger.debug("codex_cli_runtime_start", {
			workflowId: request.workflowId,
			attemptId: request.attemptId,
			role: request.role,
			profileId: request.profile.id,
			model,
			readonly: prepared.readonly,
			executable: path.basename(executable),
		});

		const processResult = await this.#processRunner(processRequest);
		const hints = parseCodexJsonl(processResult.stdout);
		if (processResult.exitCode !== 0) {
			throw classifyCliFailure({
				exitCode: processResult.exitCode,
				status: hints.status,
				stderr: processResult.stderr,
				stdout: processResult.stdout,
				message: hints.errorMessage,
			});
		}

		let finalRaw = "";
		try {
			finalRaw = await Bun.file(resultPath).text();
		} catch {
			finalRaw = "";
		}
		if (!finalRaw.trim()) {
			const lines = processResult.stdout
				.split("\n")
				.map(l => l.trim())
				.filter(Boolean);
			finalRaw = lines[lines.length - 1] ?? "";
		}
		const artifact = parseCliJsonArtifact(finalRaw, "Codex CLI final message");
		const unwrapped = unwrapCodexArtifact(artifact);
		assertCliArtifactShape(unwrapped, request.outputSchema);

		return {
			artifact: unwrapped,
			rawResultId: `codex-${request.attemptId}`,
			usage: hints.usage,
			resolvedProvider: hints.resolvedProvider ?? "codex-cli",
			resolvedModel: hints.resolvedModel ?? model,
			toolCalls: hints.toolCalls,
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
			throw new WorkflowError("Codex CLI write isolation is not configured", "configuration");
		}

		const artifactsDir = path.join(this.#artifactRoot, request.workflowId, "isolation", request.attemptId);
		await fs.mkdir(artifactsDir, { recursive: true });

		let context: CliIsolationContext;
		try {
			context = await isolation.prepareIsolationContext(request.session.cwd);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new WorkflowError(`Isolated Codex CLI requires a git repository. ${message}`, "configuration", {
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
						? `${executed.resolvedProvider ?? "codex-cli"}/${executed.resolvedModel}`
						: undefined,
					toolCalls: executed.toolCalls,
				});
			},
		});

		if (singleResult.error || singleResult.aborted || singleResult.exitCode !== 0) {
			if (singleResult.aborted) {
				throw new WorkflowError(singleResult.error ?? "Codex CLI cancelled", "cancelled");
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
			throw new WorkflowSchemaError("Codex CLI isolated run produced no structured artifact");
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
			resolvedProvider: resolved?.provider ?? "codex-cli",
			resolvedModel: resolved?.model ?? parseExactCliModel(request.profile.modelPattern),
			toolCalls: singleResult.toolCalls,
		};
	}
}

function unwrapCodexArtifact(value: unknown): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const obj = value as Record<string, unknown>;
	if (obj.structured_output && typeof obj.structured_output === "object") return obj.structured_output;
	if (obj.result && typeof obj.result === "object") return obj.result;
	if (typeof obj.message === "string") {
		try {
			return JSON.parse(obj.message) as unknown;
		} catch {
			return value;
		}
	}
	return value;
}

function parseProviderModel(value: string | undefined): { provider: string; model: string } | undefined {
	if (!value) return undefined;
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) return undefined;
	return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

export function redactCliText(text: string): string {
	return redactSecretsInText(text);
}
