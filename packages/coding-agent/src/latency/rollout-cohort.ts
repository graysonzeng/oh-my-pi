import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stableStringifyJson } from "@oh-my-pi/pi-utils";
import {
	BACKGROUND_LATENCY_ARM_IDS,
	buildLatencyRolloutDecision,
	DSH_QUALITY_STOP,
	declaredDimensionArms,
	type ExperimentDimensionId,
	emptyLatencyArms,
	freezeLatencyArmSnapshot,
	isLatencyArmId,
	LATENCY_ARM_SETTINGS,
	LATENCY_ROLLOUT_DECISION_KIND,
	type LatencyArmId,
	type LatencyArmSnapshotV1,
	type LatencyRolloutDecisionV1,
} from "./arms";
import {
	type DshAssignmentV1,
	type DshExperimentId,
	type ExperimentDefinitionV1,
	isDshExperimentId,
} from "./assignment";

export const LATENCY_ROLLOUT_OBSERVATION_KIND = "latency_rollout_observation" as const;
export const LATENCY_ROLLOUT_OBSERVATION_VERSION = 1 as const;
export const DSH_ARM_ASSIGNMENT_KIND = "dsh-arm-assignment" as const;
export const DSH_RUN_INTENT_KIND = "dsh-run-intent" as const;
export const DSH_EXPERIMENT_DEFINITION_KIND = "dsh-experiment-definition" as const;
export const DSH_OPERATOR_ACK_KIND = "dsh-operator-ack" as const;
/** Baseline key for runs with no active arm. */
export const LATENCY_BASELINE_COHORT_KEY = "baseline" as const;
/**
 * Minimum treatment + baseline samples before cohort-derived thresholds
 * (completion/rework/cost/latency/spawned) activate. Below this, only the
 * zero-tolerance P0/P1 and attribution rules apply — a handful of runs is too
 * noisy to disable arms on. Paired quality pairs still require the design's
 * ≥30-task matrix; this guard only decides when the production guardrail has
 * enough signal to act without flaking.
 */
export const LATENCY_COHORT_MIN_SAMPLES = 8;
export const DSH_DECISION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type DshObservationPhase = "metrics";

export type OrdinaryVerifierSource = "session_stop" | "extension" | "unknown";
export type OrdinaryVerifierStatus = "passed" | "failed" | "unknown";

/** Stable ordinary model/profile/arm decision identity. Missing sides remain null. */
export interface OrdinaryDecisionAttributionV1 {
	provider: string | null;
	model: string | null;
	profileId: string | null;
	armFingerprint: string | null;
	fingerprint: string;
}

/** Explicit verifier outcome; unknown is distinct from success. */
export interface OrdinaryVerifierOutcomeV1 {
	source: OrdinaryVerifierSource;
	status: OrdinaryVerifierStatus;
}

/** Observable work metrics. Missing counters remain null rather than reading as zero. */
export interface OrdinaryWorkMetricsV1 {
	wallClockMs: number | null;
	toolCallCount: number | null;
	repeatedReadCount: number | null;
	repeatedGrepCount: number | null;
	fallbackCount: number | null;
	userCorrectionCount: number | null;
}

export interface OrdinarySessionObservationInput {
	provider?: string | null;
	model?: string | null;
	profileId?: string | null;
	armFingerprint?: string | null;
	startedAt?: string | null;
	endedAt: string;
	toolCallCount?: number | null;
	toolCalls?: readonly { name: string; arguments?: Record<string, unknown> }[];
	fallbackCount?: number | null;
	userCorrectionCount?: number | null;
	verifierSource?: OrdinaryVerifierSource;
	verifierStatus?: OrdinaryVerifierStatus;
}

export interface OrdinarySessionObservationJoinV1 {
	ordinaryAttribution: OrdinaryDecisionAttributionV1 | null;
	verifier: OrdinaryVerifierOutcomeV1;
	workMetrics: OrdinaryWorkMetricsV1;
}

/**
 * One completed run (workflow terminal or ordinary-session teardown) recorded
 * for cohort aggregation. Fields are null when the run did not track them;
 * aggregations skip nulls so a missing signal never reads as zero.
 */
