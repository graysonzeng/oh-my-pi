import type { Usage } from "@oh-my-pi/pi-ai";
import type { ToolSession } from "../../tools";
import { PlanArtifactJsonSchema } from "../json-schemas";
import { parseWorkflowArtifact } from "../parse-artifact";
import { PlanArtifactSchema } from "../schemas";
import type { ModelProfile, PlanArtifactV1, RuntimePort } from "../types";

export interface PlanStageInput {
	workflowId: string;
	attemptId: string;
	profile: ModelProfile;
	assignment: string;
	context: string;
	session: ToolSession;
	signal?: AbortSignal;
}

export interface PlanStageResult {
	artifact: PlanArtifactV1;
	usage?: Usage;
}

export class PlanStage {
	readonly #runtime: RuntimePort;

	constructor(runtime: RuntimePort) {
		this.#runtime = runtime;
	}

	async execute(input: PlanStageInput): Promise<PlanStageResult> {
		const request = this.#runtime.buildRequest({
			workflowId: input.workflowId,
			attemptId: input.attemptId,
			role: "planner",
			profile: input.profile,
			assignment: input.assignment,
			context: input.context,
			outputSchema: PlanArtifactJsonSchema,
			session: input.session,
			signal: input.signal,
		});
		const result = await this.#runtime.run<PlanArtifactV1>(request);
		const artifact = parseWorkflowArtifact(
			PlanArtifactSchema,
			{
				...result.artifact,
				kind: "plan",
				schemaVersion: 1,
				workflowId: input.workflowId,
				attemptId: input.attemptId,
				stage: "planning",
				createdAt: (result.artifact as PlanArtifactV1).createdAt ?? new Date().toISOString(),
				modelProfileId: input.profile.id,
				provider: input.profile.vendor,
				promptVersion: input.profile.promptVersion,
			},
			"PlanArtifact",
		);
		return { artifact, usage: result.usage };
	}
}
