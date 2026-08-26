import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { emptyLatencyArms, freezeLatencyArmSnapshot } from "../../src/latency/arms";
import {
	buildOrdinarySessionObservationJoin,
	computeLatencyCohortMetrics,
	deriveLatencyCohortKey,
	LATENCY_BASELINE_COHORT_KEY,
	LATENCY_ROLLOUT_OBSERVATION_KIND,
	LatencyRolloutCohortStore,
	type LatencyRolloutObservationV1,
	parseCohortFileRecords,
	percentile,
	summarizeDshDimensionMetrics,
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

describe("ordinary session observation join", () => {
	it("joins decision identity, explicit unknown verifier, and repeated work metrics", () => {
		const join = buildOrdinarySessionObservationJoin({
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			profileId: "claude-normal",
			armFingerprint: "arm-fingerprint",
			startedAt: "2026-08-26T00:00:00.000Z",
			endedAt: "2026-08-26T00:00:10.000Z",
			toolCallCount: 6,
			toolCalls: [
				{ name: "read", arguments: { path: "a.ts" } },
				{ name: "read", arguments: { path: "a.ts" } },
				{ name: "read", arguments: { path: "b.ts" } },
				{ name: "grep", arguments: { pattern: "x", path: "src" } },
				{ name: "grep", arguments: { pattern: "x", path: "src" } },
				{ name: "edit", arguments: { path: "a.ts" } },
			],
			fallbackCount: 1,
		});

		expect(join.ordinaryAttribution).toMatchObject({
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			profileId: "claude-normal",
			armFingerprint: "arm-fingerprint",
		});
		expect(join.ordinaryAttribution?.fingerprint).toHaveLength(64);
		expect(join.verifier).toEqual({ source: "unknown", status: "unknown" });
		expect(join.workMetrics).toEqual({
			wallClockMs: 10_000,
			toolCallCount: 6,
			repeatedReadCount: 1,
			repeatedGrepCount: 1,
			fallbackCount: 1,
			userCorrectionCount: null,
		});
		const again = buildOrdinarySessionObservationJoin({
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			profileId: "claude-normal",
			armFingerprint: "arm-fingerprint",
			endedAt: "2026-08-27T00:00:00.000Z",
		});
		expect(again.ordinaryAttribution?.fingerprint).toBe(join.ordinaryAttribution?.fingerprint);
	});

	it("keeps missing outcome and counters explicit instead of inferring success or zero", () => {
		const join = buildOrdinarySessionObservationJoin({ endedAt: "2026-08-26T00:00:00.000Z" });

		expect(join.ordinaryAttribution).toBeNull();
		expect(join.verifier).toEqual({ source: "unknown", status: "unknown" });
		expect(join.workMetrics).toEqual({
			wallClockMs: null,
			toolCallCount: null,
			repeatedReadCount: null,
			repeatedGrepCount: null,
			fallbackCount: null,
			userCorrectionCount: null,
		});
	});

	it("parses old JSONL observations without ordinary join fields", () => {
		const parsed = parseCohortFileRecords(`${JSON.stringify(observation({}))}\n`);

		expect(parsed.observations).toHaveLength(1);
		expect(parsed.observations[0]?.ordinaryAttribution).toBeUndefined();
		expect(parsed.observations[0]?.verifier).toBeUndefined();
		expect(parsed.observations[0]?.workMetrics).toBeUndefined();
	});
});

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

	it("treats old committed plus new pending as incomplete", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-cohort-"));
		const file = path.join(dir, "cohort.jsonl");
		const store = new LatencyRolloutCohortStore(file);
		const now = "2026-08-15T00:00:00.000Z";
		const future = "2026-09-15T00:00:00.000Z";
		store.appendRunIntent({
			kind: "dsh-run-intent",
			event_id: "dshint:s:EXP-A1:old",
			sessionId: "s",
			experimentId: "EXP-A1",
			executionId: "old",
			state: "committed",
			startedAt: now,
			committedAt: now,
			metricsEventId: "dsh:s:metrics:EXP-A1",
			expiresAt: future,
		});
		store.appendObservation(
			observation({
				event_id: "dsh:s:metrics:EXP-A1",
				sessionId: "s",
				experimentId: "EXP-A1",
				phase: "metrics",
				endedAt: now,
			}),
		);
		store.appendRunIntent({
			kind: "dsh-run-intent",
			event_id: "dshint:s:EXP-A1:new",
			sessionId: "s",
			experimentId: "EXP-A1",
			executionId: "new",
			state: "pending",
			startedAt: now,
			committedAt: null,
			metricsEventId: null,
			expiresAt: future,
		});
		expect(store.recomputeStopsFromDurableMetrics(now).complete).toBe(false);
		store.appendRunIntent({
			kind: "dsh-run-intent",
			event_id: "dshint:s:EXP-A1:new",
			sessionId: "s",
			experimentId: "EXP-A1",
			executionId: "new",
			state: "committed",
			startedAt: now,
			committedAt: now,
			metricsEventId: "dsh:s:metrics:EXP-A1",
			expiresAt: future,
		});
		expect(store.recomputeStopsFromDurableMetrics(now).complete).toBe(true);
	});

	it("does not let session B missing commit look complete", () => {
		const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "omp-cohort-")), "cohort.jsonl");
		const store = new LatencyRolloutCohortStore(file);
		const now = "2026-08-15T00:00:00.000Z";
		const future = "2026-09-15T00:00:00.000Z";
		store.appendRunIntent({
			kind: "dsh-run-intent",
			event_id: "dshint:a:EXP-A1:ea",
			sessionId: "a",
			experimentId: "EXP-A1",
			executionId: "ea",
			state: "committed",
			startedAt: now,
			committedAt: now,
			metricsEventId: "dsh:a:metrics:EXP-A1",
			expiresAt: future,
		});
		store.appendObservation(
			observation({ event_id: "dsh:a:metrics:EXP-A1", sessionId: "a", experimentId: "EXP-A1" }),
		);
		store.appendRunIntent({
			kind: "dsh-run-intent",
			event_id: "dshint:b:EXP-A4:eb",
			sessionId: "b",
			experimentId: "EXP-A4",
			executionId: "eb",
			state: "pending",
			startedAt: now,
			committedAt: null,
			metricsEventId: null,
			expiresAt: future,
		});
		expect(store.recomputeStopsFromDurableMetrics(now).complete).toBe(false);
	});

	it("keeps the other writer's fence after one decision persists", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fence-"));
		const file = path.join(dir, "cohort.jsonl");
		const a = new LatencyRolloutCohortStore(file);
		const b = new LatencyRolloutCohortStore(file);
		expect(
			a.writeOwnFence({
				revision: "rev-a",
				disabledArms: ["dsh_session_search"],
				evaluatedAt: "2026-08-15T00:00:00.000Z",
				expiresAt: "2026-09-15T00:00:00.000Z",
			}),
		).toBe(true);
		expect(
			b.writeOwnFence({
				revision: "rev-b",
				disabledArms: ["dsh_headless_continuation"],
				evaluatedAt: "2026-08-15T00:00:00.000Z",
				expiresAt: "2026-09-15T00:00:00.000Z",
			}),
		).toBe(true);
		expect(b.unlinkOwnFence("rev-b")).toBe(true);
		expect(a.readFenceDecisions("2026-08-15T00:00:00.000Z").map(item => item.revision)).toEqual(["rev-a"]);
	});

	it("rejects an old bootNonce ack", () => {
		const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "omp-ack-")), "cohort.jsonl");
		const store = new LatencyRolloutCohortStore(file, {
			bootNonce: "boot-new",
			startupAt: "2026-08-15T01:00:00.000Z",
		});
		store.appendOperatorAck({ bootNonce: "boot-old", createdAt: "2026-08-15T00:00:00.000Z" });
		expect(store.consumeOperatorAck("2026-08-15T01:00:01.000Z")).toBe(false);
		store.appendOperatorAck({ bootNonce: "boot-new", createdAt: "2026-08-15T01:00:00.000Z" });
		expect(store.consumeOperatorAck("2026-08-15T01:00:01.000Z")).toBe(true);
	});

	it("does not mint a bootNonce when constructed without process context", () => {
		const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "omp-nonce-")), "cohort.jsonl");
		const store = new LatencyRolloutCohortStore(file);
		expect(store.bootNonce).toBeNull();
	});

	it("treats an empty ledger as incomplete", () => {
		const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "omp-empty-")), "cohort.jsonl");
		const store = new LatencyRolloutCohortStore(file);
		expect(store.recomputeStopsFromDurableMetrics("2026-08-15T00:00:00.000Z").complete).toBe(false);
	});

	it("uses matched control, not the all-false baseline, for NI", () => {
		const nowMs = Date.parse("2026-08-15T00:00:00.000Z");
		const metrics = summarizeDshDimensionMetrics(
			[
				observation({
					key: "dsh:dim.a1:t|bg:none",
					experimentId: "EXP-A1",
					dimensionId: "dim.a1",
					bgFingerprint: "none",
					completed: false,
					stopApplied: false,
					event_id: "dsh:t1:metrics:EXP-A1",
				}),
				observation({
					key: "dsh:dim.a1:c|bg:none",
					experimentId: "EXP-A1",
					dimensionId: "dim.a1",
					bgFingerprint: "none",
					completed: true,
					stopApplied: false,
					event_id: "dsh:c1:metrics:EXP-A1",
				}),
				observation({
					key: "baseline",
					completed: true,
					stopApplied: false,
					event_id: "dsh:base:metrics:EXP-A1",
				}),
				observation({
					key: "dsh:dim.a1:t|bg:none",
					experimentId: "EXP-A1",
					dimensionId: "dim.a1",
					bgFingerprint: "none",
					completed: false,
					stopApplied: true,
					event_id: "dsh:stopped:metrics:EXP-A1",
				}),
			],
			nowMs,
		);
		expect(metrics.get("dim.a1")?.nonInferiorityDropPp).toBe(100);
		expect(metrics.get("dim.a1")?.minSampleMet).toBe(false);
	});
});
