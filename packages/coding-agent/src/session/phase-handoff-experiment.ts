/**
 * Opt-in main-session phase-handoff / carried-context experiment (history S2).
 *
 * At natural phase boundaries, optionally reduce carried context while retaining
 * open constraints, modification state, and acceptance basis. Default off —
 * production compaction/context path unchanged. Single-factor only; does not
 * change model or concurrency. claimedLiveWin is always false.
 *
 * Reuses the Package 4 / P1-3 experiment harness shape; does not force a global
 * 200k cap.
 */

import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import { sha256Hex } from "../latency/stable-serialize";

export const PHASE_HANDOFF_EXPERIMENT_KIND = "phase_handoff_experiment" as const;
export const PHASE_HANDOFF_EXPERIMENT_VERSION = 1 as const;
export const PHASE_HANDOFF_EXPERIMENT_RUN_KIND = "phase_handoff_experiment_run" as const;

export const PHASE_HANDOFF_FACTORS = ["none", "phase_boundary_carry_slim"] as const;
export type PhaseHandoffFactor = (typeof PHASE_HANDOFF_FACTORS)[number];

export type PhaseHandoffFallbackReason =
	| "disabled"
	| "factor_none"
	| "multi_factor_rejected"
	| "missing_required_state"
	| "unknown_factor";

/** State that must survive a phase-boundary carry reduction. */
export interface PhaseHandoffRetainedState {
	openConstraints: readonly string[];
	modificationState: readonly string[];
	acceptanceBasis: readonly string[];
}

export interface PhaseHandoffCarriedContext {
	/** Bulky prior transcript / tool dumps eligible for drop when treatment applies. */
	bulkyCarry: readonly string[];
	retained: PhaseHandoffRetainedState;
}

export interface PhaseHandoffExperimentConfig {
	enabled: boolean;
	factor: PhaseHandoffFactor;
}

export interface PhaseHandoffExperimentReceiptV1 {
	kind: typeof PHASE_HANDOFF_EXPERIMENT_KIND;
	v: typeof PHASE_HANDOFF_EXPERIMENT_VERSION;
	enabled: boolean;
	factor: PhaseHandoffFactor;
	applied: boolean;
	fallbackReason?: PhaseHandoffFallbackReason;
	/** Always false — never a global fixed context cap. */
	globalFixedCap: false;
	/** Always false — model/concurrency must not change in this experiment. */
	modelOrConcurrencyChanged: false;
	configFingerprint: string;
}

export interface PhaseHandoffApplyResult {
	applied: boolean;
	carried: PhaseHandoffCarriedContext;
	droppedBulkyCount: number;
	retained: PhaseHandoffRetainedState;
	receipt: PhaseHandoffExperimentReceiptV1;
}

export interface PhaseHandoffExperimentRunV1 {
	kind: typeof PHASE_HANDOFF_EXPERIMENT_RUN_KIND;
	v: 1;
	arm: "control" | "treatment";
	factor: PhaseHandoffFactor;
	droppedBulkyCount: number | null;
	retainedOpenConstraints: number | null;
	retainedModificationState: number | null;
	retainedAcceptanceBasis: number | null;
	claimedLiveWin: false;
	configFingerprint: string;
	recordedAt: string;
}

function isFactor(value: unknown): value is PhaseHandoffFactor {
	return typeof value === "string" && (PHASE_HANDOFF_FACTORS as readonly string[]).includes(value);
}

function fingerprintConfig(config: PhaseHandoffExperimentConfig): string {
	return sha256Hex(JSON.stringify({ enabled: config.enabled, factor: config.factor }));
}

export function parsePhaseHandoffExperimentConfig(raw: unknown): PhaseHandoffExperimentConfig {
	if (!isRecord(raw)) return { enabled: false, factor: "none" };
	const enabled = raw.enabled === true;
	const factor = isFactor(raw.factor) ? raw.factor : "none";
	return { enabled, factor };
}

