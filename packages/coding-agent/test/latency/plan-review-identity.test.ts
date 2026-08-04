import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-ai";
import { ArtifactStore } from "../../src/workflow/artifact-store";
import { DEFAULT_MODEL_PROFILES } from "../../src/workflow/default-config";
import { WorkflowEngine } from "../../src/workflow/engine";
import { ModelRouter } from "../../src/workflow/model-router";
import { normalizeModelProfile } from "../../src/workflow/model-profile-registry";
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
		const engine = new WorkflowEngine({
			store,
			adapter: new RuntimeAdapter(
				scriptedRunner({
					plan: () => planArtifact({ summary: `plan-${planReviews}` }),
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
					plan: () => planArtifact({ summary: `plan-${planReviews}` }),
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

	it("arbitrates after the second rejection without a third replan", async () => {
		let planReviews = 0;
		const engine = new WorkflowEngine({
			store,
			config: { maxPlanCycles: 2 },
			adapter: new RuntimeAdapter(
				scriptedRunner({
					plan: () => planArtifact({ summary: `plan-${planReviews}` }),
					planReview: () => {
						planReviews += 1;
						if (planReviews <= 2) return planReviewArtifactV2("changes_requested");
						return planReviewArtifactV2("blocked", [], {
							explanation: "arbitration requires human authority",
						});
					},
				}),
			),
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession(),
		});

		const workflowId = await engine.startWorkflow({ request: "need arbitration" });
		const result = await engine.run(workflowId);
		expect(result.state.status).toBe("blocked");
		// Default profiles lack an exact-identity arbitrator → short-circuit to blocked
		// without a third paid review call (see F6 for the successful arbitration path).
		expect(planReviews).toBe(2);
		const transitions = await store.listTransitions(workflowId);
		expect(
			transitions.filter(
				transition => transition.fromStatus === "plan_review" && transition.toStatus === "planning",
			),
		).toHaveLength(1);
	});

	it("F6: eligible arbitrator runs a third reviewKind=arbitration lineage", async () => {
		let planReviews = 0;
		const seenAssignments: string[] = [];
		const exactArbitrator = normalizeModelProfile({
			...DEFAULT_MODEL_PROFILES.grok_plan_arbitrator,
			id: "exact_xai_arbitrator",
			modelPattern: "xai/grok-4.5",
			thinkingLevel: Effort.Medium,
		});
		const router = new ModelRouter([
			...Object.values(DEFAULT_MODEL_PROFILES).filter(profile => !profile.roles.includes("plan_arbitrator")),
			exactArbitrator,
		]);
		const baseRunner = scriptedRunner({
			plan: () => planArtifact({ summary: `plan-${planReviews}` }),
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
				return JSON.parse(loaded!.content ?? "{}") as { reviewKind?: string };
			}),
		);
		expect(bodies.some(body => body.reviewKind === "arbitration")).toBe(true);
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
							coverage: [],
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
	});

	it("C2: maxPlanCycles>2 stops after uncapped rejections", async () => {
		let planReviews = 0;
		const engine = new WorkflowEngine({
			store,
			config: { maxPlanCycles: 3 },
			adapter: new RuntimeAdapter(
				scriptedRunner({
					plan: () => planArtifact({ summary: `plan-${planReviews}` }),
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
