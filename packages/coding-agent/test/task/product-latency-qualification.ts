/**
 * Deterministic product-latency qualification scoring, gates, and baseline compare.
 * No provider I/O. Safe to import from bun:test and the manual fixture.
 */
import { isRecord } from "@oh-my-pi/pi-utils";
import { percentile } from "../../src/latency/rollout-cohort";
import { sha256Hex } from "../../src/latency/stable-serialize";
import reviewerAssignment from "./product-latency-reviewer-assignment.md" with { type: "text" };
import scoutAssignment from "./product-latency-scout-assignment.md" with { type: "text" };
import sonicAssignment from "./product-latency-sonic-assignment.md" with { type: "text" };

export type Mode = "smoke" | "release";
export type Variant = "scout" | "reviewer" | "sonic";
export type GateStatus = "PASS" | "FAIL" | "UNVERIFIED";
export type BenefitStatus = "PASS" | "FAIL" | "INCOMPARABLE" | "NO_BASELINE";

export const RUBRIC_ID = "product-latency-qualification-v2";
export const DECLARED_EXPERIMENT_ID = "sonic-effort-ceiling";
export const QUALIFICATION_VARIANTS: readonly Variant[] = ["scout", "reviewer", "sonic"];

export const ASSIGNMENT_IDS = {
	scout: "product-latency-scout-assignment.md",
	reviewer: "product-latency-reviewer-assignment.md",
	sonic: "product-latency-sonic-assignment.md",
} as const;

/** Override bundled report envelopes with the fixture's actual scoring contract. */
export const QUALIFICATION_OUTPUT_SCHEMAS = {
	scout: {
		type: "object",
		properties: { path: { type: "string" }, signature: { type: "string" }, caller: { type: "string" } },
		required: ["path", "signature", "caller"],
		additionalProperties: false,
	},
	reviewer: {
		type: "object",
		properties: {
			verdict: { type: "string", enum: ["accept", "reject"] },
			findings: {
				type: "array",
				items: {
					type: "object",
					properties: { path: { type: "string" }, line: { type: "integer" }, defect: { type: "string" } },
					required: ["path", "line", "defect"],
					additionalProperties: false,
				},
			},
		},
		required: ["verdict", "findings"],
		additionalProperties: false,
	},
} as const;

export const SCOUT_MODEL_CHAIN = ["gateway/deepseek-flash:max", "gateway/grok-4.6:high"] as const;
export const REVIEWER_MODEL_CHAIN = ["@slow"] as const;
export const SONIC_MODEL_CHAIN = ["gateway/deepseek-v4-flash:max", "gateway/grok-4.6:high"] as const;

export const SCOUT_P50_MS = 5 * 60_000;
export const SCOUT_P90_MS = 8 * 60_000;
export const REVIEWER_P50_MS = 12 * 60_000;
export const REVIEWER_P90_MS = 20 * 60_000;

export const VARIANT_LIMITS: Record<Variant, { p50Ms: number; tailMs: number }> = {
	scout: { p50Ms: SCOUT_P50_MS, tailMs: SCOUT_P90_MS },
	reviewer: { p50Ms: REVIEWER_P50_MS, tailMs: REVIEWER_P90_MS },
	sonic: { p50Ms: SCOUT_P50_MS, tailMs: SCOUT_P90_MS },
};

const SONIC_EFFORT_RANK: Record<string, number> = {
	minimal: 0,
	low: 1,
	medium: 2,
	high: 3,
	xhigh: 4,
	max: 5,
};

const EXPECTED_SONIC_SHAPE = "export function add(left: number, right: number): number { return left + right; }";

export interface FrontmatterIdentity {
	thinkingLevel: string | undefined;
	maxEffort: string | undefined;
	readSummarize: boolean | undefined;
	shadowReview: "code" | undefined;
	model: string[] | undefined;
}

export interface RuntimeProvenance {
	source: "runtime_observed";
	provider: string;
	model: string;
	fallback: false;
}

export interface TokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
}

export interface QualityScore {
	accepted: boolean;
	reason: string;
}

export interface GateVerdict {
	status: GateStatus;
	reason?: string;
}

export interface AttemptRecord {
	variant: Variant;
	repetition: number;
	warmup: boolean;
	skip: boolean;
	result: "ok" | "error" | "skip";
	accepted: boolean;
	reason: string;
	completionKind: string | null;
	durationMs: number | null;
	activeWallMs: number | null;
	acceptanceWallMs: number | null;
	providerRequests: number | null;
	runtimeModel: string | undefined;
	effectiveEffort: string | undefined;
	runtimeProvenance: RuntimeProvenance | null;
	hardTimeout: boolean;
	effectiveAgentSource: string;
	effectiveFrontmatterIdentity: FrontmatterIdentity;
	tokenUsage?: TokenUsage;
	costTotal?: number;
	/** Bounded, redacted fixture response (never a historical conversation body). */
	outputEvidence?: string;
}

export interface VariantAggregate {
	variant: Variant;
	launched: number;
	warmup: number;
	measured: number;
	completed: number;
	accepted: number;
	failed: number;
	providerRequests: number;
	missingProviderRequestSamples: number;
	p50AcceptanceMs: number | undefined;
	maxAcceptanceMs: number | undefined;
	p90AcceptanceMs?: number | undefined;
	p50ActiveWallMs: number | undefined;
	maxActiveWallMs: number | undefined;
	models: string[];
	efforts: string[];
	tokenUsage?: TokenUsage;
	costTotal?: number;
	/** Median of measured per-attempt costs; missing samples are omitted, not zero. */
	costMedian?: number;
}

export interface QualificationFingerprints {
	scoutAssignment: string;
	reviewerAssignment: string;
	sonicAssignment: string;
	modelsConfig: string;
	rubric: string;
}

