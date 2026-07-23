/**
 * In-process abort registry so tool `cancel` can signal an in-flight engine
 * even though each tool call constructs a new WorkflowEngine instance.
 */
const controllers = new Map<string, AbortController>();

export function registerWorkflowAbort(workflowId: string, controller: AbortController): void {
	controllers.set(workflowId, controller);
}

export function unregisterWorkflowAbort(workflowId: string): void {
	controllers.delete(workflowId);
}

/** Abort a running workflow if this process holds its controller. Returns true if signaled. */
export function abortRegisteredWorkflow(workflowId: string, reason?: string): boolean {
	const controller = controllers.get(workflowId);
	if (!controller) return false;
	if (!controller.signal.aborted) {
		controller.abort(reason ?? "workflow cancelled");
	}
	return true;
}
