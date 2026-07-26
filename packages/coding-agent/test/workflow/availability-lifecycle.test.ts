import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactStore } from "../../src/workflow/artifact-store";
import { WorkflowEngine } from "../../src/workflow/engine";
import { WorkflowCancelledError } from "../../src/workflow/errors";
import { ModelRouter } from "../../src/workflow/model-router";
import { RuntimeAdapter } from "../../src/workflow/runtime-adapter";
import { WorkflowStore } from "../../src/workflow/sqlite-store";
import type {
	ModelProfile,
	WorkflowAvailabilityPort,
	WorkflowAvailabilityProbeResult,
	WorkflowRole,
} from "../../src/workflow/types";
import { fakeSession, implArtifact, passVerifier, planArtifact, reviewArtifact, scriptedRunner } from "./helpers";

function testProfile(id: string, roles: WorkflowRole[], modelPattern: string): ModelProfile {
	return {
		id,
		vendor: "test",
		modelPattern,
		roles,
		promptTemplate: "planner",
		promptVersion: "1.0",
		toolPolicyId: "readonly",
		maxRequests: 10,
		maxRuntimeMs: 30_000,
		retryPolicy: { maxAttempts: 1, retryableErrorKinds: [], fallbackProfileIds: [] },
		contextPolicy: {
			includePlan: true,
			includeReviewFindings: true,
			includeVerification: true,
			includeFullTranscript: false,
			maxArtifactBytes: 10_000,
		},
	};
}

