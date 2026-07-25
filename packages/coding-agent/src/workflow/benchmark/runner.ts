/**
 * Pure benchmark runner: executes paired baseline/optimized cases via an injected runtime.
 * Never edits default-config profiles or production routes.
 */

import { sha256Hex } from "../optimization-receipt";
import type {
	BenchmarkCase,
	BenchmarkGateResult,
	BenchmarkQualityGate,
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
}

function unknownMetric<T>(): MetricValue<T> {
	return { value: null, provenance: "unknown" };
}

function exactMetric<T>(value: T): MetricValue<T> {
	return { value, provenance: "exact" };
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
		schemaRetries: exactMetric(0),
		fallbacks: exactMetric(0),
		toolCalls: unknownMetric(),
		compressionReceipts: [],
		scopeArtifactId: null,
	};
}

export function caseFingerprint(c: BenchmarkCase): string {
	const payload = JSON.stringify({
		id: c.id,
		request: c.request,
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

export function summarizeResults(results: BenchmarkRunResult[]): BenchmarkVariantSummary[] {
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
		const meanDurationMs = runs.reduce((s, r) => s + r.durationMs, 0) / runs.length;
		const tokenVals = runs
			.map(r => r.tokens.estimatedTotalTokens.value)
			.filter((v): v is number => typeof v === "number");
		summaries.push({
			variant: first.fingerprint.variant,
			caseId: first.fingerprint.caseId,
			runs,
			passRate: passed / runs.length,
			meanDurationMs,
			meanEstimatedTokens: tokenVals.length > 0 ? tokenVals.reduce((a, b) => a + b, 0) / tokenVals.length : null,
		});
	}
	return summaries.sort((a, b) => a.caseId.localeCompare(b.caseId) || a.variant.localeCompare(b.variant));
}

export function buildScorecard(suite: BenchmarkSuite, results: BenchmarkRunResult[]): BenchmarkScorecard {
	return {
		schemaVersion: 1,
		suiteId: suite.id,
		generatedAt: new Date().toISOString(),
		summaries: summarizeResults(results),
		liveQualityUnknown: true,
		notes: ["Live provider quality not measured; fake-runtime scorecard only."],
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
	for (const [caseId, pair] of byCase) {
		const base = pair.baseline;
		const opt = pair.optimized;
		// Scope hard_fail on optimized (or any gated) runs is an automatic quality-gate failure.
		const hardFailRuns = (opt?.runs ?? []).filter(r => r.scopeStatus === "hard_fail");
		if (hardFailRuns.length > 0) {
			reasons.push(
				`${caseId}: optimized run(s) reported scopeStatus=hard_fail (${hardFailRuns.length}/${opt?.runs.length ?? 0})`,
			);
		}
		if (opt && opt.passRate * 100 < gate.minPassRate) {
			reasons.push(
				`${caseId}: optimized passRate ${(opt.passRate * 100).toFixed(1)}% below min ${gate.minPassRate}`,
			);
		}
		if (base && opt) {
			const dropPp = (base.passRate - opt.passRate) * 100;
			if (dropPp > gate.maxPassRateDropPp) {
				reasons.push(
					`${caseId}: optimized passRate dropped ${dropPp.toFixed(1)}pp vs baseline (limit ${gate.maxPassRateDropPp})`,
				);
			}
			const baseQ = base.runs.map(r => r.qualityScore).filter((q): q is number => typeof q === "number");
			const optQ = opt.runs.map(r => r.qualityScore).filter((q): q is number => typeof q === "number");
			if (baseQ.length && optQ.length) {
				const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
				const qDrop = mean(baseQ) - mean(optQ);
				if (qDrop > gate.maxQualityDropPp) {
					reasons.push(
						`${caseId}: optimized quality dropped ${qDrop.toFixed(1)}pp vs baseline (limit ${gate.maxQualityDropPp})`,
					);
				}
			}
		}
	}
	return { passed: reasons.length === 0, reasons };
}
