import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactStore } from "../../src/workflow/artifact-store";
import { DEFAULT_MODEL_PROFILES } from "../../src/workflow/default-config";
import { WorkflowEngine } from "../../src/workflow/engine";
import { RuntimeAdapter } from "../../src/workflow/runtime-adapter";
import { buildWorkflowConfigFromSessionSettings } from "../../src/workflow/session-config";
import { WorkflowStore } from "../../src/workflow/sqlite-store";
import { fakeSession, planArtifact } from "./helpers";

describe("buildWorkflowConfigFromSessionSettings profiles", () => {
	let store: WorkflowStore;
	let artifactDir: string;

	beforeEach(async () => {
		store = new WorkflowStore(":memory:");
		artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-session-cfg-"));
	});

	afterEach(async () => {
		store.close();
		await fs.rm(artifactDir, { recursive: true, force: true });
	});

	it("falls back to default profiles when settings omit workflow.profiles", () => {
		const config = buildWorkflowConfigFromSessionSettings(() => undefined);
		expect(config.profiles).toEqual(DEFAULT_MODEL_PROFILES);
	});

	it("uses settings workflow.profiles so custom planner routing is selected", async () => {
		const customPlanner = {
			...DEFAULT_MODEL_PROFILES.claude_planner,
			id: "settings_planner",
			modelPattern: ["settings-planner-model"],
			retryPolicy: {
				maxAttempts: 1,
				retryableErrorKinds: [],
				fallbackProfileIds: [],
			},
		};
		const settingsProfiles = {
			...DEFAULT_MODEL_PROFILES,
			claude_planner: customPlanner,
		};
		const config = buildWorkflowConfigFromSessionSettings(key =>
			key === "workflow.profiles" ? settingsProfiles : undefined,
		);
		const seenModels: string[] = [];
		const engine = new WorkflowEngine({
			store,
			config,
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
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession(),
		});
		const id = await engine.startWorkflow({ request: "settings profiles" });
		await engine.resume(id, { singleStep: true });
		await engine.resume(id, { singleStep: true });
		expect(seenModels).toContain("settings-planner-model");
		expect(engine.routingAudit.some(a => a.profileId === "settings_planner")).toBe(true);
	});
});