export interface LatencyRolloutObservationV1 {
	schemaVersion: typeof LATENCY_ROLLOUT_OBSERVATION_VERSION;
	kind: typeof LATENCY_ROLLOUT_OBSERVATION_KIND;
	/** Cohort key: single active arm id, registered combinedArmId, or "baseline". */
	key: string;
	workflowId?: string;
	status: string;
	completed: boolean;
	repairCycles: number | null;
	p0p1Escapes: number | null;
	costUsd: number | null;
	stageTimeMs: number | null;
	spawnedAgents: number | null;
	/** Arms that actually engaged during the run (treatment receipts). */
	firedArms: LatencyArmId[];
	endedAt: string;
	event_id?: string;
	phase?: DshObservationPhase;
	snapshotFingerprint?: string | null;
	sessionId?: string | null;
	experimentId?: DshExperimentId | null;
	dimensionId?: "dim.a1" | "dim.a23" | "dim.a4" | null;
	assignmentRestored?: boolean | null;
	bgFingerprint?: string | null;
	sampleUnit?: "session";
	stopApplied?: boolean | null;
	dshGetBranchError?: boolean | null;
	dshGoalInjected?: boolean | null;
	dshAdjacentIdentical?: boolean | null;
	dshHeadlessCount?: number | null;
	/** Ordinary model/profile/arm decision identity. Optional for old JSONL. */
	ordinaryAttribution?: OrdinaryDecisionAttributionV1 | null;
	/** Explicit final verifier state. Optional for old JSONL. */
	verifier?: OrdinaryVerifierOutcomeV1 | null;
	/** Observable ordinary-session work metrics. Optional for old JSONL. */
	workMetrics?: OrdinaryWorkMetricsV1 | null;
}

function nullableString(value: string | null | undefined): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function nullableCount(value: number | null | undefined): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function ordinaryWallClockMs(startedAt: string | null | undefined, endedAt: string): number | null {
	if (!startedAt) return null;
	const started = Date.parse(startedAt);
	const ended = Date.parse(endedAt);
	return Number.isFinite(started) && Number.isFinite(ended) && ended >= started ? ended - started : null;
}

function countRepeatedCalls(
	toolCalls: OrdinarySessionObservationInput["toolCalls"],
	toolName: "read" | "grep",
): number | null {
	if (!toolCalls) return null;
	const seen = new Set<string>();
	let repeated = 0;
	for (const call of toolCalls) {
		if (call.name !== toolName) continue;
		const fingerprint = stableStringifyJson(call.arguments ?? {});
		if (seen.has(fingerprint)) repeated += 1;
		else seen.add(fingerprint);
	}
	return repeated;
}

/** Joinable ordinary-session receipt fragment for latency cohort observations. */
export function buildOrdinarySessionObservationJoin(
	input: OrdinarySessionObservationInput,
): OrdinarySessionObservationJoinV1 {
	const provider = nullableString(input.provider);
	const model = nullableString(input.model);
	const profileId = nullableString(input.profileId);
	const armFingerprint = nullableString(input.armFingerprint);
	const attributionPayload = { provider, model, profileId, armFingerprint };
	const ordinaryAttribution =
		provider || model || profileId || armFingerprint
			? {
					...attributionPayload,
					fingerprint: createHash("sha256").update(stableStringifyJson(attributionPayload)).digest("hex"),
				}
			: null;
	const toolCallCount = nullableCount(input.toolCallCount) ?? (input.toolCalls ? input.toolCalls.length : null);

	return {
		ordinaryAttribution,
		verifier: {
			source: input.verifierSource ?? "unknown",
			status: input.verifierStatus ?? "unknown",
		},
		workMetrics: {
			wallClockMs: ordinaryWallClockMs(input.startedAt, input.endedAt),
			toolCallCount,
			repeatedReadCount: countRepeatedCalls(input.toolCalls, "read"),
			repeatedGrepCount: countRepeatedCalls(input.toolCalls, "grep"),
			fallbackCount: nullableCount(input.fallbackCount),
			userCorrectionCount: nullableCount(input.userCorrectionCount),
		},
	};
}

export interface DshArmAssignmentRecordV1 {
	kind: typeof DSH_ARM_ASSIGNMENT_KIND;
	event_id: string;
	sessionId: string;
	payload: DshAssignmentV1;
	endedAt: string;
}

export interface DshRunIntentRecordV1 {
	kind: typeof DSH_RUN_INTENT_KIND;
	event_id: string;
	sessionId: string;
	experimentId: DshExperimentId;
	executionId: string;
	state: "pending" | "committed";
	startedAt: string;
	committedAt: string | null;
	metricsEventId: string | null;
	expiresAt: string;
}

export interface DshOperatorAckRecordV1 {
	kind: typeof DSH_OPERATOR_ACK_KIND;
	event_id: string;
	bootNonce: string;
	createdAt: string;
}

export interface DshFenceRecordV1 {
	revision: string;
	disabledArms: LatencyArmId[];
	evaluatedAt: string;
	expiresAt: string;
}

export type CohortFileRecord =
	| LatencyRolloutObservationV1
	| DshArmAssignmentRecordV1
	| DshRunIntentRecordV1
	| LatencyRolloutDecisionV1
	| ExperimentDefinitionV1
	| DshOperatorAckRecordV1;

