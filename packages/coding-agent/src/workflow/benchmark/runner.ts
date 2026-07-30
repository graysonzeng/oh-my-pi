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
	BenchmarkRuntimeProvenance,
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
	/** Runtime-observed identity required for live acceptance. */
	runtimeProvenance?: BenchmarkRuntimeProvenance;
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
	/** Exact provider identity — null/omit when unknown. */
	provider?: string | null;
	model?: string | null;
	checkpoint?: string | null;
	/** API / transport id. */
	api?: string | null;
	/** Host adapter id / version. */
	adapter?: string | null;
	/** Stream / event parser id / version. */
	parser?: string | null;
	/** ModelFactsV1 fingerprint when compiled policy is in play. */
	modelFactsFingerprint?: string | null;
	taskPolicyFingerprint?: string | null;
	sessionStateFingerprint?: string | null;
	/** Compiled policy content hash (receipt-level). */
	compiledPolicyFingerprint?: string | null;
	/** Durable compiled policy receipt id when available. */
	compiledPolicyReceiptId?: string | null;
	/**
	 * Ordinary paired ablation: at most one lever (string or single-element array).
	 * Combination runs: multi-element array with combinationRun=true.
	 */
	activeLever?: string | readonly string[] | null;
	/**
	 * Explicit flag for multi-lever combination runs.
	 * Required when activeLever lists more than one lever. Never mutates production profiles.
	 */
	combinationRun?: boolean;
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
		fixtureVersion: c.fixtureVersion,
		fixtureBaseIdentity: c.fixtureBaseIdentity,
		repoFixture: c.repoFixture ?? null,
		allowedPaths: [...c.allowedPaths].sort(),
		forbiddenPaths: [...c.forbiddenPaths].sort(),
		verificationCommands: c.verificationCommands,
	});
	return sha256Hex(payload);
}

function nullableIdentity(value: string | null | undefined): string | null {
	if (value === undefined || value === null || value === "") return null;
	return value;
}

/**
 * Normalize active lever for fingerprints.
 * Ordinary paired runs accept at most one lever; multi-lever requires combinationRun.
 */
export function resolveActiveLever(
	activeLever: string | readonly string[] | null | undefined,
	combinationRun: boolean | undefined,
): string | null {
	if (activeLever === undefined || activeLever === null) return null;
	const levers = (Array.isArray(activeLever) ? [...activeLever] : [activeLever])
		.map(v => String(v).trim())
		.filter(v => v.length > 0 && v !== "none");
	if (levers.length === 0) return null;
	const unique = [...new Set(levers)].sort();
	if (unique.length === 1) return unique[0]!;
	if (!combinationRun) {
		throw new Error(
			`single-lever invariant: ordinary paired runs allow at most one active lever; got [${unique.join(", ")}]. ` +
				`Set combinationRun=true with an explicit variant/flag for multi-lever combination runs. ` +
				`This does not mutate production profiles.`,
		);
	}
	return `combo:${unique.join("+")}`;
}

/** Stable JSON fingerprint of identity + policy stamps (no timestamps). */
export function fingerprintIdentity(fp: BenchmarkRunFingerprint): string {
	const payload = JSON.stringify({
		suiteId: fp.suiteId,
		caseId: fp.caseId,
		variant: fp.variant,
		caseFingerprint: fp.caseFingerprint,
		fixtureVersion: fp.fixtureVersion,
		fixtureBaseIdentity: fp.fixtureBaseIdentity,
		profileId: fp.profileId ?? null,
		strategyFingerprint: fp.strategyFingerprint ?? null,
		provider: fp.provider,
		model: fp.model,
		checkpoint: fp.checkpoint,
		api: fp.api,
		adapter: fp.adapter,
		parser: fp.parser,
		modelFactsFingerprint: fp.modelFactsFingerprint,
		taskPolicyFingerprint: fp.taskPolicyFingerprint,
		sessionStateFingerprint: fp.sessionStateFingerprint,
		compiledPolicyFingerprint: fp.compiledPolicyFingerprint,
		compiledPolicyReceiptId: fp.compiledPolicyReceiptId,
		activeLever: fp.activeLever,
	});
	return sha256Hex(payload);
}

