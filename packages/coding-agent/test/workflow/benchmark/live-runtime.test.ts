import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-catalog";
import {
	aggregateLiveCompletionKind,
	applyKnownGoodBenchmarkSolution,
	buildDefaultBenchmarkSuite,
	buildLiveBenchmarkExperimentConfig,
	buildLiveBenchmarkProfileOverrides,
	buildLiveBenchmarkQualityRoutes,
	buildLiveBenchmarkRoleIdentityMap,
	buildLiveWorkflowStartInput,
	createLiveWorkflowBenchmarkRuntime,
	runBenchmarkSuite,
	verifyLiveWorkflowProvenance,
} from "../../../src/workflow/benchmark";
import type { BenchmarkRuntimeProvenance } from "../../../src/workflow/benchmark/types";
import { getDefaultConfig } from "../../../src/workflow/default-config";
import { compileQualityRouteSnapshot } from "../../../src/workflow/quality-route-snapshot";
import {
	buildWorkflowConfigFromSessionSettings,
	resolveWorkflowProfilesFromSettings,
} from "../../../src/workflow/session-config";
import type {
	WorkflowModelBackedStage,
	WorkflowQualityRoutes,
	WorkflowRole,
	WorkflowStatusReportV1,
} from "../../../src/workflow/types";

const FIXTURE_PROVENANCE: BenchmarkRuntimeProvenance = {
	source: "runtime_observed",
	provider: "fixture-provider",
	model: "fixture-model",
	checkpoint: null,
	api: "openai-completions",
	adapter: "coding-agent:createAgentSession",
	parser: "pi-ai:openai-completions",
};

interface FixtureChildIdentity {
	provider: string;
	model: string;
	checkpoint: string;
	modelFamily: string;
}

const FIXTURE_PRIMARY_CHILD_IDENTITY: FixtureChildIdentity = {
	provider: "fixture-provider",
	model: "fixture-model",
	checkpoint: "checkpoint-1",
	modelFamily: "fixture",
};
const FIXTURE_REVIEWER_CHILD_IDENTITY: FixtureChildIdentity = {
	provider: "fixture-reviewer-provider",
	model: "fixture-reviewer-model",
	checkpoint: "reviewer-checkpoint-1",
	modelFamily: "fixture-reviewer",
};

function fixtureIdentityForStage(
	stage: WorkflowModelBackedStage,
	reviewer: FixtureChildIdentity,
): FixtureChildIdentity {
	return stage === "plan_review" || stage === "code_review" ? reviewer : FIXTURE_PRIMARY_CHILD_IDENTITY;
}

const FIXTURE_ROLE_IDENTITIES = buildLiveBenchmarkRoleIdentityMap(
	"fixture-provider",
	"fixture-model",
	"fixture-reviewer-provider",
	"fixture-reviewer-model",
);

function exactChildReport(reviewer = FIXTURE_REVIEWER_CHILD_IDENTITY): WorkflowStatusReportV1 {
	const stages: WorkflowModelBackedStage[] = ["planning", "plan_review", "implementing", "code_review"];
	const roles: Record<WorkflowModelBackedStage, WorkflowRole> = {
		planning: "planner",
		plan_review: "plan_reviewer",
		implementing: "implementer",
		code_review: "code_reviewer",
		repairing: "repair",
	};
	return {
		schemaVersion: 1,
		workflowId: "wf-live",
		status: "completed",
		currentStage: "completed",
		version: 9,
		attemptCount: stages.length,
		artifactCount: stages.length * 2,
		transitionCount: stages.length + 1,
		budgetTotals: null,
		qualityRoute: {
			status: "verified",
			qualityTier: "balanced",
			snapshotFingerprint: "route-fingerprint",
			configuredStages: ([...stages, "repairing"] as WorkflowModelBackedStage[]).map(stage => ({
				stage,
				role: roles[stage],
				orderedProfileIds: [`profile-${stage}`],
			})),
		},
		modelAttempts: stages.map((stage, index) => {
			const identity = fixtureIdentityForStage(stage, reviewer);
			return {
				attemptId: `attempt-${stage}`,
				stage,
				role: roles[stage],
				ordinal: index + 1,
				status: "completed",
				configuredProfileId: `profile-${stage}`,
				evidenceStatus: "verified",
				routing: [
					{
						selectedProfileId: `profile-${stage}`,
						configuredProfileIds: [`profile-${stage}`],
						reason: "primary",
						fallbackFrom: null,
						skipped: [],
					},
				],
				executions: [
					{
						profileId: `profile-${stage}`,
						configuredIdentity: {
							profileId: `profile-${stage}`,
							provider: identity.provider,
							model: identity.model,
							checkpoint: null,
							provenance: "configured",
							modelPattern: `${identity.provider}/${identity.model}`,
							requestedEffort: "high",
							modelFamily: identity.modelFamily,
						},
						localResolution: {
							provider: identity.provider,
							model: identity.model,
							checkpoint: null,
							provenance: "local_resolution",
						},
						attestedIdentity: {
							provider: identity.provider,
							model: identity.model,
							checkpoint: identity.checkpoint,
							provenance: "provider_echo",
						},
						exactIdentityMatch: true,
						effortSupported: true,
						modelFamily: identity.modelFamily,
						completionKind: "completed",
					},
				],
			};
		}),
	};
}

