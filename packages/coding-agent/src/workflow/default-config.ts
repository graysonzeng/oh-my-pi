import type { ModelProfile } from "./types";

const baseContext = {
	includePlan: true,
	includeReviewFindings: true,
	includeVerification: true,
	includeFullTranscript: false,
	maxArtifactBytes: 1024 * 1024,
} as const;

export const DEFAULT_MODEL_PROFILES = {
	claude_planner: {
		id: "claude_planner",
		vendor: "anthropic",
		modelPattern: ["claude-sonnet-*", "claude-opus-*"],
		roles: ["planner"],
		promptTemplate: "planner",
		promptVersion: "1.0",
		toolPolicyId: "readonly-planning",
		maxRequests: 50,
		maxRuntimeMs: 300_000,
		retryPolicy: {
			maxAttempts: 2,
			retryableErrorKinds: ["timeout", "rate_limit"],
			fallbackProfileIds: ["gpt_planner"],
		},
		contextPolicy: { ...baseContext },
	},
	gpt_planner: {
		id: "gpt_planner",
		vendor: "openai",
		modelPattern: ["gpt-5.*", "o3*"],
		roles: ["planner"],
		promptTemplate: "planner",
		promptVersion: "1.0",
		toolPolicyId: "readonly-planning",
		maxRequests: 50,
		maxRuntimeMs: 300_000,
		retryPolicy: { maxAttempts: 2, retryableErrorKinds: ["timeout", "rate_limit"], fallbackProfileIds: [] },
		contextPolicy: { ...baseContext },
	},
	claude_plan_reviewer: {
		id: "claude_plan_reviewer",
		vendor: "anthropic",
		modelPattern: ["claude-sonnet-*", "claude-opus-*"],
		roles: ["plan_reviewer"],
		promptTemplate: "plan-reviewer",
		promptVersion: "1.0",
		toolPolicyId: "readonly-review",
		maxRequests: 50,
		maxRuntimeMs: 180_000,
		retryPolicy: { maxAttempts: 2, retryableErrorKinds: ["timeout"], fallbackProfileIds: ["gpt_plan_reviewer"] },
		contextPolicy: { ...baseContext, includeFullTranscript: false },
	},
	gpt_plan_reviewer: {
		id: "gpt_plan_reviewer",
		vendor: "openai",
		modelPattern: ["gpt-5.*", "o3*"],
		roles: ["plan_reviewer"],
		promptTemplate: "plan-reviewer",
		promptVersion: "1.0",
		toolPolicyId: "readonly-review",
		maxRequests: 50,
		maxRuntimeMs: 180_000,
		retryPolicy: { maxAttempts: 2, retryableErrorKinds: ["timeout"], fallbackProfileIds: [] },
		contextPolicy: { ...baseContext, includeFullTranscript: false },
	},
	grok_implementer: {
		id: "grok_implementer",
		vendor: "xai",
		modelPattern: ["grok-code-*", "grok-4*"],
		roles: ["implementer"],
		promptTemplate: "implementer",
		promptVersion: "1.0",
		toolPolicyId: "scoped-implementation",
		maxRequests: 200,
		maxRuntimeMs: 600_000,
		retryPolicy: { maxAttempts: 1, retryableErrorKinds: [], fallbackProfileIds: [] },
		contextPolicy: {
			includePlan: true,
			includeReviewFindings: false,
			includeVerification: true,
			includeFullTranscript: false,
			maxArtifactBytes: 1024 * 1024,
		},
	},
	claude_reviewer: {
		id: "claude_reviewer",
		vendor: "anthropic",
		modelPattern: ["claude-sonnet-*", "claude-opus-*"],
		roles: ["code_reviewer"],
		promptTemplate: "code-reviewer",
		promptVersion: "1.0",
		toolPolicyId: "readonly-review",
		maxRequests: 50,
		maxRuntimeMs: 180_000,
		retryPolicy: { maxAttempts: 2, retryableErrorKinds: ["timeout"], fallbackProfileIds: ["gpt_reviewer"] },
		contextPolicy: { ...baseContext, maxArtifactBytes: 2 * 1024 * 1024 },
	},
	gpt_reviewer: {
		id: "gpt_reviewer",
		vendor: "openai",
		modelPattern: ["gpt-5.*", "o3*"],
		roles: ["code_reviewer"],
		promptTemplate: "code-reviewer",
		promptVersion: "1.0",
		toolPolicyId: "readonly-review",
		maxRequests: 50,
		maxRuntimeMs: 180_000,
		retryPolicy: { maxAttempts: 2, retryableErrorKinds: ["timeout"], fallbackProfileIds: [] },
		contextPolicy: { ...baseContext, maxArtifactBytes: 2 * 1024 * 1024 },
	},
	grok_repair: {
		id: "grok_repair",
		vendor: "xai",
		modelPattern: ["grok-code-*", "grok-4*"],
		roles: ["repair"],
		promptTemplate: "repair",
		promptVersion: "1.0",
		toolPolicyId: "scoped-repair",
		maxRequests: 100,
		maxRuntimeMs: 300_000,
		retryPolicy: { maxAttempts: 1, retryableErrorKinds: [], fallbackProfileIds: ["claude_repair"] },
		contextPolicy: {
			includePlan: true,
			includeReviewFindings: true,
			includeVerification: true,
			includeFullTranscript: false,
			maxArtifactBytes: 1024 * 1024,
		},
	},
	claude_repair: {
		id: "claude_repair",
		vendor: "anthropic",
		modelPattern: ["claude-sonnet-*", "claude-opus-*"],
		roles: ["repair"],
		promptTemplate: "repair",
		promptVersion: "1.0",
		toolPolicyId: "scoped-repair",
		maxRequests: 50,
		maxRuntimeMs: 300_000,
		retryPolicy: { maxAttempts: 2, retryableErrorKinds: ["timeout"], fallbackProfileIds: ["gpt_repair"] },
		contextPolicy: {
			includePlan: true,
			includeReviewFindings: true,
			includeVerification: true,
			includeFullTranscript: false,
			maxArtifactBytes: 2 * 1024 * 1024,
		},
	},
	gpt_repair: {
		id: "gpt_repair",
		vendor: "openai",
		modelPattern: ["gpt-5.*", "o3*"],
		roles: ["repair"],
		promptTemplate: "repair",
		promptVersion: "1.0",
		toolPolicyId: "scoped-repair",
		maxRequests: 50,
		maxRuntimeMs: 300_000,
		retryPolicy: { maxAttempts: 2, retryableErrorKinds: ["timeout"], fallbackProfileIds: [] },
		contextPolicy: {
			includePlan: true,
			includeReviewFindings: true,
			includeVerification: true,
			includeFullTranscript: false,
			maxArtifactBytes: 2 * 1024 * 1024,
		},
	},
} satisfies Record<string, ModelProfile>;

/** Explicit config shape — never infer via ReturnType (AGENTS.md ban). */
export interface WorkflowDefaultConfig {
	enabled: boolean;
	defaultRole: "implementer";
	degradedMode: boolean;
	maxBudgetUsd: number;
	maxRepairCycles: number;
	maxPlanCycles: number;
	confidenceThreshold: number;
	requireIndependentReview: boolean;
	isolation: { merge: "patch" | "branch"; apply: boolean };
	verificationCommands: string[];
	forbiddenPaths: string[];
	profiles: typeof DEFAULT_MODEL_PROFILES;
}

export function getDefaultConfig(): WorkflowDefaultConfig {
	return {
		enabled: true,
		defaultRole: "implementer",
		degradedMode: false,
		maxBudgetUsd: 10,
		maxRepairCycles: 3,
		maxPlanCycles: 2,
		confidenceThreshold: 0.6,
		requireIndependentReview: true,
		isolation: { merge: "patch", apply: true },
		verificationCommands: ["bun test", "bun check"],
		forbiddenPaths: ["node_modules", "dist", "build", ".git"],
		profiles: DEFAULT_MODEL_PROFILES,
	};
}
