/**
 * Cache-friendly stable prompt prefix assembly + receipt.
 * Dynamic IDs / timestamps / budget must not enter the stable prefix.
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

export interface PromptSection {
	id: PromptSectionId;
	/** Content included in the assembled prompt. */
	content: string;
	/** When true, participates in stable prefix hash. */
	stable: boolean;
}

export interface PromptAssemblyReceiptV1 {
	schemaVersion: typeof PROMPT_ASSEMBLY_RECEIPT_VERSION;
	kind: typeof PROMPT_ASSEMBLY_RECEIPT_KIND;
	sectionOrder: PromptSectionId[];
	stableSha256: string;
	dynamicSha256: string;
	stableBytes: number;
	dynamicBytes: number;
	totalBytes: number;
	/**
	 * Provider cache counters when observable; null when provider does not expose them.
	 * Never invent zeros.
	 */
	cacheReadTokens: number | null;
	cacheWriteTokens: number | null;
	/** Explicit observability flag — false means treat cache* as unknown. */
	cacheObservable: boolean;
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

const STABLE_ORDER: PromptSectionId[] = ["system_static", "role_policy", "tool_presentation", "skill_catalog"];
const DYNAMIC_ORDER: PromptSectionId[] = ["assignment", "repo_map", "handoff", "history"];

/**
 * Assemble prompt with fixed section order.
 * Stable: static system → role/policy → tool presentation → skill catalog.
 * Dynamic: assignment → repo-map → handoff → history.
 */
export function assemblePrompt(input: AssemblePromptInput): AssembledPrompt {
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

	const cacheObservable = input.cacheObservable === true;
	const receipt: PromptAssemblyReceiptV1 = {
		schemaVersion: PROMPT_ASSEMBLY_RECEIPT_VERSION,
		kind: PROMPT_ASSEMBLY_RECEIPT_KIND,
		sectionOrder,
		stableSha256: sha256Hex(stablePrefix),
		dynamicSha256: sha256Hex(dynamicSuffix),
		stableBytes: Buffer.byteLength(stablePrefix, "utf-8"),
		dynamicBytes: Buffer.byteLength(dynamicSuffix, "utf-8"),
		totalBytes: Buffer.byteLength(text, "utf-8"),
		cacheReadTokens: cacheObservable ? (input.cacheReadTokens ?? null) : null,
		cacheWriteTokens: cacheObservable ? (input.cacheWriteTokens ?? null) : null,
		cacheObservable,
	};

	return { text, stablePrefix, dynamicSuffix, receipt };
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
} {
	return {
		cacheReadTokens: receipt.cacheObservable ? receipt.cacheReadTokens : null,
		cacheWriteTokens: receipt.cacheObservable ? receipt.cacheWriteTokens : null,
		cacheObservable: receipt.cacheObservable,
		stableSha256: receipt.stableSha256,
	};
}
