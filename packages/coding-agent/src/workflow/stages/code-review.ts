import type { Usage } from "@oh-my-pi/pi-ai";
import type { ToolSession } from "../../tools";
import { ReviewArtifactJsonSchema } from "../json-schemas";
import { parseWorkflowArtifact } from "../parse-artifact";
import { ReviewArtifactSchema } from "../schemas";
import type { ModelProfile, ReviewArtifactV1, RuntimePort } from "../types";

export interface CodeReviewStageInput {
	workflowId: string;
	attemptId: string;
	profile: ModelProfile;
	assignment: string;
	context: string;
	session: ToolSession;
	signal?: AbortSignal;
	/** Confidence below this is advisory only (engine still sees findings). */
	confidenceThreshold?: number;
}

export interface CodeReviewStageResult {
	artifact: ReviewArtifactV1;
	usage?: Usage;
}

export class CodeReviewStage {
	readonly #runtime: RuntimePort;

	constructor(runtime: RuntimePort) {
		this.#runtime = runtime;
	}

	async execute(input: CodeReviewStageInput): Promise<CodeReviewStageResult> {
		const request = this.#runtime.buildRequest({
			workflowId: input.workflowId,
			attemptId: input.attemptId,
			role: "code_reviewer",
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
				subject: "implementation",
				schemaVersion: 1,
				workflowId: input.workflowId,
				attemptId: input.attemptId,
				stage: "code_review",
				createdAt: (result.artifact as ReviewArtifactV1).createdAt ?? new Date().toISOString(),
				modelProfileId: input.profile.id,
				provider: input.profile.vendor,
				promptVersion: input.profile.promptVersion,
			},
			"CodeReviewArtifact",
		);
		return { artifact, usage: result.usage };
	}
}
