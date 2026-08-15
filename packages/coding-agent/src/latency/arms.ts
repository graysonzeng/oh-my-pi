import { createHash, randomUUID } from "node:crypto";

/**
 * Independent latency-optimization arms (design A §6.2) plus orthogonal DSH
 * experiment dimensions (Scheme A). Defaults since the 2026-08-07 quality gate:
 * the low-risk fail-open bash pair plus the high-benefit ordinary-session pair
 * (context_optimization + read_dedupe) are on by default; every other
 * behavior-changing arm is off until its paired ≥30-task matrix passes. DSH
 * arms stay explicit false until assignment writes a treatment. Combined
 * latency experiments must use a separate combinedArmId listing child arms.
 */

export const BACKGROUND_LATENCY_ARM_IDS = [
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

export const DSH_ARM_IDS = [
	"dsh_session_search",
	"dsh_omit_goal_time",
	"dsh_goal_hash_shadow",
	"dsh_headless_continuation",
] as const;

export const LATENCY_ARM_IDS = [...BACKGROUND_LATENCY_ARM_IDS, ...DSH_ARM_IDS] as const;

export type BackgroundLatencyArmId = (typeof BACKGROUND_LATENCY_ARM_IDS)[number];
export type DshArmId = (typeof DSH_ARM_IDS)[number];
export type LatencyArmId = (typeof LATENCY_ARM_IDS)[number];

export const DSH_DIMENSION_IDS = ["dim.a1", "dim.a23", "dim.a4"] as const;
export type ExperimentDimensionId = (typeof DSH_DIMENSION_IDS)[number];
export type DshAssignmentRole = "treatment" | "control" | "excluded";

export const DSH_DIMENSION_ARMS = {
	"dim.a1": ["dsh_session_search"],
	"dim.a23": ["dsh_goal_hash_shadow", "dsh_omit_goal_time"],
	"dim.a4": ["dsh_headless_continuation"],
} as const satisfies Record<ExperimentDimensionId, readonly DshArmId[]>;

export interface DimensionSlice {
	id: ExperimentDimensionId;
	childArms: LatencyArmId[];
	assignedTreatment: boolean;
	treatment: boolean;
	stopApplied: boolean;
	role: DshAssignmentRole;
	cohortKey: string | null;
	controlKey: string | null;
}

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
	dsh_session_search: "latency.arms.dshSessionSearch",
	dsh_omit_goal_time: "latency.arms.dshOmitGoalTime",
	dsh_goal_hash_shadow: "latency.arms.dshGoalHashShadow",
	dsh_headless_continuation: "latency.arms.dshHeadlessContinuation",
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
	/** Orthogonal DSH experiment slices. Absent when no experiment is eligible. */
	dimensions?: DimensionSlice[] | null;
	/** Background latency fingerprint: `bg:<sorted>` or `bg:none`. */
	backgroundArmId?: string | null;
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
		dsh_session_search: false,
		dsh_omit_goal_time: false,
		dsh_goal_hash_shadow: false,
		dsh_headless_continuation: false,
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
	dimensions?: DimensionSlice[] | null;
	backgroundArmId?: string | null;
}): LatencyArmSnapshotV1 {
	const raw = input.arms ?? (input.getSetting ? resolveLatencyArmsFromSettings(input.getSetting) : emptyLatencyArms());
	const arms = { ...emptyLatencyArms(), ...raw };
	if (input.combinedArmId && (!input.childArms || input.childArms.length < 2)) {
		throw new Error("combinedArmId requires childArms with at least two arms");
	}
	if (input.childArms) {
		for (const child of input.childArms) {
			if (!isLatencyArmId(child)) throw new Error(`unknown child arm: ${child}`);
		}
	}
	const dimensions = normalizeFrozenDimensions(arms, input.dimensions);
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
		dimensions,
		backgroundArmId: input.backgroundArmId ?? backgroundArmIdFromArms(arms),
	};
	const fingerprint = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
	return { ...payload, fingerprint };
}

export function isLatencyArmId(value: string): value is LatencyArmId {
	return (LATENCY_ARM_IDS as readonly string[]).includes(value);
}

export function isDshArmId(value: string): value is DshArmId {
	return (DSH_ARM_IDS as readonly string[]).includes(value);
}

export function isExperimentDimensionId(value: string): value is ExperimentDimensionId {
	return (DSH_DIMENSION_IDS as readonly string[]).includes(value);
}

export function declaredDimensionArms(id: ExperimentDimensionId): LatencyArmId[] {
	return [...DSH_DIMENSION_ARMS[id]];
}