export interface ParsedCohortRecords {
	observations: LatencyRolloutObservationV1[];
	assignments: DshArmAssignmentRecordV1[];
	intents: DshRunIntentRecordV1[];
	decisions: LatencyRolloutDecisionV1[];
	definitions: ExperimentDefinitionV1[];
	acks: DshOperatorAckRecordV1[];
	rejectedAssignmentPhase: number;
}

export interface CompletenessResult {
	complete: boolean;
	stops: LatencyRolloutDecisionV1[];
	belowMinSample: boolean;
}

export interface ProcessScopedRolloutContext {
	bootNonce: string;
	startupAt: string;
}

let processScopedRolloutContext: ProcessScopedRolloutContext | undefined;

export function installProcessScopedRolloutContext(context: ProcessScopedRolloutContext): ProcessScopedRolloutContext {
	processScopedRolloutContext = context;
	return context;
}

export function getProcessScopedRolloutContext(): ProcessScopedRolloutContext | undefined {
	return processScopedRolloutContext;
}

export function mintProcessScopedRolloutContext(): ProcessScopedRolloutContext {
	if (processScopedRolloutContext) return processScopedRolloutContext;
	processScopedRolloutContext = { bootNonce: randomUUID(), startupAt: new Date().toISOString() };
	return processScopedRolloutContext;
}

/** Deterministic cohort key for a frozen arm snapshot. */
export function deriveLatencyCohortKey(snapshot: Pick<LatencyArmSnapshotV1, "arms" | "combinedArmId">): string {
	const active = BACKGROUND_LATENCY_ARM_IDS.filter(id => snapshot.arms[id] === true);
	if (active.length === 0) return LATENCY_BASELINE_COHORT_KEY;
	if (active.length === 1) return active[0]!;
	return snapshot.combinedArmId ?? `combined:${[...active].sort().join("+")}`;
}

/** Nearest-rank percentile over a sorted numeric array; undefined when empty. */
export function percentile(sorted: number[], p: number): number | undefined {
	if (sorted.length === 0) return undefined;
	const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[rank]!;
}

export interface LatencyCohortSummary {
	key: string;
	count: number;
	completed: number;
	completionRate: number;
	meanRepairCycles: number | undefined;
	p0p1Escapes: number;
	costP50: number | undefined;
	costP95: number | undefined;
	stageTimeP50: number | undefined;
	stageTimeP95: number | undefined;
	spawnedP95: number | undefined;
}

function sortedNonNull(values: (number | null)[]): number[] {
	return values.filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
}

/** Aggregate a cohort. Returns undefined below the minimum sample guard. */
export function summarizeLatencyCohort(observations: LatencyRolloutObservationV1[]): LatencyCohortSummary | undefined {
	const valid = observations.filter(o => o.key !== undefined && typeof o.completed === "boolean");
	if (valid.length === 0 || valid.length < LATENCY_COHORT_MIN_SAMPLES) return undefined;
	const completed = valid.filter(o => o.completed).length;
	const repair = sortedNonNull(valid.map(o => o.repairCycles));
	const p0p1 = valid.map(o => o.p0p1Escapes ?? 0).reduce((a, b) => a + b, 0);
	const cost = sortedNonNull(valid.map(o => o.costUsd));
	const stage = sortedNonNull(valid.map(o => o.stageTimeMs));
	const spawned = sortedNonNull(valid.map(o => o.spawnedAgents));
	const mean = (arr: number[]): number | undefined =>
		arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : undefined;
	return {
		key: valid[0]!.key,
		count: valid.length,
		completed,
		completionRate: completed / valid.length,
		meanRepairCycles: mean(repair),
		p0p1Escapes: p0p1,
		costP50: percentile(cost, 50),
		costP95: percentile(cost, 95),
		stageTimeP50: percentile(stage, 50),
		stageTimeP95: percentile(stage, 95),
		spawnedP95: percentile(spawned, 95),
	};
}

/**
 * Compare a treatment cohort against the baseline cohort and produce the
 * guardrail inputs for `evaluateLatencyQualityStop`. Each metric is emitted
 * only when both sides have a real value; a missing side disables that
 * threshold rather than inventing a number.
 */
