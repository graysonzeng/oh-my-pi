/**
 * Pure benchmark runner: executes paired baseline/optimized cases via an injected runtime.
 * Never edits default-config profiles or production routes.
 */

import { sha256Hex } from "../optimization-receipt";
import { buildComparisonRows, exceedsDropPp, formatComparisonMarkdown } from "./report";
import type {
	BenchmarkCase,
	BenchmarkGateResult,
	BenchmarkQualityGate,
	BenchmarkReport,
	BenchmarkRunFingerprint,
	BenchmarkRunResult,
	BenchmarkScorecard,
	BenchmarkSuite,
	BenchmarkVariantKind,
	BenchmarkVariantSummary,
	MetricValue,
	StageRunMetrics,
	TokenBucketMetrics,
} from "./types";

export interface BenchmarkRuntimeRequest {
	case: BenchmarkCase;
	variant: BenchmarkVariantKind;
	repetition: number;
	fingerprint: BenchmarkRunFingerprint;
}

export interface BenchmarkRuntimeResponse {
	passed: boolean;
	/** First-attempt pass when known; omit/null when unobserved. */
	firstPassed?: boolean | null;
	qualityScore?: number | null;
	tokens?: Partial<TokenBucketMetrics>;
	stage?: Partial<StageRunMetrics>;
	scopeStatus?: BenchmarkRunResult["scopeStatus"];
	error?: string;
	durationMs?: number;
}

export type BenchmarkRuntime = (req: BenchmarkRuntimeRequest) => Promise<BenchmarkRuntimeResponse>;

export interface BenchmarkRunOptions {
	suite: BenchmarkSuite;
	runtime: BenchmarkRuntime;
	/** Which variants to run; default both. */
	variants?: BenchmarkVariantKind[];
	/** Profile id stamp for optimized fingerprints. */
	optimizedProfileId?: string;
	/** Strategy fingerprint string for optimized. */
	optimizedStrategyFingerprint?: string;
	/** Override min repetitions (still ≥ case.repetitions when higher). */
	minRepetitions?: number;
	/**
	 * When true, scorecard marks liveQualityUnknown=false (live model path).
	 * Default: true (fake / no live quality).
	 */
	liveQualityUnknown?: boolean;
	/** Optional notes appended to the scorecard. */
	notes?: string[];
}

function unknownMetric<T>(): MetricValue<T> {
	return { value: null, provenance: "unknown" };
}

function defaultTokens(): TokenBucketMetrics {
	return {
		inputTokens: unknownMetric(),
		outputTokens: unknownMetric(),
		cacheReadTokens: unknownMetric(),
		cacheWriteTokens: unknownMetric(),
		costUsd: unknownMetric(),
		systemPromptBytes: unknownMetric(),
		toolSchemaBytes: unknownMetric(),
		historyBytes: unknownMetric(),
		repoMapBytes: unknownMetric(),
		toolResultBytes: unknownMetric(),
		contextEvictedBytes: unknownMetric(),
		estimatedTotalTokens: unknownMetric(),
		ttftMs: unknownMetric(),
		queueMs: unknownMetric(),
		cacheObservable: false,
	};
}

function defaultStage(): StageRunMetrics {
	return {
		durationMs: unknownMetric(),
		toolTimeMs: unknownMetric(),
		schemaRetries: unknownMetric(),
		fallbacks: unknownMetric(),
		toolCalls: unknownMetric(),
		duplicateReadCount: unknownMetric(),
		duplicateGrepCount: unknownMetric(),
		compressionReceipts: [],
		scopeArtifactId: null,
	};
}

export function caseFingerprint(c: BenchmarkCase): string {
	const payload = JSON.stringify({
		id: c.id,
		request: c.request,
		category: c.category,
		successCriteria: c.successCriteria,
		baseCommit: c.baseCommit ?? null,
		repoFixture: c.repoFixture ?? null,
		allowedPaths: [...c.allowedPaths].sort(),
		forbiddenPaths: [...c.forbiddenPaths].sort(),
		verificationCommands: c.verificationCommands,
	});
	return sha256Hex(payload);
}

function buildFingerprint(
	suite: BenchmarkSuite,
	c: BenchmarkCase,
	variant: BenchmarkVariantKind,
	opts: BenchmarkRunOptions,
): BenchmarkRunFingerprint {
	return {
		suiteId: suite.id,
		caseId: c.id,
		variant,
		caseFingerprint: caseFingerprint(c),
		profileId: variant === "optimized" ? opts.optimizedProfileId : "baseline",
		strategyFingerprint: variant === "optimized" ? opts.optimizedStrategyFingerprint : "none",
	};
}

function mergeTokens(partial?: Partial<TokenBucketMetrics>): TokenBucketMetrics {
	const base = defaultTokens();
	if (!partial) return base;
	return {
		...base,
		...partial,
		cacheObservable: partial.cacheObservable ?? base.cacheObservable,
	};
}

