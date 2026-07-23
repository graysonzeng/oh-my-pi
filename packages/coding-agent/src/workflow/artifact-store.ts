import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactIntegrityError } from "./errors";
import type { Artifact } from "./types";

/** Default outside the repo so artifacts never pollute git status. */
export function defaultWorkflowArtifactDir(): string {
	return path.join(os.homedir(), ".omp", "workflow-artifacts");
}

export class ArtifactStore {
	readonly #baseDir: string;

	constructor(baseDir: string = defaultWorkflowArtifactDir()) {
		this.#baseDir = baseDir;
	}

	get baseDir(): string {
		return this.#baseDir;
	}

	async store(
		artifact: Omit<Artifact, "id" | "createdAt" | "sha256"> & { content: string; sha256?: string },
	): Promise<Artifact> {
		const id = `art_${randomUUID()}`;
		const content = artifact.content;
		const sha256 = artifact.sha256 ?? this.computeSha256(content);
		const relativePath = artifact.relativePath || path.join(artifact.workflowId, `${id}.json`);
		const filePath = path.join(this.#baseDir, relativePath);
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(filePath, content, "utf8");
		return {
			id,
			workflowId: artifact.workflowId,
			attemptId: artifact.attemptId,
			kind: artifact.kind,
			schemaVersion: artifact.schemaVersion,
			relativePath,
			sha256,
			createdAt: new Date().toISOString(),
			content,
		};
	}

	async load(relativePath: string, expectedSha256?: string): Promise<Artifact | null> {
		const filePath = path.join(this.#baseDir, relativePath);
		try {
			const content = await fs.readFile(filePath, "utf8");
			const sha256 = this.computeSha256(content);
			if (expectedSha256 && sha256 !== expectedSha256) {
				throw new ArtifactIntegrityError("artifact_hash_mismatch", {
					relativePath,
					expectedSha256,
					actualSha256: sha256,
				});
			}
			// Metadata may be embedded JSON body, or plain content blob
			let parsed: Partial<Artifact> = {};
			try {
				parsed = JSON.parse(content) as Partial<Artifact>;
			} catch {
				// raw content blob
			}
			return {
				id: parsed.id ?? path.basename(relativePath, path.extname(relativePath)),
				workflowId: parsed.workflowId ?? "",
				attemptId: parsed.attemptId ?? "",
				kind: parsed.kind ?? "unknown",
				schemaVersion: parsed.schemaVersion ?? 1,
				relativePath,
				sha256,
				createdAt: parsed.createdAt ?? new Date(0).toISOString(),
				content,
			};
		} catch (error) {
			if (error instanceof ArtifactIntegrityError) throw error;
			// Only missing files are soft-null; permission/IO failures must surface.
			if (error && typeof error === "object" && "code" in error && (error as { code: unknown }).code === "ENOENT") {
				return null;
			}
			throw error;
		}
	}

	computeSha256(content: string): string {
		return createHash("sha256").update(content).digest("hex");
	}

	async listByWorkflow(workflowId: string): Promise<Artifact[]> {
		const dir = path.join(this.#baseDir, workflowId);
		let entries: string[];
		try {
			entries = await fs.readdir(dir);
		} catch {
			return [];
		}
		const out: Artifact[] = [];
		for (const entry of entries) {
			const relativePath = path.join(workflowId, entry);
			const loaded = await this.load(relativePath);
			if (loaded) out.push(loaded);
		}
		return out;
	}
}
