import { afterEach, describe, expect, it, vi } from "bun:test";
import * as ai from "@oh-my-pi/pi-ai";
import { Effort, type Model, type Usage } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../../src/config/model-registry";
import {
	AVAILABILITY_PROBE_TIMEOUT_MS,
	availabilityProbePromptText,
	EmbeddedWorkflowAvailabilityPort,
	interpretProbeResult,
	parseResolvedModelIdentity,
} from "../../src/workflow/availability-adapter";
import {
	availabilityProbeDedupeKey,
	buildAvailabilityCandidates,
	modelRolesForCurrentStep,
	reachableModelRoles,
} from "../../src/workflow/availability-candidates";
import {
	classifyScopeStatus,
	DEFAULT_AVAILABILITY_OVERALL_TIMEOUT_MS,
	DEFAULT_AVAILABILITY_PER_TARGET_TIMEOUT_MS,
	isDiagnosticAvailabilityTimeout,
	runAvailabilityPreflight,
} from "../../src/workflow/availability-preflight";
import { DEFAULT_MODEL_PROFILES } from "../../src/workflow/default-config";
import { WorkflowCancelledError } from "../../src/workflow/errors";
import { ModelRouter } from "../../src/workflow/model-router";
import type {
	AvailabilityProbeStatus,
	ModelProfile,
	WorkflowAvailabilityPort,
	WorkflowAvailabilityProbeRequest,
	WorkflowAvailabilityProbeResult,
} from "../../src/workflow/types";
import { fakeSession } from "./helpers";

function profile(partial: Partial<ModelProfile> & Pick<ModelProfile, "id" | "roles" | "modelPattern">): ModelProfile {
	return {
		vendor: "test",
		promptTemplate: "planner",
		promptVersion: "1.0",
		toolPolicyId: "readonly",
		maxRequests: 1,
		maxRuntimeMs: 1000,
		retryPolicy: { maxAttempts: 1, retryableErrorKinds: [], fallbackProfileIds: [] },
		contextPolicy: {
			includePlan: true,
			includeReviewFindings: true,
			includeVerification: true,
			includeFullTranscript: false,
			maxArtifactBytes: 1000,
		},
		...partial,
	};
}

const probeUsage: Usage = {
	input: 7,
	output: 2,
	cacheRead: 1,
	cacheWrite: 0,
	totalTokens: 10,
	cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 },
};

