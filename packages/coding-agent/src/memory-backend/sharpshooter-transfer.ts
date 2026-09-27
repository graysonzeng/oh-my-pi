/**
 * D4 second-seam transfer for the sharpshooter backend.
 * Traverses architecture.md / product.md / style.md — never search top-N.
 * Queue JSON and lock files are omitted (not a full knowledge-graph dump).
 *
 * Per-record scope checks, content checksums, consolidation lock, and
 * inspectable per-item errors (no throw that loses written IDs).
 *
 * Uses an exclusive lock file (not `@oh-my-pi/pi-utils` barrel / natives) so
 * transfer stays loadable without the native addon in unit tests.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import { sharpshooterLockPath, sharpshooterMemoryFilePath } from "../sharpshooter/paths";
import { SHARPSHOOTER_MEMORY_FILES } from "../sharpshooter/types";
import {
	assertPackageApplyable,
	buildConfirmBinding,
	buildExportRecord,
	checksumPackageRecords,
	classifyScopeAction,
	validateExportPackageStructure,
} from "./transfer-integrity";
import {
	defaultMemoryTransferCapabilities,
	MEMORY_EXPORT_FORMAT_VERSION,
	type MemoryExportPackage,
	type MemoryImportApplyResult,
	type MemoryImportPreview,
	type MemoryImportPreviewItem,
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

async function readOptionalText(filePath: string): Promise<string | null> {
	try {
		const text = (await Bun.file(filePath).text()).trim();
		return text.length > 0 ? text : null;
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
}

/** Exclusive lock file beside consolidate.lock — no natives dependency. */
async function withSharpshooterTransferLock<T>(agentDir: string, cwd: string, fn: () => Promise<T>): Promise<T> {
	const lockPath = `${sharpshooterLockPath(agentDir, cwd)}.transfer.lock`;
	await fs.mkdir(path.dirname(lockPath), { recursive: true });
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(lockPath, "wx");
	} catch (err) {
		const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
		if (code === "EEXIST") {
			throw new Error("sharpshooter transfer lock held — refuse concurrent apply");
		}
		throw err;
	}
	try {
		return await fn();
	} finally {
		await handle.close().catch(() => {});
		await fs.unlink(lockPath).catch(() => {});
	}
}

export async function exportSharpshooterMemory(context: MemoryBackendOperationContext): Promise<MemoryExportPackage> {
	const scope = context.cwd;
	const records = [];
	for (const name of SHARPSHOOTER_MEMORY_FILES) {
		const filePath = sharpshooterMemoryFilePath(context.agentDir, context.cwd, name);
		const content = await readOptionalText(filePath);
		if (!content) continue;
		records.push(
			buildExportRecord({
				sourceId: `sharpshooter:${name}`,
				kind: "decision",
				content,
				scope,
				trust: "user",
				sourceRef: filePath,
			}),
		);
	}
	// Queue/state/lock are out of transfer surface — declaring them omitted means
	// the package is not a full bank dump (complete=false).
	const omittedFields = ["queue/", "state.json", "consolidate.lock"];
	return {
		manifest: {
			formatVersion: MEMORY_EXPORT_FORMAT_VERSION,
			backend: "sharpshooter",
			exportedAt: new Date().toISOString(),
			scope,
			complete: false,
			omittedCapabilities: ["entryDelete", "structuredSearch"],
			omittedFields,
			contentChecksum: checksumPackageRecords(records),
			recordCount: records.length,
		},
		records,
	};
}

export async function previewSharpshooterImport(
	context: MemoryBackendOperationContext,
	pkg: MemoryExportPackage,
): Promise<MemoryImportPreview> {
	const warnings: string[] = [];
	const blockingIssues: string[] = [];
	const scope = context.cwd;
	const structural = validateExportPackageStructure(pkg);
	for (const issue of structural.issues) {
		blockingIssues.push(`${issue.code}: ${issue.message}`);
	}
	if (pkg.manifest.backend !== "sharpshooter" && pkg.manifest.backend !== "local") {
		warnings.push(`package backend=${pkg.manifest.backend} importing into sharpshooter — content only`);
	}
	if (!pkg.manifest.complete) {
		warnings.push("package marked incomplete (queue/state/lock omitted by design)");
	}

	const items: MemoryImportPreviewItem[] = [];
	if (structural.ok) {
		for (const record of pkg.records) {
			const scopeHit = classifyScopeAction(record.scope, scope, pkg.manifest.scope);
			if (scopeHit) {
				items.push({ action: scopeHit.action, record, reason: scopeHit.reason });
				continue;
			}
			const name = record.sourceId?.replace(/^sharpshooter:/, "") ?? "";
			const allowed = (SHARPSHOOTER_MEMORY_FILES as readonly string[]).includes(name);
			if (!allowed) {
				items.push({ action: "skip", record, reason: "unsupported_sharpshooter_file" });
				continue;
			}
			const existing = await readOptionalText(sharpshooterMemoryFilePath(context.agentDir, context.cwd, name));
			if (existing === null) {
				items.push({
					action: "create",
					record,
					reason: "decision_file_missing_requires_replaceSystemArtifacts",
				});
			} else if (existing.trim() === record.content.trim()) {
				items.push({ action: "skip", record, reason: "identical_decision_file" });
			} else {
				items.push({
					action: "overwrite",
					record,
					reason: "decision_file_differs_requires_replaceSystemArtifacts",
				});
			}
		}
	}

	const requiresCrossScopeConfirm = pkg.manifest.scope !== scope;
	const confirmBinding = requiresCrossScopeConfirm
		? buildConfirmBinding({
				sourceScope: pkg.manifest.scope,
				targetScope: scope,
				contentChecksum: pkg.manifest.contentChecksum,
				items,
			})
		: undefined;

	return {
		formatVersion: MEMORY_EXPORT_FORMAT_VERSION,
		backend: "sharpshooter",
		scope,
		sourceScope: pkg.manifest.scope,
		items,
		packageComplete: pkg.manifest.complete === true && structural.ok,
		warnings,
		blockingIssues,
		confirmBinding,
		requiresCrossScopeConfirm,
	};
}

