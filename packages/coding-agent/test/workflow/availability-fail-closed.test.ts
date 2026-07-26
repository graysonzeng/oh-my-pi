import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactStore } from "../../src/workflow/artifact-store";
import { WorkflowEngine } from "../../src/workflow/engine";
import { WorkflowPolicyError } from "../../src/workflow/errors";
import { ModelRouter } from "../../src/workflow/model-router";
import { RuntimeAdapter } from "../../src/workflow/runtime-adapter";
import { WorkflowStore } from "../../src/workflow/sqlite-store";
import type { ModelProfile, WorkflowAvailabilityPort, WorkflowRole } from "../../src/workflow/types";
import { fakeSession, implArtifact, passVerifier, planArtifact, reviewArtifact, scriptedRunner } from "./helpers";

function testProfile(id: string, roles: WorkflowRole[], modelPattern: string): ModelProfile {
	return {
		id,
		vendor: "test",
		modelPattern,
		roles,
		promptTemplate: "planner",
		promptVersion: "1.0",
		toolPolicyId: "readonly",
		maxRequests: 10,
		maxRuntimeMs: 30_000,
		retryPolicy: { maxAttempts: 1, retryableErrorKinds: [], fallbackProfileIds: [] },
		contextPolicy: {
			includePlan: true,
			includeReviewFindings: true,
			includeVerification: true,
			includeFullTranscript: false,
			maxArtifactBytes: 10_000,
		},
	};
}

