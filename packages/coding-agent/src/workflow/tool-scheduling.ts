/**
 * Tool scheduling policy helpers for agent-loop concurrency.
 * Pure resource-conflict + budget reservation — no DAG, no cross-turn inference.
 */

export type ResourceAccess = "read" | "write" | "unknown";

/** Design modes (serialize|fail) plus legacy aliases (conservative|permissive). */
export type ResourceConflictMode = "serialize" | "fail" | "conservative" | "permissive";

export interface ToolResourceClaim {
	toolName: string;
	/** Normalized paths claimed by this call; empty when unknown. */
	paths: string[];
	access: ResourceAccess;
	/** When true, tool is exclusive regardless of paths (e.g. mutating bash). */
	exclusive?: boolean;
}

export interface ToolSchedulingPolicy {
	maxConcurrentTools: number;
	/** Remaining tool-call budget for this stage/turn; null = unlimited. */
	remainingToolCalls: number | null;
	/** Remaining stage wall time ms; null = unknown. */
	remainingStageTimeMs: number | null;
	/**
	 * How to treat resource conflicts:
	 * - serialize/conservative: conflicting tools run one-at-a-time
	 * - fail: later conflicting tool is skipped with error
	 * - permissive: only exclusive flags / same-path writes conflict
	 */
	resourceConflictMode: ResourceConflictMode;
}

export const DEFAULT_TOOL_SCHEDULING_POLICY: ToolSchedulingPolicy = {
	maxConcurrentTools: 8,
	remainingToolCalls: null,
	remainingStageTimeMs: null,
	resourceConflictMode: "serialize",
};

const WRITE_TOOLS = new Set(["write", "edit", "apply_patch", "MultiEdit", "str_replace", "patch"]);
const READ_TOOLS = new Set(["read", "grep", "ls", "glob", "search"]);

/**
 * Heuristic: command likely mutates the workspace.
 * False positives serialize (safe); not 100% accurate by design.
 */
export function bashLikelyMutatesWorkspace(command: string): boolean {
	const c = command.trim();
	if (!c) return true;
	// Redirection / destructive / move-copy / write utilities
	if (/(?:^|[^0-9])>(?:$|[^>])/.test(c)) return true;
	if (/(?:^|&&|\|\||;|\n)\s*(?:sudo\s+)?(?:rm|mv|cp|install|dd|truncate|tee|chmod|chown)\b/.test(c)) return true;
	if (/\b(?:rm|mv|cp)\s+/.test(c)) return true;
	if (/\b(?:npm|pnpm|bun|yarn)\s+(?:install|add|remove|unlink)\b/.test(c)) return true;
	if (/\bgit\s+(?:checkout|reset|clean|rebase|merge|apply|am)\b/.test(c)) return true;
	return false;
}

/** Infer a resource claim from tool name + args (best-effort; unknown → conservative). */
export function inferResourceClaim(toolName: string, args: Record<string, unknown> | undefined): ToolResourceClaim {
	const name = toolName;
	const paths: string[] = [];
	if (args) {
		for (const key of ["path", "file_path", "filePath", "target_file", "file"]) {
			const v = args[key];
			if (typeof v === "string" && v) paths.push(normalizePath(v));
		}
		if (Array.isArray(args.paths)) {
			for (const p of args.paths) {
				if (typeof p === "string") paths.push(normalizePath(p));
			}
		}
	}

	if (WRITE_TOOLS.has(name)) {
		return { toolName: name, paths, access: "write", exclusive: paths.length === 0 };
	}
	if (READ_TOOLS.has(name)) {
		return { toolName: name, paths, access: "read" };
	}
	if (name === "bash" || name === "run_command" || name === "shell") {
		const cmd = typeof args?.command === "string" ? args.command : typeof args?.cmd === "string" ? args.cmd : "";
		if (!cmd || bashLikelyMutatesWorkspace(cmd)) {
			return { toolName: name, paths, access: "unknown", exclusive: true };
		}
		// Non-mutating bash (e.g. `cat`, `ls`, `echo hello`) may share with other reads.
		return { toolName: name, paths, access: "read", exclusive: false };
	}
	return { toolName: name, paths, access: "unknown", exclusive: false };
}

