import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactStore } from "../../src/workflow/artifact-store";
import { WorkflowStore } from "../../src/workflow/sqlite-store";

describe("WorkflowStore", () => {
	let store: WorkflowStore;
	let testDbPath: string;
	let artifactDir: string;

	beforeEach(async () => {
		testDbPath = path.join(os.tmpdir(), `workflow-test-${randomUUID()}.db`);
		artifactDir = path.join(os.tmpdir(), `workflow-arts-${randomUUID()}`);
		store = new WorkflowStore(testDbPath);
	});

	afterEach(async () => {
		store.close();
		await Promise.all([
			fs.rm(testDbPath, { force: true }),
			fs.rm(`${testDbPath}-shm`, { force: true }),
			fs.rm(`${testDbPath}-wal`, { force: true }),
			fs.rm(artifactDir, { recursive: true, force: true }),
		]);
	});

	it("creates workflow in created/created without premature planning attempt", async () => {
		const workflowId = await store.createWorkflow({ test: true }, { degradedMode: false });
		const state = await store.getCurrentState(workflowId);
		expect(state?.status).toBe("created");
		expect(state?.currentStage).toBe("created");
		expect(state?.currentAttemptId).toBeUndefined();
		expect((await store.listAttempts(workflowId)).length).toBe(0);
	});

	it("atomically completes attempt and transitions", async () => {
		const workflowId = await store.createWorkflow({ test: true }, {});
		await store.transitionWorkflow(workflowId, "created", "planning", "start");
		const attemptId = await store.beginAttempt(workflowId, "planning");
		const state = await store.getCurrentState(workflowId);
		await store.completeAttemptAndTransition({
			workflowId,
			attemptId,
			attemptStatus: "completed",
			fromStatus: "planning",
			toStatus: "plan_review",
			reason: "plan ready",
			expectedVersion: state!.version,
		});
		const next = await store.getCurrentState(workflowId);
		expect(next?.status).toBe("plan_review");
		const attempts = await store.listAttempts(workflowId);
		expect(attempts[0]?.status).toBe("completed");
	});

	it("exclusive claimRunner rejects second owner until release", async () => {
		const workflowId = await store.createWorkflow({ test: true }, {});
		const state = await store.getCurrentState(workflowId);
		await store.claimRunner(workflowId, "owner-1", state!.version);
		const held = await store.getCurrentState(workflowId);
		await expect(store.claimRunner(workflowId, "owner-2", held!.version)).rejects.toThrow("runner_lock_held");
		// Same owner re-claim is allowed (idempotent ownership)
		await store.claimRunner(workflowId, "owner-1", held!.version);
		await store.releaseRunner(workflowId, "owner-1");
		const free = await store.getCurrentState(workflowId);
		await store.claimRunner(workflowId, "owner-2", free!.version);
		await store.releaseRunner(workflowId, "owner-2");
	});

	it("artifact hash mismatch fails verification", async () => {
		const arts = new ArtifactStore(artifactDir);
		const stored = await arts.store({
			workflowId: "wf1",
			attemptId: "a1",
			kind: "plan",
			schemaVersion: 1,
			relativePath: "",
			content: JSON.stringify({ kind: "plan", summary: "x" }),
		});
		await expect(arts.load(stored.relativePath, "deadbeef")).rejects.toThrow("artifact_hash_mismatch");
		const ok = await arts.load(stored.relativePath, stored.sha256);
		expect(ok?.sha256).toBe(stored.sha256);
	});

	it("resumeFromPersistedState returns full reconstruction payload", async () => {
		const workflowId = await store.createWorkflow({ test: true }, {});
		await store.transitionWorkflow(workflowId, "created", "planning", "start");
		const attemptId = await store.beginAttempt(workflowId, "planning", "claude_planner");
		await store.addArtifact({
			workflowId,
			attemptId,
			kind: "plan",
			schemaVersion: 1,
			relativePath: `${workflowId}/plan.json`,
			sha256: store.computeSha256("{}"),
			content: "{}",
		});
		await store.saveBudgetTotals(workflowId, { requests: 1, costUsd: 0.1 });
		store.close();
		store = new WorkflowStore(testDbPath);
		const snap = await store.resumeFromPersistedState(workflowId);
		expect(snap?.state.id).toBe(workflowId);
		expect(snap?.state.status).toBe("planning");
		expect(snap?.attempts.length).toBe(1);
		expect(snap?.artifacts.length).toBe(1);
		expect(snap?.transitions.length).toBe(1);
		expect(snap?.budgetTotals).toEqual({ requests: 1, costUsd: 0.1 });
	});

	it("deletes a workflow", async () => {
		const workflowId = await store.createWorkflow({ test: true }, {});
		await store.deleteWorkflow(workflowId);
		expect(await store.getCurrentState(workflowId)).toBeNull();
	});
});
