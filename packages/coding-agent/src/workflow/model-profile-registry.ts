import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModelReferenceIndex, modelFamilyToken, resolveModelReference } from "@oh-my-pi/pi-catalog/identity";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { parseModelString } from "../config/model-resolver";
import { DEFAULT_MODEL_OPTIMIZATION_PROFILES } from "../model-optimization/default-profiles";
import type { ModelOptimizationProfile } from "../model-optimization/types";
import { WorkflowPolicyError } from "./errors";
import type {
	ConfiguredModelIdentityV1,
	ContextStrategy,
	ModelProfile,
	PromptStrategy,
	ToolStrategy,
} from "./types";

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

const MODEL_SELECTOR_META = /[*?[\]{}]/;

function exactConfiguredModel(profile: ModelProfile): { provider: string; model: string } | undefined {
	if (Array.isArray(profile.modelPattern) || MODEL_SELECTOR_META.test(profile.modelPattern)) return undefined;
	const parsed = parseModelString(profile.modelPattern);
	if (!parsed || parsed.thinkingLevel !== undefined) return undefined;
	return { provider: parsed.provider, model: parsed.id };
}

function validateConfiguredEffort(
	profile: ModelProfile,
	identity: { provider: string; model: string } | undefined,
): void {
	const effort = profile.thinkingLevel;
	if (effort === undefined) return;
	if (effort === "auto" || !THINKING_EFFORTS.includes(effort)) {
		throw new WorkflowPolicyError("invalid_model_profile_effort", {
			profileId: profile.id,
			effort,
			hint: "Strict workflow profiles require one concrete supported effort",
		});
	}
	if (!identity) return;
	const knownModel =
		getBundledModel(identity.provider, identity.model) ??
		resolveModelReference(identity.model, getBundledModelReferenceIndex());
	if (knownModel && !getSupportedEfforts(knownModel).includes(effort)) {
		throw new WorkflowPolicyError("unsupported_model_profile_effort", {
			profileId: profile.id,
			modelPattern: profile.modelPattern,
			effort,
			supportedEfforts: getSupportedEfforts(knownModel),
		});
	}
}

export function configuredIdentityForProfile(profile: ModelProfile): ConfiguredModelIdentityV1 {
	const identity = exactConfiguredModel(profile);
	if (!identity) {
		throw new WorkflowPolicyError("strict_model_profile_requires_exact_identity", {
			profileId: profile.id,
			modelPattern: profile.modelPattern,
			hint: "Use one exact provider/model id without glob or effort suffix",
		});
	}
	if (profile.thinkingLevel === undefined || profile.thinkingLevel === "auto") {
		throw new WorkflowPolicyError("strict_model_profile_requires_exact_effort", {
			profileId: profile.id,
			thinkingLevel: profile.thinkingLevel ?? null,
		});
	}
	const lineage = modelFamilyToken(identity.model);
	if (!lineage) {
		throw new WorkflowPolicyError("strict_model_profile_lineage_unknown", {
			profileId: profile.id,
			modelPattern: profile.modelPattern,
		});
	}
	if (profile.vendor !== lineage) {
		throw new WorkflowPolicyError("known_model_lineage_mismatch", {
			profileId: profile.id,
			declaredVendor: profile.vendor,
			derivedLineage: lineage,
		});
	}
	validateConfiguredEffort(profile, identity);
	return {
		profileId: profile.id,
		provider: identity.provider,
		model: identity.model,
		checkpoint: null,
		provenance: "configured",
		modelPattern: profile.modelPattern as string,
		requestedEffort: profile.thinkingLevel,
		modelFamily: lineage,
	};
}

function validateModelProfileIdentity(profile: ModelProfile): void {
	if (profile.strictIdentity !== undefined && typeof profile.strictIdentity !== "boolean") {
		throw new WorkflowPolicyError("invalid_strict_identity_policy", { profileId: profile.id });
	}
	const identity = exactConfiguredModel(profile);
	validateConfiguredEffort(profile, identity);
	if (profile.strictIdentity) configuredIdentityForProfile(profile);
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
	const promptStrategy = workflowPromptStrategy(optimization);
	const toolStrategy = workflowToolStrategy(optimization);
	const contextStrategy = workflowContextStrategy(optimization);
	const mergedPromptStrategy = profile.promptStrategy
		? { ...promptStrategy, ...profile.promptStrategy }
		: promptStrategy;
	const mergedContextStrategy = profile.contextStrategy
		? { ...contextStrategy, ...profile.contextStrategy }
		: contextStrategy;
	const normalized: ModelProfile = optimization
		? {
				...profile,
				promptStrategy: mergedPromptStrategy,
				toolStrategy: toolStrategy || profile.toolStrategy ? { ...toolStrategy, ...profile.toolStrategy } : undefined,
				contextStrategy: mergedContextStrategy,
			}
		: profile;
	validateModelProfileIdentity(normalized);
	return normalized;
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
