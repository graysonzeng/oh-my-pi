import * as path from "node:path";
import { evaluateWorkflowFinalCompletion } from "../../model-policy/completion";
import { buildLayeredVerificationPlan, layeredVerificationObserveEvents } from "../layered-verification";
import type { ScopeStatus } from "../scope-metrics";
import type { ImplementationArtifactV1, ReviewFindingV1, VerificationArtifactV1, VerifierPort } from "../types";
import {
	buildVerificationCodeState,
	captureVerificationWorkspace,
	projectReusedVerificationChecks,
	resolveVerificationPatchEvidence,
	sealWorkflowVerifierResult,
	verificationExecutionCwd,
} from "../verification-validity";
import { noteVerificationObserve, type EvidenceHandoffObservePersistSink } from "../../task/evidence-handoff-observe";

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
	/** Fallback when the verifier does not expose its execution directory. */
	cwd?: string;
	/**
	 * Prior sealed verification (typically implementation_verify). Command checks
	 * are reused only when patch identity and the executed workspace still match.
	 * Completion gates still always run.
	 */
	priorVerification?: VerificationArtifactV1 | null;
	/**
	 * Local/scoped commands already green for this code state (Package 3).
	 * Final layer may skip re-running them only when a trusted prior seal still
	 * matches — never after code/command/scope mismatch.
	 */
	alreadyGreenLocalCommands?: readonly string[];
	/** Durable observe sink (Batch 1 W3) — session custom entries. */
	observeSink?: EvidenceHandoffObservePersistSink;
}

export class FinalVerifyStage {
	readonly #verifier: VerifierPort;

	constructor(verifier: VerifierPort) {
		this.#verifier = verifier;
	}

	async execute(input: FinalVerifyInput): Promise<VerificationArtifactV1> {
		const impl = input.implementation;
		const executedCwd = verificationExecutionCwd(this.#verifier);
		const patchCwd = executedCwd ?? input.cwd ?? process.cwd();
		const { patchContent, changedFiles } = await resolveVerificationPatchEvidence(impl, patchCwd);
		const workspace = executedCwd
			? ((await captureVerificationWorkspace(executedCwd, input.signal)) ?? undefined)
			: undefined;

		const codeState = buildVerificationCodeState({
			implementation: impl,
			patchContent,
			changedFiles,
			workspace,
		});
		const scope =
			changedFiles.length > 0 ? { kind: "paths" as const, paths: changedFiles } : { kind: "repo" as const };

		// Package 3 layered planner owns final_repo reuse vs run dispositions.
		const plan = buildLayeredVerificationPlan({
			layer: "final_repo",
			commands: input.commands,
			codeState,
			scope,
			priorVerification: input.priorVerification,
			alreadyGreenLocalCommands: input.alreadyGreenLocalCommands,
		});
		if (input.observeSink) {
			for (const event of layeredVerificationObserveEvents(plan, {
				eventIdPrefix: `wf:${input.workflowId}:${input.attemptId}:final_verify`,
			})) {
				noteVerificationObserve({ ...event, sink: input.observeSink });
			}
		}
		const canReuse = plan.toReuse.length > 0 && plan.toRun.length === 0 && Boolean(input.priorVerification);

		let base: VerificationArtifactV1;
		if (canReuse && input.priorVerification) {
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
			const commandsToRun = plan.toRun.length > 0 ? plan.toRun : input.commands;
			base = await this.#verifier.verify(
				{
					workflowId: input.workflowId,
					attemptId: input.attemptId,
					stage: "final_verify",
					changedFiles,
					patchContent,
				},
				commandsToRun,
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
