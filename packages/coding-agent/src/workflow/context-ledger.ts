import { sha256Hex } from "./optimization-receipt";

export const CONTEXT_LEDGER_KIND = "context_ledger" as const;
export const CONTEXT_LEDGER_VERSION = 1 as const;
export const CONTEXT_ESTIMATE_VERSION = "estimate:utf8_bytes_div_4_v1" as const;

export type ContextLedgerBucket =
	| "system_static"
	| "role_policy"
	| "tool_schema"
	| "skill_catalog"
	| "assignment"
	| "repo_map"
	| "handoff"
	| "history"
	| "tool_results"
	| "artifacts"
	| "output";

export type ContextEntryKind = "attachment" | "reminder" | "skill_delta" | "tool_delta" | "tool_result" | "other";

export interface ContextEntry {
	id: string;
	bucket: Exclude<ContextLedgerBucket, "output">;
	kind: ContextEntryKind;
	content: string;
	/** Old tool results may be replaced; the current result remains inline. */
	replaceable?: boolean;
}

export interface ContextArtifactRecord {
	uri: string;
	sha256: string;
}

export interface ContextArtifactAdapter {
	persist(entry: ContextEntry, sha256: string): Promise<ContextArtifactRecord>;
	verify(uri: string, sha256: string): Promise<boolean>;
}

export type ContextOptimizationTransform = "dedupe_exact" | "artifact_ref";

export interface ContextOptimizationReceiptV1 {
	schemaVersion: 1;
	kind: "context_optimization_receipt";
	entryId: string;
	retainedEntryId: string | null;
	transform: ContextOptimizationTransform;
	originalSha256: string;
	visibleSha256: string;
	originalBytes: number;
	visibleBytes: number;
	artifactRef: string;
	estimatedSavedTokens: number;
	estimateVersion: typeof CONTEXT_ESTIMATE_VERSION;
}

export interface OptimizedContextEntries {
	entries: ContextEntry[];
	receipts: ContextOptimizationReceiptV1[];
}

export interface ContextBucketMeasurement {
	bytes: number;
	tokens: number;
	provenance: "estimate";
	measurement: typeof CONTEXT_ESTIMATE_VERSION;
}

export interface ContextProviderMetric {
	value: number | null;
	provenance: "provider_fact" | "unknown";
}

export interface ContextLedgerV1 {
	schemaVersion: typeof CONTEXT_LEDGER_VERSION;
	kind: typeof CONTEXT_LEDGER_KIND;
	requestId: string;
	provider: string;
	model: string;
	api: string;
	measurementVersion: typeof CONTEXT_ESTIMATE_VERSION;
	buckets: Record<ContextLedgerBucket, ContextBucketMeasurement>;
	providerUsage: {
		inputTokens: ContextProviderMetric;
		outputTokens: ContextProviderMetric;
		cacheReadTokens: ContextProviderMetric;
		cacheWriteTokens: ContextProviderMetric;
		uncachedInputTokens: ContextProviderMetric;
	};
	artifactRefs: string[];
	handoffRefs: string[];
	optimizationReceipts: ContextOptimizationReceiptV1[];
}

const DEDUPE_KINDS: Record<ContextEntryKind, boolean> = {
	attachment: true,
	reminder: true,
	skill_delta: true,
	tool_delta: true,
	tool_result: false,
	other: false,
};

function estimateMeasurement(content: string): ContextBucketMeasurement {
	const bytes = Buffer.byteLength(content, "utf8");
	return {
		bytes,
		tokens: Math.ceil(bytes / 4),
		provenance: "estimate",
		measurement: CONTEXT_ESTIMATE_VERSION,
	};
}

function providerMetric(value: number | null | undefined): ContextProviderMetric {
	return typeof value === "number" && Number.isFinite(value)
		? { value, provenance: "provider_fact" }
		: { value: null, provenance: "unknown" };
}

async function persistAndVerify(
	entry: ContextEntry,
	sha256: string,
	artifact: ContextArtifactAdapter,
): Promise<ContextArtifactRecord | null> {
	try {
		const stored = await artifact.persist(entry, sha256);
		if (stored.sha256 !== sha256 || !(await artifact.verify(stored.uri, sha256))) return null;
		return stored;
	} catch {
		return null;
	}
}

