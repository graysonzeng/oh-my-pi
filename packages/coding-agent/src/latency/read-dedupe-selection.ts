/**
 * W7: Experiment A as a controlled selection layer over the ordinary
 * latency.arms.readDedupe path — not a second cache table.
 *
 * Duties:
 * - `latency.arms.readDedupe` (ordinary arm): owns the `#readDedupeArtifacts`
 *   map + artifact rewrite in AgentSession.
 * - `deliveryExperiment.readDedupe` (Experiment A): opt-in gate that may
 *   *consult* decideReadViewReuse before the ordinary rewrite; same
 *   ReadViewKey / artifact table; no duplicate output processor.
 *
 * Same version+view reuse only; permission/source change, missing pages, and
 * necessary independent review must allow reread (return allowReuse:false).
 */
import type { ReadViewKeyV1 } from "./read-view-key";
import {
	type ReadDedupeExperimentConfig,
	type ReadReuseDecision,
	decideReadViewReuse,
	parseReadDedupeExperimentConfig,
} from "./read-dedupe-experiment";

export type ReadDedupeArmDuty = "ordinary_latency_arm" | "delivery_experiment_a";

export interface ReadDedupeArmDuties {
	ordinary: {
		arm: "ordinary_latency_arm";
		setting: "latency.arms.readDedupe";
		ownsCacheTable: true;
		ownsOutputRewrite: true;
	};
	experimentA: {
		arm: "delivery_experiment_a";
		setting: "deliveryExperiment.readDedupe";
		ownsCacheTable: false;
		ownsOutputRewrite: false;
		role: "controlled_selection_layer";
	};
}

/** Documented duty split — used by tests/status; not a second registry. */
export const READ_DEDUPE_ARM_DUTIES: ReadDedupeArmDuties = {
	ordinary: {
		arm: "ordinary_latency_arm",
		setting: "latency.arms.readDedupe",
		ownsCacheTable: true,
		ownsOutputRewrite: true,
	},
	experimentA: {
		arm: "delivery_experiment_a",
		setting: "deliveryExperiment.readDedupe",
		ownsCacheTable: false,
		ownsOutputRewrite: false,
		role: "controlled_selection_layer",
	},
};

export interface ReadDedupeSelectionInput {
	/** Ordinary arm already enabled for this turn. */
	ordinaryArmEnabled: boolean;
	experimentConfig: ReadDedupeExperimentConfig;
	current: ReadViewKeyV1;
	prior: ReadViewKeyV1 | null | undefined;
	peerStablePrefixCacheEnabled?: boolean;
	/** Force reread: permission/source change, missing page, independent review. */
	forceReread?: boolean;
}

export interface ReadDedupeSelectionResult {
	/** Whether the ordinary arm may rewrite this turn via its existing table. */
	allowReuse: boolean;
	decision: ReadReuseDecision;
	/** Experiment applied as selection overlay (not a parallel cache write). */
	experimentSelectionActive: boolean;
}

/**
 * Controlled selection: when Experiment A is applied, consult decideReadViewReuse
 * before ordinary rewrite. When Experiment A is off, ordinary arm keeps its
 * existing same-key reuse behavior (allowReuse follows ordinary eligibility).
 */
export function selectReadDedupeReuse(input: ReadDedupeSelectionInput): ReadDedupeSelectionResult {
	if (!input.ordinaryArmEnabled) {
		return {
			allowReuse: false,
			decision: { reuse: false, reason: "control_no_reuse" },
			experimentSelectionActive: false,
		};
	}
	if (input.forceReread) {
		return {
			allowReuse: false,
			decision: { reuse: false, reason: "version_or_view_mismatch" },
			experimentSelectionActive: false,
		};
	}

	const decision = decideReadViewReuse({
		config: input.experimentConfig,
		current: input.current,
		prior: input.prior,
		peerStablePrefixCacheEnabled: input.peerStablePrefixCacheEnabled,
	});

	// Experiment off / control → ordinary arm may reuse on its own (same eligible key).
	// Experiment decision stays control_no_reuse; allowReuse follows ordinary eligibility.
	if (!input.experimentConfig.enabled || decision.reason === "control_no_reuse") {
		const ordinaryEligible =
			input.current.eligible === true && input.prior?.eligible === true && input.current.key === input.prior.key;
		return {
			allowReuse: ordinaryEligible,
			decision: { reuse: false, reason: "control_no_reuse" },
			experimentSelectionActive: false,
		};
	}

	// Experiment on: selection layer gates ordinary rewrite; no second table.
	return {
		allowReuse: decision.reuse,
		decision,
		experimentSelectionActive: true,
	};
}

export function readDedupeExperimentConfigFromSettings(raw: unknown): ReadDedupeExperimentConfig {
	return parseReadDedupeExperimentConfig(raw);
}
