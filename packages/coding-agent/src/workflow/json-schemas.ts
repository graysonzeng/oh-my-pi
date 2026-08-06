/**
 * Plain JSON Schema objects for structured-subagent outputSchema.
 * Kept in lockstep with Zod contracts in schemas.ts (nested required fields + additionalProperties: false).
 */

const artifactHeaderProperties = {
	schemaVersion: { const: 1 },
	workflowId: { type: "string", minLength: 1 },
	attemptId: { type: "string", minLength: 1 },
	stage: { type: "string" },
	createdAt: { type: "string" },
	modelProfileId: { type: "string" },
	provider: { type: "string" },
	model: { type: "string" },
	promptVersion: { type: "string" },
} as const;

const reviewFindingItem = {
	type: "object",
	additionalProperties: false,
	required: ["id", "priority", "category", "confidence", "summary", "explanation", "suggestedOwner"],
	properties: {
		id: { type: "string", minLength: 1 },
		priority: { enum: ["P0", "P1", "P2", "P3"] },
		category: {
			enum: [
				"correctness",
				"architecture",
				"security",
				"concurrency",
				"compatibility",
				"testing",
				"maintainability",
			],
		},
		status: { enum: ["open", "in_progress", "resolved", "rejected"] },
		confidence: { type: "number", minimum: 0, maximum: 1 },
		summary: { type: "string", minLength: 1 },
		explanation: { type: "string", minLength: 1 },
		file: { type: "string" },
		line: { type: "integer", exclusiveMinimum: 0 },
		suggestedOwner: { enum: ["implementer", "reasoning_repair", "human"] },
	},
} as const;

const commandRunItem = {
	type: "object",
	additionalProperties: false,
	required: ["command", "exitCode", "summary"],
	properties: {
		command: { type: "string", minLength: 1 },
		exitCode: { type: "integer" },
		summary: { type: "string" },
	},
} as const;

const workPackageItem = {
	type: "object",
	additionalProperties: false,
	required: ["id", "assignment", "paths", "dependsOn"],
	properties: {
		id: { type: "string", minLength: 1 },
		assignment: { type: "string", minLength: 1 },
		paths: {
			type: "array",
			minItems: 1,
			items: { type: "string", minLength: 1 },
		},
		dependsOn: { type: "array", items: { type: "string" } },
	},
} as const;

const authorResponseItem = {
	type: "object",
	additionalProperties: false,
	required: ["findingId", "disposition", "explanation", "evidenceRefs"],
	properties: {
		findingId: { type: "string", minLength: 1 },
		disposition: { enum: ["accepted", "rejected", "clarified"] },
		explanation: { type: "string", minLength: 1 },
		evidenceRefs: { type: "array", items: { type: "string" } },
	},
} as const;

export const PlanArtifactJsonSchema = {
	type: "object",
	additionalProperties: false,
	required: [
		"schemaVersion",
		"workflowId",
		"attemptId",
		"stage",
		"createdAt",
		"kind",
		"summary",
		"assumptions",
		"nonGoals",
		"affectedFiles",
		"implementationSteps",
		"acceptanceCriteria",
		"verificationCommands",
		"risks",
		"rollback",
	],
	properties: {
		...artifactHeaderProperties,
		kind: { const: "plan" },
		summary: { type: "string" },
		assumptions: { type: "array", items: { type: "string" } },
		nonGoals: { type: "array", items: { type: "string" } },
		affectedFiles: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["path", "action", "reason"],
				properties: {
					path: { type: "string" },
					action: { enum: ["create", "modify", "delete"] },
					reason: { type: "string" },
				},
			},
		},
		implementationSteps: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["id", "description", "dependsOn"],
				properties: {
					id: { type: "string" },
					description: { type: "string" },
					dependsOn: { type: "array", items: { type: "string" } },
				},
			},
		},
		workPackages: { type: "array", items: workPackageItem },
		acceptanceCriteria: { type: "array", items: { type: "string" } },
		verificationCommands: { type: "array", items: { type: "string" } },
		risks: { type: "array", items: { type: "string" } },
		rollback: { type: "array", items: { type: "string" } },
		// Replan-only: required by engine when prior open P0/P1 findings exist.
		authorResponses: { type: "array", items: authorResponseItem },
	},
} as const;

export const ReviewArtifactJsonSchema = {
	type: "object",
	additionalProperties: false,
	required: [
		"schemaVersion",
		"workflowId",
		"attemptId",
		"stage",
		"createdAt",
		"kind",
		"subject",
		"decision",
		"findings",
		"explanation",
		"confidence",
	],
	properties: {
		...artifactHeaderProperties,
		kind: { const: "review" },
		subject: { enum: ["plan", "implementation"] },
		decision: { enum: ["approved", "changes_requested", "blocked"] },
		findings: { type: "array", items: reviewFindingItem },
		explanation: { type: "string", minLength: 1 },
		confidence: { type: "number", minimum: 0, maximum: 1 },
	},
} as const;

const artifactHeaderV2Properties = {
	schemaVersion: { const: 2 },
	workflowId: { type: "string", minLength: 1 },
	attemptId: { type: "string", minLength: 1 },
	stage: { const: "plan_review" },
	createdAt: { type: "string" },
	modelProfileId: { type: ["string", "null"] },
	provider: { type: ["string", "null"] },
	model: { type: ["string", "null"] },
	promptVersion: { type: "string", minLength: 1 },
} as const;

