import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactStore } from "../../src/workflow/artifact-store";
import { DEFAULT_MODEL_PROFILES } from "../../src/workflow/default-config";
import { WorkflowEngine } from "../../src/workflow/engine";
import { WorkflowError, WorkflowTimeoutError } from "../../src/workflow/errors";
import { ModelRouter } from "../../src/workflow/model-router";
import { RuntimeAdapter, type StructuredRunnerRequest } from "../../src/workflow/runtime-adapter";
import { WorkflowStore } from "../../src/workflow/sqlite-store";
import {
	fakeSession,
	implArtifact,
	materializeSamplePatch,
	passVerifier,
	planArtifact,
	reviewArtifact,
} from "./helpers";

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

		const session = fakeSession({ cwd: artifactDir });
		const engine = new WorkflowEngine({
			store,
			router,
			session,
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
					const resolvedModel = attestRuntimeIdentity(request);
					return {
						result: {
							id: "raw-plan",
							structuredOutput: { status: "valid", data: planArtifact() },
							resolvedModel,
						},
					};
				}
				// other roles succeed
				if (String(request.assignment).includes("Review the plan")) {
					const resolvedModel = attestRuntimeIdentity(request);
					return {
						result: {
							id: "raw-pr",
							structuredOutput: { status: "valid", data: reviewArtifact("approved", "plan") },
							resolvedModel,
						},
					};
				}
				if (String(request.assignment).includes("Implement")) {
					const patchPath = await materializeSamplePatch(artifactDir);
					return {
						result: {
							id: "raw-impl",
							structuredOutput: { status: "valid", data: implArtifact({ patchPath }) },
							patchPath,
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

	it("persists the timed-out planner execution when fallback later completes", async () => {
		const profiles = Object.values(DEFAULT_MODEL_PROFILES);
		const router = new ModelRouter(profiles);
		let planCalls = 0;
		const session = fakeSession({ cwd: artifactDir });
		const engine = new WorkflowEngine({
			store,
			router,
			session,
			verifier: passVerifier(),
			artifactStore: new ArtifactStore(artifactDir),
			adapter: new RuntimeAdapter(async request => {
				if (request.agent === "designer" || request.agent === "planner") {
					planCalls += 1;
					if (planCalls === 1) {
						throw new WorkflowTimeoutError("planner timed out");
					}
					const resolvedModel = attestRuntimeIdentity(request);
					return {
						result: {
							id: "raw-plan",
							structuredOutput: { status: "valid", data: planArtifact() },
							resolvedModel,
							completionKind: "completed",
						},
					};
				}
				if (String(request.assignment).includes("Review the plan")) {
					const resolvedModel = attestRuntimeIdentity(request);
					return {
						result: {
							id: "raw-pr",
							structuredOutput: { status: "valid", data: reviewArtifact("approved", "plan") },
							resolvedModel,
							completionKind: "completed",
						},
					};
				}
				if (String(request.assignment).includes("Implement")) {
					const patchPath = await materializeSamplePatch(artifactDir);
					return {
						result: {
							id: "raw-impl",
							structuredOutput: { status: "valid", data: implArtifact({ patchPath }) },
							patchPath,
							branchName: "wf/impl",
							completionKind: "completed",
						},
					};
				}
				return {
					result: {
						id: "raw-cr",
						structuredOutput: { status: "valid", data: reviewArtifact("approved", "implementation") },
						completionKind: "completed",
					},
				};
			}),
		});

		const id = await engine.startWorkflow({ request: "fallback timeout evidence" });
		const result = await engine.run(id);
		expect(result.state.status).toBe("completed");
		expect(planCalls).toBe(2);
		const report = await engine.getStatusReport(id);
		const kinds = report?.modelAttempts.flatMap(attempt =>
			attempt.executions.map(execution => execution.completionKind),
		);
		expect(kinds).toContain("timeout");
		expect(kinds).toContain("completed");
	});

	it("retries planning with fallback profile after authentication errors", async () => {
		const profiles = Object.values(DEFAULT_MODEL_PROFILES);
		const router = new ModelRouter(profiles);
		let planCalls = 0;
		const session = fakeSession({ cwd: artifactDir });
		const engine = new WorkflowEngine({
			store,
			router,
			session,
			verifier: passVerifier(),
			artifactStore: new ArtifactStore(artifactDir),
			adapter: new RuntimeAdapter(async request => {
				if (request.agent === "designer" || request.agent === "planner") {
					planCalls += 1;
					if (planCalls === 1) {
						throw new WorkflowError("401 unauthorized api key", "authentication");
					}
					const resolvedModel = attestRuntimeIdentity(request);
					return {
						result: {
							id: "raw-plan",
							structuredOutput: { status: "valid", data: planArtifact() },
							resolvedModel,
						},
					};
				}
				if (String(request.assignment).includes("Review the plan")) {
					const resolvedModel = attestRuntimeIdentity(request);
					return {
						result: {
							id: "raw-pr",
							structuredOutput: { status: "valid", data: reviewArtifact("approved", "plan") },
							resolvedModel,
						},
					};
				}
				if (String(request.assignment).includes("Implement")) {
					const patchPath = await materializeSamplePatch(artifactDir);
					return {
						result: {
							id: "raw-impl",
							structuredOutput: { status: "valid", data: implArtifact({ patchPath }) },
							patchPath,
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

		const id = await engine.startWorkflow({ request: "auth fallback" });
		const result = await engine.run(id);
		expect(result.state.status).toBe("completed");
		expect(planCalls).toBe(2);
		expect(result.routingAudit.some(a => String(a.reason).includes("fallback"))).toBe(true);
	});
});
