import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	abortRegisteredWorkflow,
	registerWorkflowAbort,
	unregisterWorkflowAbort,
} from "../../src/workflow/abort-registry";
import { ArtifactStore } from "../../src/workflow/artifact-store";
import { WorkflowEngine } from "../../src/workflow/engine";
import { RuntimeAdapter } from "../../src/workflow/runtime-adapter";
import { WorkflowStore } from "../../src/workflow/sqlite-store";
import {
	fakeSession,
	implArtifact,
	materializeSamplePatch,
	passVerifier,
	planArtifact,
	realTempWorkspace,
	reviewArtifact,
	scriptedRunner,
	type RealTempWorkspace,
} from "./helpers";

describe("WorkflowEngine resume / cancel / lock", () => {
	let store: WorkflowStore;
	let artifactDir: string;
	let dbPath: string;
	let workspace: RealTempWorkspace;

	beforeEach(async () => {
		workspace = await realTempWorkspace();
		await materializeSamplePatch(workspace.cwd);
		dbPath = path.join(os.tmpdir(), `wf-resume-${crypto.randomUUID()}.db`);
		store = new WorkflowStore(dbPath);
		artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-resume-arts-"));
	});

	afterEach(async () => {
		store.close();
		await fs.rm(artifactDir, { recursive: true, force: true });
		await fs.rm(dbPath, { force: true });
		await workspace.cleanup();
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
			verifier: passVerifier(workspace.cwd),
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession({ cwd: workspace.cwd }),
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
			verifier: passVerifier(workspace.cwd),
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession({ cwd: workspace.cwd }),
		});
		const result = await engine2.resume(workflowId);
		expect(result.state.status).toBe("completed");
	});

	it("cancel persists cancelled and resume refuses terminal", async () => {
		const engine = new WorkflowEngine({
			store,
			adapter: new RuntimeAdapter(scriptedRunner({ plan: planArtifact() })),
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession({ cwd: workspace.cwd }),
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
			verifier: passVerifier(workspace.cwd),
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession({ cwd: workspace.cwd }),
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

	it("plan_review after Engine rebuild still excludes planner profile/vendor", async () => {
		const seenReviewerModels: string[] = [];
		const mk = (s: WorkflowStore) =>
			new WorkflowEngine({
				store: s,
				adapter: new RuntimeAdapter(async request => {
					const agent = request.agent ?? "";
					if (request.workflowRole === "planner") {
						return {
							result: {
								id: "raw_plan",
								structuredOutput: {
									status: "valid",
									data: planArtifact({
										modelProfileId: "claude_planner",
										provider: "anthropic",
									}),
								},
							},
						};
					}
					if (agent === "reviewer" || agent === "plan_reviewer") {
						const model = Array.isArray(request.model) ? request.model[0] : request.model;
						const modelId = String(model ?? "gpt-5.6-sol");
						const provider = modelId.startsWith("claude") ? "anthropic" : "openai";
						seenReviewerModels.push(modelId);
						if (request.onResponse) {
							request.onResponse(
								{
									status: 200,
									headers: {
										"x-provider-model": modelId,
										"x-omp-resolved-provider": provider,
									},
									requestId: "resume-plan-review",
								},
								{
									id: modelId,
									provider,
									api: "openai-responses",
									name: modelId,
									baseUrl: "https://provider.invalid",
									reasoning: true,
									input: ["text"],
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
									contextWindow: 16_000,
									maxTokens: 1_000,
								} as never,
							);
						}
						return {
							result: {
								id: "raw_plan_review",
								structuredOutput: {
									status: "valid",
									data: reviewArtifact("approved", "plan"),
								},
								resolvedModel: `${provider}/${modelId}`,
							},
						};
					}
					throw new Error(`unexpected agent ${agent}`);
				}),
				verifier: passVerifier(workspace.cwd),
				artifactStore: new ArtifactStore(artifactDir),
				session: fakeSession({ cwd: workspace.cwd }),
			});

		const engine1 = mk(store);
		const workflowId = await engine1.startWorkflow({ request: "plan review diversity resume" });
		await engine1.resume(workflowId, { singleStep: true }); // → planning
		await engine1.resume(workflowId, { singleStep: true }); // planning → plan_review
		expect((await engine1.getState(workflowId))?.status).toBe("plan_review");

		store.close();
		store = new WorkflowStore(dbPath);
		const engine2 = mk(store);
		await engine2.resume(workflowId, { singleStep: true }); // run plan_review
		expect(seenReviewerModels.length).toBe(1);
		// gpt_plan_reviewer modelPattern starts with gpt-5.6-sol; anthropic claude_* would be same-vendor as planner.
		expect(seenReviewerModels[0]).toMatch(/^gpt-/);
		expect(engine2.routingAudit.some(a => a.profileId === "gpt_plan_reviewer")).toBe(true);
		expect(engine2.routingAudit.some(a => a.profileId === "claude_plan_reviewer")).toBe(false);
	});

	it("same-engine start of a second workflow clears prior routing audit and work-package cache (G1)", async () => {
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
			verifier: passVerifier(workspace.cwd),
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession({ cwd: workspace.cwd }),
		});
		const first = await engine.startWorkflow({ request: "first workflow" });
		await engine.resume(first, { singleStep: true });
		await engine.resume(first, { singleStep: true });
		expect(engine.budgetSnapshot()).toMatchObject({ requests: 1, costKnown: true, knownCostLowerBoundUsd: 0.03 });

		const second = await engine.startWorkflow({ request: "second workflow" });
		expect(second).not.toBe(first);
		expect(engine.budgetSnapshot()).toMatchObject({ requests: 0, costKnown: true, knownCostLowerBoundUsd: 0 });
		expect((await store.resumeFromPersistedState(second))?.budgetTotals).toMatchObject({ requests: 0 });

		await engine.resume(second, { singleStep: true });
		await engine.resume(second, { singleStep: true });
		expect(engine.budgetSnapshot()).toMatchObject({ requests: 1, costKnown: true, knownCostLowerBoundUsd: 0.03 });
	});
	it("does not recover a legacy missing budget as known zero", async () => {
		const workflowId = await store.createWorkflow({ request: "legacy workflow" }, {});
		const engine = new WorkflowEngine({ store, artifactStore: new ArtifactStore(artifactDir) });
		const resumed = await engine.resume(workflowId, { singleStep: true });
		expect(resumed.state.status).toBe("planning");
		expect(engine.budgetSnapshot()).toMatchObject({ costKnown: false, costUsd: null });
		expect((await store.resumeFromPersistedState(workflowId))?.budgetTotals).toMatchObject({ costKnown: false });
	});

	it("rejects a corrupt latest plan rather than silently reviving the older plan", async () => {
		const artifacts = new ArtifactStore(artifactDir);
		let calls = 0;
		const engine = new WorkflowEngine({
			store,
			artifactStore: artifacts,
			session: fakeSession({ cwd: workspace.cwd }),
			adapter: new RuntimeAdapter(async request => {
				calls++;
				return scriptedRunner({ plan: planArtifact() })(request);
			}),
		});
		const workflowId = await engine.startWorkflow({ request: "recover exact plan" });
		await engine.resume(workflowId, { singleStep: true });
		await engine.resume(workflowId, { singleStep: true });
		const attemptId = (await store.listAttempts(workflowId))[0]!.id;
		const corrupt = await artifacts.store({
			workflowId,
			attemptId,
			kind: "plan",
			schemaVersion: 1,
			relativePath: "",
			content: "{",
		});
		await store.addArtifact(corrupt);
		await expect(engine.resume(workflowId, { singleStep: true })).rejects.toThrow("required_artifact_invalid");
		expect(calls).toBe(1);
		expect((await store.getCurrentState(workflowId))?.runnerOwner).toBeUndefined();
	});

	it("does not load unrelated observation files while restoring planning state", async () => {
		const artifacts = new ArtifactStore(artifactDir);
		const engine = new WorkflowEngine({
			store,
			artifactStore: artifacts,
			session: fakeSession({ cwd: workspace.cwd }),
			adapter: new RuntimeAdapter(scriptedRunner({ plan: planArtifact() })),
		});
		const workflowId = await engine.startWorkflow({ request: "restore without historical observations" });
		await engine.resume(workflowId, { singleStep: true });
		await engine.resume(workflowId, { singleStep: true });
		const attemptId = (await store.listAttempts(workflowId))[0]!.id;
		const observation = await artifacts.store({
			workflowId,
			attemptId,
			kind: "prompt-assembly-receipt",
			schemaVersion: 1,
			relativePath: "",
			content: "{}",
		});
		await store.addArtifact(observation);
		await Bun.write(path.join(artifactDir, observation.relativePath), "corrupted observation");
		// Stop before the reviewer: a lock conflict proves hydration is not what failed.
		const state = (await store.getCurrentState(workflowId))!;
		await store.claimRunner(workflowId, "other-runner", state.version);
		await expect(engine.resume(workflowId, { singleStep: true })).rejects.toThrow("runner_lock_held");
		await store.releaseRunner(workflowId, "other-runner");
		const restarted = new WorkflowEngine({
			store,
			artifactStore: artifacts,
			session: fakeSession({ cwd: workspace.cwd }),
			adapter: new RuntimeAdapter(scriptedRunner({ planReview: reviewArtifact("approved", "plan") })),
		});
		const resumed = await restarted.resume(workflowId, { singleStep: true });
		expect(resumed.state.status).toBe("implementing");
	});

	it("abort unregister is owner-scoped under concurrent registration", () => {
		const workflowId = `wf_abort_${crypto.randomUUID()}`;
		const ownerA = { id: "a" };
		const ownerB = { id: "b" };
		const controllerA = new AbortController();
		const controllerB = new AbortController();

		const registeredA = registerWorkflowAbort(workflowId, controllerA, ownerA);
		expect(registeredA).toBe(ownerA);
		const registeredB = registerWorkflowAbort(workflowId, controllerB, ownerB);
		// Second registrant does not steal ownership
		expect(registeredB).toBe(ownerB);
		expect(unregisterWorkflowAbort(workflowId, ownerB)).toBe(false);
		expect(controllerA.signal.aborted).toBe(false);
		expect(abortRegisteredWorkflow(workflowId)).toBe(true);
		expect(controllerA.signal.aborted).toBe(true);
		expect(unregisterWorkflowAbort(workflowId, ownerA)).toBe(true);
		expect(abortRegisteredWorkflow(workflowId)).toBe(false);
	});
});
