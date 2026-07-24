import { describe, expect, it } from "bun:test";
import { DEFAULT_MODEL_PROFILES } from "../../src/workflow/default-config";
import { normalizeModelProfile } from "../../src/workflow/model-profile-registry";
import { WorkflowRuntimeDispatcher } from "../../src/workflow/runtime-dispatcher";
import { buildWorkflowConfigFromSessionSettings } from "../../src/workflow/session-config";
import type { ModelProfile, RuntimePort, WorkflowAgentRequest, WorkflowAgentResult } from "../../src/workflow/types";
import { fakeSession } from "./helpers";

function fakeRuntime(id: string): RuntimePort {
	return {
		buildRequest: r => r,
		run: async <TArtifact = unknown>(): Promise<WorkflowAgentResult<TArtifact>> => ({
			artifact: { id } as TArtifact,
			rawResultId: id,
			attemptId: "att",
		}),
	};
}

function baseRequest(profile: WorkflowAgentRequest["profile"]): WorkflowAgentRequest {
	return {
		workflowId: "wf",
		attemptId: "att",
		role: "planner",
		profile,
		assignment: "x",
		session: fakeSession(),
		outputSchema: { type: "object" },
	};
}

describe("WorkflowRuntimeDispatcher", () => {
	it.each([
		["embedded", "embedded-result"],
		["codex_cli", "codex-result"],
		["claude_cli", "claude-result"],
	] as const)("dispatches %s", async (kind, expected) => {
		const dispatcher = new WorkflowRuntimeDispatcher({
			embedded: fakeRuntime("embedded-result"),
			codexCli: fakeRuntime("codex-result"),
			claudeCli: fakeRuntime("claude-result"),
		});
		const profile = normalizeModelProfile({
			...DEFAULT_MODEL_PROFILES.claude_planner,
			modelPattern: "exact-model",
			runtime: { kind },
		});
		const result = await dispatcher.run(baseRequest(profile));
		expect(result.rawResultId).toBe(expected);
	});

	it("defaults omitted runtime to embedded", async () => {
		const dispatcher = new WorkflowRuntimeDispatcher({
			embedded: fakeRuntime("embedded-result"),
			codexCli: fakeRuntime("codex-result"),
			claudeCli: fakeRuntime("claude-result"),
		});
		const profile = { ...DEFAULT_MODEL_PROFILES.claude_planner };
		delete (profile as { runtime?: unknown }).runtime;
		const result = await dispatcher.run(baseRequest(profile));
		expect(result.rawResultId).toBe("embedded-result");
	});

	it("buildRequest delegates to the selected runtime", () => {
		const embedded: RuntimePort = {
			buildRequest: r => ({ ...r, attemptId: "embedded-built" }),
			run: async <TArtifact = unknown>(): Promise<WorkflowAgentResult<TArtifact>> => ({
				artifact: {} as TArtifact,
				rawResultId: "x",
				attemptId: "att",
			}),
		};
		const dispatcher = new WorkflowRuntimeDispatcher({
			embedded,
			codexCli: fakeRuntime("codex"),
			claudeCli: fakeRuntime("claude"),
		});
		const profile = normalizeModelProfile({
			...DEFAULT_MODEL_PROFILES.claude_planner,
			modelPattern: "exact-model",
			runtime: { kind: "embedded" },
		});
		expect(dispatcher.buildRequest(baseRequest(profile)).attemptId).toBe("embedded-built");
	});
});

describe("model profile runtime normalization", () => {
	it("defaults profiles without runtime to embedded", () => {
		const profile = normalizeModelProfile({ ...DEFAULT_MODEL_PROFILES.claude_planner, runtime: undefined });
		expect(profile.runtime).toEqual({ kind: "embedded" });
	});

	it("keeps a codex cli executable and profile", () => {
		const profile = normalizeModelProfile({
			...DEFAULT_MODEL_PROFILES.gpt_planner,
			runtime: { kind: "codex_cli", executable: "/opt/homebrew/bin/codex", profile: "cli" },
		});
		expect(profile.runtime).toEqual({
			kind: "codex_cli",
			executable: "/opt/homebrew/bin/codex",
			profile: "cli",
		});
	});

	it("rejects a claude runtime carrying a codex profile", () => {
		expect(() =>
			normalizeModelProfile({
				...DEFAULT_MODEL_PROFILES.claude_planner,
				runtime: { kind: "claude_cli", profile: "cli" },
			}),
		).toThrow(/profile.*codex_cli/i);
	});

	it("rejects empty executable", () => {
		expect(() =>
			normalizeModelProfile({
				...DEFAULT_MODEL_PROFILES.gpt_planner,
				runtime: { kind: "codex_cli", executable: "   " },
			}),
		).toThrow(/executable/i);
	});

	it("rejects unknown runtime kinds", () => {
		expect(() =>
			normalizeModelProfile({
				...DEFAULT_MODEL_PROFILES.claude_planner,
				runtime: { kind: "shell_cli" as "embedded" },
			}),
		).toThrow(/unsupported_runtime_kind|runtime/i);
	});

	it("preserves runtime through settings profile merge", () => {
		const config = buildWorkflowConfigFromSessionSettings(key => {
			if (key !== "workflow.profiles") return undefined;
			return {
				claude_planner: {
					...DEFAULT_MODEL_PROFILES.claude_planner,
					runtime: { kind: "claude_cli", executable: "claude" },
				},
			};
		});
		const planner = config.profiles.claude_planner as ModelProfile;
		expect(planner.runtime).toEqual({ kind: "claude_cli", executable: "claude" });
	});
});
