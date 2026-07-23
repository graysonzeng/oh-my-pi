import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactStore } from "../../src/workflow/artifact-store";
import { DEFAULT_MODEL_PROFILES } from "../../src/workflow/default-config";
import { WorkflowEngine } from "../../src/workflow/engine";
import { WorkflowTimeoutError } from "../../src/workflow/errors";
import { ModelRouter } from "../../src/workflow/model-router";
import { RuntimeAdapter } from "../../src/workflow/runtime-adapter";
import { WorkflowStore } from "../../src/workflow/sqlite-store";
import { fakeSession, implArtifact, passVerifier, planArtifact, reviewArtifact } from "./helpers";

describe("WorkflowEngine profile fallback", () => {
	let store: WorkflowStore;
	let artifactDir: string;

	beforeEach(async () => {
		store = new WorkflowStore(":memory:");
		artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-fb-"));
	});

	afterEach(async () => {
		store.close();
		await fs.rm(artifactDir, { recursive: true, force: true });
	});

	it("retries planning with fallback profile after retryable timeout", async () => {
		const profiles = Object.values(DEFAULT_MODEL_PROFILES);
		const router = new ModelRouter(profiles);
		let planCalls = 0;
		const seenProfiles: string[] = [];

		const engine = new WorkflowEngine({
			store,
			router,
			session: fakeSession(),
			verifier: passVerifier(),
			artifactStore: new ArtifactStore(artifactDir),
			adapter: new RuntimeAdapter(async request => {
				// Only fail first planner call
				if (request.agent === "designer" || request.agent === "planner") {
					planCalls += 1;
					const model = Array.isArray(request.model) ? request.model[0] : request.model;
					seenProfiles.push(String(model));
					if (planCalls === 1) {
						throw new WorkflowTimeoutError("planner timed out");
					}
					return {
						result: {
							id: "raw-plan",
							structuredOutput: { status: "valid", data: planArtifact() },
						},
					};
				}
				// other roles succeed
				if (String(request.assignment).includes("Review the plan")) {
					return {
						result: {
							id: "raw-pr",
							structuredOutput: { status: "valid", data: reviewArtifact("approved", "plan") },
						},
					};
				}
				if (String(request.assignment).includes("Implement")) {
					return {
						result: {
							id: "raw-impl",
							structuredOutput: { status: "valid", data: implArtifact() },
							patchPath: "patches/x.patch",
							branchName: "wf/impl",
						},
					};
				}
				return {
					result: {
						id: "raw-cr",
						structuredOutput: { status: "valid", data: reviewArtifact("approved", "implementation") },
					},
				};
			}),
		});

		const id = await engine.startWorkflow({ request: "fallback" });
		const result = await engine.run(id);
		expect(result.state.status).toBe("completed");
		expect(planCalls).toBe(2);
		// audit should include a fallback reason somewhere
		expect(result.routingAudit.some(a => String(a.reason).includes("fallback") || a.profileId)).toBe(true);
	});
});
