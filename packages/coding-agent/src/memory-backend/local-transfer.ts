/**
 * Local MemoryBackend export / preview / import.
 *
 * Traverses getMemoryRoot artifacts (learned.md, memory_summary.md, MEMORY.md).
 * Does not use search() — search is not available on local and must not fake
 * a full export. Entry delete is unsupported (clear remains whole-backend).
 *
 * Intentionally avoids importing `memories/index` (heavy session/natives graph);
 * path layout matches `getMemoryRoot` / `learned.md` conventions.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getMemoriesDir } from "@oh-my-pi/pi-utils/dirs";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import { fingerprintStable } from "../latency/stable-serialize";
import { normalizeScopeCwd } from "../memories/storage";
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
const LEARNED = "learned.md";
const SUMMARY = "memory_summary.md";
const MEMORY_MD = "MEMORY.md";

function encodeProjectPath(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** Same layout as memories.getMemoryRoot — kept local to avoid heavy imports. */
export function localMemoryRoot(agentDir: string, cwd: string): string {
	return path.join(getMemoriesDir(agentDir), encodeProjectPath(normalizeScopeCwd(cwd)));
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
	return cwd;
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

function recordFromFile(input: {
	sourceId: string;
	kind: MemoryExportRecord["kind"];
	content: string;
	scope: string;
	trust: MemoryExportRecord["trust"];
	sourceRef: string;
}): MemoryExportRecord {
	return {
		sourceId: input.sourceId,
		kind: input.kind,
		content: input.content,
		sourceRef: input.sourceRef,
		scope: input.scope,
		trust: input.trust,
		contentFingerprint: fingerprintStable({ kind: input.kind, content: input.content, scope: input.scope }),
	};
}

function neutralizeLessonLine(text: string): string {
	return text
		.replace(/[\p{Cc}\p{Cf}]/gu, " ")
		.replace(/[<>`]/g, "")
		.replace(/~{2,}/g, "~")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 2000);
}

/** Append one lesson line; skip if an identical bullet already exists. */
async function appendLearnedLesson(root: string, content: string): Promise<"created" | "skipped"> {
	const cleaned = neutralizeLessonLine(content);
	if (!cleaned) return "skipped";
	const line = `- ${cleaned}`;
	const filePath = path.join(root, LEARNED);
	await fs.mkdir(root, { recursive: true });
	let existing = "";
	try {
		existing = await Bun.file(filePath).text();
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}
	if (existing.split("\n").some(row => row.trim() === line)) {
		return "skipped";
	}
	const next = existing.trim().length > 0 ? `${line}\n${existing.trim()}\n` : `${line}\n`;
	await Bun.write(filePath, next);
	return "created";
}

/** Export local memory root. Search-prefix results are never used. */
export async function exportLocalMemory(context: MemoryBackendOperationContext): Promise<MemoryExportPackage> {
	const root = localMemoryRoot(context.agentDir, context.cwd);
	const scope = scopeFor(context.cwd);
	const records: MemoryExportRecord[] = [];
	const omittedFields: string[] = [];

	const learned = await readOptionalText(path.join(root, LEARNED));
	if (learned) {
		const chunks = learned
			.split(/\n{2,}/)
			.map(c => c.trim())
			.filter(Boolean);
		if (chunks.length <= 1) {
			records.push(
				recordFromFile({
					sourceId: "local:learned.md",
					kind: "learning_candidate",
					content: learned,
					scope,
					trust: "learned_candidate",
					sourceRef: path.join(root, LEARNED),
				}),
			);
		} else {
			chunks.forEach((chunk, index) => {
				records.push(
					recordFromFile({
						sourceId: `local:learned.md#${index}`,
						kind: "learning_candidate",
						content: chunk,
						scope,
						trust: "learned_candidate",
						sourceRef: path.join(root, LEARNED),
					}),
				);
			});
		}
	}

	const summary = await readOptionalText(path.join(root, SUMMARY));
	if (summary) {
		records.push(
			recordFromFile({
				sourceId: "local:memory_summary.md",
				kind: "summary",
				content: summary,
				scope,
				trust: "system",
				sourceRef: path.join(root, SUMMARY),
			}),
		);
	}

	const memoryMd = await readOptionalText(path.join(root, MEMORY_MD));
	if (memoryMd) {
		records.push(
			recordFromFile({
				sourceId: "local:MEMORY.md",
				kind: "project_fact",
				content: memoryMd,
				scope,
				trust: "system",
				sourceRef: path.join(root, MEMORY_MD),
			}),
		);
	}

	omittedFields.push("skills/", "rollout_summaries/", "sqlite_index");

	const exportedAt = new Date().toISOString();
	return {
		manifest: {
			formatVersion: MEMORY_EXPORT_FORMAT_VERSION,
			backend: "local",
			exportedAt,
			scope,
			complete: true,
			omittedCapabilities: ["entryDelete", "structuredSearch"],
			omittedFields,
			contentChecksum: checksumRecords(records),
			recordCount: records.length,
		},
		records,
	};
}

