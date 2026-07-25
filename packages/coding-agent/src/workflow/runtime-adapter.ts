import type { Usage } from "@oh-my-pi/pi-ai";
import type { ToolSession } from "../tools";
import {
	WorkflowCancelledError,
	WorkflowError,
	WorkflowPolicyError,
	WorkflowSchemaError,
	WorkflowTimeoutError,
} from "./errors";
import { prepareWorkflowInvocation } from "./runtime-invocation";
import type { ToolDescriptor } from "./schema-enhancer";
import {
	defaultSchemaValidator,
	renderSchemaRetryPrompt,
	repairStructuredOutput,
	totalSchemaModelAttempts,
} from "./structured-output-repair";
import type {
	RuntimePort,
	WorkflowAgentRequest,
	WorkflowAgentResult,
	WorkflowErrorKind,
	WorkflowIsolationControls,
} from "./types";

/** Minimal request shape accepted by the injectable structured runner. */
export interface StructuredRunnerRequest {
	session: ToolSession;
	invocationKind: "task" | "eval";
	assignment: string;
	context?: string;
	agent?: string;
	model?: string | string[];
	thinkingLevel?: WorkflowAgentRequest["profile"]["thinkingLevel"];
	outputSchema?: unknown;
	schemaMode?: "permissive" | "strict";
	isolation?: WorkflowIsolationControls;
	maxRuntimeMs?: number;
	signal?: AbortSignal;
	/** When true, task runtime keeps isolation artifacts for verification. */
	retainArtifacts?: boolean;
	/** Used to place durable patch copies under workflow artifact storage. */
	workflowId?: string;
	attemptId?: string;
	/** Scoped tool allowlist forwarded to structured-subagent. */
	allowedTools?: readonly string[];
	/**
	 * Per-model tool-result post-processor (truncation/summarization).
	 * Also installed on session.workflowToolOptimization for the live tool path.
	 */
	processToolResult?: (toolName: string, output: string, args?: unknown) => string;
	/** Remap tool descriptors (aliases) for the model wire surface. */
	transformTools?: (tools: ToolDescriptor[]) => ToolDescriptor[];
}

/** Minimal shape returned by runStructuredSubagent — kept local so pure tests need no natives. */
export interface StructuredRunnerResult {
	result: {
		id: string;
		structuredOutput?: {
			status: "valid" | "invalid" | string;
			data?: unknown;
			error?: string;
		};
		/**
		 * Invalid or pre-validation raw model text when available.
		 * Used by deterministic schema repair (BOM/fence/single-object extract).
		 */
		rawOutput?: string;
		patchPath?: string;
		branchName?: string;
		usage?: Usage;
		exitCode?: number;
		error?: string;
		aborted?: boolean;
		resolvedModel?: string;
		toolCalls?: number;
	};
	/** Whether isolated changes were applied to the main worktree. null when N/A. */
	changesApplied?: boolean | null;
	mergeSummary?: string;
}

export type StructuredRunner = (request: StructuredRunnerRequest) => Promise<StructuredRunnerResult>;

/**
 * Map workflow roles onto registered bundled agents.
 * Workflow roles are policy names; task runtime only knows bundled agent names.
 */
export const WORKFLOW_ROLE_TO_AGENT: Readonly<Record<WorkflowAgentRequest["role"], string>> = {
	planner: "designer",
	plan_reviewer: "reviewer",
	implementer: "task",
	code_reviewer: "reviewer",
	repair: "task",
};

// Re-export preparation helpers so existing imports keep working.
export { injectWorkflowPrompt, wrapSessionForWorkflowIsolation } from "./runtime-invocation";

/**
 * Sole workflow module allowed to call the structured runner port.
 */
export class RuntimeAdapter implements RuntimePort {
	readonly #runner: StructuredRunner;

	constructor(runner: StructuredRunner) {
		this.#runner = runner;
	}

	buildRequest(request: WorkflowAgentRequest): WorkflowAgentRequest {
		return request;
	}

	static agentNameForRole(role: WorkflowAgentRequest["role"]): string {
		return WORKFLOW_ROLE_TO_AGENT[role] ?? "task";
	}

	async run<TArtifact = unknown>(request: WorkflowAgentRequest): Promise<WorkflowAgentResult<TArtifact>> {
		const retry = request.profile.outputStrategy?.retryOnSchemaViolation;
		// maxRetries = additional model calls after the first (total = 1 + maxRetries).
		const maxRetries = retry?.enabled ? Math.max(0, retry.maxRetries) : 0;
		const maxAttempts = retry?.enabled ? totalSchemaModelAttempts(maxRetries) : 1;
		let working: WorkflowAgentRequest = request;
		let lastSchemaError: WorkflowSchemaError | undefined;

		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			try {
				return await this.#runOnce<TArtifact>(working);
			} catch (error) {
				const normalized = this.#normalizeError(error);
				if (!(normalized instanceof WorkflowSchemaError)) {
					throw normalized;
				}
				lastSchemaError = normalized;

				// Deterministic extract/repair on the error message body when it embeds raw JSON.
				// Full raw capture is owned by the runner; here we only re-prompt for retries.
				if (attempt >= maxAttempts - 1) {
					throw normalized;
				}

				// Budget check before scheduling another model call.
				const remainingModelCalls = maxAttempts - attempt - 1;
				if (remainingModelCalls <= 0) {
					throw normalized;
				}

				if (retry?.includeErrorInRetry) {
					const fragment = normalized.message.slice(0, 2000);
					const hint = renderSchemaRetryPrompt({
						violations: normalized.message,
						schemaSummary: schemaSummaryForRetry(working.outputSchema),
						previousOutput: fragment,
					});
					working = {
						...working,
						context: `${working.context?.trim() ?? ""}\n\n${hint}`,
					};
				}
			}
		}

