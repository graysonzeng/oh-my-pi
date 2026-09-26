import { parsePatchTouchedFiles } from "../../utils/parse-patch-touched-files";
import { buildLayeredVerificationPlan, layeredVerificationObserveEvents } from "../layered-verification";
import type { ImplementationArtifactV1, VerificationArtifactV1, VerifierPort } from "../types";
import {
	buildVerificationCodeState,
	captureVerificationWorkspace,
	resolveVerificationPatchEvidence,
	sealWorkflowVerifierResult,
	verificationExecutionCwd,
} from "../verification-validity";
import { noteVerificationObserve, type EvidenceHandoffObservePersistSink } from "../../task/evidence-handoff-observe";

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
	/** Durable observe sink (Batch 1 W3) — session custom entries. */
	observeSink?: EvidenceHandoffObservePersistSink;
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
		if (input.observeSink) {
			for (const event of layeredVerificationObserveEvents(plan, {
				eventIdPrefix: `wf:${input.workflowId}:${input.attemptId}:implementation_verify`,
			})) {
				noteVerificationObserve({ ...event, sink: input.observeSink });
			}
		}

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
			// Checklist-only (parent owns verify) — record skipped reasons without
			// sealing a trusted green. Stage may still advance on `passed: true`
			// (checklist delivered); delivery/reuse gates reject skipped-only.
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
			// Intentionally unsealed — sealWorkflowVerifierResult would mint a
			// trusted owner that final_verify could treat as reusable green.
			return checklist;
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
