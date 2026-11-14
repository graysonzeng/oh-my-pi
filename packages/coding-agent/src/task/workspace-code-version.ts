/**
 * Resolve a content-bound workspace code version for parent freshness checks.
 *
 * Prefer proven content identity from `captureVerificationWorkspace` (HEAD +
 * staged/unstaged/untracked/symlink targets). Different dirty trees must not
 * share a reusable identity. Capture failure returns empty string — callers
 * treat empty as stale / unknown, never invent a clean HEAD.
 *
 * Legacy `HEAD:dirty` strings may still appear in old packets; they are not
 * minted here and are not reusable against content-identity versions.
 */
import type { ParentFinalCodeStateRef } from "../latency/parent-final-verification";
import { captureVerificationWorkspace } from "../workflow/verification-validity";

/** Prefix for content-identity versions so legacy HEAD / HEAD:dirty stay distinguishable. */
export const WORKSPACE_CONTENT_VERSION_PREFIX = "content:" as const;

export function isLegacyOpaqueWorkspaceVersion(version: string): boolean {
	const trimmed = version.trim();
	if (!trimmed) return false;
	if (trimmed.startsWith(WORKSPACE_CONTENT_VERSION_PREFIX)) return false;
	// Bare HEAD ids or `${head}:dirty` from pre-consolidation producers.
	return true;
}

export function formatWorkspaceContentVersion(contentSha256: string): string {
	return `${WORKSPACE_CONTENT_VERSION_PREFIX}${contentSha256.trim()}`;
}

export function parseWorkspaceContentVersion(version: string): string | undefined {
	const trimmed = version.trim();
	if (!trimmed.startsWith(WORKSPACE_CONTENT_VERSION_PREFIX)) return undefined;
	const sha = trimmed.slice(WORKSPACE_CONTENT_VERSION_PREFIX.length).trim();
	return sha.length > 0 ? sha : undefined;
}

export async function resolveCurrentWorkspaceCodeVersion(cwd: string): Promise<string> {
	try {
		const workspace = await captureVerificationWorkspace(cwd);
		if (!workspace?.contentSha256) return "";
		return formatWorkspaceContentVersion(workspace.contentSha256);
	} catch {
		return "";
	}
}

/**
 * Snapshot for ordinary parent-final receipts. Empty when VCS/content identity
 * is unavailable — callers must not invent a child/package fallback version.
 */
export async function resolveParentFinalCodeStateRef(cwd: string): Promise<ParentFinalCodeStateRef | undefined> {
	try {
		const workspace = await captureVerificationWorkspace(cwd);
		if (!workspace?.contentSha256) return undefined;
		return {
			fingerprint: formatWorkspaceContentVersion(workspace.contentSha256),
			headId: workspace.headId,
		};
	} catch {
		return undefined;
	}
}
