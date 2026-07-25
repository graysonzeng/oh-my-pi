import { describe, expect, it } from "bun:test";
import { DEFAULT_MODEL_PROFILES } from "../../src/workflow/default-config";
import { WorkflowPolicyError } from "../../src/workflow/errors";
import { assertSupportedModelProfile, normalizeModelProfile } from "../../src/workflow/model-profile-registry";

describe("normalizeModelProfile", () => {
	it("accepts default profiles and defaults omitted runtime to embedded", () => {
		const profile = DEFAULT_MODEL_PROFILES.claude_planner;
		const normalized = normalizeModelProfile(profile);
		expect(normalized.id).toBe(profile.id);
		expect(normalized.runtime).toEqual({ kind: "embedded" });
		expect(() => assertSupportedModelProfile(profile)).not.toThrow();
	});

	it("keeps a codex cli executable and profile", () => {
		const profile = normalizeModelProfile({
			...DEFAULT_MODEL_PROFILES.grok_implementer,
			runtime: { kind: "codex_cli", executable: "codex", profile: "default" },
		});
		expect(profile.runtime).toEqual({
			kind: "codex_cli",
			executable: "codex",
			profile: "default",
		});
	});

	it("rejects a claude runtime carrying a codex profile", () => {
		expect(() =>
			normalizeModelProfile({
				...DEFAULT_MODEL_PROFILES.claude_planner,
				runtime: { kind: "claude_cli", profile: "cli" },
			}),
		).toThrow(WorkflowPolicyError);
	});

	it("rejects empty executable", () => {
		expect(() =>
			normalizeModelProfile({
				...DEFAULT_MODEL_PROFILES.claude_planner,
				runtime: { kind: "claude_cli", executable: "   " },
			}),
		).toThrow(WorkflowPolicyError);
	});
});
