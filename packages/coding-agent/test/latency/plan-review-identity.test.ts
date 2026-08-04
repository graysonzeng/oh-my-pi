import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactStore } from "../../src/workflow/artifact-store";
import { DEFAULT_MODEL_PROFILES } from "../../src/workflow/default-config";
import { WorkflowEngine } from "../../src/workflow/engine";
import { ModelRouter } from "../../src/workflow/model-router";
import { RuntimeAdapter } from "../../src/workflow/runtime-adapter";
import { WorkflowStore } from "../../src/workflow/sqlite-store";
import type { ModelProfile } from "../../src/workflow/types";
import { fakeSession, planArtifact, reviewArtifact, scriptedRunner } from "../workflow/helpers";

describe("plan review identity pin + arbitration", () => {
	let store: WorkflowStore;
	let artifactDir: string;

	beforeEach(async () => {
		store = new WorkflowStore(":memory:");
		artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-plan-review-pin-"));
	});

	afterEach(async () => {
		store.close();
		await fs.rm(artifactDir, { recursive: true, force: true });
	});

	it("returns to planning on first changes_requested and keeps single-reviewer shape", async () => {
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
				}),
			),
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession(),
		});

		const workflowId = await engine.startWorkflow({ request: "pin reviewer" });
		await engine.resume(workflowId, { singleStep: true }); // created → planning
		await engine.resume(workflowId, { singleStep: true }); // planning
		await engine.resume(workflowId, { singleStep: true }); // plan_review → planning
		const state = await engine.getState(workflowId);
		expect(state?.status).toBe("planning");
		expect(planReviews).toBe(1);
	});

	it("blocks with arbitration_required when max plan cycles hit and no arbitrator route exists", async () => {
		let planReviews = 0;
		const engine = new WorkflowEngine({
			store,
			config: { maxPlanCycles: 1 },
			adapter: new RuntimeAdapter(
				scriptedRunner({
					plan: () => planArtifact({ summary: `plan-${planReviews}` }),
					planReview: () => {
						planReviews += 1;
						return reviewArtifact("changes_requested", "plan");
					},
				}),
			),
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession(),
		});

		const workflowId = await engine.startWorkflow({ request: "need arbitration" });
		const result = await engine.run(workflowId);
		expect(result.state.status).toBe("blocked");
		expect(planReviews).toBeGreaterThanOrEqual(1);
	});

	it("never applies mechanical Flash class to plan_reviewer route selection", () => {
		const flashRepair: ModelProfile = {
			...DEFAULT_MODEL_PROFILES.deepseek_implementer,
			id: "flash_repair",
			roles: ["repair"],
		};
		const router = new ModelRouter([
			flashRepair,
			DEFAULT_MODEL_PROFILES.claude_plan_reviewer,
			DEFAULT_MODEL_PROFILES.gpt_plan_reviewer,
		]);
		const planReviewer = router.resolve("plan_reviewer", {
			roleStaticSplitEnabled: true,
			mechanicalClass: {
				schemaVersion: 1,
				class: "mechanical_repair",
				evidence: { source: "caller_declaration" },
				targetRole: "repair",
				requestedModelClass: "flash",
			},
		});
		expect(planReviewer.profileId).toBe("claude_plan_reviewer");
		expect(planReviewer.profileId).not.toBe("flash_repair");
	});
});
