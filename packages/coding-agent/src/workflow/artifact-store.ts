import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Artifact } from "./types";

export class ArtifactStore {
	constructor(private readonly baseDir: string = path.join(process.cwd(), ".workflow-artifacts")) {}

	async store(artifact: Omit<Artifact, "id" | "createdAt">): Promise<Artifact> {
		const id = `art_${Date.now()}_${Math.random().toString(36).slice(2)}`;
		const filePath = path.join(this.baseDir, id);
		const sha256 = await this.computeSha256(artifact.content || "");
		const content = JSON.stringify(artifact, null, 2);
		await fs.mkdir(this.baseDir, { recursive: true });
		await fs.writeFile(filePath, content);
		return {
			id,
			...artifact,
			createdAt: new Date().toISOString(),
			sha256,
		};
	}

	async load(id: string): Promise<Artifact | null> {
		const filePath = path.join(this.baseDir, id);
		try {
			const content = await fs.readFile(filePath, "utf8");
			return JSON.parse(content);
		} catch {
			return null;
		}
	}

	async computeSha256(content: string): Promise<string> {
		return createHash("sha256").update(content).digest("hex");
	}

	async listByWorkflow(workflowId: string): Promise<Artifact[]> {
		let entries: string[];
		try {
			entries = await fs.readdir(this.baseDir);
		} catch {
			return [];
		}
		const artifacts = await Promise.all(entries.map(entry => this.load(entry)));
		return artifacts.filter((artifact): artifact is Artifact => artifact?.workflowId === workflowId);
	}
}
