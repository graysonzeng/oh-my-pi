import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactStore } from "../../src/workflow/artifact-store";
import { DEFAULT_MODEL_PROFILES } from "../../src/workflow/default-config";
import { WorkflowEngine } from "../../src/workflow/engine";
import { WorkflowPolicyError } from "../../src/workflow/errors";
import { assertSupportedModelProfile } from "../../src/workflow/model-profile-registry";
import { RuntimeAdapter } from "../../src/workflow/runtime-adapter";
import { WorkflowStore } from "../../src/workflow/sqlite-store";
import { fakeSession, implArtifact, passVerifier, planArtifact, reviewArtifact, scriptedRunner } from "./helpers";

describe("WorkflowEngine happy path", () => {
	let store: WorkflowStore;
	let artifactDir: string;
	let engine: WorkflowEngine;

	beforeEach(async () => {
		store = new WorkflowStore(":memory:");
		artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-happy-"));
		engine = new WorkflowEngine({
			store,
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
		});
	});

	afterEach(async () => {
		store.close();
		await fs.rm(artifactDir, { recursive: true, force: true });
	});

	it("starts a workflow without invoking a provider", async () => {
		const workflowId = await engine.startWorkflow({ request: "test" }, { degradedMode: false });
		expect((await engine.getState(workflowId))?.status).toBe("created");
	});

	it("runs full accepted path to completed", async () => {
		const workflowId = await engine.startWorkflow({ request: "ship feature" });
		const result = await engine.run(workflowId, fakeSession());
		expect(result.state.status).toBe("completed");
		expect(result.plan?.kind).toBe("plan");
		expect(result.implementation?.patchPath).toBe("patches/x.patch");
		expect(result.routingAudit.length).toBeGreaterThan(0);
	});

	it("reports available budget", async () => {
		expect(await engine.budgetCheckPreStage()).toBe(true);
	});

	it("constructs router from configured profiles so custom planner routing is used", async () => {
		const customPlanner = {
			...DEFAULT_MODEL_PROFILES.claude_planner,
			id: "custom_planner",
			modelPattern: ["custom-planner-model"],
			retryPolicy: {
				maxAttempts: 1,
				retryableErrorKinds: [],
				fallbackProfileIds: [],
			},
		};
		const seenModels: string[] = [];
		const customEngine = new WorkflowEngine({
			store,
			config: {
				profiles: {
					...DEFAULT_MODEL_PROFILES,
					claude_planner: customPlanner,
				},
			},
			adapter: new RuntimeAdapter(async request => {
				if (request.agent === "designer" || request.agent === "planner") {
					const model = Array.isArray(request.model) ? request.model[0] : request.model;
					seenModels.push(String(model));
					return {
						result: {
							id: "raw-plan",
							structuredOutput: { status: "valid", data: planArtifact() },
						},
					};
				}
				throw new Error(`unexpected agent ${request.agent}`);
			}),
			verifier: passVerifier(),
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession(),
		});
		const id = await customEngine.startWorkflow({ request: "custom profiles" });
		await customEngine.resume(id, { singleStep: true }); // created → planning
		await customEngine.resume(id, { singleStep: true }); // run planning
		expect(seenModels).toContain("custom-planner-model");
		expect(customEngine.routingAudit.some(a => a.profileId === "custom_planner")).toBe(true);
	});

	it("rejects unsupported model profile fields at construction", () => {
		expect(() =>
			assertSupportedModelProfile({
				...DEFAULT_MODEL_PROFILES.grok_implementer,
				toolAliases: { bash: "shell" },
			}),
		).toThrow(WorkflowPolicyError);
		expect(
			() =>
				new WorkflowEngine({
					store,
					config: {
						profiles: {
							...DEFAULT_MODEL_PROFILES,
							grok_implementer: {
								...DEFAULT_MODEL_PROFILES.grok_implementer,
								maxInputTokens: 1000,
							},
						},
					},
					session: fakeSession(),
				}),
		).toThrow(/unsupported_model_profile_field/);
	});
});
