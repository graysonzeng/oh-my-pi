import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Settings } from "../../src/config/settings";
import {
	type buildLatencyRolloutDecision,
	emptyLatencyArms,
	freezeLatencyArmSnapshot,
	LATENCY_ROLLOUT_DECISION_KIND,
	type LatencyArmId,
	type LatencyRolloutDecisionV1,
} from "../../src/latency/arms";
import {
	LATENCY_ROLLOUT_OBSERVATION_KIND,
	LatencyRolloutCohortStore,
	type LatencyRolloutObservationV1,
} from "../../src/latency/rollout-cohort";
import type { ToolSession } from "../../src/tools";
import { ArtifactStore } from "../../src/workflow/artifact-store";
import { WorkflowEngine } from "../../src/workflow/engine";
import { RuntimeAdapter } from "../../src/workflow/runtime-adapter";
import { WorkflowStore } from "../../src/workflow/sqlite-store";
import { fakeSession, implArtifact, passVerifier, planArtifact, reviewArtifact, scriptedRunner } from "./helpers";

/**
 * Production quality-stop wiring: a workflow that reaches a terminal state with active arms
 * must persist a latency-rollout-decision artifact; when the stop fires, only the causal
 * (fired) arms are disabled through the session settings override, and the frozen snapshot
 * is invalidated so later lookups re-read live settings.
 */

function latencySession(
	settingsOverride: Record<string, unknown>,
	opts: { fired?: LatencyArmId[]; invalidated?: () => void } = {},
): ToolSession {
	const settings = {
		get: (key: string): unknown => settingsOverride[key],
		set: () => {},
		override: (key: string, value: unknown): void => {
			settingsOverride[key] = value;
		},
	} as unknown as Settings;
	const fired = new Set<LatencyArmId>(opts.fired ?? []);
	const base = fakeSession({ settings });
	return {
		...base,
		settings,
		getLatencyArmSnapshot: () =>
			freezeLatencyArmSnapshot({
				arms: {
					...emptyLatencyArms(),
					context_optimization: true,
					read_dedupe: true,
				},
				combinedArmId: "combined:context_optimization+read_dedupe",
				childArms: ["context_optimization", "read_dedupe"],
				codeRevision: "rev-1",
				configHash: "cfg-1",
				frozenAt: "2026-08-07T00:00:00.000Z",
			}),
		markLatencyArmFired: arm => {
			fired.add(arm);
		},
		getFiredLatencyArms: () => [...fired],
		invalidateLatencyArmSnapshot: () => opts.invalidated?.(),
	};
}

function observation(key: string, overrides: Partial<LatencyRolloutObservationV1> = {}): LatencyRolloutObservationV1 {
	return {
		schemaVersion: 1,
		kind: LATENCY_ROLLOUT_OBSERVATION_KIND,
		key,
		status: "completed",
		completed: true,
		repairCycles: 0,
		p0p1Escapes: 0,
		costUsd: 10,
		stageTimeMs: 1000,
		spawnedAgents: null,
		firedArms: [],
		endedAt: "2026-08-07T00:00:00.000Z",
		...overrides,
	};
}

