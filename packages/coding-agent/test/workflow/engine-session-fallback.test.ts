import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactStore } from "../../src/workflow/artifact-store";
import { DEFAULT_MODEL_PROFILES } from "../../src/workflow/default-config";
import { WorkflowEngine } from "../../src/workflow/engine";
import { WorkflowError } from "../../src/workflow/errors";
import {
	RuntimeAdapter,
	type StructuredRunner,
	type StructuredRunnerRequest,
} from "../../src/workflow/runtime-adapter";
import { SESSION_FALLBACK_PROFILE_ID } from "../../src/workflow/session-fallback-profile";
import { WorkflowStore } from "../../src/workflow/sqlite-store";
import type { ImplementationArtifactV1, ModelProfile } from "../../src/workflow/types";
import {
	fakeSession,
	implArtifact,
	materializeSamplePatch,
	passVerifier,
	planArtifact,
	reviewArtifact,
} from "./helpers";

const SESSION_MODEL = "deepseek/deepseek-v4-flash:max";

function attestRuntimeIdentity(request: StructuredRunnerRequest): string {
	const selector = Array.isArray(request.model) ? request.model[0] : request.model;
	let provider = "xai";
	let modelId = "grok-code-test";
	if (typeof selector === "string" && selector.trim().length > 0) {
		if (selector.includes("/")) {
			const slash = selector.indexOf("/");
			provider = selector.slice(0, slash);
			modelId = selector.slice(slash + 1) || modelId;
		} else {
			modelId = selector;
			if (modelId.startsWith("claude") || modelId.startsWith("anthropic")) provider = "anthropic";
			else if (
				modelId.startsWith("gpt") ||
				modelId.startsWith("o1") ||
				modelId.startsWith("o3") ||
				modelId.startsWith("o4")
			)
				provider = "openai";
			else if (modelId.startsWith("gemini")) provider = "google";
			else if (modelId.startsWith("glm")) provider = "zhipu";
			else if (modelId.startsWith("deepseek")) provider = "deepseek";
			else if (modelId.startsWith("grok")) provider = "xai";
		}
	}
	const resolvedModel = `${provider}/${modelId}`;
	request.onResponse?.(
		{
			status: 200,
			headers: { "x-provider-model": modelId, "x-omp-resolved-provider": provider },
		} as never,
		{
			provider,
			id: modelId,
			reasoning: true,
			thinking: {
				efforts:
					request.thinkingLevel && request.thinkingLevel !== "auto"
						? [request.thinkingLevel]
						: ["low", "medium", "high", "xhigh", "max"],
			},
		} as never,
	);
	return resolvedModel;
}

/** Runner that fails the first `failCount` implementer invocations with provider_transient. */
function chainRunner(opts: { failCount: number; seen: string[] }): StructuredRunner {
	// Plan-review identity pin requires resolvedModel (or identity receipt) from the runner,
	// matching production RuntimeAdapter + scriptedRunner fixtures.
	const fallbackResolvedModel = "xai/grok-code-test";
	return async request => {
		const agent = request.agent ?? "";
		if (agent === "designer" || agent === "planner") {
			const resolvedModel = attestRuntimeIdentity(request);
			return {
				result: {
					id: "plan",
					structuredOutput: { status: "valid" as const, data: planArtifact() },
					resolvedModel,
				},
			};
		}
		if (agent === "reviewer" || agent === "plan_reviewer" || agent === "code_reviewer") {
			const assignment = request.assignment ?? "";
			const subject =
				/code review|implementation/i.test(assignment) && !/plan/i.test(assignment) ? "implementation" : "plan";
			const resolvedModel = subject === "plan" ? attestRuntimeIdentity(request) : fallbackResolvedModel;
			return {
				result: {
					id: "review",
					structuredOutput: { status: "valid" as const, data: reviewArtifact("approved", subject) },
					resolvedModel,
				},
			};
		}
		if (agent === "task" || agent === "implementer" || agent === "repair") {
			const model = Array.isArray(request.model) ? String(request.model[0]) : String(request.model);
			opts.seen.push(model);
			if (opts.seen.length <= opts.failCount) {
				throw new WorkflowError("transient provider failure", "provider_transient", {});
			}
			const artifact: ImplementationArtifactV1 = implArtifact();
			const cwd = request.session?.cwd ?? "/tmp";
			if (artifact.patchPath) await materializeSamplePatch(cwd, artifact.patchPath);
			return {
				result: {
					id: "impl",
					structuredOutput: { status: "valid" as const, data: artifact },
					patchPath: artifact.patchPath,
					branchName: artifact.branchName,
					resolvedModel: model.includes("/") ? model : fallbackResolvedModel,
					usage: {
						input: 10,
						output: 20,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 30,
						cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
					},
				},
			};
		}
		throw new Error(`unexpected agent ${agent}`);
	};
}

