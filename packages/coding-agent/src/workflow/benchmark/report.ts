/**
 * Markdown / structured comparison report for paired baseline vs optimized scorecards.
 * Pure formatting — no I/O, no profile mutation.
 */

import type {
	BenchmarkComparisonRow,
	BenchmarkGateResult,
	BenchmarkMetricGroup,
	BenchmarkReport,
	BenchmarkScorecard,
	BenchmarkVariantSummary,
} from "./types";

interface MetricDef {
	metric: string;
	group: BenchmarkMetricGroup;
	unit: string;
	higherIsBetter: boolean;
	/** Extract numeric mean from a variant summary. */
	pick: (s: BenchmarkVariantSummary) => number | null;
	/** Scale for display (e.g. passRate 0-1 → percentage points via *100). */
	scale?: number;
	/** When true, delta is treated as quality pass-rate drop (pp) for gate coloring. */
	isPassRate?: boolean;
	/** When true, quality-score drop gate marks this row only. */
	isQualityScore?: boolean;
}

const METRICS: MetricDef[] = [
	// Quality
	{
		metric: "pass_rate",
		group: "quality",
		unit: "%",
		higherIsBetter: true,
		pick: s => s.passRate,
		scale: 100,
		isPassRate: true,
	},
	{
		metric: "first_pass_rate",
		group: "quality",
		unit: "%",
		higherIsBetter: true,
		pick: s => s.firstPassRate,
		scale: 100,
	},
	{
		metric: "quality_score",
		group: "quality",
		unit: "score",
		higherIsBetter: true,
		pick: s => s.meanQualityScore,
		isQualityScore: true,
	},
	{
		metric: "schema_retries",
		group: "quality",
		unit: "count",
		higherIsBetter: false,
		pick: s => s.meanSchemaRetries,
	},
	{
		metric: "provider_fallbacks",
		group: "quality",
		unit: "count",
		higherIsBetter: false,
		pick: s => s.meanFallbacks,
	},
	{
		metric: "tool_calls",
		group: "quality",
		unit: "count",
		higherIsBetter: false,
		pick: s => s.meanToolCalls,
	},
	{
		metric: "duplicate_reads",
		group: "quality",
		unit: "count",
		higherIsBetter: false,
		pick: s => s.meanDuplicateReads,
	},
	{
		metric: "duplicate_greps",
		group: "quality",
		unit: "count",
		higherIsBetter: false,
		pick: s => s.meanDuplicateGreps,
	},
	// Token (measured) — exact bytes + estimate
	{
		metric: "system_prompt_bytes",
		group: "token_measured",
		unit: "bytes",
		higherIsBetter: false,
		pick: s => s.meanSystemPromptBytes,
	},
	{
		metric: "tool_schema_bytes",
		group: "token_measured",
		unit: "bytes",
		higherIsBetter: false,
		pick: s => s.meanToolSchemaBytes,
	},
	{
		metric: "history_bytes",
		group: "token_measured",
		unit: "bytes",
		higherIsBetter: false,
		pick: s => s.meanHistoryBytes,
	},
	{
		metric: "repo_map_bytes",
		group: "token_measured",
		unit: "bytes",
		higherIsBetter: false,
		pick: s => s.meanRepoMapBytes,
	},
	{
		metric: "tool_result_bytes",
		group: "token_measured",
		unit: "bytes",
		higherIsBetter: false,
		pick: s => s.meanToolResultBytes,
	},
	{
		metric: "context_evicted_bytes",
		group: "token_measured",
		unit: "bytes",
		higherIsBetter: false,
		pick: s => s.meanContextEvictedBytes,
	},
	{
		metric: "estimated_total_tokens",
		group: "token_measured",
		unit: "tokens (est)",
		higherIsBetter: false,
		pick: s => s.meanEstimatedTokens,
	},
	// Provider (actual)
	{
		metric: "input_tokens",
		group: "provider_actual",
		unit: "tokens",
		higherIsBetter: false,
		pick: s => s.meanInputTokens,
	},
	{
		metric: "output_tokens",
		group: "provider_actual",
		unit: "tokens",
		higherIsBetter: false,
		pick: s => s.meanOutputTokens,
	},
	{
		metric: "cache_read_tokens",
		group: "provider_actual",
		unit: "tokens",
		higherIsBetter: true,
		pick: s => s.meanCacheReadTokens,
	},
	{
		metric: "cost_usd",
		group: "provider_actual",
		unit: "usd",
		higherIsBetter: false,
		pick: s => s.meanCostUsd,
	},
	// Performance
	{
		metric: "duration_ms",
		group: "performance",
		unit: "ms",
		higherIsBetter: false,
		pick: s => s.meanDurationMs,
	},
];

const GROUP_TITLES: Record<BenchmarkMetricGroup, string> = {
	quality: "Quality",
	token_measured: "Token (measured)",
	provider_actual: "Provider (actual)",
	performance: "Performance",
};

function scaleValue(v: number | null, scale?: number): number | null {
	if (v === null) return null;
	return scale ? v * scale : v;
}