const planReviewFindingV2Item = {
	type: "object",
	additionalProperties: false,
	required: [
		"id",
		"priority",
		"category",
		"confidence",
		"summary",
		"explanation",
		"suggestedOwner",
		"basis",
		"requirementId",
		"sourceRefs",
		"missingAuthority",
	],
	properties: {
		...reviewFindingItem.properties,
		basis: {
			enum: ["spec_requirement", "user_requirement", "repo_evidence", "safety_invariant", "missing_authority"],
		},
		requirementId: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
		sourceRefs: { type: "array", items: { type: "string", minLength: 1 } },
		missingAuthority: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
	},
	// Keep in lockstep with PlanReviewFindingV2Schema basis superRefine (Zod remains fail-closed).
	// JSON Schema if/then is not a thenable; biome's noThenProperty is for Promise-like shapes.
	allOf: [
		{
			if: {
				properties: { basis: { enum: ["spec_requirement", "user_requirement"] } },
				required: ["basis"],
			},
			// biome-ignore lint/suspicious/noThenProperty: `then` is the standard JSON Schema conditional keyword.
			then: {
				properties: {
					requirementId: { type: "string", minLength: 1 },
					sourceRefs: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
					missingAuthority: { type: "null" },
				},
			},
		},
		{
			if: {
				properties: { basis: { enum: ["repo_evidence", "safety_invariant"] } },
				required: ["basis"],
			},
			// biome-ignore lint/suspicious/noThenProperty: `then` is the standard JSON Schema conditional keyword.
			then: {
				properties: {
					sourceRefs: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
					missingAuthority: { type: "null" },
				},
			},
		},
		{
			if: {
				properties: { basis: { const: "missing_authority" } },
				required: ["basis"],
			},
			// biome-ignore lint/suspicious/noThenProperty: `then` is the standard JSON Schema conditional keyword.
			then: {
				properties: {
					missingAuthority: { type: "string", minLength: 1 },
				},
			},
		},
	],
} as const;

const requirementCoverageItem = {
	type: "object",
	additionalProperties: false,
	required: ["requirementId", "source", "mandatory", "status", "evidenceRefs", "rationale"],
	properties: {
		requirementId: { type: "string", minLength: 1 },
		source: { enum: ["spec_requirement", "user_requirement"] },
		mandatory: { type: "boolean" },
		status: { enum: ["satisfied", "violated", "not_applicable", "missing_authority"] },
		evidenceRefs: { type: "array", items: { type: "string", minLength: 1 } },
		rationale: { type: "string", minLength: 1 },
	},
} as const;

/** Strict model-facing V2 plan-review output; engine-owned metadata is merged before Zod parsing. */
export const PlanReviewArtifactV2JsonSchema = {
	type: "object",
	additionalProperties: false,
	required: [
		"schemaVersion",
		"workflowId",
		"attemptId",
		"stage",
		"createdAt",
		"kind",
		"subject",
		"decision",
		"findings",
		"explanation",
		"confidence",
		"coverage",
		"uncoveredDimensions",
		"antiAnchoringRationale",
	],
	properties: {
		...artifactHeaderV2Properties,
		kind: { const: "review" },
		subject: { const: "plan" },
		reviewKind: { enum: ["initial", "rereview", "arbitration", "human"] },
		decision: { enum: ["approved", "changes_requested", "blocked"] },
		findings: { type: "array", items: planReviewFindingV2Item },
		explanation: { type: "string", minLength: 1 },
		confidence: { type: "number", minimum: 0, maximum: 1 },
		requirementsSnapshotRef: { type: "string", minLength: 1 },
		requirementsSnapshotSha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
		coverage: { type: "array", items: requirementCoverageItem },
		uncoveredDimensions: { type: "array", items: { type: "string" } },
		antiAnchoringRationale: { type: "string", minLength: 1 },
		reviewRound: { enum: [1, 2] },
		authorResponses: { type: "array", items: authorResponseItem },
		// Engine-owned fields (triggerReason, routeSelectionReceiptRef, cleanContextReceiptRef,
		// specEvidenceReceiptRef) are intentionally omitted so models are not invited to emit them.
		authorityReceiptRef: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
	},
} as const;

export const ImplementationArtifactJsonSchema = {
	type: "object",
	additionalProperties: false,
	required: [
		"schemaVersion",
		"workflowId",
		"attemptId",
		"stage",
		"createdAt",
		"kind",
		"summary",
		"changedFiles",
		"addressedStepIds",
		"commandsRun",
		"unresolved",
	],
	properties: {
		...artifactHeaderProperties,
		kind: { const: "implementation" },
		summary: { type: "string", minLength: 1 },
		changedFiles: { type: "array", items: { type: "string" } },
		addressedStepIds: { type: "array", items: { type: "string" } },
		commandsRun: { type: "array", items: commandRunItem },
		patchPath: { type: "string" },
		noChangesRequired: { type: "boolean" },
		branchName: { type: "string" },
		unresolved: { type: "array", items: { type: "string" } },
	},
} as const;
