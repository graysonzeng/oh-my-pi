import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { CliProcessRequest, CliProcessResult } from "../../src/workflow/cli-process";
import { buildCodexCliCommand, CodexCliRuntimeAdapter } from "../../src/workflow/codex-cli-runtime";
import { DEFAULT_MODEL_PROFILES } from "../../src/workflow/default-config";
import type { WorkflowAgentRequest } from "../../src/workflow/types";
import { fakeSession, planArtifact } from "./helpers";

function plannerRequest(overrides: Partial<WorkflowAgentRequest> = {}): WorkflowAgentRequest {
	return {
		workflowId: "wf_codex",
		attemptId: "att_codex",
		role: "plan_reviewer",
		profile: {
			...DEFAULT_MODEL_PROFILES.gpt_plan_reviewer,
			modelPattern: "gpt-5.6-sol",
			runtime: { kind: "codex_cli", profile: "cli", executable: "codex" },
		},
		assignment: "review the plan",
		context: "plan body",
		outputSchema: { type: "object", required: ["kind", "decision"] },
		session: fakeSession(),
		...overrides,
	};
}

describe("buildCodexCliCommand", () => {
	it("builds argv without shell or dangerous flags", () => {
		const command = buildCodexCliCommand({
			executable: "codex",
			schemaPath: "/tmp/schema.json",
			resultPath: "/tmp/result.json",
			model: "gpt-5.6-sol",
			readonly: true,
			cwd: "/repo",
			profile: "cli",
		});
		expect(command).toContain("exec");
		expect(command).toContain("--ephemeral");
		expect(command).toContain("--json");
		expect(command).toContain("--sandbox");
		expect(command).toContain("read-only");
		expect(command).toContain("--profile");
		expect(command).toContain("cli");
		expect(command.at(-1)).toBe("-");
		expect(command).not.toContain("--dangerously-bypass-approvals-and-sandbox");
	});
});

