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

/** Task category for fixed suite composition (3/3/2/2/2). */
export type BenchmarkCaseCategory = "bug_fix" | "feature" | "research_plan" | "code_review" | "multi_turn";

export interface BenchmarkCase {
	id: string;
	/** Human label for scorecards. */
	name: string;
	/** Fixed request text. */
	request: string;
	/** Task category for suite composition checks. */
	category: BenchmarkCaseCategory;
	/** Explicit success criteria for the case. */
	successCriteria: string[];
	/** Optional fixed base commit / fixture repo id. */
	baseCommit?: string;
	repoFixture?: string;
	/** Optional human note for intended public mini-repo (not required at test time). */
	publicRepoNote?: string;
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
	/** Stable suite version stamp for fingerprints / reports. */
	suiteVersion: string;
	cases: BenchmarkCase[];
}

/** Single ablation lever under test. Combo runs use fingerprint form `combo:a+b`. */
export type BenchmarkActiveLever =
	| "prompt_overlay"
	| "thinking_sampling"
	| "tool_surface"
	| "structured_tier"
	| "context_cache"
	| "runtime_completion"
	| "profile_strategy"
	| "none"
	| (string & {});

/**
 * Stable identity + policy stamp for one case×variant run.
 * Optional fields stay null/unknown when not supplied — never invent timestamps.
 */
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
	/** Exact provider identity — null when unknown. */
	provider: string | null;
	model: string | null;
	checkpoint: string | null;
	/** API / transport id (e.g. responses, messages, chat_completions). */
	api: string | null;
	/** Host adapter id / version. */
	adapter: string | null;
	/** Stream / event parser id / version. */
	parser: string | null;
	/** ModelFactsV1 fingerprint when compiled policy is in play. */
	modelFactsFingerprint: string | null;
	taskPolicyFingerprint: string | null;
	sessionStateFingerprint: string | null;
	/** Compiled policy content hash (receipt-level). */
	compiledPolicyFingerprint: string | null;
	/** Durable compiled policy receipt id when available. */
	compiledPolicyReceiptId: string | null;
	/**
	 * Ordinary paired run: at most one lever name (or null/none).
	 * Combination run: `combo:sorted+levers` when explicitly flagged.
	 */
	activeLever: string | null;
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
	/** Duplicate read of the same path when measured; null when unobserved. */
	duplicateReadCount: MetricValue<number>;
	/** Duplicate grep of the same pattern/path when measured; null when unobserved. */
	duplicateGrepCount: MetricValue<number>;
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
	/**
	 * First-attempt pass for this repetition when the runtime reports it.
	 * null when unobserved (typical fake-runtime path).
	 */
	firstPassed: boolean | null;
	qualityScore: number | null;
	tokens: TokenBucketMetrics;
	stage: StageRunMetrics;
	/**
	 * Scope status from ScopeMetricsV1 when available.
	 * Canonical: adhered | warning | violation | indeterminate.
	 * Legacy dual-read also accepts pass | hard_fail.
	 */
	scopeStatus?: "adhered" | "warning" | "violation" | "indeterminate" | "pass" | "hard_fail" | null;
	error?: string;
	/** Wall clock for this repetition. */
	durationMs: number;
}

export interface BenchmarkVariantSummary {
	variant: BenchmarkVariantKind;
	caseId: string;
	category?: BenchmarkCaseCategory;
	runs: BenchmarkRunResult[];
	/** Final pass rate across repetitions. */
	passRate: number;
	/** First-pass rate when any run reports firstPassed; null when unobserved. */
	firstPassRate: number | null;
	/** Mean qualityScore when reported; null when unobserved. */
	meanQualityScore: number | null;
	meanDurationMs: number;
	meanEstimatedTokens: number | null;
	meanToolResultBytes: number | null;
	meanSystemPromptBytes: number | null;
	meanToolSchemaBytes: number | null;
	meanHistoryBytes: number | null;
	meanRepoMapBytes: number | null;
	meanContextEvictedBytes: number | null;
	meanInputTokens: number | null;
	meanOutputTokens: number | null;
	meanCacheReadTokens: number | null;
	meanCostUsd: number | null;
	meanSchemaRetries: number | null;
	meanFallbacks: number | null;
	meanToolCalls: number | null;
	meanDuplicateReads: number | null;
	meanDuplicateGreps: number | null;
}

export interface BenchmarkScorecard {
	schemaVersion: 1;
	suiteId: string;
	suiteVersion: string;
	generatedAt: string;
	summaries: BenchmarkVariantSummary[];
	/** True when any live model quality is unknown (fake-runtime only). */
	liveQualityUnknown: boolean;
	notes: string[];
	/** Associated compiled policy receipt id when runs share one. */
	compiledPolicyReceiptId?: string | null;
	/** Associated compiled policy fingerprint when runs share one. */
	compiledPolicyFingerprint?: string | null;
	/** Active lever stamp mirrored from run fingerprints when uniform. */
	activeLever?: string | null;
	/** True when this scorecard came from an explicit combination run. */
	combinationRun?: boolean;
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

/** Metric groups for Markdown / structured comparison reports. */
export type BenchmarkMetricGroup = "quality" | "token_measured" | "provider_actual" | "performance";

export interface BenchmarkComparisonRow {
	/** Human-readable metric name. */
	metric: string;
	group: BenchmarkMetricGroup;
	caseId: string | null;
	baseline: number | null;
	optimized: number | null;
	/** optimized - baseline (or rate delta in percentage points when unit is "pp"). */
	delta: number | null;
	/** ✅ improve / ❌ regress / — neutral or missing. */
	marker: "✅" | "❌" | "—";
	unit: string;
	/** Lower is better (tokens, duration, retries); higher is better (pass rate). */
	higherIsBetter: boolean;
	/** When true, quality gate failed on this row (e.g. pass-rate drop >3pp). */
	gateFail?: boolean;
}

/**
 * Full paired report: scorecard + comparison rows + gate.
 * Distinguishes exact / provider_fact / estimate / unknown via underlying metrics.
 */
export interface BenchmarkReport {
	schemaVersion: 1;
	suiteId: string;
	suiteVersion: string;
	generatedAt: string;
	liveQualityUnknown: boolean;
	scorecard: BenchmarkScorecard;
	comparison: BenchmarkComparisonRow[];
	gate: BenchmarkGateResult;
	notes: string[];
	/** Associated compiled policy receipt id when present. */
	compiledPolicyReceiptId?: string | null;
	/** Associated compiled policy fingerprint when present. */
	compiledPolicyFingerprint?: string | null;
	activeLever?: string | null;
	combinationRun?: boolean;
}
