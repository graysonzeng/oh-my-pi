import { describe, expect, it } from "bun:test";
import { DEFAULT_MODEL_PROFILES } from "../../src/workflow/default-config";
import { WorkflowPolicyError } from "../../src/workflow/errors";
import { assertSupportedModelProfile, normalizeModelProfile } from "../../src/workflow/model-profile-registry";

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
});
