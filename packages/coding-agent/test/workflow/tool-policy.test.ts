import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_MODEL_PROFILES } from "../../src/workflow/default-config";
import { RuntimeAdapter, type StructuredRunnerResult } from "../../src/workflow/runtime-adapter";
import {
	assertWorkflowCommandAllowed,
	assertWorkflowPathAllowed,
	isReadonlyWorkflowRole,
	READONLY_TOOLS,
	ToolPolicyFactory,
	wrapSessionForWorkflowRole,
} from "../../src/workflow/tool-policy";
import type { WorkflowAgentRequest } from "../../src/workflow/types";
import { fakeSession, planArtifact } from "./helpers";

function okResult(data: unknown): StructuredRunnerResult {
	return {
		result: {
			id: "raw",
			structuredOutput: { status: "valid", data },
		},
	};
}

function baseRequest(
	role: WorkflowAgentRequest["role"],
	overrides: Partial<WorkflowAgentRequest> = {},
): WorkflowAgentRequest {
	const profileByRole = {
		planner: DEFAULT_MODEL_PROFILES.claude_planner,
		plan_reviewer: DEFAULT_MODEL_PROFILES.claude_reviewer,
		implementer: DEFAULT_MODEL_PROFILES.grok_implementer,
		code_reviewer: DEFAULT_MODEL_PROFILES.claude_reviewer,
		repair: DEFAULT_MODEL_PROFILES.grok_repair ?? DEFAULT_MODEL_PROFILES.grok_implementer,
	} as const;
	return {
		workflowId: "wf_1",
		attemptId: "att_1",
		role,
		profile: profileByRole[role],
		assignment: "do work",
		context: "ctx",
		outputSchema: {},
		session: fakeSession(),
		...overrides,
	};
}

