import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactStore } from "../../src/workflow/artifact-store";
import { DEFAULT_MODEL_PROFILES } from "../../src/workflow/default-config";
import { WorkflowEngine } from "../../src/workflow/engine";
import { WorkflowPolicyError } from "../../src/workflow/errors";
import { RuntimeAdapter } from "../../src/workflow/runtime-adapter";
import {
	buildWorkflowConfigFromSessionSettings,
	resolveWorkflowProfilesFromSettings,
	resolveWorkflowQualityRoutesFromSettings,
} from "../../src/workflow/session-config";
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

	it("partial override of a removed default id fails closed instead of surviving incomplete", () => {
		// glm_implementer was removed from defaults; a leftover settings override must not
		// silently inherit the old default or survive as a partial entry that would crash
		// mid-stage (missing contextPolicy). Migration requires a full custom profile.
		expect(() =>
			resolveWorkflowProfilesFromSettings(
				{ glm_implementer: { modelPattern: ["glm-5.2"] } },
				DEFAULT_MODEL_PROFILES,
			),
		).toThrow("incomplete_model_profile");
	});

	it("quality routes referencing a removed profile id fail closed", () => {
		const strict = (id: string, role: "planner" | "plan_reviewer" | "code_reviewer" | "repair") => ({
			...DEFAULT_MODEL_PROFILES.deepseek_implementer,
			id,
			roles: [role],
			strictIdentity: true,
			modelPattern: [`test/${id}`],
		});
		const profiles = {
			...DEFAULT_MODEL_PROFILES,
			s_planner: strict("s_planner", "planner"),
			s_pr: strict("s_pr", "plan_reviewer"),
			s_cr: strict("s_cr", "code_reviewer"),
			s_repair: strict("s_repair", "repair"),
		};
		const routes = {
			balanced: {
				planner: ["s_planner"],
				plan_reviewer: ["s_pr"],
				implementer: ["glm_implementer"],
				code_reviewer: ["s_cr"],
				repair: ["s_repair"],
			},
		};
		expect(() => resolveWorkflowQualityRoutesFromSettings(routes, profiles)).toThrow(WorkflowPolicyError);
		expect(() => resolveWorkflowQualityRoutesFromSettings(routes, profiles)).toThrow(/unknown_quality_route_profile/);
	});
	it("treats arbitration as optional known route with strict configured validation", () => {
		const strict = (
			id: string,
			role: "planner" | "plan_reviewer" | "plan_arbitrator" | "implementer" | "code_reviewer" | "repair",
		) => ({
			...DEFAULT_MODEL_PROFILES.deepseek_implementer,
			id,
			roles: [role],
			strictIdentity: true,
			modelPattern: [`test/${id}`],
		});
		const profiles = {
			...DEFAULT_MODEL_PROFILES,
			s_planner: strict("s_planner", "planner"),
			s_pr: strict("s_pr", "plan_reviewer"),
			s_arb: strict("s_arb", "plan_arbitrator"),
			s_impl: strict("s_impl", "implementer"),
			s_cr: strict("s_cr", "code_reviewer"),
			s_repair: strict("s_repair", "repair"),
		};
		const required = {
			planner: ["s_planner"],
			plan_reviewer: ["s_pr"],
			implementer: ["s_impl"],
			code_reviewer: ["s_cr"],
			repair: ["s_repair"],
		};
		const withoutArbitration = resolveWorkflowQualityRoutesFromSettings({ balanced: required }, profiles);
		expect(withoutArbitration.balanced?.plan_arbitrator).toEqual([]);
		const withArbitration = resolveWorkflowQualityRoutesFromSettings(
			{ balanced: { ...required, plan_arbitrator: ["s_arb"] } },
			profiles,
		);
		expect(withArbitration.balanced?.plan_arbitrator).toEqual(["s_arb"]);
		const badArbitrator = {
			...profiles,
			s_bad_arb: strict("s_bad_arb", "plan_reviewer"),
		};
		expect(() =>
			resolveWorkflowQualityRoutesFromSettings(
				{ balanced: { ...required, plan_arbitrator: ["s_bad_arb"] } },
				badArbitrator,
			),
		).toThrow(/quality_route_profile_role_mismatch/);
	});
});
