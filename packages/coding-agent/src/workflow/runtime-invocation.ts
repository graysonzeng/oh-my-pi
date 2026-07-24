import codeReviewerPrompt from "../prompts/workflow/code-reviewer.md" with { type: "text" };
import implementerPrompt from "../prompts/workflow/implementer.md" with { type: "text" };
import planReviewerPrompt from "../prompts/workflow/plan-reviewer.md" with { type: "text" };
import plannerPrompt from "../prompts/workflow/planner.md" with { type: "text" };
import repairPrompt from "../prompts/workflow/repair.md" with { type: "text" };
import type { ToolSession } from "../tools";
import { WorkflowCancelledError, WorkflowPolicyError } from "./errors";
import { isReadonlyWorkflowRole, ToolPolicyFactory, wrapSessionForWorkflowRole } from "./tool-policy";
import type { WorkflowAgentRequest, WorkflowIsolationControls } from "./types";

/** Versioned workflow role prompts keyed by ModelProfile.promptTemplate. */
export const WORKFLOW_PROMPTS: Readonly<Record<string, string>> = {
	planner: plannerPrompt,
	"plan-reviewer": planReviewerPrompt,
	implementer: implementerPrompt,
	"code-reviewer": codeReviewerPrompt,
	repair: repairPrompt,
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

/** Provider-neutral prepared invocation shared by embedded and CLI adapters. */
export interface PreparedWorkflowInvocation {
	request: WorkflowAgentRequest;
	assignment: string;
	context?: string;
	readonly: boolean;
	isolation?: WorkflowIsolationControls;
	isolationRequested: boolean;
	allowedTools?: string[];
	session: ToolSession;
}

/**
 * Shared workflow-owned preparation before provider-specific execution.
 * Rejects aborted requests and readonly isolation; injects prompts/policy/tools.
 */
export function prepareWorkflowInvocation(request: WorkflowAgentRequest): PreparedWorkflowInvocation {
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
	const disabled = new Set(request.profile.disabledTools ?? []);
	const effectiveTools = allowedTools && disabled.size > 0 ? allowedTools.filter(t => !disabled.has(t)) : allowedTools;

	return {
		request,
		assignment: injected.assignment,
		context,
		readonly: readonlyRole,
		isolation,
		isolationRequested,
		allowedTools: effectiveTools ? [...effectiveTools] : undefined,
		session,
	};
}
