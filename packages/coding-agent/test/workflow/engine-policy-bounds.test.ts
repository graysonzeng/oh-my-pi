import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactStore } from "../../src/workflow/artifact-store";
import { BudgetLedger } from "../../src/workflow/budget-ledger";
import { WorkflowEngine } from "../../src/workflow/engine";
import { WorkflowPolicyError } from "../../src/workflow/errors";
import { RuntimeAdapter } from "../../src/workflow/runtime-adapter";
import { WorkflowStore } from "../../src/workflow/sqlite-store";
import { FinalVerifyStage } from "../../src/workflow/stages/final-verify";
import type { ReviewFindingV1 } from "../../src/workflow/types";
import { fakeSession, implArtifact, passVerifier, planArtifact, reviewArtifact, scriptedRunner } from "./helpers";

const finding = (
	overrides: Partial<ReviewFindingV1> & Pick<ReviewFindingV1, "id" | "confidence" | "priority">,
): ReviewFindingV1 => ({
	category: "correctness",
	status: "open",
	summary: "issue",
	explanation: "details",
	suggestedOwner: "implementer",
	...overrides,
});

describe("WorkflowEngine policy bounds regressions", () => {
	let store: WorkflowStore;
	let artifactDir: string;

	beforeEach(async () => {
		store = new WorkflowStore(":memory:");
		artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-bounds-"));
	});

	afterEach(async () => {
		store.close();
		await fs.rm(artifactDir, { recursive: true, force: true });
	});

	it("forceUnlock clears stale runner lock so resume can continue without cancel", async () => {
		const id = await store.createWorkflow({ request: "stuck lock" }, {});
		await store.transitionWorkflow(id, "created", "planning", "start");
		const before = await store.getCurrentState(id);
		expect(before?.status).toBe("planning");
		await store.claimRunner(id, "dead-process-owner", before!.version);

		const engine = new WorkflowEngine({
			store,
			session: fakeSession(),
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
		});

		// Without forceUnlock, exclusive claim fails
		await expect(engine.resume(id, { singleStep: true, session: fakeSession() })).rejects.toBeInstanceOf(
			WorkflowPolicyError,
		);
		expect((await engine.getState(id))?.status).toBe("planning");

		// forceUnlock does not terminal-cancel
		await engine.forceUnlock(id);
		expect((await engine.getState(id))?.status).toBe("planning");

		// resume with forceUnlock also works (clears then runs)
		const id2 = await store.createWorkflow({ request: "force flag" }, {});
		await store.transitionWorkflow(id2, "created", "planning", "go");
		const s2 = await store.getCurrentState(id2);
		await store.claimRunner(id2, "another-dead-owner", s2!.version);
		const stepped = await engine.resume(id2, { singleStep: true, session: fakeSession(), forceUnlock: true });
		expect(stepped.state.status).not.toBe("cancelled");
		expect(["planning", "plan_review", "implementing", "implementation_verify"]).toContain(stepped.state.status);
	});

	it("maxRepairCycles=1 allows exactly one repair call then blocks further provider stages", async () => {
		let repairCalls = 0;
		let codeReviews = 0;
		const openFinding = finding({ id: "f-repair", priority: "P1", confidence: 0.99 });

		const ledger = new BudgetLedger({ limitUsd: 100, maxRepairCycles: 1 });
		const engine = new WorkflowEngine({
			store,
			budgetLedger: ledger,
			config: { maxRepairCycles: 1, maxBudgetUsd: 100 },
			adapter: new RuntimeAdapter(
				scriptedRunner({
					plan: planArtifact(),
					planReview: reviewArtifact("approved", "plan"),
					implement: implArtifact(),
					codeReview: () => {
						codeReviews += 1;
						// Always request changes so workflow would repair forever without budget bound
						return reviewArtifact("changes_requested", "implementation", [openFinding]);
					},
					repair: () => {
						repairCalls += 1;
						// Do not resolve finding — forces another review→repair cycle attempt
						return implArtifact({ addressedStepIds: [], summary: `repair-${repairCalls}` });
					},
				}),
			),
			verifier: passVerifier(),
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession(),
		});

		const workflowId = await engine.startWorkflow({ request: "bounded repair" });
		let lastError: unknown;
		try {
			await engine.run(workflowId);
		} catch (error) {
			lastError = error;
		}

		const state = await engine.getState(workflowId);
		expect(repairCalls).toBe(1);
		expect(ledger.snapshot().repairCycles).toBe(1);
		// After one completed repair, next pre-stage budget check blocks (or we land in blocked)
		expect(
			state?.status === "blocked" ||
				lastError instanceof Error ||
				(lastError !== undefined && String(lastError).includes("Budget")),
		).toBe(true);
		// Must not have unbounded repair calls
		expect(repairCalls).toBeLessThanOrEqual(1);
		expect(codeReviews).toBeGreaterThanOrEqual(1);
	});

	it("maxRepairCycles=3 allows up to three completed repairs", async () => {
		let repairCalls = 0;
		let reviewN = 0;
		// Distinct fingerprints each review so finding-tracker third-cycle block does not
		// mask the budget ledger's maxRepairCycles contract under test.
		const ledger = new BudgetLedger({ limitUsd: 100, maxRepairCycles: 3 });
		const engine = new WorkflowEngine({
			store,
			budgetLedger: ledger,
			config: { maxRepairCycles: 3, maxBudgetUsd: 100 },
			adapter: new RuntimeAdapter(
				scriptedRunner({
					plan: planArtifact(),
					planReview: reviewArtifact("approved", "plan"),
					implement: implArtifact(),
					codeReview: () => {
						reviewN += 1;
						return reviewArtifact("changes_requested", "implementation", [
							finding({
								id: `f-multi-${reviewN}`,
								priority: "P1",
								confidence: 0.99,
								summary: `distinct bug ${reviewN}`,
								file: `src/file${reviewN}.ts`,
							}),
						]);
					},
					repair: () => {
						repairCalls += 1;
						// Resolve current finding id so next cycle is a fresh open finding, not repeated fingerprint
						return implArtifact({
							addressedStepIds: [`f-multi-${reviewN}`],
							summary: `r${repairCalls}`,
						});
					},
				}),
			),
			verifier: passVerifier(),
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession(),
		});

		const workflowId = await engine.startWorkflow({ request: "three repairs" });
		try {
			await engine.run(workflowId);
		} catch {
			// budget stop expected after bound
		}

		expect(repairCalls).toBe(3);
		expect(ledger.snapshot().repairCycles).toBe(3);
	});

	it("final_verify ignores open P1 findings below confidence threshold", async () => {
		const stage = new FinalVerifyStage(passVerifier());
		// Engine passes only findings marked blocking=true (confidence/priority already applied at intake).
		const advisory = finding({ id: "low", priority: "P1", confidence: 0.2, status: "open", blocking: false });
		const blocking = finding({ id: "high", priority: "P1", confidence: 0.9, status: "open", blocking: true });

		const advisoryPass = await stage.execute({
			workflowId: "wf",
			attemptId: "att-low",
			commands: [],
			openFindings: [advisory],
			implementation: implArtifact({ branchName: "wf/x", patchPath: undefined }),
		});
		expect(advisoryPass.passed).toBe(true);
		expect(advisoryPass.checks.some(c => c.id === "unresolved-findings")).toBe(false);

		const blockingFail = await stage.execute({
			workflowId: "wf",
			attemptId: "att-high",
			commands: [],
			openFindings: [blocking],
			implementation: implArtifact({ branchName: "wf/x", patchPath: undefined }),
		});
		expect(blockingFail.passed).toBe(false);
		expect(blockingFail.checks.some(c => c.id === "unresolved-findings")).toBe(true);
	});

	it("engine final_verify path treats low-confidence open findings as non-blocking", async () => {
		const lowFinding = finding({ id: "advisory", priority: "P1", confidence: 0.15 });
		const engine = new WorkflowEngine({
			store,
			config: { confidenceThreshold: 0.6 },
			adapter: new RuntimeAdapter(
				scriptedRunner({
					plan: planArtifact(),
					planReview: reviewArtifact("approved", "plan"),
					implement: implArtifact(),
					// Approved decision but still includes low-confidence finding (advisory)
					codeReview: reviewArtifact("approved", "implementation", [lowFinding]),
				}),
			),
			verifier: passVerifier(),
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession(),
		});

		const workflowId = await engine.startWorkflow({ request: "advisory finding" });
		const result = await engine.run(workflowId);
		expect(result.state.status).toBe("completed");
	});

	it("final verify fails closed on unresolved blocking P2 findings from accepted review flow", async () => {
		let reviewCount = 0;
		const blockingP2 = finding({
			id: "p2-blocking",
			priority: "P2",
			confidence: 0.95,
			summary: "blocking correctness defect",
		});
		const engine = new WorkflowEngine({
			store,
			config: { maxRepairCycles: 1 },
			adapter: new RuntimeAdapter(
				scriptedRunner({
					plan: planArtifact(),
					planReview: reviewArtifact("approved", "plan"),
					implement: implArtifact(),
					codeReview: () => {
						reviewCount += 1;
						return reviewCount === 1
							? reviewArtifact("changes_requested", "implementation", [blockingP2])
							: reviewArtifact("approved", "implementation", []);
					},
					repair: implArtifact({
						addressedStepIds: [],
						summary: "repair skipped the blocking P2 finding",
					}),
				}),
			),
			verifier: passVerifier(),
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession(),
		});

		const workflowId = await engine.startWorkflow({ request: "do not complete with open blocking P2" });
		await engine.run(workflowId).catch(() => {});
		const finalState = await engine.getState(workflowId);
		expect(finalState?.status).toBe("blocked");
	});

	it("cross-Engine resume still blocks on open blocking P2 before findings-state repair write", async () => {
		let reviewCount = 0;
		const blockingP2 = finding({
			id: "p2-blocking-resume",
			priority: "P2",
			confidence: 0.95,
			summary: "blocking P2 must survive hydrate",
		});
		const dbPath = path.join(os.tmpdir(), `wf-p2-resume-${crypto.randomUUID()}.db`);
		const mk = (s: WorkflowStore) =>
			new WorkflowEngine({
				store: s,
				config: { maxRepairCycles: 1 },
				adapter: new RuntimeAdapter(
					scriptedRunner({
						plan: planArtifact(),
						planReview: reviewArtifact("approved", "plan"),
						implement: implArtifact(),
						codeReview: () => {
							reviewCount += 1;
							return reviewCount === 1
								? reviewArtifact("changes_requested", "implementation", [blockingP2])
								: reviewArtifact("approved", "implementation", []);
						},
						repair: implArtifact({
							addressedStepIds: [],
							summary: "repair skipped the blocking P2 finding",
						}),
					}),
				),
				verifier: passVerifier(),
				artifactStore: new ArtifactStore(artifactDir),
				session: fakeSession(),
			});

		let fileStore = new WorkflowStore(dbPath);
		const engine1 = mk(fileStore);
		const workflowId = await engine1.startWorkflow({ request: "resume blocking P2" });
		// Advance until first code_review lands in repairing (no findings-state yet).
		for (let i = 0; i < 20; i++) {
			const status = (await engine1.getState(workflowId))?.status;
			if (status === "repairing") break;
			await engine1.resume(workflowId, { singleStep: true });
		}
		expect((await engine1.getState(workflowId))?.status).toBe("repairing");
		fileStore.close();

		fileStore = new WorkflowStore(dbPath);
		const engine2 = mk(fileStore);
		await engine2.resume(workflowId).catch(() => {});
		const finalState = await engine2.getState(workflowId);
		expect(finalState?.status).toBe("blocked");
		expect(finalState?.status).not.toBe("completed");
		fileStore.close();
		await fs.rm(dbPath, { force: true });
	});

	it("maxPlanCycles hard-stops after bounded plan rejections", async () => {
		let planReviews = 0;
		const engine = new WorkflowEngine({
			store,
			config: { maxPlanCycles: 2 },
			adapter: new RuntimeAdapter(
				scriptedRunner({
					plan: planArtifact({ summary: "v" }),
					planReview: () => {
						planReviews += 1;
						return reviewArtifact("changes_requested", "plan");
					},
				}),
			),
			verifier: passVerifier(),
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession(),
		});

		const workflowId = await engine.startWorkflow({ request: "plan loop" });
		const result = await engine.run(workflowId);
		expect(result.state.status).toBe("blocked");
		// At most maxPlanCycles rejections before block (2)
		expect(planReviews).toBeLessThanOrEqual(2);
		expect(planReviews).toBeGreaterThanOrEqual(1);
	});

	it("maxPlanCycles survives new Engine instances across single-step resumes", async () => {
		let planReviews = 0;
		const mk = () =>
			new WorkflowEngine({
				store,
				config: { maxPlanCycles: 2 },
				adapter: new RuntimeAdapter(
					scriptedRunner({
						plan: planArtifact({ summary: "v" }),
						planReview: () => {
							planReviews += 1;
							return reviewArtifact("changes_requested", "plan");
						},
					}),
				),
				verifier: passVerifier(),
				artifactStore: new ArtifactStore(artifactDir),
				session: fakeSession(),
			});

		const workflowId = await mk().startWorkflow({ request: "cross-engine plan bound" });
		// Each tool-like call constructs a fresh engine (same store).
		for (let i = 0; i < 8; i++) {
			const state = await store.getCurrentState(workflowId);
			if (!state || ["blocked", "failed", "cancelled", "completed"].includes(state.status)) break;
			await mk().resume(workflowId, { singleStep: true, session: fakeSession() });
		}
		const final = await store.getCurrentState(workflowId);
		expect(final?.status).toBe("blocked");
		expect(planReviews).toBeLessThanOrEqual(2);
	});

	it("cancel finishes open attempts (no permanent in_progress)", async () => {
		const engine = new WorkflowEngine({
			store,
			session: fakeSession(),
			adapter: new RuntimeAdapter(
				scriptedRunner({
					plan: planArtifact(),
				}),
			),
			verifier: passVerifier(),
			artifactStore: new ArtifactStore(artifactDir),
		});
		const workflowId = await engine.startWorkflow({ request: "cancel attempt" });
		await engine.resume(workflowId, { singleStep: true, session: fakeSession() }); // created→planning start or run planning
		// Force an open attempt then cancel
		const mid = await store.getCurrentState(workflowId);
		if (mid && mid.status !== "cancelled") {
			await engine.cancel(workflowId);
		}
		const attempts = await store.listAttempts(workflowId);
		expect(attempts.every(a => a.status !== "in_progress")).toBe(true);
		expect((await engine.getState(workflowId))?.status).toBe("cancelled");
	});
});
