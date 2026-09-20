import { describe, expect, it } from "bun:test";
import {
	SCOUT_P90_MS,
	buildQualificationReport,
	compareQualificationReports,
	launchCeiling,
	measuredCount,
	parseQualificationReport,
	scoreReviewerOutput,
	scoreScoutOutput,
	scoreSonicWorkspace,
	type AttemptRecord,
	type FrontmatterIdentity,
	type QualificationReport,
	type RuntimeProvenance,
	type Variant,
} from "./product-latency-qualification";

const FRONTMATTER: FrontmatterIdentity = {
	thinkingLevel: "medium",
	maxEffort: "medium",
	readSummarize: true,
	shadowReview: undefined,
	model: ["gateway/deepseek-flash:max", "gateway/grok-4.6:high"],
};

const USAGE = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 };

function provenance(runtimeModel: string): RuntimeProvenance {
	const slash = runtimeModel.indexOf("/");
	return {
		source: "runtime_observed",
		provider: runtimeModel.slice(0, slash),
		model: runtimeModel.slice(slash + 1),
		fallback: false,
	};
}

function variantModel(variant: Variant): string {
	if (variant === "reviewer") return "xai/gpt-5.6-sol";
	if (variant === "sonic") return "gateway/deepseek-v4-flash";
	return "gateway/deepseek-flash";
}

function sample(partial: Partial<AttemptRecord> & Pick<AttemptRecord, "variant" | "repetition">): AttemptRecord {
	const runtimeModel = partial.runtimeModel ?? variantModel(partial.variant);
	return {
		warmup: false,
		skip: false,
		result: "ok",
		accepted: true,
		reason: "ok",
		completionKind: "completed",
		durationMs: 1_000,
		activeWallMs: 800,
		acceptanceWallMs: 1_200,
		providerRequests: 2,
		runtimeModel,
		effectiveEffort: "medium",
		runtimeProvenance: provenance(runtimeModel),
		hardTimeout: false,
		effectiveAgentSource: "bundled",
		effectiveFrontmatterIdentity: FRONTMATTER,
		tokenUsage: USAGE,
		costTotal: 0.01,
		...partial,
	};
}

function suite(override?: (variant: Variant, repetition: number) => Partial<AttemptRecord>): AttemptRecord[] {
	const attempts: AttemptRecord[] = [];
	for (const variant of ["scout", "reviewer", "sonic"] as const) {
		for (let repetition = 0; repetition <= 5; repetition++) {
			attempts.push(
				sample({
					variant,
					repetition,
					warmup: repetition === 0,
					...override?.(variant, repetition),
				}),
			);
		}
	}
	return attempts;
}

function reportFrom(
	attempts: AttemptRecord[],
	extra?: Partial<Pick<QualificationReport, "launches" | "elapsedMs">>,
): QualificationReport {
	return buildQualificationReport({
		mode: "smoke",
		attempts,
		launches: extra?.launches ?? 18,
		elapsedMs: extra?.elapsedMs ?? 4_000,
		modelsConfigSha256: "a".repeat(64),
	});
}

const SCOUT_OK = JSON.stringify({
	path: "src/task/review-performance.ts",
	signature: "resolveClassMaxRuntimeMs(performanceClass, configuredMaxRuntimeMs)",
	caller: "resolveTaskSpawnRuntime",
});
const REVIEWER_OK = JSON.stringify({
	verdict: "reject",
	findings: [{ path: "add.ts", line: 2, defect: "return left - right" }],
});
const SONIC_OK = "export function add(left: number, right: number): number {\n\treturn left + right;\n}\n";

