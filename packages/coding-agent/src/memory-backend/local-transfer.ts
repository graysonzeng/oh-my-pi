/**
 * Local MemoryBackend export / preview / import.
 *
 * Traverses getMemoryRoot artifacts (learned.md, memory_summary.md, MEMORY.md).
 * Does not use search() — search is not available on local and must not fake
 * a full export. Entry delete is unsupported (clear remains whole-backend).
 *
 * Uses the real `saveLearnedLesson` owner (redaction + serial queue). Integrity
 * decisions use transfer-integrity helpers — never warning-text parsing.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import {
	getMemoryRoot,
	listExistingLearnedBodies,
	MAX_LEARNED_CONTENT_CHARS,
	normalizeLearnedText,
	saveLearnedLesson,
	splitLearnedLessonBullets,
} from "../memories/learned";
import { normalizeScopeCwd } from "../memories/storage";
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

const LEARNED = "learned.md";
const SUMMARY = "memory_summary.md";
const MEMORY_MD = "MEMORY.md";

/** Same layout as memories.getMemoryRoot — re-exported for tests/CLI. */
export function localMemoryRoot(agentDir: string, cwd: string): string {
	return getMemoryRoot(agentDir, cwd);
}

export function localMemoryTransferCapabilities(): MemoryTransferCapabilities {
	return defaultMemoryTransferCapabilities({
		export: true,
		importPreview: true,
		importApply: true,
		entryDelete: false,
		fullTraverse: true,
	});
}

