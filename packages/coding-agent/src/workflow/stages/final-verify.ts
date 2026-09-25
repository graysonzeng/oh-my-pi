import * as path from "node:path";
import { evaluateWorkflowFinalCompletion } from "../../model-policy/completion";
import type { ScopeStatus } from "../scope-metrics";
import type { ImplementationArtifactV1, ReviewFindingV1, VerificationArtifactV1, VerifierPort } from "../types";
import {
	assessVerificationReuse,
	buildVerificationCodeState,
	projectReusedVerificationChecks,
	resolveVerificationPatchEvidence,
	sealWorkflowVerifierResult,
} from "../verification-validity";

export interface FinalVerifyInput {
	workflowId: string;
	attemptId: string;
	commands: string[];
	forbiddenPaths?: string[];
	implementation?: ImplementationArtifactV1 | null;
	openFindings?: ReviewFindingV1[];
	/** Existing scope metrics status from engine (typed artifact, not model self-report). */
	scopeStatus?: ScopeStatus;
	signal?: AbortSignal;
	timeoutMs?: number;
	cwd?: string;
	/**
	 * Prior sealed verification (typically implementation_verify). When still
	 * valid for the same code state + commands, command checks are reused
	 * instead of re-running; completion gates still always run.
	 */
	priorVerification?: VerificationArtifactV1 | null;
}

export class FinalVerifyStage {
	readonly #verifier: VerifierPort;

	constructor(verifier: VerifierPort) {
		this.#verifier = verifier;
	}

	async execute(input: FinalVerifyInput): Promise<VerificationArtifactV1> {
		const impl = input.implementation;
		const cwd = input.cwd ?? process.cwd();
		const { patchContent, changedFiles } = await resolveVerificationPatchEvidence(impl, cwd);

		const codeState = buildVerificationCodeState({
			implementation: impl,
			patchContent,
			changedFiles,
		});
		const scope =
			changedFiles.length > 0
				? { kind: "paths" as const, paths: changedFiles }
				: { kind: "commands" as const };

		const reuse = assessVerificationReuse({
			prior: input.priorVerification,
			codeState,
			commands: input.commands,
			scope,
		});

		let base: VerificationArtifactV1;
		if (reuse.reusable && input.priorVerification) {
			base = projectReusedVerificationChecks(input.priorVerification, {
				workflowId: input.workflowId,
				attemptId: input.attemptId,
				stage: "final_verify",
			});
			// Command checks are reused, but current forbidden-path policy still applies.
			const forbidden = input.forbiddenPaths ?? [];
			const forbiddenFile = changedFiles.find(file =>
				forbidden.some(entry => {
					const normalizedFile = path.normalize(file);
					const normalizedForbidden = path.normalize(entry);
					return (
						normalizedFile === normalizedForbidden ||
						normalizedFile.startsWith(`${normalizedForbidden}${path.sep}`)
					);
				}),
			);
			if (forbiddenFile) {
				base = {
					...base,
					passed: false,
					checks: [
						...base.checks,
						{
							id: "forbidden-paths",
							status: "failed",
							summary: `Changed file is inside a forbidden path: ${forbiddenFile}`,
						},
					],
				};
			}
		} else {
			base = await this.#verifier.verify(
				{
					workflowId: input.workflowId,
					attemptId: input.attemptId,
					stage: "final_verify",
					changedFiles,
					patchContent,
				},
				input.commands,
				input.forbiddenPaths ?? [],
				{ signal: input.signal, timeoutMs: input.timeoutMs },
			);
			base = sealWorkflowVerifierResult(base, {
				commands: input.commands,
				codeState,
				scope,
			});
		}

		const checks = [...base.checks];
		const openBlocking = (input.openFindings ?? []).filter(
			f => (f.status === "open" || f.status === "in_progress") && f.blocking === true,
		);
		if (openBlocking.length > 0) {
			checks.push({
				id: "unresolved-findings",
				status: "failed",
				summary: `Unresolved blocking findings: ${openBlocking.map(f => f.id).join(", ")}`,
			});
		}

		// Shared pure completion gate — implementation missing/unresolved, open
		// blocking findings, verification fail, and scope violation all block completed.
		const completion = evaluateWorkflowFinalCompletion({
			implementation: impl ?? null,
			openBlockingFindings: openBlocking.map(f => ({ id: f.id, summary: f.summary })),
			verification: {
				passed: checks.every(c => c.status !== "failed"),
				checks,
			},
			scopeStatus: input.scopeStatus,
		});

		if (!completion.passed) {
			const reasonSummary = completion.reasons.join("; ") || completion.decision;
			if (!checks.some(c => c.id === "completion-gate")) {
				checks.push({
					id: "completion-gate",
					status: "failed",
					summary: `Completion gate ${completion.decision}: ${reasonSummary}`,
				});
			}
		}

		return sealWorkflowVerifierResult(
			{
				...base,
				passed: completion.passed && checks.every(c => c.status !== "failed"),
				checks,
			},
			{
				commands: input.commands,
				codeState,
				scope,
			},
		);
	}
}
