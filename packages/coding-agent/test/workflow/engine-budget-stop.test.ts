import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactStore } from "../../src/workflow/artifact-store";
import { BudgetLedger } from "../../src/workflow/budget-ledger";
import { WorkflowEngine } from "../../src/workflow/engine";
import { RuntimeAdapter } from "../../src/workflow/runtime-adapter";
import { WorkflowStore } from "../../src/workflow/sqlite-store";
import { fakeSession, planArtifact, scriptedRunner } from "./helpers";

describe("WorkflowEngine budget stop", () => {
	let store: WorkflowStore;
	let artifactDir: string;

	beforeEach(async () => {
		store = new WorkflowStore(":memory:");
		artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-budget-"));
	});

	afterEach(async () => {
		store.close();
		await fs.rm(artifactDir, { recursive: true, force: true });
	});

	it("hard-stops before provider when budget exhausted", async () => {
		const ledger = new BudgetLedger({ maxRequests: 0 });
		const engine = new WorkflowEngine({
			store,
			budgetLedger: ledger,
			adapter: new RuntimeAdapter(
				scriptedRunner({
					plan: planArtifact(),
				}),
			),
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession(),
		});
		const workflowId = await engine.startWorkflow({ request: "no budget" });
		// first step: created → planning (no provider)
		await engine.resume(workflowId, { singleStep: true });
		// second step: planning needs provider — budget 0 requests fails
		await expect(engine.resume(workflowId, { singleStep: true })).rejects.toMatchObject({
			kind: "budget_exhausted",
		});
		const state = await engine.getState(workflowId);
		expect(state?.status).toBe("blocked");
	});

	it("accumulates real usage cost and hard-stops after known usage", async () => {
		// scriptedRunner reports cost.total = 0.03 per request; limit 0.03 blocks the next stage
		const ledger = new BudgetLedger({ limitUsd: 0.03 });
		const engine = new WorkflowEngine({
			store,
			budgetLedger: ledger,
			adapter: new RuntimeAdapter(
				scriptedRunner({
					plan: planArtifact(),
					planReview: {
						schemaVersion: 1,
						workflowId: "wf",
						attemptId: "att",
						stage: "plan_review",
						createdAt: new Date().toISOString(),
						kind: "review",
						subject: "plan",
						decision: "approved",
						findings: [],
						explanation: "ok",
						confidence: 0.9,
					},
				}),
			),
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession(),
		});
		const workflowId = await engine.startWorkflow({ request: "costly" });
		// created → planning
		await engine.resume(workflowId, { singleStep: true });
		// planning: records usage 0.03
		await engine.resume(workflowId, { singleStep: true });
		expect(engine.budgetSnapshot().costUsd).toBeCloseTo(0.03, 5);
		expect(engine.budgetSnapshot().costKnown).toBe(true);
		expect(engine.budgetSnapshot().requests).toBe(1);
		// next stage would call provider again — hard-stop before provider when cost >= limit
		await expect(engine.resume(workflowId, { singleStep: true })).rejects.toMatchObject({
			kind: "budget_exhausted",
		});
		expect((await engine.getState(workflowId))?.status).toBe("blocked");
	});
});