describe("CodexCliRuntimeAdapter", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		await Promise.all(tempDirs.splice(0).map(d => fs.rm(d, { recursive: true, force: true })));
	});

	it("runs read-only review with fake process runner", async () => {
		const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-cli-"));
		tempDirs.push(artifactRoot);
		const calls: CliProcessRequest[] = [];
		const artifact = planArtifact({ kind: "plan" as const });
		// plan reviewer needs review artifact — use review shape
		const review = {
			schemaVersion: 1,
			workflowId: "wf",
			attemptId: "att",
			stage: "plan_review",
			createdAt: new Date().toISOString(),
			kind: "review",
			subject: "plan",
			decision: "approved",
			findings: [],
			explanation: "ok",
			confidence: 0.9,
		};

		const adapter = new CodexCliRuntimeAdapter({
			artifactRoot,
			resolveExecutable: async () => "/usr/bin/codex",
			processRunner: async req => {
				calls.push(req);
				const resultIdx = req.command.indexOf("--output-last-message");
				const resultPath = req.command[resultIdx + 1]!;
				await Bun.write(resultPath, JSON.stringify(review));
				const result: CliProcessResult = {
					exitCode: 0,
					stdout: `${JSON.stringify({ type: "response", response: { model: "gpt-5.6-sol", usage: { input_tokens: 5, output_tokens: 2 } } })}\n`,
					stderr: "",
					durationMs: 12,
				};
				return result;
			},
		});

		const result = await adapter.run(plannerRequest());
		expect(calls).toHaveLength(1);
		const call = calls[0]!;
		expect(call.command).toContain("exec");
		expect(call.command).toContain("--ephemeral");
		expect(call.command).toContain("--json");
		expect(call.command).toContain("--sandbox");
		expect(call.command).toContain("read-only");
		expect(call.command).not.toContain("--dangerously-bypass-approvals-and-sandbox");
		expect(call.stdin).toContain("review the plan");
		expect(result.artifact).toMatchObject({ decision: "approved" });
		expect(result.resolvedModel).toBe("gpt-5.6-sol");
		expect(result.usage?.input).toBe(5);
		void artifact;
	});

	it("fails closed without outputSchema", async () => {
		const adapter = new CodexCliRuntimeAdapter({
			processRunner: async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 }),
			resolveExecutable: async () => "codex",
		});
		await expect(adapter.run(plannerRequest({ outputSchema: undefined }))).rejects.toMatchObject({
			kind: "schema_violation",
		});
	});

	it("maps non-zero exit with 429 status to rate_limit", async () => {
		const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-cli-"));
		tempDirs.push(artifactRoot);
		const adapter = new CodexCliRuntimeAdapter({
			artifactRoot,
			resolveExecutable: async () => "codex",
			processRunner: async () => ({
				exitCode: 1,
				stdout: `${JSON.stringify({ type: "error", error: { message: "slow down", status: 429 } })}\n`,
				stderr: "request failed",
				durationMs: 3,
			}),
		});
		await expect(adapter.run(plannerRequest())).rejects.toMatchObject({ kind: "rate_limit" });
	});

	it("rejects write roles without isolation", async () => {
		const adapter = new CodexCliRuntimeAdapter({
			processRunner: async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 }),
			resolveExecutable: async () => "codex",
		});
		await expect(
			adapter.run(
				plannerRequest({
					role: "implementer",
					profile: {
						...DEFAULT_MODEL_PROFILES.grok_implementer,
						modelPattern: "grok-4.5",
						runtime: { kind: "codex_cli" },
					},
					isolation: undefined,
					outputSchema: { type: "object", required: ["kind"] },
				}),
			),
		).rejects.toMatchObject({ kind: "policy_violation" });
	});

	it("runs isolated write via injectable isolation deps", async () => {
		const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-cli-write-"));
		tempDirs.push(artifactRoot);
		const parentRepo = "/parent/repo";
		const worktree = "/isolated/worktree";
		const calls: CliProcessRequest[] = [];
		const impl = {
			schemaVersion: 1,
			workflowId: "wf",
			attemptId: "att",
			stage: "implementing",
			createdAt: new Date().toISOString(),
			kind: "implementation",
			summary: "done",
			changedFiles: ["implemented.txt"],
			addressedStepIds: ["s1"],
			commandsRun: [],
			unresolved: [],
		};

		const adapter = new CodexCliRuntimeAdapter({
			artifactRoot,
			resolveExecutable: async () => "codex",
			processRunner: async req => {
				calls.push(req);
				const resultIdx = req.command.indexOf("--output-last-message");
				await Bun.write(req.command[resultIdx + 1]!, JSON.stringify(impl));
				return { exitCode: 0, stdout: "", stderr: "", durationMs: 5 };
			},
			isolation: {
				prepareIsolationContext: async () => ({ repoRoot: parentRepo, baseline: {} }),
				parseIsolationMode: () => undefined,
				makeIsolationCommitMessage: () => () => undefined,
				runIsolatedExecution: async opts => {
					const inner = await opts.run(worktree);
					return {
						...inner,
						patchPath: path.join(artifactRoot, "att.patch"),
					};
				},
				mergeIsolatedChanges: async () => ({
					summary: "applied",
					changesApplied: true,
					hadAnyChanges: true,
					mergedBranchForNestedPatches: false,
				}),
				applyEligibleNestedPatches: async () => "",
			},
		});

		// Write the patch artifact that merge/preserve expect to read.
		await Bun.write(path.join(artifactRoot, "att.patch"), "diff --git a/implemented.txt b/implemented.txt\n");

		const result = await adapter.run(
			plannerRequest({
				role: "implementer",
				profile: {
					...DEFAULT_MODEL_PROFILES.grok_implementer,
					modelPattern: "grok-4.5",
					runtime: { kind: "codex_cli" },
				},
				isolation: { requested: true, merge: "patch", apply: true },
				outputSchema: { type: "object", required: ["kind", "summary"] },
				assignment: "implement the file",
			}),
		);

		expect(calls[0]?.command).toContain("workspace-write");
		expect(calls[0]?.cwd).toBe(worktree);
		expect(calls[0]?.cwd).not.toBe(parentRepo);
		expect(result.patchPath).toBeTruthy();
		expect(result.changesApplied).toBe(true);
		expect(result.artifact).toMatchObject({ summary: "done" });
	});
});
