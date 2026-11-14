/**
 * Quality gate for per-model optimization.
 * If optimized quality drops more than QUALITY_DROP_THRESHOLD vs baseline, roll back to quality-priority config.
 */

export const QUALITY_DROP_THRESHOLD = 0.03; // 3%

export interface QualityMetrics {
	/** Task pass rate 0–1 (or any comparable quality score normalized to 0–1). */
	passRate: number;
	/** Optional mean quality score 0–10 (mapped for drop checks). */
	qualityScore?: number;
	/** Aggregate token usage for the suite. */
	totalTokens?: number;
	/** Aggregate cost if available. */
	totalCostUsd?: number;
}

export type QualityGateDecision = "accept" | "rollback";

export interface QualityGateResult {
	decision: QualityGateDecision;
	/** Absolute pass-rate drop (baseline - optimized), never negative when improved. */
	passRateDrop: number;
	/** Absolute quality-score drop on 0–1 scale if both scores present. */
	qualityScoreDrop?: number;
	reason: string;
	/** Config posture to apply after the gate. */
	configMode: "optimized" | "quality_priority";
}

/**
 * Compare optimized metrics against baseline.
 * Rollback when pass rate drops by more than 3 percentage points (0.03 absolute on 0–1 scale),
 * or when qualityScore (0–10) drops by more than 0.3 absolute (same 3% of full scale).
 */
export function evaluateQualityGate(baseline: QualityMetrics, optimized: QualityMetrics): QualityGateResult {
	const passRateDrop = Math.max(0, baseline.passRate - optimized.passRate);

	let qualityScoreDrop: number | undefined;
	if (baseline.qualityScore !== undefined && optimized.qualityScore !== undefined) {
		// Normalize 0–10 scale drop to 0–1 fraction of full scale
		qualityScoreDrop = Math.max(0, (baseline.qualityScore - optimized.qualityScore) / 10);
	}

	const passFail = passRateDrop > QUALITY_DROP_THRESHOLD;
	const scoreFail = qualityScoreDrop !== undefined && qualityScoreDrop > QUALITY_DROP_THRESHOLD;

	if (passFail || scoreFail) {
		return {
			decision: "rollback",
			passRateDrop,
			qualityScoreDrop,
			reason: passFail
				? `pass_rate_drop ${passRateDrop.toFixed(4)} > ${QUALITY_DROP_THRESHOLD}`
				: `quality_score_drop ${(qualityScoreDrop ?? 0).toFixed(4)} > ${QUALITY_DROP_THRESHOLD}`,
			configMode: "quality_priority",
		};
	}

	return {
		decision: "accept",
		passRateDrop,
		qualityScoreDrop,
		reason: "quality_within_threshold",
		configMode: "optimized",
	};
}

/**
 * Token savings fraction: (baseline - optimized) / baseline.
 * Returns 0 when baseline is zero or missing.
 */
export function tokenSavingsFraction(baselineTokens: number, optimizedTokens: number): number {
	if (!baselineTokens || baselineTokens <= 0) return 0;
	return Math.max(0, (baselineTokens - optimizedTokens) / baselineTokens);
}