describe("Workflow tool policy (readonly planning)", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-tool-policy-"));
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("classifies planner and reviewers as readonly", () => {
		expect(isReadonlyWorkflowRole("planner")).toBe(true);
		expect(isReadonlyWorkflowRole("plan_reviewer")).toBe(true);
		expect(isReadonlyWorkflowRole("code_reviewer")).toBe(true);
		expect(isReadonlyWorkflowRole("implementer")).toBe(false);
		expect(isReadonlyWorkflowRole("repair")).toBe(false);
		expect(READONLY_TOOLS).toContain("read");
		expect(READONLY_TOOLS).not.toContain("write");
		expect(READONLY_TOOLS).not.toContain("edit");
	});

	it("wrapSessionForWorkflowRole enables plan mode for planner only", () => {
		const session = fakeSession({
			getPlanModeState: () => ({ enabled: false, planFilePath: "x.plan.md" }),
		});
		const wrapped = wrapSessionForWorkflowRole(session, "planner");
		expect(wrapped.getPlanModeState?.()?.enabled).toBe(true);
		expect(wrapped.getPlanModeState?.()?.planFilePath).toBe("x.plan.md");
		// implementer is not wrapped
		const impl = wrapSessionForWorkflowRole(session, "implementer");
		expect(impl.getPlanModeState?.()?.enabled).toBe(false);
		expect(impl).toBe(session);
	});

	it("RuntimeAdapter forces plan-mode session for planner and strips isolation", async () => {
		let seenPlanMode: boolean | undefined;
		let seenIsolation: unknown;
		const adapter = new RuntimeAdapter(async req => {
			seenPlanMode = req.session.getPlanModeState?.()?.enabled === true;
			seenIsolation = req.isolation;
			return okResult(planArtifact());
		});
		await adapter
			.run(
				baseRequest("planner", {
					// Hostile caller tries to request isolation — must fail closed or strip
					isolation: { requested: true, merge: "patch", apply: true },
				}),
			)
			.then(
				() => {
					// If it didn't throw, isolation must have been stripped and plan mode on —
					// but policy forbids isolation.requested for readonly roles.
					throw new Error("expected readonly_role_isolation_forbidden");
				},
				err => {
					expect(String(err.message ?? err)).toMatch(/readonly_role_isolation|isolation/i);
				},
			);

		// Happy path without isolation
		await adapter.run(baseRequest("planner"));
		expect(seenPlanMode).toBe(true);
		expect(seenIsolation).toBeUndefined();
	});

	it("RuntimeAdapter does not force plan mode for implementer and keeps isolation", async () => {
		let seenPlanMode: boolean | undefined;
		let seenIsolation: { requested?: boolean } | undefined;
		const adapter = new RuntimeAdapter(async req => {
			seenPlanMode = req.session.getPlanModeState?.()?.enabled === true;
			seenIsolation = req.isolation;
			return okResult({
				kind: "implementation",
				summary: "x",
				changedFiles: [],
				addressedStepIds: [],
				commandsRun: [],
				unresolved: [],
				schemaVersion: 1,
				workflowId: "wf_1",
				attemptId: "att_1",
				stage: "implementing",
				createdAt: new Date().toISOString(),
			});
		});
		await adapter.run(
			baseRequest("implementer", {
				isolation: { requested: true, merge: "patch", apply: true },
			}),
		);
		expect(seenPlanMode).toBe(false);
		expect(seenIsolation?.requested).toBe(true);
	});

	it("ToolPolicyFactory marks planning/review policies readonly without write tools", () => {
		const factory = new ToolPolicyFactory();
		const plan = factory.getPolicyForRole("planner");
		expect(plan.readonly).toBe(true);
		expect(plan.allowedTools).not.toContain("write");
		expect(plan.allowedTools).not.toContain("edit");
		expect(plan.allowedTools).toContain("read");
		const impl = factory.getPolicyForRole("implementer");
		expect(impl.readonly).toBe(false);
		expect(factory.allowedToolsForRole("implementer")).toContain("edit");
		expect(factory.allowedToolsForRole("implementer")).not.toContain("task");
		expect(factory.allowedToolsForRole("planner")).toBeUndefined(); // plan-mode owns readonly
	});

	it("RuntimeAdapter forwards scoped allowedTools for implementer", async () => {
		let seenTools: readonly string[] | undefined;
		const adapter = new RuntimeAdapter(async req => {
			seenTools = req.allowedTools;
			return okResult({
				kind: "implementation",
				summary: "x",
				changedFiles: [],
				addressedStepIds: [],
				commandsRun: [],
				unresolved: [],
				schemaVersion: 1,
				workflowId: "wf_1",
				attemptId: "att_1",
				stage: "implementing",
				createdAt: new Date().toISOString(),
			});
		});
		await adapter.run(
			baseRequest("implementer", {
				isolation: { requested: true, merge: "patch", apply: true },
			}),
		);
		expect(seenTools).toBeDefined();
		expect(seenTools).toContain("edit");
		expect(seenTools).toContain("write");
		expect(seenTools).not.toContain("task");
	});

	it("rejects forbidden workflow write paths after repo-relative normalization", async () => {
		expect(() =>
			assertWorkflowPathAllowed(path.join(dir, "nested/../package.json"), {
				repoRoot: dir,
				forbiddenPaths: ["package.json"],
			}),
		).toThrow(/forbidden|workflow/i);
	});

	it("rejects workflow bash commands outside the allowlist", () => {
		expect(() =>
			assertWorkflowCommandAllowed("echo not-allowed", {
				allowedCommands: ["bun test", "bun check"],
			}),
		).toThrow(/forbidden|workflow|policy/i);
	});

	it("rejects shell-chained commands that only prefix-match an allowlisted entry", () => {
		expect(() =>
			assertWorkflowCommandAllowed("bun test; rm -rf /", {
				allowedCommands: ["bun test", "bun check"],
			}),
		).toThrow(/forbidden|workflow|policy/i);
		expect(() =>
			assertWorkflowCommandAllowed("bun test && rm -rf /", {
				allowedCommands: ["bun test"],
			}),
		).toThrow(/forbidden|workflow|policy/i);
		expect(() =>
			assertWorkflowCommandAllowed("bun test $(rm -rf /)", {
				allowedCommands: ["bun test"],
			}),
		).toThrow(/forbidden|workflow|policy/i);
		// Safe trailing args remain allowed.
		expect(() =>
			assertWorkflowCommandAllowed("bun test packages/coding-agent/test/workflow", {
				allowedCommands: ["bun test"],
			}),
		).not.toThrow();
	});
});
