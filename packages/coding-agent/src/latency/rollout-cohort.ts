import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LatencyArmId, LatencyArmSnapshotV1 } from "./arms";
import { LATENCY_ARM_IDS } from "./arms";

export const LATENCY_ROLLOUT_OBSERVATION_KIND = "latency_rollout_observation" as const;
export const LATENCY_ROLLOUT_OBSERVATION_VERSION = 1 as const;
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
}

/** Deterministic cohort key for a frozen arm snapshot. */
export function deriveLatencyCohortKey(snapshot: Pick<LatencyArmSnapshotV1, "arms" | "combinedArmId">): string {
	const active = LATENCY_ARM_IDS.filter(id => snapshot.arms[id] === true);
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

/**
 * Durable JSONL store of completed-run observations. Appends are synchronous
 * best-effort so terminal/teardown paths never block or fail on bookkeeping.
 */
export class LatencyRolloutCohortStore {
	readonly #file: string;

	constructor(file: string = defaultLatencyRolloutCohortFile()) {
		this.#file = file;
	}

	/** Append one observation; never throws. */
	append(observation: LatencyRolloutObservationV1): void {
		try {
			fs.mkdirSync(path.dirname(this.#file), { recursive: true });
			fs.appendFileSync(this.#file, `${JSON.stringify(observation)}\n`, { flag: "a" });
		} catch {
			// Rollout bookkeeping is advisory; a full disk or sandboxed fs must
			// not fail the run that just reached terminal.
		}
	}

	/** Parse every stored observation; corrupt lines are skipped, never thrown. */
	readAll(): LatencyRolloutObservationV1[] {
		let raw: string;
		try {
			raw = fs.readFileSync(this.#file, "utf8");
		} catch {
			return [];
		}
		const observations: LatencyRolloutObservationV1[] = [];
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			try {
				const parsed = JSON.parse(line) as LatencyRolloutObservationV1;
				if (parsed?.kind !== LATENCY_ROLLOUT_OBSERVATION_KIND) continue;
				if (typeof parsed.key !== "string" || typeof parsed.completed !== "boolean") continue;
				observations.push(parsed);
			} catch {
				// skip corrupt line
			}
		}
		return observations;
	}

	summaryForKey(key: string): LatencyCohortSummary | undefined {
		return summarizeLatencyCohort(this.readAll().filter(o => o.key === key));
	}
}
