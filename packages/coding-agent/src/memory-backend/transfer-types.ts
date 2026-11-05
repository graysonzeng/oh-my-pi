/**
 * D4 memory transfer — export / preview / import contracts for MemoryBackend.
 *
 * Extends the existing seam; does not add a second memory system or Dreaming
 * daemon. `clear` remains whole-backend wipe — entry delete is separate and may
 * be unsupported.
 */
import type { MemoryBackendId } from "./types";

export const MEMORY_EXPORT_FORMAT_VERSION = 1 as const;

export type MemoryRecordKind =
	| "user_preference"
	| "project_fact"
	| "decision"
	| "learning_candidate"
	| "summary"
	| "other";

export type MemoryTrustLevel = "user" | "learned_candidate" | "system" | "unknown";

export interface MemoryTransferCapabilities {
	export: boolean;
	importPreview: boolean;
	importApply: boolean;
	/** Entry-level delete; false ⇒ must not fake via clear(). */
	entryDelete: boolean;
	/** When false, export is best-effort / partial by design. */
	fullTraverse: boolean;
}

export interface MemoryExportManifest {
	formatVersion: typeof MEMORY_EXPORT_FORMAT_VERSION;
	backend: MemoryBackendId;
	exportedAt: string;
	scope: string;
	/**
	 * True only when every transfer-supported artifact that exists was included
	 * and no out-of-surface existing assets were left on the floor.
	 * Omitted capabilities (entryDelete) do not alone make a package incomplete;
	 * omittedFields that name existing non-exported assets do.
	 */
	complete: boolean;
	omittedCapabilities: string[];
	omittedFields: string[];
	contentChecksum: string;
	recordCount: number;
}

export interface MemoryExportRecord {
	sourceId?: string;
	kind: MemoryRecordKind;
	content: string;
	sourceRef?: string;
	scope: string;
	createdAt?: string;
	updatedAt?: string;
	applicableVersion?: string;
	supersedes?: string;
	trust: MemoryTrustLevel;
	contentFingerprint: string;
}

export interface MemoryExportPackage {
	manifest: MemoryExportManifest;
	records: MemoryExportRecord[];
}

export type MemoryImportAction = "create" | "skip" | "conflict" | "overwrite";

export interface MemoryImportPreviewItem {
	action: MemoryImportAction;
	record: MemoryExportRecord;
	reason: string;
}

export interface MemoryImportPreview {
	formatVersion: typeof MEMORY_EXPORT_FORMAT_VERSION;
	backend: MemoryBackendId;
	scope: string;
	/** Package source scope from manifest (for confirm binding). */
	sourceScope: string;
	items: MemoryImportPreviewItem[];
	/** True when package claims complete AND integrity validation passed. */
	packageComplete: boolean;
	warnings: string[];
	/** Structured integrity / authorization failures (never parse warnings for these). */
	blockingIssues: string[];
	/**
	 * Binding token for cross-scope apply: source + target + checksum + plan.
	 * Required when sourceScope !== scope or any record.scope differs.
	 */
	confirmBinding?: string;
	requiresCrossScopeConfirm: boolean;
}

export interface MemoryImportApplyItemError {
	id: string;
	error: string;
}

export interface MemoryImportApplyResult {
	created: string[];
	skipped: string[];
	conflicts: string[];
	overwritten?: string[];
	/** Per-item failures that did not abort the whole batch. */
	errors: MemoryImportApplyItemError[];
	partial: boolean;
	message?: string;
	/** IDs successfully written before a later failure (inspectable partial). */
	writtenIds?: string[];
}

export function defaultMemoryTransferCapabilities(
	partial?: Partial<MemoryTransferCapabilities>,
): MemoryTransferCapabilities {
	return {
		export: false,
		importPreview: false,
		importApply: false,
		entryDelete: false,
		fullTraverse: false,
		...partial,
	};
}
