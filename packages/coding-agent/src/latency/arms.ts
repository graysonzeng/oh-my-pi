import { createHash } from "node:crypto";

/**
 * Independent latency-optimization arms (design A §6.2).
 * Defaults since the 2026-08-07 quality gate: the low-risk fail-open bash pair plus the
 * high-benefit ordinary-session pair (context_optimization + read_dedupe) are on by default;
 * every other behavior-changing arm is off until its paired ≥30-task matrix passes. The wired
 * production quality stop (cohort data plane, fired-arm attribution, ordinary-session consumer)
 * guards the on-by-default set. Arms are session-frozen when first resolved and independently
 * rollbackable.
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

/** Settings paths that gate each arm. High-benefit pair + low-risk bash pair default true. */
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
	| {
			stop: true;
			reason:
				| "p0p1_escape"
				| "completion_drop"
				| "rework_rise"
				| "missing_attribution"
				| "cost_breach"
				| "latency_miss"
				| "spawned_agents_breach";
	  };

/**
 * Evaluate treatment-attributed quality stops before promotion/rollout.
 * Covers every documented threshold (design A §6.5): P0/P1 zero-tolerance, completion drop,
 * rework rise, cost P50/P95 multiples, latency improvement, and spawned-agent P95 multiple.
 * Missing attribution is itself a stop: an unregistered multi-arm state cannot be rolled back
 * causally, so it fails closed.
 */
export function evaluateLatencyQualityStop(input: {
	treatmentAttributedP0P1Escapes: number;
	attributionKnown: boolean;
	completionDropPp?: number;
	reworkRisePct?: number;
	costP50Multiple?: number;
	costP95Multiple?: number;
	latencyImprovePct?: number;
	spawnedAgentsP95Multiple?: number;
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
	if (typeof input.costP50Multiple === "number" && input.costP50Multiple > LATENCY_QUALITY_STOP.costP50MaxMultiple) {
		return { stop: true, reason: "cost_breach" };
	}
	if (typeof input.costP95Multiple === "number" && input.costP95Multiple > LATENCY_QUALITY_STOP.costP95MaxMultiple) {
		return { stop: true, reason: "cost_breach" };
	}
	if (
		typeof input.latencyImprovePct === "number" &&
		input.latencyImprovePct < LATENCY_QUALITY_STOP.minLatencyImprovePct
	) {
		return { stop: true, reason: "latency_miss" };
	}
	if (
		typeof input.spawnedAgentsP95Multiple === "number" &&
		input.spawnedAgentsP95Multiple > LATENCY_QUALITY_STOP.spawnedAgentsP95MaxMultiple
	) {
		return { stop: true, reason: "spawned_agents_breach" };
	}
	return { stop: false, reason: null };
}

/**
 * Deterministically register the active arm set as a combination when ≥2 arms are on.
 * Production snapshots must never run an unregistered multi-arm state: without a combinedArmId
 * and exhaustive childArms the stop evaluator treats attribution as unknown and fails closed.
 */
export function deriveLatencyCombination(arms: Record<LatencyArmId, boolean>): {
	combinedArmId?: string;
	childArms?: LatencyArmId[];
} {
	const active = LATENCY_ARM_IDS.filter(id => arms[id] === true);
	if (active.length < 2) return {};
	const sorted = [...active].sort();
	return { combinedArmId: `combined:${sorted.join("+")}`, childArms: sorted };
}

/**
 * Durable per-workflow/session quality-stop receipt. Persisted when a run with active arms
 * reaches a terminal state so a quality regression is attributable and rollbackable.
 */
export const LATENCY_ROLLOUT_DECISION_KIND = "latency-rollout-decision" as const;

export interface LatencyRolloutObservedV1 {
	completion: boolean;
	repairCycles: number;
	treatmentAttributedP0P1Escapes: number;
	costUsd: number | null;
	stageTimeMs: number;
	spawnedAgents: number | null;
}

export interface LatencyRolloutDecisionV1 {
	schemaVersion: 1;
	kind: typeof LATENCY_ROLLOUT_DECISION_KIND;
	workflowId: string;
	status: string;
	snapshot: LatencyArmSnapshotV1;
	attributionKnown: boolean;
	observed: LatencyRolloutObservedV1;
	decision: LatencyQualityStopDecision;
	/** Arms disabled by this stop (empty when no stop). */
	disabledArms: LatencyArmId[];
	evaluatedAt: string;
}

/**
 * Build a persisted rollout decision from the frozen snapshot + run evidence.
 * Attribution is known only for a registered single arm or a registered combination
 * (combinedArmId + exhaustive childArms); an unregistered multi-arm state stops with
 * missing_attribution.
 */
export function buildLatencyRolloutDecision(input: {
	workflowId: string;
	status: string;
	snapshot: LatencyArmSnapshotV1;
	observed: LatencyRolloutObservedV1;
	/** Arms that actually engaged during the run. Only these are causally rollbackable. */
	firedArms?: LatencyArmId[];
	cohort?: {
		completionDropPp?: number;
		reworkRisePct?: number;
		costP50Multiple?: number;
		costP95Multiple?: number;
		latencyImprovePct?: number;
		spawnedAgentsP95Multiple?: number;
	};
}): LatencyRolloutDecisionV1 {
	const active = LATENCY_ARM_IDS.filter(id => input.snapshot.arms[id] === true);
	const registeredCombination =
		active.length < 2 || Boolean(input.snapshot.combinedArmId && (input.snapshot.childArms?.length ?? 0) >= 2);
	const attributionKnown = registeredCombination;
	const decision = evaluateLatencyQualityStop({
		treatmentAttributedP0P1Escapes: input.observed.treatmentAttributedP0P1Escapes,
		attributionKnown,
		completionDropPp: input.cohort?.completionDropPp,
		reworkRisePct: input.cohort?.reworkRisePct,
		costP50Multiple: input.cohort?.costP50Multiple,
		costP95Multiple: input.cohort?.costP95Multiple,
		latencyImprovePct: input.cohort?.latencyImprovePct,
		spawnedAgentsP95Multiple: input.cohort?.spawnedAgentsP95Multiple,
	});
	// Causal rollback: only arms that actually engaged may be disabled. When a
	// stop fires but no active arm is in the fired set, fail closed on the whole
	// active set — an unattributable regression must not re-engage next run.
	const fired = input.firedArms?.filter(arm => active.includes(arm)) ?? [];
	const disabledArms = decision.stop ? (fired.length > 0 ? fired : active) : [];
	return {
		schemaVersion: 1,
		kind: LATENCY_ROLLOUT_DECISION_KIND,
		workflowId: input.workflowId,
		status: input.status,
		snapshot: input.snapshot,
		attributionKnown,
		observed: input.observed,
		decision,
		disabledArms,
		evaluatedAt: new Date().toISOString(),
	};
}
