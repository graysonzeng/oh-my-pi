/**
 * Experiment A — less duplicate transfer, keep full recovery (Package 4).
 *
 * Opt-in single-factor surface over ReadViewKey reuse. Default off: production
 * read behavior unchanged. Does NOT globally lower output caps or add forced
 * “don’t re-read” prompt rules. Separate from the stable-prefix cache experiment.
 */

import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import { type ReadViewKeyV1 } from "./read-view-key";
import { sha256Hex } from "./stable-serialize";

export const READ_DEDUPE_EXPERIMENT_KIND = "read_dedupe_experiment" as const;
export const READ_DEDUPE_EXPERIMENT_VERSION = 1 as const;
export const READ_DEDUPE_EXPERIMENT_RUN_KIND = "read_dedupe_experiment_run" as const;

export const READ_DEDUPE_FACTORS = ["none", "same_version_view_reuse"] as const;
export type ReadDedupeFactor = (typeof READ_DEDUPE_FACTORS)[number];

export type ReadDedupeFallbackReason =
	| "disabled"
	| "factor_none"
	| "multi_factor_rejected"
	| "ineligible_view_key"
	| "unknown_factor";

export interface ReadDedupeExperimentConfig {
	enabled: boolean;
	factor: ReadDedupeFactor;
}

export interface ReadDedupeExperimentReceiptV1 {
	kind: typeof READ_DEDUPE_EXPERIMENT_KIND;
	v: typeof READ_DEDUPE_EXPERIMENT_VERSION;
	enabled: boolean;
	factor: ReadDedupeFactor;
	applied: boolean;
	fallbackReason?: ReadDedupeFallbackReason;
	/** Always false — this experiment must not lower global output caps. */
	globalOutputCapsLowered: false;
	/** Always false — no forced “don’t re-read” prompt rules. */
	forcedNoRereadPrompt: false;
	configFingerprint: string;
}

export interface ReadReuseDecision {
	reuse: boolean;
	reason:
		| "control_no_reuse"
		| "experiment_same_version_view"
		| "ineligible_key"
		| "version_or_view_mismatch"
		| "disabled"
		| "factor_none"
		| "multi_factor_rejected";
}

export interface TruncationRecoveryEvent {
	/** Tool call that recovered truncated / partial content. */
	tool: string;
	recoveredTruncation: boolean;
}

export interface ReadDedupeExperimentMetrics {
	/** Extra tool calls spent recovering truncated content. */
	truncationRecoveryToolCalls: number | null;
	duplicateTransfersAvoided: number | null;
	/** First return bytes/tokens sufficiency is judged offline; unknown stays null. */
	firstReturnSufficient: boolean | null;
}

export interface ReadDedupeExperimentRunV1 {
	kind: typeof READ_DEDUPE_EXPERIMENT_RUN_KIND;
	v: 1;
	arm: "control" | "treatment";
	factor: ReadDedupeFactor;
	metrics: ReadDedupeExperimentMetrics;
	claimedLiveWin: false;
	configFingerprint: string;
	recordedAt: string;
}

function isFactor(value: unknown): value is ReadDedupeFactor {
	return typeof value === "string" && (READ_DEDUPE_FACTORS as readonly string[]).includes(value);
}

function fingerprintConfig(config: ReadDedupeExperimentConfig): string {
	return sha256Hex(JSON.stringify({ enabled: config.enabled, factor: config.factor }));
}

export function parseReadDedupeExperimentConfig(raw: unknown): ReadDedupeExperimentConfig {
	if (!isRecord(raw)) return { enabled: false, factor: "none" };
	const enabled = raw.enabled === true;
	const factor = isFactor(raw.factor) ? raw.factor : "none";
	return { enabled, factor };
}

/** Default production control — experiment off. */
export function defaultReadDedupeExperimentConfig(): ReadDedupeExperimentConfig {
	return { enabled: false, factor: "none" };
}

/**
 * Multi-factor declarations are not supported on this surface.
 * Also reject when Experiment B is enabled in the same session (A/B entanglement).
 */
export function assertSingleReadDedupeFactor(
	config: ReadDedupeExperimentConfig,
	peer?: { stablePrefixCacheEnabled?: boolean; phaseHandoffEnabled?: boolean },
): ReadDedupeFallbackReason | null {
	if (!config.enabled) return "disabled";
	if (peer?.stablePrefixCacheEnabled === true || peer?.phaseHandoffEnabled === true) return "multi_factor_rejected";
	if (config.factor === "none") return "factor_none";
	if (!isFactor(config.factor)) return "unknown_factor";
	return null;
}

