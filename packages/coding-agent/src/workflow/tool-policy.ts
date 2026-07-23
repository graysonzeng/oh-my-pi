import * as path from "node:path";
import type { PlanModeState } from "../plan-mode/state";
import type { ToolSession } from "../tools";
import { WorkflowPolicyError } from "./errors";
import type { WorkflowRole } from "./types";

export interface WorkflowWritePolicy {
	repoRoot: string;
	forbiddenPaths: string[];
}

export interface WorkflowCommandPolicy {
	allowedCommands: string[];
}

export function assertWorkflowPathAllowed(targetPath: string, policy: WorkflowWritePolicy): void {
	const root = path.resolve(policy.repoRoot);
	const resolved = path.resolve(root, targetPath);
	const relative = path.relative(root, resolved);
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new WorkflowPolicyError("workflow_path_outside_repo", { path: targetPath });
	}
	const normalized = relative.split(path.sep).join("/");
	const forbidden = policy.forbiddenPaths.some(entry => {
		const candidate = path.normalize(entry).split(path.sep).join("/").replace(/\/+$/, "");
		return normalized === candidate || normalized.startsWith(`${candidate}/`);
	});
	if (forbidden) {
		throw new WorkflowPolicyError("workflow_path_forbidden", { path: normalized });
	}
}

/** Shell metacharacters that turn a prefix-allowed command into a chain/expansion. */
const WORKFLOW_COMMAND_SHELL_META = /[;|&`$()<>\n]/;

export function assertWorkflowCommandAllowed(command: string, policy: WorkflowCommandPolicy): void {
	const normalized = command.trim().replace(/\s+/g, " ");
	const allowed = policy.allowedCommands.some(entry => {
		const expected = entry.trim().replace(/\s+/g, " ");
		if (normalized === expected) return true;
		if (!normalized.startsWith(`${expected} `)) return false;
		// Prefix form may only append path-like args — not shell chaining / expansion.
		if (WORKFLOW_COMMAND_SHELL_META.test(normalized)) return false;
		return true;
	});
	if (!allowed) {
		throw new WorkflowPolicyError("workflow_command_forbidden", { command: normalized });
	}
}

/**
 * Readonly roles must not edit the workspace.
 * Enforced by wrapping the ToolSession so structured-subagent enters plan mode
 * (tools limited to read/grep/glob/web_search[/ast_grep], isolation disabled).
 */
export const READONLY_WORKFLOW_ROLES: ReadonlySet<WorkflowRole> = new Set([
	"planner",
	"plan_reviewer",
	"code_reviewer",
]);

/** Mirrors task structured-subagent PLAN_MODE_TOOLS (+ optional ast_grep). */
export const READONLY_TOOLS = ["read", "grep", "glob", "web_search", "ast_grep"] as const;

/** Scoped implementation tools — no package/lock/CI/release mutation surface. */
export const SCOPED_IMPLEMENTATION_TOOLS = [
	"read",
	"grep",
	"glob",
	"ast_grep",
	"edit",
	"write",
	"bash",
	"todo",
] as const;

/** Scoped repair — same as implement, no task spawn / package managers via tools list. */
export const SCOPED_REPAIR_TOOLS = [...SCOPED_IMPLEMENTATION_TOOLS] as const;

export type ToolPolicy = {
	readonly: boolean;
	/** Named policy id from ModelProfile.toolPolicyId */
	policyId: string;
	allowedTools: readonly string[];
	forbiddenPaths: string[];
	allowedCommands: string[];
};

export function isReadonlyWorkflowRole(role: WorkflowRole | string): boolean {
	return READONLY_WORKFLOW_ROLES.has(role as WorkflowRole);
}

export class ToolPolicyFactory {
	getPolicyForRole(role: string): ToolPolicy {
		if (role === "planner") {
			return {
				readonly: true,
				policyId: "readonly-planning",
				allowedTools: READONLY_TOOLS,
				forbiddenPaths: [".git", "node_modules", "dist", "build"],
				allowedCommands: ["echo", "rg", "git status"],
			};
		}
		if (role === "plan_reviewer" || role === "code_reviewer") {
			return {
				readonly: true,
				policyId: "readonly-review",
				allowedTools: READONLY_TOOLS,
				forbiddenPaths: [".git", "node_modules", "dist", "build"],
				allowedCommands: ["echo", "rg", "git status", "git diff --check"],
			};
		}
		if (role === "implementer") {
			return {
				readonly: false,
				policyId: "scoped-implementation",
				allowedTools: SCOPED_IMPLEMENTATION_TOOLS,
				forbiddenPaths: ["package.json", "bun.lock", "Cargo.lock", "lockfiles", "scripts/"],
				allowedCommands: ["bun test", "bun check", "biome check"],
			};
		}
		if (role === "repair") {
			return {
				readonly: false,
				policyId: "scoped-repair",
				allowedTools: SCOPED_REPAIR_TOOLS,
				forbiddenPaths: ["package.json", "bun.lock", "Cargo.lock"],
				allowedCommands: ["bun test", "bun check"],
			};
		}
		return {
			readonly: true,
			policyId: "readonly-default",
			allowedTools: READONLY_TOOLS,
			forbiddenPaths: [],
			allowedCommands: [],
		};
	}

	/** Resolve tools for structured-subagent allowedTools (undefined = unrestricted). */
	allowedToolsForRole(role: WorkflowRole | string): readonly string[] | undefined {
		const policy = this.getPolicyForRole(role);
		if (policy.readonly) return undefined; // plan-mode wrap owns readonly tools
		if (policy.allowedTools.length === 1 && policy.allowedTools[0] === "*") return undefined;
		return policy.allowedTools;
	}
}

/**
 * Wrap a ToolSession so structured-subagent treats the run as plan mode:
 * - getPlanModeState().enabled === true → createPlanModeAgent (read-only tools)
 * - no write tools / no isolation for that subagent
 */
export function wrapSessionForWorkflowRole(session: ToolSession, role: WorkflowRole | string): ToolSession {
	if (!isReadonlyWorkflowRole(role)) return session;

	const previous = session.getPlanModeState?.bind(session);
	return {
		...session,
		getPlanModeState: (): PlanModeState => {
			const base = previous?.();
			return {
				planFilePath: base?.planFilePath ?? "workflow-readonly.plan.md",
				workflow: base?.workflow,
				reentry: base?.reentry,
				enabled: true,
			};
		},
	};
}