describe("WorkflowEngine latency rollout decision at terminal", () => {
	let store: WorkflowStore;
	let artifactDir: string;
	let cwd: string;
	let artifactStore: ArtifactStore;
	let cohortFile: string;
	let cohortStore: LatencyRolloutCohortStore;

	beforeEach(async () => {
		store = new WorkflowStore(":memory:");
		artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-latency-rollout-arts-"));
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "wf-latency-rollout-cwd-"));
		artifactStore = new ArtifactStore(artifactDir);
		cohortFile = path.join(artifactDir, "cohort.jsonl");
		cohortStore = new LatencyRolloutCohortStore(cohortFile);
		await fs.mkdir(path.join(cwd, "src"), { recursive: true });
		await Bun.write(path.join(cwd, "src/a.ts"), "before\n");
	});

	afterEach(async () => {
		store.close();
		await fs.rm(artifactDir, { recursive: true, force: true });
		await fs.rm(cwd, { recursive: true, force: true });
	});

	function makeEngine(session: ToolSession): WorkflowEngine {
		const runner = scriptedRunner({
			plan: planArtifact(),
			planReview: reviewArtifact("approved", "plan"),
			implement: implArtifact(),
			codeReview: reviewArtifact("approved", "implementation"),
		});
		return new WorkflowEngine({
			store,
			adapter: new RuntimeAdapter(runner),
			verifier: passVerifier(),
			artifactStore,
			latencyCohortStore: cohortStore,
			session,
		});
	}

	it("persists a no-stop rollout decision when the registered combination completes cleanly", async () => {
		const overrides: Record<string, unknown> = {
			"modelOptimization.enabled": true,
			"latency.arms.readDedupe": true,
		};
		const session = latencySession(overrides);
		const engine = makeEngine(session);
		const workflowId = await engine.startWorkflow({
			request: "clean run",
			requestId: "req-clean",
		});
		const result = await engine.run(workflowId, session);
		expect(result.state.status).toBe("completed");

		const artifacts = await artifactStore.listByWorkflow(workflowId);
		const decisionArtifact = artifacts.find(artifact => artifact.kind === LATENCY_ROLLOUT_DECISION_KIND);
		expect(decisionArtifact).toBeDefined();
		const decision = JSON.parse(decisionArtifact!.content!) as ReturnType<typeof buildLatencyRolloutDecision>;
		expect(decision.decision).toEqual({ stop: false, reason: null });
		expect(decision.attributionKnown).toBe(true);
		expect(decision.observed.completion).toBe(true);
		// No stop → no rollback override.
		expect(overrides["latency.arms.readDedupe"]).toBe(true);
		// The run itself was recorded into the cohort.
		const recorded = cohortStore.readAll();
		expect(recorded.some(o => o.key === "combined:context_optimization+read_dedupe" && o.completed)).toBe(true);
	});

	it("disables only fired causal arms when an attributed P0/P1 escape stops the run", async () => {
		const overrides: Record<string, unknown> = {
			"modelOptimization.enabled": true,
			"latency.arms.readDedupe": true,
		};
		let invalidated = 0;
		// Only context_optimization actually engaged during this run (e.g. the read
		// dedupe path never rewrote a read result).
		const session = latencySession(overrides, {
			fired: ["context_optimization"],
			invalidated: () => (invalidated += 1),
		});
		// First code review carries an attributed P0 finding that is never resolved (repair's
		// addressedStepIds do not cover it); the follow-up review approves, so the workflow
		// reaches terminal with the escape still open and the stop fires.
		let reviewCount = 0;
		const runner = scriptedRunner({
			plan: planArtifact(),
			planReview: reviewArtifact("approved", "plan"),
			implement: implArtifact(),
			codeReview: () => {
				reviewCount += 1;
				if (reviewCount === 1) {
					return reviewArtifact("changes_requested", "implementation", [
						{
							id: "f-escape",
							priority: "P0",
							category: "correctness",
							status: "open",
							confidence: 0.95,
							summary: "escaped P0",
							explanation: "fixture",
							suggestedOwner: "implementer",
						},
					]);
				}
				return reviewArtifact("approved", "implementation");
			},
			// Repair keeps the same addressed steps (does not resolve f-escape).
			repair: implArtifact(),
		});
		const engine = new WorkflowEngine({
			store,
			adapter: new RuntimeAdapter(runner),
			verifier: passVerifier(),
			artifactStore,
			latencyCohortStore: cohortStore,
			session,
		});
		const workflowId = await engine.startWorkflow({
			request: "escaping run",
			requestId: "req-escape",
		});
		await engine.run(workflowId, session);

		const artifacts = await artifactStore.listByWorkflow(workflowId);
		const decisionArtifact = artifacts.find(artifact => artifact.kind === LATENCY_ROLLOUT_DECISION_KIND);
		expect(decisionArtifact).toBeDefined();
		const decision = JSON.parse(decisionArtifact!.content!) as LatencyRolloutDecisionV1;
		expect(decision.decision.stop).toBe(true);
		expect(decision.decision.reason).toBe("p0p1_escape");
		// Causal rollback: only the fired arm is disabled; the dormant arm stays on.
		expect(decision.disabledArms).toEqual(["context_optimization"]);
		expect(overrides["modelOptimization.enabled"]).toBe(false);
		expect(overrides["latency.arms.readDedupe"]).toBe(true);
		// The frozen snapshot was invalidated so subsequent lookups re-read live settings.
		expect(invalidated).toBe(1);
	});

	it("stops and rolls back on a cohort-derived completion drop", async () => {
		// Seed a healthy baseline and a failing treatment cohort so the guardrail's
		// completion-drop threshold activates (8+ samples per side).
		const treatmentKey = "combined:context_optimization+read_dedupe";
		for (let i = 0; i < 8; i++) {
			cohortStore.append(observation("baseline", { completed: true, costUsd: 10, stageTimeMs: 1000 }));
			cohortStore.append(
				observation(treatmentKey, { completed: false, costUsd: 100, stageTimeMs: 100, repairCycles: 3 }),
			);
		}
		const overrides: Record<string, unknown> = {
			"modelOptimization.enabled": true,
			"latency.arms.readDedupe": true,
		};
		const session = latencySession(overrides, { fired: ["context_optimization", "read_dedupe"] });
		const engine = makeEngine(session);
		const workflowId = await engine.startWorkflow({
			request: "cohort run",
			requestId: "req-cohort",
		});
		const result = await engine.run(workflowId, session);
		expect(result.state.status).toBe("completed");

		const artifacts = await artifactStore.listByWorkflow(workflowId);
		const decisionArtifact = artifacts.find(artifact => artifact.kind === LATENCY_ROLLOUT_DECISION_KIND);
		const decision = JSON.parse(decisionArtifact?.content ?? "") as LatencyRolloutDecisionV1;
		expect(decision.decision.stop).toBe(true);
		expect(["completion_drop", "cost_breach"]).toContain(decision.decision.reason ?? "");
		expect(decision.disabledArms).toEqual(["context_optimization", "read_dedupe"]);
		expect(overrides["modelOptimization.enabled"]).toBe(false);
		expect(overrides["latency.arms.readDedupe"]).toBe(false);
	});
});