function mergeStage(partial?: Partial<StageRunMetrics>): StageRunMetrics {
	const base = defaultStage();
	if (!partial) return base;
	return {
		...base,
		...partial,
		compressionReceipts: partial.compressionReceipts ?? base.compressionReceipts,
		duplicateReadCount: partial.duplicateReadCount ?? base.duplicateReadCount,
		duplicateGrepCount: partial.duplicateGrepCount ?? base.duplicateGrepCount,
	};
}

/** Run all cases × variants × repetitions. */
export async function runBenchmarkSuite(opts: BenchmarkRunOptions): Promise<BenchmarkRunResult[]> {
	const variants = opts.variants ?? (["baseline", "optimized"] as BenchmarkVariantKind[]);
	const results: BenchmarkRunResult[] = [];

	for (const c of opts.suite.cases) {
		const reps = Math.max(c.repetitions, opts.minRepetitions ?? 0, 1);
		for (const variant of variants) {
			const fingerprint = buildFingerprint(opts.suite, c, variant, opts);
			for (let repetition = 1; repetition <= reps; repetition++) {
				const started = performance.now();
				try {
					const response = await opts.runtime({
						case: c,
						variant,
						repetition,
						fingerprint,
					});
					const durationMs = response.durationMs ?? performance.now() - started;
					results.push({
						fingerprint,
						repetition,
						passed: response.passed,
						firstPassed: response.firstPassed ?? null,
						qualityScore: response.qualityScore ?? null,
						tokens: mergeTokens(response.tokens),
						stage: mergeStage(response.stage),
						scopeStatus: response.scopeStatus ?? null,
						error: response.error,
						durationMs,
					});
				} catch (err) {
					results.push({
						fingerprint,
						repetition,
						passed: false,
						firstPassed: null,
						qualityScore: null,
						tokens: defaultTokens(),
						stage: defaultStage(),
						scopeStatus: null,
						error: err instanceof Error ? err.message : String(err),
						durationMs: performance.now() - started,
					});
				}
			}
		}
	}
	return results;
}

