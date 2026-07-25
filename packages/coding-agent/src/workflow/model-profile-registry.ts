import { WorkflowPolicyError } from "./errors";
import type { ModelProfile } from "./types";

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
export function normalizeModelProfile(profile: ModelProfile): ModelProfile {
	// Settings/JSON may still carry removed field; fail closed at the trust boundary.
	const legacy = profile as ModelProfile & { runtime?: unknown };
	if (legacy.runtime !== undefined) {
		throw new WorkflowPolicyError("workflow_cli_runtime_removed", {
			profileId: profile.id,
			hint: "Multi-model workflows use embedded RuntimeAdapter + omp provider models only; remove profile.runtime (codex_cli/claude_cli backends removed)",
		});
	}
	return profile;
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
