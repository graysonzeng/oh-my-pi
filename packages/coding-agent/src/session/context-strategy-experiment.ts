/**
 * Context strategy experiment surface (P1-3).
 *
 * Single-factor harness over existing SessionMaintenance / cfgCompaction knobs.
 * Does not add a second compaction scheduler. Defaults stay production control;
 * ~200k is an experiment tier, not a global fixed cap for all models.
 *
 * Preserve contract for exposed knobs:
 * - recent edits → keepRecentTokens floor
 * - open constraints / acceptance criteria → handoff/structured retention
 *   (not numeric; receipt records the preserve policy)
 */

import { createHash } from "node:crypto";
import { resolveBudgetReserveTokens } from "@oh-my-pi/pi-agent-core/compaction";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import type { ScopeLike } from "../config/registry";
import {
	cfgCompaction,
	cfgCompactionExperiment,
	type CompactionSettings,
	type ContextStrategyExperimentSettings,
} from "./context-settings";

export const CONTEXT_STRATEGY_EXPERIMENT_KIND = "context_strategy_experiment" as const;
export const CONTEXT_STRATEGY_EXPERIMENT_VERSION = 1 as const;
export const CONTEXT_STRATEGY_EXPERIMENT_RUN_KIND = "context_strategy_experiment_run" as const;

/** Default experiment tier for threshold_tokens — not a production global cap. */
export const CONTEXT_STRATEGY_EXPERIMENT_TIER_TOKENS = 200_000 as const;

/**
 * Floor for keep_recent_tokens treatments so recent edits stay recoverable.
 * Below this, treatment fails closed to control.
 */
export const CONTEXT_STRATEGY_PRESERVE_KEEP_RECENT_FLOOR = 8_000 as const;

export const CONTEXT_STRATEGY_FACTORS = [
	"none",
	"threshold_tokens",
	"keep_recent_tokens",
	"reserve_tokens",
] as const;

export type ContextStrategyFactor = (typeof CONTEXT_STRATEGY_FACTORS)[number];

export type ContextStrategyExperimentSource = "control" | "treatment" | "baseline_threshold_fallback";

export type ContextStrategyFallbackReason =
	| "disabled"
	| "factor_none"
	| "multi_factor_rejected"
	| "tier_exceeds_usable_window"
	| "invalid_treatment_value"
	| "preserve_floor_violation"
	| "context_window_required"
	| "unknown_factor";

export interface ContextStrategyPreservePolicy {
	/** Recent transcript suffix kept verbatim via keepRecentTokens. */
	recentEdits: true;
	/** Open constraints retained via handoff/structured method content. */
	openConstraints: true;
	/** Acceptance criteria retained via handoff/structured method content. */
	acceptanceCriteria: true;
}

export interface ContextStrategyExperimentConfig {
	enabled: boolean;
	factor: ContextStrategyFactor;
	/** Used only when factor === "threshold_tokens". */
	thresholdTokens: number;
	/** Used only when factor === "keep_recent_tokens". */
	keepRecentTokens: number | undefined;
	/** Used only when factor === "reserve_tokens". */
	reserveTokens: number | undefined;
}

export interface ContextStrategyExperimentReceiptV1 {
	kind: typeof CONTEXT_STRATEGY_EXPERIMENT_KIND;
	v: typeof CONTEXT_STRATEGY_EXPERIMENT_VERSION;
	enabled: boolean;
	factor: ContextStrategyFactor;
	applied: boolean;
	source: ContextStrategyExperimentSource;
	fallbackReason?: ContextStrategyFallbackReason;
	tierTokens?: number;
	/** Always false — 200k must never be recorded as a global fixed cap. */
	globalFixedCap: false;
	effectiveThresholdTokens?: number;
	effectiveKeepRecentTokens?: number;
	effectiveReserveTokens?: number;
	preserve: ContextStrategyPreservePolicy;
	configFingerprint: string;
}