export interface QualificationIdentity {
	rubricId: string;
	mode: Mode;
	variants: Variant[];
	assignmentIds: { scout: string; reviewer: string; sonic: string };
	modelChains: { scout: string[]; reviewer: string[]; sonic: string[] };
	config: {
		strictModelIdentity: true;
		isolatedAuthModelsYml: true;
		measuredCount: number;
		allowedEffortDelta: { experiment: typeof DECLARED_EXPERIMENT_ID; variant: "sonic"; field: "effectiveEffort" };
		fingerprints: QualificationFingerprints;
	};
}

export interface BenefitVerdict {
	status: BenefitStatus;
	reason?: string;
	declaredExperiment?: typeof DECLARED_EXPERIMENT_ID;
	sonicEffort?: { baseline: string | undefined; treatment: string | undefined };
	acceptanceRates?: Record<Variant, { baseline: number; treatment: number; measured: number }>;
	p50AcceptanceMs?: Record<Variant, { baseline: number | undefined; treatment: number | undefined }>;
}

export interface QualificationReport {
	status: GateStatus;
	runtimeSmoke: GateVerdict;
	qualityAcceptance: GateVerdict;
	e2eDelegateToAccepted: GateVerdict;
	benefit: BenefitVerdict;
	mode: Mode;
	identity: QualificationIdentity;
	launches: number;
	launchCeiling: number;
	providerRequests: number;
	missingProviderRequestSamples: number;
	elapsedMs: number;
	attempts: AttemptRecord[];
	aggregates: Record<Variant, VariantAggregate>;
	checkpoint?: "final" | "in_progress";
	configDrift?: string;
}

export function qualificationFingerprints(modelsConfigSha256 = "unobserved"): QualificationFingerprints {
	return {
		scoutAssignment: sha256Hex(scoutAssignment.trimEnd()),
		reviewerAssignment: sha256Hex(reviewerAssignment.trimEnd()),
		sonicAssignment: sha256Hex(sonicAssignment.trimEnd()),
		modelsConfig: modelsConfigSha256,
		rubric: sha256Hex(
			JSON.stringify({
				rubricId: RUBRIC_ID,
				limits: VARIANT_LIMITS,
				measuredSmoke: measuredCount("smoke"),
				measuredRelease: measuredCount("release"),
			}),
		),
	};
}

export function measuredCount(mode: Mode): number {
	return mode === "smoke" ? 5 : 20;
}

export function launchCeiling(mode: Mode, variantCount = QUALIFICATION_VARIANTS.length): number {
	return variantCount * (1 + measuredCount(mode));
}

export function qualificationIdentity(mode: Mode, modelsConfigSha256?: string): QualificationIdentity {
	return {
		rubricId: RUBRIC_ID,
		mode,
		variants: [...QUALIFICATION_VARIANTS],
		assignmentIds: { ...ASSIGNMENT_IDS },
		modelChains: {
			scout: [...SCOUT_MODEL_CHAIN],
			reviewer: [...REVIEWER_MODEL_CHAIN],
			sonic: [...SONIC_MODEL_CHAIN],
		},
		config: {
			strictModelIdentity: true,
			isolatedAuthModelsYml: true,
			measuredCount: measuredCount(mode),
			allowedEffortDelta: {
				experiment: DECLARED_EXPERIMENT_ID,
				variant: "sonic",
				field: "effectiveEffort",
			},
			fingerprints: qualificationFingerprints(modelsConfigSha256),
		},
	};
}

export function measuredAttempts(attempts: readonly AttemptRecord[], variant: Variant): AttemptRecord[] {
	return attempts.filter(attempt => attempt.variant === variant && !attempt.warmup);
}

function parseJsonObject(text: unknown): Record<string, unknown> | undefined {
	if (isRecord(text)) return text;
	if (typeof text !== "string") return undefined;
	const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	const candidates = [
		text.trim(),
		fence?.[1]?.trim(),
		start >= 0 && end > start ? text.slice(start, end + 1) : undefined,
	];
	for (const candidate of candidates) {
		if (!candidate) continue;
		try {
			const value = JSON.parse(candidate) as unknown;
			if (isRecord(value)) return value;
		} catch {
			// try the next candidate
		}
	}
	return undefined;
}

export function scoreScoutOutput(text: unknown): QualityScore {
	const json = parseJsonObject(text);
	if (!json) return { accepted: false, reason: "scout missing structured evidence" };
	const path = typeof json.path === "string" ? json.path : "";
	const signature = typeof json.signature === "string" ? json.signature : "";
	const caller = typeof json.caller === "string" ? json.caller : "";
	const missing: string[] = [];
	if (path !== "src/task/review-performance.ts") missing.push("path src/task/review-performance.ts");
	if (signature !== "resolveClassMaxRuntimeMs(performanceClass, configuredMaxRuntimeMs)") {
		missing.push("signature resolveClassMaxRuntimeMs");
	}
	if (caller !== "resolveTaskSpawnRuntime") missing.push("caller resolveTaskSpawnRuntime");
	if (missing.length > 0) {
		return { accepted: false, reason: `scout missing ${missing.join(", ")}` };
	}
	return { accepted: true, reason: "scout path/signature/caller matched" };
}

function isPlantedSubtraction(text: string): boolean {
	if (/\bno\s+(defect|finding|issue|problem)s?\b/i.test(text) || /\b(is correct|looks good|no issue)\b/i.test(text)) {
		return false;
	}
	return /left\s*-\s*right/.test(text) || /\bsubtract(?:ion|s|ed|ing)?\b/i.test(text) || /\bminus\b/i.test(text);
}