export async function applySharpshooterImport(
	context: MemoryBackendOperationContext,
	preview: MemoryImportPreview,
	options?: {
		replaceSystemArtifacts?: boolean;
		confirmBinding?: string;
		pkg?: MemoryExportPackage;
	},
): Promise<MemoryImportApplyResult> {
	const created: string[] = [];
	const skipped: string[] = [];
	const conflicts: string[] = [];
	const overwritten: string[] = [];
	const errors: MemoryImportApplyResult["errors"] = [];

	if (preview.blockingIssues.length > 0) {
		return {
			created,
			skipped,
			conflicts: preview.items.map(i => i.record.sourceId ?? i.record.contentFingerprint),
			overwritten,
			errors: preview.blockingIssues.map(message => ({ id: "*", error: message })),
			partial: false,
			message: "import refused — package failed integrity validation",
			writtenIds: [],
		};
	}

	if (options?.pkg) {
		const gate = assertPackageApplyable(options.pkg, context.cwd, {
			confirmBinding: options.confirmBinding,
			preview,
		});
		if (!gate.ok) {
			return {
				created,
				skipped,
				conflicts: preview.items.map(i => i.record.sourceId ?? i.record.contentFingerprint),
				overwritten,
				errors: gate.issues.map(i => ({ id: i.sourceId ?? "*", error: `${i.code}: ${i.message}` })),
				partial: false,
				message: "import refused — apply-boundary validation failed",
				writtenIds: [],
			};
		}
	} else if (preview.requiresCrossScopeConfirm) {
		if (!options?.confirmBinding || options.confirmBinding !== preview.confirmBinding) {
			return {
				created,
				skipped,
				conflicts: preview.items.map(i => i.record.sourceId ?? i.record.contentFingerprint),
				overwritten,
				errors: [
					{
						id: "*",
						error: "confirm_binding_required: cross-scope import requires matching preview confirm binding",
					},
				],
				partial: false,
				message: "import refused — confirm binding missing or mismatched",
				writtenIds: [],
			};
		}
	}

	if (!options?.replaceSystemArtifacts) {
		for (const item of preview.items) {
			if (item.action === "skip") skipped.push(item.record.sourceId ?? item.record.contentFingerprint);
			else conflicts.push(item.record.sourceId ?? item.record.contentFingerprint);
		}
		return {
			created,
			skipped,
			conflicts,
			overwritten,
			errors,
			partial: false,
			writtenIds: [],
			message: "Decision files require replaceSystemArtifacts — refused silent overwrite",
		};
	}

	const allowed = new Set<string>(SHARPSHOOTER_MEMORY_FILES);
	try {
		await withSharpshooterTransferLock(context.agentDir, context.cwd, async () => {
			for (const item of preview.items) {
				const id = item.record.sourceId ?? item.record.contentFingerprint;
				if (item.action === "skip") {
					skipped.push(id);
					continue;
				}
				if (item.action === "conflict") {
					conflicts.push(id);
					continue;
				}
				const name = item.record.sourceId?.replace(/^sharpshooter:/, "") ?? "";
				if (!allowed.has(name)) {
					skipped.push(id);
					continue;
				}
				try {
					const dest = sharpshooterMemoryFilePath(context.agentDir, context.cwd, name);
					await Bun.write(dest, `${item.record.content.trim()}\n`);
					if (item.action === "overwrite") overwritten.push(id);
					else created.push(id);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					errors.push({ id, error: message });
				}
			}
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		errors.push({ id: "*", error: `consolidate_lock: ${message}` });
	}

	const writtenIds = [...created, ...overwritten];
	const partial = errors.length > 0 || (writtenIds.length > 0 && (skipped.length > 0 || conflicts.length > 0));
	return {
		created,
		skipped,
		conflicts,
		overwritten,
		errors,
		partial,
		writtenIds,
		message: partial
			? `partial import — written=${writtenIds.join(",") || "none"} errors=${errors.length}`
			: undefined,
	};
}
