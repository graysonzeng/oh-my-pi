import { describe, expect, it } from "bun:test";
import {
	ImplementationArtifactSchema,
	PlanArtifactSchema,
	ReviewArtifactSchema,
	ReviewFindingSchema,
	VerificationArtifactSchema,
	WorkflowStateSchema,
} from "../../src/workflow/schemas";

const header = {
	schemaVersion: 1 as const,
	workflowId: "wf_1",
	attemptId: "att_1",
	stage: "planning" as const,
	createdAt: "2026-07-23T00:00:00.000Z",
};

const validPlan = {
	...header,
	kind: "plan" as const,
	summary: "Test plan",
	assumptions: [],
	nonGoals: [],
	affectedFiles: [],
	implementationSteps: [],
	acceptanceCriteria: [],
	verificationCommands: [],
	risks: [],
	rollback: [],
};

describe("Workflow schemas", () => {
	it("validates every artifact kind", () => {
		expect(PlanArtifactSchema.parse(validPlan).kind).toBe("plan");
		expect(
			ImplementationArtifactSchema.parse({
				...header,
				stage: "implementing",
				kind: "implementation",
				summary: "Implemented",
				changedFiles: [],
				addressedStepIds: [],
				commandsRun: [],
				unresolved: [],
			}).kind,
		).toBe("implementation");
		expect(
			VerificationArtifactSchema.parse({
				...header,
				stage: "final_verify",
				kind: "verification",
				passed: true,
				checks: [],
			}).kind,
		).toBe("verification");
	});

	it("rejects unknown schema versions and stages", () => {
		expect(() => PlanArtifactSchema.parse({ ...validPlan, schemaVersion: 2 })).toThrow();
		expect(() => PlanArtifactSchema.parse({ ...validPlan, stage: "unknown" })).toThrow();
	});

	it("rejects missing required fields", () => {
		const { summary: _s, ...noSummary } = validPlan;
		expect(() => PlanArtifactSchema.parse(noSummary)).toThrow();
		expect(() =>
			ReviewArtifactSchema.parse({
				...header,
				stage: "plan_review",
				kind: "review",
				subject: "plan",
				decision: "approved",
				findings: [],
				// missing explanation + confidence
			}),
		).toThrow();
	});

	it("rejects invalid finding priority and confidence", () => {
		expect(() =>
			ReviewFindingSchema.parse({
				id: "f1",
				priority: "P9",
				category: "correctness",
				confidence: 0.5,
				summary: "x",
				explanation: "y",
				suggestedOwner: "implementer",
			}),
		).toThrow();
		expect(() =>
			ReviewArtifactSchema.parse({
				...header,
				stage: "plan_review",
				kind: "review",
				subject: "plan",
				decision: "approved",
				findings: [],
				explanation: "ok",
				confidence: 1.1,
			}),
		).toThrow();
		expect(() =>
			ReviewArtifactSchema.parse({
				...header,
				stage: "plan_review",
				kind: "review",
				subject: "plan",
				decision: "approved",
				findings: [],
				explanation: "ok",
				confidence: -0.1,
			}),
		).toThrow();
	});

	it("rejects unknown keys on strict objects", () => {
		expect(() => PlanArtifactSchema.parse({ ...validPlan, extraField: true })).toThrow();
	});

	it("validates persisted workflow state", () => {
		expect(
			WorkflowStateSchema.parse({
				id: "wf_1",
				status: "created",
				currentStage: "created",
				degradedMode: false,
				createdAt: header.createdAt,
				updatedAt: header.createdAt,
				version: 1,
				requestJson: "{}",
				policyJson: "{}",
			}).status,
		).toBe("created");
	});
});