export function computeLatencyCohortMetrics(
	treatment: LatencyCohortSummary,
	baseline: LatencyCohortSummary,
): {
	completionDropPp?: number;
	reworkRisePct?: number;
	costP50Multiple?: number;
	costP95Multiple?: number;
	latencyImprovePct?: number;
	spawnedAgentsP95Multiple?: number;
} {
	const metrics: ReturnType<typeof computeLatencyCohortMetrics> = {};
	metrics.completionDropPp = Math.round((baseline.completionRate - treatment.completionRate) * 1000) / 10;
	if (typeof treatment.meanRepairCycles === "number" && typeof baseline.meanRepairCycles === "number") {
		// Rise from a zero baseline is unbounded; cap at 1000 (well past the 10% stop threshold).
		metrics.reworkRisePct =
			baseline.meanRepairCycles > 0
				? Math.round(
						((treatment.meanRepairCycles - baseline.meanRepairCycles) / baseline.meanRepairCycles) * 1000,
					) / 10
				: treatment.meanRepairCycles > 0
					? 1000
					: 0;
	}
	if (typeof treatment.costP50 === "number" && typeof baseline.costP50 === "number" && baseline.costP50 > 0) {
		metrics.costP50Multiple = treatment.costP50 / baseline.costP50;
	}
	if (typeof treatment.costP95 === "number" && typeof baseline.costP95 === "number" && baseline.costP95 > 0) {
		metrics.costP95Multiple = treatment.costP95 / baseline.costP95;
	}
	if (
		typeof treatment.stageTimeP50 === "number" &&
		typeof baseline.stageTimeP50 === "number" &&
		baseline.stageTimeP50 > 0
	) {
		metrics.latencyImprovePct =
			Math.round(((baseline.stageTimeP50 - treatment.stageTimeP50) / baseline.stageTimeP50) * 1000) / 10;
	}
	if (typeof treatment.spawnedP95 === "number" && typeof baseline.spawnedP95 === "number" && baseline.spawnedP95 > 0) {
		metrics.spawnedAgentsP95Multiple = treatment.spawnedP95 / baseline.spawnedP95;
	}
	return metrics;
}

/** Default durable location shared by every session/process on this machine. */
export function defaultLatencyRolloutCohortFile(): string {
	return path.join(os.homedir(), ".omp", "workflow-artifacts", "latency-rollout-cohort.jsonl");
}

function isIso8601(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function laterIso(a: string, b: string): boolean {
	const aMs = Date.parse(a);
	const bMs = Date.parse(b);
	if (aMs === bMs) return false;
	return aMs > bMs;
}

function sortedArmKey(arms: readonly string[]): string {
	return [...arms].sort().join("+");
}

export function parseCohortFileRecords(raw: string): ParsedCohortRecords {
	const observations: LatencyRolloutObservationV1[] = [];
	const assignments: DshArmAssignmentRecordV1[] = [];
	const intents: DshRunIntentRecordV1[] = [];
	const decisions: LatencyRolloutDecisionV1[] = [];
	const definitions: ExperimentDefinitionV1[] = [];
	const acks: DshOperatorAckRecordV1[] = [];
	let rejectedAssignmentPhase = 0;
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		const kind = parsed.kind;
		if (kind === LATENCY_ROLLOUT_OBSERVATION_KIND) {
			if (typeof parsed.key !== "string" || typeof parsed.completed !== "boolean") continue;
			if (parsed.phase === "assignment") {
				rejectedAssignmentPhase += 1;
				continue;
			}
			observations.push({
				...(parsed as unknown as LatencyRolloutObservationV1),
				phase: parsed.phase === "metrics" || parsed.phase === undefined ? "metrics" : "metrics",
			});
			continue;
		}
		if (kind === DSH_ARM_ASSIGNMENT_KIND) {
			const payload = parsed.payload as DshAssignmentV1 | undefined;
			if (typeof parsed.sessionId !== "string" || !payload?.fingerprint || !isIso8601(parsed.endedAt)) continue;
			assignments.push(parsed as unknown as DshArmAssignmentRecordV1);
			continue;
		}
		if (kind === DSH_RUN_INTENT_KIND) {
			if (
				typeof parsed.sessionId !== "string" ||
				!isDshExperimentId(String(parsed.experimentId)) ||
				typeof parsed.executionId !== "string" ||
				!isIso8601(parsed.startedAt) ||
				(parsed.state !== "pending" && parsed.state !== "committed")
			) {
				continue;
			}
			intents.push(parsed as unknown as DshRunIntentRecordV1);
			continue;
		}
		if (kind === LATENCY_ROLLOUT_DECISION_KIND) {
			if (!Array.isArray(parsed.disabledArms) || typeof parsed.revision !== "string") continue;
			if (
				Array.isArray(parsed.targetArms) &&
				sortedArmKey(parsed.targetArms as string[]) !== sortedArmKey(parsed.disabledArms as string[])
			) {
				continue;
			}
			decisions.push(parsed as unknown as LatencyRolloutDecisionV1);
			continue;
		}
		if (kind === DSH_EXPERIMENT_DEFINITION_KIND) {
			if (!isDshExperimentId(String(parsed.experimentId)) || typeof parsed.salt !== "string") continue;
			if (!isIso8601(parsed.windowStart) || !isIso8601(parsed.windowEnd)) continue;
			definitions.push(parsed as unknown as ExperimentDefinitionV1);
			continue;
		}
		if (kind === DSH_OPERATOR_ACK_KIND) {
			if (typeof parsed.bootNonce !== "string" || !isIso8601(parsed.createdAt)) continue;
			acks.push(parsed as unknown as DshOperatorAckRecordV1);
		}
	}
	return { observations, assignments, intents, decisions, definitions, acks, rejectedAssignmentPhase };
}

