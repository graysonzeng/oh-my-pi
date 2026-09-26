/**
 * Resolve a cheap current workspace code version for parent freshness checks.
 * Fail-open to empty string (reclassify treats empty as stale) when VCS is unavailable.
 */
import * as vcs from "@oh-my-pi/pi-natives/vcs";

export async function resolveCurrentWorkspaceCodeVersion(cwd: string): Promise<string> {
	try {
		const repo = vcs.repo(cwd);
		if (!repo) return "";
		const headId = await repo.headId();
		return typeof headId === "string" ? headId.trim() : "";
	} catch {
		return "";
	}
}
