import { describe, expect, it } from "bun:test";
import {
	declaredDimensionArms,
	dshCohortKey,
	emptyLatencyArms,
	freezeLatencyArmSnapshot,
} from "../../src/latency/arms";
import {
	assignDshExperiments,
	bindExecutionIds,
	type ExperimentDefinitionV1,
	hashTreatmentBucket,
} from "../../src/latency/assignment";

const now = "2026-08-15T00:00:00.000Z";

function def(experimentId: ExperimentDefinitionV1["experimentId"], salt = "salt"): ExperimentDefinitionV1 {
	return {
		kind: "dsh-experiment-definition",
		event_id: `dshdef:${experimentId}:rev`,
		revision: "rev",
		experimentId,
		salt,
		windowStart: "2026-08-01T00:00:00.000Z",
		windowEnd: "2026-09-01T00:00:00.000Z",
		evaluatedAt: now,
	};
}

function eligibility(sessionId = "sess-1") {
	return {
		sessionId,
		agentKind: "main" as const,
		allowHeadlessGoalContinuation: true,
		acpDeferAgentInitiatedTurns: false,
		now,
	};
}

describe("DSH arm assignment", () => {
	it("writes control slices when eligible and hash misses treatment", () => {
		const definitions = { "EXP-A1": def("EXP-A1"), "EXP-A4": def("EXP-A4") };
		let sessionId = "control-session";
		for (const candidate of ["control-session", "control-session-2", "control-session-3", "c0", "c1", "c2"]) {
			if (!hashTreatmentBucket(candidate, "EXP-A1", "salt") && !hashTreatmentBucket(candidate, "EXP-A4", "salt")) {
				sessionId = candidate;
				break;
			}
		}
		expect(hashTreatmentBucket(sessionId, "EXP-A1", "salt")).toBe(false);
		expect(hashTreatmentBucket(sessionId, "EXP-A4", "salt")).toBe(false);
		const result = assignDshExperiments({
			sessionId,
			eligibility: eligibility(sessionId),
			definitions,
			disabledArms: new Set(),
			controlPlaneDegraded: false,
			probeOk: true,
			backgroundArms: {
				...emptyLatencyArms(),
				context_optimization: true,
				read_dedupe: true,
				bash_advisory: true,
				bash_bounded_injection: true,
			},
		});
		expect(result.assignment.arms.dsh_session_search).toBe(false);
		expect(result.assignment.arms.dsh_headless_continuation).toBe(false);
		expect(result.dimensions.map(slice => slice.role)).toEqual(["control", "control"]);
		expect(result.dimensions[0]?.cohortKey).toBe(
			dshCohortKey("dim.a1", "control", "bash_advisory+bash_bounded_injection+context_optimization+read_dedupe"),
		);
	});

	it("fail-closes xor A2/A3 before any treatment behavior", () => {
		const result = assignDshExperiments({
			sessionId: "xor",
			eligibility: eligibility("xor"),
			definitions: { "EXP-A23": def("EXP-A23") },
			disabledArms: new Set(["dsh_omit_goal_time"]),
			controlPlaneDegraded: false,
			probeOk: true,
		});
		expect(result.invalidXor).toBe(true);
		expect(result.assignment.arms.dsh_omit_goal_time).toBe(false);
		expect(result.assignment.arms.dsh_goal_hash_shadow).toBe(false);
		expect(result.dimensions.some(slice => slice.id === "dim.a23")).toBe(false);
		const frozen = freezeLatencyArmSnapshot({
			arms: { ...emptyLatencyArms(), dsh_omit_goal_time: true, dsh_goal_hash_shadow: false },
			dimensions: [
				{
					id: "dim.a23",
					childArms: declaredDimensionArms("dim.a23"),
					assignedTreatment: true,
					treatment: true,
					stopApplied: false,
					role: "treatment",
					cohortKey: "x",
					controlKey: "y",
				},
			],
		});
		expect(frozen.arms.dsh_omit_goal_time).toBe(false);
		expect(frozen.arms.dsh_goal_hash_shadow).toBe(false);
		expect(frozen.dimensions?.[0]?.role).toBe("excluded");
	});

	it("excludes both A1 and A23 when both would be treatment", () => {
		const salt = "same-salt";
		let sessionId = "both-t";
		for (const candidate of ["both-t", "both-t-1", "both-t-2", "tt0", "tt1", "tt2", "tt3"]) {
			if (hashTreatmentBucket(candidate, "EXP-A1", salt) && hashTreatmentBucket(candidate, "EXP-A23", salt)) {
				sessionId = candidate;
				break;
			}
		}
		expect(hashTreatmentBucket(sessionId, "EXP-A1", salt)).toBe(true);
		expect(hashTreatmentBucket(sessionId, "EXP-A23", salt)).toBe(true);
		const result = assignDshExperiments({
			sessionId,
			eligibility: eligibility(sessionId),
			definitions: { "EXP-A1": def("EXP-A1", salt), "EXP-A23": def("EXP-A23", salt) },
			disabledArms: new Set(),
			controlPlaneDegraded: false,
			probeOk: true,
		});
		expect(result.assignment.experiments.find(item => item.experimentId === "EXP-A1")?.role).toBe("excluded");
		expect(result.assignment.experiments.find(item => item.experimentId === "EXP-A23")?.role).toBe("excluded");
		expect(result.assignment.arms.dsh_session_search).toBe(false);
		expect(result.assignment.arms.dsh_omit_goal_time).toBe(false);
		expect(result.assignment.arms.dsh_goal_hash_shadow).toBe(false);
	});

	it("mints one pending execution per eligible experiment and reuses it", () => {
		const assigned = assignDshExperiments({
			sessionId: "exec",
			eligibility: eligibility("exec"),
			definitions: { "EXP-A1": def("EXP-A1") },
			disabledArms: new Set(),
			controlPlaneDegraded: false,
			probeOk: true,
		});
		const first = bindExecutionIds(assigned.assignment, { newExecution: true });
		expect(first.mintedPending).toHaveLength(1);
		const second = bindExecutionIds(first.assignment, {
			existing: { "EXP-A1": first.mintedPending[0]!.executionId },
		});
		expect(second.mintedPending).toHaveLength(0);
		expect(second.assignment.experiments[0]?.executionId).toBe(first.mintedPending[0]!.executionId);
	});
});
