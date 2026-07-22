import type { ArtifactHeader } from "../types";

export interface RepairArtifactV1 extends ArtifactHeader {
	kind: "repair";
	summary: string;
	findingsResolved: string[];
	patchPath?: string;
}

export class RepairStage {
	async execute(
		artifact: Pick<ArtifactHeader, "workflowId" | "attemptId">,
		findingsResolved: string[],
	): Promise<RepairArtifactV1> {
		return {
			kind: "repair",
			summary: "Repaired review findings",
			findingsResolved,
			workflowId: artifact.workflowId,
			attemptId: artifact.attemptId,
			stage: "repairing",
			schemaVersion: 1,
			createdAt: new Date().toISOString(),
			modelProfileId: "gpt_reviewer",
			provider: "openai",
			model: "gpt-5.*",
			promptVersion: "1.0",
		};
	}
}