describe("WorkflowEngine availability lifecycle", () => {
	let store: WorkflowStore;
	let artifactDir: string;
	let probeLog: Array<{ profileId: string; role: WorkflowRole }>;
	let availability: WorkflowAvailabilityPort;

	beforeEach(async () => {
		store = new WorkflowStore(":memory:");
		artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-avail-life-"));
		probeLog = [];
		availability = {
			async probe(req) {
				probeLog.push({ profileId: req.profile.id, role: req.role });
				return {
					status: "available",
					actualProvider: "mock",
					actualModel: String(
						Array.isArray(req.profile.modelPattern) ? req.profile.modelPattern[0] : req.profile.modelPattern,
					),
					latencyMs: 1,
				};
			},
		};
	});

	afterEach(async () => {
		store.close();
		await fs.rm(artifactDir, { recursive: true, force: true });
	});

	function makeEngine(profiles: ModelProfile[]) {
		return new WorkflowEngine({
			store,
			router: new ModelRouter(profiles),
			config: {
				profiles: Object.fromEntries(profiles.map(p => [p.id, p])),
				// Allow same-vendor implementer/reviewer in these lightweight fixtures.
				degradedMode: true,
				requireIndependentReview: false,
			},
			adapter: new RuntimeAdapter(
				scriptedRunner({
					plan: planArtifact(),
					planReview: reviewArtifact("approved", "plan"),
					implement: implArtifact(),
					codeReview: reviewArtifact("approved", "implementation"),
				}),
			),
			verifier: passVerifier(),
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession(),
			availability,
		});
	}

	it("start returns availability report before any stage attempt", async () => {
		const profiles = [
			testProfile("planner_a", ["planner"], "m-planner"),
			testProfile("reviewer_a", ["plan_reviewer"], "m-plan-review"),
			testProfile("impl_a", ["implementer"], "m-impl"),
			testProfile("code_a", ["code_reviewer"], "m-code"),
			testProfile("repair_a", ["repair"], "m-repair"),
		];
		const engine = makeEngine(profiles);
		const started = await engine.start({ request: "lifecycle start" });

		expect(started.workflowId.length).toBeGreaterThan(0);
		expect(started.availability).toBeDefined();
		expect(started.availability.operation).toBe("start");
		expect(started.availability.scope).toBe("full");
		expect(started.availability.status).toBe("ready");
		expect(started.availability.profiles.length).toBeGreaterThan(0);
		// Report shape
		for (const row of started.availability.profiles) {
			expect(row.profileId).toBeTruthy();
			expect(row.role).toBeTruthy();
			expect(["available", "unavailable", "indeterminate"]).toContain(row.status);
			expect(row.runtime).toBe("embedded");
		}
		// Still created — no stage attempts
		const state = await engine.getState(started.workflowId);
		expect(state?.status).toBe("created");
		const snap = await engine.recoverFromPersistedState(started.workflowId);
		expect(snap?.attempts.length ?? 0).toBe(0);
		// Preflight did probe
		expect(probeLog.length).toBeGreaterThan(0);
	});

	it("resume(singleStep=true) only probes current-step profiles", async () => {
		const profiles = [
			testProfile("planner_a", ["planner"], "m-planner"),
			testProfile("reviewer_a", ["plan_reviewer"], "m-plan-review"),
			testProfile("impl_a", ["implementer"], "m-impl"),
			testProfile("code_a", ["code_reviewer"], "m-code"),
			testProfile("repair_a", ["repair"], "m-repair"),
		];
		const engine = makeEngine(profiles);
		const { workflowId } = await engine.start({ request: "single step" });
		probeLog.length = 0;

		// created → planning (no model role for singleStep at created)
		const step0 = await engine.resume(workflowId, { singleStep: true, session: fakeSession() });
		expect(step0.state.status).toBe("planning");
		expect(step0.availability?.scope).toBe("single_step");
		// not_required or empty probes at created
		const rolesAtCreated = new Set(probeLog.map(p => p.role));
		expect(rolesAtCreated.has("implementer")).toBe(false);
		expect(rolesAtCreated.has("repair")).toBe(false);

		probeLog.length = 0;
		// planning → run planner
		const step1 = await engine.resume(workflowId, { singleStep: true, session: fakeSession() });
		expect(step1.availability?.scope).toBe("single_step");
		const rolesProbed = [...new Set(probeLog.map(p => p.role))];
		expect(rolesProbed).toEqual(["planner"]);
		// Did not probe future roles
		expect(probeLog.some(p => p.role === "implementer")).toBe(false);
		expect(probeLog.some(p => p.role === "repair")).toBe(false);
	});

	it("resume(singleStep=false) probes all reachable required+conditional profiles", async () => {
		const profiles = [
			testProfile("planner_a", ["planner"], "m-planner"),
			testProfile("reviewer_a", ["plan_reviewer"], "m-plan-review"),
			testProfile("impl_a", ["implementer"], "m-impl"),
			testProfile("code_a", ["code_reviewer"], "m-code"),
			testProfile("repair_a", ["repair"], "m-repair"),
		];
		const engine = makeEngine(profiles);
		const { workflowId } = await engine.start({ request: "full resume" });
		// Advance to planning so full resume will execute stages; preflight at planning.
		await engine.resume(workflowId, { singleStep: true, session: fakeSession() });
		probeLog.length = 0;

		const result = await engine.resume(workflowId, { singleStep: false, session: fakeSession() });
		expect(result.availability?.scope).toBe("full");
		const roles = new Set(result.availability?.profiles.map(p => p.role) ?? []);
		expect(roles.has("planner")).toBe(true);
		expect(roles.has("plan_reviewer")).toBe(true);
		expect(roles.has("implementer")).toBe(true);
		expect(roles.has("code_reviewer")).toBe(true);
		expect(roles.has("repair")).toBe(true);
		// repair is conditional
		const repair = result.availability?.profiles.find(p => p.role === "repair");
		expect(repair?.requirement).toBe("conditional");
		// planner required
		const planner = result.availability?.profiles.find(p => p.role === "planner");
		expect(planner?.requirement).toBe("required");
		expect(result.state.status).toBe("completed");
	});

	it("caller abort during preflight cancels probes without creating a stage failure or attempt", async () => {
		const profiles = [testProfile("planner_a", ["planner"], "m-planner")];
		let hang = false;
		let observedSignal: AbortSignal | undefined;
		const never = Promise.withResolvers<WorkflowAvailabilityProbeResult>();
		availability = {
			probe(req) {
				observedSignal = req.signal;
				if (hang) return never.promise;
				return Promise.resolve({
					status: "available",
					actualProvider: "mock",
					actualModel: "m-planner",
					latencyMs: 1,
				});
			},
		};
		const engine = makeEngine(profiles);
		const { workflowId } = await engine.start({ request: "cancel preflight" });
		await engine.resume(workflowId, { singleStep: true, session: fakeSession() });
		expect((await engine.getState(workflowId))?.status).toBe("planning");

		hang = true;
		const controller = new AbortController();
		const running = engine.resume(workflowId, {
			singleStep: true,
			session: fakeSession(),
			signal: controller.signal,
		});
		await Bun.sleep(1);
		controller.abort(new Error("caller stopped"));

		await expect(running).rejects.toBeInstanceOf(WorkflowCancelledError);
		expect(observedSignal?.aborted).toBe(true);
		const state = await engine.getState(workflowId);
		expect(state?.status).toBe("planning");
		const snapshot = await engine.recoverFromPersistedState(workflowId);
		expect(snapshot?.attempts).toHaveLength(0);
	});
});
