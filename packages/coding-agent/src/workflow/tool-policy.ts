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
	// Case-insensitive volumes (macOS default) can resolve Package.json → package.json.
	const normalized = relative.split(path.sep).join("/");
	const normalizedLower = normalized.toLowerCase();
	const forbidden = policy.forbiddenPaths.some(entry => {
		const candidate = path.normalize(entry).split(path.sep).join("/").replace(/\/+$/, "");
		const candidateLower = candidate.toLowerCase();
		return (
			normalized === candidate ||
			normalized.startsWith(`${candidate}/`) ||
			normalizedLower === candidateLower ||
			normalizedLower.startsWith(`${candidateLower}/`)
		);
	});
	if (forbidden) {
		throw new WorkflowPolicyError("workflow_path_forbidden", { path: normalized });
	}
}

/** Shell metacharacters that turn a prefix-allowed command into a chain/expansion. */
const WORKFLOW_COMMAND_SHELL_META = /[;|&`$()<>]/;
/** Control characters (including newline) must be rejected on the raw command before whitespace collapse. */
const WORKFLOW_COMMAND_CONTROL = /[\u0000-\u001f\u007f]/;
/** Flags that turn an allowlisted validation prefix into a mutating command. */
const WORKFLOW_COMMAND_MUTATING_FLAGS = /(?:^|\s)(--write|--fix|--apply|-w)(?:\s|=|$)/i;

export function assertWorkflowCommandAllowed(command: string, policy: WorkflowCommandPolicy): void {
	// Fail closed on control characters / newlines before any normalization: collapsing
	// whitespace would turn `bun test\nrm -rf src` into a single allowed prefix form while
	// the shell still executes the second line.
	if (WORKFLOW_COMMAND_CONTROL.test(command)) {
		throw new WorkflowPolicyError("workflow_command_forbidden", { command, reason: "control_characters" });
	}
	if (WORKFLOW_COMMAND_SHELL_META.test(command)) {
		throw new WorkflowPolicyError("workflow_command_forbidden", { command, reason: "shell_metacharacters" });
	}
	const normalized = command.trim().replace(/\s+/g, " ");
	if (WORKFLOW_COMMAND_MUTATING_FLAGS.test(normalized)) {
		throw new WorkflowPolicyError("workflow_command_forbidden", { command: normalized, reason: "mutating_flag" });
	}
	const allowed = policy.allowedCommands.some(entry => {
		const expected = entry.trim().replace(/\s+/g, " ");
		if (normalized === expected) return true;
		if (!normalized.startsWith(`${expected} `)) return false;
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

/** Scoped implementation tools — no package/lock/CI/release mutation surface.
 * `yield` is required: structured subagents terminate via yield, and catalog
 * presentation filters tools through this allowlist (optimized live). Omitting
 * it produces "Tool yield not found" after the model finishes the work.
 */
export const SCOPED_IMPLEMENTATION_TOOLS = [
	"read",
	"grep",
	"glob",
	"ast_grep",
	"edit",
	"write",
	"bash",
	"todo",
	"yield",
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

/** Policy ids ToolPolicyFactory can resolve; unknown profile toolPolicyIds fail closed. */
export const KNOWN_TOOL_POLICY_IDS: Readonly<Record<string, true>> = {
	"readonly-planning": true,
	"readonly-review": true,
	"readonly-default": true,
	"scoped-repair": true,
	"scoped-implementation": true,
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
				// .git must stay forbidden: isolated worktrees expose a writable .git file into the real repo.
				forbiddenPaths: [".git", "package.json", "bun.lock", "Cargo.lock", "lockfiles", "scripts/"],
				// Prefix allowlist: `bun test test/foo.test.ts` is permitted; shell chaining is rejected.
				// No bare `find`: prefix match would allow `find . -delete` / `-exec` and bypass path policy.
				// Prefer glob/read for discovery; cat/head for small file peeks.
				allowedCommands: ["bun test", "bun check", "biome check", "pwd", "ls", "cat", "head"],
			};
		}
		if (role === "repair") {
			return {
				readonly: false,
				policyId: "scoped-repair",
				allowedTools: SCOPED_REPAIR_TOOLS,
				forbiddenPaths: [".git", "package.json", "bun.lock", "Cargo.lock"],
				allowedCommands: ["bun test", "bun check", "pwd", "ls", "cat", "head"],
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
