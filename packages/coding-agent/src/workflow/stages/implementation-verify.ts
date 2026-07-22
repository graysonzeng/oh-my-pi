import type { VerificationArtifactV1 } from "../types";
import { Verifier } from "../verifier";

export class ImplementationVerifyStage {
	private verifier: Verifier;

	constructor() {
		this.verifier = new Verifier();
	}

	async execute(
		artifact: Pick<VerificationArtifactV1, "workflowId" | "attemptId" | "stage">,
	): Promise<VerificationArtifactV1> {
		const verify = await this.verifier.verify(artifact, ["npm run check", "bun test"]);
		return verify;
	}
}