function normalizePath(p: string): string {
	return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Map design + legacy mode names onto serialize vs permissive conflict rules. */
export function normalizeConflictMode(mode: ResourceConflictMode | undefined): "serialize" | "fail" | "permissive" {
	if (mode === "fail") return "fail";
	if (mode === "permissive") return "permissive";
	// serialize | conservative | undefined
	return "serialize";
}

/**
 * True when two claims must not run concurrently.
 * - exclusive flags
 * - same path with any write
 * - unknown access under serialize/conservative vs any write/unknown
 */
export function claimsConflict(
	a: ToolResourceClaim,
	b: ToolResourceClaim,
	mode: ResourceConflictMode = "serialize",
): boolean {
	const norm = normalizeConflictMode(mode);

	// Exclusive tools take the exclusive barrier via claim.exclusive; pairwise
	// conflict only needs exclusive vs write/unknown so pure reads can share after.
	if (a.exclusive && b.exclusive) return true;
	if (a.exclusive && (b.access === "write" || b.access === "unknown")) return true;
	if (b.exclusive && (a.access === "write" || a.access === "unknown")) return true;

	const aWrite = a.access === "write";
	const bWrite = b.access === "write";
	if (a.paths.length && b.paths.length) {
		const bSet = new Set(b.paths);
		for (const p of a.paths) {
			if (bSet.has(p) && (aWrite || bWrite)) return true;
		}
		// Same path both read → ok
		return false;
	}

	if (norm === "permissive") return false;
	// serialize: unknown prior/current write state → serialize against writes/unknowns
	if (
		(a.access === "unknown" || b.access === "unknown") &&
		(aWrite || bWrite || a.access === "unknown" || b.access === "unknown")
	) {
		if (a.access === "read" && b.access === "read") return false;
		if (a.access === "unknown" && b.access === "unknown") return true;
		if ((aWrite || a.access === "unknown") && (bWrite || b.access === "unknown")) return true;
	}
	return false;
}

/**
 * Budget reservation for a planned batch of tool calls.
 * Call releaseReservation on abort/skip.
 */
export class ToolCallBudget {
	#remaining: number | null;
	#reserved = 0;

	constructor(remaining: number | null) {
		this.#remaining = remaining;
	}

	get remaining(): number | null {
		if (this.#remaining === null) return null;
		return this.#remaining - this.#reserved;
	}

	/** Reserve n calls; returns false when budget insufficient. */
	tryReserve(n: number): boolean {
		if (this.#remaining === null) {
			this.#reserved += n;
			return true;
		}
		if (this.#remaining - this.#reserved < n) return false;
		this.#reserved += n;
		return true;
	}

	release(n: number): void {
		this.#reserved = Math.max(0, this.#reserved - n);
	}

	/** Commit a completed call (consumes one from remaining). */
	commit(n = 1): void {
		this.release(n);
		if (this.#remaining !== null) {
			this.#remaining = Math.max(0, this.#remaining - n);
		}
	}
}

/**
 * Simple semaphore for max concurrent shared tools.
 */
export class ConcurrencyLimiter {
	#max: number;
	#active = 0;
	#waiters: Array<() => void> = [];

	constructor(max: number) {
		this.#max = Math.max(1, max);
	}

	async acquire(): Promise<() => void> {
		if (this.#active < this.#max) {
			this.#active++;
			return () => this.#release();
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#waiters.push(resolve);
		await promise;
		this.#active++;
		return () => this.#release();
	}

	#release(): void {
		this.#active = Math.max(0, this.#active - 1);
		const next = this.#waiters.shift();
		if (next) next();
	}
}