describe("WorkflowAvailabilityPort contract", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("uses the dedicated session probe", async () => {
		let sessionCalls = 0;
		const port = new EmbeddedWorkflowAvailabilityPort(async (_request, signal) => {
			sessionCalls += 1;
			expect(signal.aborted).toBe(false);
			return {
				status: "available",
				actualProvider: "live-provider",
				actualModel: "live-model",
				latencyMs: 3,
				usage: probeUsage,
				reportedCostUsd: 0.031,
			};
		});
		const session = { ...fakeSession(), modelRegistry: {} as ModelRegistry };
		const result = await port.probe({
			profile: profile({ id: "live", roles: ["planner"], modelPattern: "gateway/live-model" }),
			role: "planner",
			session,
			timeoutMs: 100,
		});

		expect(result.status).toBe("available");
		expect(sessionCalls).toBe(1);
	});

	it("fails closed on an explicit short timeout", async () => {
		const pending = Promise.withResolvers<WorkflowAvailabilityProbeResult>();
		const port = new EmbeddedWorkflowAvailabilityPort((_request, signal) => {
			signal.addEventListener("abort", () => pending.reject(signal.reason), { once: true });
			return pending.promise;
		});
		const result = await port.probe({
			profile: profile({ id: "slow", roles: ["planner"], modelPattern: "gateway/slow" }),
			role: "planner",
			session: fakeSession(),
			timeoutMs: 5,
		});

		expect(result.status).toBe("unavailable");
		expect(result.errorKind).toBe("timeout");
	});

	it("fails closed when the session model registry is missing", async () => {
		const result = await new EmbeddedWorkflowAvailabilityPort().probe({
			profile: profile({ id: "missing-registry", roles: ["planner"], modelPattern: "gateway/live-model" }),
			role: "planner",
			session: fakeSession(),
			timeoutMs: 100,
		});

		expect(result.status).toBe("unavailable");
		expect(result.errorKind).toBe("configuration");
		expect(result.errorSummary).toMatch(/model registry/i);
	});

	it("classifies model-not-found errors containing timeout as configuration and blocks the required scope", async () => {
		const model = {
			provider: "provider",
			id: "timeout-profile",
			api: "openai-responses",
			name: "Timeout Profile",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		} as Model;
		const registry = {
			getAvailable: () => [model],
			getApiKey: async () => "test-key",
			resolver: () => "test-key",
		} as unknown as ModelRegistry;
		const targetProfile = profile({
			id: "timeout-word-error",
			roles: ["planner"],
			modelPattern: "provider/timeout-profile",
		});
		const session = fakeSession({ modelRegistry: registry });
		vi.spyOn(ai, "completeSimple").mockRejectedValue(new Error("model not found: provider timeout profile"));
		const port = new EmbeddedWorkflowAvailabilityPort();
		const direct = await port.probe({
			profile: targetProfile,
			role: "planner",
			session,
			timeoutMs: 100,
		});

		expect(direct.status).toBe("unavailable");
		expect(direct.errorKind).toBe("configuration");
		expect(direct.errorSummary).toBe("model not found: provider timeout profile");

		const report = await runAvailabilityPreflight({
			port,
			router: new ModelRouter([targetProfile]),
			workflowId: "wf-timeout-word-configuration",
			operation: "resume",
			status: "planning",
			singleStep: true,
			session,
		});
		expect(report.status).toBe("blocked");
		expect(report.blockedRoles).toEqual(["planner"]);
		expect(report.profiles[0]?.errorKind).toBe("configuration");
	});

	it("sends a direct probe with session transport context and reports response metadata", async () => {
		const model = {
			provider: "gateway",
			id: "gpt-5.6-sol",
			api: "openai-responses",
			name: "Live Model",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		} as Model;
		const fetchOverride = vi.fn<typeof fetch>();
		const resolver = vi.fn(() => "test-key");
		const registry = {
			getAvailable: () => [model],
			getApiKey: async () => "test-key",
			resolver,
		} as unknown as ModelRegistry;
		const complete = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: model.api,
			provider: "gateway",
			model: "actual-live-model",
			usage: probeUsage,
			stopReason: "stop",
			timestamp: Date.now(),
		} as never);
		const result = await new EmbeddedWorkflowAvailabilityPort().probe({
			profile: profile({
				id: "direct",
				roles: ["planner"],
				modelPattern: ["gateway/gpt-5.6-sol", "gateway/fallback"],
			}),
			role: "planner",
			session: fakeSession({
				cwd: "/repo",
				fetch: fetchOverride,
				modelRegistry: registry,
				getSessionId: () => "session-1",
				getServiceTierByFamily: () => ({ openai: "priority" }),
			}),
			timeoutMs: 100,
		});

		expect(result).toMatchObject({
			status: "available",
			actualProvider: "gateway",
			actualModel: "actual-live-model",
			usage: probeUsage,
			reportedCostUsd: 0.031,
		});
		expect(resolver).toHaveBeenCalledWith(model, "session-1");
		const context = complete.mock.calls[0]?.[1];
		const options = complete.mock.calls[0]?.[2];
		expect(context?.systemPrompt).toEqual([availabilityProbePromptText()]);
		expect(context?.messages[0]?.content).toBe(availabilityProbePromptText());
		expect(options).toMatchObject({
			maxTokens: 16,
			disableReasoning: true,
			fetch: fetchOverride,
			cwd: "/repo",
			serviceTier: "priority",
		});
	});

	it("disables reasoning even when strict identity validation is enabled", async () => {
		const model = {
			provider: "gateway",
			id: "gpt-5.6-sol",
			api: "openai-responses",
			name: "Strict Live Model",
			baseUrl: "https://example.invalid",
			reasoning: true,
			thinking: { mode: "effort", efforts: [Effort.High] },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		} as unknown as Model;
		const registry = {
			getAvailable: () => [model],
			getApiKey: async () => "test-key",
			resolver: () => "test-key",
		} as unknown as ModelRegistry;
		const complete = vi.spyOn(ai, "completeSimple").mockImplementation(async (calledModel, _context, options) => {
			await options?.onResponse?.(
				{
					status: 200,
					headers: {
						"x-provider-model": "gateway/gpt-5.6-sol",
						"x-omp-resolved-provider": "gateway",
						"x-omp-model-checkpoint": "gateway-checkpoint",
					},
				},
				calledModel,
			);
			return {
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				api: calledModel.api,
				provider: calledModel.provider,
				model: calledModel.id,
				usage: probeUsage,
				stopReason: "stop",
				timestamp: Date.now(),
			} as never;
		});

		const result = await new EmbeddedWorkflowAvailabilityPort().probe({
			profile: profile({
				id: "strict-direct",
				vendor: "openai",
				roles: ["planner"],
				modelPattern: "gateway/gpt-5.6-sol",
				thinkingLevel: Effort.High,
				strictIdentity: true,
			}),
			role: "planner",
			session: fakeSession({ modelRegistry: registry }),
			timeoutMs: 100,
		});

		expect(result.status).toBe("available");
		const options = complete.mock.calls[0]?.[2];
		expect(options).toMatchObject({ maxTokens: 16, disableReasoning: true });
		expect(options?.reasoning).toBeUndefined();
	});

	it("returns available / unavailable / indeterminate as specified by the probe port", async () => {
		const profiles = [
			profile({ id: "ok", roles: ["planner"], modelPattern: "m-ok" }),
			profile({ id: "bad", roles: ["planner"], modelPattern: "m-bad" }),
			profile({ id: "maybe", roles: ["planner"], modelPattern: "m-maybe" }),
		];
		const router = new ModelRouter(profiles);
		const port: WorkflowAvailabilityPort = {
			async probe(req) {
				const model = Array.isArray(req.profile.modelPattern)
					? req.profile.modelPattern[0]
					: req.profile.modelPattern;
				if (model === "m-ok") {
					return {
						status: "available",
						actualProvider: "prov",
						actualModel: "real-ok",
						latencyMs: 12,
					};
				}
				if (model === "m-bad") {
					return {
						status: "unavailable",
						latencyMs: 5,
						errorKind: "authentication",
						errorSummary: "no credentials",
					};
				}
				return {
					status: "indeterminate",
					latencyMs: 8,
					errorKind: "missing_identity",
					errorSummary: "no identity",
				};
			},
		};

		const report = await runAvailabilityPreflight({
			port,
			router,
			workflowId: "wf-1",
			operation: "start",
			status: "created",
			singleStep: false,
			session: fakeSession(),
			// only planner required for a tighter assertion — use planning single step
		});

		// Full start from created includes multiple roles; filter planner rows.
		const planner = report.profiles.filter(p => p.role === "planner");
		const statuses = planner.map(p => p.status).sort() as AvailabilityProbeStatus[];
		expect(statuses).toEqual((["available", "indeterminate", "unavailable"] as AvailabilityProbeStatus[]).sort());
		const ok = planner.find(p => p.profileId === "ok");
		expect(ok?.actualProvider).toBe("prov");
		expect(ok?.actualModel).toBe("real-ok");
		expect(ok?.latencyMs).toBe(12);
		const bad = planner.find(p => p.profileId === "bad");
		expect(bad?.errorKind).toBe("authentication");
		expect(bad?.actualProvider).toBeUndefined();
	});

	it("dedupes identical runtime/model/auth-scope to one physical probe and expands per profile", async () => {
		const sharedModel = "shared-model-x";
		const profiles = [
			profile({ id: "p1", roles: ["planner"], modelPattern: sharedModel, vendor: "a" }),
			profile({ id: "p2", roles: ["planner"], modelPattern: sharedModel, vendor: "b" }),
		];
		const router = new ModelRouter(profiles);
		let physicalProbes = 0;
		const port: WorkflowAvailabilityPort = {
			async probe() {
				physicalProbes += 1;
				return {
					status: "available",
					actualProvider: "live-prov",
					actualModel: "live-model",
					latencyMs: 42,
					usage: probeUsage,
					reportedCostUsd: 0.031,
				};
			},
		};

		const report = await runAvailabilityPreflight({
			port,
			router,
			workflowId: "wf-dedupe",
			operation: "start",
			status: "planning",
			singleStep: true,
			session: fakeSession(),
		});

		expect(physicalProbes).toBe(1);
		expect(report.profiles).toHaveLength(2);
		expect(report.profiles.map(p => p.profileId).sort()).toEqual(["p1", "p2"]);
		expect(report.profiles.every(p => p.status === "available")).toBe(true);
		expect(report.profiles.every(p => p.actualModel === "live-model")).toBe(true);
		const sources = report.profiles.map(p => p.source);
		expect(sources.filter(s => s === "live")).toHaveLength(1);
		expect(sources.filter(s => s === "shared_live")).toHaveLength(1);
		expect(report.profiles.every(row => row.usageKind === "diagnostic")).toBe(true);
		expect(report.profiles.every(row => row.usage?.totalTokens === 10)).toBe(true);
		expect(report.profiles.every(row => row.reportedCostUsd === 0.031)).toBe(true);
		// Aggregate bills the physical probe once, not once per shared profile row.
		expect(report.usageKind).toBe("diagnostic");
		expect(report.usage?.totalTokens).toBe(10);
		expect(report.reportedCostUsd).toBe(0.031);
		// Same dedupe key for both profiles
		expect(availabilityProbeDedupeKey(profiles[0]!)).toBe(availabilityProbeDedupeKey(profiles[1]!));
	});

	it("marks success without response identity as indeterminate (never fills vendor/modelPattern)", () => {
		const latencyMs = 17;
		const result = interpretProbeResult(
			{
				result: {
					id: "raw",
					// no resolvedModel
				},
			},
			latencyMs,
		);
		expect(result.status).toBe("indeterminate");
		expect(result.actualProvider).toBeUndefined();
		expect(result.actualModel).toBeUndefined();
		expect(result.latencyMs).toBe(17);
		expect(result.errorKind).toBe("missing_identity");

		// Port path via preflight: available without identity must not appear as available with vendor.
		const fakeAvailableMissingIdentity: WorkflowAvailabilityProbeResult = {
			status: "indeterminate",
			latencyMs: 3,
			errorKind: "missing_identity",
		};
		// Simulate misbehaving port returning available without identity — report still must not invent vendor.
		const badPort: WorkflowAvailabilityPort = {
			async probe(_req: WorkflowAvailabilityProbeRequest) {
				return {
					status: "available",
					// deliberately omit actualProvider/actualModel
					latencyMs: 3,
				};
			},
		};
		void fakeAvailableMissingIdentity;
		const router = new ModelRouter([
			profile({ id: "vfill", roles: ["planner"], modelPattern: "cfg-model", vendor: "should-not-appear" }),
		]);
		return runAvailabilityPreflight({
			port: badPort,
			router,
			workflowId: "wf-id",
			operation: "start",
			status: "planning",
			singleStep: true,
			session: fakeSession(),
		}).then(report => {
			const row = report.profiles[0]!;
			// Port said available without identity — expansion coerces to indeterminate, never invents vendor.
			expect(row.status).toBe("indeterminate");
			expect(row.actualProvider).toBeUndefined();
			expect(row.actualModel).toBeUndefined();
			expect(row.actualProvider).not.toBe("should-not-appear");
			expect(row.actualModel).not.toBe("cfg-model");
		});
	});

	it("static probe prompt is free of user/repo/transcript placeholders", () => {
		const text = availabilityProbePromptText();
		expect(text.length).toBeGreaterThan(10);
		expect(text).toMatch(/ok/i);
		// No Handlebars runtime-injection placeholders for user content
		expect(text).not.toMatch(/\{\{\s*request\s*\}\}/i);
		expect(text).not.toMatch(/\{\{\s*repo\s*\}\}/i);
		expect(text).not.toMatch(/\{\{\s*transcript\s*\}\}/i);
		expect(text).not.toMatch(/\{\{\s*constraints\s*\}\}/i);
		expect(text).not.toMatch(/\{\{\s*user\s*\}\}/i);
	});

	it("parseResolvedModelIdentity only accepts provider/model form", () => {
		expect(parseResolvedModelIdentity("xai/grok-4.6")).toEqual({ provider: "xai", model: "grok-4.6" });
		expect(parseResolvedModelIdentity("xai/grok-4.6:high")).toEqual({ provider: "xai", model: "grok-4.6" });
		expect(parseResolvedModelIdentity(undefined)).toBeUndefined();
		expect(parseResolvedModelIdentity("no-slash")).toBeUndefined();
		expect(parseResolvedModelIdentity("/onlymodel")).toBeUndefined();
	});

	it("propagates embedded response usage/cost and leaves absent metadata unknown", () => {
		const observed = interpretProbeResult(
			{ result: { id: "usage", resolvedModel: "provider/model", usage: probeUsage } },
			9,
		);
		expect(observed.usage).toEqual(probeUsage);
		expect(observed.reportedCostUsd).toBe(0.031);

		const unknown = interpretProbeResult({ result: { id: "unknown", resolvedModel: "provider/model" } }, 9);
		expect(unknown.usage).toBeUndefined();
		expect(unknown.reportedCostUsd).toBeUndefined();
	});

	it("uses the specified production timeout defaults", () => {
		expect(AVAILABILITY_PROBE_TIMEOUT_MS).toBe(30_000);
		expect(DEFAULT_AVAILABILITY_PER_TARGET_TIMEOUT_MS).toBe(30_000);
		expect(DEFAULT_AVAILABILITY_PER_TARGET_TIMEOUT_MS).toBe(AVAILABILITY_PROBE_TIMEOUT_MS);
		expect(DEFAULT_AVAILABILITY_OVERALL_TIMEOUT_MS).toBe(60_000);
	});

	it("marks a non-cooperative target unavailable on its per-target timeout", async () => {
		const never = Promise.withResolvers<WorkflowAvailabilityProbeResult>();
		const report = await runAvailabilityPreflight({
			port: { probe: () => never.promise },
			router: new ModelRouter([profile({ id: "slow", roles: ["planner"], modelPattern: "slow" })]),
			workflowId: "wf-target-timeout",
			operation: "resume",
			status: "planning",
			singleStep: true,
			session: fakeSession(),
			perTargetTimeoutMs: 5,
			overallTimeoutMs: 100,
		});

		expect(report.status).toBe("degraded");
		expect(report.blockedRoles ?? []).toEqual([]);
		expect(report.profiles[0]?.status).toBe("unavailable");
		expect(report.profiles[0]?.errorKind).toBe("timeout");
		expect(report.profiles[0]?.errorSummary).toMatch(/target timeout/i);
		expect(report.reportedCostUsd).toBeNull();
	});

	it("overall timeout settles running and queued targets and degrades for conditional failure", async () => {
		const never = Promise.withResolvers<WorkflowAvailabilityProbeResult>();
		const report = await runAvailabilityPreflight({
			port: {
				probe(req) {
					if (req.role === "code_reviewer") {
						return Promise.resolve({
							status: "available",
							actualProvider: "provider",
							actualModel: "reviewer",
							latencyMs: 1,
						});
					}
					return never.promise;
				},
			},
			router: new ModelRouter([
				profile({ id: "reviewer", roles: ["code_reviewer"], modelPattern: "reviewer" }),
				profile({ id: "repair", roles: ["repair"], modelPattern: "repair" }),
			]),
			workflowId: "wf-overall-timeout",
			operation: "resume",
			status: "code_review",
			singleStep: false,
			session: fakeSession(),
			perTargetTimeoutMs: 100,
			overallTimeoutMs: 5,
		});

		expect(report.status).toBe("degraded");
		expect(report.profiles.find(row => row.role === "code_reviewer")?.status).toBe("available");
		const repair = report.profiles.find(row => row.role === "repair");
		expect(repair?.requirement).toBe("conditional");
		expect(repair?.status).toBe("unavailable");
		expect(repair?.errorKind).toBe("timeout");
		expect(repair?.errorSummary).toMatch(/overall timeout/i);
	});

	it("caller abort cancels all probes without becoming a timeout result", async () => {
		const controller = new AbortController();
		const observedSignals: AbortSignal[] = [];
		const never = Promise.withResolvers<WorkflowAvailabilityProbeResult>();
		const running = runAvailabilityPreflight({
			port: {
				probe(req) {
					if (req.signal) observedSignals.push(req.signal);
					return never.promise;
				},
			},
			router: new ModelRouter([
				profile({ id: "p1", roles: ["planner"], modelPattern: "m1" }),
				profile({ id: "p2", roles: ["planner"], modelPattern: "m2" }),
			]),
			workflowId: "wf-caller-abort",
			operation: "resume",
			status: "planning",
			singleStep: true,
			session: fakeSession(),
			signal: controller.signal,
			maxConcurrency: 2,
			perTargetTimeoutMs: 100,
			overallTimeoutMs: 200,
		});
		await Bun.sleep(1);
		controller.abort(new Error("caller stopped"));

		await expect(running).rejects.toBeInstanceOf(WorkflowCancelledError);
		expect(observedSignals).toHaveLength(2);
		expect(observedSignals.every(signal => signal.aborted)).toBe(true);
	});

	it("redacts provider secrets while retaining numeric diagnostic usage", async () => {
		const report = await runAvailabilityPreflight({
			port: {
				async probe() {
					return {
						status: "unavailable",
						latencyMs: 2,
						usage: probeUsage,
						reportedCostUsd: 0.031,
						errorKind: "authentication",
						errorSummary: "token: super-secret-token",
					};
				},
			},
			router: new ModelRouter([profile({ id: "secret", roles: ["planner"], modelPattern: "secret" })]),
			workflowId: "wf-secret-redaction",
			operation: "resume",
			status: "planning",
			singleStep: true,
			session: fakeSession(),
		});

		const row = report.profiles[0]!;
		expect(row.errorSummary).not.toContain("super-secret-token");
		expect(row.usage).toEqual(probeUsage);
		expect(row.reportedCostUsd).toBe(0.031);
	});
});

