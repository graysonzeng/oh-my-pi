import * as path from "node:path";
import type { ImplementationArtifactV1, VerificationArtifactV1, VerifierPort } from "../types";

function isMissingFile(err: unknown): boolean {
	return typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === "ENOENT";
}

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
	const files = new Set<string>();
	for (const line of patchContent.split("\n")) {
		// diff --git a/path b/path
		const git = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
		if (git?.[2]) {
			files.add(git[2]);
			continue;
		}
		// +++ b/path  (skip /dev/null)
		const plus = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
		if (plus?.[1] && plus[1] !== "/dev/null") {
			files.add(plus[1].replace(/^b\//, ""));
		}
	}
	return [...files];
}

export class ImplementationVerifyStage {
	readonly #verifier: VerifierPort;

	constructor(verifier: VerifierPort) {
		this.#verifier = verifier;
	}

	async execute(input: ImplementationVerifyInput): Promise<VerificationArtifactV1> {
		const impl = input.implementation;
		let patchContent: string | undefined;
		let changedFiles = [...(impl.changedFiles ?? [])];
		const cwd = input.cwd ?? process.cwd();

		// Collect current + prior patch paths (priorPatch: stored in unresolved after repair accumulate).
		const patchPaths = [
			impl.patchPath,
			...(impl.unresolved ?? [])
				.filter(u => u.startsWith("priorPatch:"))
				.map(u => u.slice("priorPatch:".length)),
		].filter((p): p is string => Boolean(p));

		const chunks: string[] = [];
		for (const patchPath of patchPaths) {
			const resolved = path.isAbsolute(patchPath) ? patchPath : path.join(cwd, patchPath);
			try {
				const text = await Bun.file(resolved).text();
				chunks.push(text);
				const fromPatch = changedFilesFromPatch(text);
				for (const f of fromPatch) {
					if (!changedFiles.includes(f)) changedFiles.push(f);
				}
			} catch (err) {
				if (!isMissingFile(err)) throw err;
			}
		}
		if (chunks.length > 0) patchContent = chunks.join("\n");

		// Fail closed: isolation write without readable patch/branch evidence is not verifiable.
		if (!impl.branchName && !patchContent) {
			return {
				kind: "verification",
				passed: false,
				checks: [
					{
						id: "isolation-artifact",
						status: "failed",
						summary: "Implementation lacks readable patch content or branch from isolation runtime",
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
		}

		return this.#verifier.verify(
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
	}
}
