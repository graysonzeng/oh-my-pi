import type { StructuredSubagentRequest } from "../task/structured-subagent";
import { runStructuredSubagent } from "../task/structured-subagent";
import type { WorkflowAgentRequest, WorkflowAgentResult } from "./types";

export class RuntimeAdapter {
	buildRequest(request: WorkflowAgentRequest): WorkflowAgentRequest {
		return request;
	}

	async run<TArtifact = unknown>(request: WorkflowAgentRequest): Promise<WorkflowAgentResult<TArtifact>> {
		const mappedRequest: StructuredSubagentRequest = {
			session: request.session,
			invocationKind: "task",
			assignment: request.assignment,
			context: request.context,
			agent: request.role,
			model: request.profile.modelPattern,
			outputSchema: request.outputSchema,
			schemaMode: "strict",
			isolation: request.isolation,
			maxRuntimeMs: request.profile.maxRuntimeMs,
			signal: request.signal,
		};
		const result = await runStructuredSubagent(mappedRequest);
		const structured = result.result.structuredOutput;
		if (structured?.status !== "valid") {
			throw new Error(structured?.error ?? "Workflow subagent did not return a valid structured artifact");
		}
		return {
			artifact: structured.data as TArtifact,
			rawResultId: result.result.id,
			attemptId: request.attemptId,
			patchPath: result.result.patchPath,
			branchName: result.result.branchName,
			usage: result.result.usage,
		};
	}
}
