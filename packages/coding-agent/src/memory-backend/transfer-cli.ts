/**
 * User-facing memory transfer helpers for `/memory export` and import preview/apply.
 * Does not invent a second memory system. Apply never executes record content.
 * Cross-scope authorization uses confirm bindings from preview — never warning text.
 */
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import type { MemoryBackend, MemoryBackendOperationContext } from "./types";
import type { MemoryExportPackage, MemoryImportApplyResult, MemoryImportPreview } from "./transfer-types";

/** Shared flag parse for ACP + TUI `/memory import-apply`. */
export function parseMemoryImportApplyArgs(tokens: readonly string[]): {
	filePath?: string;
	confirmCrossScope: boolean;
	/** Explicit binding from preview (`--confirm-cross-scope=<token>`). */
	confirmBinding?: string;
	replaceSystemArtifacts: boolean;
} {
	let confirmBinding: string | undefined;
	let confirmCrossScope = false;
	for (const token of tokens) {
		if (token === "--confirm-cross-scope") {
			confirmCrossScope = true;
			continue;
		}
		if (token.startsWith("--confirm-cross-scope=")) {
			confirmCrossScope = true;
			confirmBinding = token.slice("--confirm-cross-scope=".length);
			continue;
		}
	}
	return {
		confirmCrossScope,
		confirmBinding,
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
		text: `Wrote ${pkg.manifest.recordCount} records to ${resolved} (complete=${pkg.manifest.complete}). Cross-project import still requires confirm binding from preview.`,
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
	options?: { confirmCrossScope?: boolean; confirmBinding?: string; replaceSystemArtifacts?: boolean },
): Promise<string> {
	const caps = backend.transferCapabilities?.();
	if (!caps?.importApply || !backend.previewImport || !backend.applyImport) {
		return `Memory import apply is unsupported for the ${backend.id} backend.`;
	}
	const pkg = await readExportPackage(filePath);
	if (!pkg) return `Could not read export package: ${filePath}`;
	const preview = await backend.previewImport(context, pkg);
	if (preview.blockingIssues.length > 0) {
		return [
			"Import refused — package failed integrity validation. Nothing was written.",
			...preview.blockingIssues.map(i => `  ${i}`),
		].join("\n");
	}
	if (preview.requiresCrossScopeConfirm) {
		const binding = options?.confirmBinding;
		if (!options?.confirmCrossScope || !binding || binding !== preview.confirmBinding) {
			return [
				"Cross-project import requires --confirm-cross-scope=<binding> matching the preview token.",
				`preview confirmBinding=${preview.confirmBinding ?? "(unavailable)"}`,
				"Nothing was written.",
			].join("\n");
		}
	}
	const result = await backend.applyImport(context, preview, {
		replaceSystemArtifacts: options?.replaceSystemArtifacts === true,
		confirmBinding: options?.confirmBinding,
		pkg,
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
	const counts = { create: 0, skip: 0, conflict: 0, overwrite: 0 };
	for (const item of preview.items) counts[item.action]++;
	return [
		`import preview backend=${preview.backend} scope=${preview.scope} sourceScope=${preview.sourceScope} complete=${preview.packageComplete}`,
		`create=${counts.create} skip=${counts.skip} conflict=${counts.conflict} overwrite=${counts.overwrite}`,
		preview.requiresCrossScopeConfirm
			? `requiresCrossScopeConfirm=true confirmBinding=${preview.confirmBinding}`
			: "requiresCrossScopeConfirm=false",
		...preview.blockingIssues.map(w => `blocking: ${w}`),
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
		`import apply created=${result.created.length} skipped=${result.skipped.length} conflicts=${result.conflicts.length} overwritten=${result.overwritten?.length ?? 0} errors=${result.errors.length} partial=${result.partial}`,
		result.writtenIds && result.writtenIds.length > 0 ? `writtenIds=${result.writtenIds.join(",")}` : "",
		...result.errors.map(e => `  error\t${e.id}\t${e.error}`),
		result.message ?? "",
	]
		.filter(Boolean)
		.join("\n");
}
