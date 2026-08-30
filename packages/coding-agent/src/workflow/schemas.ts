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

const ArtifactHeaderV2Schema = z
	.object({
		schemaVersion: z.literal(2),
		workflowId: z.string().min(1),
		attemptId: z.string().min(1),
		stage: z.literal("plan_review"),
		createdAt: z.string().datetime(),
		modelProfileId: z.string().nullable(),
		provider: z.string().nullable(),
		model: z.string().nullable(),
		promptVersion: z.string().min(1),
	})
	.strict();

const WorkPackageSchema = z
	.object({
		id: z.string().min(1),
		assignment: z.string().min(1),
		paths: z.array(z.string().min(1)).min(1),
		dependsOn: z.array(z.string()),
	})
	.strict();

const AuthorResponseSchema = z
	.object({
		findingId: z.string().min(1),
		disposition: z.enum(["accepted", "rejected", "clarified"]),
		explanation: z.string().min(1),
		evidenceRefs: z.array(z.string()),
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
	workPackages: z.array(WorkPackageSchema).optional(),
	acceptanceCriteria: z.array(z.string()),
	verificationCommands: z.array(z.string()),
	risks: z.array(z.string()),
	rollback: z.array(z.string()),
	/** Replan-only planner dispositions for prior plan-review findings. */
	authorResponses: z.array(AuthorResponseSchema).optional(),
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
		blocking: z.boolean().optional(),
		resolutionEvidence: z.array(z.string().min(1)).optional(),
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

const FindingBasisSchema = z.enum([
	"spec_requirement",
	"user_requirement",
	"repo_evidence",
	"safety_invariant",
	"missing_authority",
]);

const RequirementCoverageSchema = z
	.object({
		requirementId: z.string().min(1),
		source: z.enum(["spec_requirement", "user_requirement"]),
		mandatory: z.boolean(),
		status: z.enum(["satisfied", "violated", "not_applicable", "missing_authority"]),
		evidenceRefs: z.array(z.string().min(1)),
		rationale: z.string().min(1),
	})
	.strict();

const PlanReviewFindingV2Schema = ReviewFindingSchema.extend({
	basis: FindingBasisSchema,
	requirementId: z.string().min(1).nullable(),
	sourceRefs: z.array(z.string().min(1)),
	missingAuthority: z.string().min(1).nullable(),
})
	.strict()
	.superRefine((finding, ctx) => {
		// Design §4/§5: basis-specific evidence. Unsupported findings must not parse as valid V2.
		switch (finding.basis) {
			case "spec_requirement":
			case "user_requirement": {
				if (finding.requirementId == null || finding.requirementId.trim().length === 0) {
					ctx.addIssue({
						code: "custom",
						message: `${finding.basis} findings require a non-empty requirementId`,
						path: ["requirementId"],
					});
				}
				if (finding.sourceRefs.length === 0) {
					ctx.addIssue({
						code: "custom",
						message: `${finding.basis} findings require non-empty sourceRefs`,
						path: ["sourceRefs"],
					});
				}
				if (finding.missingAuthority != null) {
					ctx.addIssue({
						code: "custom",
						message: `${finding.basis} findings cannot set missingAuthority`,
						path: ["missingAuthority"],
					});
				}
				break;
			}
			case "repo_evidence":
			case "safety_invariant": {
				if (finding.sourceRefs.length === 0) {
					ctx.addIssue({
						code: "custom",
						message: `${finding.basis} findings require non-empty sourceRefs`,
						path: ["sourceRefs"],
					});
				}
				if (finding.missingAuthority != null) {
					ctx.addIssue({
						code: "custom",
						message: `${finding.basis} findings cannot set missingAuthority`,
						path: ["missingAuthority"],
					});
				}
				break;
			}
			case "missing_authority": {
				if (finding.missingAuthority == null || finding.missingAuthority.trim().length === 0) {
					ctx.addIssue({
						code: "custom",
						message: "missing_authority findings require a concrete missingAuthority description",
						path: ["missingAuthority"],
					});
				}
				break;
			}
		}
	});

export const PlanReviewArtifactV2Schema = ArtifactHeaderV2Schema.extend({
	kind: z.literal("review"),
	subject: z.literal("plan"),
	reviewKind: z.enum(["initial", "rereview", "arbitration", "human"]),
	decision: z.enum(["approved", "changes_requested", "blocked"]),
	findings: z.array(PlanReviewFindingV2Schema),
	explanation: z.string().min(1),
	confidence: z.number().min(0).max(1),
	requirementsSnapshotRef: z.string().min(1),
	requirementsSnapshotSha256: z.string().regex(/^[0-9a-f]{64}$/),
	coverage: z.array(RequirementCoverageSchema),
	uncoveredDimensions: z.array(z.string()),
	antiAnchoringRationale: z.string().min(1),
	reviewRound: z.union([z.literal(1), z.literal(2)]),
	authorResponses: z.array(AuthorResponseSchema),
	triggerReason: z.enum(["contradiction", "suspicious_pass", "max_cycles_author_reject"]).nullable(),
	routeSelectionReceiptRef: z.string().min(1).nullable(),
	cleanContextReceiptRef: z.string().min(1).nullable(),
	specEvidenceReceiptRef: z.string().min(1).nullable(),
	authorityReceiptRef: z.string().min(1).nullable(),
})
	.strict()
	.superRefine((data, ctx) => {
		if (data.decision === "changes_requested") {
			if (data.reviewKind === "arbitration" || data.reviewKind === "human") {
				ctx.addIssue({
					code: "custom",
					message: "arbitration/human cannot request changes",
					path: ["decision"],
				});
			}
			if (data.findings.length === 0) {
				ctx.addIssue({
					code: "custom",
					message: "changes_requested requires at least one finding",
					path: ["findings"],
				});
			}
		}
		const missingAuthority = data.findings.some(f => f.basis === "missing_authority");
		if (missingAuthority && data.decision !== "blocked") {
			ctx.addIssue({
				code: "custom",
				message: "missing_authority findings require blocked decision",
				path: ["decision"],
			});
		}
		if (data.decision === "approved") {
			const mandatory = data.coverage.filter(c => c.mandatory && c.status !== "not_applicable");
			const uncovered = mandatory.filter(c => c.status !== "satisfied");
			if (uncovered.length > 0) {
				ctx.addIssue({
					code: "custom",
					message: "approved requires 100% applicable mandatory coverage",
					path: ["coverage"],
				});
			}
			if (
				data.findings.some(
					f => f.status === "open" && (f.blocking === true || f.priority === "P0" || f.priority === "P1"),
				)
			) {
				ctx.addIssue({
					code: "custom",
					message: "approved cannot leave open blocking findings",
					path: ["findings"],
				});
			}
		}
		if (data.reviewKind === "human" && !data.authorityReceiptRef) {
			ctx.addIssue({
				code: "custom",
				message: "human review requires authorityReceiptRef",
				path: ["authorityReceiptRef"],
			});
		}
		if (data.reviewKind !== "human" && data.authorityReceiptRef) {
			ctx.addIssue({
				code: "custom",
				message: "model review cannot set authorityReceiptRef",
				path: ["authorityReceiptRef"],
			});
		}
	});

/**
 * Stage-parse schema: rejects engine-owned fields on initial/rereview so models cannot forge them
 * at the stage boundary. Persisted artifacts use {@link PlanReviewArtifactV2Schema}, which allows
 * the engine to stamp `triggerReason` / receipt refs after a successful stage parse.
 */
export const PlanReviewArtifactV2StageSchema = PlanReviewArtifactV2Schema.superRefine((data, ctx) => {
	if (data.reviewKind === "arbitration" || data.reviewKind === "human") return;
	if (data.triggerReason != null) {
		ctx.addIssue({
			code: "custom",
			message: "initial/rereview cannot set triggerReason",
			path: ["triggerReason"],
		});
	}
	if (data.cleanContextReceiptRef != null) {
		ctx.addIssue({
			code: "custom",
			message: "initial/rereview cannot set cleanContextReceiptRef",
			path: ["cleanContextReceiptRef"],
		});
	}
	if (data.specEvidenceReceiptRef != null) {
		ctx.addIssue({
			code: "custom",
			message: "initial/rereview cannot set specEvidenceReceiptRef",
			path: ["specEvidenceReceiptRef"],
		});
	}
});

export const PlanReviewArtifactSchema = z.union([ReviewArtifactSchema, PlanReviewArtifactV2Schema]);

export const PlanReviewControlStateSchema = z
	.object({
		schemaVersion: z.literal(1),
		kind: z.literal("plan_review_control_state"),
		substate: z.enum(["initial_review", "awaiting_replan", "rereview", "arbitration", "awaiting_human"]),
		reviewRound: z.union([z.literal(1), z.literal(2)]),
		planRejectionCount: z.number().int().min(0),
		arbitrationCycles: z.union([z.literal(0), z.literal(1)]),
		arbitrationTrigger: z.enum(["contradiction", "suspicious_pass", "max_cycles_author_reject"]).nullable(),
		// Defaults keep legacy control artifacts (pre-HIGH-5/HIGH-10) parseable.
		arbitrationAttemptId: z.string().min(1).nullable().default(null),
		arbitrationAttemptPhase: z.enum(["reserved", "completed", "failed_closed"]).nullable().default(null),
		// Missing cohort on old artifacts is filled at hydrate time (legacy → v1).
		reviewSchemaCohort: z.enum(["v1", "v2"]).default("v1"),
		latestPlanArtifactRef: z.string().nullable(),
		latestReviewArtifactRef: z.string().nullable(),
		authorResponsesArtifactRef: z.string().nullable(),
		routeSelectionReceiptRef: z.string().nullable(),
		humanRequestReason: z.string().nullable(),
		updatedAt: z.string().datetime(),
	})
	.strict();

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
	noChangesRequired: z.boolean().optional(),
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
		pipelineKind: z.literal("devflow").optional(),
		overlaySidecar: z.unknown().optional(),
	})
	.strict();

