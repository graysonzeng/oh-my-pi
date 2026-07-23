import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { WorkflowPolicyError } from "./errors";
import { isValidTransition } from "./transitions";
import type { Artifact, Attempt, Transition, WorkflowState, WorkflowStatus } from "./types";

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
	budget_json: string | null;
	runner_owner: string | null;
}

interface AttemptRow {
	id: string;
	workflow_id: string;
	stage: string;
	ordinal: number;
	model_profile_id: string | null;
	status: string;
	error_kind: string | null;
	error_summary: string | null;
	usage_json: string | null;
	started_at: string;
	finished_at: string | null;
}

interface ArtifactRow {
	id: string;
	workflow_id: string;
	attempt_id: string;
	kind: string;
	schema_version: number;
	relative_path: string;
	sha256: string;
	created_at: string;
}

interface TransitionRow {
	id: number;
	workflow_id: string;
	from_status: WorkflowStatus;
	to_status: WorkflowStatus;
	reason: string;
	attempt_id: string | null;
	created_at: string;
}

/** Full reconstruction payload for resume/restart recovery. */
export interface PersistedWorkflowSnapshot {
	state: WorkflowState;
	attempts: Attempt[];
	artifacts: Artifact[];
	transitions: Transition[];
	budgetTotals: Record<string, unknown> | null;
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
				version INTEGER NOT NULL,
				budget_json TEXT,
				runner_owner TEXT
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
		// Migrate older DBs that lack budget_json / runner_owner
		const cols = this.#db.prepare("PRAGMA table_info(workflows)").all() as Array<{ name: string }>;
		if (!cols.some(c => c.name === "budget_json")) {
			this.#db.exec("ALTER TABLE workflows ADD COLUMN budget_json TEXT");
		}
		if (!cols.some(c => c.name === "runner_owner")) {
			this.#db.exec("ALTER TABLE workflows ADD COLUMN runner_owner TEXT");
		}
	}

	/** Create workflow in terminal-ready `created` state with no premature attempt. */
	async createWorkflow(request: unknown, policy: unknown): Promise<string> {
		const id = `wf_${randomUUID()}`;
		const now = new Date().toISOString();
		this.#db
			.prepare(`
				INSERT INTO workflows (
					id, status, request_json, policy_json, current_stage, current_attempt_id,
					degraded_mode, created_at, updated_at, version, budget_json
				) VALUES (?, 'created', ?, ?, 'created', NULL, 0, ?, ?, 1, NULL)
			`)
			.run(id, JSON.stringify(request), JSON.stringify(policy), now, now);
		return id;
	}

	async getCurrentState(workflowId: string): Promise<WorkflowState | null> {
		const row = this.#db.prepare("SELECT * FROM workflows WHERE id = ?").get(workflowId) as WorkflowRow | null;
		if (!row) return null;
		return this.#mapState(row);
	}

	#mapState(row: WorkflowRow): WorkflowState {
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

	/** Start a stage attempt and record intent. Returns attempt id. */
	async beginAttempt(
		workflowId: string,
		stage: WorkflowStatus,
		modelProfileId?: string,
		expectedVersion?: number,
	): Promise<string> {
		const attemptId = `att_${randomUUID()}`;
		const now = new Date().toISOString();
		this.#db.transaction(() => {
			const row = this.#db.prepare("SELECT * FROM workflows WHERE id = ?").get(workflowId) as WorkflowRow | null;
			if (!row) throw new WorkflowPolicyError("workflow_not_found", { workflowId });
			if (expectedVersion !== undefined && row.version !== expectedVersion) {
				throw new WorkflowPolicyError("optimistic_version_conflict", {
					workflowId,
					expectedVersion,
					actualVersion: row.version,
				});
			}
			const ordinalRow = this.#db
				.prepare("SELECT COALESCE(MAX(ordinal), 0) AS max_ord FROM attempts WHERE workflow_id = ?")
				.get(workflowId) as { max_ord: number };
			const ordinal = (ordinalRow?.max_ord ?? 0) + 1;
			this.#db
				.prepare(`
					INSERT INTO attempts (id, workflow_id, stage, ordinal, model_profile_id, status, started_at)
					VALUES (?, ?, ?, ?, ?, 'in_progress', ?)
				`)
				.run(attemptId, workflowId, stage, ordinal, modelProfileId ?? null, now);
			this.#db
				.prepare(`
					UPDATE workflows
					SET current_attempt_id = ?, updated_at = ?, version = version + 1
					WHERE id = ?
				`)
				.run(attemptId, now, workflowId);
		})();
		return attemptId;
	}

	async completeAttempt(
		workflowId: string,
		attemptId: string,
		status: string,
		usage: unknown = {},
		error?: { kind: string; summary: string },
		modelProfileId?: string,
	): Promise<void> {
		this.#db.transaction(() => {
			const result = this.#db
				.prepare(`
					UPDATE attempts
					SET status = ?, finished_at = ?, usage_json = ?, error_kind = ?, error_summary = ?,
						model_profile_id = COALESCE(?, model_profile_id)
					WHERE id = ? AND workflow_id = ?
				`)
				.run(
					status,
					new Date().toISOString(),
					JSON.stringify(usage),
					error?.kind ?? null,
					error?.summary ?? null,
					modelProfileId ?? null,
					attemptId,
					workflowId,
				);
			if (result.changes !== 1) throw new WorkflowPolicyError("attempt_not_found", { workflowId, attemptId });
			this.#db
				.prepare("UPDATE workflows SET version = version + 1, updated_at = ? WHERE id = ?")
				.run(new Date().toISOString(), workflowId);
		})();
	}

	async setAttemptProfile(workflowId: string, attemptId: string, modelProfileId: string): Promise<void> {
		const result = this.#db
			.prepare(`UPDATE attempts SET model_profile_id = ? WHERE id = ? AND workflow_id = ?`)
			.run(modelProfileId, attemptId, workflowId);
		if (result.changes !== 1) throw new WorkflowPolicyError("attempt_not_found", { workflowId, attemptId });
	}

	/**
	 * Atomic completeAttempt + transition in one transaction.
	 * Uses optimistic version check when expectedVersion is provided.
	 */
	async completeAttemptAndTransition(params: {
		workflowId: string;
		attemptId: string;
		attemptStatus: string;
		fromStatus: WorkflowStatus;
		toStatus: WorkflowStatus;
		reason: string;
		usage?: unknown;
		error?: { kind: string; summary: string };
		expectedVersion?: number;
	}): Promise<void> {
		const {
			workflowId,
			attemptId,
			attemptStatus,
			fromStatus,
			toStatus,
			reason,
			usage = {},
			error,
			expectedVersion,
		} = params;
		if (!isValidTransition(fromStatus, toStatus)) {
			throw new WorkflowPolicyError("invalid_transition", { workflowId, fromStatus, toStatus });
		}
		this.#db.transaction(() => {
			const now = new Date().toISOString();
			const row = this.#db.prepare("SELECT * FROM workflows WHERE id = ?").get(workflowId) as WorkflowRow | null;
			if (!row) throw new WorkflowPolicyError("workflow_not_found", { workflowId });
			if (row.status !== fromStatus) {
				throw new WorkflowPolicyError("optimistic_version_conflict", {
					workflowId,
					fromStatus,
					actualStatus: row.status,
				});
			}
			if (expectedVersion !== undefined && row.version !== expectedVersion) {
				throw new WorkflowPolicyError("optimistic_version_conflict", {
					workflowId,
					expectedVersion,
					actualVersion: row.version,
				});
			}
			const attemptResult = this.#db
				.prepare(`
					UPDATE attempts
					SET status = ?, finished_at = ?, usage_json = ?, error_kind = ?, error_summary = ?
					WHERE id = ? AND workflow_id = ?
				`)
				.run(
					attemptStatus,
					now,
					JSON.stringify(usage),
					error?.kind ?? null,
					error?.summary ?? null,
					attemptId,
					workflowId,
				);
			if (attemptResult.changes !== 1) {
				throw new WorkflowPolicyError("attempt_not_found", { workflowId, attemptId });
			}
			const wfResult = this.#db
				.prepare(`
					UPDATE workflows
					SET status = ?, current_stage = ?, updated_at = ?, version = version + 1
					WHERE id = ? AND status = ? AND version = ?
				`)
				.run(toStatus, toStatus, now, workflowId, fromStatus, row.version);
			if (wfResult.changes !== 1) {
				throw new WorkflowPolicyError("optimistic_version_conflict", { workflowId, fromStatus, toStatus });
			}
			this.#db
				.prepare(`
					INSERT INTO transitions (workflow_id, from_status, to_status, reason, attempt_id, created_at)
					VALUES (?, ?, ?, ?, ?, ?)
				`)
				.run(workflowId, fromStatus, toStatus, reason, attemptId, now);
		})();
	}

	async addArtifact(artifact: Omit<Artifact, "id" | "createdAt"> & { content?: string }): Promise<string> {
		const id = `art_${randomUUID()}`;
		const sha256 = artifact.sha256 || this.computeSha256(artifact.content ?? "");
		this.#db
			.prepare(`
				INSERT INTO artifacts (id, workflow_id, attempt_id, kind, schema_version, relative_path, sha256, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			`)
			.run(
				id,
				artifact.workflowId,
				artifact.attemptId,
				artifact.kind,
				artifact.schemaVersion,
				artifact.relativePath,
				sha256,
				new Date().toISOString(),
			);
		return id;
	}

	/**
	 * Load artifact metadata and optionally verify content hash when content is provided.
	 * Throws ArtifactIntegrityError path via WorkflowPolicyError for mismatch.
	 */
	async getArtifactMeta(artifactId: string): Promise<Artifact | null> {
		const row = this.#db.prepare("SELECT * FROM artifacts WHERE id = ?").get(artifactId) as ArtifactRow | null;
		if (!row) return null;
		return {
			id: row.id,
			workflowId: row.workflow_id,
			attemptId: row.attempt_id,
			kind: row.kind,
			schemaVersion: row.schema_version,
			relativePath: row.relative_path,
			sha256: row.sha256,
			createdAt: row.created_at,
		};
	}

	verifyContentHash(content: string, expectedSha256: string): void {
		const actual = this.computeSha256(content);
		if (actual !== expectedSha256) {
			throw new WorkflowPolicyError("artifact_hash_mismatch", { expectedSha256, actualSha256: actual });
		}
	}

	computeSha256(content: string): string {
		return new Bun.CryptoHasher("sha256").update(content).digest("hex");
	}

	async transitionWorkflow(
		workflowId: string,
		fromStatus: WorkflowStatus,
		toStatus: WorkflowStatus,
		reason: string,
		attemptId?: string,
		expectedVersion?: number,
	): Promise<void> {
		if (!isValidTransition(fromStatus, toStatus)) {
			throw new WorkflowPolicyError("invalid_transition", { workflowId, fromStatus, toStatus });
		}
		this.#db.transaction(() => {
			const now = new Date().toISOString();
			const row = this.#db.prepare("SELECT * FROM workflows WHERE id = ?").get(workflowId) as WorkflowRow | null;
			if (!row) throw new WorkflowPolicyError("workflow_not_found", { workflowId });
			if (row.status !== fromStatus) {
				throw new WorkflowPolicyError("optimistic_version_conflict", {
					workflowId,
					fromStatus,
					actualStatus: row.status,
				});
			}
			if (expectedVersion !== undefined && row.version !== expectedVersion) {
				throw new WorkflowPolicyError("optimistic_version_conflict", {
					workflowId,
					expectedVersion,
					actualVersion: row.version,
				});
			}
			const result = this.#db
				.prepare(`
					UPDATE workflows
					SET status = ?, current_stage = ?, updated_at = ?, version = version + 1
					WHERE id = ? AND status = ? AND version = ?
				`)
				.run(toStatus, toStatus, now, workflowId, fromStatus, row.version);
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

	/**
	 * Exclusive runner claim: succeeds only when version matches and lock is free
	 * (or already owned by the same owner). Concurrent second owners fail.
	 */
	async claimRunner(workflowId: string, ownerId: string, expectedVersion: number): Promise<number> {
		const now = new Date().toISOString();
		const result = this.#db
			.prepare(`
				UPDATE workflows
				SET runner_owner = ?, version = version + 1, updated_at = ?
				WHERE id = ?
				  AND version = ?
				  AND (runner_owner IS NULL OR runner_owner = ?)
			`)
			.run(ownerId, now, workflowId, expectedVersion, ownerId);
		if (result.changes !== 1) {
			const row = this.#db.prepare("SELECT version, runner_owner FROM workflows WHERE id = ?").get(workflowId) as {
				version: number;
				runner_owner: string | null;
			} | null;
			if (!row) throw new WorkflowPolicyError("workflow_not_found", { workflowId });
			if (row.runner_owner && row.runner_owner !== ownerId) {
				throw new WorkflowPolicyError("runner_lock_held", {
					workflowId,
					ownerId,
					heldBy: row.runner_owner,
				});
			}
			throw new WorkflowPolicyError("optimistic_version_conflict", {
				workflowId,
				expectedVersion,
				actualVersion: row.version,
			});
		}
		const row = this.#db.prepare("SELECT version FROM workflows WHERE id = ?").get(workflowId) as {
			version: number;
		};
		return row.version;
	}

	/** Release exclusive runner ownership. No-op if not held by ownerId. */
	async releaseRunner(workflowId: string, ownerId: string): Promise<void> {
		this.#db
			.prepare(`
				UPDATE workflows
				SET runner_owner = NULL, updated_at = ?, version = version + 1
				WHERE id = ? AND runner_owner = ?
			`)
			.run(new Date().toISOString(), workflowId, ownerId);
	}

	/**
	 * Clear any runner owner (crash recovery on resume). Prefer releaseRunner when
	 * the owner id is known.
	 */
	async clearRunnerOwner(workflowId: string): Promise<void> {
		this.#db
			.prepare(`
				UPDATE workflows
				SET runner_owner = NULL, updated_at = ?, version = version + 1
				WHERE id = ? AND runner_owner IS NOT NULL
			`)
			.run(new Date().toISOString(), workflowId);
	}

	/** @deprecated Use claimRunner — kept so older call sites compile during migration. */
	async acquireRunnerLock(workflowId: string, expectedVersion: number, ownerId = "legacy"): Promise<number> {
		return this.claimRunner(workflowId, ownerId, expectedVersion);
	}

	async setDegradedMode(workflowId: string, degraded: boolean): Promise<void> {
		this.#db
			.prepare("UPDATE workflows SET degraded_mode = ?, updated_at = ?, version = version + 1 WHERE id = ?")
			.run(degraded ? 1 : 0, new Date().toISOString(), workflowId);
	}

	async saveBudgetTotals(workflowId: string, budget: Record<string, unknown>): Promise<void> {
		this.#db
			.prepare("UPDATE workflows SET budget_json = ?, updated_at = ? WHERE id = ?")
			.run(JSON.stringify(budget), new Date().toISOString(), workflowId);
	}

	async listAttempts(workflowId: string): Promise<Attempt[]> {
		const rows = this.#db
			.prepare("SELECT * FROM attempts WHERE workflow_id = ? ORDER BY ordinal ASC")
			.all(workflowId) as AttemptRow[];
		return rows.map(row => ({
			id: row.id,
			workflowId: row.workflow_id,
			stage: row.stage,
			ordinal: row.ordinal,
			modelProfileId: row.model_profile_id ?? undefined,
			status: row.status,
			errorKind: row.error_kind ?? undefined,
			errorSummary: row.error_summary ?? undefined,
			usageJson: row.usage_json ?? undefined,
			startedAt: row.started_at,
			finishedAt: row.finished_at ?? undefined,
		}));
	}

	async listArtifacts(workflowId: string): Promise<Artifact[]> {
		const rows = this.#db
			.prepare("SELECT * FROM artifacts WHERE workflow_id = ? ORDER BY created_at ASC")
			.all(workflowId) as ArtifactRow[];
		return rows.map(row => ({
			id: row.id,
			workflowId: row.workflow_id,
			attemptId: row.attempt_id,
			kind: row.kind,
			schemaVersion: row.schema_version,
			relativePath: row.relative_path,
			sha256: row.sha256,
			createdAt: row.created_at,
		}));
	}

	async listTransitions(workflowId: string): Promise<Transition[]> {
		const rows = this.#db
			.prepare("SELECT * FROM transitions WHERE workflow_id = ? ORDER BY id ASC")
			.all(workflowId) as TransitionRow[];
		return rows.map(row => ({
			id: row.id,
			workflowId: row.workflow_id,
			fromStatus: row.from_status,
			toStatus: row.to_status,
			reason: row.reason,
			attemptId: row.attempt_id ?? undefined,
			createdAt: row.created_at,
		}));
	}

	async deleteWorkflow(workflowId: string): Promise<void> {
		this.#db.prepare("DELETE FROM workflows WHERE id = ?").run(workflowId);
	}

	async resumeFromPersistedState(workflowId: string): Promise<PersistedWorkflowSnapshot | null> {
		const row = this.#db.prepare("SELECT * FROM workflows WHERE id = ?").get(workflowId) as WorkflowRow | null;
		if (!row) return null;
		const [attempts, artifacts, transitions] = await Promise.all([
			this.listAttempts(workflowId),
			this.listArtifacts(workflowId),
			this.listTransitions(workflowId),
		]);
		let budgetTotals: Record<string, unknown> | null = null;
		if (row.budget_json) {
			try {
				budgetTotals = JSON.parse(row.budget_json) as Record<string, unknown>;
			} catch {
				budgetTotals = null;
			}
		}
		return {
			state: this.#mapState(row),
			attempts,
			artifacts,
			transitions,
			budgetTotals,
		};
	}

	close(): void {
		this.#db.close();
	}
}
