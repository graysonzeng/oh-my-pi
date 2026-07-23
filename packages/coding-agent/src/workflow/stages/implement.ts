import type { Usage } from "@oh-my-pi/pi-ai";
import type { ToolSession } from "../../tools";
import { WorkflowPolicyError } from "../errors";
import { ImplementationArtifactJsonSchema } from "../json-schemas";
import { parseWorkflowArtifact } from "../parse-artifact";
import { ImplementationArtifactSchema } from "../schemas";
import type { ImplementationArtifactV1, ModelProfile, RuntimePort } from "../types";

export interface ImplementStageInput {
	workflowId: string;
	attemptId: string;
	profile: ModelProfile;
	assignment: string;
	context: string;
	session: ToolSession;
	signal?: AbortSignal;
	isolation?: { requested?: boolean; merge?: "patch" | "branch"; apply?: boolean };
}

export interface ImplementStageResult {
	artifact: ImplementationArtifactV1;
	usage?: Usage;
	changesApplied?: boolean | null;
}

export class ImplementStage {
	readonly #runtime: RuntimePort;

	constructor(runtime: RuntimePort) {
		this.#runtime = runtime;
	}

	async execute(input: ImplementStageInput): Promise<ImplementStageResult> {
		const isolation = {
			merge: input.isolation?.merge ?? "patch",
			apply: input.isolation?.apply ?? true,
			...input.isolation,
			requested: true, // isolation required for write stages
		};
		const request = this.#runtime.buildRequest({
			workflowId: input.workflowId,
			attemptId: input.attemptId,
			role: "implementer",
			profile: input.profile,
			assignment: input.assignment,
			context: input.context,
			outputSchema: ImplementationArtifactJsonSchema,
			isolation,
			session: input.session,
			signal: input.signal,
		});
		const result = await this.#runtime.run<ImplementationArtifactV1>(request);
		const modelArtifact = result.artifact as ImplementationArtifactV1;
		// Trust only runtime isolation metadata for patch/branch — never model fiction alone.
		const patchPath = result.patchPath;
		const branchName = result.branchName;
		if (isolation.requested && !patchPath && !branchName) {
			throw new WorkflowPolicyError("implementation_missing_isolation_artifact", {
				attemptId: input.attemptId,
				hint: "Isolation write stages must return patchPath or branchName from the runtime adapter",
			});
		}
		const artifact = parseWorkflowArtifact(
			ImplementationArtifactSchema,
			{
				...modelArtifact,
				kind: "implementation",
				schemaVersion: 1,
				workflowId: input.workflowId,
				attemptId: input.attemptId,
				stage: "implementing",
				createdAt: modelArtifact.createdAt ?? new Date().toISOString(),
				modelProfileId: input.profile.id,
				provider: input.profile.vendor,
				promptVersion: input.profile.promptVersion,
				patchPath,
				branchName,
				// Model-reported changedFiles are advisory only when a real patch exists;
				// empty until verify derives paths from patch content.
				changedFiles: modelArtifact.changedFiles ?? [],
				commandsRun: modelArtifact.commandsRun ?? [],
				addressedStepIds: modelArtifact.addressedStepIds ?? [],
				unresolved: modelArtifact.unresolved ?? [],
				summary: modelArtifact.summary ?? "implementation",
			},
			"ImplementationArtifact",
		);
		return { artifact, usage: result.usage, changesApplied: result.changesApplied };
	}
}
