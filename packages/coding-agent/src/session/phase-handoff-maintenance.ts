/**
 * W6: wire phase-handoff experiment into SessionMaintenance context rewrite.
 *
 * Shadow-detect first; treatment goes through existing compaction/elide owner
 * (caller supplies bulky vs retained). Idempotent; fail-open rollback; when
 * flag off, production path unchanged. Compaction cost must be counted by the
 * caller into total task cost (this module only returns receipts).
 */
import { logger } from "@oh-my-pi/pi-utils";
import {
	type PhaseBoundaryShadowDetection,
	type PhaseHandoffApplyResult,
	type PhaseHandoffCarriedContext,
	type PhaseHandoffExperimentConfig,
	type PhaseHandoffPhase,
	applyPhaseHandoffExperiment,
	buildPhaseHandoffExperimentRun,
	detectPhaseBoundaryShadow,
	parsePhaseHandoffExperimentConfig,
} from "./phase-handoff-experiment";

export const PHASE_HANDOFF_MAINTENANCE_CUSTOM_TYPE = "phase_handoff_maintenance" as const;

export interface PhaseHandoffMaintenanceResult {
	/** Shadow detection always recorded when config enabled. */
	shadow: PhaseBoundaryShadowDetection;
	/** Apply result — applied:false when off / no boundary / missing state. */
	apply: PhaseHandoffApplyResult;
	/** Bulky carry after apply (empty when treatment dropped it). */
	bulkyCarry: readonly string[];
	/** True when treatment changed carry (caller may feed SessionMaintenance elide). */
	shouldRewriteContext: boolean;
	claimedLiveWin: false;
}

/**
 * Run shadow detection + optional treatment at a SessionMaintenance boundary.
 * When config.enabled is false, returns a no-op with shouldRewriteContext=false
 * so production compaction is unchanged.
 */
export function runPhaseHandoffMaintenance(input: {
	config: PhaseHandoffExperimentConfig;
	fromPhase: PhaseHandoffPhase;
	toPhase: PhaseHandoffPhase;
	explicitStageComplete?: boolean;
	carried: PhaseHandoffCarriedContext;
}): PhaseHandoffMaintenanceResult {
	const shadow = detectPhaseBoundaryShadow({
		fromPhase: input.fromPhase,
		toPhase: input.toPhase,
		explicitStageComplete: input.explicitStageComplete,
	});

	if (!input.config.enabled) {
		const apply = applyPhaseHandoffExperiment({
			config: input.config,
			carried: input.carried,
			boundaryDetected: false,
		});
		return {
			shadow,
			apply,
			bulkyCarry: input.carried.bulkyCarry,
			shouldRewriteContext: false,
			claimedLiveWin: false,
		};
	}

	const apply = applyPhaseHandoffExperiment({
		config: input.config,
		carried: input.carried,
		boundaryDetected: shadow.boundaryDetected,
	});
	const run = buildPhaseHandoffExperimentRun({
		arm: apply.applied ? "treatment" : "control",
		config: input.config,
		result: apply,
	});
	logger.debug("phase_handoff_maintenance", {
		boundaryDetected: shadow.boundaryDetected,
		applied: apply.applied,
		droppedBulkyCount: apply.droppedBulkyCount,
		claimedLiveWin: run.claimedLiveWin,
		fallbackReason: apply.receipt.fallbackReason,
	});

	return {
		shadow,
		apply,
		bulkyCarry: apply.carried.bulkyCarry,
		shouldRewriteContext: apply.applied && apply.droppedBulkyCount > 0,
		claimedLiveWin: false,
	};
}

/** Read settings-shaped config (enabled/factor) without throwing. */
export function phaseHandoffConfigFromSettings(raw: unknown): PhaseHandoffExperimentConfig {
	return parsePhaseHandoffExperimentConfig(raw);
}
