/**
 * Workflow-neutral model optimization types.
 * Shared by ordinary coding-agent sessions and workflow bindings.
 * Workflow-only orchestration (roles, budgets, schema, presentation) lives elsewhere.
 */

import type { ToolSchedulingConfig } from "@oh-my-pi/pi-agent-core";

export type TruncationStrategy = "head" | "tail" | "smart" | "none";

export interface ToolOutputTruncationRule {
	toolName: string | string[];
	strategy: TruncationStrategy;
	maxBytes?: number;
	maxLines?: number;
	preservePatterns?: string[];
}

/** Model-native prompt shaping for ordinary sessions (no workflow role/schema). */
export interface SessionPromptStrategy {
	kind: "verbose" | "concise" | "structured" | "custom";
	/** Static template id keyed in model-optimization/prompts. */
	systemPromptTemplate?: string;
	thinkingPrompt?: {
		enabled: boolean;
		style: "step-by-step" | "scratchpad" | "none";
	};
	instructionFormat?: "natural" | "numbered" | "xml-tagged";
}

/** Safe shared tool strategies for ordinary sessions (no aliases / budgets / allowlists). */
export interface SessionToolStrategy {
	outputTruncation?: {
		enabled: boolean;
		rules: ToolOutputTruncationRule[];
	};
	resultSummarization?: {
		enabled: boolean;
		summarizerKeys?: string[];
	};
	maxConcurrentTools?: number;
	resourceConflictMode?: "serialize" | "fail" | "conservative" | "permissive";
}

/** Provider-derived context policy only; never mutates persisted transcript. */
export interface SessionContextStrategy {
	targetUtilization?: number;
	eviction?: {
		enabled: boolean;
		/** Forced true for ordinary sessions. */
		preserveUserTurns: true;
		/** Forced false for ordinary sessions. */
		evictPersisted: false;
		keepRecentN: number;
	};
	toolHistory?: {
		maxToolCalls: number;
		summarizeOld: boolean;
	};
}

export interface ModelOptimizationProfile {
	id: string;
	modelPattern: string | string[];
	priority?: number;
	promptStrategy?: SessionPromptStrategy;
	toolStrategy?: SessionToolStrategy;
	contextStrategy?: SessionContextStrategy;
}

/** Fully resolved runtime policy for the active model (or cleared none). */
export interface ResolvedModelOptimization {
	profile?: ModelOptimizationProfile;
	/** Independent system-prompt block; empty when no profile / no template. */
	promptBlock?: string;
	/** Content fingerprint for cache invalidation. */
	promptBlockFingerprint?: string;
	toolScheduling?: ToolSchedulingConfig;
	contextStrategy?: SessionContextStrategy;
}
