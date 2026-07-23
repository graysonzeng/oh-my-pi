import type { Usage } from "@oh-my-pi/pi-ai";
import type { ToolSession } from "../../tools";
import { WorkflowPolicyError } from "../errors";
import { ImplementationArtifactJsonSchema } from "../json-schemas";
import { parseWorkflowArtifact } from "../parse-artifact";
import { ImplementationArtifactSchema } from "../schemas";
import type { ImplementationArtifactV1, ModelProfile, ReviewFindingV1, RuntimePort } from "../types";

export interface RepairStageInput {
	workflowId: string;
	attemptId: string;
	profile: ModelProfile;
	findingIds: string[];
	findings: ReviewFindingV1[];
	assignment: string;
	context: string;
	session: ToolSession;
	signal?: AbortSignal;
	isolation?: { merge?: "patch" | "branch"; apply?: boolean };
}

export interface RepairStageResult {
	artifact: ImplementationArtifactV1;
	usage?: Usage;
	changesApplied?: boolean | null;
}

export class RepairStage {
	readonly #runtime: RuntimePort;

	constructor(runtime: RuntimePort) {
		this.#runtime = runtime;
	}

	async execute(input: RepairStageInput): Promise<RepairStageResult> {
		const isolation = {
			requested: true,
			merge: input.isolation?.merge ?? "patch",
			apply: input.isolation?.apply ?? true,
		};
		const request = this.#runtime.buildRequest({
			workflowId: input.workflowId,
			attemptId: input.attemptId,
			role: "repair",
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
		// Trust only runtime isolation metadata for patch/branch.
		const patchPath = result.patchPath;
		const branchName = result.branchName;
		if (!patchPath && !branchName) {
			throw new WorkflowPolicyError("repair_missing_isolation_artifact", {
				attemptId: input.attemptId,
				hint: "Repair must return patchPath or branchName from the runtime adapter",
			});
		}
		// Empty addressedStepIds must NOT auto-resolve all findings (fail-closed honesty).
		const addressed =
			Array.isArray(modelArtifact.addressedStepIds) && modelArtifact.addressedStepIds.length > 0
				? modelArtifact.addressedStepIds.filter(id => input.findingIds.includes(id))
				: [];
		const artifact = parseWorkflowArtifact(
			ImplementationArtifactSchema,
			{
				...modelArtifact,
				kind: "implementation",
				schemaVersion: 1,
				workflowId: input.workflowId,
				attemptId: input.attemptId,
				stage: "repairing",
				createdAt: modelArtifact.createdAt ?? new Date().toISOString(),
				modelProfileId: input.profile.id,
				provider: input.profile.vendor,
				promptVersion: input.profile.promptVersion,
				patchPath,
				branchName,
				addressedStepIds: addressed,
				// Preserve unrepaired finding ids for audit.
				unresolved: input.findingIds.filter(id => !addressed.includes(id)),
				commandsRun: modelArtifact.commandsRun ?? [],
				changedFiles: modelArtifact.changedFiles ?? [],
				summary: modelArtifact.summary ?? "repair",
			},
			"RepairArtifact",
		);
		return { artifact, usage: result.usage, changesApplied: result.changesApplied };
	}
}
