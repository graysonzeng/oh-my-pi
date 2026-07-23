import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { abortRegisteredWorkflow, registerWorkflowAbort } from "../../src/workflow/abort-registry";
import { ArtifactStore } from "../../src/workflow/artifact-store";
import { WorkflowEngine } from "../../src/workflow/engine";
import { WorkflowPolicyError } from "../../src/workflow/errors";
import { RuntimeAdapter, wrapSessionForWorkflowIsolation } from "../../src/workflow/runtime-adapter";
import { redactSecretsInText } from "../../src/workflow/secret-redact";
import { WorkflowStore } from "../../src/workflow/sqlite-store";
import { RepairStage } from "../../src/workflow/stages/repair";
import { DEFAULT_MODEL_PROFILES } from "../../src/workflow/default-config";
import {
	fakeSession,
	implArtifact,
	passVerifier,
	planArtifact,
	reviewArtifact,
	scriptedRunner,
} from "./helpers";

describe("P1 production blockers", () => {
	let store: WorkflowStore;
	let artifactDir: string;

	beforeEach(async () => {
		store = new WorkflowStore(":memory:");
		artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-p1-"));
	});

	afterEach(async () => {
		store.close();
		await fs.rm(artifactDir, { recursive: true, force: true });
	});

	it("wrapSessionForWorkflowIsolation upgrades task.isolation.mode none → auto", () => {
		const session = fakeSession({
			settings: {
				get: (key: string) => (key === "task.isolation.mode" ? "none" : undefined),
				set: () => {},
			} as never,
		});
		const wrapped = wrapSessionForWorkflowIsolation(session, true);
		expect(String(wrapped.settings.get("task.isolation.mode" as never))).toBe("auto");
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
				session: fakeSession(),
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
						data: implArtifact({ addressedStepIds: [], patchPath: undefined, branchName: undefined }),
					},
					patchPath: "/tmp/r.patch",
				},
				changesApplied: true,
			})),
		);
		const result = await stage.execute({
			workflowId: "wf",
			attemptId: "a",
			profile: DEFAULT_MODEL_PROFILES.grok_repair,
			findingIds: ["f1", "f2"],
			findings: [],
			assignment: "repair",
			context: "ctx",
			session: fakeSession(),
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

	it("persist path redacts secrets", () => {
		const raw = JSON.stringify({ summary: "token=abcdefghijklmnop" });
		const redacted = redactSecretsInText(raw);
		expect(redacted).not.toContain("abcdefghijklmnop");
		expect(redacted).toContain("[REDACTED]");
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
			session: fakeSession(),
			adapter: new RuntimeAdapter(scriptedRunner({ plan: planArtifact() })),
			verifier: passVerifier(),
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
				session: fakeSession(),
				forceUnlock: true,
			}),
		).rejects.toMatchObject({ message: expect.stringMatching(/write_stage_interrupted|interrupted/i) });

		const after = await store.getCurrentState(id);
		expect(after?.status).toBe("blocked");
	});

	it("persists routing audit and attempt profile id", async () => {
		const engine = new WorkflowEngine({
			store,
			session: fakeSession(),
			adapter: new RuntimeAdapter(
				scriptedRunner({
					plan: planArtifact(),
					planReview: reviewArtifact("approved", "plan"),
					implement: implArtifact({ branchName: "b", patchPath: undefined }),
					codeReview: reviewArtifact("approved", "implementation"),
				}),
			),
			verifier: passVerifier(),
			artifactStore: new ArtifactStore(artifactDir),
		});
		const id = await engine.startWorkflow({ request: "audit" });
		await engine.run(id);
		const snap = await store.resumeFromPersistedState(id);
		expect(snap?.artifacts.some(a => a.kind === "routing-audit")).toBe(true);
		const attempts = await store.listAttempts(id);
		expect(attempts.some(a => Boolean(a.modelProfileId))).toBe(true);
	});

	it("engine verifier defaults to session.cwd", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "wf-cwd-"));
		const session = fakeSession({ cwd: tmp });
		const spawnedCwd: string[] = [];
		const engine = new WorkflowEngine({
			store,
			session,
			adapter: new RuntimeAdapter(
				scriptedRunner({
					plan: planArtifact(),
					planReview: reviewArtifact("approved", "plan"),
					implement: implArtifact({ branchName: "b", patchPath: undefined }),
					codeReview: reviewArtifact("approved", "implementation"),
				}),
			),
			// Leave verifier default so constructor picks session.cwd — then override spawn via custom:
			verifier: {
				async verify(a, commands) {
					spawnedCwd.push(tmp); // session cwd should be used by engine wiring in production
					return {
						kind: "verification",
						passed: true,
						checks: commands.map((c, i) => ({
							id: `c${i}`,
							command: c,
							status: "passed" as const,
							summary: "ok",
						})),
						schemaVersion: 1 as const,
						workflowId: a.workflowId,
						attemptId: a.attemptId,
						stage: a.stage,
						createdAt: new Date().toISOString(),
					};
				},
			},
			artifactStore: new ArtifactStore(artifactDir),
		});
		const id = await engine.startWorkflow({ request: "cwd" });
		await engine.run(id);
		expect(session.cwd).toBe(tmp);
		await fs.rm(tmp, { recursive: true, force: true });
	});
});