/**
 * True only when drop strictly exceeds maxDrop (contract: drop > N pp fails; equality does not).
 * Compares at 0.01 pp resolution via integer rounding so float noise like
 * (1 - 0.97) * 100 === 3.0000000000000027 does not trip the gate.
 */
export function exceedsDropPp(dropPp: number, maxDropPp: number): boolean {
	return Math.round(dropPp * 100) > Math.round(maxDropPp * 100);
}

function deltaMarker(
	baseline: number | null,
	optimized: number | null,
	higherIsBetter: boolean,
): { delta: number | null; marker: BenchmarkComparisonRow["marker"] } {
	if (baseline === null || optimized === null) {
		return { delta: null, marker: "—" };
	}
	const delta = optimized - baseline;
	if (Math.abs(delta) < 1e-12) {
		return { delta: 0, marker: "—" };
	}
	const improved = higherIsBetter ? delta > 0 : delta < 0;
	return { delta, marker: improved ? "✅" : "❌" };
}

/** Build per-case comparison rows from a scorecard + gate reasons. */
export function buildComparisonRows(
	scorecard: BenchmarkScorecard,
	gate: BenchmarkGateResult,
	opts?: { maxPassRateDropPp?: number },
): BenchmarkComparisonRow[] {
	const maxDrop = opts?.maxPassRateDropPp ?? 3;
	const byCase = new Map<string, { baseline?: BenchmarkVariantSummary; optimized?: BenchmarkVariantSummary }>();
	for (const s of scorecard.summaries) {
		const entry = byCase.get(s.caseId) ?? {};
		if (s.variant === "baseline") entry.baseline = s;
		else entry.optimized = s;
		byCase.set(s.caseId, entry);
	}

	// Map caseId → which metric kinds failed the gate (not all metrics for that case).
	const passRateFail = new Set<string>();
	const qualityFail = new Set<string>();
	for (const r of gate.reasons) {
		const m = /^([^:]+):\s*(.*)$/.exec(r);
		if (!m) continue;
		const caseId = m[1]!;
		const body = m[2]!;
		if (/passRate|pass rate/i.test(body)) passRateFail.add(caseId);
		if (/quality dropped|qualityScore|quality score/i.test(body)) qualityFail.add(caseId);
	}

	const rows: BenchmarkComparisonRow[] = [];
	const caseIds = [...byCase.keys()].sort();
	for (const caseId of caseIds) {
		const pair = byCase.get(caseId)!;
		const base = pair.baseline;
		const opt = pair.optimized;
		for (const def of METRICS) {
			const bRaw = base ? def.pick(base) : null;
			const oRaw = opt ? def.pick(opt) : null;
			const b = scaleValue(bRaw, def.scale);
			const o = scaleValue(oRaw, def.scale);
			const { delta, marker } = deltaMarker(b, o, def.higherIsBetter);
			let gateFail = false;
			if (def.isPassRate && b !== null && o !== null) {
				const dropPp = b - o;
				if (exceedsDropPp(dropPp, maxDrop) || passRateFail.has(caseId)) {
					gateFail = true;
				}
			}
			if (def.isQualityScore && qualityFail.has(caseId)) {
				gateFail = true;
			}
			rows.push({
				metric: def.metric,
				group: def.group,
				caseId,
				baseline: b,
				optimized: o,
				delta,
				marker: gateFail ? "❌" : marker,
				unit: def.unit,
				higherIsBetter: def.higherIsBetter,
				gateFail: gateFail || undefined,
			});
		}
	}
	return rows;
}

function fmtNum(v: number | null, unit: string): string {
	if (v === null) return "null";
	if (unit === "usd") return v.toFixed(4);
	if (unit === "%" || unit === "pp") return v.toFixed(1);
	if (Number.isInteger(v)) return String(v);
	return v.toFixed(1);
}

