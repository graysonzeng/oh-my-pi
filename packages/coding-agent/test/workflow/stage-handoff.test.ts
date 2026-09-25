/**
 * Contract + recoverability + engine integration tests for StageHandoffV1 (P1).
 * Drives the shipped builders and engine persist path — no re-implementation.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactStore } from "../../src/workflow/artifact-store";
import { ContextBuilder } from "../../src/workflow/context-builder";
import { WorkflowEngine } from "../../src/workflow/engine";
import { RuntimeAdapter } from "../../src/workflow/runtime-adapter";
import { WorkflowStore } from "../../src/workflow/sqlite-store";
import {
	buildImplementerToReviewerHandoff,
	buildKeepAllHandoff,
	buildPlannerToImplementerHandoff,
	buildReviewerToRepairHandoff,
	STAGE_HANDOFF_KIND,
	STAGE_HANDOFF_SUMMARY_MAX,
	selectBlockingFindings,
	serializeStageHandoff,
	syntheticArtifactRef,
} from "../../src/workflow/stage-handoff";
import type {
	ImplementationArtifactV1,
	PlanArtifactV1,
	ReviewArtifactV1,
	StageHandoffV1,
	VerificationArtifactV1,
} from "../../src/workflow/types";
import {
	fakeSession,
	implArtifact,
	passVerifier,
	planArtifact,
	reviewArtifact,
	SAMPLE_PATCH,
	scriptedRunner,
} from "./helpers";

const header = {
	schemaVersion: 1 as const,
	workflowId: "wf-handoff",
	attemptId: "att-1",
	stage: "planning" as const,
	createdAt: "2026-07-26T00:00:00.000Z",
};

function fullPlan(): PlanArtifactV1 {
	return {
		...header,
		kind: "plan",
		summary: "Add feature X with careful scope",
		assumptions: ["repo builds", "tests green"],
		nonGoals: ["rewrite auth", "migrate db"],
		affectedFiles: [
			{ path: "src/a.ts", action: "modify", reason: "core" },
			{ path: "src/b.ts", action: "create", reason: "helper" },
		],
		implementationSteps: [
			{ id: "s1", description: "edit a", dependsOn: [] },
			{ id: "s2", description: "add b", dependsOn: ["s1"] },
		],
		acceptanceCriteria: ["unit tests pass", "no scope creep"],
		verificationCommands: ["bun test", "git diff --check"],
		risks: ["merge conflict on a.ts"],
		rollback: ["git revert HEAD"],
	};
}

function fullImpl(): ImplementationArtifactV1 {
	return {
		...header,
		stage: "implementing",
		kind: "implementation",
		summary: "implemented feature X",
		changedFiles: ["src/a.ts", "src/b.ts"],
		addressedStepIds: ["s1", "s2"],
		commandsRun: [
			{ command: "bun test", exitCode: 0, summary: "ok" },
			{ command: "git diff --check", exitCode: 0, summary: "clean" },
		],
		patchPath: "patches/x.patch",
		branchName: "wf/feature-x",
		unresolved: ["follow-up docs"],
	};
}

function fullReview(): ReviewArtifactV1 {
	return {
		...header,
		stage: "code_review",
		kind: "review",
		subject: "implementation",
		decision: "changes_requested",
		findings: [
			{
				id: "f-block",
				priority: "P0",
				category: "correctness",
				status: "open",
				confidence: 0.95,
				summary: "null deref on empty input",
				explanation: "must guard",
				file: "src/a.ts",
				line: 42,
				suggestedOwner: "implementer",
				blocking: true,
			},
			{
				id: "f-info",
				priority: "P3",
				category: "maintainability",
				status: "open",
				confidence: 0.4,
				summary: "naming nit",
				explanation: "optional",
				suggestedOwner: "implementer",
				blocking: false,
			},
			{
				id: "f-done",
				priority: "P2",
				category: "testing",
				status: "resolved",
				confidence: 0.8,
				summary: "missing test was added",
				explanation: "ok now",
				suggestedOwner: "implementer",
				blocking: false,
			},
		],
		explanation: "fix P0 then re-verify",
		confidence: 0.9,
	};
}

function failedVerification(): VerificationArtifactV1 {
	return {
		...header,
		stage: "implementation_verify",
		kind: "verification",
		passed: false,
		checks: [
			{ id: "t1", status: "failed", summary: "assert failed", exitCode: 1 },
			{ id: "t2", status: "passed", summary: "lint ok", exitCode: 0 },
		],
	};
}

describe("stage handoff contract (shipped builders)", () => {
	it("extracts correct preserved kinds per edge with real source byte sizes", () => {
		const plan = fullPlan();
		const planRef = syntheticArtifactRef("art_plan", plan);
		const exploratory = syntheticArtifactRef("art_explore", { reads: ["src/z.ts".repeat(50)] });
		const planHandoff = buildPlannerToImplementerHandoff({
			plan,
			planRef,
			omittedSources: [exploratory],
		});
		expect(planHandoff.preservedItems.every(p => p.kind === "plan" || p.kind === "finding")).toBe(true);
		expect(planHandoff.omittedArtifactIds).toContain("art_explore");
		expect(planHandoff.bytesBeforeHandoff).toBe(planRef.bytes + exploratory.bytes);
		expect(planHandoff.bytesAfterHandoff).toBeLessThan(planHandoff.bytesBeforeHandoff);

		const impl = fullImpl();
		const implRef = syntheticArtifactRef("art_impl", impl);
		const implHandoff = buildImplementerToReviewerHandoff({
			implementation: impl,
			plan,
			implRef,
			planRef,
			patchRef: { artifactId: "art_patch", bytes: 200, recoveryUri: "file://patches/x.patch" },
		});
		expect(implHandoff.preservedItems.some(p => p.kind === "patch" && p.blocking)).toBe(true);
		expect(implHandoff.preservedItems.some(p => p.kind === "plan")).toBe(true);
		expect(implHandoff.bytesBeforeHandoff).toBeGreaterThan(implHandoff.bytesAfterHandoff);

		const review = fullReview();
		const verification = failedVerification();
		const reviewRef = syntheticArtifactRef("art_review", review);
		const vRef = syntheticArtifactRef("art_ver", verification);
		const repairHandoff = buildReviewerToRepairHandoff({
			review,
			verification,
			implementation: impl,
			reviewRef,
			verificationRef: vRef,
			implRef,
			repairHistory: [{ findingId: "f-block", cycles: 1 }],
		});
		expect(repairHandoff.preservedItems.some(p => p.summary.includes("f-block") && p.blocking)).toBe(true);
		expect(repairHandoff.preservedItems.some(p => p.summary.includes("f-done"))).toBe(false);
		expect(repairHandoff.preservedItems.some(p => p.kind === "verification" && p.blocking)).toBe(true);
		expect(selectBlockingFindings(review).map(f => f.id)).toContain("f-block");
	});

	it("is byte-identical for identical inputs and never requires a model", () => {
		const plan = fullPlan();
		const planRef = syntheticArtifactRef("fixed-id", plan);
		const a = serializeStageHandoff(buildPlannerToImplementerHandoff({ plan, planRef }));
		const b = serializeStageHandoff(buildPlannerToImplementerHandoff({ plan, planRef }));
		expect(a).toBe(b);
		// No network / model side effects — pure function double-call equality is the proof.
	});

	it("caps every summary at 500 characters", () => {
		const plan = fullPlan();
		plan.summary = "S".repeat(800);
		plan.assumptions = ["A".repeat(800)];
		const handoff = buildPlannerToImplementerHandoff({ plan });
		for (const item of handoff.preservedItems) {
			expect(item.summary.length).toBeLessThanOrEqual(STAGE_HANDOFF_SUMMARY_MAX);
			expect(item.bytes).toBe(Buffer.byteLength(item.summary, "utf-8"));
		}
	});

	it("keep-all degrade preserves all source recovery URIs", () => {
		const sources = [
			syntheticArtifactRef("a1", { big: "x".repeat(1000) }),
			syntheticArtifactRef("a2", { big: "y".repeat(1000) }),
		];
		const keep = buildKeepAllHandoff({
			fromStage: "planning",
			toStage: "implementing",
			sources,
		});
		expect(keep.omittedArtifactIds).toEqual([]);
		expect(keep.recoveryUris.sort()).toEqual(sources.map(s => s.recoveryUri).sort());
		expect(keep.bytesBeforeHandoff).toBe(sources[0]!.bytes + sources[1]!.bytes);
		expect(keep.preservedItems.length).toBe(2);
	});
});

describe("stage handoff recoverability via ArtifactStore", () => {
	let dir: string;
	let store: ArtifactStore;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "stage-handoff-rec-"));
		store = new ArtifactStore(dir);
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("omitted artifacts remain loadable; recoveryUris return full content; sources not deleted", async () => {
		const plan = fullPlan();
		const planBody = JSON.stringify(plan);
		const storedPlan = await store.store({
			workflowId: plan.workflowId,
			attemptId: plan.attemptId,
			kind: "plan",
			schemaVersion: 1,
			relativePath: "",
			content: planBody,
		});
		const exploreBody = JSON.stringify({ kind: "explore", dump: "z".repeat(5000) });
		const storedExplore = await store.store({
			workflowId: plan.workflowId,
			attemptId: plan.attemptId,
			kind: "explore",
			schemaVersion: 1,
			relativePath: "",
			content: exploreBody,
		});

		const planRef = {
			artifactId: storedPlan.id,
			bytes: Buffer.byteLength(planBody, "utf-8"),
			recoveryUri: `artifact://${storedPlan.relativePath}`,
		};
		const exploreRef = {
			artifactId: storedExplore.id,
			bytes: Buffer.byteLength(exploreBody, "utf-8"),
			recoveryUri: `artifact://${storedExplore.relativePath}`,
		};

		const handoff = buildPlannerToImplementerHandoff({
			plan,
			planRef,
			omittedSources: [exploreRef],
		});

		// Persist handoff without deleting sources
		const storedHandoff = await store.store({
			workflowId: plan.workflowId,
			attemptId: plan.attemptId,
			kind: "stage-handoff",
			schemaVersion: 1,
			relativePath: "",
			content: serializeStageHandoff(handoff),
		});
		expect(storedHandoff.kind).toBe("stage-handoff");

		for (const id of handoff.omittedArtifactIds) {
			const listed = await store.listByWorkflow(plan.workflowId);
			expect(listed.some(a => a.id === id)).toBe(true);
		}

		for (const uri of handoff.recoveryUris) {
			expect(uri.startsWith("artifact://")).toBe(true);
			const relativePath = uri.slice("artifact://".length);
			const loaded = await store.load(relativePath);
			expect(loaded).not.toBeNull();
			expect(loaded!.content?.length).toBeGreaterThan(0);
		}

		// Full plan still readable after handoff
		const reloadedPlan = await store.load(storedPlan.relativePath, storedPlan.sha256);
		expect(reloadedPlan?.content).toBe(planBody);
		expect(JSON.parse(reloadedPlan!.content!).summary).toBe(plan.summary);

		// Handoff summary is sufficient: goal + acceptance present
		expect(handoff.preservedItems.some(p => p.summary.includes("goal:"))).toBe(true);
		expect(handoff.preservedItems.some(p => p.summary.includes("acceptance:"))).toBe(true);
		expect(handoff.kind).toBe(STAGE_HANDOFF_KIND);
	});
});

describe("stage handoff engine integration", () => {
	let store: WorkflowStore;
	let artifactDir: string;
	let engine: WorkflowEngine;

	beforeEach(async () => {
		store = new WorkflowStore(":memory:");
		artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "stage-handoff-eng-"));
		const patchFile = path.join(artifactDir, "impl.patch");
		await Bun.write(patchFile, SAMPLE_PATCH);
	});

	afterEach(async () => {
		store.close();
		await fs.rm(artifactDir, { recursive: true, force: true });
	});

	it("happy path plan→implement→review emits handoffs with recovery URIs", async () => {
		const patchFile = path.join(artifactDir, "impl.patch");
		const seenContexts: string[] = [];
		engine = new WorkflowEngine({
			store,
			adapter: new RuntimeAdapter(async request => {
				if (request.context) seenContexts.push(request.context);
				return scriptedRunner({
					plan: planArtifact(),
					planReview: reviewArtifact("approved", "plan"),
					implement: { ...implArtifact(), patchPath: patchFile },
					codeReview: reviewArtifact("approved", "implementation"),
				})(request);
			}),
			verifier: passVerifier(),
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession({ cwd: artifactDir }),
		});

		const workflowId = await engine.startWorkflow({ request: "ship" });
		const result = await engine.run(workflowId, fakeSession({ cwd: artifactDir }));
		expect(result.state.status).toBe("completed");

		const artifacts = await store.listArtifacts(workflowId);
		const handoffs = artifacts.filter(a => a.kind === "stage-handoff");
		expect(handoffs.length).toBeGreaterThanOrEqual(2);

		const fsStore = new ArtifactStore(artifactDir);
		const bodies: StageHandoffV1[] = [];
		for (const meta of handoffs) {
			const loaded = await fsStore.load(meta.relativePath, meta.sha256);
			expect(loaded).not.toBeNull();
			bodies.push(JSON.parse(loaded!.content!) as StageHandoffV1);
		}

		const transitions = bodies.map(b => `${b.fromStage}→${b.toStage}`);
		expect(transitions).toContain("planning→implementing");
		expect(transitions).toContain("implementing→code_review");

		// Source plan/implementation still present
		expect(artifacts.some(a => a.kind === "plan")).toBe(true);
		expect(artifacts.some(a => a.kind === "implementation")).toBe(true);

		for (const body of bodies) {
			expect(body.kind).toBe(STAGE_HANDOFF_KIND);
			for (const uri of body.recoveryUris) {
				if (!uri.startsWith("artifact://")) continue;
				const rel = uri.slice("artifact://".length);
				const loaded = await fsStore.load(rel);
				expect(loaded).not.toBeNull();
			}
		}

		expect(seenContexts.some(c => c.includes("Stage handoff (planner→implementer)"))).toBe(true);
		expect(seenContexts.some(c => c.includes("Stage handoff (implementer→reviewer)"))).toBe(true);
	});

	it("repair path keeps blocking findings visible in next-stage context", async () => {
		const patchFile = path.join(artifactDir, "impl.patch");
		const seenContexts: string[] = [];
		engine = new WorkflowEngine({
			store,
			adapter: new RuntimeAdapter(async request => {
				if (request.context) seenContexts.push(request.context);
				return scriptedRunner({
					plan: planArtifact(),
					planReview: reviewArtifact("approved", "plan"),
					implement: { ...implArtifact(), patchPath: patchFile },
					codeReview: reviewArtifact("changes_requested", "implementation", [
						{
							id: "f-block",
							priority: "P0",
							category: "correctness",
							status: "open",
							confidence: 0.95,
							summary: "must fix",
							explanation: "blocking",
							file: "src/a.ts",
							line: 10,
							suggestedOwner: "implementer",
							blocking: true,
						},
					]),
					repair: { ...implArtifact(), patchPath: patchFile, addressedStepIds: ["f-block"] },
				})(request);
			}),
			verifier: passVerifier(),
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession({ cwd: artifactDir }),
			config: { maxRepairCycles: 3 },
		});

		const workflowId = await engine.startWorkflow({ request: "fix" });
		await engine.run(workflowId, fakeSession({ cwd: artifactDir })).catch(() => {});

		const artifacts = await store.listArtifacts(workflowId);
		const fsStore = new ArtifactStore(artifactDir);
		const handoffMetas = artifacts.filter(a => a.kind === "stage-handoff");
		const bodies = await Promise.all(
			handoffMetas.map(async meta => {
				const loaded = await fsStore.load(meta.relativePath, meta.sha256);
				return loaded?.content ? (JSON.parse(loaded.content) as StageHandoffV1) : null;
			}),
		);
		const repair = bodies.find(b => b?.toStage === "repairing");
		expect(repair).toBeDefined();
		expect(repair!.preservedItems.some(p => p.blocking && p.summary.includes("f-block"))).toBe(true);

		const repairCtx = seenContexts.find(c => c.includes("Stage handoff (reviewer→repair)"));
		expect(repairCtx).toBeDefined();
		expect(repairCtx).toContain("f-block");
	});

	it("failed plan_review does not emit planner→implementer handoff", async () => {
		engine = new WorkflowEngine({
			store,
			adapter: new RuntimeAdapter(
				scriptedRunner({
					plan: planArtifact(),
					planReview: reviewArtifact("blocked", "plan", [
						{
							id: "hard-block",
							priority: "P0",
							category: "architecture",
							status: "open",
							confidence: 0.99,
							summary: "impossible",
							explanation: "stop",
							suggestedOwner: "human",
							blocking: true,
						},
					]),
				}),
			),
			verifier: passVerifier(),
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession({ cwd: artifactDir }),
			config: { maxPlanCycles: 1 },
		});

		const workflowId = await engine.startWorkflow({ request: "blocked plan" });
		await engine.run(workflowId, fakeSession({ cwd: artifactDir })).catch(() => {});

		const artifacts = await store.listArtifacts(workflowId);
		const handoffs = artifacts.filter(a => a.kind === "stage-handoff");
		const fsStore = new ArtifactStore(artifactDir);
		for (const meta of handoffs) {
			const loaded = await fsStore.load(meta.relativePath, meta.sha256);
			const body = loaded?.content ? (JSON.parse(loaded.content) as StageHandoffV1) : null;
			// Must not construct success-edge handoff into implementing when plan is blocked.
			expect(body?.toStage).not.toBe("implementing");
		}
	});
});

describe("stage handoff resume hydration", () => {
	let store: WorkflowStore;
	let artifactDir: string;
	let dbPath: string;

	beforeEach(async () => {
		dbPath = path.join(os.tmpdir(), `wf-handoff-resume-${crypto.randomUUID()}.db`);
		store = new WorkflowStore(dbPath);
		artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "stage-handoff-resume-"));
		await Bun.write(path.join(artifactDir, "impl.patch"), SAMPLE_PATCH);
	});

	afterEach(async () => {
		store.close();
		await fs.rm(artifactDir, { recursive: true, force: true });
		await fs.rm(dbPath, { force: true });
	});

	function makeEngine(s: WorkflowStore, patchFile: string): WorkflowEngine {
		return new WorkflowEngine({
			store: s,
			adapter: new RuntimeAdapter(
				scriptedRunner({
					plan: planArtifact(),
					planReview: reviewArtifact("approved", "plan"),
					implement: { ...implArtifact(), patchPath: patchFile },
					codeReview: reviewArtifact("changes_requested", "implementation", [
						{
							id: "f-block",
							priority: "P0",
							category: "correctness",
							status: "open",
							confidence: 0.95,
							summary: "must fix",
							explanation: "blocking",
							file: "src/a.ts",
							line: 10,
							suggestedOwner: "implementer",
							blocking: true,
						},
					]),
					repair: {
						...implArtifact(),
						patchPath: patchFile,
						addressedStepIds: ["f-block"],
					},
				}),
			),
			verifier: passVerifier(),
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession({ cwd: artifactDir }),
			config: { maxRepairCycles: 3 },
		});
	}

	async function loadHandoffs(workflowId: string): Promise<StageHandoffV1[]> {
		const artifacts = await store.listArtifacts(workflowId);
		const fsStore = new ArtifactStore(artifactDir);
		const out: StageHandoffV1[] = [];
		for (const meta of artifacts.filter(a => a.kind === "stage-handoff")) {
			const loaded = await fsStore.load(meta.relativePath, meta.sha256);
			if (loaded?.content) out.push(JSON.parse(loaded.content) as StageHandoffV1);
		}
		return out;
	}

	it("post-resume handoff recoveryUris load via ArtifactStore (no synthetic workflowId/plan fallbacks)", async () => {
		const patchFile = path.join(artifactDir, "impl.patch");
		const engine1 = makeEngine(store, patchFile);
		const workflowId = await engine1.startWorkflow({ request: "resume handoff" });

		// singleStep: created→planning, planning→plan_review, plan_review→implementing
		await engine1.resume(workflowId, {
			singleStep: true,
			session: fakeSession({ cwd: artifactDir }),
		}); // created → planning
		await engine1.resume(workflowId, {
			singleStep: true,
			session: fakeSession({ cwd: artifactDir }),
		}); // planning execute → plan_review
		await engine1.resume(workflowId, {
			singleStep: true,
			session: fakeSession({ cwd: artifactDir }),
		}); // plan_review execute → implementing
		expect((await engine1.getState(workflowId))?.status).toBe("implementing");

		// Process restart: new Engine + same db/artifact dir. Hydrate must restore real refs.
		store.close();
		store = new WorkflowStore(dbPath);
		const engine2 = makeEngine(store, patchFile);
		await engine2.resume(workflowId, {
			singleStep: true,
			session: fakeSession({ cwd: artifactDir }),
		}); // implementing: builds planner→implementer handoff from hydrated refs

		const afterImpl = await loadHandoffs(workflowId);
		const planHandoff = afterImpl.find(h => h.fromStage === "planning" && h.toStage === "implementing");
		expect(planHandoff).toBeDefined();

		const fsStore = new ArtifactStore(artifactDir);
		// Must not use synthetic fallbacks like artifact://{workflowId}/plan
		for (const uri of planHandoff!.recoveryUris) {
			expect(uri.startsWith("artifact://")).toBe(true);
			// Real store paths: {workflowId}/art_{uuid}.json — not bare kind labels
			expect(uri).toMatch(/\/art_[0-9a-f-]+\.json$/i);
			expect(uri).not.toMatch(/\/(plan|implementation|review|verification)$/);
			const rel = uri.slice("artifact://".length);
			const loaded = await fsStore.load(rel);
			expect(loaded).not.toBeNull();
			expect(loaded!.content?.length).toBeGreaterThan(0);
		}
		// omitted ids must match real stored art_* ids (path basenames), not synthetic labels
		for (const id of planHandoff!.omittedArtifactIds) {
			expect(id.startsWith("art_")).toBe(true);
			const listed = await fsStore.listByWorkflow(workflowId);
			expect(listed.some(a => a.id === id)).toBe(true);
		}
		expect(planHandoff!.bytesBeforeHandoff).toBeGreaterThan(0);
		expect(planHandoff!.bytesBeforeHandoff).toBeGreaterThanOrEqual(planHandoff!.bytesAfterHandoff);

		// After implementing step we are at implementation_verify. Next: verify → code_review.
		expect((await engine2.getState(workflowId))?.status).toBe("implementation_verify");
		await engine2.resume(workflowId, {
			singleStep: true,
			session: fakeSession({ cwd: artifactDir }),
		}); // verification → code_review
		expect((await engine2.getState(workflowId))?.status).toBe("code_review");

		// Crash before code_review runs; new Engine hydrates impl/plan/verification refs then builds handoff.
		store.close();
		store = new WorkflowStore(dbPath);
		const engine3 = makeEngine(store, patchFile);
		await engine3.resume(workflowId, {
			singleStep: true,
			session: fakeSession({ cwd: artifactDir }),
		}); // code_review: implement→review handoff (+ real patch artifact) → repairing

		const afterReview = await loadHandoffs(workflowId);
		const implHandoff = afterReview.find(h => h.fromStage === "implementing" && h.toStage === "code_review");
		expect(implHandoff).toBeDefined();
		for (const uri of implHandoff!.recoveryUris) {
			expect(uri.startsWith("artifact://")).toBe(true);
			expect(uri).toMatch(/\/art_[0-9a-f-]+\.json$/i);
			const rel = uri.slice("artifact://".length);
			const loaded = await fsStore.load(rel);
			expect(loaded).not.toBeNull();
		}
		// Patch ref must use real content bytes (≥ SAMPLE_PATCH length), not path-string length
		const patchMeta = (await store.listArtifacts(workflowId)).find(a => a.kind === "patch");
		expect(patchMeta).toBeDefined();
		const patchLoaded = await fsStore.load(patchMeta!.relativePath, patchMeta!.sha256);
		expect(patchLoaded?.content).toBe(SAMPLE_PATCH);
		expect(implHandoff!.bytesBeforeHandoff).toBeGreaterThanOrEqual(Buffer.byteLength(SAMPLE_PATCH, "utf-8"));
		expect(implHandoff!.omittedArtifactIds.every(id => id.startsWith("art_"))).toBe(true);
		expect(implHandoff!.recoveryUris.some(u => u.includes(patchMeta!.relativePath))).toBe(true);

		// code_review with changes_requested lands on repairing; crash and resume into repair.
		expect((await engine3.getState(workflowId))?.status).toBe("repairing");
		store.close();
		store = new WorkflowStore(dbPath);
		const engine4 = makeEngine(store, patchFile);
		await engine4
			.resume(workflowId, {
				singleStep: true,
				session: fakeSession({ cwd: artifactDir }),
			})
			.catch(() => {});

		const allHandoffs = await loadHandoffs(workflowId);
		const repairHandoff = allHandoffs.find(h => h.fromStage === "code_review" && h.toStage === "repairing");
		expect(repairHandoff).toBeDefined();
		expect(repairHandoff!.preservedItems.some(p => p.blocking && p.summary.includes("f-block"))).toBe(true);
		for (const uri of repairHandoff!.recoveryUris) {
			expect(uri).toMatch(/\/art_[0-9a-f-]+\.json$/i);
			const rel = uri.slice("artifact://".length);
			expect(await fsStore.load(rel)).not.toBeNull();
		}
		for (const id of repairHandoff!.omittedArtifactIds) {
			expect(id.startsWith("art_")).toBe(true);
		}
	});
});

describe("stage handoff context bytes compare (fake)", () => {
	it("handoff extract is smaller than full source artifacts while retaining blocking findings", () => {
		const plan = fullPlan();
		const impl = fullImpl();
		const review = fullReview();
		const verification = failedVerification();

		const planJson = JSON.stringify(plan);
		const implJson = JSON.stringify(impl);
		const reviewJson = JSON.stringify(review);
		const verJson = JSON.stringify(verification);
		const fullBytes = Buffer.byteLength(planJson + implJson + reviewJson + verJson, "utf-8");

		const repairHandoff = buildReviewerToRepairHandoff({
			review,
			verification,
			implementation: impl,
			reviewRef: syntheticArtifactRef("r", review),
			verificationRef: syntheticArtifactRef("v", verification),
			implRef: syntheticArtifactRef("i", impl),
		});

		const handoffBytes = repairHandoff.bytesAfterHandoff;
		const reductionRate = 1 - handoffBytes / fullBytes;
		expect(handoffBytes).toBeLessThan(fullBytes);
		expect(reductionRate).toBeGreaterThan(0);
		expect(repairHandoff.preservedItems.some(p => p.blocking && p.summary.includes("f-block"))).toBe(true);

		// Context builder injects handoff without dropping findings from base repair context.
		const ctx = new ContextBuilder().buildRepairContext({
			plan,
			findings: review.findings.filter(f => f.status === "open" && f.blocking),
			verification,
			implementation: impl,
			reviewExplanation: review.explanation,
		});
		const withHandoff = new ContextBuilder().appendStageHandoff(ctx, repairHandoff);
		expect(withHandoff).toContain("f-block");
		expect(withHandoff).toContain("Stage handoff (reviewer→repair)");
	});
});
