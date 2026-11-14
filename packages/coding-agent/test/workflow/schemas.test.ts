import { describe, expect, it } from "bun:test";
import {
	ImplementationArtifactSchema,
	PlanArtifactSchema,
	PlanReviewArtifactV2Schema,
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

	it("accepts optional work packages and keeps legacy plans valid", () => {
		const parsed = PlanArtifactSchema.parse({
			...validPlan,
			workPackages: [
				{
					id: "pkg-a",
					assignment: "Implement the first slice",
					paths: ["src/first.ts"],
					dependsOn: [],
				},
				{
					id: "pkg-b",
					assignment: "Implement the second slice",
					paths: ["src/second.ts"],
					dependsOn: ["pkg-a"],
				},
			],
		});
		expect(parsed.workPackages).toHaveLength(2);
		expect(PlanArtifactSchema.parse(validPlan).workPackages).toBeUndefined();
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

	it("accepts engine-owned blocking and resolution evidence metadata", () => {
		const parsed = ReviewFindingSchema.parse({
			id: "f-engine",
			priority: "P2",
			category: "correctness",
			status: "resolved",
			confidence: 0.9,
			summary: "fixed by engine repair",
			explanation: "repair artifact addressed it",
			suggestedOwner: "implementer",
			blocking: true,
			resolutionEvidence: ["repair:att_2"],
		});
		expect(parsed.blocking).toBe(true);
		expect(parsed.resolutionEvidence).toEqual(["repair:att_2"]);
	});

	it("rejects unknown keys on strict objects", () => {
		expect(() => PlanArtifactSchema.parse({ ...validPlan, extraField: true })).toThrow();
		expect(() =>
			PlanArtifactSchema.parse({
				...validPlan,
				workPackages: [
					{
						id: "pkg-a",
						assignment: "Implement the first slice",
						paths: ["src/first.ts"],
						dependsOn: [],
						extraField: true,
					},
				],
			}),
		).toThrow();
		expect(() =>
			PlanArtifactSchema.parse({
				...validPlan,
				workPackages: [
					{
						id: "pkg-a",
						assignment: "Implement the first slice",
						paths: [],
						dependsOn: [],
					},
				],
			}),
		).toThrow();
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

describe("PlanReviewArtifactV2 basis-specific evidence", () => {
	const v2Header = {
		schemaVersion: 2 as const,
		workflowId: "wf_1",
		attemptId: "att_1",
		stage: "plan_review" as const,
		createdAt: "2026-07-23T00:00:00.000Z",
		modelProfileId: "test-profile",
		provider: "test",
		model: "test/model",
		promptVersion: "test-v2",
	};

	const baseFinding = {
		id: "f1",
		priority: "P1" as const,
		category: "correctness" as const,
		status: "open" as const,
		confidence: 0.9,
		summary: "finding",
		explanation: "detail",
		suggestedOwner: "implementer" as const,
	};

	function review(overrides: {
		decision?: "approved" | "changes_requested" | "blocked";
		findings?: Array<Record<string, unknown>>;
	}) {
		return {
			...v2Header,
			kind: "review" as const,
			subject: "plan" as const,
			reviewKind: "initial" as const,
			decision: overrides.decision ?? "changes_requested",
			findings: overrides.findings ?? [],
			explanation: "review explanation",
			confidence: 0.9,
			requirementsSnapshotRef: "artifact://requirements",
			requirementsSnapshotSha256: "a".repeat(64),
			coverage: [],
			uncoveredDimensions: [],
			antiAnchoringRationale: "checked dimensions",
			reviewRound: 1 as const,
			authorResponses: [],
			triggerReason: null,
			routeSelectionReceiptRef: null,
			cleanContextReceiptRef: null,
			specEvidenceReceiptRef: null,
			authorityReceiptRef: null,
		};
	}

	it("rejects repo_evidence findings without sourceRefs", () => {
		const result = PlanReviewArtifactV2Schema.safeParse(
			review({
				findings: [
					{
						...baseFinding,
						basis: "repo_evidence",
						requirementId: null,
						sourceRefs: [],
						missingAuthority: null,
					},
				],
			}),
		);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues.some(issue => issue.path.join(".").includes("sourceRefs"))).toBe(true);
		}
	});

	it("rejects requirement-basis findings without requirementId", () => {
		const result = PlanReviewArtifactV2Schema.safeParse(
			review({
				findings: [
					{
						...baseFinding,
						basis: "spec_requirement",
						requirementId: null,
						sourceRefs: ["spec.md:1"],
						missingAuthority: null,
					},
				],
			}),
		);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues.some(issue => issue.path.join(".").includes("requirementId"))).toBe(true);
		}
	});

	it("rejects missing_authority findings without missingAuthority description", () => {
		const result = PlanReviewArtifactV2Schema.safeParse(
			review({
				decision: "blocked",
				findings: [
					{
						...baseFinding,
						suggestedOwner: "human",
						basis: "missing_authority",
						requirementId: null,
						sourceRefs: [],
						missingAuthority: null,
					},
				],
			}),
		);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues.some(issue => issue.path.join(".").includes("missingAuthority"))).toBe(true);
		}
	});

	it("rejects missing_authority findings when decision is not blocked", () => {
		const result = PlanReviewArtifactV2Schema.safeParse(
			review({
				decision: "changes_requested",
				findings: [
					{
						...baseFinding,
						suggestedOwner: "human",
						basis: "missing_authority",
						requirementId: null,
						sourceRefs: [],
						missingAuthority: "product_owner sign-off",
					},
				],
			}),
		);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues.some(issue => issue.message.includes("blocked"))).toBe(true);
		}
	});

	it("accepts well-formed basis-specific findings", () => {
		expect(
			PlanReviewArtifactV2Schema.safeParse(
				review({
					findings: [
						{
							...baseFinding,
							id: "req",
							basis: "user_requirement",
							requirementId: "user:req-001",
							sourceRefs: ["request:line-1"],
							missingAuthority: null,
						},
						{
							...baseFinding,
							id: "repo",
							basis: "repo_evidence",
							requirementId: null,
							sourceRefs: ["src/foo.ts:12"],
							missingAuthority: null,
						},
					],
				}),
			).success,
		).toBe(true);

		expect(
			PlanReviewArtifactV2Schema.safeParse(
				review({
					decision: "blocked",
					findings: [
						{
							...baseFinding,
							suggestedOwner: "human",
							basis: "missing_authority",
							requirementId: null,
							sourceRefs: [],
							missingAuthority: "security owner must approve exception",
						},
					],
				}),
			).success,
		).toBe(true);
	});
});
