import { describe, expect, it } from "bun:test";
import { Effort } from "@oh-my-pi/pi-ai";
import { DEFAULT_MODEL_PROFILES } from "../../src/workflow/default-config";
import { WorkflowPolicyError } from "../../src/workflow/errors";
import {
	assertSupportedModelProfile,
	configuredIdentityForProfile,
	normalizeModelProfile,
} from "../../src/workflow/model-profile-registry";
import type { ModelProfile } from "../../src/workflow/types";

function strictProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
	return {
		...DEFAULT_MODEL_PROFILES.gpt_planner!,
		id: "strict_openai",
		vendor: "openai",
		modelPattern: "openai/gpt-5.6-sol",
		thinkingLevel: Effort.Medium,
		strictIdentity: true,
		...overrides,
	};
}

function expectPolicyError(run: () => unknown, reason: string, details: unknown): void {
	let thrown: unknown;
	try {
		run();
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(WorkflowPolicyError);
	const policyError = thrown as WorkflowPolicyError;
	expect(policyError.kind).toBe("policy_violation");
	expect(policyError.message).toBe(`Policy violation: ${reason}`);
	expect(policyError.details).toEqual(details);
}

describe("default reviewer effort", () => {
	it("keeps routine plan and code review profiles at medium", () => {
		expect(DEFAULT_MODEL_PROFILES.claude_plan_reviewer.thinkingLevel).toBe(Effort.Medium);
		expect(DEFAULT_MODEL_PROFILES.gpt_plan_reviewer.thinkingLevel).toBe(Effort.Medium);
		expect(DEFAULT_MODEL_PROFILES.claude_reviewer.thinkingLevel).toBe(Effort.Medium);
		expect(DEFAULT_MODEL_PROFILES.gpt_reviewer.thinkingLevel).toBe(Effort.Medium);
	});
});

describe("normalizeModelProfile", () => {
	it("accepts embedded multi-model profiles without runtime field", () => {
		const profile = DEFAULT_MODEL_PROFILES.claude_planner;
		expect(normalizeModelProfile(profile).id).toBe(profile.id);
		expect(() => assertSupportedModelProfile(profile)).not.toThrow();
	});

	it("rejects legacy profile.runtime (codex_cli / claude_cli / embedded)", () => {
		const legacy = {
			...DEFAULT_MODEL_PROFILES.claude_planner,
			runtime: { kind: "codex_cli", profile: "cli" },
		};
		expect(() => normalizeModelProfile(legacy as never)).toThrow(WorkflowPolicyError);
		try {
			normalizeModelProfile(legacy as never);
		} catch (err) {
			expect(err).toBeInstanceOf(WorkflowPolicyError);
			expect((err as WorkflowPolicyError).message).toContain("workflow_cli_runtime_removed");
		}
	});

	it("materializes a referenced shared optimization while preserving workflow-only policy", () => {
		const base = DEFAULT_MODEL_PROFILES.gpt_planner!;
		const normalized = normalizeModelProfile({
			...base,
			id: "referenced_gpt",
			optimizationProfileId: "gpt-5",
			promptStrategy: undefined,
			toolStrategy: undefined,
			contextStrategy: undefined,
		});

		expect(normalized.promptStrategy?.systemPromptTemplate).toBe("structured-gpt");
		expect(normalized.toolStrategy?.maxConcurrentTools).toBe(6);
		expect(normalized.contextStrategy?.targetUtilization).toBe(0.75);
		expect(normalized.roles).toEqual(["planner"]);
		expect(normalized.toolPolicyId).toBe("readonly-planning");
		expect(normalized.outputStrategy).toBe(base.outputStrategy);
	});

	it("rejects an unknown shared optimization reference", () => {
		const base = DEFAULT_MODEL_PROFILES.gpt_planner!;
		expect(() => normalizeModelProfile({ ...base, optimizationProfileId: "missing" })).toThrow(WorkflowPolicyError);
	});

	it("returns exact configured identity, concrete effort, and known lineage", () => {
		expect(configuredIdentityForProfile(strictProfile())).toEqual({
			profileId: "strict_openai",
			provider: "openai",
			model: "gpt-5.6-sol",
			checkpoint: null,
			provenance: "configured",
			modelPattern: "openai/gpt-5.6-sol",
			requestedEffort: Effort.Medium,
			modelFamily: "openai",
		});
	});

	it("rejects selector arrays, globs, and effort suffixes for strict identity", () => {
		const cases: Array<{ modelPattern: ModelProfile["modelPattern"]; details: unknown }> = [
			{
				modelPattern: ["openai/gpt-5.6-sol"],
				details: {
					profileId: "strict_openai",
					modelPattern: ["openai/gpt-5.6-sol"],
					hint: "Use one exact provider/model id without glob or effort suffix",
				},
			},
			{
				modelPattern: "openai/gpt-5.*",
				details: {
					profileId: "strict_openai",
					modelPattern: "openai/gpt-5.*",
					hint: "Use one exact provider/model id without glob or effort suffix",
				},
			},
			{
				modelPattern: "openai/gpt-5.6-sol:medium",
				details: {
					profileId: "strict_openai",
					modelPattern: "openai/gpt-5.6-sol:medium",
					hint: "Use one exact provider/model id without glob or effort suffix",
				},
			},
		];
		for (const testCase of cases) {
			expectPolicyError(
				() => configuredIdentityForProfile(strictProfile({ modelPattern: testCase.modelPattern })),
				"strict_model_profile_requires_exact_identity",
				testCase.details,
			);
		}
	});

	it("requires a separate concrete thinking effort", () => {
		expectPolicyError(
			() => configuredIdentityForProfile(strictProfile({ thinkingLevel: undefined })),
			"strict_model_profile_requires_exact_effort",
			{ profileId: "strict_openai", thinkingLevel: null },
		);
		expectPolicyError(
			() => configuredIdentityForProfile(strictProfile({ thinkingLevel: "auto" as ModelProfile["thinkingLevel"] })),
			"strict_model_profile_requires_exact_effort",
			{ profileId: "strict_openai", thinkingLevel: "auto" },
		);
	});

	it("rejects invalid and known-model-unsupported efforts with exact details", () => {
		expectPolicyError(
			() =>
				normalizeModelProfile(strictProfile({ thinkingLevel: "not-an-effort" as ModelProfile["thinkingLevel"] })),
			"invalid_model_profile_effort",
			{
				profileId: "strict_openai",
				effort: "not-an-effort",
				hint: "Workflow model profiles require one concrete supported effort",
			},
		);
		expectPolicyError(
			() => normalizeModelProfile(strictProfile({ thinkingLevel: "minimal" as ModelProfile["thinkingLevel"] })),
			"unsupported_model_profile_effort",
			{
				profileId: "strict_openai",
				modelPattern: "openai/gpt-5.6-sol",
				effort: "minimal",
				supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
			},
		);
	});

	it("uses exact provider effort facts before global same-id references", () => {
		const providerSpecific = strictProfile({
			vendor: "xai",
			modelPattern: "opencode-zen/grok-4.6",
			thinkingLevel: Effort.XHigh,
		});
		expect(normalizeModelProfile(providerSpecific).thinkingLevel).toBe(Effort.XHigh);

		expectPolicyError(
			() =>
				normalizeModelProfile(
					strictProfile({
						vendor: "anthropic",
						modelPattern: "openrouter/anthropic/claude-opus-4.6",
						thinkingLevel: "xhigh" as ModelProfile["thinkingLevel"],
					}),
				),
			"unsupported_model_profile_effort",
			{
				profileId: "strict_openai",
				modelPattern: "openrouter/anthropic/claude-opus-4.6",
				effort: "xhigh",
				supportedEfforts: ["low", "medium", "high", "max"],
			},
		);
	});

	it("canonicalizes effort abbreviations before persistence and runtime use", () => {
		const configured = configuredIdentityForProfile(
			strictProfile({ thinkingLevel: "med" as ModelProfile["thinkingLevel"] }),
		);
		const normalized = normalizeModelProfile(
			strictProfile({ thinkingLevel: "med" as ModelProfile["thinkingLevel"] }),
		);

		expect(configured.requestedEffort).toBe(Effort.Medium);
		expect(normalized.thinkingLevel).toBe(Effort.Medium);
	});

	it("keeps invalid effort rejection for non-strict legacy profiles", () => {
		expectPolicyError(
			() =>
				normalizeModelProfile(
					strictProfile({
						strictIdentity: false,
						thinkingLevel: "not-an-effort" as ModelProfile["thinkingLevel"],
					}),
				),
			"invalid_model_profile_effort",
			{
				profileId: "strict_openai",
				effort: "not-an-effort",
				hint: "Workflow model profiles require one concrete supported effort",
			},
		);
	});

	it("rejects unknown and conflicting model lineage", () => {
		expectPolicyError(
			() => configuredIdentityForProfile(strictProfile({ modelPattern: "openai/custom-model" })),
			"strict_model_profile_lineage_unknown",
			{ profileId: "strict_openai", modelPattern: "openai/custom-model" },
		);
		expectPolicyError(
			() => configuredIdentityForProfile(strictProfile({ vendor: "anthropic" })),
			"known_model_lineage_mismatch",
			{ profileId: "strict_openai", declaredVendor: "anthropic", derivedLineage: "openai" },
		);
	});
});