/** Per-variant counts of scopeStatus for report visibility (warning vs violation vs adhered). */
export function scopeStatusSummaryLines(scorecard: BenchmarkScorecard): string[] {
	const lines: string[] = [];
	for (const s of scorecard.summaries) {
		const counts = new Map<string, number>();
		let observed = 0;
		for (const r of s.runs) {
			if (r.scopeStatus == null) continue;
			observed++;
			const key = String(r.scopeStatus);
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		if (observed === 0) continue;
		const parts = [...counts.entries()]
			.sort((a, b) => a[0].localeCompare(b[0]))
			.map(([k, n]) => `${k}=${n}`)
			.join(", ");
		lines.push(`${s.caseId}/${s.variant}: ${parts} (${observed}/${s.runs.length} runs observed)`);
	}
	return lines;
}

function fmtDelta(row: BenchmarkComparisonRow): string {
	if (row.delta === null) return "—";
	const sign = row.delta > 0 ? "+" : "";
	const unit = row.unit === "%" ? "pp" : row.unit;
	const body = row.unit === "usd" ? row.delta.toFixed(4) : row.delta.toFixed(1);
	const fail = row.gateFail ? " **FAIL**" : "";
	return `${row.marker} ${sign}${body} ${unit}${fail}`;
}

/** Render a full Markdown comparison report. */
export function formatComparisonMarkdown(report: BenchmarkReport): string {
	const lines: string[] = [];
	lines.push(`# Benchmark comparison: ${report.suiteId}`);
	lines.push("");
	lines.push(`- suiteVersion: \`${report.suiteVersion}\``);
	lines.push(`- generatedAt: \`${report.generatedAt}\``);
	lines.push(`- liveQualityUnknown: \`${report.liveQualityUnknown}\``);
	if (report.compiledPolicyReceiptId) {
		lines.push(`- compiledPolicyReceiptId: \`${report.compiledPolicyReceiptId}\``);
	}
	if (report.compiledPolicyFingerprint) {
		lines.push(`- compiledPolicyFingerprint: \`${report.compiledPolicyFingerprint}\``);
	}
	if (report.activeLever) {
		lines.push(`- activeLever: \`${report.activeLever}\``);
	}
	if (report.combinationRun) {
		lines.push(`- combinationRun: \`true\` (explicit multi-lever; production profiles unchanged)`);
	}
	if (report.liveQualityUnknown) {
		lines.push(`- **live quality unknown** (fake runtime / no live model run)`);
	}
	lines.push(`- quality gate: ${report.gate.passed ? "✅ passed" : "❌ failed"}`);
	if (report.gate.reasons.length > 0) {
		lines.push("- gate reasons:");
		for (const r of report.gate.reasons) {
			lines.push(`  - ${r}`);
		}
	}
	// Scope adherence: distinguish "tests pass but unplanned/forbidden scope worse"
	const scopeLines = scopeStatusSummaryLines(report.scorecard);
	if (scopeLines.length > 0) {
		lines.push("- scope adherence:");
		for (const s of scopeLines) {
			lines.push(`  - ${s}`);
		}
	}
	lines.push("");

	const groups: BenchmarkMetricGroup[] = ["quality", "token_measured", "provider_actual", "performance"];
	const caseIds = [...new Set(report.comparison.map(r => r.caseId).filter((id): id is string => id !== null))].sort();

	for (const group of groups) {
		lines.push(`## ${GROUP_TITLES[group]}`);
		lines.push("");
		lines.push("| Case | Metric | Baseline | Optimized | Delta |");
		lines.push("| --- | --- | ---: | ---: | --- |");
		for (const caseId of caseIds) {
			const rows = report.comparison.filter(r => r.group === group && r.caseId === caseId);
			for (const row of rows) {
				// Skip all-null provider rows to keep report readable when no provider facts.
				if (group === "provider_actual" && row.baseline === null && row.optimized === null) {
					continue;
				}
				const gateCell = row.gateFail ? " 🔴" : "";
				lines.push(
					`| ${caseId} | ${row.metric} | ${fmtNum(row.baseline, row.unit)} | ${fmtNum(row.optimized, row.unit)} | ${fmtDelta(row)}${gateCell} |`,
				);
			}
		}
		// If every provider row was skipped, note unknowns explicitly.
		if (group === "provider_actual") {
			const any = report.comparison.some(
				r => r.group === "provider_actual" && (r.baseline !== null || r.optimized !== null),
			);
			if (!any) {
				lines.push("| — | *(no provider facts; cache/TTFT/cost null / unknown)* | null | null | — |");
			}
		}
		lines.push("");
	}

	if (report.notes.length > 0) {
		lines.push("## Notes");
		lines.push("");
		for (const n of report.notes) {
			lines.push(`- ${n}`);
		}
		lines.push("");
	}

	lines.push("## Provenance legend");
	lines.push("");
	lines.push("- **Token (measured)**: exact byte counters + estimated tokens (bytes/4, labeled est)");
	lines.push("- **Provider (actual)**: provider_fact usage/cost when exposed; otherwise null/unknown");
	lines.push("- **Unknown**: TTFT, queue time, missing cache counters stay null");
	lines.push("- **Delta**: ✅ improve / ❌ regress / — neutral or missing; pass-rate drop >3pp → gate FAIL 🔴");
	lines.push("");

	return lines.join("\n");
}

/** Aggregate suite-level means across cases for a quick summary table (optional). */
export function suiteLevelMeans(
	scorecard: BenchmarkScorecard,
	variant: "baseline" | "optimized",
): Partial<Record<string, number | null>> {
	const rows = scorecard.summaries.filter(s => s.variant === variant);
	if (rows.length === 0) return {};
	const avg = (pick: (s: BenchmarkVariantSummary) => number | null): number | null => {
		const vals = rows.map(pick).filter((v): v is number => typeof v === "number");
		if (vals.length === 0) return null;
		return vals.reduce((a, b) => a + b, 0) / vals.length;
	};
	return {
		passRate: avg(s => s.passRate),
		meanEstimatedTokens: avg(s => s.meanEstimatedTokens),
		meanToolResultBytes: avg(s => s.meanToolResultBytes),
		meanDurationMs: avg(s => s.meanDurationMs),
	};
}
