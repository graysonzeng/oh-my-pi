import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { WorkflowStore } from "../../src/workflow/sqlite-store";

describe("WorkflowStore", () => {
	let store: WorkflowStore;
	let testDbPath: string;

	beforeEach(() => {
		testDbPath = `/tmp/workflow-test-${randomUUID()}.db`;
		store = new WorkflowStore(testDbPath);
	});

	afterEach(async () => {
		store.close();
		await Promise.all([
			fs.rm(testDbPath, { force: true }),
			fs.rm(`${testDbPath}-shm`, { force: true }),
			fs.rm(`${testDbPath}-wal`, { force: true }),
		]);
	});

	it("creates workflow and loads state", async () => {
		const workflowId = await store.createWorkflow({ test: true }, { degradedMode: false });
		const state = await store.getCurrentState(workflowId);
		expect(state?.status).toBe("created");
		expect(state?.currentStage).toBe("planning");
		expect(state?.currentAttemptId).toBeTruthy();
	});

	it("completes the current attempt", async () => {
		const workflowId = await store.createWorkflow({ test: true }, {});
		const state = await store.getCurrentState(workflowId);
		if (!state?.currentAttemptId) throw new Error("expected current attempt");
		await store.completeAttempt(workflowId, state.currentAttemptId, "completed", { tokens: 100 });
		expect((await store.getCurrentState(workflowId))?.version).toBe(2);
	});

	it("transitions atomically and rejects stale source states", async () => {
		const workflowId = await store.createWorkflow({ test: true }, {});
		await store.transitionWorkflow(workflowId, "created", "planning", "start planning");
		expect((await store.getCurrentState(workflowId))?.status).toBe("planning");
		await expect(store.transitionWorkflow(workflowId, "created", "planning", "stale transition")).rejects.toThrow(
			"optimistic_version_conflict",
		);
	});

	it("resumes state after reopening the database", async () => {
		const workflowId = await store.createWorkflow({ test: true }, {});
		store.close();
		store = new WorkflowStore(testDbPath);
		expect((await store.resumeFromPersistedState(workflowId))?.id).toBe(workflowId);
	});

	it("computes stable artifact hashes", () => {
		expect(store.computeSha256("workflow")).toBe(store.computeSha256("workflow"));
		expect(store.computeSha256("workflow")).not.toBe(store.computeSha256("different"));
	});

	it("deletes a workflow", async () => {
		const workflowId = await store.createWorkflow({ test: true }, {});
		await store.deleteWorkflow(workflowId);
		expect(await store.getCurrentState(workflowId)).toBeNull();
	});
});
