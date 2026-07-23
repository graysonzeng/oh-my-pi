import type { Usage } from "@oh-my-pi/pi-ai";
import type { ToolSession } from "../../tools";
import { ReviewArtifactJsonSchema } from "../json-schemas";
import { parseWorkflowArtifact } from "../parse-artifact";
import { ReviewArtifactSchema } from "../schemas";
import type { ModelProfile, ReviewArtifactV1, RuntimePort } from "../types";

export interface PlanReviewStageInput {
	workflowId: string;
	attemptId: string;
	profile: ModelProfile;
	assignment: string;
	context: string;
	session: ToolSession;
	signal?: AbortSignal;
}

export interface PlanReviewStageResult {
	artifact: ReviewArtifactV1;
	usage?: Usage;
}

export class PlanReviewStage {
	readonly #runtime: RuntimePort;

	constructor(runtime: RuntimePort) {
		this.#runtime = runtime;
	}

	async execute(input: PlanReviewStageInput): Promise<PlanReviewStageResult> {
		const request = this.#runtime.buildRequest({
			workflowId: input.workflowId,
			attemptId: input.attemptId,
			role: "plan_reviewer",
			profile: input.profile,
			assignment: input.assignment,
			context: input.context,
			outputSchema: ReviewArtifactJsonSchema,
			session: input.session,
			signal: input.signal,
		});
		const result = await this.#runtime.run<ReviewArtifactV1>(request);
		const artifact = parseWorkflowArtifact(
			ReviewArtifactSchema,
			{
				...result.artifact,
				kind: "review",
				subject: "plan",
				schemaVersion: 1,
				workflowId: input.workflowId,
				attemptId: input.attemptId,
				stage: "plan_review",
				createdAt: (result.artifact as ReviewArtifactV1).createdAt ?? new Date().toISOString(),
				modelProfileId: input.profile.id,
				provider: input.profile.vendor,
				promptVersion: input.profile.promptVersion,
			},
			"PlanReviewArtifact",
		);
		return { artifact, usage: result.usage };
	}
}
