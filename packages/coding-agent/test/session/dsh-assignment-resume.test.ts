import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import { emptyLatencyArms } from "../../src/latency/arms";
import { assignDshExperiments, bindExecutionIds, type ExperimentDefinitionV1 } from "../../src/latency/assignment";
import { prepareLatencySnapshot } from "../../src/latency/prepare-snapshot";
import { LatencyRolloutCohortStore } from "../../src/latency/rollout-cohort";
import { SessionManager } from "../../src/session/session-manager";

const now = "2026-08-15T00:00:00.000Z";

function definition(experimentId: ExperimentDefinitionV1["experimentId"]): ExperimentDefinitionV1 {
	return {
		kind: "dsh-experiment-definition",
		event_id: `dshdef:${experimentId}:r1`,
		revision: "r1",
		experimentId,
		salt: "window-salt",
		windowStart: "2026-08-01T00:00:00.000Z",
		windowEnd: "2026-09-01T00:00:00.000Z",
		evaluatedAt: now,
	};
}

describe("dsh assignment resume", () => {
	it("excludes experiments when no definition exists", () => {
		const result = assignDshExperiments({
			sessionId: "s1",
			eligibility: {
				sessionId: "s1",
				agentKind: "main",
				allowHeadlessGoalContinuation: true,
				acpDeferAgentInitiatedTurns: false,
				now,
			},
			definitions: {},
			disabledArms: new Set(),
			controlPlaneDegraded: false,
			probeOk: true,
		});
		expect(result.dimensions).toEqual([]);
		expect(result.assignment.experiments.every(item => item.role === "excluded")).toBe(true);
	});

	it("restores assignedTreatment and applies stop as effective false", () => {
		const first = assignDshExperiments({
			sessionId: "s1",
			eligibility: {
				sessionId: "s1",
				agentKind: "main",
				allowHeadlessGoalContinuation: true,
				acpDeferAgentInitiatedTurns: false,
				now,
			},
			definitions: { "EXP-A1": definition("EXP-A1") },
			disabledArms: new Set(),
			controlPlaneDegraded: false,
			probeOk: true,
			backgroundArms: emptyLatencyArms(),
		});
		const restored = first.assignment.experiments.find(item => item.experimentId === "EXP-A1");
		expect(restored?.role === "excluded").toBe(false);
		const stopped = assignDshExperiments({
			sessionId: "s1",
			eligibility: {
				sessionId: "s1",
				agentKind: "main",
				allowHeadlessGoalContinuation: true,
				acpDeferAgentInitiatedTurns: false,
				now,
			},
			definitions: { "EXP-A1": definition("EXP-A1") },
			disabledArms: new Set(["dsh_session_search"]),
			restored: first.assignment,
			controlPlaneDegraded: false,
			probeOk: true,
			backgroundArms: emptyLatencyArms(),
		});
		const slice = stopped.dimensions.find(item => item.id === "dim.a1");
		expect(slice?.assignedTreatment).toBe(restored?.role === "treatment");
		expect(slice?.treatment).toBe(false);
		expect(stopped.assignment.arms.dsh_session_search).toBe(false);
	});

	it("keeps one pending per live session and mints a new execution on resume", () => {
		const assigned = assignDshExperiments({
			sessionId: "live",
			eligibility: {
				sessionId: "live",
				agentKind: "main",
				allowHeadlessGoalContinuation: false,
				acpDeferAgentInitiatedTurns: false,
				now,
			},
			definitions: { "EXP-A1": definition("EXP-A1") },
			disabledArms: new Set(),
			controlPlaneDegraded: false,
			probeOk: true,
		});
		const first = bindExecutionIds(assigned.assignment, { newExecution: true });
		const again = bindExecutionIds(first.assignment, {
			existing: { "EXP-A1": first.mintedPending[0]!.executionId },
		});
		expect(again.mintedPending).toEqual([]);
		const resumed = bindExecutionIds(first.assignment, { newExecution: true });
		expect(resumed.mintedPending).toHaveLength(1);
		expect(resumed.mintedPending[0]?.executionId).not.toBe(first.mintedPending[0]?.executionId);
	});

	it("does not treat an operator-ack as an experiment definition", () => {
		const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "omp-ackdef-")), "cohort.jsonl");
		const store = new LatencyRolloutCohortStore(file, { bootNonce: "boot", startupAt: now });
		store.appendOperatorAck({ bootNonce: "boot", createdAt: now });
		expect(store.readActiveExperimentDefs(now)).toEqual({});
		expect(store.consumeOperatorAck(now)).toBe(true);
	});

	it("keeps one pending across two ordinary prepares of the same live session", () => {
		const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "omp-pending-")), "cohort.jsonl");
		const store = new LatencyRolloutCohortStore(file, { bootNonce: "boot", startupAt: now });
		store.appendExperimentDefinition(definition("EXP-A1"));
		store.appendOperatorAck({ bootNonce: "boot", createdAt: now });
		const manager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const eligibility = {
			sessionId: manager.getSessionId(),
			agentKind: "main" as const,
			allowHeadlessGoalContinuation: false,
			acpDeferAgentInitiatedTurns: false,
			now,
		};
		const first = prepareLatencySnapshot({
			sessionManager: manager,
			settings,
			store,
			eligibility,
			resume: false,
		});
		const firstExec = first.assignment.experiments.find(item => item.experimentId === "EXP-A1")?.executionId;
		expect(firstExec).toBeTruthy();
		const second = prepareLatencySnapshot({
			sessionManager: manager,
			settings,
			store,
			eligibility,
			resume: false,
		});
		expect(second.assignment.experiments.find(item => item.experimentId === "EXP-A1")?.executionId).toBe(firstExec);
		const intents = store.readAllRecords().intents.filter(item => item.experimentId === "EXP-A1");
		expect(new Set(intents.map(item => item.executionId)).size).toBe(1);
		expect(intents.every(item => item.state === "pending")).toBe(true);
	});
});
