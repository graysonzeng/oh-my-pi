/**
 * User-facing memory transfer helpers for `/memory export` and import preview/apply.
 * Does not invent a second memory system. Apply never executes record content.
 */
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import type { MemoryBackend, MemoryBackendOperationContext } from "./types";
import type { MemoryExportPackage, MemoryImportApplyResult, MemoryImportPreview } from "./transfer-types";

/** Shared flag parse for ACP + TUI `/memory import-apply`. */
export function parseMemoryImportApplyArgs(tokens: readonly string[]): {
	filePath?: string;
	confirmCrossScope: boolean;
	replaceSystemArtifacts: boolean;
} {
	return {
		confirmCrossScope: tokens.includes("--confirm-cross-scope"),
		replaceSystemArtifacts: tokens.includes("--replace-system"),
		filePath: tokens.find(token => token.length > 0 && !token.startsWith("--")),
	};
}

export async function exportMemoryPackage(
	backend: MemoryBackend,
	context: MemoryBackendOperationContext,
	destPath?: string,
): Promise<{ text: string; path?: string; unsupported?: boolean }> {
	const caps = backend.transferCapabilities?.();
	if (!caps?.export || !backend.exportRecords) {
		return {
			unsupported: true,
			text: `Memory export is unsupported for the ${backend.id} backend (search results are never a full export).`,
		};
	}
	const pkg = await backend.exportRecords(context);
	const body = `${JSON.stringify(pkg, null, "\t")}\n`;
	if (!destPath) {
		return {
			text: [
				`Exported ${pkg.manifest.recordCount} records from ${pkg.manifest.backend} (complete=${pkg.manifest.complete}).`,
				`omittedCapabilities: ${pkg.manifest.omittedCapabilities.join(", ") || "none"}`,
				`omittedFields: ${pkg.manifest.omittedFields.join(", ") || "none"}`,
				"",
				body,
			].join("\n"),
		};
	}
	const resolved = path.resolve(destPath);
	await Bun.write(resolved, body);
	return {
		path: resolved,
		text: `Wrote ${pkg.manifest.recordCount} records to ${resolved} (complete=${pkg.manifest.complete}). Cross-project import still requires confirm.`,
	};
}

export async function previewMemoryPackageFile(
	backend: MemoryBackend,
	context: MemoryBackendOperationContext,
	filePath: string,
): Promise<string> {
	const caps = backend.transferCapabilities?.();
	if (!caps?.importPreview || !backend.previewImport) {
		return `Memory import preview is unsupported for the ${backend.id} backend.`;
	}
	const pkg = await readExportPackage(filePath);
	if (!pkg) return `Could not read export package: ${filePath}`;
	const preview = await backend.previewImport(context, pkg);
	return formatImportPreview(preview);
}

export async function applyMemoryPackageFile(
	backend: MemoryBackend,
	context: MemoryBackendOperationContext,
	filePath: string,
	options?: { confirmCrossScope?: boolean; replaceSystemArtifacts?: boolean },
): Promise<string> {
	const caps = backend.transferCapabilities?.();
	if (!caps?.importApply || !backend.previewImport || !backend.applyImport) {
		return `Memory import apply is unsupported for the ${backend.id} backend.`;
	}
	const pkg = await readExportPackage(filePath);
	if (!pkg) return `Could not read export package: ${filePath}`;
	const preview = await backend.previewImport(context, pkg);
	const crossScope = preview.warnings.some(w => w.includes("scope mismatch"));
	if (crossScope && !options?.confirmCrossScope) {
		return "Cross-project import requires --confirm-cross-scope after reviewing the preview. Nothing was written.";
	}
	const result = await backend.applyImport(context, preview, {
		replaceSystemArtifacts: options?.replaceSystemArtifacts === true,
	});
	return formatImportApply(result);
}

async function readExportPackage(filePath: string): Promise<MemoryExportPackage | null> {
	try {
		const parsed = (await Bun.file(path.resolve(filePath)).json()) as MemoryExportPackage;
		if (!parsed?.manifest || !Array.isArray(parsed.records)) return null;
		return parsed;
	} catch (err) {
		if (isEnoent(err)) return null;
		return null;
	}
}

function formatImportPreview(preview: MemoryImportPreview): string {
	const counts = { create: 0, skip: 0, conflict: 0 };
	for (const item of preview.items) counts[item.action]++;
	return [
		`import preview backend=${preview.backend} scope=${preview.scope} complete=${preview.packageComplete}`,
		`create=${counts.create} skip=${counts.skip} conflict=${counts.conflict}`,
		...preview.warnings.map(w => `warning: ${w}`),
		...preview.items
			.slice(0, 20)
			.map(item => `  ${item.action}\t${item.record.sourceId ?? item.record.contentFingerprint}\t${item.reason}`),
		preview.items.length > 20 ? `  … ${preview.items.length - 20} more` : "",
	]
		.filter(Boolean)
		.join("\n");
}

function formatImportApply(result: MemoryImportApplyResult): string {
	return [
		`import apply created=${result.created.length} skipped=${result.skipped.length} conflicts=${result.conflicts.length} partial=${result.partial}`,
		result.message ?? "",
	]
		.filter(Boolean)
		.join("\n");
}
