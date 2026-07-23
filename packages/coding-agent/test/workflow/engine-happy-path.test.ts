import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactStore } from "../../src/workflow/artifact-store";
import { WorkflowEngine } from "../../src/workflow/engine";
import { RuntimeAdapter } from "../../src/workflow/runtime-adapter";
import { WorkflowStore } from "../../src/workflow/sqlite-store";
import { fakeSession, implArtifact, passVerifier, planArtifact, reviewArtifact, scriptedRunner } from "./helpers";

describe("WorkflowEngine happy path", () => {
	let store: WorkflowStore;
	let artifactDir: string;
	let engine: WorkflowEngine;

	beforeEach(async () => {
		store = new WorkflowStore(":memory:");
		artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-happy-"));
		engine = new WorkflowEngine({
			store,
			adapter: new RuntimeAdapter(
				scriptedRunner({
					plan: planArtifact(),
					planReview: reviewArtifact("approved", "plan"),
					implement: implArtifact(),
					codeReview: reviewArtifact("approved", "implementation"),
				}),
			),
			verifier: passVerifier(),
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession(),
		});
	});

	afterEach(async () => {
		store.close();
		await fs.rm(artifactDir, { recursive: true, force: true });
	});

	it("starts a workflow without invoking a provider", async () => {
		const workflowId = await engine.startWorkflow({ request: "test" }, { degradedMode: false });
		expect((await engine.getState(workflowId))?.status).toBe("created");
	});

	it("runs full accepted path to completed", async () => {
		const workflowId = await engine.startWorkflow({ request: "ship feature" });
		const result = await engine.run(workflowId, fakeSession());
		expect(result.state.status).toBe("completed");
		expect(result.plan?.kind).toBe("plan");
		expect(result.implementation?.patchPath).toBe("patches/x.patch");
		expect(result.routingAudit.length).toBeGreaterThan(0);
	});

	it("reports available budget", async () => {
		expect(await engine.budgetCheckPreStage()).toBe(true);
	});
});