const PIPELINE_BLOCKING_PRIORITIES = new Set(["P0", "P1"]);

export const PipelineGateVerdictSchema = z.enum([
	"PASS",
	"PASS_WITH_NOTES",
	"NEEDS_REVISION",
	"NEEDS_REDESIGN",
	"PASS_WITH_NODE",
]);

export const GateExpectedContextSchema = z
	.object({
		subject: z.enum(["plan", "implementation"]),
		workflowId: z.string().min(1).optional(),
		attemptId: z.string().min(1).optional(),
		identity: z
			.object({
				modelFamily: z.string().min(1).optional(),
			})
			.strict()
			.optional(),
	})
	.strict();

const GateModelIdentitySchema = z
	.object({
		modelFamily: z.string().min(1).optional(),
	})
	.strict();

/** Minimal model-facing Gate JSON (id/identity optional; engine stamps the rest). */
export const GateResultModelSchema = z
	.object({
		verdict: PipelineGateVerdictSchema,
		subject: z.enum(["plan", "implementation"]),
		findings: z.array(ReviewFindingSchema).default([]),
		notes: z.string().default(""),
		explanation: z.string().min(1),
		workflowId: z.string().min(1).optional(),
		attemptId: z.string().min(1).optional(),
		identity: GateModelIdentitySchema.optional(),
	})
	.strict();