export function buildFingerprint(
	suite: BenchmarkSuite,
	c: BenchmarkCase,
	variant: BenchmarkVariantKind,
	opts: BenchmarkRunOptions,
): BenchmarkRunFingerprint {
	const activeLever = resolveActiveLever(opts.activeLever, opts.combinationRun);
	return {
		suiteId: suite.id,
		caseId: c.id,
		variant,
		caseFingerprint: caseFingerprint(c),
		fixtureVersion: c.fixtureVersion,
		fixtureBaseIdentity: c.fixtureBaseIdentity,
		profileId: variant === "optimized" ? opts.optimizedProfileId : "baseline",
		strategyFingerprint: variant === "optimized" ? opts.optimizedStrategyFingerprint : "none",
		provider: nullableIdentity(opts.provider),
		model: nullableIdentity(opts.model),
		checkpoint: nullableIdentity(opts.checkpoint),
		api: nullableIdentity(opts.api),
		adapter: nullableIdentity(opts.adapter),
		parser: nullableIdentity(opts.parser),
		modelFactsFingerprint: nullableIdentity(opts.modelFactsFingerprint),
		taskPolicyFingerprint: nullableIdentity(opts.taskPolicyFingerprint),
		sessionStateFingerprint: nullableIdentity(opts.sessionStateFingerprint),
		compiledPolicyFingerprint: nullableIdentity(opts.compiledPolicyFingerprint),
		compiledPolicyReceiptId: nullableIdentity(opts.compiledPolicyReceiptId),
		activeLever,
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
		for (let repetition = 1; repetition <= reps; repetition++) {
			// Counterbalance each adjacent pair while keeping runs reproducible.
			const repetitionVariants = repetition % 2 === 1 ? variants : [...variants].reverse();
			for (const variant of repetitionVariants) {
				const fingerprint = buildFingerprint(opts.suite, c, variant, opts);
				const started = performance.now();
				try {
					const response = await opts.runtime({
						case: c,
						variant,
						repetition,
						fingerprint,
					});
					const durationMs = response.durationMs ?? performance.now() - started;
					const identityErrors: string[] = [];
					const runtimeProvenance = response.runtimeProvenance ?? null;
					let resultFingerprint = fingerprint;
					if (opts.liveQualityUnknown === false) {
						if (!runtimeProvenance?.provider.trim() || !runtimeProvenance.model.trim()) {
							identityErrors.push("live runtime provenance missing actual provider/model identity");
						} else {
							resultFingerprint = {
								...fingerprint,
								provider: runtimeProvenance.provider,
								model: runtimeProvenance.model,
								checkpoint: runtimeProvenance.checkpoint,
								api: runtimeProvenance.api,
								adapter: runtimeProvenance.adapter,
								parser: runtimeProvenance.parser,
							};
							if (opts.provider && runtimeProvenance.provider !== opts.provider) {
								identityErrors.push(
									`live provider mismatch: requested=${opts.provider} actual=${runtimeProvenance.provider}`,
								);
							}
							const requestedModel = opts.model?.includes("/")
								? opts.model.slice(opts.model.lastIndexOf("/") + 1)
								: opts.model;
							if (requestedModel && runtimeProvenance.model !== requestedModel) {
								identityErrors.push(
									`live model mismatch: requested=${opts.model} actual=${runtimeProvenance.model}`,
								);
							}
						}
						const fallbackCount = response.stage?.fallbacks?.value;
						if (typeof fallbackCount === "number" && fallbackCount > 0) {
							identityErrors.push(`fixed-model live run observed ${fallbackCount} fallback(s)`);
						}
					}
					results.push({
						fingerprint: resultFingerprint,
						repetition,
						passed: response.passed && identityErrors.length === 0,
						firstPassed: identityErrors.length === 0 ? (response.firstPassed ?? null) : false,
						qualityScore: identityErrors.length === 0 ? (response.qualityScore ?? null) : null,
						tokens: mergeTokens(response.tokens),
						stage: mergeStage(response.stage),
						scopeStatus: response.scopeStatus ?? null,
						runtimeProvenance,
						error: [...identityErrors, ...(response.error ? [response.error] : [])].join("; ") || undefined,
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
						runtimeProvenance: null,
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

function sharedFingerprintField(
	results: BenchmarkRunResult[],
	pick: (fp: BenchmarkRunFingerprint) => string | null,
): string | null {
	if (results.length === 0) return null;
	const values = new Set(results.map(r => pick(r.fingerprint)));
	if (values.size !== 1) return null;
	return [...values][0] ?? null;
}

export function buildScorecard(
	suite: BenchmarkSuite,
	results: BenchmarkRunResult[],
	opts?: {
		liveQualityUnknown?: boolean;
		notes?: string[];
		combinationRun?: boolean;
		acceptanceMinRepetitions?: number;
	},
): BenchmarkScorecard {
	const liveQualityUnknown = opts?.liveQualityUnknown ?? true;
	const compiledPolicyReceiptId = sharedFingerprintField(results, fp => fp.compiledPolicyReceiptId);
	const compiledPolicyFingerprint = sharedFingerprintField(results, fp => fp.compiledPolicyFingerprint);
	const activeLever = sharedFingerprintField(results, fp => fp.activeLever);
	const combinationRun =
		opts?.combinationRun === true || (typeof activeLever === "string" && activeLever.startsWith("combo:"));
	const acceptanceMinRepetitions = opts?.acceptanceMinRepetitions ?? 5;
	const notes = [
		...(liveQualityUnknown
			? ["Live provider quality not measured; fake-runtime scorecard only.", "live quality unknown"]
			: ["Live provider quality included for selected cases."]),
		...(opts?.notes ?? []),
	];
	if (compiledPolicyReceiptId) {
		notes.push(`compiledPolicyReceiptId=${compiledPolicyReceiptId}`);
	}
	if (compiledPolicyFingerprint) {
		notes.push(`compiledPolicyFingerprint=${compiledPolicyFingerprint}`);
	}
	if (activeLever) {
		notes.push(`activeLever=${activeLever}`);
	}
	if (combinationRun) {
		notes.push("combinationRun=true (explicit multi-lever; production profiles unchanged)");
	}
	if (!liveQualityUnknown && acceptanceMinRepetitions < 5) {
		notes.push(`acceptanceMinRepetitions=${acceptanceMinRepetitions}`);
	}
	// Cache facts remain unknown when no provider counters were observed.
	const anyCacheObservable = results.some(r => r.tokens.cacheObservable);
	if (!anyCacheObservable) {
		notes.push("cache facts unknown (no provider cache counters observed)");
	}
	return {
		schemaVersion: 1,
		suiteId: suite.id,
		suiteVersion: suite.suiteVersion,
		generatedAt: new Date().toISOString(),
		summaries: summarizeResults(results, suite),
		liveQualityUnknown,
		notes,
		compiledPolicyReceiptId,
		compiledPolicyFingerprint,
		activeLever,
		combinationRun,
		acceptanceMinRepetitions,
	};
}

/** Compare optimized vs baseline pass rates; never mutates config. */
export function evaluateBenchmarkQualityGate(
	scorecard: BenchmarkScorecard,
	gate: BenchmarkQualityGate = { minPassRate: 100, maxPassRateDropPp: 3, maxQualityDropPp: 3 },
): BenchmarkGateResult {
	const reasons: string[] = [];
	// Fake/synthetic pipeline may pass the structural gate while liveQualityUnknown=true.
	// Live acceptance (`liveQualityUnknown=false`) adds absolute identity/sampling checks below.
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
		for (const summary of [base, opt]) {
			const requiredReps = scorecard.acceptanceMinRepetitions ?? 5;
			if (!scorecard.liveQualityUnknown && summary.runs.length < requiredReps) {
				reasons.push(
					`${caseId}: ${summary.variant} acceptance is undersampled (${summary.runs.length}/${requiredReps} repetitions)`,
				);
			}
			if (!scorecard.liveQualityUnknown) {
				const missingRuntimeIdentity = summary.runs.filter(run => !run.runtimeProvenance);
				if (missingRuntimeIdentity.length > 0) {
					reasons.push(
						`${caseId}: ${summary.variant} run(s) missing runtime provenance (${missingRuntimeIdentity.length}/${summary.runs.length})`,
					);
				}
			}
			if (summary.passRate * 100 < gate.minPassRate) {
				reasons.push(
					`${caseId}: ${summary.variant} passRate ${(summary.passRate * 100).toFixed(1)}% below min ${gate.minPassRate}`,
				);
			}
			const missingScopeRuns = summary.runs.filter(run => run.scopeStatus === null || run.scopeStatus === undefined);
			if (missingScopeRuns.length > 0) {
				reasons.push(
					`${caseId}: ${summary.variant} run(s) missing scope evidence (${missingScopeRuns.length}/${summary.runs.length})`,
				);
			}
			const hardFailRuns = summary.runs.filter(
				run => run.scopeStatus === "violation" || run.scopeStatus === "hard_fail",
			);
			if (hardFailRuns.length > 0) {
				reasons.push(
					`${caseId}: ${summary.variant} run(s) reported scopeStatus=violation (${hardFailRuns.length}/${summary.runs.length})`,
				);
			}
			// Live acceptance requires observed adherence; fake/indeterminate/warning remain reportable without hard-fail.
			if (!scorecard.liveQualityUnknown) {
				const nonAdheredRuns = summary.runs.filter(
					run => run.scopeStatus !== "adhered" && run.scopeStatus !== "pass",
				);
				if (nonAdheredRuns.length > 0) {
					const statuses = [...new Set(nonAdheredRuns.map(run => run.scopeStatus ?? "missing"))].join(",");
					reasons.push(
						`${caseId}: ${summary.variant} scope hard gate requires adhered; got ${statuses} (${nonAdheredRuns.length}/${summary.runs.length})`,
					);
				}
			}
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
		combinationRun?: boolean;
		acceptanceMinRepetitions?: number;
	},
): BenchmarkReport {
	const scorecard = buildScorecard(suite, results, {
		liveQualityUnknown: opts?.liveQualityUnknown,
		notes: opts?.notes,
		combinationRun: opts?.combinationRun,
		acceptanceMinRepetitions: opts?.acceptanceMinRepetitions,
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
		compiledPolicyReceiptId: scorecard.compiledPolicyReceiptId ?? null,
		compiledPolicyFingerprint: scorecard.compiledPolicyFingerprint ?? null,
		activeLever: scorecard.activeLever ?? null,
		combinationRun: scorecard.combinationRun ?? false,
	};
}

/** Markdown comparison report from a full BenchmarkReport. */
export function renderBenchmarkReportMarkdown(report: BenchmarkReport): string {
	return formatComparisonMarkdown(report);
}

export { buildComparisonRows, formatComparisonMarkdown } from "./report";
