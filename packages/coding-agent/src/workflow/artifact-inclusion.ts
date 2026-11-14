import type { ContextStrategy, ModelProfile } from "./types";

/** Resolved artifact inclusion for stage context builders. */
export interface ResolvedArtifactInclusion {
	includePlan: boolean;
	includeReviewFindings: boolean;
	includeVerification: boolean;
	includeFullTranscript: boolean;
	maxArtifactBytes: number;
}

/**
 * Resolve include flags from the dual budget surfaces on a model profile.
 *
 * ## Dual-field override rules (behavior unchanged — documentation only)
 *
 * Profiles carry two related surfaces that can disagree in defaults:
 *
 * 1. `contextPolicy` — legacy / compat budget surface (always required for
 *    profile validation unless `contextStrategy.artifactInclusion` is present).
 * 2. `contextStrategy.artifactInclusion` — preferred strategy surface used by
 *    stage context builders when set.
 *
 * Per-field precedence in {@link resolveArtifactInclusion}:
 * - `includePlan` / `includeReviewFindings` / `includeVerification` /
 *   `maxArtifactBytes`: `contextStrategy.artifactInclusion.<field>` wins when
 *   that property is defined; otherwise `contextPolicy.<field>`.
 * - `includeFullTranscript`: **only** `contextPolicy` (strategy has no twin).
 *
 * Example: `grok_implementer` ships `contextPolicy.maxArtifactBytes = 1 MiB`
 * and `contextStrategy.artifactInclusion.maxArtifactBytes = 80_000`. Effective
 * runtime budget is **80_000** (strategy wins). Do not read the 1 MiB policy
 * field alone when reasoning about inclusion caps.
 *
 * This helper does **not** change thresholds or quotas — it only documents and
 * centralizes the existing parse precedence.
 *
 * See design §6.2.
 */
export function resolveArtifactInclusion(
	profile: Pick<ModelProfile, "contextPolicy" | "contextStrategy">,
): ResolvedArtifactInclusion {
	const policy = profile.contextPolicy;
	const art = profile.contextStrategy?.artifactInclusion;
	return {
		includePlan: art?.includePlan ?? policy.includePlan,
		includeReviewFindings: art?.includeReviewFindings ?? policy.includeReviewFindings,
		includeVerification: art?.includeVerification ?? policy.includeVerification,
		includeFullTranscript: policy.includeFullTranscript,
		maxArtifactBytes: art?.maxArtifactBytes ?? policy.maxArtifactBytes,
	};
}

/** Effective context strategy with toolHistory.maxToolCalls tightening keepRecentN. */
export function withToolHistoryEviction(strategy: ContextStrategy | undefined): ContextStrategy | undefined {
	if (!strategy?.eviction?.enabled) return strategy;
	const maxTools = strategy.toolHistory?.maxToolCalls;
	if (maxTools === undefined || maxTools <= 0) return strategy;
	const keepRecentN = Math.min(strategy.eviction.keepRecentN, maxTools);
	if (keepRecentN === strategy.eviction.keepRecentN) return strategy;
	return {
		...strategy,
		eviction: { ...strategy.eviction, keepRecentN },
	};
}
