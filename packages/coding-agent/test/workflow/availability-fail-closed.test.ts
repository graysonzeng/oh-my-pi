import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-ai";
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

function qualityTestProfile(id: string, role: WorkflowRole): ModelProfile {
	const identityByRole: Record<WorkflowRole, { vendor: string; modelPattern: string }> = {
		planner: { vendor: "anthropic", modelPattern: "anthropic/claude-fable-5" },
		plan_reviewer: { vendor: "openai", modelPattern: "openai/gpt-5.6-sol" },
		plan_arbitrator: { vendor: "xai", modelPattern: "grok-4.6" },
		implementer: { vendor: "xai", modelPattern: "xai/grok-4.6" },
		code_reviewer: { vendor: "openai", modelPattern: "openai/gpt-5.6-terra" },
		repair: { vendor: "anthropic", modelPattern: "anthropic/claude-fable-5" },
	};
	const identity = identityByRole[role];
	return {
		...testProfile(id, [role], identity.modelPattern),
		vendor: identity.vendor,
		thinkingLevel: Effort.Medium,
		strictIdentity: true,
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

	it("quality routes fail closed before attempts for an unavailable required role", async () => {
		const profiles = [
			qualityTestProfile("planner_a", "planner"),
			qualityTestProfile("reviewer_a", "plan_reviewer"),
			qualityTestProfile("impl_a", "implementer"),
			qualityTestProfile("code_a", "code_reviewer"),
			qualityTestProfile("repair_a", "repair"),
		];
		let plannerUnavailable = false;
		// Start succeeds with an available snapshot; the planner becomes unavailable before the model stage.
		const availability: WorkflowAvailabilityPort = {
			async probe(req) {
				if (plannerUnavailable && (req.role === "planner" || req.profile.roles.includes("planner"))) {
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
			config: {
				profiles: Object.fromEntries(profiles.map(p => [p.id, p])),
				qualityRoutes: {
					balanced: {
						planner: ["planner_a"],
						plan_reviewer: ["reviewer_a"],
						plan_arbitrator: [],
						implementer: ["impl_a"],
						code_reviewer: ["code_a"],
						repair: ["repair_a"],
					},
					critical: {
						planner: ["planner_a"],
						plan_reviewer: ["reviewer_a"],
						plan_arbitrator: [],
						implementer: ["impl_a"],
						code_reviewer: ["code_a"],
						repair: ["repair_a"],
					},
				},
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

		const { workflowId } = await engine.start({ request: "fail closed", qualityTier: "balanced" });
		// Advance created → planning so resume will need planner
		await engine.resume(workflowId, { singleStep: true, session: fakeSession() });
		plannerUnavailable = true;
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

	it("allows a timed-out required quality route to reach its strict stage attempt", async () => {
		const profiles = [
			qualityTestProfile("planner_a", "planner"),
			qualityTestProfile("reviewer_a", "plan_reviewer"),
			qualityTestProfile("impl_a", "implementer"),
			qualityTestProfile("code_a", "code_reviewer"),
			qualityTestProfile("repair_a", "repair"),
		];
		let plannerTimedOut = false;
		const availability: WorkflowAvailabilityPort = {
			async probe(req) {
				if (plannerTimedOut && req.profile.id === "planner_a") {
					return {
						status: "unavailable",
						latencyMs: 2,
						errorKind: "timeout",
						errorSummary: "planner diagnostic timed out",
					};
				}
				return { status: "available", actualProvider: "mock", actualModel: "ok", latencyMs: 1 };
			},
		};
		const scripted = scriptedRunner({
			plan: planArtifact(),
			planReview: reviewArtifact("approved", "plan"),
			implement: implArtifact(),
			codeReview: reviewArtifact("approved", "implementation"),
		});
		let stageAttempts = 0;
		const engine = new WorkflowEngine({
			store,
			router: new ModelRouter(profiles),
			config: {
				profiles: Object.fromEntries(profiles.map(p => [p.id, p])),
				qualityRoutes: {
					balanced: {
						planner: ["planner_a"],
						plan_reviewer: ["reviewer_a"],
						plan_arbitrator: [],
						implementer: ["impl_a"],
						code_reviewer: ["code_a"],
						repair: ["repair_a"],
					},
				},
			},
			adapter: new RuntimeAdapter(async request => {
				stageAttempts += 1;
				const result = await scripted({ ...request, onResponse: undefined });
				const selector = Array.isArray(request.model) ? request.model[0] : request.model;
				if (typeof selector !== "string" || !selector.includes("/")) {
					throw new Error("timeout quality fixture requires provider/model selector");
				}
				const separator = selector.indexOf("/");
				const provider = selector.slice(0, separator);
				const model = selector.slice(separator + 1);
				request.onResponse?.(
					{ status: 200, headers: { "x-provider-model": selector } } as never,
					{
						provider,
						id: model,
						reasoning: true,
						thinking: { mode: "effort", efforts: [Effort.Medium] },
					} as never,
				);
				return result;
			}),
			verifier: passVerifier(),
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession(),
			availability,
		});

		const { workflowId } = await engine.start({ request: "timeout diagnostic", qualityTier: "balanced" });
		await engine.resume(workflowId, { singleStep: true, session: fakeSession() });
		plannerTimedOut = true;
		await engine.resume(workflowId, { singleStep: true, session: fakeSession() });

		const report = engine.getLastAvailabilityReport();
		expect(report?.status).toBe("degraded");
		expect(report?.blockedRoles ?? []).toEqual([]);
		expect(report?.profiles.find(row => row.profileId === "planner_a")?.errorKind).toBe("timeout");
		expect(stageAttempts).toBeGreaterThan(0);
		expect((await engine.getState(workflowId))?.status).not.toBe("blocked");
	});

	it("keeps legacy advisory behavior when a registered role is unavailable", async () => {
		const profiles = [testProfile("planner_only", ["planner"], "m-planner")];
		const availability: WorkflowAvailabilityPort = {
			async probe() {
				return {
					status: "unavailable",
					latencyMs: 1,
					errorKind: "authentication",
					errorSummary: "planner credentials missing",
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

		const { workflowId, availability: startReport } = await engine.start({ request: "legacy unavailable" });
		expect(startReport.status).toBe("blocked");
		await engine.resume(workflowId, { singleStep: true, session: fakeSession() });
		const before = await engine.getState(workflowId);
		expect(before?.status).toBe("planning");
		const attemptsBefore = (await engine.recoverFromPersistedState(workflowId))?.attempts.length ?? 0;

		let caught: unknown;
		try {
			await engine.resume(workflowId, { singleStep: true, session: fakeSession() });
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(WorkflowPolicyError);
		expect(engine.getLastAvailabilityReport()?.status).toBe("blocked");
		expect((caught as WorkflowPolicyError).message).toMatch(/model_profile_not_found/i);
		expect((caught as WorkflowPolicyError).message).not.toMatch(/required_role_unavailable/i);
		expect((await engine.getState(workflowId))?.status).toBe("blocked");
		expect((await engine.recoverFromPersistedState(workflowId))?.attempts.length ?? 0).toBeGreaterThan(
			attemptsBefore,
		);
	});

	it("keeps legacy advisory behavior when a required role has no registered profile", async () => {
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

		let caught: unknown;
		try {
			await engine.resume(workflowId, { singleStep: true, session: fakeSession() });
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(WorkflowPolicyError);
		expect(engine.getLastAvailabilityReport()?.status).toBe("blocked");
		const err = caught as WorkflowPolicyError;
		// Legacy workflows proceed to normal routing, where the missing profile is reported after an attempt.
		expect(err.message).toMatch(/model_profile_not_found/i);

		const after = await engine.getState(workflowId);
		expect(after?.status).toBe("blocked");
		const snapAfter = await engine.recoverFromPersistedState(workflowId);
		expect(snapAfter?.attempts.length ?? 0).toBeGreaterThan(attemptsBefore);
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