describe("product-latency qualification scoring", () => {
	it("scores parsed schema output without concatenating its duplicate textual representation", () => {
		expect(scoreScoutOutput(JSON.parse(SCOUT_OK)).accepted).toBe(true);
		expect(scoreReviewerOutput(JSON.parse(REVIEWER_OK)).accepted).toBe(true);
		expect(scoreScoutOutput(`${SCOUT_OK}\n${SCOUT_OK}`).accepted).toBe(false);
		expect(scoreReviewerOutput(`${REVIEWER_OK}\n${REVIEWER_OK}`).accepted).toBe(false);
	});

	it("rejects a completed scout answer that omits the caller", () => {
		const score = scoreScoutOutput(
			JSON.stringify({
				path: "src/task/review-performance.ts",
				signature: "resolveClassMaxRuntimeMs(performanceClass, configuredMaxRuntimeMs)",
			}),
		);
		expect(score.accepted).toBe(false);
		expect(score.reason).toContain("caller resolveTaskSpawnRuntime");

		const report = reportFrom(
			suite((variant, repetition) =>
				variant === "scout" && repetition === 1 ? { accepted: false, reason: score.reason } : {},
			),
		);
		expect(report.runtimeSmoke.status).toBe("PASS");
		expect(report.qualityAcceptance.status).toBe("FAIL");
		expect(report.qualityAcceptance.reason).toContain("caller");
		expect(report.e2eDelegateToAccepted.status).toBe("FAIL");
	});

	it("rejects keyword-rich scout prose that is not structured evidence", () => {
		const score = scoreScoutOutput(
			"src/task/review-performance.ts resolveClassMaxRuntimeMs(performanceClass, configuredMaxRuntimeMs) caller resolveTaskSpawnRuntime is unused",
		);
		expect(score.accepted).toBe(false);
		expect(score.reason).toContain("structured evidence");
	});

	it("rejects a completed reviewer verdict that misses the planted subtraction defect", () => {
		const score = scoreReviewerOutput("No findings. add.ts looks good.");
		expect(score.accepted).toBe(false);
		expect(score.reason).toContain("structured evidence");

		const report = reportFrom(
			suite((variant, repetition) =>
				variant === "reviewer" && repetition === 2 ? { accepted: false, reason: score.reason } : {},
			),
		);
		expect(report.runtimeSmoke.status).toBe("PASS");
		expect(report.qualityAcceptance.status).toBe("FAIL");
	});

	it("rejects reviewer keyword soup, negated pass, empty finding, and unanchored JSON", () => {
		expect(scoreReviewerOutput("add.ts: no defect; left - right is correct").accepted).toBe(false);
		expect(
			scoreReviewerOutput(
				JSON.stringify({
					verdict: "reject",
					findings: [{ path: "add.ts", line: 2, defect: "no defect; left - right is correct" }],
				}),
			).accepted,
		).toBe(false);
		expect(scoreReviewerOutput(JSON.stringify({ verdict: "reject", findings: [] })).accepted).toBe(false);
		expect(scoreReviewerOutput(JSON.stringify({ verdict: "accept", findings: [] })).accepted).toBe(false);
		expect(
			scoreReviewerOutput(
				JSON.stringify({
					verdict: "reject",
					findings: [{ path: "add.ts", defect: "return left - right" }],
				}),
			).accepted,
		).toBe(false);
	});

	it("rejects a completed sonic edit that leaves add() subtracting", () => {
		const score = scoreSonicWorkspace(
			"export function add(left: number, right: number): number {\n\treturn left - right;\n}\n",
		);
		expect(score.accepted).toBe(false);

		const report = reportFrom(
			suite((variant, repetition) =>
				variant === "sonic" && repetition === 1 ? { accepted: false, reason: score.reason } : {},
			),
		);
		expect(report.qualityAcceptance.status).toBe("FAIL");
		expect(report.runtimeSmoke.status).toBe("PASS");
	});

	it("rejects commented, unreachable, or wrong-signature sonic sums", () => {
		expect(
			scoreSonicWorkspace(
				"export function add(left: number, right: number): number {\n\treturn 0; // return left + right\n}\n",
			).accepted,
		).toBe(false);
		expect(
			scoreSonicWorkspace(
				"export function add(left: number, right: number): number {\n\treturn 0;\n\treturn left + right;\n}\n",
			).accepted,
		).toBe(false);
		expect(
			scoreSonicWorkspace("export function add(a: number, b: number): number {\n\treturn a + b;\n}\n").accepted,
		).toBe(false);
	});

	it("accepts scout, reviewer, and sonic when the planted evidence is present", () => {
		expect(scoreScoutOutput(SCOUT_OK).accepted).toBe(true);
		expect(scoreReviewerOutput(REVIEWER_OK).accepted).toBe(true);
		expect(scoreSonicWorkspace(SONIC_OK).accepted).toBe(true);
	});

	it("rejects wrong path, reversed parameters, and wrong caller even when they include the tokens", () => {
		expect(
			scoreScoutOutput(
				JSON.stringify({
					path: "vendor/src/task/review-performance.ts.bak",
					signature: "resolveClassMaxRuntimeMs(configuredMaxRuntimeMs, performanceClass)",
					caller: "notResolveTaskSpawnRuntime",
				}),
			).accepted,
		).toBe(false);
	});
});

