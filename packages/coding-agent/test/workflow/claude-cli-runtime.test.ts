import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildClaudeCliCommand, ClaudeCliRuntimeAdapter } from "../../src/workflow/claude-cli-runtime";
import type { CliProcessRequest } from "../../src/workflow/cli-process";
import { DEFAULT_MODEL_PROFILES } from "../../src/workflow/default-config";
import type { WorkflowAgentRequest } from "../../src/workflow/types";
import { fakeSession, planArtifact } from "./helpers";

function plannerRequest(overrides: Partial<WorkflowAgentRequest> = {}): WorkflowAgentRequest {
	return {
		workflowId: "wf_claude",
		attemptId: "att_claude",
		role: "planner",
		profile: {
			...DEFAULT_MODEL_PROFILES.claude_planner,
			modelPattern: "claude-sonnet-4-6",
			runtime: { kind: "claude_cli", executable: "claude" },
		},
		assignment: "plan the change",
		context: "req",
		outputSchema: { type: "object", required: ["kind", "summary"] },
		session: fakeSession(),
		...overrides,
	};
}

describe("buildClaudeCliCommand", () => {
	it("builds argv with plan mode and no dangerous flags", () => {
		const command = buildClaudeCliCommand({
			executable: "claude",
			schemaJson: JSON.stringify({ type: "object" }),
			model: "claude-sonnet-4-6",
			readonly: true,
			tools: ["read", "grep"],
		});
		expect(command).toEqual(
			expect.arrayContaining([
				"--print",
				"--output-format",
				"json",
				"--json-schema",
				JSON.stringify({ type: "object" }),
				"--model",
				"claude-sonnet-4-6",
				"--permission-mode",
				"plan",
				"--no-session-persistence",
				"--disable-slash-commands",
				"--setting-sources",
				"user",
			]),
		);
		expect(command).not.toContain("--dangerously-skip-permissions");
		expect(command).not.toContain("--allow-dangerously-skip-permissions");
	});
});

describe("ClaudeCliRuntimeAdapter", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		await Promise.all(tempDirs.splice(0).map(d => fs.rm(d, { recursive: true, force: true })));
	});

	it("parses JSON envelope and structured_output", async () => {
		const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "claude-cli-"));
		tempDirs.push(artifactRoot);
		const calls: CliProcessRequest[] = [];
		const plan = planArtifact({ summary: "from-claude" });
		const adapter = new ClaudeCliRuntimeAdapter({
			artifactRoot,
			resolveExecutable: async () => "/usr/bin/claude",
			processRunner: async req => {
				calls.push(req);
				return {
					exitCode: 0,
					stdout: JSON.stringify({
						session_id: "sess-1",
						model: "claude-sonnet-4-6",
						usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 2 },
						structured_output: plan,
					}),
					stderr: "",
					durationMs: 8,
				};
			},
		});

		const result = await adapter.run(plannerRequest());
		expect(calls).toHaveLength(1);
		const call = calls[0]!;
		expect(call.command).toEqual(
			expect.arrayContaining([
				"--print",
				"--output-format",
				"json",
				"--model",
				"claude-sonnet-4-6",
				"--permission-mode",
				"plan",
				"--no-session-persistence",
				"--disable-slash-commands",
				"--setting-sources",
				"user",
			]),
		);
		expect(call.command).not.toContain("--dangerously-skip-permissions");
		expect(call.stdin).toContain("plan the change");
		expect(result.rawResultId).toBe("sess-1");
		expect(result.resolvedModel).toBe("claude-sonnet-4-6");
		expect(result.resolvedProvider).toBe("claude-cli");
		expect(result.artifact).toMatchObject({ summary: "from-claude" });
		expect(result.usage).toMatchObject({ input: 11, output: 7, cacheRead: 2 });
	});

	it("maps auth failures", async () => {
		const adapter = new ClaudeCliRuntimeAdapter({
			resolveExecutable: async () => "claude",
			processRunner: async () => ({
				exitCode: 1,
				stdout: JSON.stringify({ is_error: true, error: "unauthorized", status: 401 }),
				stderr: "login required",
				durationMs: 2,
			}),
		});
		await expect(adapter.run(plannerRequest())).rejects.toMatchObject({ kind: "authentication" });
	});

	it("fails when structured_output is missing", async () => {
		const adapter = new ClaudeCliRuntimeAdapter({
			resolveExecutable: async () => "claude",
			processRunner: async () => ({
				exitCode: 0,
				stdout: JSON.stringify({ session_id: "x", model: "claude-sonnet-4-6" }),
				stderr: "",
				durationMs: 1,
			}),
		});
		await expect(adapter.run(plannerRequest())).rejects.toMatchObject({ kind: "schema_violation" });
	});

	it("does not write shared settings paths", async () => {
		const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "claude-cli-"));
		tempDirs.push(artifactRoot);
		const adapter = new ClaudeCliRuntimeAdapter({
			artifactRoot,
			resolveExecutable: async () => "claude",
			processRunner: async req => {
				// Ensure no argv targets settings files
				expect(req.command.join(" ")).not.toMatch(/settings\.json/);
				return {
					exitCode: 0,
					stdout: JSON.stringify({
						session_id: "s",
						model: "claude-sonnet-4-6",
						structured_output: planArtifact(),
					}),
					stderr: "",
					durationMs: 1,
				};
			},
		});
		await adapter.run(plannerRequest());
	});
});
