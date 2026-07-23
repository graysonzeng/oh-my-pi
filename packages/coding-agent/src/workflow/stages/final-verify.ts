import * as path from "node:path";
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
			f => (f.status === "open" || f.status === "in_progress") && (f.priority === "P0" || f.priority === "P1"),
		);
		if (openBlocking.length > 0) {
			checks.push({
				id: "unresolved-findings",
				status: "failed",
				summary: `Unresolved blocking findings: ${openBlocking.map(f => f.id).join(", ")}`,
			});
		}

		return {
			...base,
			passed: checks.every(c => c.status !== "failed"),
			checks,
		};
	}
}
