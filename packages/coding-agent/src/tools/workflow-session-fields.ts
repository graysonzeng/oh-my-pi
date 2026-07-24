/**
 * Workflow-scoped ToolSession fields installed by prepareWorkflowInvocation.
 * Must be forwarded parent → ExecutorOptions → createAgentSession → createTools
 * or argumentAliases / processResult / path policies are silently dropped on the
 * embedded structured-subagent path.
 */

export type WorkflowToolOptimization = {
	processResult: (toolName: string, output: string, args?: unknown) => string;
	toolAliases?: Record<string, string>;
	argumentAliases?: Record<string, Record<string, string>>;
};

export type WorkflowWritePolicy = { repoRoot: string; forbiddenPaths: string[] };
export type WorkflowCommandPolicy = { allowedCommands: string[] };

/** Slice of ToolSession that is workflow-stage scoped (not recreated by SDK defaults). */
export type WorkflowToolSessionFields = {
	workflowToolOptimization?: WorkflowToolOptimization;
	workflowWritePolicy?: WorkflowWritePolicy;
	workflowCommandPolicy?: WorkflowCommandPolicy;
};

/**
 * Pick workflow fields from a parent ToolSession (or prepared request.session)
 * for subagent executor / createAgentSession handoff.
 */
export function pickWorkflowToolSessionFields(
	session: WorkflowToolSessionFields | null | undefined,
): WorkflowToolSessionFields {
	if (!session) return {};
	const out: WorkflowToolSessionFields = {};
	if (session.workflowToolOptimization) {
		out.workflowToolOptimization = session.workflowToolOptimization;
	}
	if (session.workflowWritePolicy) {
		out.workflowWritePolicy = session.workflowWritePolicy;
	}
	if (session.workflowCommandPolicy) {
		out.workflowCommandPolicy = session.workflowCommandPolicy;
	}
	return out;
}

/**
 * Apply workflow fields onto a freshly built child ToolSession (createAgentSession).
 * Mutates `target` in place so createTools sees aliases / processResult / policies.
 */
export function applyWorkflowToolSessionFields(
	target: WorkflowToolSessionFields,
	fields: WorkflowToolSessionFields | null | undefined,
): void {
	if (!fields) return;
	if (fields.workflowToolOptimization) {
		target.workflowToolOptimization = fields.workflowToolOptimization;
	}
	if (fields.workflowWritePolicy) {
		target.workflowWritePolicy = fields.workflowWritePolicy;
	}
	if (fields.workflowCommandPolicy) {
		target.workflowCommandPolicy = fields.workflowCommandPolicy;
	}
}