function latestBy<T>(items: T[], keyOf: (item: T) => string, timeOf: (item: T) => string): Map<string, T> {
	const won = new Map<string, T>();
	for (const item of items) {
		const key = keyOf(item);
		const prev = won.get(key);
		if (!prev || laterIso(timeOf(item), timeOf(prev)) || timeOf(item) === timeOf(prev)) won.set(key, item);
	}
	return won;
}

export function replayObservations(observations: LatencyRolloutObservationV1[]): LatencyRolloutObservationV1[] {
	const metrics = observations.filter(item => (item.phase ?? "metrics") === "metrics");
	return [
		...latestBy(
			metrics,
			item => item.event_id ?? `${item.sessionId ?? ""}:${item.key}:${item.endedAt}`,
			item => item.endedAt,
		).values(),
	];
}

export function replayIntents(intents: DshRunIntentRecordV1[]): DshRunIntentRecordV1[] {
	const won = new Map<string, DshRunIntentRecordV1>();
	for (const item of intents) {
		const prev = won.get(item.event_id);
		if (!prev) {
			won.set(item.event_id, item);
			continue;
		}
		if (prev.executionId !== item.executionId) {
			won.set(item.event_id, item);
			continue;
		}
		if (item.state === "committed" || prev.state !== "committed") won.set(item.event_id, item);
	}
	return [...won.values()];
}

function sleepSync(ms: number): void {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		// bounded sync retry delay for durable-before-evaluate
	}
}

export interface DshDimensionStopMetrics {
	a1GetBranchErrorRate?: number;
	a23ZeroInjectionRate?: number;
	a4CapViolations: number;
	nonInferiorityDropPp?: number;
	minSampleMet: boolean;
}

function observationRole(item: LatencyRolloutObservationV1): "treatment" | "control" | null {
	if (item.key.includes(":t|")) return "treatment";
	if (item.key.includes(":c|")) return "control";
	return null;
}

function dimensionOf(item: LatencyRolloutObservationV1): ExperimentDimensionId | null {
	if (item.dimensionId === "dim.a1" || item.dimensionId === "dim.a23" || item.dimensionId === "dim.a4") {
		return item.dimensionId;
	}
	return null;
}

/** Efficacy/NI/rate inputs per DSH dimension. stopApplied rows stay out of rates. */
export function summarizeDshDimensionMetrics(
	observations: LatencyRolloutObservationV1[],
	nowMs: number,
): Map<ExperimentDimensionId, DshDimensionStopMetrics> {
	const out = new Map<ExperimentDimensionId, DshDimensionStopMetrics>();
	const dims: ExperimentDimensionId[] = ["dim.a1", "dim.a23", "dim.a4"];
	for (const dim of dims) {
		const rows = observations.filter(item => dimensionOf(item) === dim);
		const efficacy = rows.filter(item => item.stopApplied !== true);
		const treatment = efficacy.filter(item => observationRole(item) === "treatment");
		const minNeeded = dim === "dim.a4" ? DSH_QUALITY_STOP.a4MinSamples : DSH_QUALITY_STOP.a1A23MinSamples;
		const a4CapViolations = rows.filter(
			item => typeof item.dshHeadlessCount === "number" && item.dshHeadlessCount > DSH_QUALITY_STOP.a4Cap,
		).length;
		let a1GetBranchErrorRate: number | undefined;
		if (dim === "dim.a1") {
			const windowed = treatment.filter(
				item => Date.parse(item.endedAt) >= nowMs - DSH_QUALITY_STOP.a1GetBranchWindowMs,
			);
			if (windowed.length > 0) {
				a1GetBranchErrorRate = windowed.filter(item => item.dshGetBranchError === true).length / windowed.length;
			}
		}
		let a23ZeroInjectionRate: number | undefined;
		if (dim === "dim.a23" && treatment.length > 0) {
			a23ZeroInjectionRate = treatment.filter(item => item.dshGoalInjected === false).length / treatment.length;
		}
		let nonInferiorityDropPp: number | undefined;
		const byBg = new Map<string, { t: LatencyRolloutObservationV1[]; c: LatencyRolloutObservationV1[] }>();
		for (const item of efficacy) {
			const bg = item.bgFingerprint ?? "none";
			const bucket = byBg.get(bg) ?? { t: [], c: [] };
			const role = observationRole(item);
			if (role === "treatment") bucket.t.push(item);
			if (role === "control") bucket.c.push(item);
			byBg.set(bg, bucket);
		}
		let worstDrop: number | undefined;
		for (const bucket of byBg.values()) {
			if (bucket.t.length === 0 || bucket.c.length === 0) continue;
			const tRate = bucket.t.filter(item => item.completed).length / bucket.t.length;
			const cRate = bucket.c.filter(item => item.completed).length / bucket.c.length;
			const dropPp = Math.round((cRate - tRate) * 1000) / 10;
			worstDrop = worstDrop === undefined ? dropPp : Math.max(worstDrop, dropPp);
		}
		if (worstDrop !== undefined) nonInferiorityDropPp = worstDrop;
		out.set(dim, {
			a1GetBranchErrorRate,
			a23ZeroInjectionRate,
			a4CapViolations,
			nonInferiorityDropPp,
			minSampleMet: efficacy.length >= minNeeded,
		});
	}
	return out;
}

