import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { DEFAULT_MODEL_OPTIMIZATION_PROFILES } from "../model-optimization/default-profiles";
import { DEFAULT_TRUNCATION_RULES } from "./tool-output-manager";
import type {
	ContextStrategy,
	ModelProfile,
	OutputStrategy,
	PromptStrategy,
	ToolStrategy,
	WorkflowQualityRoutes,
	WorkflowQualityTier,
} from "./types";

/** Models required by the quality-first per-model optimization design. */
export const TARGET_MODEL_PATTERNS = [
	"claude-sonnet-5",
	"claude-opus-5",
	"gpt-5.6-sol",
	"gpt-6-astra",
	"grok-4.6",
	"glm-5.2",
	"deepseek-v4-flash",
] as const;

export type TargetModelPattern = (typeof TARGET_MODEL_PATTERNS)[number];

const baseContext = {
	includePlan: true,
	includeReviewFindings: true,
	includeVerification: true,
	includeFullTranscript: false,
	maxArtifactBytes: 1024 * 1024,
} as const;

const conciseClaudePrompt: PromptStrategy = {
	...DEFAULT_MODEL_OPTIMIZATION_PROFILES.claude.promptStrategy,
	kind: "concise",
	// ponytail: few-shot bank not shipped — keep policy off so config does not pretend otherwise
	fewShotPolicy: { enabled: false, maxExamples: 1, dynamicSelection: false },
	thinkingPrompt: { enabled: true, style: "scratchpad" },
	roleEmphasis: "light",
	instructionFormat: "natural",
};

const structuredGptPrompt: PromptStrategy = {
	...DEFAULT_MODEL_OPTIMIZATION_PROFILES["gpt-5"].promptStrategy,
	kind: "structured",
	fewShotPolicy: { enabled: false, maxExamples: 2, dynamicSelection: false },
	roleEmphasis: "medium",
	instructionFormat: "numbered",
};

const explicitGrokPrompt: PromptStrategy = {
	...DEFAULT_MODEL_OPTIMIZATION_PROFILES.grok.promptStrategy,
	kind: "verbose",
	fewShotPolicy: { enabled: false, maxExamples: 3, dynamicSelection: false },
	thinkingPrompt: { enabled: true, style: "step-by-step" },
	roleEmphasis: "heavy",
	instructionFormat: "numbered",
};

const BASH_ERROR_PRESERVE = ["ERROR", "FAIL", "Exception", "Traceback"] as const;

function truncationRules(opts: {
	bashBytes: number;
	bashLines: number;
	readBytes: number;
	readLines: number;
	grepBytes: number;
	grepLines: number;
	starBytes: number;
	starLines: number;
}): NonNullable<ToolStrategy["outputTruncation"]> {
	return {
		enabled: true,
		rules: [
			{
				toolName: "bash",
				strategy: "smart",
				maxBytes: opts.bashBytes,
				maxLines: opts.bashLines,
				preservePatterns: [...BASH_ERROR_PRESERVE],
			},
			{ toolName: "read", strategy: "smart", maxBytes: opts.readBytes, maxLines: opts.readLines },
			{ toolName: "grep", strategy: "head", maxBytes: opts.grepBytes, maxLines: opts.grepLines },
			{ toolName: "*", strategy: "head", maxBytes: opts.starBytes, maxLines: opts.starLines },
		],
	};
}

const ORDINARY_TRUNCATION = truncationRules({
	bashBytes: 4000,
	bashLines: 80,
	readBytes: 8000,
	readLines: 160,
	grepBytes: 8000,
	grepLines: 120,
	starBytes: 4000,
	starLines: 80,
});

function conservativeTruncation(opts: {
	maxBytes: number;
	maxLines: number;
}): NonNullable<ToolStrategy["outputTruncation"]> {
	return truncationRules({
		bashBytes: opts.maxBytes,
		bashLines: opts.maxLines,
		readBytes: opts.maxBytes + 2000,
		readLines: opts.maxLines + 20,
		grepBytes: 3000,
		grepLines: 40,
		starBytes: Math.min(2000, opts.maxBytes),
		starLines: 50,
	});
}

