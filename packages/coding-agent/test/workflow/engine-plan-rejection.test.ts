import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactStore } from "../../src/workflow/artifact-store";
import { WorkflowEngine } from "../../src/workflow/engine";
import { RuntimeAdapter } from "../../src/workflow/runtime-adapter";
import { WorkflowStore } from "../../src/workflow/sqlite-store";
import { fakeSession, planArtifact, reviewArtifact, scriptedRunner } from "./helpers";

describe("WorkflowEngine plan rejection", () => {
	let store: WorkflowStore;
	let artifactDir: string;

	beforeEach(async () => {
		store = new WorkflowStore(":memory:");
		artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-planrej-"));
	});

	afterEach(async () => {
		store.close();
		await fs.rm(artifactDir, { recursive: true, force: true });
	});

	it("returns to planning when plan review requests changes", async () => {
		let planReviews = 0;
		const engine = new WorkflowEngine({
			store,
			adapter: new RuntimeAdapter(
				scriptedRunner({
					plan: () => planArtifact({ summary: `plan-${planReviews}` }),
					planReview: () => {
						planReviews += 1;
						if (planReviews === 1) return reviewArtifact("changes_requested", "plan");
						return reviewArtifact("approved", "plan");
					},
					implement: {
						schemaVersion: 1,
						workflowId: "wf",
						attemptId: "att",
						stage: "implementing",
						createdAt: new Date().toISOString(),
						kind: "implementation",
						summary: "done",
						changedFiles: ["a.ts"],
						addressedStepIds: ["s1"],
						commandsRun: [],
						patchPath: "p.patch",
						unresolved: [],
					},
					codeReview: reviewArtifact("approved", "implementation"),
				}),
			),
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession(),
			verifier: {
				async verify(a) {
					return {
						kind: "verification",
						passed: true,
						checks: [{ id: "c", status: "passed", summary: "ok" }],
						schemaVersion: 1,
						workflowId: a.workflowId,
						attemptId: a.attemptId,
						stage: a.stage,
						createdAt: new Date().toISOString(),
					};
				},
			},
		});

		const workflowId = await engine.startWorkflow({ request: "plan me" });
		// Run until we leave plan_review first time → planning
		await engine.resume(workflowId, { singleStep: true }); // created→planning
		await engine.resume(workflowId, { singleStep: true }); // planning
		await engine.resume(workflowId, { singleStep: true }); // plan_review → planning
		const state = await engine.getState(workflowId);
		expect(state?.status).toBe("planning");
		expect(planReviews).toBe(1);
	});
});
