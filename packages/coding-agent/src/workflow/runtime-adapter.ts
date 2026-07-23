import type { Usage } from "@oh-my-pi/pi-ai";
import codeReviewerPrompt from "../prompts/workflow/code-reviewer.md" with { type: "text" };
import implementerPrompt from "../prompts/workflow/implementer.md" with { type: "text" };
import planReviewerPrompt from "../prompts/workflow/plan-reviewer.md" with { type: "text" };
import plannerPrompt from "../prompts/workflow/planner.md" with { type: "text" };
import repairPrompt from "../prompts/workflow/repair.md" with { type: "text" };
import type { ToolSession } from "../tools";
import {
	WorkflowCancelledError,
	WorkflowError,
	WorkflowPolicyError,
	WorkflowSchemaError,
	WorkflowTimeoutError,
} from "./errors";
import { isReadonlyWorkflowRole, ToolPolicyFactory, wrapSessionForWorkflowRole } from "./tool-policy";
import type {
	RuntimePort,
	WorkflowAgentRequest,
	WorkflowAgentResult,
	WorkflowErrorKind,
	WorkflowIsolationControls,
} from "./types";

/** Versioned workflow role prompts keyed by ModelProfile.promptTemplate. */
const WORKFLOW_PROMPTS: Readonly<Record<string, string>> = {
	planner: plannerPrompt,
	"plan-reviewer": planReviewerPrompt,
	implementer: implementerPrompt,
	"code-reviewer": codeReviewerPrompt,
	repair: repairPrompt,
};

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

/**
 * Inject static role prompt into the request sent to the runner.
 */
export function injectWorkflowPrompt(
	promptTemplate: string,
	assignment: string,
	context?: string,
): { assignment: string; context?: string } {
	const template = WORKFLOW_PROMPTS[promptTemplate]?.trim();
	if (!template) return { assignment, context };
	const ctx = context?.trim() ? `${template}\n\n## Context\n${context}` : template;
	return { assignment, context: ctx };
}

/**
 * When workflow write stages request isolation but global task.isolation.mode is "none",
 * override to "auto" so production workflow is not dead on open.
 */
export function wrapSessionForWorkflowIsolation(session: ToolSession, isolationRequested: boolean): ToolSession {
	if (!isolationRequested) return session;
	const settings = session.settings;
	if (!settings?.get) return session;
	const current = settings.get("task.isolation.mode" as never) as string | undefined;
	if (current && current !== "none") return session;
	return {
		...session,
		settings: {
			...settings,
			get: (key: never) => {
				if ((key as string) === "task.isolation.mode") return "auto";
				return settings.get(key);
			},
		} as ToolSession["settings"],
	};
}

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
		if (request.signal?.aborted) {
			throw new WorkflowCancelledError("aborted before runtime call");
		}

		const readonlyRole = isReadonlyWorkflowRole(request.role);
		if (readonlyRole && request.isolation?.requested) {
			throw new WorkflowPolicyError("readonly_role_isolation_forbidden", {
				role: request.role,
				hint: "planner/plan_reviewer/code_reviewer cannot request isolation",
			});
		}

		const isolation = readonlyRole ? undefined : request.isolation;
		const isolationRequested = isolation?.requested === true;

		const injected = injectWorkflowPrompt(request.profile.promptTemplate, request.assignment, request.context);
		// Truncate context by profile contextPolicy byte cap.
		const maxBytes = request.profile.contextPolicy?.maxArtifactBytes ?? Number.POSITIVE_INFINITY;
		let context = injected.context;
		if (context && context.length > maxBytes) {
			context = `${context.slice(0, Math.max(0, maxBytes - 32))}\n/* truncated by contextPolicy */`;
		}

		let session = wrapSessionForWorkflowRole(request.session, request.role);
		session = wrapSessionForWorkflowIsolation(session, isolationRequested);

		const policyFactory = new ToolPolicyFactory();
		const policy = policyFactory.getPolicyForRole(request.role);
		if (!policy.readonly) {
			session = {
				...session,
				workflowWritePolicy: {
					repoRoot: request.session.cwd,
					forbiddenPaths: [...policy.forbiddenPaths],
				},
				workflowCommandPolicy: { allowedCommands: [...policy.allowedCommands] },
			};
		}
		const allowedTools = policyFactory.allowedToolsForRole(request.role);
		// Honor profile.disabledTools by filtering allowlist when present.
		const disabled = new Set(request.profile.disabledTools ?? []);
		const effectiveTools =
			allowedTools && disabled.size > 0 ? allowedTools.filter(t => !disabled.has(t)) : allowedTools;

		const mappedRequest: StructuredRunnerRequest = {
			session,
			invocationKind: "task",
			assignment: injected.assignment,
			context,
			agent: RuntimeAdapter.agentNameForRole(request.role),
			model: request.profile.modelPattern,
			thinkingLevel: request.profile.thinkingLevel,
			outputSchema: request.outputSchema,
			schemaMode: "strict",
			isolation,
			maxRuntimeMs: request.profile.maxRuntimeMs,
			signal: request.signal,
			retainArtifacts: isolationRequested,
			workflowId: request.workflowId,
			attemptId: request.attemptId,
			allowedTools: effectiveTools,
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
			if (isolationRequested && isolation?.apply !== false && result.changesApplied === false) {
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