export class LatencyRolloutCohortStore {
	readonly #file: string;
	readonly #dir: string;
	readonly bootNonce: string | null;
	readonly startupAt: string | null;
	#ackAcceptedForBoot = false;
	#controlPlaneDegraded = false;
	#abortExit: ((code: number) => never) | undefined;

	constructor(
		file: string = defaultLatencyRolloutCohortFile(),
		context?: ProcessScopedRolloutContext,
		options?: { abortExit?: (code: number) => never },
	) {
		this.#file = file;
		this.#dir = path.dirname(file);
		const scoped = context ?? getProcessScopedRolloutContext();
		this.bootNonce = scoped?.bootNonce ?? null;
		this.startupAt = scoped?.startupAt ?? null;
		this.#abortExit = options?.abortExit;
	}

	get controlPlaneDegraded(): boolean {
		return this.#controlPlaneDegraded;
	}

	get ackAcceptedForBoot(): boolean {
		return this.#ackAcceptedForBoot;
	}

	markControlPlaneDegraded(): void {
		this.#controlPlaneDegraded = true;
	}

	#ensureDir(): void {
		fs.mkdirSync(this.#dir, { recursive: true });
	}

	#appendLine(record: object): boolean {
		try {
			this.#ensureDir();
			fs.appendFileSync(this.#file, `${JSON.stringify(record)}\n`, { flag: "a" });
			return true;
		} catch {
			return false;
		}
	}

	#readRaw(): string | null {
		try {
			return fs.readFileSync(this.#file, "utf8");
		} catch {
			return null;
		}
	}

	append(observation: LatencyRolloutObservationV1): void {
		this.#appendLine({ phase: "metrics", sampleUnit: "session", ...observation });
	}

	appendObservation(observation: LatencyRolloutObservationV1): boolean {
		return this.#appendLine({ phase: "metrics", sampleUnit: "session", ...observation });
	}

	appendAssignment(record: DshArmAssignmentRecordV1): boolean {
		return this.#appendLine(record);
	}

	appendRunIntent(record: DshRunIntentRecordV1): boolean {
		return this.#appendLine(record);
	}

	appendExperimentDefinition(record: ExperimentDefinitionV1): boolean {
		return this.#appendLine({ ...record, kind: DSH_EXPERIMENT_DEFINITION_KIND });
	}

