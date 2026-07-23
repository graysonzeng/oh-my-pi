import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactStore } from "../../src/workflow/artifact-store";
import { WorkflowEngine } from "../../src/workflow/engine";
import { RuntimeAdapter } from "../../src/workflow/runtime-adapter";
import { WorkflowStore } from "../../src/workflow/sqlite-store";
import { fakeSession, implArtifact, passVerifier, planArtifact, reviewArtifact, scriptedRunner } from "./helpers";

describe("WorkflowEngine repair loop", () => {
	let store: WorkflowStore;
	let artifactDir: string;

	beforeEach(async () => {
		store = new WorkflowStore(":memory:");
		artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-repair-"));
	});

	afterEach(async () => {
		store.close();
		await fs.rm(artifactDir, { recursive: true, force: true });
	});

	it("enters repair on code-review findings then can complete", async () => {
		let reviews = 0;
		const finding = {
			id: "f1",
			priority: "P1" as const,
			category: "correctness" as const,
			status: "open" as const,
			confidence: 0.95,
			summary: "bug",
			explanation: "fix it",
			suggestedOwner: "implementer" as const,
		};
		const engine = new WorkflowEngine({
			store,
			adapter: new RuntimeAdapter(
				scriptedRunner({
					plan: planArtifact(),
					planReview: reviewArtifact("approved", "plan"),
					implement: implArtifact(),
					codeReview: () => {
						reviews += 1;
						if (reviews === 1) {
							return reviewArtifact("changes_requested", "implementation", [finding]);
						}
						return reviewArtifact("approved", "implementation", []);
					},
					repair: implArtifact({ addressedStepIds: ["f1"], summary: "repaired" }),
				}),
			),
			verifier: passVerifier(),
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession(),
		});

		const workflowId = await engine.startWorkflow({ request: "repair path" });
		const result = await engine.run(workflowId);
		expect(result.state.status).toBe("completed");
		expect(reviews).toBeGreaterThanOrEqual(1);
	});

	it("verification failure enters repair", async () => {
		let verifyCalls = 0;
		const engine = new WorkflowEngine({
			store,
			adapter: new RuntimeAdapter(
				scriptedRunner({
					plan: planArtifact(),
					planReview: reviewArtifact("approved", "plan"),
					implement: implArtifact(),
					codeReview: reviewArtifact("approved", "implementation"),
					repair: implArtifact({ summary: "fixed verify" }),
				}),
			),
			verifier: {
				async verify(a) {
					verifyCalls += 1;
					// first impl verify fails, later ones pass
					const passed = verifyCalls !== 1;
					return {
						kind: "verification",
						passed,
						checks: [{ id: "c", status: passed ? "passed" : "failed", summary: passed ? "ok" : "fail" }],
						schemaVersion: 1,
						workflowId: a.workflowId,
						attemptId: a.attemptId,
						stage: a.stage,
						createdAt: new Date().toISOString(),
					};
				},
			},
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession(),
		});

		const workflowId = await engine.startWorkflow({ request: "verify fail" });
		// Drive to implementation_verify failure
		for (let i = 0; i < 6; i++) {
			const s = await engine.getState(workflowId);
			if (s && ["repairing", "completed", "blocked", "failed"].includes(s.status)) break;
			await engine.resume(workflowId, { singleStep: true });
		}
		const state = await engine.getState(workflowId);
		expect(state?.status).toBe("repairing");
	});
});
