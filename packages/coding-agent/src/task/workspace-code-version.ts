/**
 * Resolve a cheap current workspace code version for parent freshness checks.
 * Fail-open to empty string (reclassify treats empty as stale) when VCS is unavailable.
 *
 * Freshness includes the dirty tree: uncommitted edits must not keep the same
 * identity as a clean HEAD (forged / stale child packages stay stale).
 */
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { ParentFinalCodeStateRef } from "../latency/parent-final-verification";

export async function resolveCurrentWorkspaceCodeVersion(cwd: string): Promise<string> {
	try {
		const repo = vcs.repo(cwd);
		if (!repo) return "";
		const headId = await repo.headId();
		const head = typeof headId === "string" ? headId.trim() : "";
		if (!head) return "";
		let dirty = false;
		try {
			const git = repo.asGit();
			if (git) {
				dirty = (await git.isDirty()) === true;
			} else {
				const summary = await repo.statusSummary();
				dirty = summary.staged + summary.unstaged + summary.untracked > 0;
			}
		} catch {
			// Dirty probe unavailable — keep HEAD-only rather than inventing dirty.
			dirty = false;
		}
		return dirty ? `${head}:dirty` : head;
	} catch {
		return "";
	}
}

/**
 * Snapshot for ordinary parent-final receipts. Empty when VCS is unavailable —
 * callers must not invent a child/package fallback version.
 */
export async function resolveParentFinalCodeStateRef(cwd: string): Promise<ParentFinalCodeStateRef | undefined> {
	const version = await resolveCurrentWorkspaceCodeVersion(cwd);
	if (!version) return undefined;
	const headId = version.endsWith(":dirty") ? version.slice(0, -":dirty".length) : version;
	return {
		fingerprint: version,
		headId,
	};
}
