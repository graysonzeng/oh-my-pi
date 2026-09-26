import { parsePatchTouchedFiles } from "../../utils/parse-patch-touched-files";
import { buildLayeredVerificationPlan } from "../layered-verification";
import type { ImplementationArtifactV1, VerificationArtifactV1, VerifierPort } from "../types";
import {
	buildVerificationCodeState,
	captureVerificationWorkspace,
	resolveVerificationPatchEvidence,
	sealWorkflowVerifierResult,
	verificationExecutionCwd,
} from "../verification-validity";

export interface ImplementationVerifyInput {
	workflowId: string;
	attemptId: string;
	implementation: ImplementationArtifactV1;
	commands: string[];
	forbiddenPaths?: string[];
	signal?: AbortSignal;
	timeoutMs?: number;
	/** Fallback when the verifier does not expose its execution directory. */
	cwd?: string;
	/**
	 * When true, slice_local delivers a checklist only (Package 3) — commands
	 * are not auto-run by this stage.
	 */
	parentOwnsVerify?: boolean;
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
		const executedCwd = verificationExecutionCwd(this.#verifier);
		const patchCwd = executedCwd ?? input.cwd ?? process.cwd();
		const { patchContent, changedFiles } = await resolveVerificationPatchEvidence(impl, patchCwd);
		const workspace = executedCwd
			? ((await captureVerificationWorkspace(executedCwd, input.signal)) ?? undefined)
			: undefined;

		const codeState = buildVerificationCodeState({
			implementation: impl,
			patchContent: patchContent ?? undefined,
			changedFiles,
			workspace,
		});
		const scope = changedFiles.length ? { kind: "paths" as const, paths: changedFiles } : { kind: "repo" as const };

		// Package 3 slice_local planner — parent-owned verify → checklist only.
		const plan = buildLayeredVerificationPlan({
			layer: "slice_local",
			commands: input.commands,
			codeState,
			scope,
			parentOwnsVerify: input.parentOwnsVerify === true,
		});

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
			return sealWorkflowVerifierResult(failed, {
				commands: input.commands,
				codeState,
				scope,
			});
		}

		if (input.parentOwnsVerify === true && plan.toRun.length === 0) {
			// Checklist-only (parent owns verify) — seal a passed-local artifact
			// with skipped reasons, without auto-running the full suite.
			const checklist: VerificationArtifactV1 = {
				kind: "verification",
				passed: true,
				checks: plan.skipped.map(item => ({
					id: item.id,
					status: "skipped" as const,
					summary: item.reason,
				})),
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
			return sealWorkflowVerifierResult(checklist, {
				commands: input.commands,
				codeState,
				scope,
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
			plan.toRun.length > 0 ? plan.toRun : input.commands,
			input.forbiddenPaths ?? [],
			{
				signal: input.signal,
				timeoutMs: input.timeoutMs,
				expectDirtyTree: changedFiles.length > 0 || Boolean(impl.patchPath) || Boolean(impl.branchName),
			},
		);

		return sealWorkflowVerifierResult(result, {
			commands: input.commands,
			codeState,
			scope,
		});
	}
}