function toolStrategy(opts?: {
	maxConcurrent?: number;
	aliases?: Record<string, string>;
	argAliases?: Record<string, Record<string, string>>;
	truncation?: NonNullable<ToolStrategy["outputTruncation"]>;
}): ToolStrategy {
	return {
		toolAliases: opts?.aliases,
		argumentAliases: opts?.argAliases,
		outputTruncation: opts?.truncation ?? ORDINARY_TRUNCATION,
		resultSummarization: { enabled: true, summarizerKeys: ["bash", "read", "grep", "ls", "test", "*"] },
		maxConcurrentTools: opts?.maxConcurrent ?? 8,
	};
}

function contextStrategy(opts: {
	targetUtilization: number;
	repoMap: boolean;
	maxFiles: number;
	keepRecentN: number;
	maxArtifactBytes?: number;
}): ContextStrategy {
	return {
		targetUtilization: opts.targetUtilization,
		repoMap: {
			enabled: opts.repoMap,
			maxFiles: opts.maxFiles,
			strategy: opts.repoMap ? "hybrid" : "full-content",
		},
		eviction: {
			enabled: true,
			preserveUserTurns: true,
			evictPersisted: true,
			keepRecentN: opts.keepRecentN,
		},
		artifactInclusion: {
			includePlan: true,
			includeReviewFindings: true,
			includeVerification: true,
			maxArtifactBytes: opts.maxArtifactBytes ?? 50_000,
		},
		toolHistory: { maxToolCalls: opts.keepRecentN, summarizeOld: true },
	};
}

const claudeOutput: OutputStrategy = {
	schemaEnhancement: { addDescriptions: true, addExamples: false, strictMode: false },
	retryOnSchemaViolation: { enabled: true, maxRetries: 2, includeErrorInRetry: true },
};

const gptOutput: OutputStrategy = {
	schemaEnhancement: { addDescriptions: false, addExamples: false, strictMode: true },
	retryOnSchemaViolation: { enabled: true, maxRetries: 1, includeErrorInRetry: false },
};

const grokOutput: OutputStrategy = {
	schemaEnhancement: { addDescriptions: true, addExamples: true, strictMode: false },
	outputPrefixPrompt: "Output valid JSON:",
	retryOnSchemaViolation: { enabled: true, maxRetries: 3, includeErrorInRetry: true },
};

/**
 * Quality-first default profiles.
 * Role matrix (design § quality-first):
 * - Planning / review: Opus 5 (xhigh), GPT-5.6-sol (primary), GLM as cost-aware fallback
 * - Implement: Grok 4.6 (relatively complex default), GPT-6-Astra (very complex, fallback Grok 4.6), DeepSeek-V4-Flash (mechanical only), then the session model (last resort)
 * - Simple repair: Grok; complex repair: Sol / Opus
 * - Sonnet/DeepSeek available but demoted for critical paths
 * - Exact model ids only — no wildcard fallback, silent model downgrade is forbidden
 *
 * Existing profile ids (claude_planner, grok_implementer, …) are preserved for engine tests.
 */
