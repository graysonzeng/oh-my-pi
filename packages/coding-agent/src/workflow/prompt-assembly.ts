/**
 * Cache-friendly stable prompt prefix assembly + receipt.
 *
 * Stable (fixed order): system_static → role_policy → tool_presentation → skill_catalog
 * Dynamic (fixed order): assignment → repo_map → handoff → history
 *
 * Workflow ID, attempt ID, wall-clock timestamps, and real-time budget hints must not
 * enter the stable prefix. Hash equality of the stable prefix is NOT proof of a provider
 * prompt-cache hit — SSOT for cache hits is provider-reported usage counters only.
 */

import { sha256Hex } from "./optimization-receipt";

export const PROMPT_ASSEMBLY_RECEIPT_VERSION = 1 as const;
export const PROMPT_ASSEMBLY_RECEIPT_KIND = "prompt_assembly_receipt" as const;

export type PromptSectionId =
	| "system_static"
	| "role_policy"
	| "tool_presentation"
	| "skill_catalog"
	| "assignment"
	| "repo_map"
	| "handoff"
	| "history";

export type PromptAuthority = "system" | "developer" | "user" | "tool" | "unknown";

export interface PromptSectionReceiptV1 {
	id: PromptSectionId;
	source: string | null;
	sha256: string;
	authority: PromptAuthority;
	stability: "stable" | "dynamic";
	bytes: number;
	/** Coarse UTF-8 byte estimate for comparisons only; provider usage remains authoritative. */
	tokenEstimate: number;
}

export type PromptLintCode =
	| "duplicate_section"
	| "stability_mismatch"
	| "unresolved_handlebars"
	| "contradictory_rfc2119";

export interface PromptLintIssue {
	code: PromptLintCode;
	sectionId: PromptSectionId;
	message: string;
}

export interface PromptSection {
	id: PromptSectionId;
	/** Content included in the assembled prompt. */
	content: string;
	/** When true, participates in stable prefix hash. */
	stable: boolean;
	/** Origin identifier persisted in receipts; null when a caller cannot identify it. */
	source?: string;
	/** Trust boundary for the section content. */
	authority?: PromptAuthority;
}

/**
 * Durable receipt for one prompt assembly.
 *
 * `cacheReadTokens` / `cacheWriteTokens` hold provider-reported cache counters when
 * observable (null when unknown — never invent zeros). Design-doc aliases
 * `providerCacheReadTokens` / `providerCacheWriteTokens` are optional mirrors set only
 * when cache is observable so consumers can read either name.
 */
export interface PromptAssemblyReceiptV1 {
	schemaVersion: typeof PROMPT_ASSEMBLY_RECEIPT_VERSION;
	kind: typeof PROMPT_ASSEMBLY_RECEIPT_KIND;
	sectionOrder: PromptSectionId[];
	sections: PromptSectionReceiptV1[];
	stableSha256: string;
	dynamicSha256: string;
	stableBytes: number;
	dynamicBytes: number;
	totalBytes: number;
	/**
	 * Provider cache counters when observable; null when provider does not expose them.
	 * Never invent zeros when unobservable.
	 */
	cacheReadTokens: number | null;
	cacheWriteTokens: number | null;
	/** Explicit observability flag — false means treat cache* as unknown. */
	cacheObservable: boolean;
	/** Alias of cacheReadTokens when observable (design-doc field name). */
	providerCacheReadTokens?: number | null;
	/** Alias of cacheWriteTokens when observable (design-doc field name). */
	providerCacheWriteTokens?: number | null;
}

export interface AssemblePromptInput {
	sections: PromptSection[];
	/** Provider-reported cache stats; omit or null when unknown. */
	cacheReadTokens?: number | null;
	cacheWriteTokens?: number | null;
	cacheObservable?: boolean;
}

export interface AssembledPrompt {
	/** Full prompt text in stable-then-dynamic section order. */
	text: string;
	stablePrefix: string;
	dynamicSuffix: string;
	receipt: PromptAssemblyReceiptV1;
}

