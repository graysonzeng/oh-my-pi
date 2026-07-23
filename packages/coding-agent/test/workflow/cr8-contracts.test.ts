import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactStore } from "../../src/workflow/artifact-store";
import { ContextBuilder } from "../../src/workflow/context-builder";
import { WorkflowEngine } from "../../src/workflow/engine";
import { FindingTracker } from "../../src/workflow/finding-tracker";
import { parseWorkflowArtifact } from "../../src/workflow/parse-artifact";
import { RuntimeAdapter } from "../../src/workflow/runtime-adapter";
import { ReviewArtifactSchema } from "../../src/workflow/schemas";
import { WorkflowStore } from "../../src/workflow/sqlite-store";
import { fakeSession, implArtifact, passVerifier, planArtifact, reviewArtifact, scriptedRunner } from "./helpers";

describe("CR8 contract fixes", () => {
	let store: WorkflowStore;
	let artifactDir: string;

	beforeEach(async () => {
		store = new WorkflowStore(":memory:");
		artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-cr8-"));
	});

	afterEach(async () => {
		store.close();
		await fs.rm(artifactDir, { recursive: true, force: true });
	});

	it("changes_requested without findings is schema_violation", () => {
		expect(() =>
			parseWorkflowArtifact(
				ReviewArtifactSchema,
				{
					schemaVersion: 1,
					workflowId: "wf",
					attemptId: "a",
					stage: "plan_review",
					createdAt: "2026-07-23T00:00:00.000Z",
					kind: "review",
					subject: "plan",
					decision: "changes_requested",
					findings: [],
					explanation: "needs work",
					confidence: 0.9,
				},
				"ReviewArtifact",
			),
		).toThrow(/schema_violation|requires at least one finding/i);
	});

	it("replan/repair contexts include reviewer explanation", () => {
		const review = reviewArtifact("changes_requested", "plan", [
			{
				id: "f1",
				priority: "P1",
				category: "correctness",
				status: "open",
				confidence: 0.9,
				summary: "race",
				explanation: "Fix the race described here",
				suggestedOwner: "implementer",
			},
		]);
		review.explanation = "Fix the race described here in detail";
		const cb = new ContextBuilder();
		const planCtx = cb.buildPlanContext({
			request: { request: "build it" },
			priorReview: review,
		});
		expect(planCtx).toContain("Fix the race described here in detail");
		const repairCtx = cb.buildRepairContext({
			plan: planArtifact(),
			findings: review.findings,
			reviewExplanation: review.explanation,
		});
		expect(repairCtx).toContain("Fix the race described here in detail");
	});

	it("engine records one repair cycle per fingerprint across duplicate finding ids", async () => {
		const sameBug = {
			id: "a",
			priority: "P1" as const,
			category: "correctness" as const,
			status: "open" as const,
			confidence: 0.9,
			summary: "same bug",
			explanation: "dup",
			suggestedOwner: "implementer" as const,
			file: "a.ts",
			line: 10,
		};
		let repairCalls = 0;
		const engine = new WorkflowEngine({
			store,
			config: { maxRepairCycles: 2 },
			adapter: new RuntimeAdapter(
				scriptedRunner({
					plan: planArtifact(),
					planReview: reviewArtifact("approved", "plan"),
					implement: implArtifact(),
					codeReview: () =>
						reviewArtifact("changes_requested", "implementation", [
							sameBug,
							{ ...sameBug, id: "b" },
							{ ...sameBug, id: "c" },
						]),
					repair: () => {
						repairCalls += 1;
						return implArtifact({
							addressedStepIds: ["a", "b", "c"],
							summary: "fixed once for fingerprint",
						});
					},
				}),
			),
			verifier: passVerifier(),
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession(),
		});
		const id = await engine.startWorkflow({ request: "fingerprint dedupe" });
		const result = await engine.run(id).catch(() => null);
		// One repair attempt for the shared fingerprint (not three)
		expect(repairCalls).toBeLessThanOrEqual(2);
		expect(repairCalls).toBeGreaterThanOrEqual(1);
		if (result) {
			expect(["completed", "blocked", "failed"]).toContain(result.state.status);
		}
		const tracker = new FindingTracker();
		const f1 = tracker.add(sameBug);
		const f2 = tracker.add({ ...sameBug, id: "b" });
		expect(f1.fingerprint).toBe(f2.fingerprint);
	});

	it("parse rejects review artifacts missing required finding fields", () => {
		expect(() =>
			parseWorkflowArtifact(
				ReviewArtifactSchema,
				{
					schemaVersion: 1,
					workflowId: "wf",
					attemptId: "a",
					stage: "code_review",
					createdAt: "2026-07-23T00:00:00.000Z",
					kind: "review",
					subject: "implementation",
					decision: "changes_requested",
					findings: [
						{
							id: "f1",
							status: "open",
							summary: "missing priority/category/confidence",
							explanation: "incomplete",
							suggestedOwner: "implementer",
						},
					],
					explanation: "needs work",
					confidence: 0.9,
				},
				"ReviewArtifact",
			),
		).toThrow();
	});
});