const WORKFLOW_MODEL_PROFILES = {
	// --- Quality-first primaries (registration order = router preference) ---
	claude_planner: {
		id: "claude_planner",
		vendor: "anthropic",
		modelPattern: ["claude-opus-5"],
		roles: ["planner"],
		promptTemplate: "planner",
		promptVersion: "1.0",
		thinkingLevel: ThinkingLevel.XHigh,
		toolPolicyId: "readonly-planning",
		promptStrategy: conciseClaudePrompt,
		toolStrategy: toolStrategy({ maxConcurrent: 8 }),
		contextStrategy: contextStrategy({
			targetUtilization: 0.75,
			repoMap: true,
			maxFiles: 12,
			keepRecentN: 10,
			maxArtifactBytes: 50_000,
		}),
		outputStrategy: claudeOutput,
		maxRequests: 50,
		maxRuntimeMs: 300_000,
		retryPolicy: {
			maxAttempts: 2,
			retryableErrorKinds: ["timeout", "rate_limit", "authentication", "provider_transient"],
			fallbackProfileIds: ["gpt_planner", "glm_planner"],
		},
		contextPolicy: { ...baseContext, maxArtifactBytes: 50_000 },
	},
	gpt_planner: {
		id: "gpt_planner",
		vendor: "openai",
		modelPattern: ["gpt-5.6-sol"],
		roles: ["planner"],
		promptTemplate: "planner",
		promptVersion: "1.0",
		toolPolicyId: "readonly-planning",
		promptStrategy: structuredGptPrompt,
		toolStrategy: toolStrategy({ maxConcurrent: 6 }),
		contextStrategy: contextStrategy({
			targetUtilization: 0.75,
			repoMap: true,
			maxFiles: 10,
			keepRecentN: 8,
			maxArtifactBytes: 25_000,
		}),
		outputStrategy: gptOutput,
		maxRequests: 50,
		maxRuntimeMs: 300_000,
		retryPolicy: {
			maxAttempts: 2,
			retryableErrorKinds: ["timeout", "rate_limit", "authentication", "provider_transient"],
			fallbackProfileIds: ["claude_planner"],
		},
		contextPolicy: { ...baseContext, maxArtifactBytes: 25_000 },
	},
	glm_planner: {
		id: "glm_planner",
		vendor: "zhipu",
		modelPattern: ["glm-5.2"],
		roles: ["planner"],
		promptTemplate: "planner",
		promptVersion: "1.0",
		toolPolicyId: "readonly-planning",
		promptStrategy: explicitGrokPrompt,
		toolStrategy: toolStrategy({ maxConcurrent: 6 }),
		contextStrategy: contextStrategy({
			targetUtilization: 0.75,
			repoMap: true,
			maxFiles: 10,
			keepRecentN: 8,
		}),
		outputStrategy: grokOutput,
		maxRequests: 50,
		maxRuntimeMs: 300_000,
		retryPolicy: {
			maxAttempts: 2,
			retryableErrorKinds: ["timeout", "provider_transient"],
			fallbackProfileIds: ["claude_planner"],
		},
		contextPolicy: { ...baseContext },
	},
	claude_plan_reviewer: {
		id: "claude_plan_reviewer",
		vendor: "anthropic",
		modelPattern: ["claude-opus-5"],
		roles: ["plan_reviewer"],
		promptTemplate: "plan-reviewer",
		promptVersion: "1.0",
		thinkingLevel: ThinkingLevel.Medium,
		toolPolicyId: "readonly-review",
		promptStrategy: conciseClaudePrompt,
		toolStrategy: toolStrategy(),
		contextStrategy: contextStrategy({
			targetUtilization: 0.75,
			repoMap: true,
			maxFiles: 10,
			keepRecentN: 8,
		}),
		outputStrategy: claudeOutput,
		maxRequests: 50,
		// Live gateways can be slow; 3m was aborting code/plan review mid-stream.
		maxRuntimeMs: 300_000,
		retryPolicy: {
			maxAttempts: 2,
			retryableErrorKinds: ["timeout", "authentication", "provider_transient"],
			fallbackProfileIds: ["gpt_plan_reviewer"],
		},
		contextPolicy: { ...baseContext, includeFullTranscript: false },
	},
	gpt_plan_reviewer: {
		id: "gpt_plan_reviewer",
		vendor: "openai",
		modelPattern: ["gpt-5.6-sol"],
		roles: ["plan_reviewer"],
		promptTemplate: "plan-reviewer",
		promptVersion: "1.0",
		thinkingLevel: ThinkingLevel.Medium,
		toolPolicyId: "readonly-review",
		promptStrategy: structuredGptPrompt,
		toolStrategy: toolStrategy(),
		contextStrategy: contextStrategy({
			targetUtilization: 0.75,
			repoMap: true,
			maxFiles: 10,
			keepRecentN: 8,
		}),
		outputStrategy: gptOutput,
		maxRequests: 50,
		maxRuntimeMs: 300_000,
		retryPolicy: {
			maxAttempts: 2,
			retryableErrorKinds: ["timeout", "authentication", "provider_transient"],
			fallbackProfileIds: [],
		},
		contextPolicy: { ...baseContext, includeFullTranscript: false },
	},
	// Implementation: Grok-4.6 first (relatively complex), then GPT-6-Astra (very complex), then DeepSeek-V4-Flash (mechanical)
	grok_implementer: {
		id: "grok_implementer",
		vendor: "xai",
		modelPattern: ["grok-4.6"],
		roles: ["implementer"],
		promptTemplate: "implementer",
		promptVersion: "1.0",
		thinkingLevel: ThinkingLevel.High,
		toolPolicyId: "scoped-implementation",
		promptStrategy: explicitGrokPrompt,
		toolStrategy: toolStrategy({
			maxConcurrent: 12,
			aliases: { bash: "run_command" },
			argAliases: { read: { path: "file_path" } },
		}),
		contextStrategy: contextStrategy({
			targetUtilization: 0.55,
			repoMap: false,
			maxFiles: 20,
			keepRecentN: 15,
			maxArtifactBytes: 80_000,
		}),
		outputStrategy: grokOutput,
		toolAliases: { bash: "run_command" },
		argumentAliases: { read: { path: "file_path" } },
		maxRequests: 200,
		maxRuntimeMs: 600_000,
		retryPolicy: {
			maxAttempts: 1,
			retryableErrorKinds: [],
			fallbackProfileIds: ["gpt_astra_implementer", "deepseek_implementer"],
		},
		contextPolicy: {
			includePlan: true,
			includeReviewFindings: false,
			includeVerification: true,
			includeFullTranscript: false,
			maxArtifactBytes: 1024 * 1024,
		},
	},
	gpt_astra_implementer: {
		id: "gpt_astra_implementer",
		vendor: "openai",
		modelPattern: ["gpt-6-astra"],
		roles: ["implementer"],
		thinkingLevel: ThinkingLevel.Max,
		promptTemplate: "implementer",
		promptVersion: "1.0",
		toolPolicyId: "scoped-implementation",
		promptStrategy: structuredGptPrompt,
		toolStrategy: toolStrategy({ maxConcurrent: 10 }),
		contextStrategy: contextStrategy({
			targetUtilization: 0.65,
			repoMap: false,
			maxFiles: 20,
			keepRecentN: 12,
		}),
		outputStrategy: gptOutput,
		maxRequests: 200,
		maxRuntimeMs: 600_000,
		retryPolicy: {
			maxAttempts: 2,
			retryableErrorKinds: ["provider_transient"],
			fallbackProfileIds: ["grok_implementer"],
		},
		contextPolicy: {
			includePlan: true,
			includeReviewFindings: false,
			includeVerification: true,
			includeFullTranscript: false,
			maxArtifactBytes: 2 * 1024 * 1024,
		},
	},
	deepseek_implementer: {
		id: "deepseek_implementer",
		vendor: "deepseek",
		modelPattern: ["deepseek-v4-flash"],
		roles: ["implementer"],
		promptTemplate: "implementer",
		promptVersion: "1.0",
		toolPolicyId: "scoped-implementation",
		// No family prompt overlay for DeepSeek — see model-optimization/default-profiles
		// (deepseek: "no Grok prompt inheritance"); keep prompt/output strategies off the grok style.
		toolStrategy: toolStrategy({
			maxConcurrent: 8,
			aliases: { bash: "run_command" },
			truncation: conservativeTruncation({ maxBytes: 3500, maxLines: 80 }),
		}),
		contextStrategy: contextStrategy({
			targetUtilization: 0.75,
			repoMap: true,
			maxFiles: 12,
			keepRecentN: 10,
		}),
		thinkingLevel: ThinkingLevel.Max,
		maxRequests: 200,
		maxRuntimeMs: 600_000,
		retryPolicy: {
			maxAttempts: 2,
			retryableErrorKinds: ["provider_transient", "timeout"],
			fallbackProfileIds: ["grok_implementer", "gpt_astra_implementer"],
		},
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
		modelPattern: ["claude-opus-5"],
		roles: ["code_reviewer"],
		promptTemplate: "code-reviewer",
		promptVersion: "1.0",
		thinkingLevel: ThinkingLevel.Medium,
		toolPolicyId: "readonly-review",
		promptStrategy: conciseClaudePrompt,
		toolStrategy: toolStrategy(),
		contextStrategy: contextStrategy({
			targetUtilization: 0.75,
			repoMap: true,
			maxFiles: 12,
			keepRecentN: 10,
			maxArtifactBytes: 60_000,
		}),
		outputStrategy: claudeOutput,
		maxRequests: 50,
		maxRuntimeMs: 300_000,
		retryPolicy: {
			maxAttempts: 2,
			retryableErrorKinds: ["timeout", "authentication", "provider_transient"],
			fallbackProfileIds: ["gpt_reviewer"],
		},
		contextPolicy: { ...baseContext, maxArtifactBytes: 2 * 1024 * 1024 },
	},
	gpt_reviewer: {
		id: "gpt_reviewer",
		vendor: "openai",
		modelPattern: ["gpt-5.6-sol", "gpt-5.6-terra"],
		roles: ["code_reviewer"],
		promptTemplate: "code-reviewer",
		promptVersion: "1.0",
		thinkingLevel: ThinkingLevel.Medium,
		toolPolicyId: "readonly-review",
		promptStrategy: structuredGptPrompt,
		toolStrategy: toolStrategy(),
		contextStrategy: contextStrategy({
			targetUtilization: 0.7,
			repoMap: true,
			maxFiles: 12,
			keepRecentN: 10,
		}),
		outputStrategy: gptOutput,
		maxRequests: 50,
		maxRuntimeMs: 300_000,
		retryPolicy: {
			maxAttempts: 2,
			retryableErrorKinds: ["timeout", "authentication", "provider_transient"],
			fallbackProfileIds: [],
		},
		contextPolicy: { ...baseContext, maxArtifactBytes: 2 * 1024 * 1024 },
	},
	// Mechanical Flash repair (latency role_static_split treatment target)
	flash_repair: {
		id: "flash_repair",
		vendor: "deepseek",
		modelPattern: ["deepseek-v4-flash"],
		roles: ["repair"],
		promptTemplate: "repair",
		promptVersion: "1.0",
		toolPolicyId: "scoped-repair",
		thinkingLevel: ThinkingLevel.Max,
		toolStrategy: toolStrategy({
			maxConcurrent: 8,
			aliases: { bash: "run_command" },
			truncation: conservativeTruncation({ maxBytes: 3500, maxLines: 80 }),
		}),
		contextStrategy: contextStrategy({
			targetUtilization: 0.75,
			repoMap: false,
			maxFiles: 12,
			keepRecentN: 10,
		}),
		maxRequests: 100,
		maxRuntimeMs: 300_000,
		retryPolicy: {
			maxAttempts: 1,
			retryableErrorKinds: ["provider_transient", "timeout"],
			fallbackProfileIds: ["grok_repair"],
		},
		contextPolicy: {
			includePlan: true,
			includeReviewFindings: true,
			includeVerification: true,
			includeFullTranscript: false,
			maxArtifactBytes: 1024 * 1024,
		},
	},
	// Plan arbitrator: xai/Grok lineage, distinct from author/reviewer
	grok_plan_arbitrator: {
		id: "grok_plan_arbitrator",
		vendor: "xai",
		modelPattern: ["grok-4.6"],
		roles: ["plan_arbitrator"],
		promptTemplate: "plan-reviewer",
		promptVersion: "1.0",
		toolPolicyId: "readonly-review",
		promptStrategy: explicitGrokPrompt,
		toolStrategy: toolStrategy(),
		contextStrategy: contextStrategy({
			targetUtilization: 0.55,
			repoMap: false,
			maxFiles: 12,
			keepRecentN: 10,
		}),
		outputStrategy: grokOutput,
		maxRequests: 20,
		maxRuntimeMs: 300_000,
		retryPolicy: {
			maxAttempts: 1,
			retryableErrorKinds: ["provider_transient"],
			fallbackProfileIds: [],
		},
		contextPolicy: { ...baseContext, includeFullTranscript: false },
	},
	// Simple repair: Grok first; complex repair router prefers anthropic/openai
	grok_repair: {
		id: "grok_repair",
		vendor: "xai",
		modelPattern: ["grok-4.6"],
		roles: ["repair"],
		promptTemplate: "repair",
		promptVersion: "1.0",
		toolPolicyId: "scoped-repair",
		promptStrategy: explicitGrokPrompt,
		toolStrategy: toolStrategy({ maxConcurrent: 10 }),
		contextStrategy: contextStrategy({
			targetUtilization: 0.55,
			repoMap: false,
			maxFiles: 15,
			keepRecentN: 12,
		}),
		outputStrategy: grokOutput,
		maxRequests: 100,
		maxRuntimeMs: 300_000,
		retryPolicy: {
			maxAttempts: 1,
			retryableErrorKinds: ["authentication", "provider_transient"],
			fallbackProfileIds: ["claude_repair"],
		},
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
		modelPattern: ["claude-opus-5"],
		roles: ["repair"],
		promptTemplate: "repair",
		promptVersion: "1.0",
		thinkingLevel: ThinkingLevel.XHigh,
		toolPolicyId: "scoped-repair",
		promptStrategy: conciseClaudePrompt,
		toolStrategy: toolStrategy(),
		contextStrategy: contextStrategy({
			targetUtilization: 0.7,
			repoMap: true,
			maxFiles: 12,
			keepRecentN: 10,
		}),
		outputStrategy: claudeOutput,
		maxRequests: 50,
		maxRuntimeMs: 300_000,
		retryPolicy: {
			maxAttempts: 2,
			retryableErrorKinds: ["timeout", "authentication", "provider_transient"],
			fallbackProfileIds: ["gpt_repair"],
		},
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
		modelPattern: ["gpt-5.6-sol", "gpt-5.6-terra"],
		roles: ["repair"],
		promptTemplate: "repair",
		promptVersion: "1.0",
		toolPolicyId: "scoped-repair",
		promptStrategy: structuredGptPrompt,
		toolStrategy: toolStrategy(),
		contextStrategy: contextStrategy({
			targetUtilization: 0.7,
			repoMap: true,
			maxFiles: 12,
			keepRecentN: 10,
		}),
		outputStrategy: gptOutput,
		maxRequests: 50,
		maxRuntimeMs: 300_000,
		retryPolicy: {
			maxAttempts: 2,
			retryableErrorKinds: ["timeout", "authentication", "provider_transient"],
			fallbackProfileIds: [],
		},
		contextPolicy: {
			includePlan: true,
			includeReviewFindings: true,
			includeVerification: true,
			includeFullTranscript: false,
			maxArtifactBytes: 2 * 1024 * 1024,
		},
	},
	// Demoted / bulk-only profiles (still registered so patterns resolve)
	claude_sonnet_bulk: {
		id: "claude_sonnet_bulk",
		vendor: "anthropic",
		modelPattern: ["claude-sonnet-5"],
		roles: ["repair"],
		promptTemplate: "repair",
		promptVersion: "1.0",
		toolPolicyId: "scoped-repair",
		promptStrategy: { ...conciseClaudePrompt, roleEmphasis: "medium" },
		toolStrategy: toolStrategy({
			maxConcurrent: 4,
			truncation: conservativeTruncation({ maxBytes: 2000, maxLines: 40 }),
		}),
		contextStrategy: contextStrategy({
			targetUtilization: 0.8,
			repoMap: true,
			maxFiles: 6,
			keepRecentN: 5,
			maxArtifactBytes: 15_000,
		}),
		outputStrategy: claudeOutput,
		maxRequests: 80,
		maxRuntimeMs: 180_000,
		retryPolicy: {
			maxAttempts: 2,
			retryableErrorKinds: ["provider_transient"],
			fallbackProfileIds: ["claude_repair"],
		},
		contextPolicy: { ...baseContext, maxArtifactBytes: 30_000 },
	},
	claude_opus_long_context: {
		id: "claude_opus_long_context",
		vendor: "anthropic",
		modelPattern: ["claude-opus-5"],
		roles: ["planner", "code_reviewer"],
		promptTemplate: "planner",
		promptVersion: "1.0",
		toolPolicyId: "readonly-planning",
		promptStrategy: conciseClaudePrompt,
		toolStrategy: toolStrategy({ maxConcurrent: 10 }),
		contextStrategy: contextStrategy({
			targetUtilization: 0.65,
			repoMap: false,
			maxFiles: 20,
			keepRecentN: 15,
			maxArtifactBytes: 60_000,
		}),
		outputStrategy: claudeOutput,
		maxRequests: 30,
		maxRuntimeMs: 600_000,
		retryPolicy: {
			maxAttempts: 2,
			retryableErrorKinds: ["provider_transient", "timeout"],
			fallbackProfileIds: ["claude_planner"],
		},
		contextPolicy: { ...baseContext, maxArtifactBytes: 60_000 },
	},
} satisfies Record<string, ModelProfile>;