export async function optimizeContextEntries(
	entries: readonly ContextEntry[],
	artifact: ContextArtifactAdapter,
): Promise<OptimizedContextEntries> {
	const firstByHash = new Map<string, string>();
	const optimized: ContextEntry[] = [];
	const receipts: ContextOptimizationReceiptV1[] = [];

	for (const entry of entries) {
		const originalSha256 = sha256Hex(entry.content);
		const retainedEntryId = DEDUPE_KINDS[entry.kind] ? firstByHash.get(originalSha256) : undefined;
		const transform: ContextOptimizationTransform | null = retainedEntryId
			? "dedupe_exact"
			: entry.kind === "tool_result" && entry.replaceable === true
				? "artifact_ref"
				: null;

		if (!transform) {
			optimized.push({ ...entry });
			if (DEDUPE_KINDS[entry.kind] && !retainedEntryId) firstByHash.set(originalSha256, entry.id);
			continue;
		}

		const stored = await persistAndVerify(entry, originalSha256, artifact);
		if (!stored) {
			optimized.push({ ...entry });
			continue;
		}

		const content = `[context ref: ${stored.uri}]`;
		const originalBytes = Buffer.byteLength(entry.content, "utf8");
		const visibleBytes = Buffer.byteLength(content, "utf8");
		optimized.push({ ...entry, content });
		receipts.push({
			schemaVersion: 1,
			kind: "context_optimization_receipt",
			entryId: entry.id,
			retainedEntryId: retainedEntryId ?? null,
			transform,
			originalSha256,
			visibleSha256: sha256Hex(content),
			originalBytes,
			visibleBytes,
			artifactRef: stored.uri,
			estimatedSavedTokens: Math.max(0, Math.ceil(originalBytes / 4) - Math.ceil(visibleBytes / 4)),
			estimateVersion: CONTEXT_ESTIMATE_VERSION,
		});
	}

	return { entries: optimized, receipts };
}

export function buildContextLedger(input: {
	requestId: string;
	provider: string;
	model: string;
	api: string;
	entries: readonly ContextEntry[];
	output?: string;
	providerUsage?: {
		inputTokens?: number | null;
		outputTokens?: number | null;
		cacheReadTokens?: number | null;
		cacheWriteTokens?: number | null;
		uncachedInputTokens?: number | null;
	};
	artifactRefs?: readonly string[];
	handoffRefs?: readonly string[];
	optimizationReceipts?: readonly ContextOptimizationReceiptV1[];
}): ContextLedgerV1 {
	const bucketText = new Map<ContextLedgerBucket, string[]>();
	for (const entry of input.entries) {
		const contents = bucketText.get(entry.bucket) ?? [];
		contents.push(entry.content);
		bucketText.set(entry.bucket, contents);
	}
	bucketText.set("output", input.output ? [input.output] : []);

	const bucketIds: ContextLedgerBucket[] = [
		"system_static",
		"role_policy",
		"tool_schema",
		"skill_catalog",
		"assignment",
		"repo_map",
		"handoff",
		"history",
		"tool_results",
		"artifacts",
		"output",
	];
	const buckets = Object.fromEntries(
		bucketIds.map(bucket => [bucket, estimateMeasurement((bucketText.get(bucket) ?? []).join(""))]),
	) as Record<ContextLedgerBucket, ContextBucketMeasurement>;
	const usage = input.providerUsage;

	return {
		schemaVersion: CONTEXT_LEDGER_VERSION,
		kind: CONTEXT_LEDGER_KIND,
		requestId: input.requestId,
		provider: input.provider,
		model: input.model,
		api: input.api,
		measurementVersion: CONTEXT_ESTIMATE_VERSION,
		buckets,
		providerUsage: {
			inputTokens: providerMetric(usage?.inputTokens),
			outputTokens: providerMetric(usage?.outputTokens),
			cacheReadTokens: providerMetric(usage?.cacheReadTokens),
			cacheWriteTokens: providerMetric(usage?.cacheWriteTokens),
			uncachedInputTokens: providerMetric(usage?.uncachedInputTokens),
		},
		artifactRefs: [...(input.artifactRefs ?? [])],
		handoffRefs: [...(input.handoffRefs ?? [])],
		optimizationReceipts: [...(input.optimizationReceipts ?? [])],
	};
}

export function withContextProviderUsage(
	ledger: ContextLedgerV1,
	usage:
		| {
				input?: number | null;
				output?: number | null;
				cacheRead?: number | null;
				cacheWrite?: number | null;
				uncachedInput?: number | null;
		  }
		| null
		| undefined,
): ContextLedgerV1 {
	return {
		...ledger,
		providerUsage: {
			inputTokens: providerMetric(usage?.input),
			outputTokens: providerMetric(usage?.output),
			cacheReadTokens: providerMetric(usage?.cacheRead),
			cacheWriteTokens: providerMetric(usage?.cacheWrite),
			uncachedInputTokens: providerMetric(usage?.uncachedInput),
		},
	};
}