export function dimensionChildSetEqualsDeclared(id: ExperimentDimensionId, childArms: readonly string[]): boolean {
	const declared = declaredDimensionArms(id);
	if (childArms.length !== declared.length) return false;
	const sorted = [...childArms].sort();
	return declared.every((arm, index) => sorted[index] === arm);
}

export function backgroundFingerprint(arms: Record<LatencyArmId, boolean>): string {
	const active = BACKGROUND_LATENCY_ARM_IDS.filter(id => arms[id] === true).sort();
	return active.length > 0 ? active.join("+") : "none";
}

export function backgroundArmIdFromArms(arms: Record<LatencyArmId, boolean>): string {
	const fp = backgroundFingerprint(arms);
	return fp === "none" ? "bg:none" : `bg:${fp}`;
}

export function dshCohortKey(
	dimensionId: ExperimentDimensionId,
	role: Exclude<DshAssignmentRole, "excluded">,
	bgFingerprint: string,
): string {
	const side = role === "treatment" ? "t" : "c";
	return `dsh:${dimensionId}:${side}|bg:${bgFingerprint}`;
}

function normalizeFrozenDimensions(
	arms: Record<LatencyArmId, boolean>,
	input: DimensionSlice[] | null | undefined,
): DimensionSlice[] | null {
	if (!input || input.length === 0) return input ?? null;
	const a2 = arms.dsh_omit_goal_time === true;
	const a3 = arms.dsh_goal_hash_shadow === true;
	if (a2 !== a3) {
		arms.dsh_omit_goal_time = false;
		arms.dsh_goal_hash_shadow = false;
	}
	return input.map(slice => {
		const declared = declaredDimensionArms(slice.id);
		const exact = dimensionChildSetEqualsDeclared(slice.id, slice.childArms);
		const childArms = exact ? [...slice.childArms].sort() : declared;
		if (slice.id === "dim.a23" && a2 !== a3) {
			return {
				...slice,
				childArms,
				assignedTreatment: false,
				treatment: false,
				role: "excluded",
				cohortKey: null,
				controlKey: null,
			};
		}
		return { ...slice, childArms };
	});
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

/** DSH dimension stops from design §5.7.5. Rate rules stay off below min sample. */
export const DSH_QUALITY_STOP = {
	a1GetBranchErrorRate: 0.05,
	a1GetBranchWindowMs: 5 * 60 * 1000,
	a23ZeroInjectionRate: 0.02,
	nonInferiorityPp: 10,
	a1A23MinSamples: 200,
	a4MinSamples: 100,
	a4Cap: 20,
} as const;

export type LatencyQualityStopReason =
	| "p0p1_escape"
	| "completion_drop"
	| "rework_rise"
	| "missing_attribution"
	| "cost_breach"
	| "latency_miss"
	| "spawned_agents_breach"
	| "dsh_a1_get_branch"
	| "dsh_a23_zero_injection"
	| "dsh_a4_cap"
	| "dsh_non_inferiority";

export type LatencyQualityStopDecision =
	| { stop: false; reason: null }
	| { stop: true; reason: LatencyQualityStopReason };

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
	dshA1GetBranchErrorRate?: number;
	dshA23ZeroInjectionRate?: number;
	dshA4CapViolations?: number;
	dshNonInferiorityDropPp?: number;
	dshMinSampleMet?: boolean;
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
	if ((input.dshA4CapViolations ?? 0) > 0) {
		return { stop: true, reason: "dsh_a4_cap" };
	}
	if (input.dshMinSampleMet === false) return { stop: false, reason: null };
	if (
		typeof input.dshA1GetBranchErrorRate === "number" &&
		input.dshA1GetBranchErrorRate > DSH_QUALITY_STOP.a1GetBranchErrorRate
	) {
		return { stop: true, reason: "dsh_a1_get_branch" };
	}
	if (
		typeof input.dshA23ZeroInjectionRate === "number" &&
		input.dshA23ZeroInjectionRate > DSH_QUALITY_STOP.a23ZeroInjectionRate
	) {
		return { stop: true, reason: "dsh_a23_zero_injection" };
	}
	if (
		typeof input.dshNonInferiorityDropPp === "number" &&
		input.dshNonInferiorityDropPp > DSH_QUALITY_STOP.nonInferiorityPp
	) {
		return { stop: true, reason: "dsh_non_inferiority" };
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
	const active = BACKGROUND_LATENCY_ARM_IDS.filter(id => arms[id] === true);
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
	event_id?: string;
	revision?: string;
	scope?: "machine";
	reason?: string;
	expiresAt?: string;
}

export function snapshotHasEligibleDshDimension(snapshot: LatencyArmSnapshotV1): boolean {
	return (snapshot.dimensions ?? []).some(slice => slice.role !== "excluded");
}

export function dimensionAttributionKnown(snapshot: LatencyArmSnapshotV1, dimensionId: ExperimentDimensionId): boolean {
	const slice = snapshot.dimensions?.find(item => item.id === dimensionId);
	if (!slice || slice.role === "excluded") return false;
	return dimensionChildSetEqualsDeclared(dimensionId, slice.childArms);
}

/**
 * Build a persisted rollout decision from the frozen snapshot + run evidence.
 * Attribution is known only for a registered single arm or a registered combination
 * (combinedArmId + exhaustive childArms); an unregistered multi-arm state stops with
 * missing_attribution. DSH dimensions require exact declared childArms.
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
	now?: string;
	reason?: string;
	targetDimensionId?: ExperimentDimensionId;
	dsh?: {
		a1GetBranchErrorRate?: number;
		a23ZeroInjectionRate?: number;
		a4CapViolations?: number;
		nonInferiorityDropPp?: number;
		minSampleMet?: boolean;
	};
}): LatencyRolloutDecisionV1 {
	const activeBackground = BACKGROUND_LATENCY_ARM_IDS.filter(id => input.snapshot.arms[id] === true);
	const activeDsh = DSH_ARM_IDS.filter(id => input.snapshot.arms[id] === true);
	const active = [...activeBackground, ...activeDsh];
	const eligibleDims = (input.snapshot.dimensions ?? []).filter(slice => slice.role !== "excluded");
	const targetDim = input.targetDimensionId
		? eligibleDims.find(slice => slice.id === input.targetDimensionId)
		: undefined;
	let attributionKnown: boolean;
	if (targetDim) {
		attributionKnown = dimensionChildSetEqualsDeclared(targetDim.id, targetDim.childArms);
	} else if (eligibleDims.length > 0) {
		const dimsKnown = eligibleDims.every(slice => dimensionChildSetEqualsDeclared(slice.id, slice.childArms));
		const unregisteredSuperset = activeDsh.some(arm => !eligibleDims.some(slice => slice.childArms.includes(arm)));
		attributionKnown = dimsKnown && !unregisteredSuperset;
	} else {
		const registeredCombination =
			activeBackground.length < 2 ||
			Boolean(input.snapshot.combinedArmId && (input.snapshot.childArms?.length ?? 0) >= 2);
		attributionKnown = registeredCombination;
	}
	const decision = evaluateLatencyQualityStop({
		treatmentAttributedP0P1Escapes: input.observed.treatmentAttributedP0P1Escapes,
		attributionKnown,
		completionDropPp: input.cohort?.completionDropPp,
		reworkRisePct: input.cohort?.reworkRisePct,
		costP50Multiple: input.cohort?.costP50Multiple,
		costP95Multiple: input.cohort?.costP95Multiple,
		latencyImprovePct: input.cohort?.latencyImprovePct,
		spawnedAgentsP95Multiple: input.cohort?.spawnedAgentsP95Multiple,
		dshA1GetBranchErrorRate: input.dsh?.a1GetBranchErrorRate,
		dshA23ZeroInjectionRate: input.dsh?.a23ZeroInjectionRate,
		dshA4CapViolations: input.dsh?.a4CapViolations,
		dshNonInferiorityDropPp: input.dsh?.nonInferiorityDropPp,
		dshMinSampleMet: input.dsh?.minSampleMet,
	});
	const fired = input.firedArms?.filter(arm => active.includes(arm)) ?? [];
	let disabledArms: LatencyArmId[] = [];
	if (decision.stop) {
		if (targetDim) {
			const firedOnDim = targetDim.childArms.filter(arm => fired.includes(arm));
			disabledArms = firedOnDim.length > 0 ? firedOnDim : [...targetDim.childArms];
		} else if (eligibleDims.length > 0) {
			const firedDims = eligibleDims.filter(slice => slice.childArms.some(arm => fired.includes(arm)));
			const targetDims = firedDims.length > 0 ? firedDims : eligibleDims;
			disabledArms = [...new Set(targetDims.flatMap(slice => slice.childArms))];
		} else {
			disabledArms = fired.length > 0 ? fired : active;
		}
	}
	const evaluatedAt = input.now ?? new Date().toISOString();
	const revision = randomUUID();
	const expiresAt = new Date(Date.parse(evaluatedAt) + 30 * 24 * 60 * 60 * 1000).toISOString();
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
		evaluatedAt,
		event_id: `dshdec:${revision}`,
		revision,
		scope: "machine",
		reason: input.reason ?? decision.reason ?? "none",
		expiresAt,
	};
}
