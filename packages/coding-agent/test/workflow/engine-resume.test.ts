import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactStore } from "../../src/workflow/artifact-store";
import { WorkflowEngine } from "../../src/workflow/engine";
import { RuntimeAdapter } from "../../src/workflow/runtime-adapter";
import { WorkflowStore } from "../../src/workflow/sqlite-store";
import { fakeSession, implArtifact, passVerifier, planArtifact, reviewArtifact, scriptedRunner } from "./helpers";

describe("WorkflowEngine resume / cancel / lock", () => {
	let store: WorkflowStore;
	let artifactDir: string;
	let dbPath: string;

	beforeEach(async () => {
		dbPath = path.join(os.tmpdir(), `wf-resume-${crypto.randomUUID()}.db`);
		store = new WorkflowStore(dbPath);
		artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-resume-arts-"));
	});

	afterEach(async () => {
		store.close();
		await fs.rm(artifactDir, { recursive: true, force: true });
		await fs.rm(dbPath, { force: true });
	});

	it("restarts from persisted non-terminal stage and continues execution", async () => {
		const engine = new WorkflowEngine({
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
		const workflowId = await engine.startWorkflow({ request: "resume me" });
		await engine.resume(workflowId, { singleStep: true }); // → planning
		await engine.resume(workflowId, { singleStep: true }); // planning done → plan_review
		expect((await engine.getState(workflowId))?.status).toBe("plan_review");

		// Simulate process restart with new engine same db + artifacts
		store.close();
		store = new WorkflowStore(dbPath);
		const engine2 = new WorkflowEngine({
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
		const result = await engine2.resume(workflowId);
		expect(result.state.status).toBe("completed");
	});

	it("cancel persists cancelled and resume refuses terminal", async () => {
		const engine = new WorkflowEngine({
			store,
			adapter: new RuntimeAdapter(scriptedRunner({ plan: planArtifact() })),
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession(),
		});
		const workflowId = await engine.startWorkflow({ request: "cancel me" });
		await engine.cancel(workflowId);
		expect((await engine.getState(workflowId))?.status).toBe("cancelled");
		await expect(engine.resume(workflowId)).rejects.toThrow("cannot_resume_terminal");
	});

	it("exclusive runner lock: second claim fails until first releases", async () => {
		const workflowId = await store.createWorkflow({ request: "lock" }, {});
		const state = await store.getCurrentState(workflowId);
		const v1 = state!.version;
		await store.claimRunner(workflowId, "runner-a", v1);
		const afterA = await store.getCurrentState(workflowId);
		// Second owner with fresh version still fails while A holds the lock
		await expect(store.claimRunner(workflowId, "runner-b", afterA!.version)).rejects.toThrow("runner_lock_held");
		await store.releaseRunner(workflowId, "runner-a");
		const afterRelease = await store.getCurrentState(workflowId);
		// After release, B can claim
		await store.claimRunner(workflowId, "runner-b", afterRelease!.version);
		await store.releaseRunner(workflowId, "runner-b");
	});

	it("fail-closes stale in_progress attempt on resume then starts a fresh attempt", async () => {
		const engine = new WorkflowEngine({
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
		const workflowId = await engine.startWorkflow({ request: "stale attempt" });
		// created → planning
		await engine.resume(workflowId, { singleStep: true });
		// Leave planning with an open in_progress attempt (simulate crash mid-stage)
		const mid = await store.getCurrentState(workflowId);
		expect(mid?.status).toBe("planning");
		const staleId = await store.beginAttempt(workflowId, "planning", undefined, mid!.version);
		expect((await store.listAttempts(workflowId)).some(a => a.id === staleId && a.status === "in_progress")).toBe(
			true,
		);

		// Resume must not double-run blindly: stale attempt marked failed, new attempt runs to completion
		const result = await engine.resume(workflowId);
		expect(result.state.status).toBe("completed");
		const attempts = await store.listAttempts(workflowId);
		const stale = attempts.find(a => a.id === staleId);
		expect(stale?.status).toBe("failed");
		expect(stale?.errorSummary).toBe("stale_in_progress_on_resume");
		// At least one completed planning attempt after the stale one
		expect(attempts.some(a => a.stage === "planning" && a.status === "completed" && a.id !== staleId)).toBe(true);
	});
});
