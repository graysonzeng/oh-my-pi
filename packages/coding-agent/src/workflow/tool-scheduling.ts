/**
 * Tool scheduling policy helpers for agent-loop concurrency.
 * Pure resource-conflict + budget reservation — no DAG, no cross-turn inference.
 */

export type ResourceAccess = "read" | "write" | "unknown";

export interface ToolResourceClaim {
	toolName: string;
	/** Normalized paths claimed by this call; empty when unknown. */
	paths: string[];
	access: ResourceAccess;
	/** When true, tool is exclusive regardless of paths (e.g. unknown bash side effects). */
	exclusive?: boolean;
}

export interface ToolSchedulingPolicy {
	maxConcurrentTools: number;
	/** Remaining tool-call budget for this stage/turn; null = unlimited. */
	remainingToolCalls: number | null;
	/** Remaining stage wall time ms; null = unknown. */
	remainingStageTimeMs: number | null;
	/** How to treat unknown resource state: conservative serializes. */
	resourceConflictMode: "conservative" | "permissive";
}

export const DEFAULT_TOOL_SCHEDULING_POLICY: ToolSchedulingPolicy = {
	maxConcurrentTools: 8,
	remainingToolCalls: null,
	remainingStageTimeMs: null,
	resourceConflictMode: "conservative",
};

const WRITE_TOOLS = new Set(["write", "edit", "apply_patch", "MultiEdit", "str_replace"]);
const READ_TOOLS = new Set(["read", "grep", "ls", "glob", "search"]);

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
		// Workspace-mutating bash is unknown without parsing — conservative exclusive.
		return { toolName: name, paths, access: "unknown", exclusive: true };
	}
	return { toolName: name, paths, access: "unknown", exclusive: false };
}

function normalizePath(p: string): string {
	return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * True when two claims must not run concurrently.
 * - exclusive flags
 * - same path with any write
 * - unknown access under conservative mode vs any write/unknown
 */
export function claimsConflict(
	a: ToolResourceClaim,
	b: ToolResourceClaim,
	mode: ToolSchedulingPolicy["resourceConflictMode"] = "conservative",
): boolean {
	if (a.exclusive || b.exclusive) {
		// Exclusive only conflicts when both are exclusive or one is write/unknown
		if (a.exclusive && b.exclusive) return true;
		if (a.exclusive && (b.access === "write" || b.access === "unknown")) return true;
		if (b.exclusive && (a.access === "write" || a.access === "unknown")) return true;
	}

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

	// Unknown paths
	if (mode === "permissive") return false;
	// conservative: unknown prior/current write state → serialize against writes/unknowns
	if (
		(a.access === "unknown" || b.access === "unknown") &&
		(aWrite || bWrite || a.access === "unknown" || b.access === "unknown")
	) {
		// Two pure reads with empty paths may still concurrent under conservative if both access=read
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
