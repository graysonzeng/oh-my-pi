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
	/** Existing one-hop session artifact for this typed entry, when available. */
	artifactRef?: string;
	/** Immutable SHA-256 of the bytes addressed by artifactRef. */
	immutableSha256?: string;
	/** Handoff recovery refs carried by this typed entry. */
	handoffRefs?: string[];
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
	replacedEntryId: string;
	replacedPosition: number;
	retainedEntryId: string | null;
	transform: ContextOptimizationTransform;
	bucket: Exclude<ContextLedgerBucket, "output">;
	originalSha256: string;
	retainedSha256: string | null;
	immutableSha256: string;
	visibleSha256: string;
	originalBytes: number;
	visibleBytes: number;
	estimatedSavedBytes: number;
	artifactRef: string;
	estimatedSavedTokens: number;
	estimateVersion: typeof CONTEXT_ESTIMATE_VERSION;
}

export interface OptimizedContextEntries {
	entries: ContextEntry[];
	receipts: ContextOptimizationReceiptV1[];
}

export interface ContextBucketMeasurement {
	bytes: number | null;
	tokens: number | null;
	provenance: "estimate" | "provider_fact" | "unknown";
	measurement: typeof CONTEXT_ESTIMATE_VERSION | "provider_usage" | "unknown";
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
	plannedProvider: string;
	plannedModel: string;
	resolvedProvider: string | null;
	resolvedModel: string | null;
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
		if (!/^artifact:\/\/\d+$/.test(stored.uri)) return null;
		if (stored.sha256 !== sha256 || !(await artifact.verify(stored.uri, sha256))) return null;
		return stored;
	} catch {
		return null;
	}
}

interface RetainedContextEntry {
	id: string;
	artifactRef?: string;
	immutableSha256?: string;
}

export async function optimizeContextEntries(
	entries: readonly ContextEntry[],
	artifact: ContextArtifactAdapter,
): Promise<OptimizedContextEntries> {
	const firstByHash = new Map<string, RetainedContextEntry>();
	const optimized: ContextEntry[] = [];
	const receipts: ContextOptimizationReceiptV1[] = [];

	for (const [position, entry] of entries.entries()) {
		const originalSha256 = sha256Hex(entry.content);
		const retained = DEDUPE_KINDS[entry.kind] ? firstByHash.get(originalSha256) : undefined;
		const transform: ContextOptimizationTransform | null = retained
			? "dedupe_exact"
			: entry.kind === "tool_result" && entry.replaceable === true
				? "artifact_ref"
				: null;

		if (!transform) {
			optimized.push({ ...entry });
			if (DEDUPE_KINDS[entry.kind] && !retained) {
				firstByHash.set(originalSha256, {
					id: entry.id,
					artifactRef: entry.artifactRef,
					immutableSha256: entry.immutableSha256,
				});
			}
			continue;
		}

		let stored: ContextArtifactRecord | null = null;
		if (
			retained?.artifactRef &&
			retained.immutableSha256 === originalSha256 &&
			/^artifact:\/\/\d+$/.test(retained.artifactRef) &&
			(await artifact.verify(retained.artifactRef, originalSha256))
		) {
			stored = { uri: retained.artifactRef, sha256: originalSha256 };
		} else {
			stored = await persistAndVerify(entry, originalSha256, artifact);
		}
		if (!stored) {
			optimized.push({ ...entry });
			continue;
		}

		const content = `[context ref: ${stored.uri} sha256:${stored.sha256}]`;
		const originalBytes = Buffer.byteLength(entry.content, "utf8");
		const visibleBytes = Buffer.byteLength(content, "utf8");
		optimized.push({ ...entry, content, artifactRef: stored.uri, immutableSha256: stored.sha256 });
		receipts.push({
			schemaVersion: 1,
			kind: "context_optimization_receipt",
			entryId: entry.id,
			replacedEntryId: entry.id,
			replacedPosition: position,
			retainedEntryId: retained?.id ?? null,
			transform,
			bucket: entry.bucket,
			originalSha256,
			retainedSha256: retained ? originalSha256 : null,
			immutableSha256: stored.sha256,
			visibleSha256: sha256Hex(content),
			originalBytes,
			visibleBytes,
			estimatedSavedBytes: Math.max(0, originalBytes - visibleBytes),
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
	bucketText.set("output", input.output !== undefined ? [input.output] : []);

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
		plannedProvider: input.provider,
		plannedModel: input.model,
		resolvedProvider: null,
		resolvedModel: null,
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
		artifactRefs: [
			...new Set([...(input.artifactRefs ?? []), ...input.entries.flatMap(entry => entry.artifactRef ?? [])]),
		],
		handoffRefs: [
			...new Set([...(input.handoffRefs ?? []), ...input.entries.flatMap(entry => entry.handoffRefs ?? [])]),
		],
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
		  }
		| null
		| undefined,
	options: {
		cacheReadObservable?: boolean;
		cacheWriteObservable?: boolean;
		resolvedProvider?: string;
		resolvedModel?: string;
		recoverableOutput?: string;
	} = {},
): ContextLedgerV1 {
	const mergeMetric = (current: ContextProviderMetric, value: number | null | undefined): ContextProviderMetric =>
		typeof value === "number" && Number.isFinite(value) ? providerMetric(value) : current;
	const outputTokens = mergeMetric(ledger.providerUsage.outputTokens, usage?.output);
	let output = ledger.buckets.output;
	if (outputTokens.provenance === "provider_fact") {
		output = {
			bytes: options.recoverableOutput === undefined ? null : Buffer.byteLength(options.recoverableOutput, "utf8"),
			tokens: outputTokens.value,
			provenance: "provider_fact",
			measurement: "provider_usage",
		};
	} else if (options.recoverableOutput !== undefined) {
		output = estimateMeasurement(options.recoverableOutput);
	} else {
		output = { bytes: null, tokens: null, provenance: "unknown", measurement: "unknown" };
	}
	const inputTokens = mergeMetric(ledger.providerUsage.inputTokens, usage?.input);
	return {
		...ledger,
		resolvedProvider: options.resolvedProvider ?? ledger.resolvedProvider,
		resolvedModel: options.resolvedModel ?? ledger.resolvedModel,
		buckets: { ...ledger.buckets, output },
		providerUsage: {
			inputTokens,
			outputTokens,
			cacheReadTokens:
				options.cacheReadObservable === true
					? mergeMetric(ledger.providerUsage.cacheReadTokens, usage?.cacheRead)
					: ledger.providerUsage.cacheReadTokens,
			cacheWriteTokens:
				options.cacheWriteObservable === true
					? mergeMetric(ledger.providerUsage.cacheWriteTokens, usage?.cacheWrite)
					: ledger.providerUsage.cacheWriteTokens,
			uncachedInputTokens: mergeMetric(ledger.providerUsage.uncachedInputTokens, usage?.input),
		},
	};
}
