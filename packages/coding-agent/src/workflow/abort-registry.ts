/**
 * In-process abort registry so tool `cancel` can signal an in-flight engine
 * even though each tool call constructs a new WorkflowEngine instance.
 */
interface AbortRegistration {
	controller: AbortController;
	owner: object;
}

const controllers = new Map<string, AbortRegistration>();

export function registerWorkflowAbort(
	workflowId: string,
	controller: AbortController,
	owner: object = controller,
): object {
	if (controllers.has(workflowId)) return owner;
	controllers.set(workflowId, { controller, owner });
	return owner;
}

export function unregisterWorkflowAbort(workflowId: string, owner: object): boolean {
	const registration = controllers.get(workflowId);
	if (!registration || registration.owner !== owner) return false;
	return controllers.delete(workflowId);
}

/** Abort a running workflow if this process holds its controller. Returns true if signaled. */
export function abortRegisteredWorkflow(workflowId: string, reason?: string): boolean {
	const registration = controllers.get(workflowId);
	if (!registration) return false;
	if (!registration.controller.signal.aborted) {
		registration.controller.abort(reason ?? "workflow cancelled");
	}
	return true;
}