		throw lastSchemaError ?? new WorkflowSchemaError("schema retry exhausted");
	}

	/**
	 * Repair a raw model string against the request schema (shared by embedded/CLI adapters).
	 * maxRetries counts additional model calls after the provided raw.
	 */
	async repairRawOutput(
		raw: string,
		schema: unknown,
		options?: {
			maxRetries?: number;
			retryWithModel?: (prompt: string) => Promise<string>;
			remainingModelCalls?: number;
		},
	) {
		return repairStructuredOutput(raw, {
			maxRetries: options?.maxRetries ?? 0,
			schema,
			validate: defaultSchemaValidator,
			retryWithModel: options?.retryWithModel,
			budget: { remainingModelCalls: options?.remainingModelCalls },
		});
	}

	async #runOnce<TArtifact>(request: WorkflowAgentRequest): Promise<WorkflowAgentResult<TArtifact>> {
		const prepared = prepareWorkflowInvocation(request);
		// strictMode:true → strict; strictMode:false → permissive; omitted → strict (safe default).
		const schemaMode =
			request.profile.outputStrategy?.schemaEnhancement?.strictMode === false ? "permissive" : "strict";

		const mappedRequest: StructuredRunnerRequest = {
			session: prepared.session,
			invocationKind: "task",
			assignment: prepared.assignment,
			// Assembled stable+dynamic prompt text is the production model-facing context.
			context: prepared.assembledPromptText || prepared.context,
			agent: RuntimeAdapter.agentNameForRole(request.role),
			model: request.profile.modelPattern,
			thinkingLevel: request.profile.thinkingLevel,
			outputSchema: prepared.outputSchema ?? request.outputSchema,
			schemaMode,
			isolation: prepared.isolation,
			maxRuntimeMs: request.profile.maxRuntimeMs,
			signal: request.signal,
			retainArtifacts: prepared.isolationRequested,
			workflowId: request.workflowId,
			attemptId: request.attemptId,
			allowedTools: prepared.allowedTools,
			processToolResult: prepared.processToolResult,
			transformTools: prepared.transformTools,
		};

		try {
			const result = await this.#runner(mappedRequest);
			const body = result.result;

			if (body.aborted) {
				throw new WorkflowCancelledError(body.error ?? "Workflow subagent was aborted", {
					exitCode: body.exitCode,
				});
			}
			if (body.error) {
				throw new WorkflowError(body.error, this.#classifyErrorKind(body.error), { exitCode: body.exitCode });
			}
			if (body.exitCode !== undefined && body.exitCode !== 0) {
				// Schema violation often surfaces as exitCode=1 + structured invalid — try repair first.
				const structuredFail = body.structuredOutput;
				if (structuredFail && structuredFail.status !== "valid") {
					const repaired = await this.#tryRepairStructured<TArtifact>(
						body,
						prepared.outputSchema ?? request.outputSchema,
						prepared,
						request,
						result.changesApplied ?? null,
					);
					if (repaired) return repaired;
					// Fall through to schema error so the outer retry loop can re-prompt.
					throw new WorkflowSchemaError(
						structuredFail.error ?? "Workflow subagent did not return a valid structured artifact",
						{ status: structuredFail.status, rawOutput: body.rawOutput, exitCode: body.exitCode },
					);
				}
				throw new WorkflowError(`Workflow subagent exited with code ${body.exitCode}`, "tool_failure", {
					exitCode: body.exitCode,
				});
			}

			// Fail closed when isolation apply was requested but changes did not land.
			if (prepared.isolationRequested && prepared.isolation?.apply !== false && result.changesApplied === false) {
				throw new WorkflowPolicyError("isolation_changes_not_applied", {
					patchPath: body.patchPath,
					branchName: body.branchName,
					mergeSummary: result.mergeSummary,
				});
			}

			const structured = body.structuredOutput;
			if (structured?.status !== "valid") {
				const repaired = await this.#tryRepairStructured<TArtifact>(
					body,
					prepared.outputSchema ?? request.outputSchema,
					prepared,
					request,
					result.changesApplied ?? null,
				);
				if (repaired) return repaired;
				throw new WorkflowSchemaError(
					structured?.error ?? "Workflow subagent did not return a valid structured artifact",
					{ status: structured?.status, rawOutput: body.rawOutput },
				);
			}
			const resolved = parseResolvedModel(body.resolvedModel);
			return {
				artifact: structured.data as TArtifact,
				rawResultId: body.id,
				attemptId: request.attemptId,
				patchPath: body.patchPath,
				branchName: body.branchName,
				usage: body.usage,
				changesApplied: result.changesApplied ?? null,
				resolvedProvider: resolved?.provider,
				resolvedModel: resolved?.model,
				toolCalls: body.toolCalls,
				// After the live tool path finishes, optimization receipts (if any) sit on the shared array.
				promptAssemblyReceipt: prepared.promptAssemblyReceipt,
				optimizationReceipts:
					prepared.optimizationReceipts.length > 0 ? [...prepared.optimizationReceipts] : undefined,
			};
		} catch (error) {
			throw this.#normalizeError(error);
		}
	}

	/**
	 * Deterministic raw repair (BOM/fence/single-object) before model schema retry.
	 * Returns a result when repair succeeds with zero model calls; otherwise undefined.
	 */
	async #tryRepairStructured<TArtifact>(
		body: StructuredRunnerResult["result"],
		schema: unknown,
		prepared: ReturnType<typeof prepareWorkflowInvocation>,
		request: WorkflowAgentRequest,
		changesApplied: boolean | null,
	): Promise<WorkflowAgentResult<TArtifact> | undefined> {
		const raw = extractInvalidRaw(body);
		if (!raw) return undefined;
		const repaired = await repairStructuredOutput(raw, {
			maxRetries: 0,
			schema,
			validate: defaultSchemaValidator,
			budget: { remainingModelCalls: 0 },
		});
		if (!repaired.ok || repaired.value === undefined) return undefined;
		const resolved = parseResolvedModel(body.resolvedModel);
		return {
			artifact: repaired.value as TArtifact,
			rawResultId: body.id,
			attemptId: request.attemptId,
			patchPath: body.patchPath,
			branchName: body.branchName,
			usage: body.usage,
			changesApplied,
			resolvedProvider: resolved?.provider,
			resolvedModel: resolved?.model,
			toolCalls: body.toolCalls,
			promptAssemblyReceipt: prepared.promptAssemblyReceipt,
			optimizationReceipts:
				prepared.optimizationReceipts.length > 0 ? [...prepared.optimizationReceipts] : undefined,
			schemaRepairReceipt: repaired.receipt,
		};
	}

	#classifyErrorKind(message: string): WorkflowErrorKind {
		const m = message.toLowerCase();
		if (/auth|unauthorized|401|403|credential|api.?key/.test(m)) return "authentication";
		if (/quota|billing|insufficient.?quota/.test(m)) return "quota";
		if (/rate.?limit|429|too many requests/.test(m)) return "rate_limit";
		if (/timeout|timed out|deadline/.test(m)) return "timeout";
		if (/transient|temporarily|503|502|overloaded|retry/.test(m)) return "provider_transient";
		if (/schema|structured|invalid output/.test(m)) return "schema_violation";
		if (/isolat|git repository/.test(m)) return "configuration";
		return "provider_permanent";
	}

	#normalizeError(error: unknown): WorkflowError {
		if (error instanceof WorkflowError) return error;
		const message = error instanceof Error ? error.message : String(error);
		const name = error instanceof Error ? error.name : "";
		if (name === "AbortError" || /abort|cancel/i.test(message)) {
			return new WorkflowCancelledError(message, { cause: error });
		}
		if (/timeout|timed out/i.test(message)) {
			return new WorkflowTimeoutError(message, { cause: error });
		}
		if (/schema|structured|invalid/i.test(message)) {
			return new WorkflowSchemaError(message, { cause: error });
		}
		return new WorkflowError(message, this.#classifyErrorKind(message), { cause: error });
	}
}

function extractInvalidRaw(body: StructuredRunnerResult["result"]): string | undefined {
	if (typeof body.rawOutput === "string" && body.rawOutput.length > 0) return body.rawOutput;
	const data = body.structuredOutput?.data;
	if (typeof data === "string" && data.length > 0) return data;
	if (data !== undefined && data !== null) {
		try {
			return JSON.stringify(data);
		} catch {
			// fall through
		}
	}
	const err = body.structuredOutput?.error;
	if (typeof err === "string" && (err.includes("{") || err.includes("```"))) return err;
	return undefined;
}

function schemaSummaryForRetry(schema: unknown): string {
	try {
		const s = JSON.stringify(schema ?? {});
		return s.length > 800 ? `${s.slice(0, 800)}…` : s;
	} catch {
		return "{}";
	}
}

function parseResolvedModel(value: string | undefined): { provider: string; model: string } | undefined {
	if (!value) return undefined;
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) return undefined;
	const provider = value.slice(0, slash);
	const selector = value.slice(slash + 1);
	const thinkingSuffix = selector.lastIndexOf(":");
	const model = thinkingSuffix > 0 ? selector.slice(0, thinkingSuffix) : selector;
	return { provider, model };
}