describe("product-latency qualification gates", () => {
	it("does not treat short active-wall as a pass when parent acceptance wall includes long idle", () => {
		const report = reportFrom(
			suite((variant, repetition) =>
				variant === "scout" && repetition === 5
					? { accepted: true, activeWallMs: 400, acceptanceWallMs: SCOUT_P90_MS + 1 }
					: {},
			),
		);
		expect(report.qualityAcceptance.status).toBe("PASS");
		expect(report.aggregates.scout.maxActiveWallMs).toBeLessThan(SCOUT_P90_MS);
		expect(report.e2eDelegateToAccepted.status).toBe("FAIL");
		expect(report.e2eDelegateToAccepted.reason).toContain("acceptance max");
	});

	it("rejects mixed runtime models in one variant", () => {
		const report = reportFrom(
			suite((variant, repetition) =>
				variant === "scout" && repetition === 3
					? {
							runtimeModel: "gateway/other-model",
							runtimeProvenance: provenance("gateway/other-model"),
						}
					: {},
			),
		);
		expect(report.runtimeSmoke.status).toBe("FAIL");
		expect(report.runtimeSmoke.reason).toContain("runtime model mixed");
	});

	it("rejects mixed efforts in one variant", () => {
		const report = reportFrom(
			suite((variant, repetition) =>
				variant === "reviewer" && repetition === 4 ? { effectiveEffort: "xhigh" } : {},
			),
		);
		expect(report.runtimeSmoke.status).toBe("FAIL");
		expect(report.runtimeSmoke.reason).toContain("runtime effort mixed");
	});

	it("rejects an execution error even when its completion label says completed", () => {
		const report = reportFrom(
			suite((variant, repetition) =>
				variant === "sonic" && repetition === 1
					? {
							result: "error",
							accepted: false,
							completionKind: "completed",
							reason: "child execution failed",
						}
					: {},
			),
		);
		expect(report.runtimeSmoke.status).toBe("FAIL");
		expect(report.runtimeSmoke.reason).toContain("execution failure");
		expect(report.status).toBe("FAIL");
	});

	it("fails absolute quality when warmup is rejected", () => {
		const report = reportFrom(
			suite((variant, repetition) =>
				variant === "scout" && repetition === 0 ? { accepted: false, reason: "warmup quality fail" } : {},
			),
		);
		expect(report.attempts.some(attempt => attempt.warmup && !attempt.accepted)).toBe(true);
		expect(report.qualityAcceptance.status).toBe("FAIL");
		expect(report.qualityAcceptance.reason).toContain("warmup");
		expect(report.e2eDelegateToAccepted.status).toBe("FAIL");
	});

	it("fails runtime smoke when a warmup attempt times out", () => {
		const report = reportFrom(
			suite((variant, repetition) =>
				variant === "reviewer" && repetition === 0
					? { hardTimeout: true, completionKind: "timeout", accepted: false, reason: "per-attempt timeout" }
					: {},
			),
		);
		expect(report.runtimeSmoke.status).toBe("FAIL");
		expect(report.runtimeSmoke.reason).toContain("warmup");
		expect(report.qualityAcceptance.status).toBe("FAIL");
	});
});