export function resolveReadDedupeExperiment(
	config: ReadDedupeExperimentConfig,
	peer?: { stablePrefixCacheEnabled?: boolean; phaseHandoffEnabled?: boolean },
): {
	applied: boolean;
	receipt: ReadDedupeExperimentReceiptV1;
} {
	const fallback = assertSingleReadDedupeFactor(config, peer);
	if (fallback) {
		return {
			applied: false,
			receipt: {
				kind: READ_DEDUPE_EXPERIMENT_KIND,
				v: READ_DEDUPE_EXPERIMENT_VERSION,
				enabled: config.enabled,
				factor: config.factor,
				applied: false,
				fallbackReason: fallback,
				globalOutputCapsLowered: false,
				forcedNoRereadPrompt: false,
				configFingerprint: fingerprintConfig(config),
			},
		};
	}
	return {
		applied: true,
		receipt: {
			kind: READ_DEDUPE_EXPERIMENT_KIND,
			v: READ_DEDUPE_EXPERIMENT_VERSION,
			enabled: true,
			factor: config.factor,
			applied: true,
			globalOutputCapsLowered: false,
			forcedNoRereadPrompt: false,
			configFingerprint: fingerprintConfig(config),
		},
	};
}

/**
 * Decide whether a prior read view may be reused for the current key.
 * Control / disabled → never reuse via this experiment (production unchanged).
 */
export function decideReadViewReuse(input: {
	config: ReadDedupeExperimentConfig;
	current: ReadViewKeyV1;
	prior: ReadViewKeyV1 | null | undefined;
	/** When Experiment B is also enabled, fail closed (A/B must stay separate). */
	peerStablePrefixCacheEnabled?: boolean;
	/** When S2 phase-handoff is also enabled, fail closed (single-factor only). */
	peerPhaseHandoffEnabled?: boolean;
}): ReadReuseDecision {
	const { applied, receipt } = resolveReadDedupeExperiment(input.config, {
		stablePrefixCacheEnabled: input.peerStablePrefixCacheEnabled,
		phaseHandoffEnabled: input.peerPhaseHandoffEnabled,
	});
	if (!applied) {
		return {
			reuse: false,
			reason:
				receipt.fallbackReason === "multi_factor_rejected"
					? "multi_factor_rejected"
					: input.config.enabled && input.config.factor === "none"
						? "factor_none"
						: input.config.enabled
							? "disabled"
							: "control_no_reuse",
		};
	}
	if (!input.current.eligible || !input.prior?.eligible) {
		return { reuse: false, reason: "ineligible_key" };
	}
	if (input.current.key !== input.prior.key) {
		return { reuse: false, reason: "version_or_view_mismatch" };
	}
	return { reuse: true, reason: "experiment_same_version_view" };
}

/** Count tool calls that recovered truncated content. */
export function countTruncationRecoveryToolCalls(events: readonly TruncationRecoveryEvent[]): number {
	let n = 0;
	for (const event of events) {
		if (event.recoveredTruncation) n++;
	}
	return n;
}

/**
 * Fixture guard: treatment must not increase truncation-recovery round-trips
 * vs control. Returns null when either side is unknown.
 */
export function truncationRecoveryNotIncreased(input: {
	controlRecoveryCalls: number | null;
	treatmentRecoveryCalls: number | null;
}): boolean | null {
	if (input.controlRecoveryCalls === null || input.treatmentRecoveryCalls === null) return null;
	return input.treatmentRecoveryCalls <= input.controlRecoveryCalls;
}

export function buildReadDedupeExperimentRun(input: {
	arm: "control" | "treatment";
	config: ReadDedupeExperimentConfig;
	metrics: ReadDedupeExperimentMetrics;
}): ReadDedupeExperimentRunV1 {
	return {
		kind: READ_DEDUPE_EXPERIMENT_RUN_KIND,
		v: 1,
		arm: input.arm,
		factor: input.config.factor,
		metrics: input.metrics,
		claimedLiveWin: false,
		configFingerprint: fingerprintConfig(input.config),
		recordedAt: new Date().toISOString(),
	};
}