function isAnchoredPlantedFinding(finding: unknown): boolean {
	if (!isRecord(finding)) return false;
	const path = typeof finding.path === "string" ? finding.path : "";
	const basename = path.split(/[\\/]/).pop() ?? "";
	if (basename !== "add.ts") return false;
	const line = typeof finding.line === "number" ? finding.line : Number(finding.line);
	if (line !== 2) return false;
	const defect = [finding.defect, finding.issue, finding.message, finding.reason]
		.filter((value): value is string => typeof value === "string")
		.join(" ");
	return defect.length > 0 && isPlantedSubtraction(defect);
}

export function scoreReviewerOutput(text: unknown): QualityScore {
	const json = parseJsonObject(text);
	if (!json) return { accepted: false, reason: "reviewer missing structured evidence" };
	const verdict = typeof json.verdict === "string" ? json.verdict.trim().toLowerCase() : "";
	if (verdict !== "reject") {
		return { accepted: false, reason: "reviewer missed planted subtraction defect" };
	}
	if (!Array.isArray(json.findings) || json.findings.length === 0) {
		return { accepted: false, reason: "reviewer empty finding" };
	}
	if (!json.findings.some(finding => isAnchoredPlantedFinding(finding))) {
		return { accepted: false, reason: "reviewer missed planted subtraction defect" };
	}
	return { accepted: true, reason: "reviewer found subtraction defect" };
}

export function scoreSonicWorkspace(addTsSource: string): QualityScore {
	const shape = addTsSource
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\/\/.*$/gm, "")
		.replace(/\s+/g, " ")
		.trim();
	if (shape !== EXPECTED_SONIC_SHAPE) {
		return { accepted: false, reason: "sonic did not make add() return a sum" };
	}
	return { accepted: true, reason: "sonic add() returns a sum" };
}

export function scoreAttempt(variant: Variant, evidence: { outputText?: unknown; addTsSource?: string }): QualityScore {
	if (variant === "scout") return scoreScoutOutput(evidence.outputText ?? "");
	if (variant === "reviewer") return scoreReviewerOutput(evidence.outputText ?? "");
	return scoreSonicWorkspace(evidence.addTsSource ?? "");
}