describe("availability candidate set", () => {
	it("singleStep only includes current-step model role", () => {
		expect(modelRolesForCurrentStep("planning")).toEqual([{ role: "planner", requirement: "required" }]);
		expect(modelRolesForCurrentStep("created")).toEqual([]);
		expect(modelRolesForCurrentStep("implementation_verify")).toEqual([]);
		expect(modelRolesForCurrentStep("code_review")).toEqual([{ role: "code_reviewer", requirement: "required" }]);
	});

	it("full reachable marks repair as conditional from planning", () => {
		const roles = reachableModelRoles("planning");
		expect(roles.find(r => r.role === "planner")?.requirement).toBe("required");
		expect(roles.find(r => r.role === "repair")?.requirement).toBe("conditional");
	});

	it("builds candidates from ModelRouter registry only", () => {
		const router = new ModelRouter([DEFAULT_MODEL_PROFILES.claude_planner, DEFAULT_MODEL_PROFILES.grok_implementer]);
		const candidates = buildAvailabilityCandidates({
			router,
			status: "created",
			singleStep: false,
		});
		// planner profiles from registry + implementer when roles match
		expect(candidates.some(c => c.role === "planner" && c.profile.id === "claude_planner")).toBe(true);
		expect(candidates.some(c => c.role === "implementer" && c.profile.id === "grok_implementer")).toBe(true);
		// no invented profiles
		expect(candidates.every(c => router.list().some(p => p.id === c.profile.id))).toBe(true);
	});

	it("classifyScopeStatus blocks required role with zero available", () => {
		const { status, blockedRoles } = classifyScopeStatus([
			{
				profileId: "a",
				role: "planner",
				requirement: "required",
				status: "unavailable",
				runtime: "embedded",
				usageKind: "diagnostic",
			},
		]);
		expect(status).toBe("blocked");
		expect(blockedRoles).toContain("planner");
	});

	it("classifies a required role with only diagnostic timeouts as degraded", () => {
		const timeoutRow = {
			profileId: "timeout",
			role: "planner" as const,
			requirement: "required" as const,
			status: "unavailable" as const,
			runtime: "embedded" as const,
			usageKind: "diagnostic" as const,
			errorKind: "timeout" as const,
		};
		expect(isDiagnosticAvailabilityTimeout(timeoutRow)).toBe(true);
		expect(classifyScopeStatus([timeoutRow])).toEqual({ status: "degraded", blockedRoles: [] });
	});

	it("keeps required roles blocked for identity and ordinary unavailability", () => {
		for (const errorKind of ["missing_identity", "authentication", undefined] as const) {
			const row = {
				profileId: `unavailable-${errorKind ?? "plain"}`,
				role: "planner" as const,
				requirement: "required" as const,
				status: "unavailable" as const,
				runtime: "embedded" as const,
				usageKind: "diagnostic" as const,
				errorKind,
			};
			const result = classifyScopeStatus([row]);
			expect(result.status).toBe("blocked");
			expect(result.blockedRoles).toEqual(["planner"]);
		}
	});

	it("required role with zero registry profiles is blocked (not not_required)", async () => {
		// Only implementer registered; planning singleStep requires planner.
		const router = new ModelRouter([profile({ id: "impl_only", roles: ["implementer"], modelPattern: "m-impl" })]);
		const port: WorkflowAvailabilityPort = {
			async probe() {
				return {
					status: "available",
					actualProvider: "mock",
					actualModel: "ok",
					latencyMs: 1,
				};
			},
		};
		const report = await runAvailabilityPreflight({
			port,
			router,
			workflowId: "wf-missing-role",
			operation: "resume",
			status: "planning",
			singleStep: true,
			session: fakeSession(),
		});
		expect(report.status).toBe("blocked");
		expect(report.blockedRoles).toContain("planner");
		expect(report.profiles.some(p => p.role === "planner" && p.status === "unavailable")).toBe(true);
		expect(report.profiles.find(p => p.role === "planner")?.errorKind).toBe("configuration");
	});
});
