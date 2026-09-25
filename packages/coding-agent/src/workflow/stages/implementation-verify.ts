import * as path from "node:path";
import { parsePatchTouchedFiles } from "../../utils/parse-patch-touched-files";
import type { ImplementationArtifactV1, VerificationArtifactV1, VerifierPort } from "../types";
import {
	buildVerificationCodeState,
	resolveVerificationPatchEvidence,
	sealWorkflowVerifierResult,
} from "../verification-validity";

export interface ImplementationVerifyInput {
	workflowId: string;
	attemptId: string;
	implementation: ImplementationArtifactV1;
	commands: string[];
	forbiddenPaths?: string[];
	signal?: AbortSignal;
	timeoutMs?: number;
	/** Workspace root used to resolve relative patchPath. */
	cwd?: string;
}

/** Best-effort path extraction from unified diff headers. */
export function changedFilesFromPatch(patchContent: string): string[] {
	return parsePatchTouchedFiles(patchContent);
}

export class ImplementationVerifyStage {
	readonly #verifier: VerifierPort;

	constructor(verifier: VerifierPort) {
		this.#verifier = verifier;
	}

	async execute(input: ImplementationVerifyInput): Promise<VerificationArtifactV1> {
		const impl = input.implementation;
		const cwd = input.cwd ?? process.cwd();
		const { patchContent, changedFiles } = await resolveVerificationPatchEvidence(impl, cwd);

		// Branch names and model-reported files are not diff evidence.
		if (!patchContent) {
			const failed: VerificationArtifactV1 = {
				kind: "verification",
				passed: false,
				checks: [
					{
						id: "isolation-artifact",
						status: "failed",
						summary: "Implementation lacks readable persisted patch content from isolation runtime",
					},
				],
				schemaVersion: 1,
				workflowId: input.workflowId,
				attemptId: input.attemptId,
				stage: "implementation_verify",
				createdAt: new Date().toISOString(),
				modelProfileId: impl.modelProfileId,
				provider: impl.provider,
				model: impl.model,
				promptVersion: impl.promptVersion,
			};
			const codeState = buildVerificationCodeState({
				implementation: impl,
				changedFiles,
			});
			return sealWorkflowVerifierResult(failed, {
				commands: input.commands,
				codeState,
			});
		}

		const result = await this.#verifier.verify(
			{
				workflowId: input.workflowId,
				attemptId: input.attemptId,
				stage: "implementation_verify",
				changedFiles,
				patchContent,
				modelProfileId: impl.modelProfileId,
				provider: impl.provider,
				model: impl.model,
				promptVersion: impl.promptVersion,
			},
			input.commands,
			input.forbiddenPaths ?? [],
			{
				signal: input.signal,
				timeoutMs: input.timeoutMs,
				expectDirtyTree: changedFiles.length > 0 || Boolean(impl.patchPath) || Boolean(impl.branchName),
			},
		);

		const codeState = buildVerificationCodeState({
			implementation: impl,
			patchContent,
			changedFiles,
		});
		return sealWorkflowVerifierResult(result, {
			commands: input.commands,
			codeState,
			scope: changedFiles.length ? { kind: "paths", paths: changedFiles } : { kind: "repo" },
		});
	}
}