function uniqueStrings(values: readonly (string | undefined)[]): string[] {
	return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function provenanceKey(attempt: AttemptRecord): string | undefined {
	return attempt.runtimeProvenance
		? `${attempt.runtimeProvenance.provider}/${attempt.runtimeProvenance.model}`
		: undefined;
}

function sortedNumbers(values: readonly (number | null | undefined)[]): number[] {
	return values
		.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
		.sort((a, b) => a - b);
}

export function aggregateVariant(mode: Mode, variant: Variant, attempts: readonly AttemptRecord[]): VariantAggregate {
	const launched = attempts.filter(attempt => attempt.variant === variant);
	const measured = measuredAttempts(attempts, variant);
	const walls = sortedNumbers(measured.map(attempt => attempt.acceptanceWallMs));
	const active = sortedNumbers(measured.map(attempt => attempt.activeWallMs));
	let providerRequests = 0;
	let missingProviderRequestSamples = 0;
	let costTotal = 0;
	let hasCost = false;
	let hasUsage = false;
	const tokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
	for (const attempt of launched) {
		if (attempt.providerRequests === null) missingProviderRequestSamples += 1;
		else providerRequests += attempt.providerRequests;
		if (attempt.tokenUsage) {
			hasUsage = true;
			tokenUsage.input += attempt.tokenUsage.input;
			tokenUsage.output += attempt.tokenUsage.output;
			tokenUsage.cacheRead += attempt.tokenUsage.cacheRead;
			tokenUsage.cacheWrite += attempt.tokenUsage.cacheWrite;
			tokenUsage.totalTokens += attempt.tokenUsage.totalTokens;
		}
		if (typeof attempt.costTotal === "number") {
			hasCost = true;
			costTotal += attempt.costTotal;
		}
	}
	const measuredCosts = sortedNumbers(measured.map(attempt => attempt.costTotal));
	return {
		variant,
		launched: launched.length,
		warmup: launched.filter(attempt => attempt.warmup).length,
		measured: measured.length,
		completed: measured.filter(attempt => attempt.completionKind === "completed").length,
		accepted: measured.filter(attempt => attempt.accepted).length,
		failed: measured.filter(attempt => !attempt.accepted).length,
		providerRequests,
		missingProviderRequestSamples,
		p50AcceptanceMs: percentile(walls, 50),
		maxAcceptanceMs: walls[walls.length - 1],
		...(mode === "release" ? { p90AcceptanceMs: percentile(walls, 90) } : {}),
		p50ActiveWallMs: percentile(active, 50),
		maxActiveWallMs: active[active.length - 1],
		models: uniqueStrings(measured.map(provenanceKey)),
		efforts: uniqueStrings(measured.map(attempt => attempt.effectiveEffort)),
		...(hasUsage ? { tokenUsage } : {}),
		...(hasCost ? { costTotal } : {}),
		...(measuredCosts.length > 0 ? { costMedian: percentile(measuredCosts, 50) } : {}),
	};
}

export function evaluateRuntimeSmoke(mode: Mode, attempts: readonly AttemptRecord[]): GateVerdict {
	if (attempts.some(attempt => attempt.skip)) {
		return { status: "UNVERIFIED", reason: attempts.find(attempt => attempt.skip)?.reason ?? "skipped" };
	}
	const timedOut = attempts.find(attempt => attempt.hardTimeout);
	if (timedOut) {
		return {
			status: "FAIL",
			reason: `${timedOut.warmup ? "warmup " : ""}${timedOut.variant} hard timeout count > 0`,
		};
	}
	const incomplete = attempts.find(attempt => attempt.completionKind !== "completed");
	if (incomplete) {
		return {
			status: "FAIL",
			reason: `${incomplete.warmup ? "warmup " : ""}${incomplete.variant} non-completed completionKind`,
		};
	}
	const executionError = attempts.find(attempt => attempt.result !== "ok");
	if (executionError) {
		return { status: "FAIL", reason: `${executionError.variant} child execution failure` };
	}
	for (const variant of QUALIFICATION_VARIANTS) {
		const launched = attempts.filter(attempt => attempt.variant === variant);
		const warmups = launched.filter(attempt => attempt.warmup);
		if (warmups.length !== 1 || warmups[0]?.repetition !== 0) {
			return { status: "FAIL", reason: `${variant} warmup count/repetition invalid` };
		}
		const measured = measuredAttempts(attempts, variant);
		if (measured.length !== measuredCount(mode)) {
			return {
				status: "FAIL",
				reason: `${variant} measured ${measured.length}, expected ${measuredCount(mode)}`,
			};
		}
		const repetitions = measured.map(attempt => attempt.repetition).sort((left, right) => left - right);
		for (let index = 0; index < repetitions.length; index++) {
			if (repetitions[index] !== index + 1) {
				return { status: "FAIL", reason: `${variant} measured repetitions are not unique 1..n` };
			}
		}
		if (measured.some(attempt => !attempt.runtimeProvenance || attempt.effectiveAgentSource !== "bundled")) {
			return { status: "FAIL", reason: `${variant} identity/provenance missing or mixed` };
		}
		if (measured.some(attempt => !attempt.effectiveEffort)) {
			return { status: "FAIL", reason: `${variant} missing runtime effort` };
		}
		if (uniqueStrings(measured.map(provenanceKey)).length !== 1) {
			return { status: "FAIL", reason: `${variant} runtime model mixed across samples` };
		}
		if (uniqueStrings(measured.map(attempt => attempt.effectiveEffort)).length !== 1) {
			return { status: "FAIL", reason: `${variant} runtime effort mixed across samples` };
		}
	}
	return { status: "PASS" };
}

export function evaluateQualityAcceptance(mode: Mode, attempts: readonly AttemptRecord[]): GateVerdict {
	if (attempts.some(attempt => attempt.skip)) {
		return { status: "UNVERIFIED", reason: attempts.find(attempt => attempt.skip)?.reason ?? "skipped" };
	}
	const warmupRejected = attempts.find(attempt => attempt.warmup && !attempt.accepted);
	if (warmupRejected) {
		return { status: "FAIL", reason: `warmup ${warmupRejected.variant}: ${warmupRejected.reason}` };
	}
	for (const variant of QUALIFICATION_VARIANTS) {
		const measured = measuredAttempts(attempts, variant);
		if (measured.length !== measuredCount(mode)) {
			return {
				status: "FAIL",
				reason: `${variant} measured ${measured.length}, expected ${measuredCount(mode)}`,
			};
		}
		const rejected = measured.find(attempt => !attempt.accepted);
		if (rejected) {
			return { status: "FAIL", reason: rejected.reason };
		}
	}
	return { status: "PASS" };
}

export function evaluateE2eDelegateToAccepted(mode: Mode, attempts: readonly AttemptRecord[]): GateVerdict {
	const quality = evaluateQualityAcceptance(mode, attempts);
	if (quality.status !== "PASS") return quality;
	for (const variant of QUALIFICATION_VARIANTS) {
		const measured = measuredAttempts(attempts, variant);
		if (measured.some(attempt => attempt.acceptanceWallMs === null)) {
			return { status: "FAIL", reason: `${variant} missing parent acceptance wall` };
		}
		const walls = sortedNumbers(measured.map(attempt => attempt.acceptanceWallMs));
		const p50 = percentile(walls, 50);
		const max = walls[walls.length - 1];
		if (p50 === undefined || max === undefined) {
			return { status: "FAIL", reason: `${variant} acceptance percentile unavailable` };
		}
		const limits = VARIANT_LIMITS[variant];
		if (p50 > limits.p50Ms) {
			return { status: "FAIL", reason: `${variant} acceptance p50 ${p50}ms exceeds ${limits.p50Ms}ms` };
		}
		if (max > limits.tailMs) {
			return { status: "FAIL", reason: `${variant} acceptance max ${max}ms exceeds ${limits.tailMs}ms` };
		}
		if (mode === "release") {
			const p90 = percentile(walls, 90);
			if (p90 === undefined || p90 > limits.tailMs) {
				return { status: "FAIL", reason: `${variant} acceptance p90 ${String(p90)}ms exceeds ${limits.tailMs}ms` };
			}
		}
	}
	return { status: "PASS" };
}

function rollupStatus(verdicts: readonly GateVerdict[]): GateStatus {
	if (verdicts.some(verdict => verdict.status === "UNVERIFIED")) return "UNVERIFIED";
	if (verdicts.some(verdict => verdict.status === "FAIL")) return "FAIL";
	return "PASS";
}

export function buildQualificationReport(args: {
	mode: Mode;
	attempts: AttemptRecord[];
	launches: number;
	elapsedMs: number;
	benefit?: BenefitVerdict;
	modelsConfigSha256?: string;
}): QualificationReport {
	let runtimeSmoke = evaluateRuntimeSmoke(args.mode, args.attempts);
	if (runtimeSmoke.status === "PASS" && args.launches !== args.attempts.length) {
		runtimeSmoke = {
			status: "FAIL",
			reason: `launches ${args.launches} != attempts ${args.attempts.length}`,
		};
	} else if (runtimeSmoke.status === "PASS" && args.launches > launchCeiling(args.mode)) {
		runtimeSmoke = {
			status: "FAIL",
			reason: `launches ${args.launches} exceeds ceiling ${launchCeiling(args.mode)}`,
		};
	}
	const qualityAcceptance = evaluateQualityAcceptance(args.mode, args.attempts);
	const e2eDelegateToAccepted = evaluateE2eDelegateToAccepted(args.mode, args.attempts);
	const aggregates = {
		scout: aggregateVariant(args.mode, "scout", args.attempts),
		reviewer: aggregateVariant(args.mode, "reviewer", args.attempts),
		sonic: aggregateVariant(args.mode, "sonic", args.attempts),
	};
	return {
		status: rollupStatus([runtimeSmoke, qualityAcceptance, e2eDelegateToAccepted]),
		runtimeSmoke,
		qualityAcceptance,
		e2eDelegateToAccepted,
		benefit: args.benefit ?? { status: "NO_BASELINE", reason: "no comparable baseline supplied" },
		mode: args.mode,
		identity: qualificationIdentity(args.mode, args.modelsConfigSha256),
		launches: args.launches,
		launchCeiling: launchCeiling(args.mode),
		providerRequests: QUALIFICATION_VARIANTS.reduce((sum, variant) => sum + aggregates[variant].providerRequests, 0),
		missingProviderRequestSamples: QUALIFICATION_VARIANTS.reduce(
			(sum, variant) => sum + aggregates[variant].missingProviderRequestSamples,
			0,
		),
		elapsedMs: args.elapsedMs,
		attempts: args.attempts,
		aggregates,
	};
}

function identityMismatch(baseline: QualificationIdentity, treatment: QualificationIdentity): string | undefined {
	if (![baseline, treatment].every(identity => /^[a-f0-9]{64}$/.test(identity.config.fingerprints.modelsConfig))) {
		return "models configuration fingerprint unobserved";
	}
	if (baseline.rubricId !== treatment.rubricId) return `rubric ${baseline.rubricId} vs ${treatment.rubricId}`;
	if (baseline.mode !== treatment.mode) return `mode ${baseline.mode} vs ${treatment.mode}`;
	if (baseline.config.measuredCount !== treatment.config.measuredCount) {
		return `measuredCount ${baseline.config.measuredCount} vs ${treatment.config.measuredCount}`;
	}
	if (JSON.stringify(baseline.assignmentIds) !== JSON.stringify(treatment.assignmentIds)) {
		return "assignment identity differs";
	}
	if (JSON.stringify(baseline.modelChains) !== JSON.stringify(treatment.modelChains)) {
		return "model chain identity differs";
	}
	if (JSON.stringify(baseline.config.fingerprints) !== JSON.stringify(treatment.config.fingerprints)) {
		return "assignment/rubric/models fingerprints differ";
	}
	if (baseline.config.strictModelIdentity !== treatment.config.strictModelIdentity) {
		return "strictModelIdentity differs";
	}
	if (baseline.config.isolatedAuthModelsYml !== treatment.config.isolatedAuthModelsYml) {
		return "auth/models.yml isolation differs";
	}
	if (JSON.stringify(baseline.config.allowedEffortDelta) !== JSON.stringify(treatment.config.allowedEffortDelta)) {
		return "allowed effort delta differs";
	}
	if (JSON.stringify(baseline.variants) !== JSON.stringify(treatment.variants)) {
		return "variant set differs";
	}
	return undefined;
}

function observedEffort(aggregate: VariantAggregate): string | undefined {
	return aggregate.efforts.length === 1 ? aggregate.efforts[0] : undefined;
}

function allowedSonicEffortDelta(baseline: string, treatment: string): boolean {
	if (baseline === treatment) return true;
	const baselineRank = SONIC_EFFORT_RANK[baseline];
	const treatmentRank = SONIC_EFFORT_RANK[treatment];
	const mediumRank = SONIC_EFFORT_RANK.medium;
	return (
		baselineRank !== undefined &&
		treatmentRank !== undefined &&
		mediumRank !== undefined &&
		baselineRank > mediumRank &&
		treatmentRank <= mediumRank
	);
}

function reportFromAttempts(report: QualificationReport): QualificationReport {
	const rebuilt = buildQualificationReport({
		mode: report.mode,
		attempts: report.attempts,
		launches: report.launches,
		elapsedMs: report.elapsedMs,
	});
	rebuilt.identity = report.identity;
	return rebuilt;
}

function hasCostAndTokens(attempt: AttemptRecord): boolean {
	const usage = attempt.tokenUsage;
	return (
		!!usage &&
		typeof attempt.costTotal === "number" &&
		Number.isFinite(attempt.costTotal) &&
		Number.isFinite(usage.input) &&
		Number.isFinite(usage.output) &&
		Number.isFinite(usage.cacheRead) &&
		Number.isFinite(usage.cacheWrite) &&
		Number.isFinite(usage.totalTokens)
	);
}

export function compareQualificationReports(
	baseline: QualificationReport,
	treatment: QualificationReport,
): BenefitVerdict {
	const mismatch = identityMismatch(baseline.identity, treatment.identity);
	if (mismatch) {
		return { status: "INCOMPARABLE", reason: `identity mismatch: ${mismatch}` };
	}
	const baselineView = reportFromAttempts(baseline);
	const treatmentView = reportFromAttempts(treatment);

	for (const variant of QUALIFICATION_VARIANTS) {
		const baselineModel =
			baselineView.aggregates[variant].models.length === 1 ? baselineView.aggregates[variant].models[0] : undefined;
		const treatmentModel =
			treatmentView.aggregates[variant].models.length === 1
				? treatmentView.aggregates[variant].models[0]
				: undefined;
		if (!baselineModel || !treatmentModel) {
			return { status: "INCOMPARABLE", reason: `${variant} runtime model mixed or missing` };
		}
		if (baselineModel !== treatmentModel) {
			return {
				status: "INCOMPARABLE",
				reason: `${variant} runtime model ${baselineModel} vs ${treatmentModel}`,
			};
		}
		const baselineEffort = observedEffort(baselineView.aggregates[variant]);
		const treatmentEffort = observedEffort(treatmentView.aggregates[variant]);
		if (!baselineEffort || !treatmentEffort) {
			return { status: "INCOMPARABLE", reason: `${variant} runtime effort mixed or missing` };
		}
		if (variant === "sonic") {
			const declaredCeiling = treatmentView.attempts.every(
				attempt => attempt.variant !== "sonic" || attempt.effectiveFrontmatterIdentity.maxEffort === "medium",
			);
			if (
				!allowedSonicEffortDelta(baselineEffort, treatmentEffort) ||
				(baselineEffort !== treatmentEffort && !declaredCeiling)
			) {
				return {
					status: "INCOMPARABLE",
					reason: `sonic undeclared effort delta ${baselineEffort} vs ${treatmentEffort}`,
				};
			}
			continue;
		}
		if (baselineEffort !== treatmentEffort) {
			return {
				status: "INCOMPARABLE",
				reason: `${variant} undeclared effort drift ${baselineEffort} vs ${treatmentEffort}`,
			};
		}
	}

	const sonicEffort = {
		baseline: observedEffort(baselineView.aggregates.sonic),
		treatment: observedEffort(treatmentView.aggregates.sonic),
	};
	const baselineAbs = rollupStatus([
		baselineView.runtimeSmoke,
		baselineView.qualityAcceptance,
		baselineView.e2eDelegateToAccepted,
	]);
	const treatmentAbs = rollupStatus([
		treatmentView.runtimeSmoke,
		treatmentView.qualityAcceptance,
		treatmentView.e2eDelegateToAccepted,
	]);
	if (baselineAbs === "UNVERIFIED" || treatmentAbs === "UNVERIFIED") {
		return {
			status: "INCOMPARABLE",
			reason: "absolute runtime/quality/e2e gates unverified",
			declaredExperiment: DECLARED_EXPERIMENT_ID,
			sonicEffort,
		};
	}
	if (baselineAbs !== "PASS" || treatmentAbs !== "PASS") {
		return {
			status: "FAIL",
			reason: `absolute runtime/quality/e2e gates not PASS (baseline ${baselineAbs}, treatment ${treatmentAbs})`,
			declaredExperiment: DECLARED_EXPERIMENT_ID,
			sonicEffort,
		};
	}

	const acceptanceRates = {} as Record<Variant, { baseline: number; treatment: number; measured: number }>;
	const p50AcceptanceMs = {} as Record<Variant, { baseline: number | undefined; treatment: number | undefined }>;
	for (const variant of QUALIFICATION_VARIANTS) {
		const baselineAgg = baselineView.aggregates[variant];
		const treatmentAgg = treatmentView.aggregates[variant];
		if (baselineAgg.measured === 0 || treatmentAgg.measured === 0) {
			return { status: "INCOMPARABLE", reason: `${variant} empty measured denominator` };
		}
		if (baselineAgg.measured !== treatmentAgg.measured) {
			return {
				status: "INCOMPARABLE",
				reason: `${variant} measured denominator ${baselineAgg.measured} vs ${treatmentAgg.measured}`,
			};
		}
		acceptanceRates[variant] = {
			baseline: baselineAgg.accepted / baselineAgg.measured,
			treatment: treatmentAgg.accepted / treatmentAgg.measured,
			measured: treatmentAgg.measured,
		};
		p50AcceptanceMs[variant] = {
			baseline: baselineAgg.p50AcceptanceMs,
			treatment: treatmentAgg.p50AcceptanceMs,
		};
		if (acceptanceRates[variant].treatment < acceptanceRates[variant].baseline) {
			return {
				status: "FAIL",
				reason: `${variant} acceptance rate regression ${acceptanceRates[variant].treatment} < ${acceptanceRates[variant].baseline}`,
				declaredExperiment: DECLARED_EXPERIMENT_ID,
				sonicEffort,
				acceptanceRates,
				p50AcceptanceMs,
			};
		}
		const baselineP50 = baselineAgg.p50AcceptanceMs;
		const treatmentP50 = treatmentAgg.p50AcceptanceMs;
		if (baselineP50 === undefined || treatmentP50 === undefined) {
			return { status: "INCOMPARABLE", reason: `${variant} acceptance p50 missing` };
		}
		if (treatmentP50 > baselineP50) {
			return {
				status: "FAIL",
				reason: `${variant} acceptance p50 regression ${treatmentP50}ms > ${baselineP50}ms`,
				declaredExperiment: DECLARED_EXPERIMENT_ID,
				sonicEffort,
				acceptanceRates,
				p50AcceptanceMs,
			};
		}

		const baselineAttempts = baselineView.attempts.filter(attempt => attempt.variant === variant && !attempt.skip);
		const treatmentAttempts = treatmentView.attempts.filter(attempt => attempt.variant === variant && !attempt.skip);
		if (baselineAttempts.length === 0 || treatmentAttempts.length === 0) {
			return { status: "INCOMPARABLE", reason: `${variant} empty attempted completions` };
		}
		if (baselineAttempts.length !== treatmentAttempts.length) {
			return {
				status: "INCOMPARABLE",
				reason: `${variant} attempted completions ${baselineAttempts.length} vs ${treatmentAttempts.length}`,
			};
		}
		if (
			baselineAttempts.some(attempt => !hasCostAndTokens(attempt)) ||
			treatmentAttempts.some(attempt => !hasCostAndTokens(attempt))
		) {
			return {
				status: "INCOMPARABLE",
				reason: `${variant} missing cost/token coverage`,
				declaredExperiment: DECLARED_EXPERIMENT_ID,
				sonicEffort,
				acceptanceRates,
				p50AcceptanceMs,
			};
		}
		const baselineCost = baselineAttempts.reduce((sum, attempt) => sum + (attempt.costTotal ?? 0), 0);
		const treatmentCost = treatmentAttempts.reduce((sum, attempt) => sum + (attempt.costTotal ?? 0), 0);
		if (treatmentCost > baselineCost) {
			return {
				status: "FAIL",
				reason: `${variant} cost regression ${treatmentCost} > ${baselineCost}`,
				declaredExperiment: DECLARED_EXPERIMENT_ID,
				sonicEffort,
				acceptanceRates,
				p50AcceptanceMs,
			};
		}
		const baselineTokens = baselineAttempts.reduce((sum, attempt) => sum + (attempt.tokenUsage?.totalTokens ?? 0), 0);
		const treatmentTokens = treatmentAttempts.reduce(
			(sum, attempt) => sum + (attempt.tokenUsage?.totalTokens ?? 0),
			0,
		);
		if (treatmentTokens > baselineTokens) {
			return {
				status: "FAIL",
				reason: `${variant} token regression ${treatmentTokens} > ${baselineTokens}`,
				declaredExperiment: DECLARED_EXPERIMENT_ID,
				sonicEffort,
				acceptanceRates,
				p50AcceptanceMs,
			};
		}
	}
	return {
		status: "PASS",
		reason: "non-regression under matched identity; sonic effort delta is the declared experiment",
		declaredExperiment: DECLARED_EXPERIMENT_ID,
		sonicEffort,
		acceptanceRates,
		p50AcceptanceMs,
	};
}

function isVariant(value: unknown): value is Variant {
	return value === "scout" || value === "reviewer" || value === "sonic";
}

function parseFrontmatterIdentity(value: unknown): FrontmatterIdentity | undefined {
	if (!isRecord(value)) return undefined;
	const shadowReview = value.shadowReview === "code" ? "code" : undefined;
	const model =
		Array.isArray(value.model) && value.model.every(item => typeof item === "string") ? value.model : undefined;
	return {
		thinkingLevel: typeof value.thinkingLevel === "string" ? value.thinkingLevel : undefined,
		maxEffort: typeof value.maxEffort === "string" ? value.maxEffort : undefined,
		readSummarize: typeof value.readSummarize === "boolean" ? value.readSummarize : undefined,
		shadowReview,
		model,
	};
}

function parseRuntimeProvenance(value: unknown): RuntimeProvenance | null | undefined {
	if (value === null) return null;
	if (!isRecord(value)) return undefined;
	if (value.source !== "runtime_observed" || value.fallback !== false) return undefined;
	if (typeof value.provider !== "string" || typeof value.model !== "string") return undefined;
	return { source: "runtime_observed", provider: value.provider, model: value.model, fallback: false };
}

function parseTokenUsage(value: unknown): TokenUsage | undefined {
	if (!isRecord(value)) return undefined;
	if (
		typeof value.input !== "number" ||
		typeof value.output !== "number" ||
		typeof value.cacheRead !== "number" ||
		typeof value.cacheWrite !== "number" ||
		typeof value.totalTokens !== "number"
	) {
		return undefined;
	}
	return {
		input: value.input,
		output: value.output,
		cacheRead: value.cacheRead,
		cacheWrite: value.cacheWrite,
		totalTokens: value.totalTokens,
	};
}

function parseAttempt(value: unknown): AttemptRecord | undefined {
	if (!isRecord(value) || !isVariant(value.variant)) return undefined;
	if (typeof value.repetition !== "number" || !Number.isInteger(value.repetition)) return undefined;
	if (typeof value.warmup !== "boolean" || typeof value.skip !== "boolean") return undefined;
	if (value.result !== "ok" && value.result !== "error" && value.result !== "skip") return undefined;
	if (typeof value.accepted !== "boolean" || typeof value.reason !== "string") return undefined;
	if (value.completionKind !== null && typeof value.completionKind !== "string") return undefined;
	if (value.durationMs !== null && typeof value.durationMs !== "number") return undefined;
	if (value.activeWallMs !== null && typeof value.activeWallMs !== "number") return undefined;
	if (value.acceptanceWallMs !== null && typeof value.acceptanceWallMs !== "number") return undefined;
	if (value.providerRequests !== null && typeof value.providerRequests !== "number") return undefined;
	if (typeof value.hardTimeout !== "boolean" || typeof value.effectiveAgentSource !== "string") return undefined;
	const effectiveFrontmatterIdentity = parseFrontmatterIdentity(value.effectiveFrontmatterIdentity);
	if (!effectiveFrontmatterIdentity) return undefined;
	const runtimeProvenance = parseRuntimeProvenance(value.runtimeProvenance);
	if (runtimeProvenance === undefined) return undefined;
	const tokenUsage = value.tokenUsage === undefined ? undefined : parseTokenUsage(value.tokenUsage);
	if (value.tokenUsage !== undefined && !tokenUsage) return undefined;
	if (value.costTotal !== undefined && typeof value.costTotal !== "number") return undefined;
	return {
		variant: value.variant,
		repetition: value.repetition,
		warmup: value.warmup,
		skip: value.skip,
		result: value.result,
		accepted: value.accepted,
		reason: value.reason,
		completionKind: value.completionKind,
		durationMs: value.durationMs,
		activeWallMs: value.activeWallMs,
		acceptanceWallMs: value.acceptanceWallMs,
		providerRequests: value.providerRequests,
		runtimeModel: typeof value.runtimeModel === "string" ? value.runtimeModel : undefined,
		effectiveEffort: typeof value.effectiveEffort === "string" ? value.effectiveEffort : undefined,
		runtimeProvenance,
		hardTimeout: value.hardTimeout,
		effectiveAgentSource: value.effectiveAgentSource,
		effectiveFrontmatterIdentity,
		...(tokenUsage ? { tokenUsage } : {}),
		...(typeof value.costTotal === "number" ? { costTotal: value.costTotal } : {}),
	};
}

function parseFingerprints(value: unknown): QualificationFingerprints | undefined {
	if (!isRecord(value)) return undefined;
	if (
		typeof value.scoutAssignment !== "string" ||
		typeof value.reviewerAssignment !== "string" ||
		typeof value.sonicAssignment !== "string" ||
		typeof value.modelsConfig !== "string" ||
		typeof value.rubric !== "string" ||
		value.scoutAssignment.length === 0 ||
		value.reviewerAssignment.length === 0 ||
		value.sonicAssignment.length === 0 ||
		value.modelsConfig.length === 0 ||
		value.rubric.length === 0
	) {
		return undefined;
	}
	return {
		scoutAssignment: value.scoutAssignment,
		reviewerAssignment: value.reviewerAssignment,
		sonicAssignment: value.sonicAssignment,
		modelsConfig: value.modelsConfig,
		rubric: value.rubric,
	};
}

function parseStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || !value.every(item => typeof item === "string")) return undefined;
	return value;
}

