import type { ToolSession } from "../tools";
import { WorkflowEngine } from "./engine";
import { createSessionPipelineAuditor } from "./pipeline-auditor";
import { createDefaultAvailabilityPort, createDefaultRuntimeAdapter } from "./runtime-default";
import { buildWorkflowConfigFromSessionSettings } from "./session-config";
import { WorkflowStore } from "./sqlite-store";

/** Production WorkflowEngine: settings, default adapter, Flash completeness auditor. */
export function createEngineFromSessionSettings(session: ToolSession): WorkflowEngine {
	const raw = (key: string): unknown => session.settings?.get?.(key as never);
	const storageRaw = raw("workflow.storagePath");
	const storage = typeof storageRaw === "string" && storageRaw.length > 0 ? storageRaw : "";
	const store = storage ? new WorkflowStore(storage) : new WorkflowStore();
	return new WorkflowEngine({
		store,
		ownsStore: true,
		session,
		adapter: createDefaultRuntimeAdapter(),
		availability: createDefaultAvailabilityPort(),
		config: buildWorkflowConfigFromSessionSettings(raw),
		pipelineAuditor: createSessionPipelineAuditor(session),
	});
}
