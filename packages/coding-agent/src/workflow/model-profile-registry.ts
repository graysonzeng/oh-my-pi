import { DEFAULT_MODEL_OPTIMIZATION_PROFILES } from "../model-optimization/default-profiles";
import type { ModelOptimizationProfile } from "../model-optimization/types";
import { WorkflowPolicyError } from "./errors";
import type { ContextStrategy, ModelProfile, PromptStrategy, ToolStrategy } from "./types";

/**
 * Fields accepted on ModelProfile but not yet wired through the structured runner.
 * toolAliases / argumentAliases are supported via schema-enhancer transforms — not rejected.
 */
const UNSUPPORTED_RUNTIME_FIELDS = ["maxInputTokens", "maxOutputTokens"] as const;

/**
 * Normalize a model profile for workflow use.
 * Legacy `runtime` (codex_cli / claude_cli / embedded) is rejected — multi-model is
 * embedded only via provider models + profile strategies.
 */
function referencedOptimization(profile: ModelProfile): ModelOptimizationProfile | undefined {
	const reference = profile.optimizationProfileId;
	if (!reference) return undefined;
	const optimization = DEFAULT_MODEL_OPTIMIZATION_PROFILES[reference];
	if (!optimization) {
		throw new WorkflowPolicyError("unknown_model_optimization_profile", {
			profileId: profile.id,
			optimizationProfileId: reference,
		});
	}
	return optimization;
}

function workflowContextStrategy(optimization: ModelOptimizationProfile | undefined): ContextStrategy | undefined {
	const strategy = optimization?.contextStrategy;
	if (!strategy || strategy.targetUtilization === undefined) return undefined;
	return {
		targetUtilization: strategy.targetUtilization,
		eviction: strategy.eviction,
		toolHistory: strategy.toolHistory,
	};
}

function workflowPromptStrategy(optimization: ModelOptimizationProfile | undefined): PromptStrategy | undefined {
	return optimization?.promptStrategy ? { ...optimization.promptStrategy } : undefined;
}

function workflowToolStrategy(optimization: ModelOptimizationProfile | undefined): ToolStrategy | undefined {
	return optimization?.toolStrategy ? { ...optimization.toolStrategy } : undefined;
}

export function normalizeModelProfile(profile: ModelProfile): ModelProfile {
	// Settings/JSON may still carry removed field; fail closed at the trust boundary.
	const legacy = profile as ModelProfile & { runtime?: unknown };
	if (legacy.runtime !== undefined) {
		throw new WorkflowPolicyError("workflow_cli_runtime_removed", {
			profileId: profile.id,
			hint: "Multi-model workflows use embedded RuntimeAdapter + omp provider models only; remove profile.runtime (codex_cli/claude_cli backends removed)",
		});
	}
	const optimization = referencedOptimization(profile);
	if (!optimization) return profile;
	const promptStrategy = workflowPromptStrategy(optimization);
	const toolStrategy = workflowToolStrategy(optimization);
	const contextStrategy = workflowContextStrategy(optimization);
	const mergedPromptStrategy = profile.promptStrategy
		? { ...promptStrategy, ...profile.promptStrategy }
		: promptStrategy;
	const mergedContextStrategy = profile.contextStrategy
		? { ...contextStrategy, ...profile.contextStrategy }
		: contextStrategy;
	return {
		...profile,
		promptStrategy: mergedPromptStrategy,
		toolStrategy: toolStrategy || profile.toolStrategy ? { ...toolStrategy, ...profile.toolStrategy } : undefined,
		contextStrategy: mergedContextStrategy,
	};
}

/**
 * Reject profile fields the task/structured-subagent runtime cannot honor.
 * Supported mappings today: thinkingLevel, disabledTools, maxRuntimeMs, contextPolicy, modelPattern, strategies.
 */
export function assertSupportedModelProfile(profile: ModelProfile): void {
	for (const field of UNSUPPORTED_RUNTIME_FIELDS) {
		if (profile[field] !== undefined) {
			throw new WorkflowPolicyError("unsupported_model_profile_field", {
				profileId: profile.id,
				field,
				hint: "Remove unsupported fields or map them through the structured-subagent API first",
			});
		}
	}
	// Surface removed runtime field; do not require callers to pre-normalize.
	normalizeModelProfile(profile);
}

export class ModelProfileRegistry {
	readonly #profiles = new Map<string, ModelProfile>();

	constructor(profiles: Iterable<ModelProfile> = []) {
		for (const profile of profiles) this.register(profile);
	}

	register(profile: ModelProfile): void {
		const normalized = normalizeModelProfile(profile);
		assertSupportedModelProfile(normalized);
		this.#profiles.set(normalized.id, normalized);
	}

	get(id: string): ModelProfile | undefined {
		return this.#profiles.get(id);
	}

	list(): ModelProfile[] {
		return [...this.#profiles.values()];
	}
}
