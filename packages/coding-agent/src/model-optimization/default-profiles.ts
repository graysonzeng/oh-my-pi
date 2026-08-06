/**
 * Built-in ordinary-session model optimization profiles.
 * Family-level only — never derived from workflow role profiles (gpt_planner, etc.).
 */

import { DEFAULT_TRUNCATION_RULES } from "../workflow/tool-output-manager";
import {
	CONTEXT_BUDGET_CANDIDATE_VERSION,
	type ModelOptimizationProfile,
	type SessionContextStrategy,
	type SessionToolStrategy,
} from "./types";

function toolStrategy(opts?: { maxBytes?: number; maxLines?: number; maxConcurrent?: number }): SessionToolStrategy {
	const maxBytes = opts?.maxBytes ?? 4000;
	const maxLines = opts?.maxLines ?? 80;
	return {
		outputTruncation: {
			enabled: true,
			rules: [
				{
					toolName: "bash",
					strategy: "smart",
					maxBytes,
					maxLines,
					preservePatterns: ["ERROR", "FAIL", "Exception", "Traceback"],
				},
				{ toolName: "read", strategy: "smart", maxBytes: maxBytes + 2000, maxLines: maxLines + 20 },
				{ toolName: "grep", strategy: "head", maxBytes: 3000, maxLines: 40 },
				{ toolName: "*", strategy: "head", maxBytes: Math.min(2000, maxBytes), maxLines: 50 },
			],
		},
		// P3 keeps LLM summarizer off; deterministic truncation remains available.
		// Explicit user profile overrides may re-enable summarization.
		resultSummarization: { enabled: false, summarizerKeys: ["bash", "read", "grep", "ls", "test", "*"] },
		maxConcurrentTools: opts?.maxConcurrent ?? 8,
		resourceConflictMode: "serialize",
	};
}

function contextStrategy(opts: { targetUtilization: number; keepRecentN: number }): SessionContextStrategy {
	return {
		targetUtilization: opts.targetUtilization,
		eviction: {
			enabled: true,
			preserveUserTurns: true,
			evictPersisted: false,
			keepRecentN: opts.keepRecentN,
		},
		toolHistory: { maxToolCalls: opts.keepRecentN, summarizeOld: true },
	};
}

/**
 * Built-in profiles keyed by id. Patterns intentionally cover families, not workflow roles.
 * Priority is equal by default; more specific user overrides win by higher priority.
 */
export const DEFAULT_MODEL_OPTIMIZATION_PROFILES: Record<string, ModelOptimizationProfile> = {
	claude: {
		id: "claude",
		modelPattern: ["claude-*", "anthropic/*"],
		priority: 0,
		promptStrategy: {
			kind: "concise",
			systemPromptTemplate: "concise-claude",
			thinkingPrompt: { enabled: true, style: "scratchpad" },
			instructionFormat: "natural",
		},
		toolStrategy: toolStrategy({ maxBytes: 4000, maxConcurrent: 8 }),
		contextStrategy: contextStrategy({ targetUtilization: 0.75, keepRecentN: 12 }),
	},
	"gpt-5": {
		id: "gpt-5",
		modelPattern: ["gpt-5*", "openai/gpt-5*", "o3*", "o4*", "codex*"],
		priority: 0,
		promptStrategy: {
			kind: "structured",
			systemPromptTemplate: "structured-gpt",
			instructionFormat: "numbered",
		},
		toolStrategy: toolStrategy({ maxBytes: 3000, maxConcurrent: 6 }),
		contextStrategy: contextStrategy({ targetUtilization: 0.75, keepRecentN: 10 }),
	},
	grok: {
		id: "grok",
		// Cover bare ids, xai provider ids, and gateway-prefixed host ids.
		modelPattern: ["grok-*", "xai/*", "gateway/grok*", "*grok*"],
		priority: 0,
		promptStrategy: {
			kind: "verbose",
			systemPromptTemplate: "explicit-grok",
			thinkingPrompt: { enabled: true, style: "step-by-step" },
			instructionFormat: "numbered",
		},
		toolStrategy: toolStrategy({ maxBytes: 3000, maxConcurrent: 6 }),
		contextStrategy: contextStrategy({ targetUtilization: 0.7, keepRecentN: 10 }),
	},
	glm: {
		id: "glm",
		modelPattern: ["glm-*", "zhipu/*"],
		priority: 0,
		// No family prompt overlay until GLM-specific live ablation passes.
		// Do not inherit explicit-grok / step-by-step.
		toolStrategy: toolStrategy({ maxBytes: 3000, maxConcurrent: 6 }),
		contextStrategy: contextStrategy({ targetUtilization: 0.7, keepRecentN: 10 }),
	},
	deepseek: {
		id: "deepseek",
		modelPattern: ["deepseek-*", "deepseek/*"],
		priority: 0,
		// Shared baseline only; no Grok prompt inheritance or guessed step-by-step.
		toolStrategy: toolStrategy({ maxBytes: 1500, maxLines: 30, maxConcurrent: 3 }),
		contextStrategy: contextStrategy({ targetUtilization: 0.8, keepRecentN: 5 }),
	},
	// Gateway production ids also match the broad gpt-5* family. Raise priority
	// so enabled=true resolves a concrete profile instead of failing closed on
	// equal-priority ambiguity, and so luna/terra/sol are not silent no-ops.
	// Patterns stay model-id specific (`*sol*` alone would match console/resolve).
	luna: {
		id: "luna",
		modelPattern: ["*luna*", "gpt-5.6-luna", "gateway/gpt-5.6-luna", "gpt-5.6-luna*"],
		priority: 10,
		// Conservative deterministic truncation only; no family prompt overlay.
		toolStrategy: toolStrategy({ maxBytes: 3000, maxConcurrent: 6 }),
		contextStrategy: contextStrategy({ targetUtilization: 0.75, keepRecentN: 10 }),
		contextBudgetCandidate: {
			version: CONTEXT_BUDGET_CANDIDATE_VERSION,
			targetUtilization: 0.7,
			keepRecentN: 8,
			maxToolCalls: 8,
		},
	},
	terra: {
		id: "terra",
		modelPattern: ["*terra*", "gpt-5.6-terra", "gateway/gpt-5.6-terra", "gpt-5.6-terra*"],
		priority: 10,
		toolStrategy: toolStrategy({ maxBytes: 3000, maxConcurrent: 6 }),
		contextStrategy: contextStrategy({ targetUtilization: 0.75, keepRecentN: 10 }),
	},
	sol: {
		id: "sol",
		modelPattern: ["gpt-5.6-sol", "gpt-5.6-sol*", "gateway/gpt-5.6-sol", "gateway/gpt-5.6-sol*", "*-sol", "*-sol-*"],
		priority: 10,
		// More conservative visible tool output for the slow/review class.
		toolStrategy: toolStrategy({ maxBytes: 2000, maxLines: 40, maxConcurrent: 4 }),
		contextStrategy: contextStrategy({ targetUtilization: 0.7, keepRecentN: 8 }),
	},
};

/** Fallback truncation rules when a profile has none (should not happen for built-ins). */
export const FALLBACK_TRUNCATION_RULES = DEFAULT_TRUNCATION_RULES;

export function listDefaultModelOptimizationProfiles(): ModelOptimizationProfile[] {
	return Object.values(DEFAULT_MODEL_OPTIMIZATION_PROFILES);
}