describe("availability fail-closed (required role unavailable)", () => {
	let store: WorkflowStore;
	let artifactDir: string;

	beforeEach(async () => {
		store = new WorkflowStore(":memory:");
		artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-avail-fc-"));
	});

	afterEach(async () => {
		store.close();
		await fs.rm(artifactDir, { recursive: true, force: true });
	});

	it("keeps workflow state, creates zero attempts, and names the unavailable role", async () => {
		const profiles = [
			testProfile("planner_a", ["planner"], "m-planner"),
			testProfile("reviewer_a", ["plan_reviewer"], "m-plan-review"),
			testProfile("impl_a", ["implementer"], "m-impl"),
			testProfile("code_a", ["code_reviewer"], "m-code"),
			testProfile("repair_a", ["repair"], "m-repair"),
		];

		// Planner always unavailable; other roles available.
		const availability: WorkflowAvailabilityPort = {
			async probe(req) {
				if (req.role === "planner" || req.profile.roles.includes("planner")) {
					// When probe representative is a planner profile
					if (req.profile.id === "planner_a") {
						return {
							status: "unavailable",
							latencyMs: 2,
							errorKind: "authentication",
							errorSummary: "planner credentials missing",
						};
					}
				}
				return {
					status: "available",
					actualProvider: "mock",
					actualModel: "ok",
					latencyMs: 1,
				};
			},
		};

		const engine = new WorkflowEngine({
			store,
			router: new ModelRouter(profiles),
			config: { profiles: Object.fromEntries(profiles.map(p => [p.id, p])) },
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
			availability,
		});

		const { workflowId } = await engine.start({ request: "fail closed" });
		// Advance created → planning so resume will need planner
		await engine.resume(workflowId, { singleStep: true, session: fakeSession() });
		const before = await engine.getState(workflowId);
		expect(before?.status).toBe("planning");
		const versionBefore = before!.version;
		const snapBefore = await engine.recoverFromPersistedState(workflowId);
		const attemptsBefore = snapBefore?.attempts.length ?? 0;

		let caught: unknown;
		try {
			await engine.resume(workflowId, { singleStep: true, session: fakeSession() });
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(WorkflowPolicyError);
		const err = caught as WorkflowPolicyError;
		expect(err.message).toMatch(/required_role_unavailable/i);
		expect(err.message).toMatch(/planner/i);

		const after = await engine.getState(workflowId);
		// Status must not advance into stage work; claim/release may bump version only.
		expect(after?.status).toBe("planning");
		expect(after?.status).toBe(before?.status);
		// No stage transitions beyond lock bookkeeping (claim + release each +1).
		expect(after!.version).toBeLessThanOrEqual(versionBefore + 2);

		const snapAfter = await engine.recoverFromPersistedState(workflowId);
		expect(snapAfter?.attempts.length ?? 0).toBe(attemptsBefore);
	});

	it("required role with zero registered profiles fail-closes before any attempt", async () => {
		// Registry has only implementer — no planner. At planning singleStep, planner is required.
		const profiles = [testProfile("impl_only", ["implementer"], "m-impl")];

		const availability: WorkflowAvailabilityPort = {
			async probe() {
				return {
					status: "available",
					actualProvider: "mock",
					actualModel: "ok",
					latencyMs: 1,
				};
			},
		};

		const engine = new WorkflowEngine({
			store,
			router: new ModelRouter(profiles),
			config: {
				profiles: Object.fromEntries(profiles.map(p => [p.id, p])),
				degradedMode: true,
				requireIndependentReview: false,
			},
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
			availability,
		});

		const { workflowId } = await engine.start({ request: "missing planner registry" });
		// created → planning (no model role at created singleStep)
		await engine.resume(workflowId, { singleStep: true, session: fakeSession() });
		const before = await engine.getState(workflowId);
		expect(before?.status).toBe("planning");
		const snapBefore = await engine.recoverFromPersistedState(workflowId);
		const attemptsBefore = snapBefore?.attempts.length ?? 0;
		expect(attemptsBefore).toBe(0);

		let caught: unknown;
		try {
			await engine.resume(workflowId, { singleStep: true, session: fakeSession() });
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(WorkflowPolicyError);
		const err = caught as WorkflowPolicyError;
		// Must be availability fail-closed, not late model_profile_not_found after an attempt.
		expect(err.message).toMatch(/required_role_unavailable/i);
		expect(err.message).toMatch(/planner/i);
		expect(err.message).not.toMatch(/model_profile_not_found/i);

		const after = await engine.getState(workflowId);
		expect(after?.status).toBe("planning");
		const snapAfter = await engine.recoverFromPersistedState(workflowId);
		expect(snapAfter?.attempts.length ?? 0).toBe(0);
	});

	it("does not block when a required role has at least one available fallback", async () => {
		const profiles = [
			testProfile("planner_primary", ["planner"], "m-planner-primary"),
			testProfile("planner_fallback", ["planner"], "m-planner-fallback"),
			testProfile("reviewer_a", ["plan_reviewer"], "m-plan-review"),
			testProfile("impl_a", ["implementer"], "m-impl"),
			testProfile("code_a", ["code_reviewer"], "m-code"),
		];

		const availability: WorkflowAvailabilityPort = {
			async probe(req) {
				if (req.profile.id === "planner_primary") {
					return {
						status: "unavailable",
						latencyMs: 1,
						errorKind: "quota",
						errorSummary: "primary out",
					};
				}
				return {
					status: "available",
					actualProvider: "mock",
					actualModel: "ok",
					latencyMs: 1,
				};
			},
		};

		const engine = new WorkflowEngine({
			store,
			router: new ModelRouter(profiles),
			config: { profiles: Object.fromEntries(profiles.map(p => [p.id, p])) },
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
			availability,
		});

		const { workflowId, availability: startReport } = await engine.start({ request: "degraded ok" });
		// start full preflight: planner primary unavailable but fallback available → not blocked
		expect(startReport.status).not.toBe("blocked");

		await engine.resume(workflowId, { singleStep: true, session: fakeSession() }); // → planning
		const result = await engine.resume(workflowId, { singleStep: true, session: fakeSession() });
		// Should have created a planner attempt (not fail-closed)
		expect(result.state.status === "plan_review" || result.state.status === "planning").toBe(true);
		const snap = await engine.recoverFromPersistedState(workflowId);
		expect((snap?.attempts.length ?? 0) > 0).toBe(true);
	});
});