export interface ContextStrategyExperimentResolution {
	applied: boolean;
	factor: ContextStrategyFactor;
	settings: CompactionSettings;
	source: ContextStrategyExperimentSource;
	fallbackReason?: ContextStrategyFallbackReason;
	effectiveThresholdTokens?: number;
	receipt: ContextStrategyExperimentReceiptV1;
}

export type ConstraintRetentionMetric = "retained" | "lost" | "unknown";
export type RecoveryQualityMetric = "recovered" | "failed" | "unknown";

export interface ContextStrategyExperimentMetrics {
	totalTaskTimeMs: number | null;
	constraintRetention: ConstraintRetentionMetric;
	recoveryQuality: RecoveryQualityMetric;
}

export interface ContextStrategyExperimentRunV1 {
	kind: typeof CONTEXT_STRATEGY_EXPERIMENT_RUN_KIND;
	v: 1;
	arm: "control" | "treatment";
	factor: ContextStrategyFactor;
	tierTokens?: number;
	metrics: ContextStrategyExperimentMetrics;
	/** Mechanism harness never claims a live win by itself. */
	claimedLiveWin: false;
	configFingerprint: string;
	recordedAt: string;
}

export type ContextStrategyJudgeStatus = "comparable" | "incomplete_metrics" | "incomparable";

export interface ContextStrategyJudgeVerdict {
	status: ContextStrategyJudgeStatus;
	taskTimeImproved: boolean | null;
	constraintsRetained: boolean | null;
	recoveryOk: boolean | null;
	claimedLiveWin: false;
	notes: string[];
}

const PRESERVE: ContextStrategyPreservePolicy = {
	recentEdits: true,
	openConstraints: true,
	acceptanceCriteria: true,
};

function isFactor(value: unknown): value is ContextStrategyFactor {
	return typeof value === "string" && (CONTEXT_STRATEGY_FACTORS as readonly string[]).includes(value);
}

function fingerprintConfig(config: ContextStrategyExperimentConfig): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				enabled: config.enabled,
				factor: config.factor,
				thresholdTokens: config.thresholdTokens,
				keepRecentTokens: config.keepRecentTokens ?? null,
				reserveTokens: config.reserveTokens ?? null,
			}),
		)
		.digest("hex");
}

function controlReceipt(
	config: ContextStrategyExperimentConfig,
	source: ContextStrategyExperimentSource,
	fallbackReason?: ContextStrategyFallbackReason,
): ContextStrategyExperimentReceiptV1 {
	return {
		kind: CONTEXT_STRATEGY_EXPERIMENT_KIND,
		v: CONTEXT_STRATEGY_EXPERIMENT_VERSION,
		enabled: config.enabled,
		factor: config.factor,
		applied: false,
		source,
		fallbackReason,
		tierTokens: config.factor === "threshold_tokens" ? config.thresholdTokens : undefined,
		globalFixedCap: false,
		preserve: PRESERVE,
		configFingerprint: fingerprintConfig(config),
	};
}

/**
 * Multi-factor declarations fail closed — one experiment surface at a time.
 */
export function assertSingleFactorDeclaration(
	input: Partial<ContextStrategyExperimentConfig> & { factor?: ContextStrategyFactor },
): void {
	const factor = input.factor ?? "none";
	const extras: string[] = [];
	if (factor !== "keep_recent_tokens" && typeof input.keepRecentTokens === "number") {
		extras.push("keepRecentTokens");
	}
	if (factor !== "reserve_tokens" && typeof input.reserveTokens === "number") {
		extras.push("reserveTokens");
	}
	if (extras.length > 0) {
		throw new Error(
			`context strategy experiment allows a single factor; extra treatment fields: ${extras.join(", ")}`,
		);
	}
}

function hasMultiFactorConflict(config: ContextStrategyExperimentConfig): boolean {
	try {
		assertSingleFactorDeclaration(config);
		return false;
	} catch {
		return true;
	}
}

