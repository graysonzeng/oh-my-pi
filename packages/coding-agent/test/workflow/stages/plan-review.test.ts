import { describe, expect, it } from "bun:test";
import { DEFAULT_MODEL_PROFILES } from "../../../src/workflow/default-config";
import { PlanReviewArtifactV2JsonSchema, ReviewArtifactJsonSchema } from "../../../src/workflow/json-schemas";
import { RuntimeAdapter } from "../../../src/workflow/runtime-adapter";
import { PlanReviewStage } from "../../../src/workflow/stages/plan-review";
import type { PlanReviewArtifactV2, ReviewArtifactV1 } from "../../../src/workflow/types";
import { fakeSession, planReviewArtifactV2, reviewArtifact, scriptedRunner } from "../helpers";

describe("PlanReviewStage", () => {
	it("does not hardcode approval — uses runtime artifact", async () => {
		let outputSchema: unknown;
		const runner = scriptedRunner({ planReview: planReviewArtifactV2("changes_requested") });
		const stage = new PlanReviewStage(
			new RuntimeAdapter(async request => {
				outputSchema = request.outputSchema;
				return runner(request);
			}),
		);
		const result = await stage.execute({
			workflowId: "wf1",
			attemptId: "a1",
			profile: DEFAULT_MODEL_PROFILES.claude_plan_reviewer,
			assignment: "review",
			context: "ctx",
			session: fakeSession(),
			requirementsSnapshotRef: "artifact://wf1/plan",
			requirementsSnapshotSha256: "0".repeat(64),
		});
		const review = result.artifact as PlanReviewArtifactV2;
		expect(review.decision).toBe("changes_requested");
		expect(review.subject).toBe("plan");
		expect(review.schemaVersion).toBe(2);
		expect(review.reviewKind).toBe("initial");
		expect(review.requirementsSnapshotRef).toBe("artifact://wf1/plan");
		expect((outputSchema as { required?: readonly string[] }).required).toEqual(
			PlanReviewArtifactV2JsonSchema.required,
		);
	});

	it("forces arbitration decisions to approved or blocked", async () => {
		const stage = new PlanReviewStage(
			new RuntimeAdapter(scriptedRunner({ planReview: planReviewArtifactV2("changes_requested") })),
		);
		await expect(
			stage.execute({
				workflowId: "wf1",
				attemptId: "a1",
				profile: DEFAULT_MODEL_PROFILES.claude_plan_reviewer,
				assignment: "arbitrate",
				context: "ctx",
				session: fakeSession(),
				requirementsSnapshotRef: "artifact://wf1/plan",
				requirementsSnapshotSha256: "0".repeat(64),
				reviewKind: "arbitration",
				reviewRound: 2,
				triggerReason: "max_cycles_author_reject",
			}),
		).rejects.toMatchObject({ kind: "schema_violation" });
	});

	it("C1: strips model triggerReason when input does not supply it", async () => {
		const stage = new PlanReviewStage(
			new RuntimeAdapter(
				scriptedRunner({
					planReview: planReviewArtifactV2("approved", [], {
						triggerReason: "contradiction",
						routeSelectionReceiptRef: "forged-route",
						cleanContextReceiptRef: "forged-clean",
						specEvidenceReceiptRef: "forged-spec",
					}),
				}),
			),
		);
		const result = await stage.execute({
			workflowId: "wf1",
			attemptId: "a1",
			profile: DEFAULT_MODEL_PROFILES.claude_plan_reviewer,
			assignment: "review",
			context: "ctx",
			session: fakeSession(),
			requirementsSnapshotRef: "artifact://wf1/plan",
			requirementsSnapshotSha256: "0".repeat(64),
		});
		const review = result.artifact as PlanReviewArtifactV2;
		expect(review.triggerReason).toBeNull();
		expect(review.routeSelectionReceiptRef).toBeNull();
		expect(review.cleanContextReceiptRef).toBeNull();
		expect(review.specEvidenceReceiptRef).toBeNull();
	});

	it("keeps legacy V1 parsing behind an explicit resume flag", async () => {
		let outputSchema: unknown;
		const runner = scriptedRunner({ codeReview: reviewArtifact("approved", "implementation") });
		const stage = new PlanReviewStage(
			new RuntimeAdapter(async request => {
				outputSchema = request.outputSchema;
				return runner(request);
			}),
		);
		const result = await stage.execute({
			workflowId: "wf1",
			attemptId: "a1",
			profile: DEFAULT_MODEL_PROFILES.claude_plan_reviewer,
			assignment: "review",
			context: "ctx",
			session: fakeSession(),
			legacyV1: true,
		});
		const review = result.artifact as ReviewArtifactV1;
		expect(review.schemaVersion).toBe(1);
		expect(review.subject).toBe("plan");
		expect((outputSchema as { required?: readonly string[] }).required).toEqual(ReviewArtifactJsonSchema.required);
	});
});