export const GateResultArtifactSchema = z
	.object({
		schemaVersion: z.literal(1),
		kind: z.literal("gate-result"),
		verdict: z.enum(["PASS", "PASS_WITH_NOTES", "NEEDS_REVISION", "NEEDS_REDESIGN"]),
		subject: z.enum(["plan", "implementation"]),
		findings: z.array(ReviewFindingSchema),
		notes: z.string(),
		explanation: z.string().min(1),
		workflowId: z.string().min(1),
		attemptId: z.string().min(1),
		createdAt: z.string().datetime(),
		reviewerIdentity: z
			.object({
				modelFamily: z.string().optional(),
				provider: z.string().optional(),
				model: z.string().optional(),
			})
			.strict()
			.optional(),
	})
	.strict();

export type GateExpectedContext = z.infer<typeof GateExpectedContextSchema>;
export type GateResultModelRaw = z.infer<typeof GateResultModelSchema>;
export type NormalizedGateVerdict = "PASS" | "PASS_WITH_NOTES" | "NEEDS_REVISION" | "NEEDS_REDESIGN";
export type GateResultModel = Omit<GateResultModelRaw, "verdict"> & { verdict: NormalizedGateVerdict };
export type GateResultArtifact = z.infer<typeof GateResultArtifactSchema>;

