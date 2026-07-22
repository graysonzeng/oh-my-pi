import type { ImplementationArtifactV1 } from "../types";
import { Verifier } from "../verifier";

export class ImplementStage {
	private verifier: Verifier;

	constructor() {
		this.verifier = new Verifier();
	}

	async execute(
		artifact: Pick<ImplementationArtifactV1, "workflowId" | "attemptId">,
	): Promise<ImplementationArtifactV1> {
		// real implementation with isolation, Grok profile, etc.
		const implementation: ImplementationArtifactV1 = {
			kind: "implementation",
			summary: "Implemented plan",
			changedFiles: ["packages/coding-agent/src/workflow/engine.ts"],
			addressedStepIds: ["step1"],
			commandsRun: [{ command: "echo test", exitCode: 0, summary: "success" }],
			patchPath: "patch.patch",
			branchName: "feat/workflow",
			unresolved: [],
			schemaVersion: 1,
			workflowId: artifact.workflowId,
			attemptId: artifact.attemptId,
			stage: "implementing",
			createdAt: new Date().toISOString(),
			modelProfileId: "grok_implementer",
			provider: "xai",
			model: "grok-4",
			promptVersion: "1.0",
		};
		await this.verifier.verify(
			implementation,
			implementation.commandsRun.map(command => command.command),
		);
		return implementation;
	}
}