function engineWith(
	store: WorkflowStore,
	artifactDir: string,
	runner: StructuredRunner,
	profiles?: Record<string, ModelProfile>,
) {
	return new WorkflowEngine({
		store,
		...(profiles ? { config: { profiles } } : {}),
		adapter: new RuntimeAdapter(runner),
		verifier: passVerifier(),
		artifactStore: new ArtifactStore(artifactDir),
		session: fakeSession(),
	});
}

describe("WorkflowEngine implementer chain with session-model last resort", () => {
	let store: WorkflowStore;
	let artifactDir: string;

	beforeEach(async () => {
		store = new WorkflowStore(":memory:");
		artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-fallback-"));
	});

	afterEach(async () => {
		store.close();
		await fs.rm(artifactDir, { recursive: true, force: true });
	});

	it("routes grok → astra → deepseek → session model across retryable failures", async () => {
		const seen: string[] = [];
		const engine = engineWith(store, artifactDir, chainRunner({ failCount: 3, seen }));
		const id = await engine.startWorkflow({ request: "chain fallback" });
		const result = await engine.run(id, fakeSession({ getActiveModelString: () => SESSION_MODEL }));
		expect(result.state.status).toBe("completed");
		// One retryable failure per static candidate, then the session model succeeds.
		expect(seen).toEqual(["grok-4.6", "gpt-6-astra", "deepseek-v4-flash", SESSION_MODEL]);
		const main = result.routingAudit.find(a => a.profileId === SESSION_FALLBACK_PROFILE_ID);
		expect(main).toBeDefined();
		expect(main?.reason).toBe("fallback_from:grok_implementer");
		expect(main?.degraded).toBe(true);
	});

	it("preflight-excluded primary does not truncate the chain (maxAttempts = candidate count)", async () => {
		// Simulate Grok being preflight-unavailable by dropping its profile: the router
		// prefers Astra, and the retry budget must still cover DeepSeek + the session model.
		const profiles = Object.fromEntries(
			Object.entries(DEFAULT_MODEL_PROFILES).filter(([id]) => id !== "grok_implementer"),
		);
		const seen: string[] = [];
		const engine = engineWith(store, artifactDir, chainRunner({ failCount: 2, seen }), profiles);
		const id = await engine.startWorkflow({ request: "truncated primary" });
		const result = await engine.run(id, fakeSession({ getActiveModelString: () => SESSION_MODEL }));
		expect(result.state.status).toBe("completed");
		expect(seen).toEqual(["gpt-6-astra", "deepseek-v4-flash", SESSION_MODEL]);
		const main = result.routingAudit.find(a => a.profileId === SESSION_FALLBACK_PROFILE_ID);
		expect(main?.degraded).toBe(true);
		expect(main?.reason).toBe("fallback_from:gpt_astra_implementer");
	});

	it("does not fall back when no session model selector exists", async () => {
		const seen: string[] = [];
		const engine = engineWith(store, artifactDir, chainRunner({ failCount: 99, seen }));
		const id = await engine.startWorkflow({ request: "no session model" });
		// No dynamic profile is registered: the three static candidates exhaust and the
		// last candidate's retryable error surfaces — no invented session-model route.
		await expect(engine.run(id, fakeSession())).rejects.toThrow(/transient provider failure/);
		expect(seen).toEqual(["grok-4.6", "gpt-6-astra", "deepseek-v4-flash"]);
		expect(engine.routingAudit.some(a => a.profileId === SESSION_FALLBACK_PROFILE_ID)).toBe(false);
	});
});