export class GateParseError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "GateParseError";
		this.code = code;
	}
}

/** Open finding is a PASS* blocker when blocking===true or priority is P0/P1. */
export function isOpenPassBlocker(finding: { status?: string; blocking?: boolean; priority?: string }): boolean {
	if (finding.status !== "open") return false;
	return finding.blocking === true || PIPELINE_BLOCKING_PRIORITIES.has(finding.priority ?? "");
}

/**
 * Pipeline-only. Fail-closed when PASS* still has an open P0/P1 or blocking finding.
 * Does not rewrite the verdict to NEEDS_REVISION.
 */
export function assertPassHasNoOpenBlockers(
	verdict: string,
	findings: ReadonlyArray<{ status?: string; blocking?: boolean; priority?: string }>,
): void {
	if (verdict !== "PASS" && verdict !== "PASS_WITH_NOTES") return;
	if (findings.some(isOpenPassBlocker)) {
		throw new GateParseError(
			"pass_open_blockers",
			"PASS/PASS_WITH_NOTES cannot retain open P0/P1 or blocking findings",
		);
	}
}

function normalizeGateVerdict(
	verdict: z.infer<typeof PipelineGateVerdictSchema>,
): "PASS" | "PASS_WITH_NOTES" | "NEEDS_REVISION" | "NEEDS_REDESIGN" {
	return verdict === "PASS_WITH_NODE" ? "PASS_WITH_NOTES" : verdict;
}

/**
 * Fail-closed Gate parse bound to the current stage. Missing id/identity are stamped later.
 */
export function parseGateResultArtifact(raw: unknown, expected: GateExpectedContext): GateResultModel {
	const expectedParsed = GateExpectedContextSchema.parse(expected);
	const model = GateResultModelSchema.parse(raw);
	const verdict = normalizeGateVerdict(model.verdict);
	if (model.subject !== expectedParsed.subject) {
		throw new GateParseError("subject_mismatch", `Gate subject ${model.subject} !== ${expectedParsed.subject}`);
	}
	if (model.workflowId && expectedParsed.workflowId && model.workflowId !== expectedParsed.workflowId) {
		throw new GateParseError("stale_workflow_id", "Gate workflowId does not match expected context");
	}
	if (model.attemptId && expectedParsed.attemptId && model.attemptId !== expectedParsed.attemptId) {
		throw new GateParseError("stale_attempt_id", "Gate attemptId does not match expected context");
	}
	const expectedFamily = expectedParsed.identity?.modelFamily;
	const actualFamily = model.identity?.modelFamily;
	if (expectedFamily && actualFamily && expectedFamily !== actualFamily) {
		throw new GateParseError("identity_mismatch", "Gate identity.modelFamily does not match expected context");
	}
	if (verdict === "NEEDS_REVISION" && model.findings.length < 1) {
		throw new GateParseError("revision_requires_finding", "NEEDS_REVISION requires at least one finding");
	}
	assertPassHasNoOpenBlockers(verdict, model.findings);
	return { ...model, verdict };
}
