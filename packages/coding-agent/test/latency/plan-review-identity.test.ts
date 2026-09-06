import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-ai";
import { ArtifactStore } from "../../src/workflow/artifact-store";
import { DEFAULT_MODEL_PROFILES } from "../../src/workflow/default-config";
import { WorkflowEngine } from "../../src/workflow/engine";
import { normalizeModelProfile } from "../../src/workflow/model-profile-registry";
import { ModelRouter } from "../../src/workflow/model-router";
import { RuntimeAdapter } from "../../src/workflow/runtime-adapter";
import { WorkflowStore } from "../../src/workflow/sqlite-store";
import type { ModelProfile } from "../../src/workflow/types";
import { fakeSession, planArtifact, planReviewArtifactV2, scriptedRunner } from "../workflow/helpers";

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
		let planCount = 0;
		const engine = new WorkflowEngine({
			store,
			adapter: new RuntimeAdapter(
				scriptedRunner({
					plan: () => {
						planCount += 1;
						if (planCount === 1) return planArtifact({ summary: "plan-initial" });
						return planArtifact({
							summary: "plan-replan",
							authorResponses: [
								{
									findingId: "f-default",
									disposition: "accepted",
									explanation: "will fix default finding",
									evidenceRefs: ["plan:step-1"],
								},
							],
						});
					},
					planReview: () => {
						planReviews += 1;
						if (planReviews === 1) return planReviewArtifactV2("changes_requested");
						return planReviewArtifactV2("approved");
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
		const controlMeta = (await store.listArtifacts(workflowId))
			.filter(artifact => artifact.kind === "plan-review-control-state")
			.at(-1);
		expect(controlMeta).toBeDefined();
		const controlBody = controlMeta
			? await new ArtifactStore(artifactDir).load(controlMeta.relativePath, controlMeta.sha256)
			: null;
		expect(controlBody ? JSON.parse(controlBody.content ?? "{}") : null).toMatchObject({
			substate: "awaiting_replan",
			reviewRound: 1,
			planRejectionCount: 1,
		});

		const resumed = new WorkflowEngine({
			store,
			adapter: new RuntimeAdapter(
				scriptedRunner({
					plan: () =>
						planArtifact({
							summary: "plan-replan",
							authorResponses: [
								{
									findingId: "f-default",
									disposition: "accepted",
									explanation: "will fix default finding",
									evidenceRefs: ["plan:step-1"],
								},
							],
						}),
					planReview: () => {
						planReviews += 1;
						return planReviewArtifactV2("approved");
					},
				}),
			),
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession(),
		});
		await resumed.resume(workflowId, { singleStep: true });
		expect((await resumed.getState(workflowId))?.status).toBe("plan_review");
		await resumed.resume(workflowId, { singleStep: true });
		expect((await resumed.getState(workflowId))?.status).toBe("implementing");
		expect(planReviews).toBe(2);
	});

	it("HIGH-4: fails closed when initial review has no attested runtime identity", async () => {
		const engine = new WorkflowEngine({
			store,
			adapter: new RuntimeAdapter(async request => {
				const agent = request.agent ?? "";
				if (agent === "designer" || agent === "planner") {
					return {
						result: {
							id: "raw_plan",
							structuredOutput: { status: "valid", data: planArtifact({ summary: "plan-no-attestation" }) },
							resolvedModel: "xai/grok-code-test",
						},
					};
				}
				if (agent === "reviewer" || agent === "plan_reviewer") {
					// Intentionally omit onResponse attestation — pin must fail closed.
					return {
						result: {
							id: "raw_plan_review",
							structuredOutput: {
								status: "valid",
								data: planReviewArtifactV2("changes_requested"),
							},
							resolvedModel: "openai/gpt-5.6-sol",
						},
					};
				}
				throw new Error(`unexpected agent ${agent}`);
			}),
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession(),
		});

		const workflowId = await engine.startWorkflow({ request: "no attestation pin" });
		await expect(engine.run(workflowId)).rejects.toMatchObject({
			kind: "policy_violation",
			message: expect.stringContaining("plan_reviewer_identity_unavailable"),
		});
		const routeSelections = (await store.listArtifacts(workflowId)).filter(
			artifact => artifact.kind === "plan-review-route-selection",
		);
		expect(routeSelections).toHaveLength(0);
	});

	it("HIGH-4: persists attested route selection and reuses pin across resume", async () => {
		let planReviews = 0;
		let planCount = 0;
		const engine = new WorkflowEngine({
			store,
			adapter: new RuntimeAdapter(
				scriptedRunner({
					plan: () => {
						planCount += 1;
						if (planCount === 1) return planArtifact({ summary: "plan-initial-attested" });
						return planArtifact({
							summary: "plan-replan-attested",
							authorResponses: [
								{
									findingId: "f-default",
									disposition: "accepted",
									explanation: "will fix default finding",
									evidenceRefs: ["plan:step-1"],
								},
							],
						});
					},
					planReview: () => {
						planReviews += 1;
						if (planReviews === 1) return planReviewArtifactV2("changes_requested");
						return planReviewArtifactV2("approved");
					},
				}),
			),
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession(),
		});

		const workflowId = await engine.startWorkflow({ request: "attested pin resume" });
		await engine.resume(workflowId, { singleStep: true }); // created → planning
		await engine.resume(workflowId, { singleStep: true }); // planning
		await engine.resume(workflowId, { singleStep: true }); // plan_review → planning
		expect((await engine.getState(workflowId))?.status).toBe("planning");
		const routeMeta = (await store.listArtifacts(workflowId)).filter(
			artifact => artifact.kind === "plan-review-route-selection",
		);
		expect(routeMeta.length).toBe(1);
		const routeLoaded = await new ArtifactStore(artifactDir).load(routeMeta[0]!.relativePath, routeMeta[0]!.sha256);
		expect(routeLoaded?.content).toBeTruthy();
		const route = JSON.parse(routeLoaded!.content!) as {
			kind?: string;
			profileId?: string;
			attestedProvider?: string;
			attestedModel?: string;
		};
		expect(route.kind).toBe("plan_review_route_selection");
		expect(typeof route.profileId).toBe("string");
		expect(typeof route.attestedProvider).toBe("string");
		expect(typeof route.attestedModel).toBe("string");
		expect((route.attestedProvider ?? "").length).toBeGreaterThan(0);
		expect((route.attestedModel ?? "").length).toBeGreaterThan(0);

		const controlMeta = (await store.listArtifacts(workflowId))
			.filter(artifact => artifact.kind === "plan-review-control-state")
			.at(-1);
		const controlBody = controlMeta
			? await new ArtifactStore(artifactDir).load(controlMeta.relativePath, controlMeta.sha256)
			: null;
		expect(controlBody ? JSON.parse(controlBody.content ?? "{}") : null).toMatchObject({
			substate: "awaiting_replan",
			routeSelectionReceiptRef: expect.any(String),
		});

		const resumed = new WorkflowEngine({
			store,
			adapter: new RuntimeAdapter(
				scriptedRunner({
					plan: () =>
						planArtifact({
							summary: "plan-replan-attested",
							authorResponses: [
								{
									findingId: "f-default",
									disposition: "accepted",
									explanation: "will fix default finding",
									evidenceRefs: ["plan:step-1"],
								},
							],
						}),
					planReview: () => {
						planReviews += 1;
						return planReviewArtifactV2("approved");
					},
				}),
			),
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession(),
		});
		await resumed.resume(workflowId, { singleStep: true }); // replan → plan_review
		expect((await resumed.getState(workflowId))?.status).toBe("plan_review");
		await resumed.resume(workflowId, { singleStep: true }); // rereview with hydrated pin
		expect((await resumed.getState(workflowId))?.status).toBe("implementing");
		expect(planReviews).toBe(2);
		// Route selection is established once on initial pin; resume must not rewrite it.
		expect(
			(await store.listArtifacts(workflowId)).filter(artifact => artifact.kind === "plan-review-route-selection"),
		).toHaveLength(1);
	});

	it("blocks second rejection without author reject evidence", async () => {
		let planReviews = 0;
		let planCount = 0;
		const engine = new WorkflowEngine({
			store,
			config: { maxPlanCycles: 2 },
			adapter: new RuntimeAdapter(
				scriptedRunner({
					plan: () => {
						planCount += 1;
						if (planCount === 1) return planArtifact({ summary: "plan-initial" });
						return planArtifact({
							summary: "plan-replan-accept",
							authorResponses: [
								{
									findingId: "f-default",
									disposition: "accepted",
									explanation: "accepted finding; no disagreement",
									evidenceRefs: [],
								},
							],
						});
					},
					planReview: () => {
						planReviews += 1;
						return planReviewArtifactV2("changes_requested");
					},
				}),
			),
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession(),
		});

		const workflowId = await engine.startWorkflow({ request: "no author reject" });
		const result = await engine.run(workflowId);
		expect(result.state.status).toBe("blocked");
		expect(planReviews).toBe(2);
		const transitions = await store.listTransitions(workflowId);
		expect(transitions.some(transition => transition.reason === "max_plan_cycles_exceeded")).toBe(true);
		expect(
			transitions.filter(
				transition => transition.fromStatus === "plan_review" && transition.toStatus === "planning",
			),
		).toHaveLength(1);
		const controlMeta = (await store.listArtifacts(workflowId))
			.filter(artifact => artifact.kind === "plan-review-control-state")
			.at(-1);
		const controlBody = controlMeta
			? await new ArtifactStore(artifactDir).load(controlMeta.relativePath, controlMeta.sha256)
			: null;
		expect(controlBody ? JSON.parse(controlBody.content ?? "{}") : null).toMatchObject({
			substate: "awaiting_human",
			humanRequestReason: "max_plan_cycles_exceeded",
			arbitrationTrigger: null,
		});
	});

	it("F6: eligible arbitrator runs only when author rejects P0/P1 with evidence", async () => {
		let planReviews = 0;
		let planCount = 0;
		const seenAssignments: string[] = [];
		const exactArbitrator = normalizeModelProfile({
			...DEFAULT_MODEL_PROFILES.grok_plan_arbitrator,
			id: "exact_xai_arbitrator",
			modelPattern: "xai/grok-4.6",
			thinkingLevel: Effort.Medium,
		});
		const router = new ModelRouter([
			...Object.values(DEFAULT_MODEL_PROFILES).filter(profile => !profile.roles.includes("plan_arbitrator")),
			exactArbitrator,
		]);
		const baseRunner = scriptedRunner({
			plan: () => {
				planCount += 1;
				if (planCount === 1) return planArtifact({ summary: "plan-initial" });
				return planArtifact({
					summary: "plan-replan-reject",
					authorResponses: [
						{
							findingId: "f-default",
							disposition: "rejected",
							explanation: "prior finding is wrong; auth is covered by step-1",
							evidenceRefs: ["plan:step-1", "src/auth.ts:1"],
						},
					],
				});
			},
			planReview: () => {
				planReviews += 1;
				if (planReviews <= 2) return planReviewArtifactV2("changes_requested");
				return planReviewArtifactV2("approved", [], {
					explanation: "arbitrator approves after bounded disagreement",
					reviewKind: "arbitration",
					triggerReason: "max_cycles_author_reject",
				});
			},
			implement: () => {
				throw new Error("F6 must stop at implementing — implement must not run");
			},
		});
		const engine = new WorkflowEngine({
			store,
			config: { maxPlanCycles: 2 },
			router,
			adapter: new RuntimeAdapter(async request => {
				seenAssignments.push(request.assignment);
				return baseRunner(request);
			}),
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession(),
		});

		const workflowId = await engine.startWorkflow({ request: "need real arbitration" });
		for (let i = 0; i < 12; i++) {
			const state = await engine.getState(workflowId);
			if (!state || state.status === "implementing" || state.status === "blocked" || state.status === "failed") {
				break;
			}
			await engine.resume(workflowId, { singleStep: true });
		}
		const result = await engine.getState(workflowId);
		expect(result?.status).toBe("implementing");
		expect(planReviews).toBe(3);
		expect(seenAssignments.some(assignment => /arbitrate/i.test(assignment))).toBe(true);
		const reviewMetas = (await store.listArtifacts(workflowId)).filter(artifact => artifact.kind === "review");
		const bodies = await Promise.all(
			reviewMetas.map(async meta => {
				const loaded = await new ArtifactStore(artifactDir).load(meta.relativePath, meta.sha256);
				expect(loaded).not.toBeNull();
				return JSON.parse(loaded!.content ?? "{}") as {
					reviewKind?: string;
					authorResponses?: Array<{ disposition?: string }>;
					triggerReason?: string | null;
				};
			}),
		);
		expect(bodies.some(body => body.reviewKind === "arbitration")).toBe(true);
		expect(
			bodies.some(
				body =>
					body.reviewKind === "rereview" &&
					body.authorResponses?.some(response => response.disposition === "rejected"),
			),
		).toBe(true);
		const authorResponseMetas = (await store.listArtifacts(workflowId)).filter(
			artifact => artifact.kind === "author_responses",
		);
		expect(authorResponseMetas.length).toBeGreaterThan(0);
		const transitions = await store.listTransitions(workflowId);
		expect(
			transitions.filter(
				transition => transition.fromStatus === "plan_review" && transition.toStatus === "planning",
			),
		).toHaveLength(1);
	});

	it("escalates a structured contradiction trigger without replanning", async () => {
		let planReviews = 0;
		const engine = new WorkflowEngine({
			store,
			adapter: new RuntimeAdapter(
				scriptedRunner({
					plan: planArtifact(),
					planReview: () => {
						planReviews += 1;
						// Engine derives contradiction from dual coverage — not model triggerReason.
						return planReviewArtifactV2("approved", [], {
							triggerReason: null,
							coverage: [
								{
									requirementId: "req-auth",
									source: "user_requirement",
									mandatory: true,
									status: "satisfied",
									evidenceRefs: ["plan:step-1"],
									rationale: "plan addresses auth",
								},
								{
									requirementId: "req-auth",
									source: "user_requirement",
									mandatory: false,
									status: "violated",
									evidenceRefs: ["plan:step-2"],
									rationale: "same req also marked violated",
								},
							],
						});
					},
				}),
			),
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession(),
		});

		const workflowId = await engine.startWorkflow({ request: "contradictory coverage" });
		const result = await engine.run(workflowId);
		expect(result.state.status).toBe("blocked");
		expect(planReviews).toBe(1);
		const transitions = await store.listTransitions(workflowId);
		expect(
			transitions.filter(
				transition => transition.fromStatus === "plan_review" && transition.toStatus === "planning",
			),
		).toHaveLength(0);
	});

	it("C1: ignores forged model triggerReason without contradictory evidence", async () => {
		let planReviews = 0;
		const engine = new WorkflowEngine({
			store,
			adapter: new RuntimeAdapter(
				scriptedRunner({
					plan: planArtifact(),
					planReview: () => {
						planReviews += 1;
						return planReviewArtifactV2("approved", [], {
							triggerReason: "contradiction",
							findings: [],
						});
					},
				}),
			),
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession(),
		});

		const workflowId = await engine.startWorkflow({ request: "forged trigger" });
		// Only advance through plan_review — forged trigger must not escalate.
		await engine.resume(workflowId, { singleStep: true }); // created → planning
		await engine.resume(workflowId, { singleStep: true }); // planning
		await engine.resume(workflowId, { singleStep: true }); // plan_review → implementing
		const state = await engine.getState(workflowId);
		expect(state?.status).toBe("implementing");
		expect(state?.status).not.toBe("blocked");
		expect(planReviews).toBe(1);
	});

	it("C1: real contradiction coverage escalates even when model triggerReason is null", async () => {
		let planReviews = 0;
		const engine = new WorkflowEngine({
			store,
			adapter: new RuntimeAdapter(
				scriptedRunner({
					plan: planArtifact(),
					planReview: () => {
						planReviews += 1;
						return planReviewArtifactV2("approved", [], {
							triggerReason: "suspicious_pass",
							coverage: [
								{
									requirementId: "req-x",
									source: "spec_requirement",
									mandatory: true,
									status: "satisfied",
									evidenceRefs: ["spec:1"],
									rationale: "covered",
								},
								{
									requirementId: "req-x",
									source: "spec_requirement",
									mandatory: false,
									status: "violated",
									evidenceRefs: ["spec:2"],
									rationale: "also violated",
								},
							],
						});
					},
				}),
			),
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession(),
		});

		const workflowId = await engine.startWorkflow({ request: "real contradiction" });
		const result = await engine.run(workflowId);
		// Default fixture has no eligible arbitrator → terminal blocked (not silent approve).
		expect(result.state.status).toBe("blocked");
		expect(planReviews).toBe(1);
		const transitions = await store.listTransitions(workflowId);
		expect(
			transitions.filter(
				transition => transition.fromStatus === "plan_review" && transition.toStatus === "planning",
			),
		).toHaveLength(0);
		// Persisted stamped review must re-parse under the durable (non-stage) Zod schema.
		const { PlanReviewArtifactV2Schema } = await import("../../src/workflow/schemas");
		const reviewMeta = (await store.listArtifacts(workflowId)).filter(a => a.kind === "review").at(-1);
		expect(reviewMeta).toBeDefined();
		const loaded = await new ArtifactStore(artifactDir).load(reviewMeta!.relativePath, reviewMeta!.sha256);
		const parsed = PlanReviewArtifactV2Schema.safeParse(JSON.parse(loaded!.content ?? "{}"));
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data.triggerReason).toBe("contradiction");
			expect(parsed.data.reviewKind).toBe("initial");
		}
	});

	it("C2: maxPlanCycles>2 stops after uncapped rejections", async () => {
		let planReviews = 0;
		let planCount = 0;
		const engine = new WorkflowEngine({
			store,
			config: { maxPlanCycles: 3 },
			adapter: new RuntimeAdapter(
				scriptedRunner({
					plan: () => {
						planCount += 1;
						if (planCount === 1) return planArtifact({ summary: "plan-initial" });
						return planArtifact({
							summary: `plan-replan-${planCount}`,
							authorResponses: [
								{
									findingId: "f-default",
									disposition: "accepted",
									explanation: "accepted for replan",
									evidenceRefs: [],
								},
							],
						});
					},
					planReview: () => {
						planReviews += 1;
						return planReviewArtifactV2("changes_requested");
					},
				}),
			),
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession(),
		});

		const workflowId = await engine.startWorkflow({ request: "uncapped cycles" });
		// Cap resumes so a regression cannot spin forever.
		for (let i = 0; i < 10; i++) {
			const state = await engine.getState(workflowId);
			if (!state || state.status === "blocked" || state.status === "completed" || state.status === "failed") break;
			await engine.resume(workflowId, { singleStep: true });
		}
		const final = await engine.getState(workflowId);
		expect(final?.status).toBe("blocked");
		expect(planReviews).toBe(3);
		const transitions = await store.listTransitions(workflowId);
		expect(
			transitions.filter(
				transition => transition.fromStatus === "plan_review" && transition.toStatus === "planning",
			),
		).toHaveLength(2);
	});

	it("F5: resume with reserved arbitration and no trusted artifact fails closed without re-pay", async () => {
		let planReviews = 0;
		let arbitrationCalls = 0;
		const exactArbitrator = normalizeModelProfile({
			...DEFAULT_MODEL_PROFILES.grok_plan_arbitrator,
			id: "exact_xai_arbitrator_f5",
			modelPattern: "xai/grok-4.6",
			thinkingLevel: Effort.Medium,
		});
		const router = new ModelRouter([
			...Object.values(DEFAULT_MODEL_PROFILES).filter(profile => !profile.roles.includes("plan_arbitrator")),
			exactArbitrator,
		]);
		const baseRunner = scriptedRunner({
			plan: planArtifact(),
			planReview: () => {
				planReviews += 1;
				return planReviewArtifactV2("approved", [], {
					explanation: "must not be reached on reserved resume",
					reviewKind: "arbitration",
					triggerReason: "contradiction",
				});
			},
		});
		const makeEngine = () =>
			new WorkflowEngine({
				store,
				router,
				adapter: new RuntimeAdapter(async request => {
					if (/arbitrate/i.test(request.assignment)) arbitrationCalls += 1;
					return baseRunner(request);
				}),
				artifactStore: new ArtifactStore(artifactDir),
				session: fakeSession(),
			});

		const engine = makeEngine();
		const workflowId = await engine.startWorkflow({ request: "f5 crash window" });
		await engine.resume(workflowId, { singleStep: true }); // → planning
		await engine.resume(workflowId, { singleStep: true }); // planning → plan_review
		const mid = await engine.getState(workflowId);
		expect(mid?.status).toBe("plan_review");
		const attemptId = (await store.listAttempts(workflowId)).at(-1)?.id;
		expect(attemptId).toBeTruthy();

		// Simulate crash after pre-call reservation (cycles=1, phase=reserved, no arbitration artifact).
		const control = {
			schemaVersion: 1 as const,
			kind: "plan_review_control_state" as const,
			substate: "arbitration" as const,
			reviewRound: 1 as const,
			planRejectionCount: 0,
			arbitrationCycles: 1 as const,
			arbitrationTrigger: "contradiction" as const,
			arbitrationAttemptId: "arb_reserved_f5",
			arbitrationAttemptPhase: "reserved" as const,
			reviewSchemaCohort: "v2" as const,
			latestPlanArtifactRef: null,
			latestReviewArtifactRef: null,
			authorResponsesArtifactRef: null,
			routeSelectionReceiptRef: null,
			humanRequestReason: null,
			updatedAt: new Date().toISOString(),
		};
		const content = JSON.stringify(control);
		const stored = await new ArtifactStore(artifactDir).store({
			workflowId,
			attemptId: attemptId!,
			kind: "plan-review-control-state",
			schemaVersion: 1,
			relativePath: "",
			content,
		});
		await store.addArtifact({
			workflowId,
			attemptId: attemptId!,
			kind: "plan-review-control-state",
			schemaVersion: 1,
			relativePath: stored.relativePath,
			sha256: stored.sha256,
			content,
		});

		const resumed = makeEngine();
		for (let i = 0; i < 6; i++) {
			const state = await resumed.getState(workflowId);
			if (!state || state.status === "implementing" || state.status === "blocked" || state.status === "failed") {
				break;
			}
			await resumed.resume(workflowId, { singleStep: true });
		}
		const final = await resumed.getState(workflowId);
		expect(final?.status).toBe("blocked");
		expect(arbitrationCalls).toBe(0);
		expect(planReviews).toBe(0);
		const controlMeta = (await store.listArtifacts(workflowId))
			.filter(a => a.kind === "plan-review-control-state")
			.at(-1);
		const controlBody = controlMeta
			? await new ArtifactStore(artifactDir).load(controlMeta.relativePath, controlMeta.sha256)
			: null;
		expect(controlBody ? JSON.parse(controlBody.content ?? "{}") : null).toMatchObject({
			substate: "awaiting_human",
			humanRequestReason: "arbitration attempt has no trusted artifact",
			arbitrationCycles: 1,
			arbitrationAttemptPhase: "reserved",
			arbitrationAttemptId: "arb_reserved_f5",
		});
	});

	it("F5b: resume with trusted arbitration artifact finishes transition without re-call", async () => {
		let planReviews = 0;
		let arbitrationCalls = 0;
		const exactArbitrator = normalizeModelProfile({
			...DEFAULT_MODEL_PROFILES.grok_plan_arbitrator,
			id: "exact_xai_arbitrator_f5b",
			modelPattern: "xai/grok-4.6",
			thinkingLevel: Effort.Medium,
		});
		const router = new ModelRouter([
			...Object.values(DEFAULT_MODEL_PROFILES).filter(profile => !profile.roles.includes("plan_arbitrator")),
			exactArbitrator,
		]);
		const baseRunner = scriptedRunner({
			plan: planArtifact(),
			planReview: () => {
				planReviews += 1;
				return planReviewArtifactV2("approved", [], {
					explanation: "must not re-run arbitration",
					reviewKind: "arbitration",
					triggerReason: "contradiction",
				});
			},
		});
		const makeEngine = () =>
			new WorkflowEngine({
				store,
				router,
				adapter: new RuntimeAdapter(async request => {
					if (/arbitrate/i.test(request.assignment)) arbitrationCalls += 1;
					return baseRunner(request);
				}),
				artifactStore: new ArtifactStore(artifactDir),
				session: fakeSession(),
			});

		const engine = makeEngine();
		const workflowId = await engine.startWorkflow({ request: "f5b trusted artifact resume" });
		await engine.resume(workflowId, { singleStep: true }); // → planning
		await engine.resume(workflowId, { singleStep: true }); // planning → plan_review
		const mid = await engine.getState(workflowId);
		expect(mid?.status).toBe("plan_review");
		const attemptId = (await store.listAttempts(workflowId)).at(-1)?.id;
		expect(attemptId).toBeTruthy();

		const arbitrationReview = planReviewArtifactV2("approved", [], {
			explanation: "arbitrator already decided",
			reviewKind: "arbitration",
			triggerReason: "contradiction",
		});
		const reviewContent = JSON.stringify(arbitrationReview);
		const storedReview = await new ArtifactStore(artifactDir).store({
			workflowId,
			attemptId: attemptId!,
			kind: "review",
			schemaVersion: 2,
			relativePath: "",
			content: reviewContent,
		});
		await store.addArtifact({
			workflowId,
			attemptId: attemptId!,
			kind: "review",
			schemaVersion: 2,
			relativePath: storedReview.relativePath,
			sha256: storedReview.sha256,
			content: reviewContent,
		});

		// Crash window: review persisted, control still reserved (or completed without transition).
		// latestReviewArtifactRef must match ArtifactStore id (basename of relativePath), not sqlite row id.
		const control = {
			schemaVersion: 1 as const,
			kind: "plan_review_control_state" as const,
			substate: "arbitration" as const,
			reviewRound: 1 as const,
			planRejectionCount: 0,
			arbitrationCycles: 1 as const,
			arbitrationTrigger: "contradiction" as const,
			arbitrationAttemptId: "arb_completed_f5b",
			arbitrationAttemptPhase: "reserved" as const,
			reviewSchemaCohort: "v2" as const,
			latestPlanArtifactRef: null,
			latestReviewArtifactRef: storedReview.id,
			authorResponsesArtifactRef: null,
			routeSelectionReceiptRef: null,
			humanRequestReason: null,
			updatedAt: new Date().toISOString(),
		};
		const controlContent = JSON.stringify(control);
		const storedControl = await new ArtifactStore(artifactDir).store({
			workflowId,
			attemptId: attemptId!,
			kind: "plan-review-control-state",
			schemaVersion: 1,
			relativePath: "",
			content: controlContent,
		});
		await store.addArtifact({
			workflowId,
			attemptId: attemptId!,
			kind: "plan-review-control-state",
			schemaVersion: 1,
			relativePath: storedControl.relativePath,
			sha256: storedControl.sha256,
			content: controlContent,
		});

		const resumed = makeEngine();
		for (let i = 0; i < 6; i++) {
			const state = await resumed.getState(workflowId);
			if (!state || state.status === "implementing" || state.status === "blocked" || state.status === "failed") {
				break;
			}
			await resumed.resume(workflowId, { singleStep: true });
		}
		const final = await resumed.getState(workflowId);
		expect(final?.status).toBe("implementing");
		expect(arbitrationCalls).toBe(0);
		expect(planReviews).toBe(0);
		const transitions = await store.listTransitions(workflowId);
		expect(
			transitions.some(
				transition =>
					transition.fromStatus === "plan_review" &&
					transition.toStatus === "implementing" &&
					transition.reason === "plan_review:arbitration_approved",
			),
		).toBe(true);
	});

	it("C3: missing_authority reaches terminal blocked with awaiting_human control", async () => {
		const engine = new WorkflowEngine({
			store,
			adapter: new RuntimeAdapter(
				scriptedRunner({
					plan: planArtifact(),
					planReview: () =>
						planReviewArtifactV2("blocked", [
							{
								id: "f-auth",
								priority: "P0",
								category: "correctness",
								status: "open",
								confidence: 0.95,
								summary: "need human authority",
								explanation: "missing product decision",
								suggestedOwner: "human",
								basis: "missing_authority",
								requirementId: null,
								sourceRefs: ["test:authority"],
								missingAuthority: "product_owner",
							},
						]),
				}),
			),
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession(),
		});

		const workflowId = await engine.startWorkflow({ request: "need human" });
		const result = await engine.run(workflowId);
		expect(result.state.status).toBe("blocked");
		expect(result.state.status).not.toBe("plan_review");
		const controlMeta = (await store.listArtifacts(workflowId))
			.filter(artifact => artifact.kind === "plan-review-control-state")
			.at(-1);
		expect(controlMeta).toBeDefined();
		const controlBody = controlMeta
			? await new ArtifactStore(artifactDir).load(controlMeta.relativePath, controlMeta.sha256)
			: null;
		expect(controlBody ? JSON.parse(controlBody.content ?? "{}") : null).toMatchObject({
			substate: "awaiting_human",
			humanRequestReason: "missing_authority",
		});
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
