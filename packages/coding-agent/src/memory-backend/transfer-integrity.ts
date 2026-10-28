/**
 * Shared integrity + authorization helpers for memory export/import.
 *
 * Security decisions use structured validation results — never warning-text
 * substring matching. Checksums cover actual record content; in-package
 * fingerprints are re-verified, never trusted alone.
 */
import { fingerprintStable } from "../latency/stable-serialize";
import { redactMemorySecrets } from "./redact";
import {
	MEMORY_EXPORT_FORMAT_VERSION,
	type MemoryExportPackage,
	type MemoryExportRecord,
	type MemoryImportAction,
	type MemoryImportPreviewItem,
} from "./transfer-types";

export type TransferValidationCode =
	| "ok"
	| "unsupported_format_version"
	| "malformed_package"
	| "checksum_mismatch"
	| "fingerprint_mismatch"
	| "record_structure_invalid"
	| "scope_conflict"
	| "confirm_binding_required"
	| "confirm_binding_mismatch"
	| "backend_mismatch"
	| "pkg_required"
	| "preview_package_mismatch"
	| "intra_package_conflict";

export interface TransferValidationIssue {
	code: TransferValidationCode;
	message: string;
	sourceId?: string;
}

export interface TransferValidationResult {
	ok: boolean;
	issues: TransferValidationIssue[];
	/** Recomputed checksum over actual content (when package is well-formed). */
	computedChecksum?: string;
}

const RECORD_KINDS = new Set(["user_preference", "project_fact", "decision", "learning_candidate", "summary", "other"]);
const TRUST_LEVELS = new Set(["user", "learned_candidate", "system", "unknown"]);

/** Redact then fingerprint — export must never fingerprint raw secrets. */
export function fingerprintRecordContent(input: {
	kind: MemoryExportRecord["kind"];
	content: string;
	scope: string;
	sourceId?: string;
}): string {
	const content = redactMemorySecrets(input.content);
	return fingerprintStable({
		kind: input.kind,
		content,
		scope: input.scope,
		sourceId: input.sourceId ?? null,
	});
}

/** Package checksum over actual bodies — not over trusted-in fingerprints. */
export function checksumPackageRecords(records: readonly MemoryExportRecord[]): string {
	return fingerprintStable(
		records.map(r => ({
			id: r.sourceId ?? null,
			kind: r.kind,
			scope: r.scope,
			trust: r.trust,
			content: r.content,
		})),
	);
}

