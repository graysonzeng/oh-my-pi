import { z } from "zod";

export const WorkflowStatusSchema = z.enum([
	"created",
	"planning",
	"plan_review",
	"implementing",
	"implementation_verify",
	"code_review",
	"repairing",
	"final_verify",
	"completed",
	"blocked",
	"cancelled",
	"failed",
]);

const ArtifactHeaderSchema = z
	.object({
		schemaVersion: z.literal(1),
		workflowId: z.string().min(1),
		attemptId: z.string().min(1),
		stage: WorkflowStatusSchema,
		createdAt: z.string().datetime(),
		modelProfileId: z.string().optional(),
		provider: z.string().optional(),
		model: z.string().optional(),
		promptVersion: z.string().optional(),
	})
	.strict();

export const PlanArtifactSchema = ArtifactHeaderSchema.extend({
	kind: z.literal("plan"),
	summary: z.string().min(1),
	assumptions: z.array(z.string()),
	nonGoals: z.array(z.string()),
	affectedFiles: z.array(
		z
			.object({
				path: z.string().min(1),
				action: z.enum(["create", "modify", "delete"]),
				reason: z.string(),
			})
			.strict(),
	),
	implementationSteps: z.array(
		z
			.object({
				id: z.string().min(1),
				description: z.string().min(1),
				dependsOn: z.array(z.string()),
			})
			.strict(),
	),
	acceptanceCriteria: z.array(z.string()),
	verificationCommands: z.array(z.string()),
	risks: z.array(z.string()),
	rollback: z.array(z.string()),
}).strict();

export const ReviewFindingSchema = z
	.object({
		id: z.string().min(1),
		priority: z.enum(["P0", "P1", "P2", "P3"]),
		category: z.enum([
			"correctness",
			"architecture",
			"security",
			"concurrency",
			"compatibility",
			"testing",
			"maintainability",
		]),
		status: z.enum(["open", "in_progress", "resolved", "rejected"]).default("open"),
		confidence: z.number().min(0).max(1),
		summary: z.string().min(1),
		explanation: z.string().min(1),
		file: z.string().optional(),
		line: z.number().int().positive().optional(),
		suggestedOwner: z.enum(["implementer", "reasoning_repair", "human"]),
	})
	.strict();

export const ReviewArtifactSchema = ArtifactHeaderSchema.extend({
	kind: z.literal("review"),
	subject: z.enum(["plan", "implementation"]),
	decision: z.enum(["approved", "changes_requested", "blocked"]),
	findings: z.array(ReviewFindingSchema),
	explanation: z.string().min(1),
	confidence: z.number().min(0).max(1),
})
	.strict()
	.superRefine((data, ctx) => {
		// changes_requested must carry at least one finding so replan/repair have actionable IDs.
		if (data.decision === "changes_requested" && data.findings.length === 0) {
			ctx.addIssue({
				code: "custom",
				message: "changes_requested requires at least one finding",
				path: ["findings"],
			});
		}
		if (data.decision === "blocked" && data.findings.length === 0 && data.explanation.trim().length < 8) {
			ctx.addIssue({
				code: "custom",
				message: "blocked decision requires findings or a substantive explanation",
				path: ["explanation"],
			});
		}
	});

export const ImplementationArtifactSchema = ArtifactHeaderSchema.extend({
	kind: z.literal("implementation"),
	summary: z.string().min(1),
	changedFiles: z.array(z.string()),
	addressedStepIds: z.array(z.string()),
	commandsRun: z.array(
		z
			.object({
				command: z.string().min(1),
				exitCode: z.number().int(),
				summary: z.string(),
			})
			.strict(),
	),
	patchPath: z.string().optional(),
	branchName: z.string().optional(),
	unresolved: z.array(z.string()),
}).strict();

export const VerificationArtifactSchema = ArtifactHeaderSchema.extend({
	kind: z.literal("verification"),
	passed: z.boolean(),
	checks: z.array(
		z
			.object({
				id: z.string().min(1),
				command: z.string().optional(),
				status: z.enum(["passed", "failed", "skipped"]),
				exitCode: z.number().int().optional(),
				summary: z.string(),
				logPath: z.string().optional(),
			})
			.strict(),
	),
}).strict();

export const WorkflowStateSchema = z
	.object({
		id: z.string().min(1),
		status: WorkflowStatusSchema,
		currentStage: WorkflowStatusSchema,
		currentAttemptId: z.string().optional(),
		degradedMode: z.boolean().default(false),
		createdAt: z.string().datetime(),
		updatedAt: z.string().datetime(),
		version: z.number().int().positive(),
		requestJson: z.string(),
		policyJson: z.string(),
	})
	.strict();
