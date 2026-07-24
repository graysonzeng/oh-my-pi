import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactStore } from "../../src/workflow/artifact-store";
import { DEFAULT_MODEL_PROFILES } from "../../src/workflow/default-config";
import { WorkflowEngine } from "../../src/workflow/engine";
import { WorkflowError } from "../../src/workflow/errors";
import { normalizeModelProfile } from "../../src/workflow/model-profile-registry";
import { WorkflowRuntimeDispatcher } from "../../src/workflow/runtime-dispatcher";
import { WorkflowStore } from "../../src/workflow/sqlite-store";
import type { ModelProfile, RuntimePort, WorkflowAgentRequest, WorkflowAgentResult } from "../../src/workflow/types";
import {
	fakeSession,
	implArtifact,
	materializeSamplePatch,
	passVerifier,
	planArtifact,
	reviewArtifact,
} from "./helpers";

function profile(
	base: ModelProfile,
	runtime: ModelProfile["runtime"],
	modelPattern: string,
	extra: Partial<ModelProfile> = {},
): ModelProfile {
	return normalizeModelProfile({
		...base,
		...extra,
		modelPattern,
		runtime,
	});
}

describe("mixed runtime engine offline", () => {
	let store: WorkflowStore;
	let artifactDir: string;

	beforeEach(async () => {
		store = new WorkflowStore(":memory:");
		artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-mixed-"));
	});

	afterEach(async () => {
		store.close();
		await fs.rm(artifactDir, { recursive: true, force: true });
	});

	it("routes Claude CLI planner, Codex plan review, Codex implementer, Claude code review", async () => {
		const routes: string[] = [];
		const tracking = {
			claude_planner: profile(DEFAULT_MODEL_PROFILES.claude_planner, { kind: "claude_cli" }, "claude-sonnet-4-6"),
			gpt_plan_reviewer: profile(
				DEFAULT_MODEL_PROFILES.gpt_plan_reviewer,
				{ kind: "codex_cli", profile: "cli" },
				"gpt-5.6-sol",
			),
			grok_implementer: profile(DEFAULT_MODEL_PROFILES.grok_implementer, { kind: "codex_cli" }, "grok-4.5"),
			claude_reviewer: profile(DEFAULT_MODEL_PROFILES.claude_reviewer, { kind: "claude_cli" }, "claude-sonnet-4-6"),
			// Keep remaining defaults embedded so fallbacks remain defined
			...Object.fromEntries(
				Object.entries(DEFAULT_MODEL_PROFILES)
					.filter(
						([id]) =>
							!["claude_planner", "gpt_plan_reviewer", "grok_implementer", "claude_reviewer"].includes(id),
					)
					.map(([id, p]) => [id, normalizeModelProfile(p)]),
			),
		};

		const makePort = (label: string): RuntimePort => ({
			buildRequest: r => r,
			run: async <TArtifact = unknown>(request: WorkflowAgentRequest): Promise<WorkflowAgentResult<TArtifact>> => {
				const model = Array.isArray(request.profile.modelPattern)
					? request.profile.modelPattern[0]
					: request.profile.modelPattern;
				const kind = request.profile.runtime?.kind ?? "embedded";
				routes.push(`${kind}:${request.role}:${model}`);
				if (request.role === "planner") {
					return {
						artifact: planArtifact() as TArtifact,
						rawResultId: `${label}-plan`,
						attemptId: request.attemptId,
						resolvedProvider: "claude-cli",
						resolvedModel: "claude-sonnet-4-6",
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					};
				}
				if (request.role === "plan_reviewer") {
					return {
						artifact: reviewArtifact("approved", "plan") as TArtifact,
						rawResultId: `${label}-plan-review`,
						attemptId: request.attemptId,
						resolvedProvider: "codex-cli",
						resolvedModel: "gpt-5.6-sol",
						usage: {
							input: 2,
							output: 2,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 4,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					};
				}
				if (request.role === "implementer") {
					const patchPath = await materializeSamplePatch(request.session.cwd, "patches/x.patch");
					return {
						artifact: implArtifact({ patchPath }) as TArtifact,
						rawResultId: `${label}-impl`,
						attemptId: request.attemptId,
						patchPath,
						changesApplied: true,
						resolvedProvider: "codex-cli",
						resolvedModel: "grok-4.5",
						usage: {
							input: 3,
							output: 3,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 6,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					};
				}
				if (request.role === "code_reviewer") {
					return {
						artifact: reviewArtifact("approved", "implementation") as TArtifact,
						rawResultId: `${label}-code-review`,
						attemptId: request.attemptId,
						resolvedProvider: "claude-cli",
						resolvedModel: "claude-sonnet-4-6",
					};
				}
				throw new Error(`unexpected role ${request.role}`);
			},
		});

		// One port per kind so dispatcher selection is exercised even though
		// each fake returns the same role-based script.
		const adapter = new WorkflowRuntimeDispatcher({
			embedded: makePort("embedded"),
			codexCli: makePort("codex"),
			claudeCli: makePort("claude"),
		});

		const engine = new WorkflowEngine({
			store,
			config: { profiles: tracking },
			adapter,
			verifier: passVerifier(),
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession({ cwd: artifactDir }),
		});

		const workflowId = await engine.startWorkflow({ request: "mixed runtime" });
		const result = await engine.run(workflowId, fakeSession({ cwd: artifactDir }));
		expect(result.state.status).toBe("completed");
		expect(routes).toEqual([
			"claude_cli:planner:claude-sonnet-4-6",
			"codex_cli:plan_reviewer:gpt-5.6-sol",
			"codex_cli:implementer:grok-4.5",
			"claude_cli:code_reviewer:claude-sonnet-4-6",
		]);
	});

	it("falls back from Claude auth failure to GPT planner profile", async () => {
		const routes: string[] = [];
		const profiles = {
			...DEFAULT_MODEL_PROFILES,
			claude_planner: profile(DEFAULT_MODEL_PROFILES.claude_planner, { kind: "claude_cli" }, "claude-sonnet-4-6", {
				retryPolicy: {
					maxAttempts: 2,
					retryableErrorKinds: ["authentication", "timeout", "provider_transient"],
					fallbackProfileIds: ["gpt_planner"],
				},
			}),
			gpt_planner: profile(DEFAULT_MODEL_PROFILES.gpt_planner, { kind: "codex_cli" }, "gpt-5.6-sol", {
				retryPolicy: {
					maxAttempts: 1,
					retryableErrorKinds: [],
					fallbackProfileIds: [],
				},
			}),
		};

		const adapter = new WorkflowRuntimeDispatcher({
			embedded: {
				buildRequest: r => r,
				run: async <TArtifact = unknown>(): Promise<WorkflowAgentResult<TArtifact>> => {
					throw new Error("embedded unused");
				},
			},
			claudeCli: {
				buildRequest: r => r,
				run: async <TArtifact = unknown>(
					request: WorkflowAgentRequest,
				): Promise<WorkflowAgentResult<TArtifact>> => {
					routes.push(`claude:${request.role}`);
					throw new WorkflowError("auth failed", "authentication");
				},
			},
			codexCli: {
				buildRequest: r => r,
				run: async <TArtifact = unknown>(
					request: WorkflowAgentRequest,
				): Promise<WorkflowAgentResult<TArtifact>> => {
					routes.push(`codex:${request.role}`);
					if (request.role === "planner") {
						return {
							artifact: planArtifact() as TArtifact,
							rawResultId: "gpt-plan",
							attemptId: request.attemptId,
							resolvedProvider: "codex-cli",
							resolvedModel: "gpt-5.6-sol",
						};
					}
					throw new Error(`unexpected ${request.role}`);
				},
			},
		});

		const engine = new WorkflowEngine({
			store,
			config: { profiles },
			adapter,
			verifier: passVerifier(),
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession({ cwd: artifactDir }),
		});

		const id = await engine.startWorkflow({ request: "fallback" });
		// Advance through create + planning only
		await engine.resume(id, { singleStep: true });
		await engine.resume(id, { singleStep: true });
		expect(routes).toEqual(["claude:planner", "codex:planner"]);
		expect(engine.routingAudit.some(a => a.profileId === "gpt_planner")).toBe(true);
	});
});
