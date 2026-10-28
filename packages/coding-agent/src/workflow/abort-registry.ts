/**
 * In-process abort registry so tool `cancel` can signal an in-flight engine
 * even though each tool call constructs a new WorkflowEngine instance.
 */
interface AbortRegistration {
	controller: AbortController;
	owner: object;
	settled: Promise<void>;
	resolveSettled: () => void;
}

const controllers = new Map<string, AbortRegistration>();

export function registerWorkflowAbort(
	workflowId: string,
	controller: AbortController,
	owner: object = controller,
): object {
	if (controllers.has(workflowId)) return owner;
	const settled = Promise.withResolvers<void>();
	controllers.set(workflowId, {
		controller,
		owner,
		settled: settled.promise,
		resolveSettled: settled.resolve,
	});
	return owner;
}

export function unregisterWorkflowAbort(workflowId: string, owner: object): boolean {
	const registration = controllers.get(workflowId);
	if (!registration || registration.owner !== owner) return false;
	controllers.delete(workflowId);
	registration.resolveSettled();
	return true;
}

/** Current runner settlement barrier, captured before signalling cancellation. */
export function workflowAbortSettlement(workflowId: string): Promise<void> | undefined {
	return controllers.get(workflowId)?.settled;
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
