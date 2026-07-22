import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { WorkflowEngine } from "../../src/workflow/engine";
import { WorkflowStore } from "../../src/workflow/sqlite-store";

describe("WorkflowEngine persistence", () => {
	let engine: WorkflowEngine;
	let store: WorkflowStore;

	beforeEach(() => {
		store = new WorkflowStore(":memory:");
		engine = new WorkflowEngine({ store });
	});

	afterEach(() => store.close());

	it("starts a workflow without invoking a provider", async () => {
		const workflowId = await engine.startWorkflow({ request: "test" }, { degradedMode: false });
		expect((await engine.getState(workflowId))?.status).toBe("created");
	});

	it("reports available budget", async () => {
		expect(await engine.budgetCheckPreStage()).toBe(true);
	});

	it("resumes persisted state", async () => {
		const workflowId = await engine.startWorkflow({ request: "resume" });
		expect((await engine.recoverFromPersistedState(workflowId))?.id).toBe(workflowId);
	});
});
