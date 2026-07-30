import type {
	ActiveModelPolicyLever,
	CompiledModelPolicyReceiptV1,
	CompiledModelPolicyV1,
	ModelFactsV1,
} from "../model-policy/types";

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
	/**
	 * Shadow/active capability-compiled policy for the active model.
	 * Profile execution results remain authoritative until compilerActive is true.
	 */
	compiledPolicy?: CompiledModelPolicyV1;
	/** Deterministic receipt for compiled policy (observability + A/B). */
	compiledReceipt?: CompiledModelPolicyReceiptV1;
	/** Facts used for the shadow/active compile. */
	compiledModelFacts?: ModelFactsV1;
	/** True only when featureGates.compilerActive applied compiled levers to live seams. */
	compilerActive?: boolean;
	activeLever?: ActiveModelPolicyLever;
}

/** Descriptor placement for Gemini auto refresh + explicit on/off. */
export type DescriptorPlacementDecision = "system_inline" | "provider_schema";

/** Applied ordinary-session levers for decision receipts. */
export interface OrdinaryAppliedFields {
	promptBlock: boolean;
	toolScheduling: boolean;
	outputTruncation: boolean;
	resultSummarization: boolean;
	contextStrategy: boolean;
	descriptorPlacement: DescriptorPlacementDecision;
}

export const ORDINARY_DECISION_RECEIPT_KIND = "ordinary_model_decision_receipt" as const;
export const ORDINARY_DECISION_RECEIPT_VERSION = 1 as const;

/**
 * Versioned ordinary-session decision receipt.
 * Complements ToolOptimizationReceiptV1 (lossy transform bytes) with active
 * model/profile/applied levers/descriptor/context decisions.
 */
export interface OrdinaryDecisionReceiptV1 {
	schemaVersion: typeof ORDINARY_DECISION_RECEIPT_VERSION;
	kind: typeof ORDINARY_DECISION_RECEIPT_KIND;
	createdAt: string;
	provider?: string;
	model?: string;
	profileId?: string;
	applied: OrdinaryAppliedFields;
	/** Present when a tool-output transform receipt was also produced. */
	toolCallId?: string;
	tool?: string;
	toolTransform?: string;
	originalBytes?: number;
	visibleBytes?: number;
	recoveryUri?: string;
	/** Context strategy decision for provider-only view (never mutates transcript). */
	contextDecision?: {
		targetUtilization?: number;
		toolHistoryMaxToolCalls?: number;
		providerViewOnly: true;
	};
}
