import codeReviewerPrompt from "../prompts/workflow/code-reviewer.md" with { type: "text" };
import implementerPrompt from "../prompts/workflow/implementer.md" with { type: "text" };
import planReviewerPrompt from "../prompts/workflow/plan-reviewer.md" with { type: "text" };
import plannerPrompt from "../prompts/workflow/planner.md" with { type: "text" };
import repairPrompt from "../prompts/workflow/repair.md" with { type: "text" };
import type { ToolSession } from "../tools";
import { WorkflowCancelledError, WorkflowPolicyError } from "./errors";
import { applyPromptStrategy } from "./prompt-strategy";
import { enhanceSchemaForProfile, type ToolDescriptor, transformToolsForProfile } from "./schema-enhancer";
import { applyContextStrategyEviction } from "./tool-optimization";
import { processToolOutput } from "./tool-output-manager";
import { isReadonlyWorkflowRole, ToolPolicyFactory, wrapSessionForWorkflowRole } from "./tool-policy";
import type { ModelProfile, WorkflowAgentRequest, WorkflowIsolationControls } from "./types";

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
 * When profile.promptStrategy is set, applies per-model style template (concise/structured/explicit).
 */
export function injectWorkflowPrompt(
	promptTemplate: string,
	assignment: string,
	context?: string,
	profile?: Pick<ModelProfile, "promptStrategy">,
	role?: WorkflowAgentRequest["role"],
	outputSchema?: unknown,
): { assignment: string; context?: string; styleMarker?: string | null } {
	const template = WORKFLOW_PROMPTS[promptTemplate]?.trim();
	if (!template) return { assignment, context, styleMarker: null };

	if (profile?.promptStrategy && role) {
		const applied = applyPromptStrategy({
			profile,
			role,
			rolePrompt: template,
			context: context?.trim() ? `## Context\n${context}` : undefined,
			assignment,
			outputSchema,
		});
		return { assignment, context: applied.context, styleMarker: applied.styleMarker };
	}

	const ctx = context?.trim() ? `${template}\n\n## Context\n${context}` : template;
	return { assignment, context: ctx, styleMarker: null };
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
	/** Non-null when a per-model style template was applied. */
	styleMarker?: string | null;
	/** Schema after outputStrategy enhancement (may equal request.outputSchema). */
	outputSchema?: unknown;
	/** Apply toolStrategy truncation/summarization to a tool result string. */
	processToolResult: (toolName: string, output: string, args?: unknown) => string;
	/** Remap tool descriptors with profile aliases for the model wire surface. */
	transformTools: (tools: ToolDescriptor[]) => ToolDescriptor[];
}

/**
 * Shared workflow-owned preparation before provider-specific execution.
 * Rejects aborted requests and readonly isolation; injects prompts/policy/tools;
 * applies per-model prompt, schema, and tool strategies.
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

	const enhancedSchema = enhanceSchemaForProfile(request.outputSchema, request.profile);

	const injected = injectWorkflowPrompt(
		request.profile.promptTemplate,
		request.assignment,
		request.context,
		request.profile,
		request.role,
		enhancedSchema,
	);
	const maxBytes = request.profile.contextPolicy?.maxArtifactBytes ?? Number.POSITIVE_INFINITY;
	let context = injected.context;
	if (context && context.length > maxBytes) {
		context = `${context.slice(0, Math.max(0, maxBytes - 32))}\n/* truncated by contextPolicy */`;
	}

	// Optional repo-map / contextStrategy artifact cap is applied when contextStrategy is present
	// and context already includes a map (stages may inject via ContextBuilder).
	const strategyMax = request.profile.contextStrategy?.artifactInclusion?.maxArtifactBytes;
	if (strategyMax && context && context.length > strategyMax) {
		context = `${context.slice(0, Math.max(0, strategyMax - 32))}\n/* truncated by contextStrategy */`;
	}

	// CWL-style eviction under utilization pressure (production call site for evictContext).
	const evictionBudget =
		request.profile.contextStrategy?.artifactInclusion?.maxArtifactBytes ??
		request.profile.contextPolicy?.maxArtifactBytes ??
		maxBytes;
	context = applyContextStrategyEviction(context, request.profile.contextStrategy, evictionBudget);

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

	const toolStrategy = request.profile.toolStrategy;
	const processToolResult = (toolName: string, output: string, args?: unknown) =>
		processToolOutput(output, toolName, toolStrategy, args);

	const transformTools = (tools: ToolDescriptor[]) => transformToolsForProfile(tools, request.profile);

	const toolAliases = {
		...(request.profile.toolStrategy?.toolAliases ?? {}),
		...(request.profile.toolAliases ?? {}),
	};
	const argumentAliases = {
		...(request.profile.toolStrategy?.argumentAliases ?? {}),
		...(request.profile.argumentAliases ?? {}),
	};

	// Always install optimization on the session so bash/read/grep honor processResult
	// and customWireName on the real tool path (not only via PreparedWorkflowInvocation helpers).
	session = {
		...session,
		workflowToolOptimization: {
			processResult: processToolResult,
			toolAliases: Object.keys(toolAliases).length > 0 ? toolAliases : undefined,
			argumentAliases: Object.keys(argumentAliases).length > 0 ? argumentAliases : undefined,
		},
	};

	return {
		request,
		assignment: injected.assignment,
		context,
		readonly: readonlyRole,
		isolation,
		isolationRequested,
		allowedTools: effectiveTools ? [...effectiveTools] : undefined,
		session,
		styleMarker: injected.styleMarker,
		outputSchema: enhancedSchema,
		processToolResult,
		transformTools,
	};
}
