import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import { abortRegisteredWorkflow, registerWorkflowAbort } from "../../src/workflow/abort-registry";
import { ArtifactStore } from "../../src/workflow/artifact-store";
import { DEFAULT_MODEL_PROFILES } from "../../src/workflow/default-config";
import { WorkflowEngine } from "../../src/workflow/engine";
import { WorkflowPolicyError } from "../../src/workflow/errors";
import { RuntimeAdapter, wrapSessionForWorkflowIsolation } from "../../src/workflow/runtime-adapter";
import { WorkflowStore } from "../../src/workflow/sqlite-store";
import { RepairStage } from "../../src/workflow/stages/repair";
import {
	fakeSession,
	implArtifact,
	materializeSamplePatch,
	passVerifier,
	planArtifact,
	realTempWorkspace,
	reviewArtifact,
	scriptedRunner,
	type RealTempWorkspace,
} from "./helpers";

describe("P1 production blockers", () => {
	let store: WorkflowStore;
	let artifactDir: string;
	let workspace: RealTempWorkspace;

	beforeEach(async () => {
		workspace = await realTempWorkspace();
		await materializeSamplePatch(workspace.cwd);
		store = new WorkflowStore(":memory:");
		artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-p1-"));
	});

	afterEach(async () => {
		store.close();
		await fs.rm(artifactDir, { recursive: true, force: true });
		await workspace.cleanup();
	});

	it("keeps isolation local while inherited model roles remain live and callable", () => {
		const settings = Settings.isolated({ "task.isolation.enabled": false });
		const session = fakeSession({ settings });
		const wrapped = wrapSessionForWorkflowIsolation(session, true);
		settings.setModelRole("default", "fixture/first");
		expect(wrapped.settings.getModelRoles()).toEqual(settings.getModelRoles());
		settings.setModelRole("default", "fixture/updated");
		expect(wrapped.settings.getModelRoles()).toEqual(settings.getModelRoles());
		expect(wrapped.settings.get("task.isolation.enabled")).toBe(true);
		expect(settings.get("task.isolation.enabled")).toBe(false);
		expect(wrapped.settings.get("workflow.enabled")).toBe(settings.get("workflow.enabled"));
	});

	it("adapter fails when changesApplied is false under isolation apply", async () => {
		const adapter = new RuntimeAdapter(async () => ({
			result: {
				id: "raw",
				structuredOutput: {
					status: "valid",
					data: implArtifact({ patchPath: undefined, branchName: undefined }),
				},
				patchPath: "/tmp/x.patch",
				branchName: undefined,
			},
			changesApplied: false,
		}));
		await expect(
			adapter.run({
				workflowId: "wf",
				attemptId: "a",
				role: "implementer",
				profile: DEFAULT_MODEL_PROFILES.grok_implementer,
				assignment: "impl",
				session: fakeSession({ cwd: workspace.cwd }),
				isolation: { requested: true, merge: "patch", apply: true },
			}),
		).rejects.toMatchObject({ details: expect.objectContaining({}) });
	});

	it("repair does not auto-resolve all findings when addressedStepIds is empty", async () => {
		const stage = new RepairStage(
			new RuntimeAdapter(async () => ({
				result: {
					id: "raw",
					structuredOutput: {
						status: "valid",
						data: implArtifact({ addressedStepIds: [], summary: "noop" }),
					},
					patchPath: "patches/x.patch",
					branchName: "wf/r",
				},
			})),
		);
		const result = await stage.execute({
			workflowId: "wf",
			attemptId: "a",
			profile: DEFAULT_MODEL_PROFILES.grok_repair,
			findingIds: ["f1", "f2"],
			findings: [],
			assignment: "Repair findings: f1, f2",
			context: "ctx",
			session: fakeSession({ cwd: workspace.cwd }),
		});
		expect(result.artifact.addressedStepIds).toEqual([]);
		expect(result.artifact.unresolved).toEqual(["f1", "f2"]);
	});

	it("sqlite store rejects illegal transitions", async () => {
		const id = await store.createWorkflow({ request: "x" }, {});
		await expect(store.transitionWorkflow(id, "created", "completed", "illegal")).rejects.toBeInstanceOf(
			WorkflowPolicyError,
		);
	});

	it("persisted artifacts redact secret-like values through the engine store path", async () => {
		const arts = new ArtifactStore(artifactDir);
		const engine = new WorkflowEngine({
			store,
			session: fakeSession({ cwd: workspace.cwd }),
			adapter: new RuntimeAdapter(
				scriptedRunner({
					plan: planArtifact({ summary: "token=abcdefghijklmnop" }),
					planReview: reviewArtifact("approved", "plan"),
					implement: implArtifact(),
					codeReview: reviewArtifact("approved", "implementation"),
				}),
			),
			verifier: passVerifier(workspace.cwd),
			artifactStore: arts,
		});
		const id = await engine.startWorkflow({ request: "redact" });
		await engine.run(id);
		const snap = await store.resumeFromPersistedState(id);
		const planMeta = snap?.artifacts.find(a => a.kind === "plan");
		expect(planMeta).toBeDefined();
		const loaded = await arts.load(planMeta!.relativePath, planMeta!.sha256);
		expect(loaded?.content).toBeDefined();
		expect(loaded?.content).not.toContain("abcdefghijklmnop");
		expect(loaded?.content).toContain("[REDACTED]");
	});

	it("abort registry signals registered controllers", () => {
		const c = new AbortController();
		registerWorkflowAbort("wf_abort", c);
		expect(abortRegisteredWorkflow("wf_abort")).toBe(true);
		expect(c.signal.aborted).toBe(true);
	});

	it("write-stage crash does not auto-replay implement", async () => {
		const engine = new WorkflowEngine({
			store,
			session: fakeSession({ cwd: workspace.cwd }),
			adapter: new RuntimeAdapter(scriptedRunner({ plan: planArtifact() })),
			verifier: passVerifier(workspace.cwd),
			artifactStore: new ArtifactStore(artifactDir),
		});
		const id = await engine.startWorkflow({ request: "crash" });
		// Advance to planning then force an in_progress implementing attempt
		await store.transitionWorkflow(id, "created", "planning", "go");
		await store.transitionWorkflow(id, "planning", "plan_review", "go");
		await store.transitionWorkflow(id, "plan_review", "implementing", "go");
		const st = await store.getCurrentState(id);
		const attemptId = await store.beginAttempt(id, "implementing", "grok", st!.version);
		// Leave attempt in_progress (simulate crash mid-write)
		const st2 = await store.getCurrentState(id);
		expect(st2?.currentAttemptId).toBe(attemptId);

		await expect(
			engine.resume(id, {
				singleStep: true,
				session: fakeSession({ cwd: workspace.cwd }),
				forceUnlock: true,
			}),
		).rejects.toMatchObject({ message: expect.stringMatching(/write_stage_interrupted|interrupted/i) });

		const after = await store.getCurrentState(id);
		expect(after?.status).toBe("blocked");
	});

	it("persists routing audit and attempt profile id", async () => {
		const engine = new WorkflowEngine({
			store,
			session: fakeSession({ cwd: workspace.cwd }),
			adapter: new RuntimeAdapter(
				scriptedRunner({
					plan: planArtifact(),
					planReview: reviewArtifact("approved", "plan"),
					implement: implArtifact(),
					codeReview: reviewArtifact("approved", "implementation"),
				}),
			),
			verifier: passVerifier(workspace.cwd),
			artifactStore: new ArtifactStore(artifactDir),
		});
		const id = await engine.startWorkflow({ request: "audit" });
		await engine.run(id);
		const snap = await store.resumeFromPersistedState(id);
		expect(snap?.artifacts.some(a => a.kind === "routing-audit")).toBe(true);
		const attempts = await store.listAttempts(id);
		expect(attempts.some(a => Boolean(a.modelProfileId))).toBe(true);
	});

	it("runs the real verifier commands in session.cwd", async () => {
		const marker = `cwd-marker-${crypto.randomUUID()}`;
		await Bun.write(path.join(workspace.cwd, marker), "verify from this checkout\n");
		const command = `test -f ${marker}`;
		const engine = new WorkflowEngine({
			store,
			session: fakeSession({ cwd: workspace.cwd }),
			config: { verificationCommands: [command] },
			adapter: new RuntimeAdapter(
				scriptedRunner({
					plan: planArtifact({ verificationCommands: [command] }),
					planReview: reviewArtifact("approved", "plan"),
					implement: implArtifact(),
					codeReview: reviewArtifact("approved", "implementation"),
				}),
			),
			artifactStore: new ArtifactStore(artifactDir),
		});
		const id = await engine.startWorkflow({ request: "cwd" });
		const result = await engine.run(id);
		expect(result.state.status).toBe("completed");
		expect(result.verification?.checks.some(check => check.command === command && check.status === "passed")).toBe(
			true,
		);
	});

	it("accumulates runtime toolCalls into the budget ledger snapshot", async () => {
		const engine = new WorkflowEngine({
			store,
			session: fakeSession({ cwd: workspace.cwd }),
			adapter: new RuntimeAdapter(
				scriptedRunner({
					plan: planArtifact(),
					planReview: reviewArtifact("approved", "plan"),
					implement: implArtifact(),
					codeReview: reviewArtifact("approved", "implementation"),
				}),
			),
			verifier: passVerifier(workspace.cwd),
			artifactStore: new ArtifactStore(artifactDir),
		});
		const id = await engine.startWorkflow({ request: "toolcalls" });
		await engine.run(id);
		expect(engine.budgetSnapshot().toolCalls).toBeGreaterThan(0);
	});
});
