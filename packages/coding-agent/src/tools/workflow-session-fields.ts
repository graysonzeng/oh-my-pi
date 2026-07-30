/**
 * Workflow-scoped ToolSession fields installed by prepareWorkflowInvocation.
 * Must be forwarded parent → ExecutorOptions → createAgentSession → createTools
 * or argumentAliases / processResult / path policies are silently dropped on the
 * embedded structured-subagent path.
 */

import type { ContextLedgerV1 } from "../workflow/context-ledger";
import type { ToolOptimizationReceiptV1 } from "../workflow/optimization-receipt";
import type { PromptAssemblyReceiptV1 } from "../workflow/prompt-assembly";
import type { ToolDescriptor } from "../workflow/schema-enhancer";

export type WorkflowToolOptimization = {
	processResult: (toolName: string, output: string, args?: unknown) => string;
	toolAliases?: Record<string, string>;
	argumentAliases?: Record<string, Record<string, string>>;
	/** Forwarded to Agent.toolScheduling when present. */
	maxConcurrentTools?: number;
	/**
	 * Remaining tool-call budget for this stage (mutable across batches).
	 * null/undefined = unlimited. Forwarded to Agent.toolScheduling.
	 */
	remainingToolCalls?: number | null;
	/** Remaining stage wall time ms; forwarded when set. */
	remainingStageTimeMs?: number | null;
	/**
	 * Resource conflict mode for concurrent tools.
	 * serialize/conservative (default), fail, or permissive.
	 */
	resourceConflictMode?: "serialize" | "fail" | "conservative" | "permissive";
	/**
	 * Catalog / alias transform applied to model-visible tool descriptors.
	 * Production runner and createAgentSession consume this.
	 */
	transformTools?: (tools: ToolDescriptor[]) => ToolDescriptor[];
	/**
	 * Mutable receipt log written by processResult when a lossy transform runs.
	 * Shared array identity — prepareWorkflowInvocation owns the array; live tools append.
	 */
	optimizationReceipts?: ToolOptimizationReceiptV1[];
	/** Last receipt (if any) for quick access without scanning the log. */
	lastOptimizationReceipt?: ToolOptimizationReceiptV1;
	/**
	 * Role allowlist used by catalog presentation expand (`xd://tools/{name}`).
	 * Expand refuses tools not in this set — catalog never elevates privileges.
	 */
	presentationAllowedTools?: readonly string[];
	/**
	 * Full tool schemas captured before catalog stubbing, keyed by tool name.
	 * Used by one-hop `xd://tools/{name}` expand on the real path.
	 */
	presentationToolSchemas?: Map<string, unknown>;
	/**
	 * Full skill bodies for catalog-only presentation, keyed by skill name.
	 * Used by one-hop `xd://skills/{name}` expand when bodies are omitted from the prompt.
	 */
	presentationSkillBodies?: Map<string, string>;
};

/** Optional durable attempt evidence attached on prepared workflow sessions. */
export type WorkflowAttemptEvidence = {
	promptAssemblyReceipt?: PromptAssemblyReceiptV1;
	contextLedger?: ContextLedgerV1;
};

export type WorkflowWritePolicy = { repoRoot: string; forbiddenPaths: string[] };
export type WorkflowCommandPolicy = { allowedCommands: string[] };

/** Slice of ToolSession that is workflow-stage scoped (not recreated by SDK defaults). */
export type WorkflowToolSessionFields = {
	workflowToolOptimization?: WorkflowToolOptimization;
	workflowWritePolicy?: WorkflowWritePolicy;
	workflowCommandPolicy?: WorkflowCommandPolicy;
	/** Attempt-level evidence (prompt assembly receipt, etc.). */
	workflowAttemptEvidence?: WorkflowAttemptEvidence;
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
	if (session.workflowAttemptEvidence) {
		out.workflowAttemptEvidence = session.workflowAttemptEvidence;
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
	if (fields.workflowAttemptEvidence) {
		target.workflowAttemptEvidence = fields.workflowAttemptEvidence;
	}
}
