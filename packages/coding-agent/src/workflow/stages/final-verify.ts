import * as path from "node:path";
import { evaluateWorkflowFinalCompletion } from "../../model-policy/completion";
import type { ScopeStatus } from "../scope-metrics";
import type { ImplementationArtifactV1, ReviewFindingV1, VerificationArtifactV1, VerifierPort } from "../types";
import { changedFilesFromPatch } from "./implementation-verify";

function isMissingFile(err: unknown): boolean {
	return typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === "ENOENT";
}

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
}

export class FinalVerifyStage {
	readonly #verifier: VerifierPort;

	constructor(verifier: VerifierPort) {
		this.#verifier = verifier;
	}

	async execute(input: FinalVerifyInput): Promise<VerificationArtifactV1> {
		const impl = input.implementation;
		let patchContent: string | undefined;
		let changedFiles = [...(impl?.changedFiles ?? [])];

		if (impl?.patchPath) {
			const resolved = path.isAbsolute(impl.patchPath)
				? impl.patchPath
				: path.join(input.cwd ?? process.cwd(), impl.patchPath);
			try {
				patchContent = await Bun.file(resolved).text();
				if (changedFiles.length === 0) {
					changedFiles = changedFilesFromPatch(patchContent);
				}
			} catch (err) {
				if (!isMissingFile(err)) throw err;
			}
		}

		const base = await this.#verifier.verify(
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

		return {
			...base,
			passed: completion.passed && checks.every(c => c.status !== "failed"),
			checks,
		};
	}
}