	appendOperatorAck(record: Omit<DshOperatorAckRecordV1, "kind" | "event_id">): boolean {
		return this.#appendLine({
			kind: DSH_OPERATOR_ACK_KIND,
			event_id: `dshack:${record.bootNonce}`,
			...record,
		});
	}

	consumeOperatorAck(now: string = new Date().toISOString()): boolean {
		if (this.#ackAcceptedForBoot) return true;
		if (!this.bootNonce || !this.startupAt) return false;
		const startupMs = Date.parse(this.startupAt);
		for (const ack of this.readAllRecords().acks) {
			if (ack.bootNonce !== this.bootNonce) continue;
			if (Date.parse(ack.createdAt) < startupMs) continue;
			if (Date.parse(ack.createdAt) > Date.parse(now)) continue;
			this.#ackAcceptedForBoot = true;
			return true;
		}
		return false;
	}

	readAll(): LatencyRolloutObservationV1[] {
		const raw = this.#readRaw();
		if (raw === null) return [];
		return parseCohortFileRecords(raw).observations.filter(item => (item.phase ?? "metrics") === "metrics");
	}

	readAllRecords(): ParsedCohortRecords {
		const raw = this.#readRaw();
		if (raw === null) {
			return {
				observations: [],
				assignments: [],
				intents: [],
				decisions: [],
				definitions: [],
				acks: [],
				rejectedAssignmentPhase: 0,
			};
		}
		return parseCohortFileRecords(raw);
	}

	summaryForKey(key: string): LatencyCohortSummary | undefined {
		return summarizeLatencyCohort(this.readAll().filter(o => o.key === key));
	}

	#fencePath(revision: string): string {
		return path.join(this.#dir, `latency-rollout-cohort.fence.${revision}`);
	}

	readFenceDecisions(now: string = new Date().toISOString()): DshFenceRecordV1[] {
		let names: string[];
		try {
			names = fs.readdirSync(this.#dir);
		} catch {
			return [];
		}
		const nowMs = Date.parse(now);
		const fences: DshFenceRecordV1[] = [];
		for (const name of names) {
			if (!name.startsWith("latency-rollout-cohort.fence.")) continue;
			try {
				const parsed = JSON.parse(fs.readFileSync(path.join(this.#dir, name), "utf8")) as DshFenceRecordV1;
				if (
					typeof parsed.revision !== "string" ||
					!Array.isArray(parsed.disabledArms) ||
					!isIso8601(parsed.expiresAt)
				) {
					continue;
				}
				if (Date.parse(parsed.expiresAt) <= nowMs) continue;
				fences.push(parsed);
			} catch {
				// skip corrupt fence
			}
		}
		return fences;
	}

	readActiveDecisions(now: string = new Date().toISOString()): LatencyArmId[] {
		const nowMs = Date.parse(now);
		const disabled = new Set<LatencyArmId>();
		for (const fence of this.readFenceDecisions(now)) {
			for (const arm of fence.disabledArms) {
				if (isLatencyArmId(arm)) disabled.add(arm);
			}
		}
		const decisions = this.readAllRecords().decisions.filter(item => {
			if (!Array.isArray(item.disabledArms)) return false;
			if (item.expiresAt && Date.parse(item.expiresAt) <= nowMs) return false;
			return true;
		});
		const won = latestBy(
			decisions,
			item => sortedArmKey(item.disabledArms),
			item => `${item.evaluatedAt}:${item.revision ?? ""}`,
		);
		for (const decision of won.values()) {
			for (const arm of decision.disabledArms) {
				if (isLatencyArmId(arm)) disabled.add(arm);
			}
		}
		return [...disabled];
	}

	applyDecisionsToGetSetting(get: (path: string) => unknown, now?: string): (path: string) => unknown {
		const disabled = new Set(this.readActiveDecisions(now));
		return (settingPath: string) => {
			for (const [arm, pathValue] of Object.entries(LATENCY_ARM_SETTINGS)) {
				if (settingPath === pathValue && disabled.has(arm as LatencyArmId)) return false;
			}
			return get(settingPath);
		};
	}

	readActiveExperimentDefs(
		now: string = new Date().toISOString(),
	): Partial<Record<DshExperimentId, ExperimentDefinitionV1>> {
		const nowMs = Date.parse(now);
		const won = latestBy(
			this.readAllRecords().definitions,
			item => item.experimentId,
			item => `${item.evaluatedAt}:${item.revision}`,
		);
		const active: Partial<Record<DshExperimentId, ExperimentDefinitionV1>> = {};
		for (const def of won.values()) {
			if (Date.parse(def.windowStart) <= nowMs && nowMs < Date.parse(def.windowEnd)) {
				active[def.experimentId] = def;
			}
		}
		return active;
	}

	writeOwnFence(record: DshFenceRecordV1): boolean {
		const dest = this.#fencePath(record.revision);
		const tmp = `${dest}.${randomUUID()}.tmp`;
		try {
			this.#ensureDir();
			fs.writeFileSync(tmp, `${JSON.stringify(record)}\n`);
			fs.renameSync(tmp, dest);
			return true;
		} catch {
			try {
				fs.unlinkSync(tmp);
			} catch {
				// ignore tmp cleanup
			}
			return false;
		}
	}

	unlinkOwnFence(revision: string): boolean {
		try {
			fs.unlinkSync(this.#fencePath(revision));
			return true;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ENOENT";
		}
	}

	appendDecision(decision: LatencyRolloutDecisionV1): { persisted: boolean; via: "jsonl" | "fence" | "none" } {
		const delays = [10, 50, 200];
		for (let attempt = 0; attempt < 3; attempt++) {
			if (this.#appendLine(decision)) {
				if (decision.revision) this.unlinkOwnFence(decision.revision);
				return { persisted: true, via: "jsonl" };
			}
			if (attempt < delays.length) sleepSync(delays[attempt]!);
		}
		if (decision.revision && decision.expiresAt) {
			const fenced = this.writeOwnFence({
				revision: decision.revision,
				disabledArms: decision.disabledArms,
				evaluatedAt: decision.evaluatedAt,
				expiresAt: decision.expiresAt,
			});
			if (fenced) return { persisted: true, via: "fence" };
		}
		this.#controlPlaneDegraded = true;
		return { persisted: false, via: "none" };
	}

	appendDecisionOrAbort(decision: LatencyRolloutDecisionV1): { persisted: true; via: "jsonl" | "fence" } {
		const first = this.appendDecision(decision);
		if (first.persisted && first.via !== "none") return { persisted: true, via: first.via };
		for (;;) {
			const next = this.appendDecision(decision);
			if (next.persisted && next.via !== "none") return { persisted: true, via: next.via };
			if (this.#abortExit) this.#abortExit(1);
		}
	}

	probe(): boolean {
		const id = randomUUID();
		const dest = path.join(this.#dir, `latency-rollout-cohort.probe.${id}`);
		const tmp = `${dest}.tmp`;
		try {
			this.#ensureDir();
			fs.writeFileSync(tmp, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`);
			fs.renameSync(tmp, dest);
			try {
				fs.unlinkSync(dest);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
			}
			return true;
		} catch {
			try {
				fs.unlinkSync(tmp);
			} catch {
				// ignore
			}
			return false;
		}
	}

	sweepStaleProbes(now: string = new Date().toISOString()): void {
		let names: string[];
		try {
			names = fs.readdirSync(this.#dir);
		} catch {
			return;
		}
		const cutoff = Date.parse(now) - 5 * 60 * 1000;
		for (const name of names) {
			if (!name.startsWith("latency-rollout-cohort.probe.")) continue;
			const full = path.join(this.#dir, name);
			try {
				if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
			} catch {
				// ignore
			}
		}
	}

	recomputeStopsFromDurableMetrics(now: string = new Date().toISOString()): CompletenessResult {
		const raw = this.#readRaw();
		if (raw === null) return { complete: false, stops: [], belowMinSample: false };
		const parsed = parseCohortFileRecords(raw);
		const nowMs = Date.parse(now);
		const intents = replayIntents(parsed.intents).filter(item => Date.parse(item.expiresAt) > nowMs);
		if (intents.length === 0) return { complete: false, stops: [], belowMinSample: false };
		const metrics = replayObservations(parsed.observations);
		const metricsById = new Map(metrics.filter(item => item.event_id).map(item => [item.event_id!, item]));
		for (const intent of intents) {
			if (intent.state !== "committed" || !intent.metricsEventId) {
				return { complete: false, stops: [], belowMinSample: false };
			}
			if (!metricsById.has(intent.metricsEventId)) {
				return { complete: false, stops: [], belowMinSample: false };
			}
		}
		const dimMetrics = summarizeDshDimensionMetrics(metrics, nowMs);
		const stops: LatencyRolloutDecisionV1[] = [];
		for (const [dimensionId, dim] of dimMetrics) {
			const childArms = declaredDimensionArms(dimensionId);
			const arms = emptyLatencyArms();
			for (const arm of childArms) arms[arm] = true;
			const snapshot = freezeLatencyArmSnapshot({
				arms,
				dimensions: [
					{
						id: dimensionId,
						childArms,
						assignedTreatment: true,
						treatment: true,
						stopApplied: false,
						role: "treatment",
						cohortKey: `dsh:${dimensionId}:t|bg:none`,
						controlKey: `dsh:${dimensionId}:c|bg:none`,
					},
				],
				frozenAt: now,
			});
			const decision = buildLatencyRolloutDecision({
				workflowId: "machine",
				status: "recompute",
				snapshot,
				observed: {
					completion: true,
					repairCycles: 0,
					treatmentAttributedP0P1Escapes: 0,
					costUsd: null,
					stageTimeMs: 0,
					spawnedAgents: null,
				},
				now,
				targetDimensionId: dimensionId,
				dsh: {
					a1GetBranchErrorRate: dim.a1GetBranchErrorRate,
					a23ZeroInjectionRate: dim.a23ZeroInjectionRate,
					a4CapViolations: dim.a4CapViolations,
					nonInferiorityDropPp: dim.nonInferiorityDropPp,
					minSampleMet: dim.minSampleMet,
				},
			});
			if (!decision.decision.stop) continue;
			const persisted = this.appendDecision(decision);
			if (!persisted.persisted) {
				this.#controlPlaneDegraded = true;
				return { complete: false, stops, belowMinSample: dim.minSampleMet === false };
			}
			stops.push(decision);
		}
		const efficacy = metrics.filter(item => item.stopApplied !== true);
		return {
			complete: true,
			stops,
			belowMinSample: efficacy.length < LATENCY_COHORT_MIN_SAMPLES,
		};
	}

	startupAllowsTreatment(now: string = new Date().toISOString()): boolean {
		if (this.#controlPlaneDegraded) return false;
		if (this.readActiveDecisions(now).length > 0 || this.readFenceDecisions(now).length > 0) return true;
		if (this.recomputeStopsFromDurableMetrics(now).complete) return true;
		return this.consumeOperatorAck(now);
	}
}