/** Provider usage shapes that may carry cache counters (pi-ai Usage + raw Anthropic-style). */
export type ProviderCacheUsageLike = {
	cacheRead?: number | null;
	cacheWrite?: number | null;
	cache_read_input_tokens?: number | null;
	cache_creation_input_tokens?: number | null;
	providerCacheReadTokens?: number | null;
	providerCacheWriteTokens?: number | null;
};

export const STABLE_SECTION_ORDER: readonly PromptSectionId[] = [
	"system_static",
	"role_policy",
	"tool_presentation",
	"skill_catalog",
] as const;

export const DYNAMIC_SECTION_ORDER: readonly PromptSectionId[] = [
	"assignment",
	"repo_map",
	"handoff",
	"history",
] as const;

const STABLE_ORDER = STABLE_SECTION_ORDER;
const DYNAMIC_ORDER = DYNAMIC_SECTION_ORDER;

const STABLE_SECTION_IDS = new Set<PromptSectionId>(STABLE_SECTION_ORDER);
const UNRESOLVED_HANDLEBARS_PATTERN = /{{{?[^{}]+}?}}/;
const RFC2119_REQUIREMENT_PATTERN = /\b(MUST|SHOULD|MAY)(\s+NOT)?\s+([^\n.!?;]+)/gi;

/**
 * Deterministic preflight for assembled prompt sections.
 *
 * Content-level checks apply only to stable instructions. Dynamic assignment/history
 * may legitimately quote templates or contradictory text from the user/repository.
 */
export function lintPromptSections(sections: readonly PromptSection[]): PromptLintIssue[] {
	const issues: PromptLintIssue[] = [];
	const seen = new Set<PromptSectionId>();
	for (const section of sections) {
		if (seen.has(section.id)) {
			issues.push({
				code: "duplicate_section",
				sectionId: section.id,
				message: `Prompt section "${section.id}" appears more than once`,
			});
		}
		seen.add(section.id);

		const expectedStable = STABLE_SECTION_IDS.has(section.id);
		if (section.stable !== expectedStable) {
			issues.push({
				code: "stability_mismatch",
				sectionId: section.id,
				message: `Prompt section "${section.id}" must be ${expectedStable ? "stable" : "dynamic"}`,
			});
		}

		if (!expectedStable || !section.content) continue;
		if (UNRESOLVED_HANDLEBARS_PATTERN.test(section.content)) {
			issues.push({
				code: "unresolved_handlebars",
				sectionId: section.id,
				message: `Stable prompt section "${section.id}" contains an unresolved Handlebars token`,
			});
		}

		for (const paragraph of section.content.split(/\n\s*\n/)) {
			const requirements = new Map<string, Set<boolean>>();
			for (const match of paragraph.matchAll(RFC2119_REQUIREMENT_PATTERN)) {
				const modal = match[1]?.toUpperCase();
				const target = match[3]?.trim().replace(/\s+/g, " ").toLowerCase();
				if (!modal || !target) continue;
				const key = `${modal}:${target}`;
				const polarities = requirements.get(key) ?? new Set<boolean>();
				polarities.add(Boolean(match[2]));
				requirements.set(key, polarities);
			}
			if ([...requirements.values()].some(polarities => polarities.size > 1)) {
				issues.push({
					code: "contradictory_rfc2119",
					sectionId: section.id,
					message: `Stable prompt section "${section.id}" contains contradictory RFC 2119 requirements`,
				});
				break;
			}
		}
	}
	return issues;
}

function buildSectionReceipt(section: PromptSection): PromptSectionReceiptV1 {
	const bytes = Buffer.byteLength(section.content, "utf-8");
	return {
		id: section.id,
		source: section.source ?? null,
		sha256: sha256Hex(section.content),
		authority: section.authority ?? "unknown",
		stability: section.stable ? "stable" : "dynamic",
		bytes,
		tokenEstimate: Math.ceil(bytes / 4),
	};
}