export function previewLocalMemoryImport(
	context: MemoryBackendOperationContext,
	pkg: MemoryExportPackage,
): MemoryImportPreview {
	const warnings: string[] = [];
	const scope = scopeFor(context.cwd);
	if (pkg.manifest.formatVersion !== MEMORY_EXPORT_FORMAT_VERSION) {
		warnings.push(`unsupported formatVersion=${pkg.manifest.formatVersion}`);
	}
	if (pkg.manifest.backend !== "local") {
		warnings.push(`package backend=${pkg.manifest.backend} importing into local — content only`);
	}
	if (pkg.manifest.scope !== scope) {
		warnings.push(`scope mismatch package=${pkg.manifest.scope} target=${scope} — cross-project requires confirm`);
	}
	if (!pkg.manifest.complete) {
		warnings.push("package marked incomplete");
	}
	const expected = checksumRecords(pkg.records);
	if (expected !== pkg.manifest.contentChecksum) {
		warnings.push("contentChecksum mismatch");
	}

	const items = pkg.records.map(record => {
		if (record.scope !== scope && pkg.manifest.scope !== scope) {
			return {
				action: "conflict" as const,
				record,
				reason: "scope_conflict",
			};
		}
		return {
			action: "create" as const,
			record,
			reason: "will_append_via_local_save_owner",
		};
	});

	return {
		formatVersion: MEMORY_EXPORT_FORMAT_VERSION,
		backend: "local",
		scope,
		items,
		packageComplete: pkg.manifest.complete === true && warnings.every(w => !w.includes("incomplete")),
		warnings,
	};
}

/**
 * Apply a previewed import. Learning candidates append to learned.md with dedupe.
 * Summary/MEMORY.md writes require explicit replaceSystemArtifacts.
 */
export async function applyLocalMemoryImport(
	context: MemoryBackendOperationContext,
	preview: MemoryImportPreview,
	options?: { replaceSystemArtifacts?: boolean },
): Promise<MemoryImportApplyResult> {
	const created: string[] = [];
	const skipped: string[] = [];
	const conflicts: string[] = [];
	let partial = false;
	const root = localMemoryRoot(context.agentDir, context.cwd);

	for (const item of preview.items) {
		if (item.action === "skip") {
			skipped.push(item.record.sourceId ?? item.record.contentFingerprint);
			continue;
		}
		if (item.action === "conflict") {
			conflicts.push(item.record.sourceId ?? item.record.contentFingerprint);
			continue;
		}
		try {
			if (item.record.kind === "learning_candidate" || item.record.kind === "user_preference") {
				const outcome = await appendLearnedLesson(root, item.record.content);
				if (outcome === "created") {
					created.push(item.record.sourceId ?? item.record.contentFingerprint);
				} else {
					skipped.push(item.record.sourceId ?? item.record.contentFingerprint);
				}
				continue;
			}
			if (item.record.kind === "summary" || item.record.kind === "project_fact") {
				if (!options?.replaceSystemArtifacts) {
					conflicts.push(item.record.sourceId ?? item.record.contentFingerprint);
					continue;
				}
				await fs.mkdir(root, { recursive: true });
				const fileName = item.record.kind === "summary" ? SUMMARY : MEMORY_MD;
				await Bun.write(path.join(root, fileName), `${item.record.content.trim()}\n`);
				created.push(item.record.sourceId ?? fileName);
				continue;
			}
			skipped.push(item.record.sourceId ?? item.record.contentFingerprint);
		} catch {
			partial = true;
			conflicts.push(item.record.sourceId ?? item.record.contentFingerprint);
		}
	}

	return {
		created,
		skipped,
		conflicts,
		partial: partial || (created.length > 0 && conflicts.length > 0),
		message: partial ? "partial import — some records failed" : undefined,
	};
}
