import { describe, expect, it } from "bun:test";
import {
	ImplementationArtifactSchema,
	PlanArtifactSchema,
	ReviewArtifactSchema,
	VerificationArtifactSchema,
	WorkflowStateSchema,
} from "../../src/workflow/schemas";

const header = {
	schemaVersion: 1,
	workflowId: "wf_1",
	attemptId: "att_1",
	stage: "planning",
	createdAt: "2026-07-23T00:00:00.000Z",
} as const;

describe("Workflow schemas", () => {
	it("validates every artifact kind", () => {
		expect(
			PlanArtifactSchema.parse({
				...header,
				kind: "plan",
				summary: "Test plan",
				assumptions: [],
				nonGoals: [],
				affectedFiles: [],
				implementationSteps: [],
				acceptanceCriteria: [],
				verificationCommands: [],
				risks: [],
				rollback: [],
			}).kind,
		).toBe("plan");
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
		const plan = {
			...header,
			kind: "plan",
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
		expect(() => PlanArtifactSchema.parse({ ...plan, schemaVersion: 2 })).toThrow();
		expect(() => PlanArtifactSchema.parse({ ...plan, stage: "unknown" })).toThrow();
	});

	it("rejects invalid review confidence", () => {
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
	});

	it("validates persisted workflow state", () => {
		expect(
			WorkflowStateSchema.parse({
				id: "wf_1",
				status: "created",
				currentStage: "planning",
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