function meanOf(values: Array<number | null | undefined>): number | null {
	const nums = values.filter((v): v is number => typeof v === "number");
	if (nums.length === 0) return null;
	return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export function summarizeResults(results: BenchmarkRunResult[], suite?: BenchmarkSuite): BenchmarkVariantSummary[] {
	const categoryByCase = new Map(suite?.cases.map(c => [c.id, c.category]) ?? []);
	const groups = new Map<string, BenchmarkRunResult[]>();
	for (const r of results) {
		const key = `${r.fingerprint.caseId}::${r.fingerprint.variant}`;
		const list = groups.get(key) ?? [];
		list.push(r);
		groups.set(key, list);
	}
	const summaries: BenchmarkVariantSummary[] = [];
	for (const [, runs] of groups) {
		const first = runs[0]!;
		const passed = runs.filter(r => r.passed).length;
		const firstPassObserved = runs.filter(r => r.firstPassed !== null);
		const firstPassRate =
			firstPassObserved.length > 0
				? firstPassObserved.filter(r => r.firstPassed === true).length / firstPassObserved.length
				: null;
		summaries.push({
			variant: first.fingerprint.variant,
			caseId: first.fingerprint.caseId,
			category: categoryByCase.get(first.fingerprint.caseId),
			runs,
			passRate: passed / runs.length,
			firstPassRate,
			meanQualityScore: meanOf(runs.map(r => r.qualityScore)),
			meanDurationMs: runs.reduce((s, r) => s + r.durationMs, 0) / runs.length,
			meanEstimatedTokens: meanOf(runs.map(r => r.tokens.estimatedTotalTokens.value)),
			meanToolResultBytes: meanOf(runs.map(r => r.tokens.toolResultBytes.value)),
			meanSystemPromptBytes: meanOf(runs.map(r => r.tokens.systemPromptBytes.value)),
			meanToolSchemaBytes: meanOf(runs.map(r => r.tokens.toolSchemaBytes.value)),
			meanHistoryBytes: meanOf(runs.map(r => r.tokens.historyBytes.value)),
			meanRepoMapBytes: meanOf(runs.map(r => r.tokens.repoMapBytes.value)),
			meanContextEvictedBytes: meanOf(runs.map(r => r.tokens.contextEvictedBytes.value)),
			meanInputTokens: meanOf(runs.map(r => r.tokens.inputTokens.value)),
			meanOutputTokens: meanOf(runs.map(r => r.tokens.outputTokens.value)),
			meanCacheReadTokens: meanOf(runs.map(r => r.tokens.cacheReadTokens.value)),
			meanCostUsd: meanOf(runs.map(r => r.tokens.costUsd.value)),
			meanSchemaRetries: meanOf(runs.map(r => r.stage.schemaRetries.value)),
			meanFallbacks: meanOf(runs.map(r => r.stage.fallbacks.value)),
			meanToolCalls: meanOf(runs.map(r => r.stage.toolCalls.value)),
			meanDuplicateReads: meanOf(runs.map(r => r.stage.duplicateReadCount.value)),
			meanDuplicateGreps: meanOf(runs.map(r => r.stage.duplicateGrepCount.value)),
		});
	}
	return summaries.sort((a, b) => a.caseId.localeCompare(b.caseId) || a.variant.localeCompare(b.variant));
}

export function buildScorecard(
	suite: BenchmarkSuite,
	results: BenchmarkRunResult[],
	opts?: { liveQualityUnknown?: boolean; notes?: string[] },
): BenchmarkScorecard {
	const liveQualityUnknown = opts?.liveQualityUnknown ?? true;
	const notes = [
		...(liveQualityUnknown
			? ["Live provider quality not measured; fake-runtime scorecard only.", "live quality unknown"]
			: ["Live provider quality included for selected cases."]),
		...(opts?.notes ?? []),
	];
	return {
		schemaVersion: 1,
		suiteId: suite.id,
		suiteVersion: suite.suiteVersion,
		generatedAt: new Date().toISOString(),
		summaries: summarizeResults(results, suite),
		liveQualityUnknown,
		notes,
	};
}

/** Compare optimized vs baseline pass rates; never mutates config. */
export function evaluateBenchmarkQualityGate(
	scorecard: BenchmarkScorecard,
	gate: BenchmarkQualityGate = { minPassRate: 0, maxPassRateDropPp: 3, maxQualityDropPp: 3 },
): BenchmarkGateResult {
	const reasons: string[] = [];
	const byCase = new Map<string, { baseline?: BenchmarkVariantSummary; optimized?: BenchmarkVariantSummary }>();
	for (const s of scorecard.summaries) {
		const entry = byCase.get(s.caseId) ?? {};
		if (s.variant === "baseline") entry.baseline = s;
		else entry.optimized = s;
		byCase.set(s.caseId, entry);
	}
	if (byCase.size === 0) {
		return { passed: false, reasons: ["inconclusive: no case summaries"] };
	}
	for (const [caseId, pair] of byCase) {
		const base = pair.baseline;
		const opt = pair.optimized;
		// Paired A/B gate requires both variants; single-variant runs are inconclusive.
		if (!base || !opt) {
			const have = base ? "baseline" : "optimized";
			reasons.push(
				`${caseId}: inconclusive paired quality gate (only ${have} present; need baseline and optimized)`,
			);
			continue;
		}
		// Scope hard violation (canonical "violation" or legacy "hard_fail") fails the quality gate.
		const hardFailRuns = opt.runs.filter(r => r.scopeStatus === "violation" || r.scopeStatus === "hard_fail");
		if (hardFailRuns.length > 0) {
			reasons.push(
				`${caseId}: optimized run(s) reported scopeStatus=violation (${hardFailRuns.length}/${opt.runs.length})`,
			);
		}
		if (opt.passRate * 100 < gate.minPassRate) {
			reasons.push(
				`${caseId}: optimized passRate ${(opt.passRate * 100).toFixed(1)}% below min ${gate.minPassRate}`,
			);
		}
		const dropPp = (base.passRate - opt.passRate) * 100;
		if (exceedsDropPp(dropPp, gate.maxPassRateDropPp)) {
			reasons.push(
				`${caseId}: optimized passRate dropped ${dropPp.toFixed(1)}pp vs baseline (limit ${gate.maxPassRateDropPp})`,
			);
		}
		const baseQ = base.runs.map(r => r.qualityScore).filter((q): q is number => typeof q === "number");
		const optQ = opt.runs.map(r => r.qualityScore).filter((q): q is number => typeof q === "number");
		if (baseQ.length && optQ.length) {
			const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
			const qDrop = mean(baseQ) - mean(optQ);
			if (exceedsDropPp(qDrop, gate.maxQualityDropPp)) {
				reasons.push(
					`${caseId}: optimized quality dropped ${qDrop.toFixed(1)}pp vs baseline (limit ${gate.maxQualityDropPp})`,
				);
			}
		}
	}
	return { passed: reasons.length === 0, reasons };
}

/** Build full report with comparison rows + gate. */
export function buildBenchmarkReport(
	suite: BenchmarkSuite,
	results: BenchmarkRunResult[],
	opts?: {
		liveQualityUnknown?: boolean;
		notes?: string[];
		gate?: BenchmarkQualityGate;
	},
): BenchmarkReport {
	const scorecard = buildScorecard(suite, results, {
		liveQualityUnknown: opts?.liveQualityUnknown,
		notes: opts?.notes,
	});
	const gate = evaluateBenchmarkQualityGate(scorecard, opts?.gate);
	const comparison = buildComparisonRows(scorecard, gate);
	return {
		schemaVersion: 1,
		suiteId: suite.id,
		suiteVersion: suite.suiteVersion,
		generatedAt: scorecard.generatedAt,
		liveQualityUnknown: scorecard.liveQualityUnknown,
		scorecard,
		comparison,
		gate,
		notes: scorecard.notes,
	};
}

/** Markdown comparison report from a full BenchmarkReport. */
export function renderBenchmarkReportMarkdown(report: BenchmarkReport): string {
	return formatComparisonMarkdown(report);
}

export { buildComparisonRows, formatComparisonMarkdown } from "./report";
