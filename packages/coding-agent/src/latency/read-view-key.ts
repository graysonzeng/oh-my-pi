/**
 * ReadViewKeyV1 — design A §4.1.4.
 * Dedupe is prompt-level (model-visible injection), not a change to read external semantics.
 * Any unknown identity field → fail open (no dedupe hit).
 */

import { sha256Hex, stableSerialize } from "./stable-serialize";

export const READ_VIEW_KEY_VERSION = 1 as const;
export const READ_VIEW_RENDERER_VERSION = "read-renderer:v1" as const;

export type ReadOutputMode = "raw" | "converted" | "decoded" | "summary" | "unknown";

export interface ReadViewKeyPartsV1 {
	tool: "read";
	/** Resolved local path, archive member, internal URI, or normalized URL. */
	canonicalSource: string;
	/** raw/line-range/table-row/query selector semantics. */
	normalizedSelector: string;
	/** repo root + worktree/session revision/branch identity. */
	branchOrWorktreeScope: string;
	/**
	 * URL ETag/Last-Modified/content digest, artifact immutable SHA,
	 * archive member SHA, DB snapshot, or provider view id.
	 * Empty/unknown ⇒ fail open.
	 */
	providerViewIdentity: string;
	/** Working-tree content digest or revision receipt. Empty/unknown ⇒ fail open. */
	contentOrRevisionIdentity: string;
	rendererVersion: string;
	outputMode: ReadOutputMode;
}

export interface ReadViewKeyV1 {
	schemaVersion: typeof READ_VIEW_KEY_VERSION;
	key: string;
	parts: ReadViewKeyPartsV1;
	/** False when any identity required for safe hit is missing. */
	eligible: boolean;
	/** Why the key is ineligible for hits (empty when eligible). */
	failOpenReasons: string[];
}


export function buildReadViewKeyV1(
	parts: Omit<ReadViewKeyPartsV1, "tool" | "rendererVersion"> & {
		rendererVersion?: string;
	},
): ReadViewKeyV1 {
	const normalized: ReadViewKeyPartsV1 = {
		tool: "read",
		canonicalSource: parts.canonicalSource.trim(),
		normalizedSelector: parts.normalizedSelector.trim() || "full",
		branchOrWorktreeScope: parts.branchOrWorktreeScope.trim(),
		providerViewIdentity: parts.providerViewIdentity.trim(),
		contentOrRevisionIdentity: parts.contentOrRevisionIdentity.trim(),
		rendererVersion: (parts.rendererVersion ?? READ_VIEW_RENDERER_VERSION).trim(),
		outputMode: parts.outputMode,
	};

	const failOpenReasons: string[] = [];
	if (!normalized.canonicalSource) failOpenReasons.push("missing_canonical_source");
	if (!normalized.branchOrWorktreeScope) failOpenReasons.push("missing_branch_or_worktree_scope");
	if (!normalized.providerViewIdentity) failOpenReasons.push("missing_provider_view_identity");
	if (!normalized.contentOrRevisionIdentity) failOpenReasons.push("missing_content_or_revision_identity");
	if (!normalized.rendererVersion) failOpenReasons.push("missing_renderer_version");
	if (normalized.outputMode === "unknown") failOpenReasons.push("unknown_output_mode");

	const eligible = failOpenReasons.length === 0;
	const key = sha256Hex(stableSerialize(normalized));
	return {
		schemaVersion: READ_VIEW_KEY_VERSION,
		key,
		parts: normalized,
		eligible,
		failOpenReasons,
	};
}

export function normalizeReadSelector(input: {
	raw?: boolean;
	offset?: number;
	limit?: number;
	selector?: string;
	query?: string;
}): string {
	if (input.selector?.trim()) return input.selector.trim();
	const parts: string[] = [];
	if (input.raw) parts.push("raw");
	if (typeof input.offset === "number") parts.push(`offset=${input.offset}`);
	if (typeof input.limit === "number") parts.push(`limit=${input.limit}`);
	if (input.query?.trim()) parts.push(`q=${input.query.trim()}`);
	return parts.length > 0 ? parts.join("&") : "full";
}
