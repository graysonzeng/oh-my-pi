import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactStore } from "../../src/workflow/artifact-store";
import { WorkflowEngine } from "../../src/workflow/engine";
import {
	buildRequirementsSnapshot,
	computeRequirementsSnapshotSha256,
	satisfyMandatoryCoverage,
	validateApprovedMandatoryCoverage,
} from "../../src/workflow/requirements-snapshot";
import { RuntimeAdapter } from "../../src/workflow/runtime-adapter";
import { WorkflowStore } from "../../src/workflow/sqlite-store";
import {
	fakeSession,
	implArtifact,
	planArtifact,
	planReviewArtifactV2,
	reviewArtifact,
	scriptedRunner,
} from "./helpers";

describe("requirements snapshot", () => {
	it("extracts stable mandatory IDs from request and constraints", () => {
		const snapshot = buildRequirementsSnapshot({
			workflowId: "wf_req",
			request: {
				request: "Add auth to the API",
				constraints: "- Must preserve existing tokens\n- No downtime",
			},
		});
		expect(snapshot.requirements.map(r => r.requirementId)).toEqual([
			"user:req-001",
			"user:constraint-001",
			"user:constraint-002",
		]);
		expect(snapshot.requirements.every(r => r.mandatory)).toBe(true);
		expect(snapshot.sha256).toBe(computeRequirementsSnapshotSha256(snapshot));
		// createdAt does not affect fingerprint
		const rebuilt = buildRequirementsSnapshot({
			workflowId: "wf_req",
			request: {
				request: "Add auth to the API",
				constraints: "- Must preserve existing tokens\n- No downtime",
			},
			createdAt: "2099-01-01T00:00:00.000Z",
		});
		expect(rebuilt.sha256).toBe(snapshot.sha256);
	});

	it("rejects approved coverage that omits a mandatory snapshot ID", () => {
		const snapshot = buildRequirementsSnapshot({
			workflowId: "wf_req",
			request: { request: "Ship feature X", constraints: "Keep rollback path" },
		});
		const review = planReviewArtifactV2("approved", [], {
			requirementsSnapshotSha256: snapshot.sha256,
			// Only covers the request, omits constraint
			coverage: [
				{
					requirementId: "user:req-001",
					source: "user_requirement",
					mandatory: true,
					status: "satisfied",
					evidenceRefs: ["plan:summary"],
					rationale: "plan addresses request",
				},
			],
		});
		const gate = validateApprovedMandatoryCoverage(review, snapshot);
		expect(gate.ok).toBe(false);
		expect(gate.missingRequirementIds).toContain("user:constraint-001");
	});

	it("rejects approved when snapshot hash is forged", () => {
		const snapshot = buildRequirementsSnapshot({
			workflowId: "wf_req",
			request: { request: "Ship feature X" },
		});
		const review = planReviewArtifactV2("approved", [], {
			requirementsSnapshotSha256: "a".repeat(64),
			coverage: satisfyMandatoryCoverage(snapshot),
		});
		const gate = validateApprovedMandatoryCoverage(review, snapshot);
		expect(gate.ok).toBe(false);
		expect(gate.hashMismatch).toBe(true);
	});

	it("accepts full mandatory coverage with matching hash", () => {
		const snapshot = buildRequirementsSnapshot({
			workflowId: "wf_req",
			request: { request: "Ship feature X", constraints: "Keep rollback path" },
		});
		const review = planReviewArtifactV2("approved", [], {
			requirementsSnapshotSha256: snapshot.sha256,
			coverage: satisfyMandatoryCoverage(snapshot),
		});
		expect(validateApprovedMandatoryCoverage(review, snapshot).ok).toBe(true);
	});
});

