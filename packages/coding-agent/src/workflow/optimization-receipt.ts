/**
 * Durable, versioned receipts for lossy tool-output transforms.
 * Recovery URI is only set when an artifact was actually persisted.
 */

export const TOOL_OPTIMIZATION_RECEIPT_KIND = "tool_optimization_receipt" as const;
export const TOOL_OPTIMIZATION_RECEIPT_VERSION = 1 as const;

export type ToolOptimizationTransform = "none" | "summarize" | "truncate" | "summarize+truncate" | "preserve_body";

export interface ToolOptimizationOmittedRange {
	/** 0-based inclusive start byte offset in original UTF-16 string indexing (JS). */
	start: number;
	/** Exclusive end. */
	end: number;
	reason: "summarize" | "truncate" | "noise_strip" | "byte_cap";
}

export interface ToolOptimizationReceiptV1 {
	schemaVersion: typeof TOOL_OPTIMIZATION_RECEIPT_VERSION;
	kind: typeof TOOL_OPTIMIZATION_RECEIPT_KIND;
	tool: string;
	transform: ToolOptimizationTransform;
	originalBytes: number;
	originalLines: number;
	visibleBytes: number;
	visibleLines: number;
	/** sha256 of original full text when known. */
	originalSha256: string;
	/** sha256 of model-visible text. */
	visibleSha256: string;
	omittedRanges: ToolOptimizationOmittedRange[];
	/** Present only when full text was actually saved; never a fabricated URI. */
	recoveryUri?: string;
	/** True when recoveryUri is set or transform did not drop content. */
	reversible: boolean;
	createdAt: string;
}

export interface WorkflowToolOptimizationResult {
	text: string;
	receipt?: ToolOptimizationReceiptV1;
}

/** Footer contract shared with bash enforceInlineByteCap / output-meta. */
export const RAW_OUTPUT_ARTIFACT_FOOTER_RE = /\[raw output: artifact:\/\/([^\]]+)\]\s*$/;

export function extractRawOutputFooter(text: string): { body: string; footer?: string; artifactId?: string } {
	const match = text.match(RAW_OUTPUT_ARTIFACT_FOOTER_RE);
	if (!match || match.index === undefined) return { body: text };
	return {
		body: text.slice(0, match.index).replace(/\n$/, ""),
		footer: match[0].trimEnd(),
		artifactId: match[1],
	};
}

/** Re-attach an existing recovery footer after a transform that may have dropped it. */
export function preserveRawOutputFooter(original: string, transformed: string): string {
	const { footer } = extractRawOutputFooter(original);
	if (!footer) return transformed;
	if (transformed.includes(footer) || /\[raw output: artifact:\/\//.test(transformed)) {
		return transformed;
	}
	const sep = transformed.endsWith("\n") ? "" : "\n";
	return `${transformed}${sep}${footer}`;
}

export function sha256Hex(content: string): string {
	return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}

export function buildToolOptimizationReceipt(input: {
	tool: string;
	transform: ToolOptimizationTransform;
	original: string;
	visible: string;
	recoveryUri?: string;
	omittedRanges?: ToolOptimizationOmittedRange[];
}): ToolOptimizationReceiptV1 {
	const originalLines = input.original.length === 0 ? 0 : input.original.split("\n").length;
	const visibleLines = input.visible.length === 0 ? 0 : input.visible.split("\n").length;
	const lossy = input.visible.length < input.original.length || input.transform !== "none";
	const recoveryUri = input.recoveryUri;
	return {
		schemaVersion: TOOL_OPTIMIZATION_RECEIPT_VERSION,
		kind: TOOL_OPTIMIZATION_RECEIPT_KIND,
		tool: input.tool,
		transform: input.transform,
		originalBytes: Buffer.byteLength(input.original, "utf-8"),
		originalLines,
		visibleBytes: Buffer.byteLength(input.visible, "utf-8"),
		visibleLines,
		originalSha256: sha256Hex(input.original),
		visibleSha256: sha256Hex(input.visible),
		omittedRanges: input.omittedRanges ?? [],
		recoveryUri,
		reversible: Boolean(recoveryUri) || !lossy || input.transform === "preserve_body",
		createdAt: new Date().toISOString(),
	};
}

/**
 * Optional adapter for persisting full tool output before a lossy transform.
 * Must return a real artifact id only after a successful write.
 */
export type ToolOutputArtifactAdapter = {
	saveRaw?: (toolName: string, fullText: string) => string | undefined | Promise<string | undefined>;
};
