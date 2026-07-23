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
		acceptanceCriteria: { type: "array", items: { type: "string" } },
		verificationCommands: { type: "array", items: { type: "string" } },
		risks: { type: "array", items: { type: "string" } },
		rollback: { type: "array", items: { type: "string" } },
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
		branchName: { type: "string" },
		unresolved: { type: "array", items: { type: "string" } },
	},
} as const;