function parseIdentity(value: unknown): QualificationIdentity | undefined {
	if (!isRecord(value) || value.rubricId !== RUBRIC_ID) return undefined;
	if (value.mode !== "smoke" && value.mode !== "release") return undefined;
	if (!Array.isArray(value.variants) || value.variants.length !== QUALIFICATION_VARIANTS.length) return undefined;
	if (!value.variants.every((item, index) => item === QUALIFICATION_VARIANTS[index])) return undefined;
	if (!isRecord(value.assignmentIds) || !isRecord(value.modelChains) || !isRecord(value.config)) return undefined;
	const scoutIds = value.assignmentIds.scout;
	const reviewerIds = value.assignmentIds.reviewer;
	const sonicIds = value.assignmentIds.sonic;
	if (typeof scoutIds !== "string" || typeof reviewerIds !== "string" || typeof sonicIds !== "string")
		return undefined;
	const scoutModels = parseStringArray(value.modelChains.scout);
	const reviewerModels = parseStringArray(value.modelChains.reviewer);
	const sonicModels = parseStringArray(value.modelChains.sonic);
	if (!scoutModels || !reviewerModels || !sonicModels) return undefined;
	const fingerprints = parseFingerprints(value.config.fingerprints);
	if (!fingerprints) return undefined;
	if (value.config.strictModelIdentity !== true || value.config.isolatedAuthModelsYml !== true) return undefined;
	if (typeof value.config.measuredCount !== "number") return undefined;
	if (!isRecord(value.config.allowedEffortDelta)) return undefined;
	if (
		value.config.allowedEffortDelta.experiment !== DECLARED_EXPERIMENT_ID ||
		value.config.allowedEffortDelta.variant !== "sonic" ||
		value.config.allowedEffortDelta.field !== "effectiveEffort"
	) {
		return undefined;
	}
	return {
		rubricId: RUBRIC_ID,
		mode: value.mode,
		variants: [...QUALIFICATION_VARIANTS],
		assignmentIds: { scout: scoutIds, reviewer: reviewerIds, sonic: sonicIds },
		modelChains: { scout: scoutModels, reviewer: reviewerModels, sonic: sonicModels },
		config: {
			strictModelIdentity: true,
			isolatedAuthModelsYml: true,
			measuredCount: value.config.measuredCount,
			allowedEffortDelta: {
				experiment: DECLARED_EXPERIMENT_ID,
				variant: "sonic",
				field: "effectiveEffort",
			},
			fingerprints,
		},
	};
}