export function defaultPhaseHandoffExperimentConfig(): PhaseHandoffExperimentConfig {
	return { enabled: false, factor: "none" };
}

export function assertSinglePhaseHandoffFactor(
	config: PhaseHandoffExperimentConfig,
): PhaseHandoffFallbackReason | null {
	if (!config.enabled) return "disabled";
	if (config.factor === "none") return "factor_none";
	if (!isFactor(config.factor)) return "unknown_factor";
	return null;
}

export function resolvePhaseHandoffExperiment(config: PhaseHandoffExperimentConfig): {
	applied: boolean;
	receipt: PhaseHandoffExperimentReceiptV1;
} {
	const fallback = assertSinglePhaseHandoffFactor(config);
	if (fallback) {
		return {
			applied: false,
			receipt: {
				kind: PHASE_HANDOFF_EXPERIMENT_KIND,
				v: PHASE_HANDOFF_EXPERIMENT_VERSION,
				enabled: config.enabled,
				factor: config.factor,
				applied: false,
				fallbackReason: fallback,
				globalFixedCap: false,
				modelOrConcurrencyChanged: false,
				configFingerprint: fingerprintConfig(config),
			},
		};
	}
	return {
		applied: true,
		receipt: {
			kind: PHASE_HANDOFF_EXPERIMENT_KIND,
			v: PHASE_HANDOFF_EXPERIMENT_VERSION,
			enabled: true,
			factor: config.factor,
			applied: true,
			globalFixedCap: false,
			modelOrConcurrencyChanged: false,
			configFingerprint: fingerprintConfig(config),
		},
	};
}

function hasRequiredRetainedState(retained: PhaseHandoffRetainedState): boolean {
	return (
		retained.openConstraints.length > 0 &&
		retained.modificationState.length > 0 &&
		retained.acceptanceBasis.length > 0
	);
}

/**
 * Apply the experiment at a natural phase boundary. Control keeps bulky carry.
 * Treatment drops bulky carry only when required retained state is present.
 */
export function applyPhaseHandoffExperiment(args: {
	config: PhaseHandoffExperimentConfig;
	carried: PhaseHandoffCarriedContext;
}): PhaseHandoffApplyResult {
	const { applied, receipt } = resolvePhaseHandoffExperiment(args.config);
	if (!applied || args.config.factor !== "phase_boundary_carry_slim") {
		return {
			applied: false,
			carried: args.carried,
			droppedBulkyCount: 0,
			retained: args.carried.retained,
			receipt,
		};
	}
	if (!hasRequiredRetainedState(args.carried.retained)) {
		return {
			applied: false,
			carried: args.carried,
			droppedBulkyCount: 0,
			retained: args.carried.retained,
			receipt: {
				...receipt,
				applied: false,
				fallbackReason: "missing_required_state",
			},
		};
	}
	const droppedBulkyCount = args.carried.bulkyCarry.length;
	return {
		applied: true,
		carried: {
			bulkyCarry: [],
			retained: args.carried.retained,
		},
		droppedBulkyCount,
		retained: args.carried.retained,
		receipt,
	};
}

export function buildPhaseHandoffExperimentRun(args: {
	arm: "control" | "treatment";
	config: PhaseHandoffExperimentConfig;
	result: PhaseHandoffApplyResult;
	recordedAt?: string;
}): PhaseHandoffExperimentRunV1 {
	return {
		kind: PHASE_HANDOFF_EXPERIMENT_RUN_KIND,
		v: 1,
		arm: args.arm,
		factor: args.config.factor,
		droppedBulkyCount: args.result.applied ? args.result.droppedBulkyCount : null,
		retainedOpenConstraints: args.result.retained.openConstraints.length,
		retainedModificationState: args.result.retained.modificationState.length,
		retainedAcceptanceBasis: args.result.retained.acceptanceBasis.length,
		claimedLiveWin: false,
		configFingerprint: args.result.receipt.configFingerprint,
		recordedAt: args.recordedAt ?? new Date().toISOString(),
	};
}