function buildReceiptFields(
	sectionOrder: PromptSectionId[],
	sectionReceipts: PromptSectionReceiptV1[],
	stablePrefix: string,
	dynamicSuffix: string,
	text: string,
	cache: { cacheReadTokens: number | null; cacheWriteTokens: number | null; cacheObservable: boolean },
): PromptAssemblyReceiptV1 {
	const receipt: PromptAssemblyReceiptV1 = {
		schemaVersion: PROMPT_ASSEMBLY_RECEIPT_VERSION,
		kind: PROMPT_ASSEMBLY_RECEIPT_KIND,
		sectionOrder,
		sections: sectionReceipts,
		stableSha256: sha256Hex(stablePrefix),
		dynamicSha256: sha256Hex(dynamicSuffix),
		stableBytes: Buffer.byteLength(stablePrefix, "utf-8"),
		dynamicBytes: Buffer.byteLength(dynamicSuffix, "utf-8"),
		totalBytes: Buffer.byteLength(text, "utf-8"),
		cacheReadTokens: cache.cacheObservable ? cache.cacheReadTokens : null,
		cacheWriteTokens: cache.cacheObservable ? cache.cacheWriteTokens : null,
		cacheObservable: cache.cacheObservable,
	};
	if (cache.cacheObservable) {
		receipt.providerCacheReadTokens = cache.cacheReadTokens;
		receipt.providerCacheWriteTokens = cache.cacheWriteTokens;
	}
	return receipt;
}

/**
 * Assemble prompt with fixed section order.
 * Empty optional sections are skipped without reordering survivors.
 * Stable: static system → role/policy → tool presentation → skill catalog.
 * Dynamic: assignment → repo-map → handoff → history.
 */
export function assemblePrompt(input: AssemblePromptInput): AssembledPrompt {
	const lintIssues = lintPromptSections(input.sections);
	if (lintIssues.length > 0) {
		throw new Error(
			`Prompt assembly preflight failed:\n${lintIssues.map(issue => `- ${issue.code}: ${issue.message}`).join("\n")}`,
		);
	}
	const byId = new Map(input.sections.map(s => [s.id, s]));
	const stableParts: string[] = [];
	const dynamicParts: string[] = [];
	const sectionOrder: PromptSectionId[] = [];

	for (const id of STABLE_ORDER) {
		const s = byId.get(id);
		if (!s?.content) continue;
		stableParts.push(s.content);
		sectionOrder.push(id);
	}
	for (const id of DYNAMIC_ORDER) {
		const s = byId.get(id);
		if (!s?.content) continue;
		dynamicParts.push(s.content);
		sectionOrder.push(id);
	}

	const stablePrefix = stableParts.join("\n\n");
	const dynamicSuffix = dynamicParts.join("\n\n");
	const text = [stablePrefix, dynamicSuffix].filter(Boolean).join("\n\n");
	const sectionReceipts: PromptSectionReceiptV1[] = [];
	for (const id of sectionOrder) {
		const section = byId.get(id);
		if (section) sectionReceipts.push(buildSectionReceipt(section));
	}

	const cacheObservable = input.cacheObservable === true;
	const receipt = buildReceiptFields(sectionOrder, sectionReceipts, stablePrefix, dynamicSuffix, text, {
		cacheObservable,
		cacheReadTokens: cacheObservable ? (input.cacheReadTokens ?? null) : null,
		cacheWriteTokens: cacheObservable ? (input.cacheWriteTokens ?? null) : null,
	});

	return { text, stablePrefix, dynamicSuffix, receipt };
}

/**
 * Extract provider cache counters from a usage object without inventing zeros.
 * Observable only when at least one known cache field is present as a finite number.
 * Missing / non-object usage → unobservable (nulls).
 */