const OPTIMIZATION_PROFILE_BY_VENDOR: Record<string, string> = {
	anthropic: "claude",
	openai: "gpt-5",
	xai: "grok",
	zhipu: "glm",
	deepseek: "deepseek",
};

export const DEFAULT_MODEL_PROFILES: Record<string, ModelProfile> = {};
for (const [id, profile] of Object.entries(WORKFLOW_MODEL_PROFILES)) {
	const optimizationProfileId = OPTIMIZATION_PROFILE_BY_VENDOR[profile.vendor];
	DEFAULT_MODEL_PROFILES[id] = {
		...profile,
		...(optimizationProfileId ? { optimizationProfileId } : {}),
	};
}

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
	defaultQualityTier: WorkflowQualityTier;
	qualityRoutes: WorkflowQualityRoutes;
	isolation: { merge: "patch" | "branch"; apply: boolean };
	/** Hard timeout for each verification command (ms). */
	verificationTimeoutMs: number;
	verificationCommands: string[];
	forbiddenPaths: string[];
	profiles: typeof DEFAULT_MODEL_PROFILES | Record<string, ModelProfile>;
	/**
	 * Settings gate for lazy tool/skill presentation. Default false.
	 * Profiles keep presentationPolicy.enabled = false; only enable after quality holds.
	 */
	presentationOptimizationEnabled: boolean;
	/** DevFlow overlay knobs. Not a new role profile. */
	pipelineOverlay: {
		kindDefault: "off";
		auditorModel: "deepseek-v4-flash";
		maxGrillQuestions: number;
		maxPlanningCompletenessRetries: number;
	};
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
		defaultQualityTier: "balanced",
		qualityRoutes: {},
		isolation: { merge: "patch", apply: true },
		verificationTimeoutMs: 120_000,
		// Prefer trusted repo checks + focused commands; full `bun test` is opt-in via settings.
		verificationCommands: ["git diff --check", "bun check"],
		forbiddenPaths: ["node_modules", "dist", "build", ".git"],
		profiles: DEFAULT_MODEL_PROFILES,
		presentationOptimizationEnabled: false,
		pipelineOverlay: {
			kindDefault: "off",
			auditorModel: "deepseek-v4-flash",
			maxGrillQuestions: 8,
			maxPlanningCompletenessRetries: 2,
		},
	};
}

/** Whether every required model pattern appears in at least one default profile. */
export function defaultProfilesCoverTargetModels(profiles: Record<string, ModelProfile> = DEFAULT_MODEL_PROFILES): {
	ok: boolean;
	missing: string[];
} {
	const patterns = Object.values(profiles).flatMap(p =>
		Array.isArray(p.modelPattern) ? p.modelPattern : [p.modelPattern],
	);
	const missing = TARGET_MODEL_PATTERNS.filter(
		target => !patterns.some(p => p === target || p.includes(target) || target.includes(p.replace(/\*$/, ""))),
	);
	return { ok: missing.length === 0, missing: [...missing] };
}

export { DEFAULT_TRUNCATION_RULES };
