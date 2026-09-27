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

export type MemoryImportAction = "create" | "skip" | "conflict";

export interface MemoryImportPreviewItem {
	action: MemoryImportAction;
	record: MemoryExportRecord;
	reason: string;
}

export interface MemoryImportPreview {
	formatVersion: typeof MEMORY_EXPORT_FORMAT_VERSION;
	backend: MemoryBackendId;
	scope: string;
	items: MemoryImportPreviewItem[];
	/** True when package claims complete and preview accepted the claim. */
	packageComplete: boolean;
	warnings: string[];
}

export interface MemoryImportApplyResult {
	created: string[];
	skipped: string[];
	conflicts: string[];
	partial: boolean;
	message?: string;
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
