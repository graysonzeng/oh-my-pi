import { describe, expect, it } from "bun:test";
import {
	createPairedSchedule,
	EXPERIMENT_VARIANTS,
	requestsPairedQualification,
	runPairedQualification,
	type PairedExperiment,
	type PairedQualificationReport,
	type PairedSlot,
} from "./product-latency-paired";
import {
	measuredCount,
	type AttemptRecord,
	type FrontmatterIdentity,
	type RuntimeProvenance,
	type Variant,
} from "./product-latency-qualification";

const MODELS_CONFIG = "a".repeat(64);

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

function attemptFor(
	slot: PairedSlot,
	experiment: PairedExperiment = "advisories",
	extra: Partial<AttemptRecord> = {},
): AttemptRecord {
	const sonicCeiling = experiment === "sonic-effort" && slot.variant === "sonic";
	return sample({
		variant: slot.variant,
		repetition: slot.repetition,
		warmup: slot.repetition === 0,
		...(sonicCeiling
			? slot.arm === "control"
				? {
						effectiveEffort: "high",
						effectiveFrontmatterIdentity: { ...FRONTMATTER, maxEffort: undefined },
					}
				: {
						effectiveEffort: "medium",
						effectiveFrontmatterIdentity: { ...FRONTMATTER, maxEffort: "medium" },
					}
			: {}),
		...extra,
	});
}

async function runPaired(options: {
	experiment?: PairedExperiment;
	signal?: AbortSignal;
	attempt?: (slot: PairedSlot) => AttemptRecord | Promise<AttemptRecord>;
	verifyConditions?: () => Promise<void>;
	checkpointHook?: (report: PairedQualificationReport) => void;
}): Promise<{
	report: PairedQualificationReport;
	executions: PairedSlot[];
	checkpoints: PairedQualificationReport[];
}> {
	const experiment = options.experiment ?? "advisories";
	const executions: PairedSlot[] = [];
	const checkpoints: PairedQualificationReport[] = [];
	const report = await runPairedQualification({
		mode: "smoke",
		experiment,
		modelsConfigSha256: MODELS_CONFIG,
		execute: async slot => {
			executions.push(slot);
			return (options.attempt ?? (current => attemptFor(current, experiment)))(slot);
		},
		checkpoint: async current => {
			checkpoints.push(structuredClone(current));
			options.checkpointHook?.(current);
		},
		verifyConditions: options.verifyConditions ?? (async () => {}),
		signal: options.signal ?? new AbortController().signal,
	});
	return { report, executions, checkpoints };
}

describe("product-latency paired schedule", () => {
	it("scopes advisories and sonic-effort to disjoint role sets", () => {
		expect(EXPERIMENT_VARIANTS.advisories).toEqual(["scout", "reviewer"]);
		expect(EXPERIMENT_VARIANTS["sonic-effort"]).toEqual(["sonic"]);
	});

	it("fail-closes bare experiment argv into paired mode (never unpaired full pack)", () => {
		expect(requestsPairedQualification(["--mode", "smoke", "--experiment", "advisories"])).toBe(true);
		expect(requestsPairedQualification(["--mode", "smoke", "--experiment", "sonic-effort"])).toBe(true);
		expect(requestsPairedQualification(["--paired-control", "/tmp/c"])).toBe(true);
		expect(requestsPairedQualification(["--mode", "smoke", "--output", "/tmp/out.json"])).toBe(false);
	});

	it("routes malformed experiment requests to validation instead of unpaired provider calls", () => {
		expect(requestsPairedQualification(["--experiment", "advisory"])).toBe(true);
		expect(requestsPairedQualification(["--experiment"])).toBe(true);
		expect(requestsPairedQualification(["--experiment=advisories"])).toBe(true);
	});

	it("keeps arms adjacent and alternates the first arm by pair index", () => {
		for (const experiment of ["advisories", "sonic-effort"] as const) {
			const variants = EXPERIMENT_VARIANTS[experiment];
			const smoke = createPairedSchedule("smoke", experiment);
			expect(smoke).toHaveLength(variants.length * 2 * (1 + measuredCount("smoke")));
			expect(createPairedSchedule("release", experiment)).toHaveLength(
				variants.length * 2 * (1 + measuredCount("release")),
			);

			let pairIndex = 0;
			for (let repetition = 0; repetition <= measuredCount("smoke"); repetition++) {
				for (const variant of variants) {
					const first = smoke[pairIndex * 2]!;
					const second = smoke[pairIndex * 2 + 1]!;
					expect(first.pairId).toBe(second.pairId);
					expect(first.variant).toBe(variant);
					expect(second.variant).toBe(variant);
					expect(first.repetition).toBe(repetition);
					expect(second.repetition).toBe(repetition);
					expect(first.order).toBe(0);
					expect(second.order).toBe(1);
					expect(first.arm).toBe(pairIndex % 2 === 0 ? "control" : "treatment");
					expect(second.arm).toBe(first.arm === "control" ? "treatment" : "control");
					pairIndex += 1;
				}
			}
		}
	});
});

