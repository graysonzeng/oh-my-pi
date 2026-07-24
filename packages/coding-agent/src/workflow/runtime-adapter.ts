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
		const prepared = prepareWorkflowInvocation(request);

		const mappedRequest: StructuredRunnerRequest = {
			session: prepared.session,
			invocationKind: "task",
			assignment: prepared.assignment,
			context: prepared.context,
			agent: RuntimeAdapter.agentNameForRole(request.role),
			model: request.profile.modelPattern,
			thinkingLevel: request.profile.thinkingLevel,
			outputSchema: request.outputSchema,
			schemaMode: "strict",
			isolation: prepared.isolation,
			maxRuntimeMs: request.profile.maxRuntimeMs,
			signal: request.signal,
			retainArtifacts: prepared.isolationRequested,
			workflowId: request.workflowId,
			attemptId: request.attemptId,
			allowedTools: prepared.allowedTools,
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
				throw new WorkflowSchemaError(
					structured?.error ?? "Workflow subagent did not return a valid structured artifact",
					{ status: structured?.status },
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
			};
		} catch (error) {
			throw this.#normalizeError(error);
		}
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