export function parseContextStrategyExperimentConfig(raw: unknown): ContextStrategyExperimentConfig | null {
	if (!isRecord(raw)) return null;
	const enabled = raw.enabled === true;
	const factor = isFactor(raw.factor) ? raw.factor : null;
	if (!factor) return null;
	const thresholdTokens =
		typeof raw.thresholdTokens === "number" && Number.isFinite(raw.thresholdTokens) && raw.thresholdTokens > 0
			? Math.floor(raw.thresholdTokens)
			: CONTEXT_STRATEGY_EXPERIMENT_TIER_TOKENS;
	const keepRecentTokens =
		typeof raw.keepRecentTokens === "number" && Number.isFinite(raw.keepRecentTokens)
			? Math.floor(raw.keepRecentTokens)
			: undefined;
	const reserveTokens =
		typeof raw.reserveTokens === "number" && Number.isFinite(raw.reserveTokens)
			? Math.floor(raw.reserveTokens)
			: undefined;
	const config: ContextStrategyExperimentConfig = {
		enabled,
		factor,
		thresholdTokens,
		keepRecentTokens,
		reserveTokens,
	};
	if (hasMultiFactorConflict(config)) return null;
	return config;
}

export function settingsToExperimentConfig(value: ContextStrategyExperimentSettings): ContextStrategyExperimentConfig {
	const factor = isFactor(value.factor) ? value.factor : "none";
	return {
		enabled: value.enabled === true,
		factor,
		thresholdTokens:
			typeof value.thresholdTokens === "number" && value.thresholdTokens > 0
				? value.thresholdTokens
				: CONTEXT_STRATEGY_EXPERIMENT_TIER_TOKENS,
		keepRecentTokens: typeof value.keepRecentTokens === "number" ? value.keepRecentTokens : undefined,
		reserveTokens: typeof value.reserveTokens === "number" ? value.reserveTokens : undefined,
	};
}

export function readContextStrategyExperimentConfig(settings: ScopeLike): ContextStrategyExperimentConfig {
	return settingsToExperimentConfig(cfgCompactionExperiment.get(settings));
}

/**
 * Resolve a single-factor overlay onto existing compaction settings for SessionMaintenance.
 * Never invents a second scheduler; never changes production defaults when disabled.
 */
