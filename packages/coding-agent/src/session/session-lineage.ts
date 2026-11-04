/**
 * Session-scoped lineage for internal-URL resolution.
 *
 * Normal sessions live beneath the configured session root (normally outside
 * the repository), so session artifacts are NEVER encoded as
 * repository-relative paths. The persisted `parentSession` header value stays a
 * STRING: a canonical absolute session-file path for new writes, or a legacy
 * session ID for pre-revision writes. Normalization to a structured reference
 * happens here, at read/resolve time.
 *
 * Lineage context is derived LIVE from the owning session manager per resolve
 * (never snapshotted as a required field): a switch/new/fork that changes the
 * current file must not retain a stale ancestor set, and an in-memory session
 * with no file degrades to an empty (non-lineage) context.
 */
import * as path from "node:path";
import { resolveManagedSessionRoot } from "./session-paths";

/** Bounded ancestor-walk depth, aligned with existing safe-read limits. */
export const MAX_LINEAGE_DEPTH = 8;

/** One resolved ancestor session file, ordered nearest-first. */
export interface LineageRoot {
	canonicalPath: string;
	depth: number;
}

/** Live, per-resolve lineage snapshot supplied by the owning session. */
export interface LineageContext {
	currentSessionFile: string | null;
	lineageRoots: readonly LineageRoot[];
}

export const EMPTY_LINEAGE_CONTEXT: LineageContext = { currentSessionFile: null, lineageRoots: [] };

export type ParentSessionRef =
	| { kind: "session-file"; canonicalPath: string }
	| { kind: "legacy-session-id"; id: string };

export type LineageDiagnostic =
	| { kind: "unsafe-root"; path: string }
	| { kind: "malformed-link"; path: string }
	| { kind: "missing"; path: string }
	| { kind: "cycle"; path: string }
	| { kind: "collision"; path: string }
	| { kind: "depth-exceeded" };

function homedir(): string {
	return process.env.HOME ?? "/";
}

/**
 * Whether a canonical session-file path lives under the managed session root
 * (the configured root, or the session's own directory when no managed root
 * is resolvable — e.g. temp-root or in-memory sessions).
 */
function isWithinManagedRoot(canonicalPath: string, sessionDir: string, cwd: string): boolean {
	const managedRoot = resolveManagedSessionRoot(sessionDir, cwd) ?? sessionDir;
	const root = path.resolve(managedRoot);
	return canonicalPath === root || canonicalPath.startsWith(root + path.sep);
}

/**
 * Normalize a persisted `parentSession` header value. Path-form strings are
 * canonicalized and validated against the managed session root before being
 * accepted; anything else is treated as a legacy opaque ID (bounded store
 * lookup at resolve time). Unsafe/outside-root paths yield a diagnostic, never
 * an alternate root.
 */
export function normalizeParentSessionRef(
	value: string | undefined,
	sessionDir: string,
	cwd: string,
): { ref?: ParentSessionRef; diagnostic?: LineageDiagnostic } {
	if (value === undefined || value === "") {
		return {};
	}
	const looksLikePath =
		value.includes(path.sep) ||
		value.includes("/") ||
		value.endsWith(".jsonl") ||
		value.startsWith("~") ||
		path.isAbsolute(value);
	if (!looksLikePath) {
		return { ref: { kind: "legacy-session-id", id: value } };
	}
	const expanded = value.startsWith("~") ? path.join(homedir(), value.slice(1)) : value;
	const canonical = path.resolve(expanded);
	if (!canonical.endsWith(".jsonl")) {
		return { ref: { kind: "legacy-session-id", id: value } };
	}
	if (!isWithinManagedRoot(canonical, sessionDir, cwd)) {
		return { diagnostic: { kind: "unsafe-root", path: canonical } };
	}
	return { ref: { kind: "session-file", canonicalPath: canonical } };
}