function scopeFor(cwd: string): string {
	return normalizeScopeCwd(cwd);
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

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

/** Export local memory root. Search-prefix results are never used. */
export async function exportLocalMemory(context: MemoryBackendOperationContext): Promise<MemoryExportPackage> {
	const root = localMemoryRoot(context.agentDir, context.cwd);
	const scope = scopeFor(context.cwd);
	const records = [];
	const omittedFields: string[] = [];

	const learnedPath = path.join(root, LEARNED);
	const learned = await readOptionalText(learnedPath);
	if (learned) {
		const lessons = splitLearnedLessonBullets(learned);
		if (lessons.length === 0) {
			// Non-bullet prose — keep as a single learning candidate with provenance.
			records.push(
				buildExportRecord({
					sourceId: "local:learned.md",
					kind: "learning_candidate",
					content: learned,
					scope,
					trust: "learned_candidate",
					sourceRef: learnedPath,
				}),
			);
		} else {
			lessons.forEach((lesson, index) => {
				records.push(
					buildExportRecord({
						sourceId: `local:learned.md#${index}`,
						kind: "learning_candidate",
						content: lesson,
						scope,
						trust: "learned_candidate",
						sourceRef: learnedPath,
					}),
				);
			});
		}
	}

	const summaryPath = path.join(root, SUMMARY);
	const summary = await readOptionalText(summaryPath);
	if (summary) {
		records.push(
			buildExportRecord({
				sourceId: "local:memory_summary.md",
				kind: "summary",
				content: summary,
				scope,
				trust: "system",
				sourceRef: summaryPath,
			}),
		);
	}

	const memoryMdPath = path.join(root, MEMORY_MD);
	const memoryMd = await readOptionalText(memoryMdPath);
	if (memoryMd) {
		records.push(
			buildExportRecord({
				sourceId: "local:MEMORY.md",
				kind: "project_fact",
				content: memoryMd,
				scope,
				trust: "system",
				sourceRef: memoryMdPath,
			}),
		);
	}

	// Out-of-surface assets that exist make the package incomplete — do not claim
	// complete=true while leaving data on the floor.
	for (const name of ["skills", "rollout_summaries"] as const) {
		if (await pathExists(path.join(root, name))) omittedFields.push(`${name}/`);
	}
	if (await pathExists(path.join(root, "index.sqlite"))) omittedFields.push("sqlite_index");

	const exportedAt = new Date().toISOString();
	return {
		manifest: {
			formatVersion: MEMORY_EXPORT_FORMAT_VERSION,
			backend: "local",
			exportedAt,
			scope,
			complete: omittedFields.length === 0,
			omittedCapabilities: ["entryDelete", "structuredSearch"],
			omittedFields,
			contentChecksum: checksumPackageRecords(records),
			recordCount: records.length,
		},
		records,
	};
}

async function targetSystemArtifactText(
	context: MemoryBackendOperationContext,
	kind: "summary" | "project_fact",
): Promise<string | null> {
	const root = localMemoryRoot(context.agentDir, context.cwd);
	const fileName = kind === "summary" ? SUMMARY : MEMORY_MD;
	return readOptionalText(path.join(root, fileName));
}

/**
 * Preview import against the live target — reports real dup/conflict/overwrite.
 */
export async function previewLocalMemoryImport(
	context: MemoryBackendOperationContext,
	pkg: MemoryExportPackage,
): Promise<MemoryImportPreview> {
	const warnings: string[] = [];
	const blockingIssues: string[] = [];
	const scope = scopeFor(context.cwd);
	const structural = validateExportPackageStructure(pkg);
	for (const issue of structural.issues) {
		blockingIssues.push(`${issue.code}: ${issue.message}`);
	}
	if (pkg.manifest.backend !== "local") {
		warnings.push(`package backend=${pkg.manifest.backend} importing into local — content only`);
	}
	if (!pkg.manifest.complete) {
		warnings.push("package marked incomplete");
	}

	const existingLessons = structural.ok
		? await listExistingLearnedBodies(context.agentDir, context.cwd)
		: new Set<string>();

	const items: MemoryImportPreviewItem[] = [];
	if (structural.ok) {
		for (const record of pkg.records) {
			const scopeHit = classifyScopeAction(record.scope, scope, pkg.manifest.scope);
			if (scopeHit) {
				items.push({ action: scopeHit.action, record, reason: scopeHit.reason });
				continue;
			}
			if (record.kind === "learning_candidate" || record.kind === "user_preference") {
				const normalized = normalizeLearnedText(record.content, MAX_LEARNED_CONTENT_CHARS);
				if (!normalized) {
					items.push({ action: "skip", record, reason: "empty_after_owner_normalize" });
					continue;
				}
				if (existingLessons.has(normalized)) {
					items.push({ action: "skip", record, reason: "duplicate_lesson" });
					continue;
				}
				// Learning candidates stay candidates — never auto-activate as system facts.
				items.push({
					action: "create",
					record,
					reason: "append_via_saveLearnedLesson_owner",
				});
				continue;
			}
			if (record.kind === "summary" || record.kind === "project_fact") {
				const existing = await targetSystemArtifactText(context, record.kind);
				if (existing === null) {
					items.push({
						action: "create",
						record,
						reason: "system_artifact_missing_requires_replaceSystemArtifacts",
					});
				} else if (existing.trim() === record.content.trim()) {
					items.push({ action: "skip", record, reason: "identical_system_artifact" });
				} else {
					items.push({
						action: "overwrite",
						record,
						reason: "system_artifact_differs_requires_replaceSystemArtifacts",
					});
				}
				continue;
			}
			items.push({ action: "skip", record, reason: "unsupported_kind_for_local" });
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
		backend: "local",
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

/**
 * Apply a previewed import. Learning candidates append via saveLearnedLesson.
 * Summary/MEMORY.md writes require explicit replaceSystemArtifacts (formal activation).
 * Never throws away written IDs on a later failure — returns inspectable batch result.
 */
export async function applyLocalMemoryImport(
	context: MemoryBackendOperationContext,
	preview: MemoryImportPreview,
	options?: {
		replaceSystemArtifacts?: boolean;
		confirmBinding?: string;
		/** Original package for re-validation at the apply boundary. */
		pkg?: MemoryExportPackage;
	},
): Promise<MemoryImportApplyResult> {
	const created: string[] = [];
	const skipped: string[] = [];
	const conflicts: string[] = [];
	const overwritten: string[] = [];
	const errors: MemoryImportApplyResult["errors"] = [];
	const root = localMemoryRoot(context.agentDir, context.cwd);

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
		const gate = assertPackageApplyable(options.pkg, scopeFor(context.cwd), {
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
		try {
			if (item.record.kind === "learning_candidate" || item.record.kind === "user_preference") {
				const outcome = await saveLearnedLesson(context.agentDir, context.cwd, {
					content: item.record.content,
					source: item.record.sourceRef ?? item.record.sourceId,
				});
				if (outcome.stored > 0) {
					created.push(id);
				} else {
					skipped.push(id);
				}
				continue;
			}
			if (item.record.kind === "summary" || item.record.kind === "project_fact") {
				if (!options?.replaceSystemArtifacts) {
					conflicts.push(id);
					continue;
				}
				if (item.action !== "create" && item.action !== "overwrite") {
					conflicts.push(id);
					continue;
				}
				await fs.mkdir(root, { recursive: true });
				const fileName = item.record.kind === "summary" ? SUMMARY : MEMORY_MD;
				await Bun.write(path.join(root, fileName), `${item.record.content.trim()}\n`);
				if (item.action === "overwrite") overwritten.push(id);
				else created.push(id);
				continue;
			}
			skipped.push(id);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			errors.push({ id, error: message });
		}
	}

	const writtenIds = [...created, ...overwritten];
	const partial = errors.length > 0 || (writtenIds.length > 0 && conflicts.length > 0);
	return {
		created,
		skipped,
		conflicts,
		overwritten,
		errors,
		partial,
		writtenIds,
		message: partial
			? `partial import — written=${writtenIds.length} errors=${errors.length} conflicts=${conflicts.length}`
			: undefined,
	};
}
