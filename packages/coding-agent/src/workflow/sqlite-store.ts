import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";
import { WorkflowPolicyError } from "./errors";
import type { Artifact, WorkflowState, WorkflowStatus } from "./types";

const DB_PATH = path.join(process.cwd(), "workflow.db");

interface WorkflowRow {
	id: string;
	status: WorkflowStatus;
	request_json: string;
	policy_json: string;
	current_stage: WorkflowStatus;
	current_attempt_id: string | null;
	degraded_mode: number;
	created_at: string;
	updated_at: string;
	version: number;
}

export class WorkflowStore {
	readonly #db: Database;

	constructor(dbPath = DB_PATH) {
		this.#db = new Database(dbPath, { create: true, readwrite: true, strict: true });
		this.#db.exec("PRAGMA foreign_keys = ON;");
		this.#initSchema();
	}

	#initSchema(): void {
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS workflows (
				id TEXT PRIMARY KEY,
				status TEXT NOT NULL,
				request_json TEXT NOT NULL,
				policy_json TEXT NOT NULL,
				current_stage TEXT NOT NULL,
				current_attempt_id TEXT,
				degraded_mode INTEGER NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				version INTEGER NOT NULL
			);

			CREATE TABLE IF NOT EXISTS attempts (
				id TEXT PRIMARY KEY,
				workflow_id TEXT NOT NULL,
				stage TEXT NOT NULL,
				ordinal INTEGER NOT NULL,
				model_profile_id TEXT,
				status TEXT NOT NULL,
				error_kind TEXT,
				error_summary TEXT,
				usage_json TEXT,
				started_at TEXT NOT NULL,
				finished_at TEXT,
				FOREIGN KEY(workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
			);

			CREATE TABLE IF NOT EXISTS artifacts (
				id TEXT PRIMARY KEY,
				workflow_id TEXT NOT NULL,
				attempt_id TEXT NOT NULL,
				kind TEXT NOT NULL,
				schema_version INTEGER NOT NULL,
				relative_path TEXT NOT NULL,
				sha256 TEXT NOT NULL,
				created_at TEXT NOT NULL,
				FOREIGN KEY(workflow_id) REFERENCES workflows(id) ON DELETE CASCADE,
				FOREIGN KEY(attempt_id) REFERENCES attempts(id) ON DELETE CASCADE
			);

			CREATE TABLE IF NOT EXISTS transitions (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				workflow_id TEXT NOT NULL,
				from_status TEXT NOT NULL,
				to_status TEXT NOT NULL,
				reason TEXT NOT NULL,
				attempt_id TEXT,
				created_at TEXT NOT NULL,
				FOREIGN KEY(workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
			);
		`);
	}

	async createWorkflow(request: unknown, policy: unknown): Promise<string> {
		const id = `wf_${randomUUID()}`;
		const attemptId = `att_${randomUUID()}`;
		const now = new Date().toISOString();
		this.#db.transaction(() => {
			this.#db
				.prepare(`
					INSERT INTO workflows (
						id, status, request_json, policy_json, current_stage, current_attempt_id,
						degraded_mode, created_at, updated_at, version
					) VALUES (?, 'created', ?, ?, 'planning', ?, 0, ?, ?, 1)
				`)
				.run(id, JSON.stringify(request), JSON.stringify(policy), attemptId, now, now);
			this.#db
				.prepare(`
					INSERT INTO attempts (id, workflow_id, stage, ordinal, status, started_at)
					VALUES (?, ?, 'planning', 1, 'in_progress', ?)
				`)
				.run(attemptId, id, now);
		})();
		return id;
	}

	async getCurrentState(workflowId: string): Promise<WorkflowState | null> {
		const row = this.#db.prepare("SELECT * FROM workflows WHERE id = ?").get(workflowId) as WorkflowRow | null;
		if (!row) return null;
		return {
			id: row.id,
			status: row.status,
			currentStage: row.current_stage,
			currentAttemptId: row.current_attempt_id ?? undefined,
			degradedMode: row.degraded_mode === 1,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			version: row.version,
			requestJson: row.request_json,
			policyJson: row.policy_json,
		};
	}

	async completeAttempt(
		workflowId: string,
		attemptId: string,
		status: string,
		usage: unknown = {},
		error?: { kind: string; summary: string },
	): Promise<void> {
		this.#db.transaction(() => {
			const result = this.#db
				.prepare(`
					UPDATE attempts
					SET status = ?, finished_at = ?, usage_json = ?, error_kind = ?, error_summary = ?
					WHERE id = ? AND workflow_id = ?
				`)
				.run(
					status,
					new Date().toISOString(),
					JSON.stringify(usage),
					error?.kind ?? null,
					error?.summary ?? null,
					attemptId,
					workflowId,
				);
			if (result.changes !== 1) throw new WorkflowPolicyError("attempt_not_found", { workflowId, attemptId });
			this.#db
				.prepare("UPDATE workflows SET version = version + 1, updated_at = ? WHERE id = ?")
				.run(new Date().toISOString(), workflowId);
		})();
	}

	async addArtifact(artifact: Omit<Artifact, "id" | "createdAt">): Promise<void> {
		this.#db
			.prepare(`
				INSERT INTO artifacts (id, workflow_id, attempt_id, kind, schema_version, relative_path, sha256, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			`)
			.run(
				`art_${randomUUID()}`,
				artifact.workflowId,
				artifact.attemptId,
				artifact.kind,
				artifact.schemaVersion,
				artifact.relativePath,
				this.computeSha256(artifact.content ?? ""),
				new Date().toISOString(),
			);
	}

	computeSha256(content: string): string {
		return createHash("sha256").update(content).digest("hex");
	}

	async transitionWorkflow(
		workflowId: string,
		fromStatus: WorkflowStatus,
		toStatus: WorkflowStatus,
		reason: string,
		attemptId?: string,
	): Promise<void> {
		this.#db.transaction(() => {
			const now = new Date().toISOString();
			const result = this.#db
				.prepare(`
					UPDATE workflows
					SET status = ?, current_stage = ?, updated_at = ?, version = version + 1
					WHERE id = ? AND status = ?
				`)
				.run(toStatus, toStatus, now, workflowId, fromStatus);
			if (result.changes !== 1) {
				throw new WorkflowPolicyError("optimistic_version_conflict", { workflowId, fromStatus, toStatus });
			}
			this.#db
				.prepare(`
					INSERT INTO transitions (workflow_id, from_status, to_status, reason, attempt_id, created_at)
					VALUES (?, ?, ?, ?, ?, ?)
				`)
				.run(workflowId, fromStatus, toStatus, reason, attemptId ?? null, now);
		})();
	}

	async deleteWorkflow(workflowId: string): Promise<void> {
		this.#db.prepare("DELETE FROM workflows WHERE id = ?").run(workflowId);
	}

	async resumeFromPersistedState(workflowId: string): Promise<WorkflowState | null> {
		return this.getCurrentState(workflowId);
	}

	close(): void {
		this.#db.close();
	}
}