export function extractProviderCacheMetrics(usage: unknown): {
	cacheReadTokens: number | null;
	cacheWriteTokens: number | null;
	cacheObservable: boolean;
} {
	if (usage === null || usage === undefined || typeof usage !== "object") {
		return { cacheReadTokens: null, cacheWriteTokens: null, cacheObservable: false };
	}
	const u = usage as ProviderCacheUsageLike;
	const readRaw = u.cacheRead ?? u.cache_read_input_tokens ?? u.providerCacheReadTokens ?? undefined;
	const writeRaw = u.cacheWrite ?? u.cache_creation_input_tokens ?? u.providerCacheWriteTokens ?? undefined;

	const hasRead = typeof readRaw === "number" && Number.isFinite(readRaw);
	const hasWrite = typeof writeRaw === "number" && Number.isFinite(writeRaw);
	if (!hasRead && !hasWrite) {
		return { cacheReadTokens: null, cacheWriteTokens: null, cacheObservable: false };
	}
	return {
		cacheReadTokens: hasRead ? (readRaw as number) : null,
		cacheWriteTokens: hasWrite ? (writeRaw as number) : null,
		cacheObservable: true,
	};
}

/**
 * Attach provider-reported cache counters onto an existing assembly receipt.
 * Prepare-time receipts start unobservable; call this after a real usage object exists.
 * Does not invent zeros when usage has no cache fields.
 */
export function withProviderCacheMetrics(receipt: PromptAssemblyReceiptV1, usage: unknown): PromptAssemblyReceiptV1 {
	const metrics = extractProviderCacheMetrics(usage);
	if (!metrics.cacheObservable) {
		// Preserve existing observability if already set; otherwise keep nulls.
		if (!receipt.cacheObservable) {
			return {
				...receipt,
				cacheReadTokens: null,
				cacheWriteTokens: null,
				cacheObservable: false,
				providerCacheReadTokens: undefined,
				providerCacheWriteTokens: undefined,
			};
		}
		return receipt;
	}
	return {
		...receipt,
		cacheReadTokens: metrics.cacheReadTokens,
		cacheWriteTokens: metrics.cacheWriteTokens,
		cacheObservable: true,
		providerCacheReadTokens: metrics.cacheReadTokens,
		providerCacheWriteTokens: metrics.cacheWriteTokens,
	};
}

/**
 * Build cache metrics for reporting: null when not observable.
 * Hash match of stable prefix ≠ provider cache hit.
 */
export function cacheMetricsFromReceipt(receipt: PromptAssemblyReceiptV1): {
	cacheReadTokens: number | null;
	cacheWriteTokens: number | null;
	cacheObservable: boolean;
	stableSha256: string;
	stableBytes: number;
	dynamicBytes: number;
} {
	return {
		cacheReadTokens: receipt.cacheObservable ? receipt.cacheReadTokens : null,
		cacheWriteTokens: receipt.cacheObservable ? receipt.cacheWriteTokens : null,
		cacheObservable: receipt.cacheObservable,
		stableSha256: receipt.stableSha256,
		stableBytes: receipt.stableBytes,
		dynamicBytes: receipt.dynamicBytes,
	};
}

/**
 * Locate UTF-8 byte offsets for each included section in the assembled text.
 * Useful for tests and analysis of the stable/dynamic boundary.
 */
export function sectionByteBoundaries(
	assembled: AssembledPrompt,
	sections: PromptSection[],
): Array<{ id: PromptSectionId; start: number; end: number; bytes: number }> {
	const byId = new Map(sections.map(s => [s.id, s]));
	const out: Array<{ id: PromptSectionId; start: number; end: number; bytes: number }> = [];
	let cursor = 0;
	let first = true;
	for (const id of assembled.receipt.sectionOrder) {
		const s = byId.get(id);
		if (!s?.content) continue;
		if (!first) cursor += Buffer.byteLength("\n\n", "utf-8");
		first = false;
		const bytes = Buffer.byteLength(s.content, "utf-8");
		out.push({ id, start: cursor, end: cursor + bytes, bytes });
		cursor += bytes;
	}
	return out;
}
