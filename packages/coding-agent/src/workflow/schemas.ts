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

const ArtifactHeaderSchema = z.object({
	schemaVersion: z.literal(1),
	workflowId: z.string().min(1),
	attemptId: z.string().min(1),
	stage: WorkflowStatusSchema,
	createdAt: z.string().datetime(),
	modelProfileId: z.string().optional(),
	provider: z.string().optional(),
	model: z.string().optional(),
	promptVersion: z.string().optional(),
});

export const PlanArtifactSchema = ArtifactHeaderSchema.extend({
	kind: z.literal("plan"),
	summary: z.string(),
	assumptions: z.array(z.string()),
	nonGoals: z.array(z.string()),
	affectedFiles: z.array(
		z.object({
			path: z.string(),
			action: z.enum(["create", "modify", "delete"]),
			reason: z.string(),
		}),
	),
	implementationSteps: z.array(
		z.object({
			id: z.string(),
			description: z.string(),
			dependsOn: z.array(z.string()),
		}),
	),
	acceptanceCriteria: z.array(z.string()),
	verificationCommands: z.array(z.string()),
	risks: z.array(z.string()),
	rollback: z.array(z.string()),
}).strict();

const ReviewFindingSchema = z
	.object({
		id: z.string(),
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
		summary: z.string(),
		explanation: z.string(),
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
	explanation: z.string(),
	confidence: z.number().min(0).max(1),
}).strict();

export const ImplementationArtifactSchema = ArtifactHeaderSchema.extend({
	kind: z.literal("implementation"),
	summary: z.string(),
	changedFiles: z.array(z.string()),
	addressedStepIds: z.array(z.string()),
	commandsRun: z.array(
		z.object({
			command: z.string(),
			exitCode: z.number().int(),
			summary: z.string(),
		}),
	),
	patchPath: z.string().optional(),
	branchName: z.string().optional(),
	unresolved: z.array(z.string()),
}).strict();

export const VerificationArtifactSchema = ArtifactHeaderSchema.extend({
	kind: z.literal("verification"),
	passed: z.boolean(),
	checks: z.array(
		z.object({
			id: z.string(),
			command: z.string().optional(),
			status: z.enum(["passed", "failed", "skipped"]),
			exitCode: z.number().int().optional(),
			summary: z.string(),
			logPath: z.string().optional(),
		}),
	),
}).strict();

export const WorkflowStateSchema = z
	.object({
		id: z.string(),
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
