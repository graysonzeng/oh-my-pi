/**
 * Opt-in main-session phase-handoff / carried-context experiment (history S2 / W6).
 *
 * At natural phase boundaries, optionally reduce carried context while retaining
 * open constraints, modification/branch state, acceptance contract, incomplete
 * tools, failed attempts, and artifact/recovery locators. Default off —
 * production compaction/context path unchanged. Single-factor only; does not
 * change model or concurrency. claimedLiveWin is always false.
 *
 * Does not force a global 200k cap or add a per-turn model summarizer.
 */

import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import { sha256Hex } from "../latency/stable-serialize";

export const PHASE_HANDOFF_EXPERIMENT_KIND = "phase_handoff_experiment" as const;
export const PHASE_HANDOFF_EXPERIMENT_VERSION = 1 as const;
export const PHASE_HANDOFF_EXPERIMENT_RUN_KIND = "phase_handoff_experiment_run" as const;
export const PHASE_HANDOFF_SHADOW_CUSTOM_TYPE = "phase_handoff_shadow" as const;

export const PHASE_HANDOFF_FACTORS = ["none", "phase_boundary_carry_slim"] as const;
export type PhaseHandoffFactor = (typeof PHASE_HANDOFF_FACTORS)[number];

export type PhaseHandoffFallbackReason =
	| "disabled"
	| "factor_none"
	| "multi_factor_rejected"
	| "missing_required_state"
	| "no_phase_boundary"
	| "unknown_factor";

export type PhaseHandoffPhase = "research" | "implement" | "verify" | "unknown";

/** State that must survive a phase-boundary carry reduction (semantic, not “three arrays”). */
export interface PhaseHandoffRetainedState {
	openConstraints: readonly string[];
	modificationState: readonly string[];
	acceptanceBasis: readonly string[];
	/** Incomplete tool-call pairings that must not be dropped. */
	incompleteTools?: readonly string[];
	/** Failed attempt summaries needed for recovery. */
	failedAttempts?: readonly string[];
	/** Artifact / recovery locators (version-bound). */
	artifactLocators?: readonly string[];
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
	retainedIncompleteTools: number | null;
	retainedFailedAttempts: number | null;
	retainedArtifactLocators: number | null;
	claimedLiveWin: false;
	configFingerprint: string;
	recordedAt: string;
}

export interface PhaseBoundaryShadowDetection {
	kind: typeof PHASE_HANDOFF_SHADOW_CUSTOM_TYPE;
	v: 1;
	boundaryDetected: boolean;
	fromPhase: PhaseHandoffPhase;
	toPhase: PhaseHandoffPhase;
	reason: string;
	/** Shadow only — does not mutate production context. */
	shadow: true;
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

/**
 * Semantic retain check — not merely “three arrays non-empty”.
 * Requires constraints + mods + acceptance, plus at least one of incomplete
 * tools / failed attempts / artifact locators when those arrays are present
 * on the retained object (optional fields may be omitted by older callers).
 */
export function hasRequiredRetainedState(retained: PhaseHandoffRetainedState): boolean {
	if (
		retained.openConstraints.length === 0 ||
		retained.modificationState.length === 0 ||
		retained.acceptanceBasis.length === 0
	) {
		return false;
	}
	const hasOptional =
		retained.incompleteTools !== undefined ||
		retained.failedAttempts !== undefined ||
		retained.artifactLocators !== undefined;
	if (!hasOptional) {
		// Backward-compatible path for library callers that only supply the
		// original three arrays — still require all three non-empty.
		return true;
	}
	const incompleteOk = retained.incompleteTools === undefined || retained.incompleteTools.length >= 0;
	const failedOk = retained.failedAttempts === undefined || retained.failedAttempts.length >= 0;
	const artifactsOk = retained.artifactLocators === undefined || retained.artifactLocators.length >= 0;
	// When optional fields are declared, at least one recovery locator class
	// must carry content (empty declared arrays fail closed).
	const anyRecovery =
		(retained.incompleteTools?.length ?? 0) > 0 ||
		(retained.failedAttempts?.length ?? 0) > 0 ||
		(retained.artifactLocators?.length ?? 0) > 0;
	return incompleteOk && failedOk && artifactsOk && anyRecovery;
}

/**
 * Shadow-detect a natural phase boundary (research→implement→verify or
 * explicit stage completion). No model summarizer; no 200k threshold.
 */
export function detectPhaseBoundaryShadow(input: {
	fromPhase: PhaseHandoffPhase;
	toPhase: PhaseHandoffPhase;
	/** Explicit stage-complete signal from workflow/owner when known. */
	explicitStageComplete?: boolean;
}): PhaseBoundaryShadowDetection {
	const recordedAt = new Date().toISOString();
	const ordered: PhaseHandoffPhase[] = ["research", "implement", "verify"];
	const fromIdx = ordered.indexOf(input.fromPhase);
	const toIdx = ordered.indexOf(input.toPhase);
	const naturalAdvance = fromIdx >= 0 && toIdx >= 0 && toIdx === fromIdx + 1 && input.fromPhase !== input.toPhase;
	const boundaryDetected = naturalAdvance || input.explicitStageComplete === true;
	return {
		kind: PHASE_HANDOFF_SHADOW_CUSTOM_TYPE,
		v: 1,
		boundaryDetected,
		fromPhase: input.fromPhase,
		toPhase: input.toPhase,
		reason: !boundaryDetected
			? "no_phase_boundary"
			: input.explicitStageComplete
				? "explicit_stage_complete"
				: `advance_${input.fromPhase}_to_${input.toPhase}`,
		shadow: true,
		recordedAt,
	};
}

/**
 * Apply the experiment at a natural phase boundary. Control keeps bulky carry.
 * Treatment drops bulky carry only when required retained state is present.
 * Callers should pass a detected boundary; without one, fail open (no drop).
 */
export function applyPhaseHandoffExperiment(args: {
	config: PhaseHandoffExperimentConfig;
	carried: PhaseHandoffCarriedContext;
	/** When false, skip treatment (shadow-only / no boundary). Default true for library tests. */
	boundaryDetected?: boolean;
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
	if (args.boundaryDetected === false) {
		return {
			applied: false,
			carried: args.carried,
			droppedBulkyCount: 0,
			retained: args.carried.retained,
			receipt: {
				...receipt,
				applied: false,
				fallbackReason: "no_phase_boundary",
			},
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
		retainedIncompleteTools: args.result.retained.incompleteTools?.length ?? null,
		retainedFailedAttempts: args.result.retained.failedAttempts?.length ?? null,
		retainedArtifactLocators: args.result.retained.artifactLocators?.length ?? null,
		claimedLiveWin: false,
		configFingerprint: args.result.receipt.configFingerprint,
		recordedAt: args.recordedAt ?? new Date().toISOString(),
	};
}
