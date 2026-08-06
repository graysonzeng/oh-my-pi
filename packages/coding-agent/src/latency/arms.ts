import { createHash } from "node:crypto";

/**
 * Independent latency-optimization arms (design A §6.2).
 * All arms default-on since the 2026-08-06 live re-verification (context_optimization reuses
 * modelOptimization.enabled; the rest use latency.arms.*), session-frozen when first resolved,
 * and independently rollbackable.
 * Combined experiments must use a separate combinedArmId listing child arms.
 */

export const LATENCY_ARM_IDS = [
	"context_optimization",
	"read_dedupe",
	"context_budget_tuning",
	"role_static_split",
	"bash_advisory",
	"bash_bounded_injection",
	"concurrency_declaration",
	"concurrency_execution",
	"eval_gate_migration",
] as const;

export type LatencyArmId = (typeof LATENCY_ARM_IDS)[number];

/** Settings paths that gate each arm. All default true since 2026-08-06. */
export const LATENCY_ARM_SETTINGS = {
	context_optimization: "modelOptimization.enabled",
	read_dedupe: "latency.arms.readDedupe",
	context_budget_tuning: "latency.arms.contextBudgetTuning",
	role_static_split: "latency.arms.roleStaticSplit",
	bash_advisory: "latency.arms.bashAdvisory",
	bash_bounded_injection: "latency.arms.bashBoundedInjection",
	concurrency_declaration: "latency.arms.concurrencyDeclaration",
	concurrency_execution: "latency.arms.concurrencyExecution",
	eval_gate_migration: "latency.arms.evalGateMigration",
} as const satisfies Record<LatencyArmId, string>;

export const LATENCY_ARM_SNAPSHOT_KIND = "latency_arm_snapshot" as const;
export const LATENCY_ARM_SNAPSHOT_VERSION = 1 as const;

export interface LatencyArmSnapshotV1 {
	schemaVersion: typeof LATENCY_ARM_SNAPSHOT_VERSION;
	kind: typeof LATENCY_ARM_SNAPSHOT_KIND;
	/** Frozen at session/workflow start; mid-run settings changes do not mutate this. */
	arms: Record<LatencyArmId, boolean>;
	/** Optional pre-registered combination; never invent ad-hoc multi-arm deltas. */
	combinedArmId?: string;
	childArms?: LatencyArmId[];
	frozenAt: string;
	/** Code/config lineage anchors for A/B pairing. */
	codeRevision?: string;
	configHash?: string;
	fingerprint: string;
}

export function emptyLatencyArms(): Record<LatencyArmId, boolean> {
	return {
		context_optimization: false,
		read_dedupe: false,
		context_budget_tuning: false,
		role_static_split: false,
		bash_advisory: false,
		bash_bounded_injection: false,
		concurrency_declaration: false,
		concurrency_execution: false,
		eval_gate_migration: false,
	};
}

/** Resolve live settings into a frozen arm map (session/workflow start). */
export function resolveLatencyArmsFromSettings(get: (path: string) => unknown): Record<LatencyArmId, boolean> {
	const arms = emptyLatencyArms();
	for (const arm of LATENCY_ARM_IDS) {
		try {
			arms[arm] = get(LATENCY_ARM_SETTINGS[arm]) === true;
		} catch {
			arms[arm] = false;
		}
	}
	return arms;
}

/**
 * Session-frozen snapshot. Mid-run settings mutations must not rewrite this object.
 * Combined experiments require an explicit combinedArmId + childArms list.
 */
export function freezeLatencyArmSnapshot(input: {
	arms?: Record<LatencyArmId, boolean>;
	getSetting?: (path: string) => unknown;
	combinedArmId?: string;
	childArms?: LatencyArmId[];
	codeRevision?: string;
	configHash?: string;
	frozenAt?: string;
}): LatencyArmSnapshotV1 {
	const arms =
		input.arms ?? (input.getSetting ? resolveLatencyArmsFromSettings(input.getSetting) : emptyLatencyArms());
	if (input.combinedArmId && (!input.childArms || input.childArms.length < 2)) {
		throw new Error("combinedArmId requires childArms with at least two arms");
	}
	if (input.childArms) {
		for (const child of input.childArms) {
			if (!isLatencyArmId(child)) throw new Error(`unknown child arm: ${child}`);
		}
	}
	const frozenAt = input.frozenAt ?? new Date().toISOString();
	const payload = {
		schemaVersion: LATENCY_ARM_SNAPSHOT_VERSION,
		kind: LATENCY_ARM_SNAPSHOT_KIND,
		arms,
		combinedArmId: input.combinedArmId,
		childArms: input.childArms ? [...input.childArms] : undefined,
		frozenAt,
		codeRevision: input.codeRevision,
		configHash: input.configHash,
	};
	const fingerprint = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
	return { ...payload, fingerprint };
}

export function isLatencyArmId(value: string): value is LatencyArmId {
	return (LATENCY_ARM_IDS as readonly string[]).includes(value);
}

/** Quality stop thresholds from design A §6.5 (percentage points / relative). */
export const LATENCY_QUALITY_STOP = {
	completionDropPp: 2,
	reworkRisePct: 10,
	/** Any treatment-attributed P0/P1 escape stops rollout immediately (zero tolerance). */
	p0p1ZeroTolerance: true as const,
	costP50MaxMultiple: 1.5,
	costP95MaxMultiple: 2,
	minLatencyImprovePct: 10,
	spawnedAgentsP95MaxMultiple: 2,
} as const;

export type LatencyQualityStopDecision =
	| { stop: false; reason: null }
	| { stop: true; reason: "p0p1_escape" | "completion_drop" | "rework_rise" | "missing_attribution" };

/**
 * Evaluate treatment-attributed quality stops before promotion/rollout.
 * P0/P1 is zero-tolerance: one attributed escape stops the causal arm immediately.
 */
export function evaluateLatencyQualityStop(input: {
	treatmentAttributedP0P1Escapes: number;
	attributionKnown: boolean;
	completionDropPp?: number;
	reworkRisePct?: number;
}): LatencyQualityStopDecision {
	if (!input.attributionKnown) {
		return { stop: true, reason: "missing_attribution" };
	}
	if (LATENCY_QUALITY_STOP.p0p1ZeroTolerance && input.treatmentAttributedP0P1Escapes > 0) {
		return { stop: true, reason: "p0p1_escape" };
	}
	if (typeof input.completionDropPp === "number" && input.completionDropPp > LATENCY_QUALITY_STOP.completionDropPp) {
		return { stop: true, reason: "completion_drop" };
	}
	if (typeof input.reworkRisePct === "number" && input.reworkRisePct > LATENCY_QUALITY_STOP.reworkRisePct) {
		return { stop: true, reason: "rework_rise" };
	}
	return { stop: false, reason: null };
}
