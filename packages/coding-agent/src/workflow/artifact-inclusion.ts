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
 * Resolve include flags: contextStrategy.artifactInclusion wins when set;
 * otherwise fall back to contextPolicy (compat surface).
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