export function applyContextStrategyExperiment(input: {
	base: CompactionSettings;
	experiment: ContextStrategyExperimentConfig;
	contextWindow?: number;
}): ContextStrategyExperimentResolution {
	const { base, experiment } = input;
	const contextWindow = input.contextWindow;

	if (!experiment.enabled) {
		return {
			applied: false,
			factor: experiment.factor,
			settings: base,
			source: "control",
			fallbackReason: "disabled",
			receipt: controlReceipt(experiment, "control", "disabled"),
		};
	}

	if (experiment.factor === "none") {
		return {
			applied: false,
			factor: "none",
			settings: base,
			source: "control",
			fallbackReason: "factor_none",
			receipt: controlReceipt(experiment, "control", "factor_none"),
		};
	}

	if (hasMultiFactorConflict(experiment)) {
		return {
			applied: false,
			factor: experiment.factor,
			settings: base,
			source: "control",
			fallbackReason: "multi_factor_rejected",
			receipt: controlReceipt(experiment, "control", "multi_factor_rejected"),
		};
	}

	if (experiment.factor === "threshold_tokens") {
		if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) {
			return {
				applied: false,
				factor: "threshold_tokens",
				settings: base,
				source: "control",
				fallbackReason: "context_window_required",
				receipt: controlReceipt(experiment, "control", "context_window_required"),
			};
		}
		const tier = experiment.thresholdTokens;
		if (!Number.isFinite(tier) || tier <= 0) {
			return {
				applied: false,
				factor: "threshold_tokens",
				settings: base,
				source: "control",
				fallbackReason: "invalid_treatment_value",
				receipt: controlReceipt(experiment, "control", "invalid_treatment_value"),
			};
		}
		const reserve = resolveBudgetReserveTokens(contextWindow, {
			enabled: base.enabled,
			thresholdPercent: base.thresholdPercent,
			thresholdTokens: base.thresholdTokens,
			reserveTokens: base.reserveTokens,
			keepRecentTokens: base.keepRecentTokens,
		});
		const usable = contextWindow - reserve;
		if (tier >= usable) {
			return {
				applied: false,
				factor: "threshold_tokens",
				settings: base,
				source: "baseline_threshold_fallback",
				fallbackReason: "tier_exceeds_usable_window",
				receipt: {
					...controlReceipt(experiment, "baseline_threshold_fallback", "tier_exceeds_usable_window"),
					tierTokens: tier,
				},
			};
		}
		const settings: CompactionSettings = { ...base, thresholdTokens: tier };
		return {
			applied: true,
			factor: "threshold_tokens",
			settings,
			source: "treatment",
			effectiveThresholdTokens: tier,
			receipt: {
				kind: CONTEXT_STRATEGY_EXPERIMENT_KIND,
				v: CONTEXT_STRATEGY_EXPERIMENT_VERSION,
				enabled: true,
				factor: "threshold_tokens",
				applied: true,
				source: "treatment",
				tierTokens: tier,
				globalFixedCap: false,
				effectiveThresholdTokens: tier,
				preserve: PRESERVE,
				configFingerprint: fingerprintConfig(experiment),
			},
		};
	}

	if (experiment.factor === "keep_recent_tokens") {
		const value = experiment.keepRecentTokens;
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
			return {
				applied: false,
				factor: "keep_recent_tokens",
				settings: base,
				source: "control",
				fallbackReason: "invalid_treatment_value",
				receipt: controlReceipt(experiment, "control", "invalid_treatment_value"),
			};
		}
		if (value < CONTEXT_STRATEGY_PRESERVE_KEEP_RECENT_FLOOR) {
			return {
				applied: false,
				factor: "keep_recent_tokens",
				settings: base,
				source: "control",
				fallbackReason: "preserve_floor_violation",
				receipt: controlReceipt(experiment, "control", "preserve_floor_violation"),
			};
		}
		const settings: CompactionSettings = { ...base, keepRecentTokens: value };
		return {
			applied: true,
			factor: "keep_recent_tokens",
			settings,
			source: "treatment",
			receipt: {
				kind: CONTEXT_STRATEGY_EXPERIMENT_KIND,
				v: CONTEXT_STRATEGY_EXPERIMENT_VERSION,
				enabled: true,
				factor: "keep_recent_tokens",
				applied: true,
				source: "treatment",
				globalFixedCap: false,
				effectiveKeepRecentTokens: value,
				preserve: PRESERVE,
				configFingerprint: fingerprintConfig(experiment),
			},
		};
	}

	if (experiment.factor === "reserve_tokens") {
		const value = experiment.reserveTokens;
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
			return {
				applied: false,
				factor: "reserve_tokens",
				settings: base,
				source: "control",
				fallbackReason: "invalid_treatment_value",
				receipt: controlReceipt(experiment, "control", "invalid_treatment_value"),
			};
		}
		const settings: CompactionSettings = { ...base, reserveTokens: value };
		return {
			applied: true,
			factor: "reserve_tokens",
			settings,
			source: "treatment",
			receipt: {
				kind: CONTEXT_STRATEGY_EXPERIMENT_KIND,
				v: CONTEXT_STRATEGY_EXPERIMENT_VERSION,
				enabled: true,
				factor: "reserve_tokens",
				applied: true,
				source: "treatment",
				globalFixedCap: false,
				effectiveReserveTokens: value,
				preserve: PRESERVE,
				configFingerprint: fingerprintConfig(experiment),
			},
		};
	}

	return {
		applied: false,
		factor: experiment.factor,
		settings: base,
		source: "control",
		fallbackReason: "unknown_factor",
		receipt: controlReceipt(experiment, "control", "unknown_factor"),
	};
}

/**
 * SessionMaintenance entry: overlay one experiment factor onto cfgCompaction.
 * When the experiment is off, returns production settings unchanged.
 */
export function effectiveCompactionSettings(settings: ScopeLike, contextWindow?: number): CompactionSettings {
	return resolveSessionCompactionSettings({ settings, contextWindow }).settings;
}