describe("WorkflowEngine mandatory coverage gate", () => {
	let store: WorkflowStore;
	let artifactDir: string;

	beforeEach(async () => {
		store = new WorkflowStore(":memory:");
		artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-req-gate-"));
	});

	afterEach(async () => {
		store.close();
		await fs.rm(artifactDir, { recursive: true, force: true });
	});

	it("blocks approved plans that omit mandatory snapshot requirements", async () => {
		const engine = new WorkflowEngine({
			store,
			adapter: new RuntimeAdapter(
				scriptedRunner({
					plan: planArtifact(),
					// Explicit empty coverage: planner-omitted requirements must not PASS.
					planReview: planReviewArtifactV2("approved", [], { coverage: [] }),
				}),
			),
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession(),
		});

		const workflowId = await engine.startWorkflow({
			request: "Implement mandatory coverage gate",
			constraints: "Must use engine-owned snapshot",
		});
		const result = await engine.run(workflowId);
		expect(result.state.status).toBe("blocked");

		const snapshot = await store.resumeFromPersistedState(workflowId);
		expect(snapshot).not.toBeNull();
		const reqMeta = snapshot!.artifacts.filter(a => a.kind === "requirements_snapshot");
		expect(reqMeta.length).toBeGreaterThanOrEqual(1);
		const loaded = await new ArtifactStore(artifactDir).load(reqMeta[0]!.relativePath, reqMeta[0]!.sha256);
		expect(loaded).not.toBeNull();
		const body = JSON.parse(loaded!.content ?? "{}") as {
			requirements?: Array<{ requirementId: string }>;
		};
		expect(body.requirements?.map(r => r.requirementId)).toEqual(["user:req-001", "user:constraint-001"]);
	});

	it("allows approved plans that cover every mandatory snapshot requirement", async () => {
		const request = "Implement mandatory coverage gate";
		const constraints = "Must use engine-owned snapshot";
		const engine = new WorkflowEngine({
			store,
			adapter: new RuntimeAdapter(
				scriptedRunner({
					plan: planArtifact(),
					planReview: planReviewArtifactV2(
						"approved",
						[],
						{
							coverage: [
								{
									requirementId: "user:req-001",
									source: "user_requirement",
									mandatory: true,
									status: "satisfied",
									evidenceRefs: ["plan:summary"],
									rationale: "plan addresses user request",
								},
								{
									requirementId: "user:constraint-001",
									source: "user_requirement",
									mandatory: true,
									status: "satisfied",
									evidenceRefs: ["plan:rollback"],
									rationale: "plan preserves engine-owned snapshot",
								},
							],
						},
						{ request, constraints },
					),
					implement: implArtifact(),
					codeReview: reviewArtifact("approved", "implementation"),
				}),
			),
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession(),
			verifier: {
				async verify(a) {
					return {
						kind: "verification",
						passed: true,
						checks: [{ id: "c", status: "passed", summary: "ok" }],
						schemaVersion: 1,
						workflowId: a.workflowId,
						attemptId: a.attemptId,
						stage: a.stage,
						createdAt: new Date().toISOString(),
					};
				},
			},
		});

		const workflowId = await engine.startWorkflow({ request, constraints });
		const frozen = buildRequirementsSnapshot({ workflowId, request: { request, constraints } });
		expect(frozen.requirements.map(r => r.requirementId)).toEqual(["user:req-001", "user:constraint-001"]);

		const result = await engine.run(workflowId);
		expect(result.state.status).toBe("completed");
	});

	it("injects authoritative requirements into plan-review context", async () => {
		let seenContext = "";
		const base = scriptedRunner({
			plan: planArtifact(),
			planReview: planReviewArtifactV2("approved", [], { coverage: [] }),
		});
		const engine = new WorkflowEngine({
			store,
			adapter: new RuntimeAdapter(async request => {
				if ((request.agent === "reviewer" || request.agent === "plan_reviewer") && request.context) {
					seenContext = request.context;
				}
				return base(request);
			}),
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession(),
		});

		const workflowId = await engine.startWorkflow({
			request: "Context must include snapshot",
			constraints: "Do not approve incomplete coverage",
		});
		const result = await engine.run(workflowId);
		// Empty coverage is blocked by the gate — still proves context injection happened.
		expect(result.state.status).toBe("blocked");
		expect(seenContext).toContain("Authoritative requirements snapshot");
		expect(seenContext).toContain("user:req-001");
		expect(seenContext).toContain("user:constraint-001");
		expect(seenContext).toContain("Context must include snapshot");
	});
});
