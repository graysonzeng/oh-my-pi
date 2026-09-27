/**
 * D4 second-seam transfer for the sharpshooter backend.
 * Traverses architecture.md / product.md / style.md — never search top-N.
 * Queue JSON and lock files are omitted (not a full knowledge-graph dump).
 */
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import { fingerprintStable } from "../latency/stable-serialize";
import { sharpshooterMemoryFilePath } from "../sharpshooter/paths";
import { SHARPSHOOTER_MEMORY_FILES } from "../sharpshooter/types";
import {
	defaultMemoryTransferCapabilities,
	MEMORY_EXPORT_FORMAT_VERSION,
	type MemoryExportPackage,
	type MemoryExportRecord,
	type MemoryImportApplyResult,
	type MemoryImportPreview,
	type MemoryTransferCapabilities,
} from "./transfer-types";
import type { MemoryBackendOperationContext } from "./types";

export function sharpshooterMemoryTransferCapabilities(): MemoryTransferCapabilities {
	return defaultMemoryTransferCapabilities({
		export: true,
		importPreview: true,
		importApply: true,
		entryDelete: false,
		fullTraverse: true,
	});
}

function checksumRecords(records: readonly MemoryExportRecord[]): string {
	return fingerprintStable(records.map(r => ({ id: r.sourceId ?? null, fp: r.contentFingerprint, kind: r.kind })));
}

async function readOptionalText(filePath: string): Promise<string | null> {
	try {
		const text = (await Bun.file(filePath).text()).trim();
		return text.length > 0 ? text : null;
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
}

export async function exportSharpshooterMemory(context: MemoryBackendOperationContext): Promise<MemoryExportPackage> {
	const scope = context.cwd;
	const records: MemoryExportRecord[] = [];
	for (const name of SHARPSHOOTER_MEMORY_FILES) {
		const filePath = sharpshooterMemoryFilePath(context.agentDir, context.cwd, name);
		const content = await readOptionalText(filePath);
		if (!content) continue;
		records.push({
			sourceId: `sharpshooter:${name}`,
			kind: "decision",
			content,
			sourceRef: filePath,
			scope,
			trust: "user",
			contentFingerprint: fingerprintStable({ kind: "decision", content, scope, name }),
		});
	}
	return {
		manifest: {
			formatVersion: MEMORY_EXPORT_FORMAT_VERSION,
			backend: "sharpshooter",
			exportedAt: new Date().toISOString(),
			scope,
			complete: true,
			omittedCapabilities: ["entryDelete", "structuredSearch"],
			omittedFields: ["queue/", "state.json", "consolidate.lock"],
			contentChecksum: checksumRecords(records),
			recordCount: records.length,
		},
		records,
	};
}

export function previewSharpshooterImport(
	context: MemoryBackendOperationContext,
	pkg: MemoryExportPackage,
): MemoryImportPreview {
	const warnings: string[] = [];
	const scope = context.cwd;
	if (pkg.manifest.formatVersion !== MEMORY_EXPORT_FORMAT_VERSION) {
		warnings.push(`unsupported formatVersion=${pkg.manifest.formatVersion}`);
	}
	if (pkg.manifest.backend !== "sharpshooter" && pkg.manifest.backend !== "local") {
		warnings.push(`package backend=${pkg.manifest.backend} importing into sharpshooter — content only`);
	}
	if (pkg.manifest.scope !== scope) {
		warnings.push(`scope mismatch package=${pkg.manifest.scope} target=${scope} — cross-project requires confirm`);
	}
	if (checksumRecords(pkg.records) !== pkg.manifest.contentChecksum) {
		warnings.push("contentChecksum mismatch");
	}
	const items = pkg.records.map(record => ({
		action: "create" as const,
		record,
		reason: "will_write_decision_file_only_with_replaceSystemArtifacts",
	}));
	return {
		formatVersion: MEMORY_EXPORT_FORMAT_VERSION,
		backend: "sharpshooter",
		scope,
		items,
		packageComplete: pkg.manifest.complete === true,
		warnings,
	};
}

export async function applySharpshooterImport(
	context: MemoryBackendOperationContext,
	preview: MemoryImportPreview,
	options?: { replaceSystemArtifacts?: boolean },
): Promise<MemoryImportApplyResult> {
	const created: string[] = [];
	const skipped: string[] = [];
	const conflicts: string[] = [];
	if (!options?.replaceSystemArtifacts) {
		for (const item of preview.items) {
			conflicts.push(item.record.sourceId ?? item.record.contentFingerprint);
		}
		return {
			created,
			skipped,
			conflicts,
			partial: false,
			message: "Decision files require replaceSystemArtifacts — refused silent overwrite",
		};
	}
	const allowed = new Set<string>(SHARPSHOOTER_MEMORY_FILES);
	for (const item of preview.items) {
		const name = item.record.sourceId?.replace(/^sharpshooter:/, "") ?? "";
		if (!allowed.has(name)) {
			skipped.push(item.record.sourceId ?? item.record.contentFingerprint);
			continue;
		}
		const dest = sharpshooterMemoryFilePath(context.agentDir, context.cwd, name);
		await Bun.write(dest, `${item.record.content.trim()}\n`);
		created.push(item.record.sourceId ?? name);
	}
	return { created, skipped, conflicts, partial: created.length > 0 && skipped.length > 0 };
}