describe("live workflow benchmark runtime", () => {
	it("carries authoritative allowed and forbidden paths into the workflow start constraints", () => {
		const suite = buildDefaultBenchmarkSuite();
		const benchmarkCase = suite.cases.find(item => item.id === "bugfix-null-deref");
		expect(benchmarkCase).toBeDefined();
		const input = buildLiveWorkflowStartInput(benchmarkCase!);
		expect(input.op).toBe("start");
		expect(input.request).toBe(benchmarkCase!.request);
		expect(input.constraints).toContain(`Allowed paths: ${benchmarkCase!.allowedPaths.join(", ")}.`);
		expect(input.constraints).toContain("Forbidden paths:");
		expect(input.constraints).toContain(".benchmark/");
		expect(input.degradedMode).toBe(false);
	});

	it("uses the agent seam, verifies the fixture, and reports provider facts without synthetic quality", async () => {
		const suite = buildDefaultBenchmarkSuite();
		const benchmarkCase = suite.cases.find(item => item.id === "bugfix-null-deref");
		expect(benchmarkCase).toBeDefined();
		const selectedSuite = { ...suite, cases: [benchmarkCase!] };
		let calls = 0;
		const runtime = createLiveWorkflowBenchmarkRuntime({
			provider: "fixture-provider",
			model: "fixture-model",
			reviewerProvider: "fixture-reviewer-provider",
			reviewerModel: "fixture-reviewer-model",
			agentRunner: async (request, cwd) => {
				calls += 1;
				await applyKnownGoodBenchmarkSolution(cwd, request.case);
				return {
					terminalStatus: "completed",
					inputTokens: 11,
					outputTokens: 7,
					cacheReadTokens: 3,
					cacheWriteTokens: 0,
					cacheObservable: true,
					costUsd: 0.02,
					toolCalls: 2,
					usageObservable: true,
					runtimeProvenance: FIXTURE_PROVENANCE,
					fallbackCount: 0,
					completionKind: "completed",
				};
			},
		});

		const results = await runBenchmarkSuite({
			suite: selectedSuite,
			runtime,
			variants: ["baseline"],
			minRepetitions: 1,
			liveQualityUnknown: false,
			provider: "fixture-provider",
			model: "fixture-model",
		});

		expect(calls).toBe(5);
		expect(results.map(result => result.error)).toEqual([undefined, undefined, undefined, undefined, undefined]);
		expect(results.every(result => result.passed)).toBe(true);
		expect(results.every(result => result.scopeStatus === "adhered")).toBe(true);
		expect(results.every(result => result.runtimeProvenance?.provider === "fixture-provider")).toBe(true);
		expect(results[0]?.tokens.inputTokens).toEqual({ value: 11, provenance: "provider_fact" });
		expect(results[0]?.stage.toolCalls).toEqual({ value: 2, provenance: "exact" });
		expect(results[0]?.stage.schemaRetries).toEqual({ value: null, provenance: "unknown" });
		expect(results[0]?.stage.duplicateReadCount).toEqual({ value: null, provenance: "unknown" });
		expect(results[0]?.tokens.costUsd).toEqual({ value: 0.02, provenance: "provider_fact" });
	}, 20_000);

	it("materializes and verifies every fixed live-suite fixture", async () => {
		const suite = buildDefaultBenchmarkSuite();
		const runtime = createLiveWorkflowBenchmarkRuntime({
			provider: "fixture-provider",
			model: "fixture-model",
			reviewerProvider: "fixture-reviewer-provider",
			reviewerModel: "fixture-reviewer-model",
			agentRunner: async (request, cwd) => {
				await applyKnownGoodBenchmarkSolution(cwd, request.case);
				return {
					terminalStatus: "completed",
					inputTokens: 1,
					outputTokens: 1,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					cacheObservable: false,
					usageObservable: false,
					costUsd: 0,
					toolCalls: 1,
					runtimeProvenance: FIXTURE_PROVENANCE,
					fallbackCount: 0,
					completionKind: "completed",
				};
			},
		});

		for (const benchmarkCase of suite.cases) {
			const [result] = await runBenchmarkSuite({
				suite: { ...suite, cases: [{ ...benchmarkCase, repetitions: 1 }] },
				runtime,
				variants: ["baseline"],
			});
			expect(result?.error).toBeUndefined();
			expect(result?.passed).toBe(true);
			expect(result?.scopeStatus).toBe("adhered");
		}
	}, 60_000);

	it("keeps outer-session zero usage unknown when workflow child usage is not observable", async () => {
		const suite = buildDefaultBenchmarkSuite();
		const benchmarkCase = { ...suite.cases[0]!, repetitions: 1 };
		const runtime = createLiveWorkflowBenchmarkRuntime({
			provider: "fixture-provider",
			model: "fixture-model",
			reviewerProvider: "fixture-reviewer-provider",
			reviewerModel: "fixture-reviewer-model",
			agentRunner: async (request, cwd) => {
				await applyKnownGoodBenchmarkSolution(cwd, request.case);
				return {
					terminalStatus: "completed",
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					cacheObservable: false,
					usageObservable: false,
					costUsd: 0,
					toolCalls: 0,
					completionKind: "completed",
				};
			},
		});
		const [result] = await runBenchmarkSuite({
			suite: { ...suite, cases: [benchmarkCase] },
			runtime,
			variants: ["baseline"],
			minRepetitions: 1,
		});
		expect(result?.tokens.inputTokens).toEqual({ value: null, provenance: "unknown" });
		expect(result?.tokens.outputTokens).toEqual({ value: null, provenance: "unknown" });
		expect(result?.tokens.costUsd).toEqual({ value: null, provenance: "unknown" });
	});

	it("fails closed when provider, model, or reviewer identity is omitted or not independent", () => {
		expect(() =>
			createLiveWorkflowBenchmarkRuntime({
				provider: "",
				model: "model",
				reviewerModel: "reviewer-model",
			}),
		).toThrow("explicit provider and model");
		expect(() =>
			createLiveWorkflowBenchmarkRuntime({
				provider: "provider",
				model: "",
				reviewerModel: "reviewer-model",
			}),
		).toThrow("explicit provider and model");
		expect(() =>
			createLiveWorkflowBenchmarkRuntime({
				provider: "gateway",
				model: "gpt-5.6-luna",
				reviewerModel: "",
			}),
		).toThrow("explicit reviewer model");
		expect(() =>
			createLiveWorkflowBenchmarkRuntime({
				provider: "gateway",
				model: "gpt-5.6-luna",
				reviewerModel: "gpt-5.6-sol",
			}),
		).toThrow(/reviewer model family must differ/);
	});

	it("builds a real baseline without optimization strategies and preserves them for optimized", () => {
		const baseline = buildLiveBenchmarkProfileOverrides(
			"provider",
			"model",
			"baseline",
			"profile-strategy",
			"reviewer-provider",
			"reviewer-model",
		);
		const optimized = buildLiveBenchmarkProfileOverrides(
			"provider",
			"model",
			"optimized",
			"profile-strategy",
			"reviewer-provider",
			"reviewer-model",
		);
		const profileId = Object.keys(baseline)[0]!;
		expect(baseline[profileId]?.modelPattern).toBe("provider/model");
		expect(optimized[profileId]?.modelPattern).toBe("provider/model");
		expect(baseline[profileId]?.toolStrategy).toBeUndefined();
		expect(baseline[profileId]?.promptStrategy).toBeUndefined();
		expect(baseline[profileId]?.presentationPolicy).toEqual({ enabled: false, mode: "direct" });
		expect(Object.hasOwn(optimized[profileId] ?? {}, "toolStrategy")).toBe(false);
		for (const overrides of [baseline, optimized]) {
			for (const profile of Object.values(overrides)) {
				expect(profile.maxRuntimeMs).toBe(600_000);
				expect(profile.strictIdentity).toBe(true);
				expect(profile.retryPolicy).toEqual({
					maxAttempts: 1,
					retryableErrorKinds: [],
					fallbackProfileIds: [],
				});
			}
		}
	});

	it("keeps presentation control and treatment profile overrides byte-equivalent", () => {
		const control = buildLiveBenchmarkProfileOverrides(
			"provider",
			"model",
			"baseline",
			"presentation",
			"reviewer-provider",
			"reviewer-model",
		);
		const treatment = buildLiveBenchmarkProfileOverrides(
			"provider",
			"model",
			"optimized",
			"presentation",
			"reviewer-provider",
			"reviewer-model",
		);
		expect(JSON.stringify(control)).toBe(JSON.stringify(treatment));
		const profileId = Object.keys(control)[0]!;
		expect(control[profileId]).toMatchObject({
			modelPattern: "provider/model",
			strictIdentity: true,
			maxRuntimeMs: 600_000,
			retryPolicy: { maxAttempts: 1, retryableErrorKinds: [], fallbackProfileIds: [] },
		});
	});

	it("compiles isolated presentation and profile-strategy setting inputs", () => {
		const presentationControl = buildLiveBenchmarkExperimentConfig(
			"provider",
			"model",
			"baseline",
			"presentation",
			"reviewer-provider",
			"reviewer-model",
		);
		const presentationTreatment = buildLiveBenchmarkExperimentConfig(
			"provider",
			"model",
			"optimized",
			"presentation",
			"reviewer-provider",
			"reviewer-model",
		);
		expect(presentationControl.profileOverrides).toEqual(presentationTreatment.profileOverrides);
		expect(JSON.stringify(presentationControl.profileOverrides)).toBe(
			JSON.stringify(presentationTreatment.profileOverrides),
		);
		expect(presentationControl.roleIdentityMap).toEqual(presentationTreatment.roleIdentityMap);
		expect(presentationControl.presentationOptimizationEnabled).toBe(false);
		expect(presentationTreatment.presentationOptimizationEnabled).toBe(true);

		const profileStrategyControl = buildLiveBenchmarkExperimentConfig(
			"provider",
			"model",
			"baseline",
			"profile-strategy",
			"reviewer-provider",
			"reviewer-model",
		);
		const profileStrategyTreatment = buildLiveBenchmarkExperimentConfig(
			"provider",
			"model",
			"optimized",
			"profile-strategy",
			"reviewer-provider",
			"reviewer-model",
		);
		expect(profileStrategyControl.presentationOptimizationEnabled).toBe(false);
		expect(profileStrategyTreatment.presentationOptimizationEnabled).toBe(false);
		expect(profileStrategyControl.profileOverrides).not.toEqual(profileStrategyTreatment.profileOverrides);
		expect(profileStrategyControl.roleIdentityMap).toEqual(profileStrategyTreatment.roleIdentityMap);
	});

	it("builds strict role-specific profiles with distinct model-family identity", () => {
		const overrides = buildLiveBenchmarkProfileOverrides(
			"gateway",
			"gpt-5.6-luna",
			"optimized",
			"profile-strategy",
			"gateway",
			"claude-fable-5",
		);
		const profiles = resolveWorkflowProfilesFromSettings(overrides, getDefaultConfig().profiles);
		for (const [id, profile] of Object.entries(profiles)) {
			const isReviewer = getDefaultConfig().profiles[id]?.roles.some(
				role => role === "plan_reviewer" || role === "plan_arbitrator" || role === "code_reviewer",
			);
			expect(profile.strictIdentity).toBe(true);
			expect(profile.vendor).toBe(isReviewer ? "anthropic" : "openai");
			expect(profile.modelPattern).toBe(isReviewer ? "gateway/claude-fable-5" : "gateway/gpt-5.6-luna");
		}
	});

	it("compiles a verified live quality-route snapshot for fixed-model profiles", () => {
		const experimentConfig = buildLiveBenchmarkExperimentConfig(
			"gateway",
			"gpt-5.6-luna",
			"optimized",
			"profile-strategy",
			"gateway",
			"claude-fable-5",
		);
		const profiles = resolveWorkflowProfilesFromSettings(
			experimentConfig.profileOverrides,
			getDefaultConfig().profiles,
		);
		const routes = buildLiveBenchmarkQualityRoutes(experimentConfig.roleIdentityMap);
		expect(routes.balanced).toEqual({
			planner: ["gpt_planner"],
			plan_reviewer: ["claude_plan_reviewer"],
			plan_arbitrator: ["grok_plan_arbitrator"],
			implementer: ["gpt_astra_implementer"],
			code_reviewer: ["claude_reviewer"],
			repair: ["gpt_repair"],
		});
		const snapshot = compileQualityRouteSnapshot(
			{ profiles, qualityRoutes: routes as WorkflowQualityRoutes },
			"balanced",
		);
		expect(snapshot.qualityTier).toBe("balanced");
		expect(snapshot.routes.planner.length).toBeGreaterThan(0);
		expect(snapshot.routes.plan_reviewer.length).toBeGreaterThan(0);
		expect(snapshot.routes.implementer.length).toBeGreaterThan(0);
		expect(snapshot.routes.plan_arbitrator.length).toBeGreaterThan(0);
		expect(snapshot.routes.code_reviewer.length).toBeGreaterThan(0);
		const settings = {
			"workflow.profiles": experimentConfig.profileOverrides,
			"workflow.qualityRoutes": routes,
			"workflow.defaultQualityTier": "balanced",
			"workflow.degradedMode": false,
		} as Record<string, unknown>;
		const config = buildWorkflowConfigFromSessionSettings(key => settings[key]);
		expect(config.qualityRoutes).toBeDefined();
		expect(Object.keys(config.qualityRoutes ?? {})).toContain("balanced");
		expect(config.degradedMode).toBe(false);
	});

	it("clamps live fixed-model efforts to deepseek-v4-flash max default", () => {
		const baseline = buildLiveBenchmarkProfileOverrides(
			"gateway",
			"deepseek-v4-flash",
			"baseline",
			"profile-strategy",
			"gateway",
			"claude-fable-5",
		);
		// Primary profiles use deepseek defaults; reviewer profiles remain on Claude's supported effort dial.
		expect(baseline.claude_planner?.thinkingLevel).toBe(Effort.Max);
		expect(baseline.deepseek_implementer?.thinkingLevel).toBe(Effort.Max);
		expect(baseline.gpt_planner?.thinkingLevel).toBe(Effort.Max);
		expect(baseline.grok_implementer?.thinkingLevel).toBe(Effort.Max);
		expect(baseline.claude_plan_reviewer?.thinkingLevel).toBe(Effort.Medium);
		expect(baseline.claude_reviewer?.thinkingLevel).toBe(Effort.Medium);

		const merged = resolveWorkflowProfilesFromSettings(baseline, getDefaultConfig().profiles);
		expect(merged.claude_planner?.modelPattern).toBe("gateway/deepseek-v4-flash");
		expect(merged.deepseek_implementer?.modelPattern).toBe("gateway/deepseek-v4-flash");
		expect(merged.claude_plan_reviewer?.modelPattern).toBe("gateway/claude-fable-5");
		expect(merged.claude_reviewer?.modelPattern).toBe("gateway/claude-fable-5");
		expect(merged.claude_planner?.thinkingLevel).toBe(Effort.Max);
		expect(merged.claude_plan_reviewer?.thinkingLevel).toBe(Effort.Medium);
		expect(merged.grok_implementer?.thinkingLevel).toBe(Effort.Max);
	});

	it("includes untracked files in the live scope verdict", async () => {
		const suite = buildDefaultBenchmarkSuite();
		const benchmarkCase = suite.cases.find(item => item.id === "bugfix-null-deref")!;
		const runtime = createLiveWorkflowBenchmarkRuntime({
			provider: "fixture-provider",
			model: "fixture-model",
			reviewerProvider: "fixture-reviewer-provider",
			reviewerModel: "fixture-reviewer-model",
			agentRunner: async (_request, cwd) => {
				await Bun.write(path.join(cwd, "untracked.txt"), "out of scope\n");
				return {
					terminalStatus: "completed",
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					cacheObservable: false,
					usageObservable: false,
					costUsd: 0,
					toolCalls: 0,
					completionKind: "completed",
				};
			},
		});
		const [result] = await runBenchmarkSuite({
			suite: { ...suite, cases: [{ ...benchmarkCase, repetitions: 1, verificationCommands: [] }] },
			runtime,
			variants: ["baseline"],
		});
		expect(result?.passed).toBe(false);
		expect(result?.scopeStatus).toBe("violation");
		expect(result?.error).toContain("untracked.txt");
	}, 10_000);

	it("accepts one exact child identity across every required stage with known zero fallback", () => {
		const verified = verifyLiveWorkflowProvenance(exactChildReport(), FIXTURE_ROLE_IDENTITIES);
		expect(verified.errors).toEqual([]);
		expect(verified.fallbackCount).toBe(0);
		expect(verified.runtimeProvenance).toMatchObject({
			provider: "fixture-provider",
			model: "fixture-model",
			checkpoint: "checkpoint-1",
		});
	});

	it("accepts exact same-model evidence from an intentional legacy route", () => {
		const report = exactChildReport(FIXTURE_PRIMARY_CHILD_IDENTITY);
		report.qualityRoute = {
			status: "legacy",
			qualityTier: null,
			snapshotFingerprint: null,
			configuredStages: [],
		};
		const verified = verifyLiveWorkflowProvenance(report, "fixture-provider", "fixture-model");
		expect(verified.errors).toEqual([]);
		expect(verified.fallbackCount).toBe(0);
		expect(verified.runtimeProvenance).toMatchObject({
			provider: "fixture-provider",
			model: "fixture-model",
			checkpoint: "checkpoint-1",
		});
	});

	it("fails closed when a required child stage lacks runtime evidence", () => {
		const report = exactChildReport();
		report.modelAttempts.find(attempt => attempt.stage === "code_review")!.executions = [];
		const verified = verifyLiveWorkflowProvenance(report, FIXTURE_ROLE_IDENTITIES);
		expect(verified.runtimeProvenance).toBeUndefined();
		expect(verified.errors).toContain("child runtime evidence missing: code_review");
	});

	it("fails closed when a reviewer stage attests the primary identity", () => {
		const report = exactChildReport();
		const execution = report.modelAttempts.find(attempt => attempt.stage === "plan_review")!.executions[0]!;
		execution.configuredIdentity!.provider = "fixture-provider";
		execution.configuredIdentity!.model = "fixture-model";
		execution.attestedIdentity!.provider = "fixture-provider";
		execution.attestedIdentity!.model = "fixture-model";
		const verified = verifyLiveWorkflowProvenance(report, FIXTURE_ROLE_IDENTITIES);
		expect(verified.runtimeProvenance).toBeUndefined();
		expect(verified.errors).toContain("child exact identity not verified: plan_review");
	});

	it("accepts plan arbitration as an exact reviewer identity", () => {
		const report = exactChildReport();
		report.qualityRoute.configuredStages.find(stage => stage.stage === "plan_review")!.role = "plan_arbitrator";
		report.modelAttempts.find(attempt => attempt.stage === "plan_review")!.role = "plan_arbitrator";
		const verified = verifyLiveWorkflowProvenance(report, FIXTURE_ROLE_IDENTITIES);
		expect(verified.errors).toEqual([]);
		expect(verified.fallbackCount).toBe(0);
		expect(verified.runtimeProvenance).toMatchObject({
			provider: "fixture-provider",
			model: "fixture-model",
		});
	});

	it("fails closed when child checkpoints are mixed", () => {
		const report = exactChildReport();
		report.modelAttempts[0]!.executions[0]!.attestedIdentity!.checkpoint = "checkpoint-2";
		const verified = verifyLiveWorkflowProvenance(report, FIXTURE_ROLE_IDENTITIES);
		expect(verified.runtimeProvenance).toBeUndefined();
		expect(verified.errors).toContain("child runtime identity mixed or missing: 2");
	});

	it("fails closed on child fallback or skipped routing evidence", () => {
		const report = exactChildReport();
		const routing = report.modelAttempts[0]!.routing;
		routing.push({
			selectedProfileId: "profile-planning",
			configuredProfileIds: ["profile-planning"],
			reason: "fallback_from:unavailable-planner",
			fallbackFrom: "unavailable-planner",
			skipped: [{ profileId: "unavailable-planner", reason: "unavailable" }],
		});
		const verified = verifyLiveWorkflowProvenance(report, FIXTURE_ROLE_IDENTITIES);
		expect(verified.runtimeProvenance).toBeUndefined();
		expect(verified.fallbackCount).toBeGreaterThan(0);
		expect(verified.errors).toContain("child fallback or routing ambiguity: planning");
	});

	it("still reports scope evidence when the agent seam throws before completion", async () => {
		const suite = buildDefaultBenchmarkSuite();
		const benchmarkCase = { ...suite.cases[0]!, repetitions: 1, verificationCommands: [] };
		const runtime = createLiveWorkflowBenchmarkRuntime({
			provider: "fixture-provider",
			model: "fixture-model",
			reviewerProvider: "fixture-reviewer-provider",
			reviewerModel: "fixture-reviewer-model",
			agentRunner: async () => {
				throw new Error("Policy violation: required_role_unavailable: planner");
			},
		});
		const [result] = await runBenchmarkSuite({
			suite: { ...suite, cases: [benchmarkCase] },
			runtime,
			variants: ["baseline"],
			minRepetitions: 1,
		});
		expect(result?.passed).toBe(false);
		expect(result?.scopeStatus).toBe("adhered");
		expect(result?.error).toContain("required_role_unavailable");
		expect(result?.runtimeProvenance).toBeNull();
	}, 10_000);

	it("fails a live case when completionKind is missing even if workflow completed", async () => {
		const suite = buildDefaultBenchmarkSuite();
		const benchmarkCase = { ...suite.cases[0]!, repetitions: 1 };
		const runtime = createLiveWorkflowBenchmarkRuntime({
			provider: "fixture-provider",
			model: "fixture-model",
			reviewerProvider: "fixture-reviewer-provider",
			reviewerModel: "fixture-reviewer-model",
			agentRunner: async (request, cwd) => {
				await applyKnownGoodBenchmarkSolution(cwd, request.case);
				return {
					terminalStatus: "completed",
					inputTokens: 1,
					outputTokens: 1,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					cacheObservable: false,
					usageObservable: true,
					costUsd: 0,
					toolCalls: 1,
					runtimeProvenance: FIXTURE_PROVENANCE,
					fallbackCount: 0,
				};
			},
		});
		const [result] = await runBenchmarkSuite({
			suite: { ...suite, cases: [benchmarkCase] },
			runtime,
			variants: ["baseline"],
			liveQualityUnknown: false,
			provider: "fixture-provider",
			model: "fixture-model",
		});
		expect(result?.passed).toBe(false);
		expect(result?.error).toContain("completionKind=missing");
	});

	it("aggregates the worst live completionKind and fail-closes on a missing execution", () => {
		const report = exactChildReport();
		expect(aggregateLiveCompletionKind(report)).toBe("completed");
		report.modelAttempts[0]!.executions[0]!.completionKind = "budget_stop";
		expect(aggregateLiveCompletionKind(report)).toBe("budget_stop");
		report.modelAttempts[1]!.executions[0]!.completionKind = "timeout";
		expect(aggregateLiveCompletionKind(report)).toBe("timeout");
		delete report.modelAttempts[2]!.executions[0]!.completionKind;
		expect(aggregateLiveCompletionKind(report)).toBeUndefined();
	});
});