export function parseQualificationReport(value: unknown): QualificationReport | { error: string } {
	if (!isRecord(value)) return { error: "report is not an object" };
	const identity = parseIdentity(value.identity);
	if (!identity) return { error: "report identity/rubric missing" };
	if (value.mode !== "smoke" && value.mode !== "release") return { error: "report mode invalid" };
	if (identity.mode !== value.mode) return { error: "report mode does not match identity.mode" };
	if (!Array.isArray(value.attempts)) return { error: "report attempts missing" };
	const attempts: AttemptRecord[] = [];
	for (const item of value.attempts) {
		const attempt = parseAttempt(item);
		if (!attempt) return { error: "report attempts nested shape invalid" };
		attempts.push(attempt);
	}
	if (typeof value.launches !== "number" || !Number.isFinite(value.launches))
		return { error: "report launches missing" };
	if (typeof value.elapsedMs !== "number" || !Number.isFinite(value.elapsedMs))
		return { error: "report elapsedMs missing" };
	const report = buildQualificationReport({
		mode: value.mode,
		attempts,
		launches: value.launches,
		elapsedMs: value.elapsedMs,
	});
	report.identity = identity;
	if (value.checkpoint === "in_progress") {
		report.checkpoint = "in_progress";
		report.status = "UNVERIFIED";
		report.runtimeSmoke = { status: "UNVERIFIED", reason: "in_progress checkpoint" };
	}
	const storedSmoke = isRecord(value.runtimeSmoke) ? value.runtimeSmoke : undefined;
	const driftReason =
		typeof value.configDrift === "string" && value.configDrift
			? value.configDrift
			: typeof storedSmoke?.reason === "string" &&
				  storedSmoke.status === "UNVERIFIED" &&
				  storedSmoke.reason.includes("config-drift")
				? storedSmoke.reason
				: undefined;
	if (driftReason) {
		report.configDrift = driftReason;
		report.runtimeSmoke = { status: "UNVERIFIED", reason: driftReason };
		report.status = "UNVERIFIED";
	}
	return report;
}