describe("product-latency baseline comparison", () => {
	it("marks incompatible rubric or model identity as INCOMPARABLE", () => {
		const baseline = reportFrom(suite());
		const otherRubric = structuredClone(baseline);
		otherRubric.identity.rubricId = "other-rubric";
		expect(compareQualificationReports(baseline, otherRubric).status).toBe("INCOMPARABLE");
		expect(compareQualificationReports(baseline, otherRubric).reason).toContain("rubric");

		const otherModel = reportFrom(
			suite((variant, _repetition) =>
				variant === "scout"
					? {
							runtimeModel: "gateway/not-the-same",
							runtimeProvenance: provenance("gateway/not-the-same"),
						}
					: {},
			),
		);
		const modelCompare = compareQualificationReports(baseline, otherModel);
		expect(modelCompare.status).toBe("INCOMPARABLE");
		expect(modelCompare.reason).toContain("runtime model");
	});

	it("marks differing assignment fingerprints as INCOMPARABLE", () => {
		const baseline = reportFrom(suite());
		expect(baseline.identity.config.fingerprints.scoutAssignment).not.toBe(
			baseline.identity.config.fingerprints.reviewerAssignment,
		);
		const treatment = structuredClone(baseline);
		treatment.identity.config.fingerprints.scoutAssignment = "0".repeat(64);
		const benefit = compareQualificationReports(baseline, treatment);
		expect(benefit.status).toBe("INCOMPARABLE");
		expect(benefit.reason).toContain("fingerprints");
		const missingConfig = structuredClone(baseline);
		missingConfig.identity.config.fingerprints.modelsConfig = "unobserved";
		expect(compareQualificationReports(missingConfig, missingConfig).status).toBe("INCOMPARABLE");
	});

	it("allows the declared sonic effort ceiling delta and still compares", () => {
		const baseline = reportFrom(
			suite((variant, _repetition) =>
				variant === "sonic"
					? {
							effectiveEffort: "high",
							runtimeModel: "gateway/deepseek-v4-flash:high",
							runtimeProvenance: provenance("gateway/deepseek-v4-flash"),
						}
					: {},
			),
		);
		const treatment = reportFrom(
			suite((variant, _repetition) =>
				variant === "sonic"
					? {
							effectiveEffort: "medium",
							runtimeModel: "gateway/deepseek-v4-flash:medium",
							runtimeProvenance: provenance("gateway/deepseek-v4-flash"),
						}
					: {},
			),
		);
		const benefit = compareQualificationReports(baseline, treatment);
		expect(benefit.status).toBe("PASS");
		expect(benefit.declaredExperiment).toBe("sonic-effort-ceiling");
		expect(benefit.sonicEffort).toEqual({ baseline: "high", treatment: "medium" });
	});

	it("accepts a lower supported effort under the declared medium ceiling, not an undeclared demotion", () => {
		const baseline = reportFrom(
			suite(variant =>
				variant === "sonic"
					? {
							effectiveEffort: "max",
							effectiveFrontmatterIdentity: { ...FRONTMATTER, maxEffort: undefined },
						}
					: {},
			),
		);
		const treatment = reportFrom(suite(variant => (variant === "sonic" ? { effectiveEffort: "low" } : {})));
		expect(compareQualificationReports(baseline, treatment).status).toBe("PASS");
		const undeclared = reportFrom(
			suite(variant =>
				variant === "sonic"
					? {
							effectiveEffort: "low",
							effectiveFrontmatterIdentity: { ...FRONTMATTER, maxEffort: undefined },
						}
					: {},
			),
		);
		expect(compareQualificationReports(baseline, undeclared).status).toBe("INCOMPARABLE");
	});

	it("allows same sonic effort and rejects undeclared increases or missing mixed effort", () => {
		const same = reportFrom(suite());
		expect(compareQualificationReports(same, reportFrom(suite())).status).toBe("PASS");

		const increased = reportFrom(
			suite((variant, _repetition) => (variant === "sonic" ? { effectiveEffort: "high" } : {})),
		);
		const increase = compareQualificationReports(same, increased);
		expect(increase.status).toBe("INCOMPARABLE");
		expect(increase.reason).toContain("undeclared effort delta");

		const missing = reportFrom(
			suite((variant, _repetition) => (variant === "sonic" ? { effectiveEffort: undefined } : {})),
		);
		expect(compareQualificationReports(same, missing).status).toBe("INCOMPARABLE");
		expect(compareQualificationReports(same, missing).reason).toContain("runtime effort mixed or missing");

		const mixed = reportFrom(
			suite((variant, repetition) => (variant === "sonic" && repetition === 1 ? { effectiveEffort: "high" } : {})),
		);
		expect(compareQualificationReports(same, mixed).status).toBe("INCOMPARABLE");
	});

	it("rejects undeclared reviewer effort drift as INCOMPARABLE", () => {
		const baseline = reportFrom(suite());
		const treatment = reportFrom(
			suite((variant, _repetition) => (variant === "reviewer" ? { effectiveEffort: "xhigh" } : {})),
		);
		const benefit = compareQualificationReports(baseline, treatment);
		expect(benefit.status).toBe("INCOMPARABLE");
		expect(benefit.reason).toContain("undeclared effort drift");
	});

	it("does not PASS benefit when both reports fail absolute quality", () => {
		const bad = reportFrom(suite(() => ({ accepted: false, reason: "wrong answer" })));
		expect(bad.qualityAcceptance.status).toBe("FAIL");
		const benefit = compareQualificationReports(bad, structuredClone(bad));
		expect(benefit.status).toBe("FAIL");
		expect(benefit.reason).toContain("absolute runtime/quality/e2e");
	});

	it("counts failed attempts in denominators instead of dropping them", () => {
		const attempts = suite((variant, repetition) =>
			variant === "scout" && repetition === 3 ? { accepted: false, result: "error", reason: "child failed" } : {},
		);
		const report = reportFrom(attempts);
		expect(report.attempts).toHaveLength(18);
		expect(report.attempts.filter(attempt => attempt.warmup)).toHaveLength(3);
		expect(report.aggregates.scout.warmup).toBe(1);
		expect(report.attempts.some(attempt => attempt.result === "error")).toBe(true);
		expect(report.aggregates.scout.measured).toBe(5);
		expect(report.aggregates.scout.failed).toBe(1);
		expect(report.aggregates.scout.accepted).toBe(4);
		expect(report.aggregates.scout.accepted / report.aggregates.scout.measured).toBe(0.8);

		const baseline = reportFrom(suite());
		const benefit = compareQualificationReports(baseline, report);
		expect(benefit.status).toBe("FAIL");
	});

	it("cannot claim cost non-regression without per-attempt coverage", () => {
		const baseline = reportFrom(suite());
		const treatment = reportFrom(
			suite((variant, repetition) =>
				variant === "scout" && repetition === 1 ? { tokenUsage: undefined, costTotal: undefined } : {},
			),
		);
		const benefit = compareQualificationReports(baseline, treatment);
		expect(benefit.status).toBe("INCOMPARABLE");
		expect(benefit.reason).toContain("missing cost/token coverage");
	});

	it("fails cost non-regression when treatment spend increases", () => {
		const baseline = reportFrom(suite());
		const treatment = reportFrom(suite((variant, _repetition) => (variant === "sonic" ? { costTotal: 1 } : {})));
		const benefit = compareQualificationReports(baseline, treatment);
		expect(benefit.status).toBe("FAIL");
		expect(benefit.reason).toContain("cost regression");
	});

	it("does not claim benefit from a single treatment without baseline", () => {
		const report = reportFrom(suite());
		expect(report.benefit.status).toBe("NO_BASELINE");
	});

	it("keeps launch counts distinct from provider request counts", () => {
		const report = reportFrom(suite(), { launches: 18 });
		expect(report.launches).toBe(18);
		expect(report.launchCeiling).toBe(launchCeiling("smoke"));
		expect(report.launchCeiling).toBe(3 * (1 + measuredCount("smoke")));
		expect(report.providerRequests).toBe(36);
		expect(report.providerRequests).not.toBe(report.launches);
		expect(report.providerRequests).not.toBe(report.launchCeiling);
	});

	it("reports cost total separately from the measured-attempt cost median", () => {
		const report = reportFrom(suite());
		expect(report.aggregates.scout.costTotal).toBeCloseTo(0.06);
		expect(report.aggregates.scout.costMedian).toBe(0.01);
		expect(report.aggregates.scout.costTotal).not.toBe(report.aggregates.scout.costMedian);
	});

	it("rejects a malformed baseline object instead of inventing a report", () => {
		const parsed = parseQualificationReport({ status: "PASS" });
		expect("error" in parsed).toBe(true);
	});

	it("rejects nested attempts that are not complete records", () => {
		const parsed = parseQualificationReport({
			...reportFrom(suite()),
			attempts: [{ variant: "scout" }],
		});
		expect("error" in parsed).toBe(true);
	});

	it("recomputes gates from attempts instead of trusting stored PASS", () => {
		const raw = {
			...reportFrom(suite(() => ({ accepted: false, reason: "bad" }))),
			status: "PASS" as const,
			qualityAcceptance: { status: "PASS" as const },
			runtimeSmoke: { status: "PASS" as const },
			e2eDelegateToAccepted: { status: "PASS" as const },
		};
		const parsed = parseQualificationReport(raw);
		expect("error" in parsed).toBe(false);
		if ("error" in parsed) return;
		expect(parsed.qualityAcceptance.status).toBe("FAIL");
		expect(parsed.status).toBe("FAIL");
	});

	it("does not promote config-drift or in_progress checkpoints to PASS on parse", () => {
		const base = reportFrom(suite());
		const drifted = parseQualificationReport({
			...base,
			runtimeSmoke: { status: "UNVERIFIED", reason: "config-drift: models.yml hash changed" },
		});
		expect("error" in drifted).toBe(false);
		if ("error" in drifted) return;
		expect(drifted.status).toBe("UNVERIFIED");
		expect(drifted.runtimeSmoke.status).toBe("UNVERIFIED");

		const checkpoint = parseQualificationReport({ ...base, checkpoint: "in_progress" });
		expect("error" in checkpoint).toBe(false);
		if ("error" in checkpoint) return;
		expect(checkpoint.status).toBe("UNVERIFIED");
	});

	it("fails runtime smoke when one measured attempt lacks effort", () => {
		const report = reportFrom(
			suite((variant, repetition) =>
				variant === "scout" && repetition === 1 ? { effectiveEffort: undefined } : {},
			),
		);
		expect(report.runtimeSmoke.status).toBe("FAIL");
		expect(report.runtimeSmoke.reason).toContain("missing runtime effort");
	});
});
