/**
 * Fixed-task benchmark suite contracts for per-model optimization measurement.
 * Runner never mutates default profiles or production routes.
 */

import type { ToolOptimizationReceiptV1 } from "../optimization-receipt";

export type BenchmarkVariantKind = "baseline" | "optimized";

/** Fact vs exact bytes vs estimate vs unknown — report fields must use these. */
export type MetricProvenance = "provider_fact" | "exact" | "estimate" | "unknown";

export interface MetricValue<T> {
	value: T | null;
	provenance: MetricProvenance;
}

export interface BenchmarkCase {
	id: string;
	/** Human label for scorecards. */
	name: string;
	/** Fixed request text. */
	request: string;
	/** Optional fixed base commit / fixture repo id. */
	baseCommit?: string;
	repoFixture?: string;
	allowedPaths: string[];
	forbiddenPaths: string[];
	verificationCommands: string[];
	/** Minimum repetitions per variant (design: ≥3). */
	repetitions: number;
}

export interface BenchmarkSuite {
	id: string;
	name: string;
	schemaVersion: 1;
	cases: BenchmarkCase[];
}

export interface BenchmarkRunFingerprint {
	suiteId: string;
	caseId: string;
	variant: BenchmarkVariantKind;
	/** Stable hash of case inputs (request, paths, commit). */
	caseFingerprint: string;
	/** Profile / strategy id used for optimized variant. */
	profileId?: string;
	/** sha256 of tool strategy JSON when optimized. */
	strategyFingerprint?: string;
}

export interface StageRunMetrics {
	profileId?: string;
	provider?: string | null;
	model?: string | null;
	/** Wall duration of the stage in ms (exact when measured). */
	durationMs: MetricValue<number>;
	/** Aggregate tool wall time when measured. */
	toolTimeMs: MetricValue<number>;
	schemaRetries: MetricValue<number>;
	fallbacks: MetricValue<number>;
	toolCalls: MetricValue<number>;
	compressionReceipts: ToolOptimizationReceiptV1[];
	/** Scope artifact id when computed. */
	scopeArtifactId?: string | null;
}

export interface TokenBucketMetrics {
	inputTokens: MetricValue<number>;
	outputTokens: MetricValue<number>;
	cacheReadTokens: MetricValue<number>;
	cacheWriteTokens: MetricValue<number>;
	/** null when provider does not expose cost. */
	costUsd: MetricValue<number>;
	/** Exact measured prompt section sizes (bytes). */
	systemPromptBytes: MetricValue<number>;
	toolSchemaBytes: MetricValue<number>;
	historyBytes: MetricValue<number>;
	repoMapBytes: MetricValue<number>;
	toolResultBytes: MetricValue<number>;
	contextEvictedBytes: MetricValue<number>;
	/** Estimated tokens (bytes/4) — always provenance=estimate when set. */
	estimatedTotalTokens: MetricValue<number>;
	/** Provider TTFT — null when unobservable. */
	ttftMs: MetricValue<number>;
	/** Provider queue time — null when unobservable. */
	queueMs: MetricValue<number>;
	/**
	 * Whether the provider exposed cache read/write counters.
	 * false → cache* metrics stay null with provenance unknown.
	 */
	cacheObservable: boolean;
}

export interface BenchmarkRunResult {
	fingerprint: BenchmarkRunFingerprint;
	repetition: number;
	passed: boolean;
	qualityScore: number | null;
	tokens: TokenBucketMetrics;
	stage: StageRunMetrics;
	/** Scope status from ScopeMetricsV1 when available. */
	scopeStatus?: "pass" | "warning" | "hard_fail" | null;
	error?: string;
	/** Wall clock for this repetition. */
	durationMs: number;
}

export interface BenchmarkVariantSummary {
	variant: BenchmarkVariantKind;
	caseId: string;
	runs: BenchmarkRunResult[];
	passRate: number;
	meanDurationMs: number;
	meanEstimatedTokens: number | null;
}

export interface BenchmarkScorecard {
	schemaVersion: 1;
	suiteId: string;
	generatedAt: string;
	summaries: BenchmarkVariantSummary[];
	/** True when any live model quality is unknown (fake-runtime only). */
	liveQualityUnknown: boolean;
	notes: string[];
}

export interface BenchmarkQualityGate {
	/** Absolute pass-rate floor. */
	minPassRate: number;
	/** Max allowed pass-rate drop (pp) of optimized vs baseline. */
	maxPassRateDropPp: number;
	/** Max allowed quality score drop (pp). */
	maxQualityDropPp: number;
}

export interface BenchmarkGateResult {
	passed: boolean;
	reasons: string[];
}