export function resolveSessionCompactionSettings(input: {
	settings: ScopeLike;
	base?: CompactionSettings;
	contextWindow?: number;
}): ContextStrategyExperimentResolution {
	const base = input.base ?? cfgCompaction.get(input.settings);
	const experiment = readContextStrategyExperimentConfig(input.settings);
	return applyContextStrategyExperiment({
		base,
		experiment,
		contextWindow: input.contextWindow,
	});
}

export function buildContextStrategyExperimentRun(input: {
	arm: "control" | "treatment";
	factor: ContextStrategyFactor;
	tierTokens?: number;
	metrics: Partial<ContextStrategyExperimentMetrics> & {
		totalTaskTimeMs?: number | null;
		constraintRetention?: ConstraintRetentionMetric;
		recoveryQuality?: RecoveryQualityMetric;
	};
	recordedAt?: string;
	configFingerprint?: string;
}): ContextStrategyExperimentRunV1 {
	const metrics: ContextStrategyExperimentMetrics = {
		totalTaskTimeMs:
			typeof input.metrics.totalTaskTimeMs === "number" && Number.isFinite(input.metrics.totalTaskTimeMs)
				? input.metrics.totalTaskTimeMs
				: null,
		constraintRetention: input.metrics.constraintRetention ?? "unknown",
		recoveryQuality: input.metrics.recoveryQuality ?? "unknown",
	};
	const configFingerprint =
		input.configFingerprint ??
		fingerprintConfig({
			enabled: input.arm === "treatment",
			factor: input.factor,
			thresholdTokens: input.tierTokens ?? CONTEXT_STRATEGY_EXPERIMENT_TIER_TOKENS,
			keepRecentTokens: undefined,
			reserveTokens: undefined,
		});
	return {
		kind: CONTEXT_STRATEGY_EXPERIMENT_RUN_KIND,
		v: 1,
		arm: input.arm,
		factor: input.factor,
		tierTokens: input.tierTokens,
		metrics,
		claimedLiveWin: false,
		configFingerprint,
		recordedAt: input.recordedAt ?? new Date().toISOString(),
	};
}

/**
 * Judge a paired control/treatment run. Never stamps claimedLiveWin — live wins
 * require an actual recorded corpus outside this mechanism harness.
 */
export function judgeContextStrategyExperiment(input: {
	control: ContextStrategyExperimentRunV1;
	treatment: ContextStrategyExperimentRunV1;
}): ContextStrategyJudgeVerdict {
	const notes: string[] = [
		"mechanism-only harness: do not claim historical 57%/30%/316k figures as current",
		"live wins require recorded paired corpus; this judge never sets claimedLiveWin",
	];
	if (input.control.factor !== input.treatment.factor || input.control.factor === "none") {
		return {
			status: "incomparable",
			taskTimeImproved: null,
			constraintsRetained: null,
			recoveryOk: null,
			claimedLiveWin: false,
			notes: [...notes, "control and treatment must share one non-none factor"],
		};
	}
	const c = input.control.metrics;
	const t = input.treatment.metrics;
	const incomplete =
		c.totalTaskTimeMs === null ||
		t.totalTaskTimeMs === null ||
		c.constraintRetention === "unknown" ||
		t.constraintRetention === "unknown" ||
		c.recoveryQuality === "unknown" ||
		t.recoveryQuality === "unknown";
	if (incomplete) {
		return {
			status: "incomplete_metrics",
			taskTimeImproved: null,
			constraintsRetained: null,
			recoveryOk: null,
			claimedLiveWin: false,
			notes: [...notes, "need totalTaskTimeMs, constraintRetention, and recoveryQuality on both arms"],
		};
	}
	return {
		status: "comparable",
		taskTimeImproved: (t.totalTaskTimeMs as number) < (c.totalTaskTimeMs as number),
		constraintsRetained: t.constraintRetention === "retained" && c.constraintRetention !== "lost",
		recoveryOk: t.recoveryQuality === "recovered",
		claimedLiveWin: false,
		notes,
	};
}

export type { CompactionSettings };