export function buildExportRecord(input: {
	sourceId: string;
	kind: MemoryExportRecord["kind"];
	/** Raw content — redacted before fingerprint + stored body. */
	content: string;
	scope: string;
	trust: MemoryExportRecord["trust"];
	sourceRef?: string;
	createdAt?: string;
	updatedAt?: string;
	applicableVersion?: string;
	supersedes?: string;
}): MemoryExportRecord {
	const content = redactMemorySecrets(input.content);
	return {
		sourceId: input.sourceId,
		kind: input.kind,
		content,
		sourceRef: input.sourceRef,
		scope: input.scope,
		trust: input.trust,
		createdAt: input.createdAt,
		updatedAt: input.updatedAt,
		applicableVersion: input.applicableVersion,
		supersedes: input.supersedes,
		contentFingerprint: fingerprintRecordContent({
			kind: input.kind,
			content,
			scope: input.scope,
			sourceId: input.sourceId,
		}),
	};
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

export function validateExportPackageStructure(pkg: unknown): TransferValidationResult {
	const issues: TransferValidationIssue[] = [];
	if (!pkg || typeof pkg !== "object") {
		return { ok: false, issues: [{ code: "malformed_package", message: "package is not an object" }] };
	}
	const candidate = pkg as MemoryExportPackage;
	if (!candidate.manifest || typeof candidate.manifest !== "object" || !Array.isArray(candidate.records)) {
		return {
			ok: false,
			issues: [{ code: "malformed_package", message: "manifest/records missing or wrong type" }],
		};
	}
	if (candidate.manifest.formatVersion !== MEMORY_EXPORT_FORMAT_VERSION) {
		issues.push({
			code: "unsupported_format_version",
			message: `unsupported formatVersion=${String(candidate.manifest.formatVersion)}`,
		});
	}
	if (!isNonEmptyString(candidate.manifest.backend)) {
		issues.push({ code: "malformed_package", message: "manifest.backend missing" });
	}
	if (!isNonEmptyString(candidate.manifest.scope)) {
		issues.push({ code: "malformed_package", message: "manifest.scope missing" });
	}
	if (typeof candidate.manifest.contentChecksum !== "string") {
		issues.push({ code: "malformed_package", message: "manifest.contentChecksum missing" });
	}
	if (
		typeof candidate.manifest.recordCount !== "number" ||
		candidate.manifest.recordCount !== candidate.records.length
	) {
		issues.push({
			code: "malformed_package",
			message: `recordCount=${String(candidate.manifest.recordCount)} !== records.length=${candidate.records.length}`,
		});
	}

	for (const [index, record] of candidate.records.entries()) {
		const id = typeof record?.sourceId === "string" ? record.sourceId : `index:${index}`;
		if (!record || typeof record !== "object") {
			issues.push({ code: "record_structure_invalid", message: "record is not an object", sourceId: id });
			continue;
		}
		if (!RECORD_KINDS.has(record.kind)) {
			issues.push({
				code: "record_structure_invalid",
				message: `invalid kind=${String(record.kind)}`,
				sourceId: id,
			});
		}
		if (!TRUST_LEVELS.has(record.trust)) {
			issues.push({
				code: "record_structure_invalid",
				message: `invalid trust=${String(record.trust)}`,
				sourceId: id,
			});
		}
		if (typeof record.content !== "string") {
			issues.push({ code: "record_structure_invalid", message: "content must be string", sourceId: id });
		}
		if (!isNonEmptyString(record.scope)) {
			issues.push({ code: "record_structure_invalid", message: "scope missing", sourceId: id });
		}
		if (typeof record.contentFingerprint !== "string") {
			issues.push({ code: "record_structure_invalid", message: "contentFingerprint missing", sourceId: id });
		} else if (typeof record.content === "string" && isNonEmptyString(record.scope)) {
			const expected = fingerprintRecordContent({
				kind: record.kind,
				content: record.content,
				scope: record.scope,
				sourceId: record.sourceId,
			});
			if (expected !== record.contentFingerprint) {
				issues.push({
					code: "fingerprint_mismatch",
					message: "contentFingerprint does not match actual content",
					sourceId: id,
				});
			}
		}
	}

	// Intra-package identity collisions for single-slot artifacts (same sourceId /
	// kind+slot with divergent bodies) — last-wins would silently drop content.
	const identityBodies = new Map<string, string>();
	for (const [index, record] of candidate.records.entries()) {
		if (!record || typeof record !== "object" || typeof record.content !== "string") continue;
		const identity = intraPackageIdentity(record, index);
		if (!identity) continue;
		const prior = identityBodies.get(identity);
		if (prior === undefined) {
			identityBodies.set(
				identity,
				record.contentFingerprint ??
					fingerprintRecordContent({
						kind: record.kind,
						content: record.content,
						scope: record.scope ?? "",
						sourceId: record.sourceId,
					}),
			);
			continue;
		}
		const current =
			record.contentFingerprint ??
			fingerprintRecordContent({
				kind: record.kind,
				content: record.content,
				scope: record.scope ?? "",
				sourceId: record.sourceId,
			});
		if (prior !== current) {
			issues.push({
				code: "intra_package_conflict",
				message: `duplicate identity ${identity} with divergent bodies`,
				sourceId: typeof record.sourceId === "string" ? record.sourceId : `index:${index}`,
			});
		}
	}

	let computedChecksum: string | undefined;
	if (issues.every(i => i.code !== "malformed_package" && i.code !== "record_structure_invalid")) {
		computedChecksum = checksumPackageRecords(candidate.records);
		if (computedChecksum !== candidate.manifest.contentChecksum) {
			issues.push({
				code: "checksum_mismatch",
				message: "contentChecksum does not match actual record bodies",
			});
		}
	}

	const blocking = issues.filter(i => i.code !== "ok");
	return { ok: blocking.length === 0, issues: blocking, computedChecksum };
}

/**
 * Identity key for single-slot artifacts that must not appear twice with
 * different bodies in one package (MEMORY.md / summary / sharpshooter files).
 * Learning candidates may share kind but use distinct sourceIds — only collide
 * when sourceId matches.
 */
export function intraPackageIdentity(
	record: Pick<MemoryExportRecord, "sourceId" | "kind">,
	index: number,
): string | null {
	if (typeof record.sourceId === "string" && record.sourceId.length > 0) {
		return `id:${record.sourceId}`;
	}
	if (record.kind === "summary" || record.kind === "project_fact" || record.kind === "decision") {
		return `kind:${record.kind}`;
	}
	return `index:${index}`;
}

/**
 * Bind preview items to the verified package: same length, matching
 * sourceId/fingerprint/content per item. Apply must write package bodies only.
 */
export function assertPreviewBoundToPackage(
	pkg: MemoryExportPackage,
	preview: { items: readonly MemoryImportPreviewItem[] },
): TransferValidationResult {
	const issues: TransferValidationIssue[] = [];
	if (preview.items.length !== pkg.records.length) {
		issues.push({
			code: "preview_package_mismatch",
			message: `preview items=${preview.items.length} !== package records=${pkg.records.length}`,
		});
		return { ok: false, issues };
	}
	const byFingerprint = new Map(pkg.records.map(r => [r.contentFingerprint, r]));
	for (const [index, item] of preview.items.entries()) {
		const pkgRecord = pkg.records[index]!;
		const previewRecord = item.record;
		const id = previewRecord.sourceId ?? pkgRecord.sourceId ?? `index:${index}`;
		if ((previewRecord.sourceId ?? null) !== (pkgRecord.sourceId ?? null)) {
			issues.push({
				code: "preview_package_mismatch",
				message: `item[${index}] sourceId diverged from package`,
				sourceId: id,
			});
			continue;
		}
		if (previewRecord.contentFingerprint !== pkgRecord.contentFingerprint) {
			issues.push({
				code: "preview_package_mismatch",
				message: `item[${index}] contentFingerprint diverged from package`,
				sourceId: id,
			});
			continue;
		}
		if (previewRecord.content !== pkgRecord.content) {
			issues.push({
				code: "preview_package_mismatch",
				message: `item[${index}] content body diverged from package`,
				sourceId: id,
			});
			continue;
		}
		if (previewRecord.scope !== pkgRecord.scope || previewRecord.kind !== pkgRecord.kind) {
			issues.push({
				code: "preview_package_mismatch",
				message: `item[${index}] scope/kind diverged from package`,
				sourceId: id,
			});
			continue;
		}
		// Defense: fingerprint must still resolve to the same package record.
		if (byFingerprint.get(previewRecord.contentFingerprint) !== pkgRecord) {
			issues.push({
				code: "preview_package_mismatch",
				message: `item[${index}] fingerprint does not uniquely bind to package record`,
				sourceId: id,
			});
		}
	}
	return { ok: issues.length === 0, issues };
}

/**
 * Confirm binding for cross-scope apply: source scope + target scope + package
 * checksum + preview action plan. A bare `--confirm-cross-scope` boolean is not
 * authorization.
 */
export function buildConfirmBinding(input: {
	sourceScope: string;
	targetScope: string;
	contentChecksum: string;
	items: readonly Pick<MemoryImportPreviewItem, "action" | "reason">[];
}): string {
	return fingerprintStable({
		v: 1,
		sourceScope: input.sourceScope,
		targetScope: input.targetScope,
		contentChecksum: input.contentChecksum,
		plan: input.items.map(i => ({ action: i.action, reason: i.reason })),
	});
}

export function scopeConflicts(recordScope: string, targetScope: string): boolean {
	return recordScope !== targetScope;
}

export function classifyScopeAction(
	recordScope: string,
	targetScope: string,
	manifestScope: string,
): { action: MemoryImportAction; reason: string } | null {
	if (!scopeConflicts(recordScope, targetScope)) return null;
	// Same-project package claiming target scope cannot smuggle a foreign record.
	if (manifestScope === targetScope) {
		return { action: "conflict", reason: "record_scope_conflict" };
	}
	// Cross-project package: do not short-circuit — caller continues with normal
	// create/skip/overwrite planning; apply still requires confirm binding.
	return null;
}

/** Hard apply gate — rejects packages that only warned previously. */
export function assertPackageApplyable(
	pkg: MemoryExportPackage,
	targetScope: string,
	options?: { confirmBinding?: string; preview?: { items: MemoryImportPreviewItem[]; confirmBinding?: string } },
): TransferValidationResult {
	const structural = validateExportPackageStructure(pkg);
	if (!structural.ok) return structural;

	const issues: TransferValidationIssue[] = [...structural.issues];
	if (options?.preview) {
		const bound = assertPreviewBoundToPackage(pkg, options.preview);
		issues.push(...bound.issues);
	}
	const crossScope = pkg.manifest.scope !== targetScope;
	if (crossScope) {
		const expected =
			options?.preview?.confirmBinding ??
			buildConfirmBinding({
				sourceScope: pkg.manifest.scope,
				targetScope,
				contentChecksum: pkg.manifest.contentChecksum,
				items: options?.preview?.items ?? [],
			});
		if (!options?.confirmBinding) {
			issues.push({
				code: "confirm_binding_required",
				message: "cross-scope import requires confirm binding from preview",
			});
		} else if (options.confirmBinding !== expected) {
			issues.push({
				code: "confirm_binding_mismatch",
				message: "confirm binding does not match source/target/preview plan",
			});
		}
	}
	return { ok: issues.length === 0, issues, computedChecksum: structural.computedChecksum };
}
