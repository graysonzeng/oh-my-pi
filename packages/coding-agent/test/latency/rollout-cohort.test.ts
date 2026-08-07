import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { emptyLatencyArms, freezeLatencyArmSnapshot } from "../../src/latency/arms";
import {
	computeLatencyCohortMetrics,
	deriveLatencyCohortKey,
	LATENCY_BASELINE_COHORT_KEY,
	LATENCY_ROLLOUT_OBSERVATION_KIND,
	LatencyRolloutCohortStore,
	type LatencyRolloutObservationV1,
	percentile,
	summarizeLatencyCohort,
} from "../../src/latency/rollout-cohort";

function observation(overrides: Partial<LatencyRolloutObservationV1>): LatencyRolloutObservationV1 {
	return {
		schemaVersion: 1,
		kind: LATENCY_ROLLOUT_OBSERVATION_KIND,
		key: "baseline",
		status: "completed",
		completed: true,
		repairCycles: 0,
		p0p1Escapes: 0,
		costUsd: 1,
		stageTimeMs: 1000,
		spawnedAgents: null,
		firedArms: [],
		endedAt: "2026-08-07T00:00:00.000Z",
		...overrides,
	};
}

describe("deriveLatencyCohortKey", () => {
	it("maps no arms to baseline, one arm to its id, and many to the registered combination", () => {
		expect(deriveLatencyCohortKey(freezeLatencyArmSnapshot({ arms: emptyLatencyArms() }))).toBe(
			LATENCY_BASELINE_COHORT_KEY,
		);
		expect(
			deriveLatencyCohortKey(freezeLatencyArmSnapshot({ arms: { ...emptyLatencyArms(), bash_advisory: true } })),
		).toBe("bash_advisory");
		const combined = freezeLatencyArmSnapshot({
			arms: { ...emptyLatencyArms(), context_optimization: true, read_dedupe: true },
			combinedArmId: "combined:context_optimization+read_dedupe",
			childArms: ["context_optimization", "read_dedupe"],
		});
		expect(deriveLatencyCohortKey(combined)).toBe("combined:context_optimization+read_dedupe");
	});
});

describe("percentile", () => {
	it("uses nearest-rank over sorted input", () => {
		expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
		expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
		expect(percentile([], 50)).toBeUndefined();
	});
});

describe("summarizeLatencyCohort", () => {
	it("returns undefined below the minimum sample guard", () => {
		expect(summarizeLatencyCohort([observation({})])).toBeUndefined();
		expect(summarizeLatencyCohort([])).toBeUndefined();
	});

	it("aggregates completion, percentiles, and null-skipping from ≥8 samples", () => {
		const observations = Array.from({ length: 9 }, (_, i) =>
			observation({ completed: i < 8, costUsd: 10 + i, stageTimeMs: 100 * (i + 1), repairCycles: i % 2 }),
		);
		const summary = summarizeLatencyCohort(observations)!;
		expect(summary.count).toBe(9);
		expect(summary.completionRate).toBeCloseTo(8 / 9, 10);
		expect(summary.costP50).toBe(14);
		expect(summary.stageTimeP50).toBe(500);
		expect(summary.stageTimeP95).toBe(900);
		expect(summary.meanRepairCycles).toBeCloseTo(4 / 9, 10);
	});

	it("excludes null-valued fields from aggregation instead of reading them as zero", () => {
		const observations = Array.from({ length: 8 }, () =>
			observation({ costUsd: null, stageTimeMs: null, spawnedAgents: null }),
		);
		const summary = summarizeLatencyCohort(observations)!;
		expect(summary.costP50).toBeUndefined();
		expect(summary.stageTimeP50).toBeUndefined();
		expect(summary.spawnedP95).toBeUndefined();
		expect(summary.completionRate).toBe(1);
	});
});

describe("computeLatencyCohortMetrics", () => {
	const baseline = summarizeLatencyCohort(
		Array.from({ length: 8 }, (_, i) =>
			observation({ completed: true, costUsd: 10 + i, stageTimeMs: 500 + i * 10, spawnedAgents: 2 }),
		),
	)!;

	it("emits a completion drop when treatment completes less often", () => {
		const treatment = summarizeLatencyCohort(
			Array.from({ length: 8 }, (_, i) => observation({ completed: i < 4, costUsd: 20, stageTimeMs: 100 })),
		)!;
		const metrics = computeLatencyCohortMetrics(treatment, baseline);
		expect(metrics.completionDropPp).toBe(50);
		expect(metrics.costP50Multiple).toBeGreaterThan(1);
		expect(metrics.latencyImprovePct).toBeGreaterThan(0);
	});

	it("emits rework rise and spawned P95 multiples only when both sides have values", () => {
		const treatment = summarizeLatencyCohort(
			Array.from({ length: 8 }, () =>
				observation({ repairCycles: 4, costUsd: 20, stageTimeMs: 100, spawnedAgents: 6 }),
			),
		)!;
		const metrics = computeLatencyCohortMetrics(treatment, baseline);
		expect(metrics.reworkRisePct).toBeGreaterThan(0);
		expect(metrics.spawnedAgentsP95Multiple).toBeGreaterThan(1);
	});

	it("skips a metric when the baseline side is absent or zero", () => {
		const noCost = summarizeLatencyCohort(
			Array.from({ length: 8 }, () => observation({ costUsd: null, stageTimeMs: 100 })),
		)!;
		const metrics = computeLatencyCohortMetrics(noCost, baseline);
		expect(metrics.costP50Multiple).toBeUndefined();
		expect(metrics.costP95Multiple).toBeUndefined();
		expect(metrics.latencyImprovePct).toBeGreaterThan(0);
	});
});

describe("LatencyRolloutCohortStore", () => {
	it("round-trips observations and skips corrupt lines", () => {
		const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "omp-cohort-")), "cohort.jsonl");
		const store = new LatencyRolloutCohortStore(file);
		store.append(observation({ key: "baseline", completed: true }));
		store.append(observation({ key: "read_dedupe", completed: false, firedArms: ["read_dedupe"] }));
		fs.appendFileSync(file, "{not-json}\n");
		const all = store.readAll();
		expect(all.length).toBe(2);
		expect(all[0]!.key).toBe("baseline");
		expect(all[1]!.key).toBe("read_dedupe");
		expect(store.summaryForKey("baseline")).toBeUndefined(); // 1 sample < min guard
		store.append(observation({ key: "baseline", completed: true }));
		store.append(observation({ key: "baseline", completed: false }));
		store.append(observation({ key: "baseline", completed: true }));
		store.append(observation({ key: "baseline", completed: true }));
		store.append(observation({ key: "baseline", completed: true }));
		store.append(observation({ key: "baseline", completed: true }));
		store.append(observation({ key: "baseline", completed: true }));
		store.append(observation({ key: "baseline", completed: true }));
		const summary = store.summaryForKey("baseline")!;
		expect(summary.count).toBe(9);
		expect(summary.completionRate).toBeCloseTo(8 / 9, 10);
	});

	it("never throws on unreadable or unwritable files", () => {
		const store = new LatencyRolloutCohortStore("/nonexistent-dir/cohort.jsonl");
		store.append(observation({}));
		expect(store.readAll()).toEqual([]);
		expect(store.summaryForKey("baseline")).toBeUndefined();
	});
});