describe("product-latency paired qualification", () => {
	it("retains a failed attempt and still runs the paired arm", async () => {
		const schedule = createPairedSchedule("smoke", "advisories");
		const failed = schedule[0]!;
		const { report, executions } = await runPaired({
			attempt: slot =>
				attemptFor(
					slot,
					"advisories",
					slot.pairId === failed.pairId && slot.arm === failed.arm
						? { accepted: false, result: "error", reason: "child failed" }
						: {},
				),
		});

		expect(executions).toEqual(schedule);
		expect(report.phase).toBe("complete");
		expect(report.slots).toHaveLength(schedule.length);
		expect(report.slots[0]?.attempt.result).toBe("error");
		expect(report.slots.some(item => item.slot.pairId === failed.pairId && item.slot.arm !== failed.arm)).toBe(true);
		const failedPair = report.pairs.find(pair => pair.pairId === failed.pairId);
		expect(failedPair?.controlIndex).not.toBeNull();
		expect(failedPair?.treatmentIndex).not.toBeNull();
		expect(report.control.attempts.some(attempt => attempt.result === "error")).toBe(true);
		expect(report.control.identity.variants).toEqual(["scout", "reviewer"]);
		expect(report.slots.every(item => item.slot.variant !== "sonic")).toBe(true);
	});

	it("cannot PASS an aborted incomplete schedule and keeps prior evidence", async () => {
		const controller = new AbortController();
		const { report, executions, checkpoints } = await runPaired({
			signal: controller.signal,
			checkpointHook: current => {
				if (current.slots.length === 2) controller.abort();
			},
		});

		expect(executions).toHaveLength(2);
		expect(report.phase).toBe("interrupted");
		expect(report.status).toBe("INCOMPARABLE");
		expect(report.benefit.status).toBe("INCOMPARABLE");
		expect(report.slots).toHaveLength(2);
		expect(checkpoints.at(-1)?.phase).toBe("interrupted");
		expect(checkpoints.at(-1)?.slots).toHaveLength(2);
	});

	it("does not launch execute when abort happens during verifyConditions", async () => {
		const controller = new AbortController();
		const { report, executions } = await runPaired({
			signal: controller.signal,
			verifyConditions: async () => {
				controller.abort();
			},
		});

		expect(executions).toHaveLength(0);
		expect(report.phase).toBe("interrupted");
		expect(report.status).toBe("INCOMPARABLE");
		expect(report.slots).toHaveLength(0);
		expect(report.benefit.status).not.toBe("PASS");
	});

	it("stops on condition drift while preserving already returned attempts", async () => {
		let checks = 0;
		const { report, executions } = await runPaired({
			verifyConditions: async () => {
				checks += 1;
				if (checks === 4) throw new Error("source drifted");
			},
		});

		expect(executions).toHaveLength(3);
		expect(report.phase).toBe("interrupted");
		expect(report.status).toBe("INCOMPARABLE");
		expect(report.slots).toHaveLength(3);
		expect(report.reason).toContain("source drifted");
		expect(report.benefit.status).not.toBe("PASS");
	});

	it("rejects a wrong slot after retaining the mismatched attempt", async () => {
		let launched = 0;
		const { report } = await runPaired({
			attempt: slot => {
				launched += 1;
				if (launched === 1) {
					return sample({ variant: "reviewer", repetition: 3, warmup: false });
				}
				return attemptFor(slot);
			},
		});

		expect(launched).toBe(1);
		expect(report.phase).toBe("interrupted");
		expect(report.status).toBe("INCOMPARABLE");
		expect(report.slots).toHaveLength(1);
		expect(report.slots[0]?.attempt.variant).toBe("reviewer");
		expect(report.reason).toContain("slot mismatch");
	});

	it("rejects mixed experiment metadata as INCOMPARABLE", async () => {
		const { report, executions } = await runPaired({
			experiment: "advisories",
			attempt: slot =>
				attemptFor(slot, "advisories", {
					effectiveFrontmatterIdentity:
						slot.arm === "treatment" ? { ...FRONTMATTER, maxEffort: "high" } : FRONTMATTER,
				}),
		});

		expect(executions).toHaveLength(createPairedSchedule("smoke", "advisories").length);
		expect(report.phase).toBe("complete");
		expect(report.status).toBe("INCOMPARABLE");
		expect(report.benefit.status).toBe("INCOMPARABLE");
		expect(report.reason).toContain("mixed experiment metadata");
	});

	it("compares a complete compatible advisories corpus without declaring sonic", async () => {
		const schedule = createPairedSchedule("smoke", "advisories");
		const { report, checkpoints } = await runPaired({ experiment: "advisories" });

		expect(report.phase).toBe("complete");
		expect(report.status).toBe("PASS");
		expect(report.benefit.status).toBe("PASS");
		expect(report.benefit.declaredExperiment).toBeUndefined();
		expect(report.benefit.sonicEffort).toBeUndefined();
		expect(report.control.identity.variants).toEqual(["scout", "reviewer"]);
		expect(report.slots).toHaveLength(schedule.length);
		expect(report.control.launches).toBe(schedule.length / 2);
		expect(report.treatment.launches).toBe(schedule.length / 2);
		expect(report.control.elapsedMs).toBe(report.control.attempts.length * 1_200);
		expect(report.pairs.every(pair => pair.controlIndex !== null && pair.treatmentIndex !== null)).toBe(true);
		expect(checkpoints.at(-1)?.phase).toBe("complete");
	});

	it("executes serially and checkpoints the final pair before checking source stability", async () => {
		let active = false;
		let executed = 0;
		let persisted = 0;
		const schedule = createPairedSchedule("smoke", "advisories");
		const { report } = await runPaired({
			attempt: async slot => {
				if (active) throw new Error("overlapping paired executions");
				active = true;
				await Promise.resolve();
				active = false;
				executed += 1;
				return attemptFor(slot, "advisories", { acceptanceWallMs: slot.arm === "control" ? 1_200 : 1_000 });
			},
			checkpointHook: current => {
				persisted = current.slots.length;
			},
			verifyConditions: async () => {
				if (executed === schedule.length) expect(persisted).toBe(schedule.length);
			},
		});
		expect(report.status).toBe("PASS");
		expect(report.pairs.map(pair => pair.acceptanceDeltaMs)).toEqual(Array(schedule.length / 2).fill(-200));
	});

	it("compares a complete sonic-effort corpus with a declared ceiling delta", async () => {
		const { report } = await runPaired({ experiment: "sonic-effort" });

		expect(report.phase).toBe("complete");
		expect(report.status).toBe("PASS");
		expect(report.benefit.status).toBe("PASS");
		expect(report.benefit.declaredExperiment).toBe("sonic-effort-ceiling");
		expect(report.benefit.sonicEffort).toEqual({ baseline: "high", treatment: "medium" });
	});

	it("marks a sonic experiment without a ceiling delta INCOMPARABLE", async () => {
		const { report } = await runPaired({
			experiment: "sonic-effort",
			attempt: slot => attemptFor(slot, "advisories"),
		});

		expect(report.phase).toBe("complete");
		expect(report.status).toBe("INCOMPARABLE");
		expect(report.benefit.status).toBe("INCOMPARABLE");
		expect(report.reason).toContain("no declared ceiling delta");
	});
});
